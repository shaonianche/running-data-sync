import tzLookup from '@photostructure/tz-lookup'
import { BASE_TIMEZONE } from '../foundation/constants.js'

const OFFSET_SUFFIX_RE = /(?:[+-]\d{2}:?\d{2}|Z)$/i

/**
 * Resolve an IANA timezone name from geographic coordinates, falling back to `Asia/Shanghai`
 * when coordinates are missing, out of range, or lookup fails.
 */
export function lookupTimezone(
  lat: number | null | undefined,
  lng: number | null | undefined,
  fallbackTimeZone: string = BASE_TIMEZONE,
): string {
  if (
    typeof lat !== 'number'
    || typeof lng !== 'number'
    || !Number.isFinite(lat)
    || !Number.isFinite(lng)
    || lat < -90
    || lat > 90
    || lng < -180
    || lng > 180
  ) {
    return fallbackTimeZone
  }

  try {
    const resolved = tzLookup(lat, lng)
    return resolved || fallbackTimeZone
  }
  catch {
    return fallbackTimeZone
  }
}

/**
 * Format an instant (`Date`) as a local ISO-like wall-clock timestamp (`YYYY-MM-DDTHH:mm:ss`)
 * in the target IANA timezone using Node's built-in `Intl.DateTimeFormat`.
 */
export function formatDateInTimezone(date: Date, timeZone: string): string {
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
    if (part.type !== 'literal') {
      map[part.type] = part.value
    }
  }

  const hour = map.hour === '24' ? '00' : map.hour
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`
}

function toUtcDate(input: Date | string): Date | null {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input
  }
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const isoCandidate = OFFSET_SUFFIX_RE.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`
  const parsed = new Date(isoCandidate)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export interface LocalDatetimeConversionResult {
  readonly startDateLocal: string
  readonly endDateLocal?: string
  readonly timeZone: string
}

/**
 * Convert UTC start/end timestamps into local wall-clock timestamps using a coordinate's
 * IANA timezone (falling back to `Asia/Shanghai`).
 */
export function parseDatetimeToLocal(
  startDate: Date | string,
  endDate?: Date | string | null,
  point?: readonly [number, number] | null,
  fallbackTimeZone: string = BASE_TIMEZONE,
): LocalDatetimeConversionResult {
  const timeZone = point
    ? lookupTimezone(point[0], point[1], fallbackTimeZone)
    : fallbackTimeZone

  const startInstant = toUtcDate(startDate)
  const endInstant = endDate !== undefined && endDate !== null ? toUtcDate(endDate) : null

  const formatSafe = (instant: Date | null, raw: Date | string): string => {
    if (!instant) {
      return typeof raw === 'string' ? raw : raw.toISOString()
    }
    try {
      return formatDateInTimezone(instant, timeZone)
    }
    catch {
      return formatDateInTimezone(instant, fallbackTimeZone)
    }
  }

  return {
    startDateLocal: formatSafe(startInstant, startDate),
    ...(endDate !== undefined && endDate !== null
      ? { endDateLocal: formatSafe(endInstant, endDate) }
      : {}),
    timeZone,
  }
}
