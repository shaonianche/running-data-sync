import type { Activity, FlybyPoint } from '../../foundation/index.js'
import type { GarminActivityRecord, GarminMatchOptions } from './types.js'
import { createHash } from 'node:crypto'
import {
  DEFAULT_DISTANCE_TOLERANCE_M,
  DEFAULT_DURATION_TOLERANCE_SEC,
  DEFAULT_MATCH_WINDOW_SEC,
} from './types.js'

const STRAVA_GARMIN_TYPE_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  Run: new Set(['running', 'street_running', 'trail_running', 'treadmill_running']),
  TrailRun: new Set(['running', 'trail_running']),
  Treadmill: new Set(['running', 'treadmill_running']),
  VirtualRun: new Set(['running', 'virtual_running']),
  Walk: new Set(['walking']),
  Hike: new Set(['hiking', 'walking']),
  Ride: new Set(['cycling', 'road_biking']),
  VirtualRide: new Set(['cycling', 'indoor_cycling', 'virtual_ride']),
  GravelRide: new Set(['cycling', 'gravel_cycling']),
  MountainBikeRide: new Set(['cycling', 'mountain_biking']),
  EBikeRide: new Set(['cycling', 'e_biking']),
  Workout: new Set(['fitness', 'strength_training', 'cardio_training', 'indoor_cardio', 'boxing']),
  WeightTraining: new Set(['strength_training', 'fitness']),
  Boxing: new Set(['boxing', 'fitness']),
  Crossfit: new Set(['cross_training', 'strength_training', 'fitness']),
  Yoga: new Set(['yoga']),
  Elliptical: new Set(['elliptical']),
  StairStepper: new Set(['stair_stepper']),
}

const DURATION_FIRST_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'Workout',
  'WeightTraining',
  'Boxing',
  'Crossfit',
  'Yoga',
  'Elliptical',
  'StairStepper',
])

const GARMIN_DURATION_KEYS = [
  'duration',
  'elapsedDuration',
  'movingDuration',
  'durationInSeconds',
  'elapsedDurationInSeconds',
  'movingDurationInSeconds',
] as const

const PRIMARY_UPLOAD_ID_KEYS = [
  'activityId',
  'activity_id',
  'garminActivityId',
  'activityPk',
  'activityPK',
] as const

const SECONDARY_UPLOAD_ID_KEYS = ['internalId'] as const

const GARMIN_SQL_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/

