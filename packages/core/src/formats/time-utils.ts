import { BASE_TIMEZONE } from '../foundation/constants.js'
import { ParseError } from '../foundation/errors.js'

const EXPLICIT_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:?\d{2})$/
const NAIVE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

const EARTH_RADIUS_METERS = 6371000

/**
 * Parse a timestamp string or Date into a UTC Date.
 * Naive strings (`YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DDTHH:MM:SS`) are treated as UTC
 * to stay deterministic regardless of the host timezone.
 */
export function parseUtcDate(value: string | Date): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ParseError('Invalid Date value')
    }
    return new Date(value.getTime())
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new ParseError('Empty timestamp string')
  }

  const naiveMatch = NAIVE_TIMESTAMP_RE.exec(trimmed)
  const normalized = naiveMatch ? `${naiveMatch[1]}T${naiveMatch[2]}Z` : trimmed
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) {
    throw new ParseError(`Invalid timestamp: "${value}"`)
  }
  return new Date(ms)
}

/**
 * Format a UTC Date as ISO-8601 (`YYYY-MM-DDTHH:mm:ssZ`, keeping fractional ms only when non-zero).
 */
export function formatUtcIso(date: Date): string {
  const iso = date.toISOString()
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso
}

/**
 * Format a UTC Date into a local wall-clock ISO string (`YYYY-MM-DDTHH:mm:ss`)
 * in the specified IANA timezone (default: `BASE_TIMEZONE`, i.e. `Asia/Shanghai`).
 */
export function formatLocalDateTime(date: Date, timeZone: string = BASE_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(date)
  const map: Record<string, string> = {}
  for (const part of parts) {
    map[part.type] = part.value
  }
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`
}

/**
 * Convert start/end timestamps to local wall-clock strings.
 * If the raw input timestamp carried an explicit non-UTC offset (e.g. `+08:00`),
 * preserve that offset directly; otherwise convert using `BASE_TIMEZONE`.
 */
export function resolveLocalDateBounds(
  startDate: Date,
  endDate: Date,
  rawStartTimestamp?: string | null,
  rawEndTimestamp?: string | null,
): { startDateLocal: string, endDateLocal: string } {
  const startMatch = rawStartTimestamp ? EXPLICIT_OFFSET_RE.exec(rawStartTimestamp.trim()) : null
  const endMatch = rawEndTimestamp ? EXPLICIT_OFFSET_RE.exec(rawEndTimestamp.trim()) : null
  if (startMatch && endMatch) {
    return {
      startDateLocal: `${startMatch[1]}T${startMatch[2]}`,
      endDateLocal: `${endMatch[1]}T${endMatch[2]}`,
    }
  }
  return {
    startDateLocal: formatLocalDateTime(startDate),
    endDateLocal: formatLocalDateTime(endDate),
  }
}

/**
 * Compute great-circle Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Compute cumulative positive elevation gain (uphill) in meters across a sequence of altitudes.
 */
export function computeElevationGain(altitudes: readonly (number | null | undefined)[]): number | null {
  let prev: number | null = null
  let hasAltitude = false
  let gain = 0

  for (const alt of altitudes) {
    if (alt == null || !Number.isFinite(alt)) {
      continue
    }
    hasAltitude = true
    if (prev !== null && alt > prev) {
      gain += alt - prev
    }
    prev = alt
  }

  return hasAltitude ? Math.round(gain * 100) / 100 : null
}
