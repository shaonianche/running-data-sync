import type { Logger } from '../../foundation/logger.js'
import type { Activity, FlybyPoint } from '../../foundation/types.js'
import type {
  ReverseGeocoder,
  StravaLatLng,
  StravaStreamsMap,
  StravaStreamType,
  StravaSummaryActivity,
} from './types.js'
import { createLogger } from '../../foundation/logger.js'
import {
  DEFAULT_NOMINATIM_CONCURRENCY,
  formatGeocodeCacheKey,
  runWithConcurrencyLimit,
} from './geocoder.js'

const MEANINGFUL_STREAM_TYPES: readonly StravaStreamType[] = [
  'latlng',
  'distance',
  'velocity_smooth',
  'altitude',
  'heartrate',
  'cadence',
  'watts',
]

export interface MapStravaActivitiesOptions {
  readonly geocoder?: ReverseGeocoder | null
  readonly geocoderConcurrency?: number
  readonly logger?: Logger
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function normalizeStartDateLocal(startDateLocal: string): string {
  const trimmed = startDateLocal.trim()
  if (trimmed.endsWith('Z') || trimmed.endsWith('z')) {
    return trimmed.slice(0, -1)
  }
  return trimmed
}

export function extractStartLatLng(
  startLatLng: StravaLatLng | readonly number[] | null | undefined,
): readonly [number, number] | null {
  if (!startLatLng) {
    return null
  }
  if (Array.isArray(startLatLng)) {
    if (startLatLng.length < 2) {
      return null
    }
    const lat = Number(startLatLng[0])
    const lon = Number(startLatLng[1])
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return [lat, lon]
    }
    return null
  }
  const record = startLatLng as { readonly lat?: unknown, readonly lon?: unknown, readonly lng?: unknown }
  const lat = Number(record.lat)
  const lon = Number(record.lon ?? record.lng)
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return [lat, lon]
  }
  return null
}

export function resolveActivityTypeAndSubtype(
  activity: Pick<StravaSummaryActivity, 'name' | 'type' | 'sport_type' | 'subtype'>,
): { readonly type: string, readonly subtype: string } {
  let type = (activity.type ?? activity.sport_type ?? '').trim()
  const name = activity.name ?? ''
  if (name && (type === 'Workout' || type === 'WeightTraining')) {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('boxing') || name.includes('拳击')) {
      type = 'Boxing'
    }
  }

  const subtype = (activity.sport_type ?? activity.subtype ?? '').trim()
  return { type, subtype }
}

export function needsReverseGeocoding(locationCountry: string | null | undefined): boolean {
  if (!locationCountry) {
    return true
  }
  const trimmed = locationCountry.trim()
  return trimmed.length === 0 || trimmed === 'China'
}

export function mapStravaActivity(
  activity: StravaSummaryActivity,
  resolvedLocationCountry?: string | null,
): Activity {
  const { type, subtype } = resolveActivityTypeAndSubtype(activity)
  const rawElevation = activity.total_elevation_gain ?? activity.elevation_gain ?? 0
  const elevationGain = Number.isFinite(rawElevation) ? Number(rawElevation) : 0
  const rawDistance = Number(activity.distance ?? 0)
  const rawMovingTime = Number(activity.moving_time ?? 0)
  const rawElapsedTime = activity.elapsed_time !== undefined ? Number(activity.elapsed_time) : rawMovingTime
  const rawAverageSpeed = Number(activity.average_speed ?? 0)
  const averageHeartrate = typeof activity.average_heartrate === 'number' && Number.isFinite(activity.average_heartrate)
    ? activity.average_heartrate
    : null
  const summaryPolyline = activity.map?.summary_polyline && activity.map.summary_polyline.length > 0
    ? activity.map.summary_polyline
    : null
  const locationCountry = resolvedLocationCountry !== undefined
    ? resolvedLocationCountry
    : (activity.location_country ?? '')

  return {
    run_id: Math.trunc(activity.id),
    name: activity.name ?? '',
    distance: Number.isFinite(rawDistance) ? rawDistance : 0,
    moving_time: Number.isFinite(rawMovingTime) ? Math.trunc(rawMovingTime) : 0,
    elapsed_time: Number.isFinite(rawElapsedTime) ? Math.trunc(rawElapsedTime) : 0,
    type,
    subtype,
    start_date: activity.start_date,
    start_date_local: normalizeStartDateLocal(activity.start_date_local),
    location_country: locationCountry,
    summary_polyline: summaryPolyline,
    average_heartrate: averageHeartrate,
    average_speed: Number.isFinite(rawAverageSpeed) ? rawAverageSpeed : 0,
    elevation_gain: elevationGain,
  }
}

/**
 * Map a batch of Strava API activities to canonical `Activity` records,
 * deduplicating and running Nominatim reverse geocoding concurrently when needed.
 */