function parseUtcTimestampMs(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const match = GARMIN_SQL_DATETIME_REGEX.exec(trimmed)
  if (match) {
    const [, year, month, day, hour, minute, second, frac, tz] = match
    if (tz) {
      const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${frac ? `.${frac.slice(0, 3)}` : ''}${tz}`
      const parsed = Date.parse(iso)
      return Number.isNaN(parsed) ? null : parsed
    }
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      ms,
    )
  }

  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

export function parseGarminStartTime(value: string | null | undefined): number | null {
  return parseUtcTimestampMs(value)
}

export function parseGarminDurationSeconds(garminActivity: GarminActivityRecord): number | null {
  for (const key of GARMIN_DURATION_KEYS) {
    const raw = garminActivity[key]
    if (raw === null || raw === undefined) {
      continue
    }
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

export function extractGarminTypeKey(garminActivity: GarminActivityRecord): string | null {
  for (const key of ['activityType', 'activityTypeDTO'] as const) {
    const raw = garminActivity[key]
    if (raw && typeof raw === 'object' && typeof raw.typeKey === 'string' && raw.typeKey.trim().length > 0) {
      return raw.typeKey.trim().toLowerCase()
    }
  }
  return null
}

export function getStravaTypeAliases(stravaType: string | null | undefined): ReadonlySet<string> {
  if (!stravaType) {
    return new Set()
  }
  const known = STRAVA_GARMIN_TYPE_ALIASES[stravaType]
  if (known) {
    return known
  }
  return new Set([stravaType.toLowerCase()])
}

export function preferDurationMatch(activity: Pick<Activity, 'distance' | 'type'>): boolean {
  const distance = Number(activity.distance ?? 0)
  if (!Number.isFinite(distance) || distance <= 1) {
    return true
  }
  return DURATION_FIRST_ACTIVITY_TYPES.has(activity.type)
}

/**
 * Find the best matching remote Garmin activity ID for a local activity.
 *
 * Mirrors `scripts/strava_cli_core/sync_garmin.py`:
 * - Start time must fall within `matchWindowSec` (default 300s).
 * - Sport type must be compatible via `STRAVA_GARMIN_TYPE_ALIASES`.
 * - Indoor / zero-distance workouts match duration-first (`durationToleranceSec`, default 120s).
 * - Outdoor activities match distance-first (`distanceToleranceM`, default 50m).
 * - Candidates are ranked by `(timeDelta, secondaryDelta, garminActivityId)` ascending.
 */
export function findMatchingGarminActivity(
  activity: Pick<Activity, 'start_date' | 'distance' | 'elapsed_time' | 'moving_time' | 'type'>,
  garminActivities: readonly GarminActivityRecord[],
  options: GarminMatchOptions = {},
): number | null {
  const matchWindowSec = options.matchWindowSec ?? DEFAULT_MATCH_WINDOW_SEC
  const distanceToleranceM = options.distanceToleranceM ?? DEFAULT_DISTANCE_TOLERANCE_M
  const durationToleranceSec = options.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC
  const reservedActivityIds = options.reservedActivityIds

  const activityStartMs = parseUtcTimestampMs(activity.start_date)
  if (activityStartMs === null) {
    return null
  }

  const activityDistance = Number(activity.distance ?? 0)
  const activityElapsed = Number(activity.elapsed_time ?? activity.moving_time ?? 0)
  const useDuration = preferDurationMatch(activity)
  const allowedTypes = getStravaTypeAliases(activity.type)

  const candidates: Array<{ timeDelta: number, secondaryDelta: number, activityId: number }> = []

  for (const garminActivity of garminActivities) {
    const garminStartMs = parseGarminStartTime(garminActivity.startTimeGMT)
    if (garminStartMs === null) {
      continue
    }

    const rawId = garminActivity.activityId
    if (rawId === null || rawId === undefined || rawId === '') {
      continue
    }
    const garminActivityId = Number(rawId)
    if (!Number.isSafeInteger(garminActivityId) || garminActivityId <= 0) {
      continue
    }
    if (reservedActivityIds?.has(garminActivityId)) {
      continue
    }

    const timeDelta = Math.abs(activityStartMs - garminStartMs) / 1000
    if (timeDelta > matchWindowSec) {
      continue
    }

    const garminType = extractGarminTypeKey(garminActivity)
    if (allowedTypes.size > 0 && garminType && !allowedTypes.has(garminType)) {
      continue
    }

    let secondaryDelta: number
    if (useDuration) {
      const garminDuration = parseGarminDurationSeconds(garminActivity)
      if (garminDuration === null) {
        continue
      }
      secondaryDelta = Math.abs(activityElapsed - garminDuration)
      if (secondaryDelta > durationToleranceSec) {
        continue
      }
    }
    else {
      const garminDistance = Number(garminActivity.distance ?? 0)
      secondaryDelta = Math.abs(activityDistance - garminDistance)
      if (secondaryDelta > distanceToleranceM) {
        continue
      }
    }

    candidates.push({
      timeDelta,
      secondaryDelta,
      activityId: garminActivityId,
    })
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((a, b) => {
    if (a.timeDelta !== b.timeDelta) {
      return a.timeDelta - b.timeDelta
    }
    if (a.secondaryDelta !== b.secondaryDelta) {
      return a.secondaryDelta - b.secondaryDelta
    }
    return a.activityId - b.activityId
  })

  return candidates[0].activityId
}

function normalizeFiniteNumber(value: number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Object.is(value, -0) ? 0 : value
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Object.is(value, -0) ? 0 : value
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJsonStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const serialized = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJsonStringify(val)}`)
  return `{${serialized.join(',')}}`
}

/**
 * Compute a deterministic SHA-256 content hash for a local activity and its flyby telemetry.
 */
export function computeActivityContentHash(
  activity: Activity,
  flybyPoints: readonly FlybyPoint[],
): string {
  const activityPayload = {
    average_heartrate: normalizeFiniteNumber(activity.average_heartrate, 0),
    average_speed: normalizeFiniteNumber(activity.average_speed, 0),
    distance: normalizeFiniteNumber(activity.distance, 0),
    elapsed_time: normalizeFiniteNumber(activity.elapsed_time ?? activity.moving_time, 0),
    moving_time: normalizeFiniteNumber(activity.moving_time, 0),
    run_id: Math.trunc(activity.run_id),
    start_date: String(activity.start_date ?? ''),
    total_elevation_gain: normalizeFiniteNumber(activity.elevation_gain, 0),
  }

  const sortedPoints = [...flybyPoints].sort((a, b) => a.time_offset - b.time_offset)
  const flybyPayload = sortedPoints.map(point => ({
    alt: normalizeNullableNumber(point.alt),
    cadence: normalizeNullableNumber(point.cadence),
    distance: normalizeNullableNumber(point.distance),
    hr: normalizeNullableNumber(point.hr),
    lat: normalizeNullableNumber(point.lat),
    lng: normalizeNullableNumber(point.lng),
    pace: normalizeNullableNumber(point.pace),
    time_offset: normalizeFiniteNumber(point.time_offset, 0),
    watts: normalizeNullableNumber(point.watts),
  }))

  const canonical = stableJsonStringify({
    activity: activityPayload,
    flyby: flybyPayload,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function parsePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed
  }
  return null
}

function extractIdByKeys(value: unknown, keys: readonly string[]): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractIdByKeys(item, keys)
      if (nested !== null) {
        return nested
      }
    }
    return null
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const found = parsePositiveInt(record[key])
      if (found !== null) {
        return found
      }
    }
    for (const child of Object.values(record)) {
      const nested = extractIdByKeys(child, keys)
      if (nested !== null) {
        return nested
      }
    }
  }

  return null
}

/**
 * Recursively extract a Garmin remote activity ID from a Garmin upload response payload.
 */
export function extractRemoteActivityIdFromUploadResult(uploadResult: unknown): number | null {
  return (
    extractIdByKeys(uploadResult, PRIMARY_UPLOAD_ID_KEYS)
    ?? extractIdByKeys(uploadResult, SECONDARY_UPLOAD_ID_KEYS)
  )
}
