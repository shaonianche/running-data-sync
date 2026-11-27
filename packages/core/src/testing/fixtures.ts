import type { ParsedTrack, PosterTrack } from '../contracts/index.js'
import type { Activity, FlybyPoint, VendorSyncRow } from '../foundation/types.js'

/**
 * Valid Google-encoded polyline matching `FIXTURE_OUTDOOR_RUN_FLYBY_POINTS` coordinates.
 */
export const FIXTURE_OUTDOOR_RUN_POLYLINE = '_qxrFok}eU_XoK_XwQ_XwQ_XwQ_XwQ'

export const FIXTURE_OUTDOOR_RUN_ACTIVITY: Readonly<Activity> = Object.freeze({
  run_id: 100001,
  name: 'Morning Run',
  distance: 5000,
  moving_time: 1500,
  elapsed_time: 1530,
  type: 'Run',
  subtype: 'Run',
  start_date: '2025-03-15T00:30:00Z',
  start_date_local: '2025-03-15T08:30:00',
  location_country: 'China',
  summary_polyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
  average_heartrate: 152,
  average_speed: 3.333,
  elevation_gain: 35,
})

export const FIXTURE_INDOOR_WORKOUT_ACTIVITY: Readonly<Activity> = Object.freeze({
  run_id: 100002,
  name: 'Indoor Strength Workout',
  distance: 0,
  moving_time: 2400,
  elapsed_time: 2460,
  type: 'Workout',
  subtype: 'WeightTraining',
  start_date: '2025-03-16T11:00:00Z',
  start_date_local: '2025-03-16T19:00:00',
  location_country: '',
  summary_polyline: null,
  average_heartrate: 128,
  average_speed: 0,
  elevation_gain: 0,
})

export const FIXTURE_OUTDOOR_RUN_FLYBY_POINTS: readonly Readonly<FlybyPoint>[] = Object.freeze([
  Object.freeze({
    activity_id: 100001,
    time_offset: 0,
    lat: 39.944,
    lng: 116.482,
    alt: 40,
    pace: 5.0,
    hr: 138,
    distance: 0,
    cadence: 84,
    watts: 220,
  }),
  Object.freeze({
    activity_id: 100001,
    time_offset: 300,
    lat: 39.948,
    lng: 116.484,
    alt: 42,
    pace: 5.0,
    hr: 148,
    distance: 1000,
    cadence: 85,
    watts: 230,
  }),
  Object.freeze({
    activity_id: 100001,
    time_offset: 600,
    lat: 39.952,
    lng: 116.487,
    alt: 45,
    pace: 5.0,
    hr: 152,
    distance: 2000,
    cadence: 86,
    watts: 235,
  }),
  Object.freeze({
    activity_id: 100001,
    time_offset: 900,
    lat: 39.956,
    lng: 116.49,
    alt: 48,
    pace: 5.0,
    hr: 156,
    distance: 3000,
    cadence: 87,
    watts: 240,
  }),
  Object.freeze({
    activity_id: 100001,
    time_offset: 1200,
    lat: 39.96,
    lng: 116.493,
    alt: 46,
    pace: 5.0,
    hr: 160,
    distance: 4000,
    cadence: 87,
    watts: 242,
  }),
  Object.freeze({
    activity_id: 100001,
    time_offset: 1500,
    lat: 39.964,
    lng: 116.496,
    alt: 44,
    pace: 5.0,
    hr: 162,
    distance: 5000,
    cadence: 88,
    watts: 245,
  }),
])

export const FIXTURE_INDOOR_WORKOUT_FLYBY_POINTS: readonly Readonly<FlybyPoint>[] = Object.freeze([
  Object.freeze({
    activity_id: 100002,
    time_offset: 0,
    lat: null,
    lng: null,
    alt: null,
    pace: 0,
    hr: 115,
    distance: 0,
    cadence: null,
    watts: null,
  }),
  Object.freeze({
    activity_id: 100002,
    time_offset: 600,
    lat: null,
    lng: null,
    alt: null,
    pace: 0,
    hr: 128,
    distance: 0,
    cadence: null,
    watts: null,
  }),
  Object.freeze({
    activity_id: 100002,
    time_offset: 1200,
    lat: null,
    lng: null,
    alt: null,
    pace: 0,
    hr: 138,
    distance: 0,
    cadence: null,
    watts: null,
  }),
  Object.freeze({
    activity_id: 100002,
    time_offset: 1800,
    lat: null,
    lng: null,
    alt: null,
    pace: 0,
    hr: 132,
    distance: 0,
    cadence: null,
    watts: null,
  }),
  Object.freeze({
    activity_id: 100002,
    time_offset: 2400,
    lat: null,
    lng: null,
    alt: null,
    pace: 0,
    hr: 125,
    distance: 0,
    cadence: null,
    watts: null,
  }),
])

