export const DEFAULT_GARMIN_MANUFACTURER = 1 // Garmin
export const DEFAULT_GARMIN_PRODUCT_ID = 3589 // Forerunner 245 (legacy repo constant)
export const DEFAULT_GARMIN_SOFTWARE_VERSION = 5.5
export const DEFAULT_GARMIN_SERIAL_NUMBER = 1234567890
export const DEFAULT_AUTO_LAP_DISTANCE_METERS = 1000

/**
 * Semicircle conversion factor: 2^31 / 180 = 2^32 / 360 = 11930464.711111112.
 */
export const SEMICIRCLES_PER_DEGREE = (2 ** 31) / 180

export function degreesToSemicircles(degrees: number): number {
  return Math.round(degrees * SEMICIRCLES_PER_DEGREE)
}

export function semicirclesToDegrees(semicircles: number): number {
  return semicircles / SEMICIRCLES_PER_DEGREE
}

export interface FitSportMapping {
  readonly sport: string
  readonly subSport: string
  readonly isStationary: boolean
}

const STRAVA_TO_FIT_SPORT: Readonly<Record<string, FitSportMapping>> = {
  Run: { sport: 'running', subSport: 'street', isStationary: false },
  TrailRun: { sport: 'running', subSport: 'trail', isStationary: false },
  Treadmill: { sport: 'running', subSport: 'treadmill', isStationary: false },
  VirtualRun: { sport: 'running', subSport: 'virtualActivity', isStationary: false },
  Walk: { sport: 'walking', subSport: 'generic', isStationary: false },
  Hike: { sport: 'hiking', subSport: 'generic', isStationary: false },
  Ride: { sport: 'cycling', subSport: 'road', isStationary: false },
  VirtualRide: { sport: 'cycling', subSport: 'virtualActivity', isStationary: false },
  GravelRide: { sport: 'cycling', subSport: 'gravelCycling', isStationary: false },
  MountainBikeRide: { sport: 'cycling', subSport: 'mountain', isStationary: false },
  EBikeRide: { sport: 'eBiking', subSport: 'generic', isStationary: false },
  Swim: { sport: 'swimming', subSport: 'lapSwimming', isStationary: false },
  AlpineSki: { sport: 'alpineSkiing', subSport: 'resort', isStationary: false },
  BackcountrySki: { sport: 'alpineSkiing', subSport: 'backcountry', isStationary: false },
  Snowboard: { sport: 'snowboarding', subSport: 'generic', isStationary: false },
  WeightTraining: { sport: 'training', subSport: 'strengthTraining', isStationary: true },
  Workout: { sport: 'training', subSport: 'strengthTraining', isStationary: true },
  Crossfit: { sport: 'training', subSport: 'cardioTraining', isStationary: true },
  Yoga: { sport: 'training', subSport: 'yoga', isStationary: true },
  Elliptical: { sport: 'fitnessEquipment', subSport: 'elliptical', isStationary: false },
  StairStepper: { sport: 'fitnessEquipment', subSport: 'stairClimbing', isStationary: true },
  RockClimbing: { sport: 'rockClimbing', subSport: 'generic', isStationary: false },
  Boxing: { sport: 'boxing', subSport: 'generic', isStationary: true },
}

const DEFAULT_SPORT_MAPPING: FitSportMapping = {
  sport: 'generic',
  subSport: 'generic',
  isStationary: false,
}

/**
 * Map Strava activity type (and optional activity name for the Boxing heuristic)
 * to official `@garmin/fitsdk` `sport` / `subSport` enum strings and stationary flag.
 */
export function mapStravaSportToFit(activityType: string, activityName?: string | null): FitSportMapping {
  if (activityName && activityName.includes('Boxing')) {
    return { sport: 'boxing', subSport: 'generic', isStationary: true }
  }
  return STRAVA_TO_FIT_SPORT[activityType] ?? DEFAULT_SPORT_MAPPING
}

/**
 * Normalize a FIT decoded sport string to the repo's canonical activity type.
 */
export function mapFitSportToActivityType(sport: string | number | null | undefined): string {
  if (sport == null) {
    return 'Run'
  }
  const normalized = String(sport).trim().toLowerCase()
  if (normalized === 'running') {
    return 'Run'
  }
  return normalized || 'Run'
}

/**
 * Produce a FIT-safe activity name: strip NUL bytes and prefer the prefix before `:` or `：`.
 */
export function sanitizeFitActivityName(rawName: string | null | undefined, activityId: number): string {
  if (rawName == null) {
    return `Strava ${activityId}`
  }
  const cleanName = String(rawName).replaceAll('\0', '').trim()
  if (!cleanName) {
    return `Strava ${activityId}`
  }

  for (const sep of [':', '：']) {
    const idx = cleanName.indexOf(sep)
    if (idx !== -1) {
      const prefix = cleanName.slice(0, idx).trim()
      if (prefix) {
        return prefix
      }
    }
  }
  return cleanName
}

/**
 * Convert pace (min/km) to speed (m/s). Zero or non-finite pace maps to 0.
 */
