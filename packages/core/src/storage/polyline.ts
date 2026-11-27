import process from 'node:process'
import polyline from '@mapbox/polyline'
import { ConfigurationError } from '../foundation/errors.js'

/** Mean Earth radius in km matching Python `haversine` (`AVG_EARTH_RADIUS_KM`). */
export const EARTH_RADIUS_KM = 6371.0088

export type LatLngPoint = readonly [latitude: number, longitude: number]

export interface PolylinePrivacyOptions {
  /** Encoded polyline whose decoded points define exclusion zone centers (`IGNORE_POLYLINE`). */
  readonly ignorePolyline?: string
  /** Explicit exclusion zone centers (overrides `ignorePolyline` when provided). */
  readonly ignorePoints?: readonly LatLngPoint[]
  /** Exclusion zone radius in meters (`IGNORE_RANGE`). Defaults to 0. */
  readonly ignoreRangeMeters?: number
  /** Distance in meters trimmed from both start and end (`IGNORE_START_END_RANGE`). Defaults to 0. */
  readonly ignoreStartEndRangeMeters?: number
  /** Optional environment source for fallback lookup. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface ResolvedPolylinePrivacyConfig {
  readonly ignorePoints: readonly LatLngPoint[]
  readonly ignoreRangeKm: number
  readonly ignoreStartEndRangeKm: number
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * Great-circle Haversine distance in kilometers between two `(lat, lng)` points,
 * matching Python's `haversine.haversine(a, b)` default km calculation.
 */
export function haversineDistanceKm(pointA: LatLngPoint, pointB: LatLngPoint): number {
  const lat1 = toRadians(pointA[0])
  const lng1 = toRadians(pointA[1])
  const lat2 = toRadians(pointB[0])
  const lng2 = toRadians(pointB[1])

  const dLat = lat2 - lat1
  const dLng = lng2 - lng1

  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(a)))
  return EARTH_RADIUS_KM * c
}

function parseNonNegativeMeters(raw: string | undefined, envKey: string): number {
  if (raw === undefined || raw.trim() === '') {
    return 0
  }
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
    throw new ConfigurationError(`${envKey} must be an integer number of meters, got "${raw}".`)
  }
  return parsed
}

export function resolvePolylinePrivacyConfig(
  options: PolylinePrivacyOptions = {},
): ResolvedPolylinePrivacyConfig {
  const env = options.env ?? process.env

  let ignorePoints: readonly LatLngPoint[]
  if (options.ignorePoints !== undefined) {
    ignorePoints = options.ignorePoints
  }
  else {
    const rawIgnorePolyline = options.ignorePolyline ?? env.IGNORE_POLYLINE
    if (rawIgnorePolyline) {
      try {
        ignorePoints = polyline.decode(rawIgnorePolyline)
      }
      catch (error) {
        throw new ConfigurationError('IGNORE_POLYLINE is not a valid encoded polyline.', { cause: error })
      }
    }
    else {
      ignorePoints = []
    }
  }

  const ignoreRangeMeters = options.ignoreRangeMeters !== undefined
    ? options.ignoreRangeMeters
    : parseNonNegativeMeters(env.IGNORE_RANGE, 'IGNORE_RANGE')

  const ignoreStartEndRangeMeters = options.ignoreStartEndRangeMeters !== undefined
    ? options.ignoreStartEndRangeMeters
    : parseNonNegativeMeters(env.IGNORE_START_END_RANGE, 'IGNORE_START_END_RANGE')

  return {
    ignorePoints,
    ignoreRangeKm: ignoreRangeMeters / 1000,
    ignoreStartEndRangeKm: ignoreStartEndRangeMeters / 1000,
  }
}

export function hideStartEndPoints(
  points: readonly LatLngPoint[],
  distanceKm: number,
): LatLngPoint[] {
  if (points.length === 0) {
    return []
  }

  let startIndex = 0
  let endIndex = points.length - 1

  let startingDistance = 0
  for (let i = 1; i < points.length; i += 1) {
    startingDistance += haversineDistanceKm(points[i], points[i - 1])
    if (startingDistance > distanceKm) {
      startIndex = i
      break
    }
  }

  let endingDistance = 0
  for (let i = points.length - 2; i >= 0; i -= 1) {
    endingDistance += haversineDistanceKm(points[i], points[i + 1])
    if (endingDistance > distanceKm) {
      endIndex = i
      break
    }
  }

  if (startIndex >= endIndex) {
    return []
  }

  return points.slice(startIndex, endIndex + 1)
}

export function hidePointsInRange(
  points: readonly LatLngPoint[],
  ignorePoints: readonly LatLngPoint[],
  distanceKm: number,
): LatLngPoint[] {
  if (ignorePoints.length === 0 || distanceKm <= 0) {
    return [...points]
  }
  return points.filter(point =>
    !ignorePoints.some(center => haversineDistanceKm(point, center) < distanceKm),
  )
}

/**
 * Applies start/end distance clipping and exclusion-zone filtering to an encoded polyline.
 * Mirrors `scripts/polyline_processor.py#filter_out`.
 */
export function filterPolyline(
  polylineStr: string | null | undefined,
  options: PolylinePrivacyOptions = {},
): string | null {
  if (!polylineStr) {
    return null
  }

  const decoded = polyline.decode(polylineStr)
  if (decoded.length === 0) {
    return polylineStr
  }

  const config = resolvePolylinePrivacyConfig(options)
  const trimmed = hideStartEndPoints(decoded, config.ignoreStartEndRangeKm)
  const filtered = hidePointsInRange(trimmed, config.ignorePoints, config.ignoreRangeKm)
  if (filtered.length === 0) {
    return null
  }

  return polyline.encode(filtered as [number, number][])
}