export async function mapStravaActivities(
  activities: readonly StravaSummaryActivity[],
  options: MapStravaActivitiesOptions = {},
): Promise<Activity[]> {
  if (activities.length === 0) {
    return []
  }

  const geocoder = options.geocoder ?? null
  const concurrency = options.geocoderConcurrency ?? DEFAULT_NOMINATIM_CONCURRENCY
  const logger = options.logger ?? createLogger('strava.mapper')
  const geocodedByKey = new Map<string, string>()

  if (geocoder) {
    const uniqueCoords = new Map<string, readonly [number, number]>()
    for (const activity of activities) {
      if (!needsReverseGeocoding(activity.location_country)) {
        continue
      }
      const coords = extractStartLatLng(activity.start_latlng)
      if (!coords) {
        continue
      }
      const key = formatGeocodeCacheKey(coords[0], coords[1])
      if (!uniqueCoords.has(key)) {
        uniqueCoords.set(key, coords)
      }
    }

    if (uniqueCoords.size > 0) {
      logger.info('Performing reverse geocoding for missing or generic locations', {
        uniqueLocations: uniqueCoords.size,
      })
      const entries = Array.from(uniqueCoords.entries())
      await runWithConcurrencyLimit(entries, concurrency, async ([key, [lat, lon]]) => {
        const country = await geocoder.reverseGeocode(lat, lon)
        geocodedByKey.set(key, country)
      })
    }
  }

  return activities.map((activity) => {
    if (!geocoder || !needsReverseGeocoding(activity.location_country)) {
      return mapStravaActivity(activity)
    }

    const coords = extractStartLatLng(activity.start_latlng)
    if (!coords) {
      return mapStravaActivity(activity, activity.location_country ?? '')
    }

    const key = formatGeocodeCacheKey(coords[0], coords[1])
    const resolved = geocodedByKey.get(key) ?? ''
    return mapStravaActivity(activity, resolved)
  })
}

function isValidLatLngPair(entry: unknown): entry is readonly [number, number] {
  return Array.isArray(entry)
    && entry.length >= 2
    && typeof entry[0] === 'number'
    && typeof entry[1] === 'number'
    && Number.isFinite(entry[0])
    && Number.isFinite(entry[1])
}

function hasValidStreamData(streamName: StravaStreamType, data: readonly unknown[], length: number): boolean {
  const limit = Math.min(data.length, length)
  for (let i = 0; i < limit; i += 1) {
    const value = data[i]
    if (streamName === 'latlng') {
      if (isValidLatLngPair(value)) {
        return true
      }
    }
    else if (typeof value === 'number' && Number.isFinite(value)) {
      return true
    }
  }
  return false
}

function alignStream<T>(data: readonly T[] | undefined, length: number): Array<T | null> {
  const aligned: Array<T | null> = Array.from({ length }, () => null)
  if (!data || data.length === 0) {
    return aligned
  }
  const limit = Math.min(data.length, length)
  for (let i = 0; i < limit; i += 1) {
    const value = data[i]
    aligned[i] = value === undefined ? null : value
  }
  return aligned
}

function computePace(timeOffset: number, velocity: number | null): number {
  if (timeOffset === 0) {
    return 0
  }
  if (typeof velocity !== 'number' || !Number.isFinite(velocity) || velocity <= 0) {
    return 0
  }
  const pace = (1000 / 60) / velocity
  if (pace >= 1.0 && pace <= 30.0) {
    return roundTo(pace, 2)
  }
  return 0
}

function toNullableInt(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.trunc(value)
}

function toNullableHeartRate(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 255) {
    return null
  }
  return Math.trunc(value)
}

/**
 * Convert Strava activity streams into aligned `FlybyPoint[]` records.
 * Aligns all telemetry streams to the `time` series, computes `pace`,
 * and returns an empty array unless `time` and at least one non-`time`
 * stream contain valid data.
 */
export function convertStreamsToFlybyPoints(
  activityId: number,
  streams: StravaStreamsMap | null | undefined,
): FlybyPoint[] {
  const rawTime = streams?.time?.data
  if (!streams || !Array.isArray(rawTime) || rawTime.length === 0) {
    return []
  }

  let length = rawTime.length
  const rawLatLng = streams.latlng?.data
  const hasLatLngStream = Array.isArray(rawLatLng) && rawLatLng.length > 0
  if (hasLatLngStream && rawLatLng.length !== length) {
    length = Math.min(length, rawLatLng.length)
  }

  if (length === 0) {
    return []
  }

  const hasMeaningfulData = MEANINGFUL_STREAM_TYPES.some((streamName) => {
    const stream = streams[streamName]
    return stream && Array.isArray(stream.data) && hasValidStreamData(streamName, stream.data, length)
  })

  if (!hasMeaningfulData) {
    return []
  }

  const latlng = hasLatLngStream ? alignStream(rawLatLng, length) : null
  const altitude = alignStream(streams.altitude?.data, length)
  const velocity = alignStream(streams.velocity_smooth?.data, length)
  const heartrate = alignStream(streams.heartrate?.data, length)
  const distance = alignStream(streams.distance?.data, length)
  const cadence = alignStream(streams.cadence?.data, length)
  const watts = alignStream(streams.watts?.data, length)

  const normalizedActivityId = Math.trunc(activityId)
  const points: FlybyPoint[] = []

  for (let i = 0; i < length; i += 1) {
    const rawTimeOffset = rawTime[i]
    if (typeof rawTimeOffset !== 'number' || !Number.isFinite(rawTimeOffset)) {
      continue
    }
    const timeOffset = Math.trunc(rawTimeOffset)
    const pair = latlng ? latlng[i] : null
    const validPair = isValidLatLngPair(pair)

    points.push({
      activity_id: normalizedActivityId,
      time_offset: timeOffset,
      lat: validPair ? roundTo(pair[0], 6) : null,
      lng: validPair ? roundTo(pair[1], 6) : null,
      alt: toNullableInt(altitude[i]),
      pace: computePace(timeOffset, velocity[i]),
      hr: toNullableHeartRate(heartrate[i]),
      distance: toNullableInt(distance[i]),
      cadence: toNullableInt(cadence[i]),
      watts: toNullableInt(watts[i]),
    })
  }

  return points
}