export const FIXTURE_VENDOR_SYNC_ROWS: readonly Readonly<VendorSyncRow>[] = Object.freeze([
  Object.freeze({
    activityId: 100001,
    vendor: 'garmin',
    account: 'garmin_com',
    status: 'synced',
    remoteActivityId: 900001,
    contentHash: 'sha256-fixture-100001',
    lastError: null,
    attemptCount: 1,
    nextRetryAt: null,
    uploadedAt: '2025-03-15T01:00:00Z',
    lastVerifiedAt: '2025-03-15T01:05:00Z',
  }),
  Object.freeze({
    activityId: 100002,
    vendor: 'garmin',
    account: 'garmin_com',
    status: 'failed',
    remoteActivityId: null,
    contentHash: 'sha256-fixture-100002',
    lastError: 'HTTP 503 Service Unavailable',
    attemptCount: 2,
    nextRetryAt: '2025-03-16T12:00:00Z',
    uploadedAt: null,
    lastVerifiedAt: null,
  }),
  Object.freeze({
    activityId: 100001,
    vendor: 'garmin',
    account: 'garmin_cn',
    status: 'skipped_exists',
    remoteActivityId: 800001,
    contentHash: 'sha256-fixture-100001',
    lastError: null,
    attemptCount: 1,
    nextRetryAt: null,
    uploadedAt: null,
    lastVerifiedAt: '2025-03-15T01:10:00Z',
  }),
])

export const FIXTURE_POSTER_TRACKS: readonly Readonly<PosterTrack>[] = Object.freeze([
  Object.freeze({
    runId: 100001,
    name: 'Morning Run',
    type: 'Run',
    startDateLocal: '2025-03-15T08:30:00',
    distance: 5000,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
    special: false,
  }),
  Object.freeze({
    runId: 100003,
    name: 'Long Sunday Run',
    type: 'Run',
    startDateLocal: '2024-11-10T07:00:00',
    distance: 21100,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
    special: true,
  }),
])

export function createOutdoorRunActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    ...FIXTURE_OUTDOOR_RUN_ACTIVITY,
    ...overrides,
  }
}

export function createIndoorWorkoutActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    ...FIXTURE_INDOOR_WORKOUT_ACTIVITY,
    ...overrides,
  }
}

export function createOutdoorRunFlybyPoints(activityId = FIXTURE_OUTDOOR_RUN_ACTIVITY.run_id): FlybyPoint[] {
  return FIXTURE_OUTDOOR_RUN_FLYBY_POINTS.map(point => ({
    ...point,
    activity_id: activityId,
  }))
}

export function createIndoorWorkoutFlybyPoints(activityId = FIXTURE_INDOOR_WORKOUT_ACTIVITY.run_id): FlybyPoint[] {
  return FIXTURE_INDOOR_WORKOUT_FLYBY_POINTS.map(point => ({
    ...point,
    activity_id: activityId,
  }))
}

export function createVendorSyncRow(overrides: Partial<VendorSyncRow> = {}): VendorSyncRow {
  return {
    ...FIXTURE_VENDOR_SYNC_ROWS[0],
    ...overrides,
  }
}

export function createPosterTrack(overrides: Partial<PosterTrack> = {}): PosterTrack {
  return {
    ...FIXTURE_POSTER_TRACKS[0],
    ...overrides,
  }
}

export function createParsedTrackFixture(overrides: Partial<ParsedTrack> = {}): ParsedTrack {
  const polylineCoords: readonly [number, number][] = FIXTURE_OUTDOOR_RUN_FLYBY_POINTS
    .filter((p): p is FlybyPoint & { lat: number, lng: number } => p.lat !== null && p.lng !== null)
    .map(p => [p.lat, p.lng] as const)

  return {
    runId: FIXTURE_OUTDOOR_RUN_ACTIVITY.run_id,
    name: FIXTURE_OUTDOOR_RUN_ACTIVITY.name,
    type: FIXTURE_OUTDOOR_RUN_ACTIVITY.type,
    subtype: FIXTURE_OUTDOOR_RUN_ACTIVITY.subtype,
    startDate: FIXTURE_OUTDOOR_RUN_ACTIVITY.start_date,
    endDate: '2025-03-15T00:55:30Z',
    startDateLocal: FIXTURE_OUTDOOR_RUN_ACTIVITY.start_date_local,
    endDateLocal: '2025-03-15T08:55:30',
    distance: FIXTURE_OUTDOOR_RUN_ACTIVITY.distance,
    movingTime: FIXTURE_OUTDOOR_RUN_ACTIVITY.moving_time,
    elapsedTime: FIXTURE_OUTDOOR_RUN_ACTIVITY.elapsed_time ?? FIXTURE_OUTDOOR_RUN_ACTIVITY.moving_time,
    averageSpeed: FIXTURE_OUTDOOR_RUN_ACTIVITY.average_speed,
    averageHeartrate: FIXTURE_OUTDOOR_RUN_ACTIVITY.average_heartrate ?? null,
    elevationGain: FIXTURE_OUTDOOR_RUN_ACTIVITY.elevation_gain,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_ACTIVITY.summary_polyline ?? null,
    startLatLng: polylineCoords[0] ?? null,
    polylines: polylineCoords.length > 0 ? [polylineCoords] : [],
    points: FIXTURE_OUTDOOR_RUN_FLYBY_POINTS.map((point) => {
      const startMs = Date.parse(FIXTURE_OUTDOOR_RUN_ACTIVITY.start_date)
      return {
        lat: point.lat,
        lng: point.lng,
        alt: point.alt,
        timestamp: new Date(startMs + point.time_offset * 1000).toISOString(),
        timeOffset: point.time_offset,
        hr: point.hr,
        cadence: point.cadence,
        speed: FIXTURE_OUTDOOR_RUN_ACTIVITY.average_speed,
        distance: point.distance,
        watts: point.watts,
      }
    }),
    device: 'Forerunner 245',
    ...overrides,
  }
}
