const SINGLE_YEAR_RE = /^\d+$/
const YEAR_RANGE_RE = /^(\d+)-(\d+)$/
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

export interface LocalDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly dateKey: string
}

/**
 * Parse the calendar date (`YYYY-MM-DD`) from a local date/timestamp string without
 * applying host timezone conversions.
 */
export function parseLocalDateParts(value: string): LocalDateParts | null {
  const trimmed = value.trim()
  const match = LOCAL_DATE_RE.exec(trimmed)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  // Validate that the calendar date did not roll over (e.g. 2025-02-30).
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    return null
  }
  return {
    year,
    month,
    day,
    dateKey: `${match[1]}-${match[2]}-${match[3]}`,
  }
}

/**
 * Parse a naive local timestamp into UTC epoch milliseconds for elapsed-time comparisons
 * between tracks (matching Python naive `datetime` subtraction).
 */
export function parseLocalTimestampMs(value: string): number | null {
  const trimmed = value.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(trimmed)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = match[4] ? Number(match[4]) : 0
  const minute = match[5] ? Number(match[5]) : 0
  const second = match[6] ? Number(match[6]) : 0
  const ms = match[7] ? Number(match[7].slice(0, 3).padEnd(3, '0')) : 0
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  return Number.isNaN(timestamp) ? null : timestamp
}

/**
 * Return Monday-based weekday index (`0 = Monday`, ..., `6 = Sunday`),
 * matching Python `datetime.date.weekday()`.
 */
export function getMondayBasedWeekday(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return (utcDay + 6) % 7
}

/**
 * Return ISO-8601 week number (`1..53`), matching Python `datetime.date.isocalendar()[1]`.
 */
export function getIsoWeekNumber(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
}

/**
 * Format a UTC `Date` as `YYYY-MM-DD`.
 */
export function formatUtcDateKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Represent a range of years parsed from `"all"`, `"YYYY"`, or `"YYYY-YYYY"`,
 * and dynamically expanded from activity dates.
 */
export class YearRange {
  fromYear: number | null = null
  toYear: number | null = null
  private readonly yearsCounts = new Map<number, number>()

  parse(input: string): boolean {
    if (input === 'all') {
      this.fromYear = null
      this.toYear = null
      return true
    }
    if (SINGLE_YEAR_RE.test(input)) {
      const year = Number.parseInt(input, 10)
      this.fromYear = year
      this.toYear = year
      return true
    }
    const rangeMatch = YEAR_RANGE_RE.exec(input)
    if (rangeMatch) {
      const y1 = Number.parseInt(rangeMatch[1], 10)
      const y2 = Number.parseInt(rangeMatch[2], 10)
      if (y1 <= y2) {
        this.fromYear = y1
        this.toYear = y2
        return true
      }
    }
    return false
  }

  addYear(year: number): void {
    if (this.fromYear === null || this.toYear === null) {
      this.fromYear = year
      this.toYear = year
    }
    else {
      if (year < this.fromYear) {
        this.fromYear = year
      }
      if (year > this.toYear) {
        this.toYear = year
      }
    }
    this.yearsCounts.set(year, (this.yearsCounts.get(year) ?? 0) + 1)
  }

  addDate(value: string): boolean {
    const parts = parseLocalDateParts(value)
    if (!parts) {
      return false
    }
    this.addYear(parts.year)
    return true
  }

  containsYear(year: number): boolean {
    if (this.fromYear === null || this.toYear === null) {
      return true
    }
    return this.fromYear <= year && year <= this.toYear
  }

  containsDate(value: string): boolean {
    const parts = parseLocalDateParts(value)
    if (!parts) {
      return false
    }
    return this.containsYear(parts.year)
  }

  count(): number | null {
    if (this.fromYear === null || this.toYear === null) {
      return null
    }
    return 1 + this.toYear - this.fromYear
  }

  /** Number of distinct years that contain at least one activity. */
  get realYear(): number {
    return this.yearsCounts.size
  }

  all(): number[] {
    if (this.fromYear === null || this.toYear === null) {
      return []
    }
    const result: number[] = []
    for (let year = this.fromYear; year <= this.toYear; year++) {
      result.push(year)
    }
    return result
  }
}