export function paceToSpeed(paceMinPerKm: number | null | undefined): number {
  if (paceMinPerKm == null || !Number.isFinite(paceMinPerKm) || paceMinPerKm <= 0) {
    return 0
  }
  return (1000 / 60) / paceMinPerKm
}

/**
 * Calculate stride length in meters from speed (m/s) and cadence (spm).
 * Filters out unrealistic values outside `(0.2, 3.0)` meters.
 */
export function calculateStrideLengthMeters(
  speedMps: number,
  cadenceSpm: number | null | undefined,
): number | null {
  if (!Number.isFinite(speedMps) || speedMps <= 0) {
    return null
  }
  if (cadenceSpm == null || !Number.isFinite(cadenceSpm) || cadenceSpm <= 0) {
    return null
  }
  const strideLength = speedMps / (cadenceSpm / 60)
  return strideLength > 0.2 && strideLength < 3.0 ? strideLength : null
}

export interface NormalizedFitRecord {
  readonly timestamp: Date
  readonly positionLat: number | null
  readonly positionLong: number | null
  readonly distance: number | null
  readonly altitude: number | null
  readonly speed: number | null
  readonly heartRate: number | null
  readonly cadence: number | null
  readonly power: number | null
  readonly stepLengthMm: number | null
}

export interface ComputedFitLap {
  readonly timestamp: Date
  readonly startTime: Date
  readonly totalElapsedTime: number
  readonly totalTimerTime: number
  readonly totalDistance: number
  readonly avgSpeed: number
  readonly avgHeartRate: number | null
  readonly avgCadence: number | null
  readonly avgPower: number | null
}

function meanOfValid(values: readonly (number | null)[]): number | null {
  let sum = 0
  let count = 0
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v
      count++
    }
  }
  return count > 0 ? sum / count : null
}

function buildLapSummary(
  segment: readonly NormalizedFitRecord[],
  startTime: Date,
  endTime: Date,
  distance: number,
): ComputedFitLap {
  const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000
  let avgSpeed: number
  if (elapsedTime > 0) {
    avgSpeed = distance / elapsedTime
  }
  else {
    const meanSpeed = meanOfValid(segment.map(r => r.speed))
    avgSpeed = meanSpeed ?? 0
  }

  const avgHr = meanOfValid(segment.map(r => r.heartRate))
  const avgCadence = meanOfValid(segment.map(r => r.cadence))
  const avgPower = meanOfValid(segment.map(r => r.power))

  return {
    timestamp: endTime,
    startTime,
    totalElapsedTime: elapsedTime,
    totalTimerTime: elapsedTime,
    totalDistance: distance,
    avgSpeed,
    avgHeartRate: avgHr != null ? Math.trunc(avgHr) : null,
    avgCadence: avgCadence != null ? Math.trunc(avgCadence) : null,
    avgPower: avgPower != null ? Math.trunc(avgPower) : null,
  }
}

/**
 * Split distance-bearing FIT records into auto-laps (default: 1000 m),
 * matching `scripts/export_fit.py` `calculate_laps_from_records`.
 */
export function calculateLapsFromRecords(
  records: readonly NormalizedFitRecord[],
  autoLapDistanceMeters: number = DEFAULT_AUTO_LAP_DISTANCE_METERS,
): ComputedFitLap[] {
  const splitDistance = autoLapDistanceMeters > 0 ? autoLapDistanceMeters : DEFAULT_AUTO_LAP_DISTANCE_METERS
  const withDistance = records
    .filter((r): r is NormalizedFitRecord & { distance: number } => r.distance != null && Number.isFinite(r.distance))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  if (withDistance.length === 0) {
    return []
  }

  const laps: ComputedFitLap[] = []
  let startIdx = 0
  let lapStartDist = withDistance[0].distance
  let lapStartTime = withDistance[0].timestamp

  for (let i = 0; i < withDistance.length; i++) {
    const currDist = withDistance[i].distance
    const distCovered = currDist - lapStartDist

    if (distCovered >= splitDistance) {
      const endTime = withDistance[i].timestamp
      const segStart = startIdx < i ? startIdx + 1 : startIdx
      const segment = withDistance.slice(segStart, i + 1)

      laps.push(buildLapSummary(segment, lapStartTime, endTime, distCovered))

      startIdx = i
      lapStartDist = currDist
      lapStartTime = endTime
    }
  }

  // Handle final remainder lap when meaningful distance (>10m) or elapsed time (>5s) remains
  if (startIdx < withDistance.length - 1) {
    const lastIdx = withDistance.length - 1
    const endTime = withDistance[lastIdx].timestamp
    const distCovered = withDistance[lastIdx].distance - lapStartDist
    const elapsedTime = (endTime.getTime() - lapStartTime.getTime()) / 1000

    if (distCovered > 10 || elapsedTime > 5) {
      const segStart = startIdx < lastIdx ? startIdx + 1 : startIdx
      const segment = withDistance.slice(segStart, lastIdx + 1)
      laps.push(buildLapSummary(segment, lapStartTime, endTime, distCovered))
    }
  }

  return laps
}
