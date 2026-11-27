import { describe, expect, it } from 'vitest'
import {
  hslToRgb,
  interpolateColor,
  parseColorToRgb,
  resolveDistanceColor,
  rgbToHex,
  rgbToHsl,
} from './color.js'
import { ParameterError } from './errors.js'
import { DARK_POSTER_THEME, LIGHT_POSTER_THEME } from './poster.js'
import { formatDateInTimezone, lookupTimezone, parseDatetimeToLocal } from './timezone.js'
import { ValueRange } from './value-range.js'
import {
  formatUtcDateKey,
  getIsoWeekNumber,
  getMondayBasedWeekday,
  parseLocalDateParts,
  parseLocalTimestampMs,
  YearRange,
} from './year-range.js'

describe('svg color interpolation and tier resolution', () => {
  it('parses 3-digit hex, 6-digit hex, and CSS named colors, and rejects invalid inputs', () => {
    expect(parseColorToRgb('#fff')).toEqual([1, 1, 1])
    expect(parseColorToRgb('#000000')).toEqual([0, 0, 0])
    expect(parseColorToRgb('yellow')).toEqual([1, 1, 0])
    expect(parseColorToRgb('RED')).toEqual([1, 0, 0])
    expect(parseColorToRgb(' #4dd2ff ')).toEqual([0x4D / 255, 0xD2 / 255, 1])

    expect(() => parseColorToRgb('not-a-color')).toThrow(ParameterError)
    expect(() => parseColorToRgb('#12345')).toThrow(ParameterError)
  })

  it('round-trips RGB <-> HSL <-> Hex accurately', () => {
    const samples = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#4dd2ff', '#024a70', '#ff8904']
    for (const hex of samples) {
      const [r, g, b] = parseColorToRgb(hex)
      const [h, s, l] = rgbToHsl(r, g, b)
      const [r2, g2, b2] = hslToRgb(h, s, l)
      expect(rgbToHex(r2, g2, b2)).toBe(hex)
    }
  })

  it('interpolates colors linearly in HSL space and clamps ratio to [0, 1]', () => {
    expect(interpolateColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(interpolateColor('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(interpolateColor('#000000', '#ffffff', -0.5)).toBe('#000000')
    expect(interpolateColor('#000000', '#ffffff', 2.0)).toBe('#ffffff')

    // Red (h=0) -> Yellow (h=1/6) midpoint is orange (h=1/12 => #ff7f00 in IEEE 754)
    expect(interpolateColor('red', 'yellow', 0.5)).toBe('#ff7f00')
    // Dark theme track -> special midpoint
    const mid = interpolateColor('#4DD2FF', 'yellow', 0.5)
    expect(mid).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('resolves distance color tiers for dark and light themes', () => {
    const trackRange = ValueRange.fromPair(3000, 25000)
    const dateRange = ValueRange.fromPair(3000, 25000)
    const specialDistance = { specialDistance: 10, specialDistance2: 20 }

    // Below specialDistance (5 km): normal track color
    const normalDark = resolveDistanceColor({
      lengthMeters: 5000,
      dateLengthRange: dateRange,
      trackLengthRange: trackRange,
      theme: DARK_POSTER_THEME,
      specialDistance,
    })
    expect(normalDark).toBe('#4dd2ff')

    // Between specialDistance and specialDistance2 (15 km): interpolated toward special
    const midLight = resolveDistanceColor({
      lengthMeters: 15000,
      dateLengthRange: dateRange,
      trackLengthRange: trackRange,
      theme: LIGHT_POSTER_THEME,
      specialDistance,
    })
    expect(midLight).not.toBe('#525252')
    expect(midLight).not.toBe('#ff8904')
    expect(midLight).toMatch(/^#[0-9a-f]{6}$/)

    // At or above specialDistance2 (21.1 km): special2 color
    const longDark = resolveDistanceColor({
      lengthMeters: 21100,
      dateLengthRange: dateRange,
      trackLengthRange: trackRange,
      theme: DARK_POSTER_THEME,
      specialDistance,
    })
    expect(longDark).toBe('red')

    const longLight = resolveDistanceColor({
      lengthMeters: 21100,
      dateLengthRange: dateRange,
      trackLengthRange: trackRange,
      theme: LIGHT_POSTER_THEME,
      specialDistance,
    })
    expect(longLight).toBe('#ff8904')
  })
})

describe('valueRange and YearRange parsing', () => {
  it('tracks numeric bounds and containment in ValueRange', () => {
    const empty = new ValueRange()
    expect(empty.isValid()).toBe(false)
    expect(empty.diameter()).toBe(0)
    expect(empty.contains(5)).toBe(false)

    const range = ValueRange.fromPair(10, 30)
    expect(range.isValid()).toBe(true)
    expect(range.lower).toBe(10)
    expect(range.upper).toBe(30)
    expect(range.diameter()).toBe(20)
    expect(range.contains(10)).toBe(true)
    expect(range.contains(20)).toBe(true)
    expect(range.contains(30)).toBe(true)
    expect(range.contains(31)).toBe(false)
  })

  it('parses all, single-year, and multi-year ranges and rejects invalid specs', () => {
    const allRange = new YearRange()
    expect(allRange.parse('all')).toBe(true)
    expect(allRange.fromYear).toBeNull()
    expect(allRange.toYear).toBeNull()
    expect(allRange.containsYear(2020)).toBe(true)
    expect(allRange.count()).toBeNull()

    const single = new YearRange()
    expect(single.parse('2025')).toBe(true)
    expect(single.all()).toEqual([2025])
    expect(single.containsYear(2025)).toBe(true)
    expect(single.containsYear(2024)).toBe(false)
    expect(single.containsDate('2025-03-15T08:30:00')).toBe(true)
    expect(single.containsDate('2024-12-31T23:59:59')).toBe(false)

    const multi = new YearRange()
    expect(multi.parse('2022-2025')).toBe(true)
    expect(multi.all()).toEqual([2022, 2023, 2024, 2025])
    expect(multi.count()).toBe(4)

    expect(new YearRange().parse('2025-2022')).toBe(false)
    expect(new YearRange().parse('not-a-year')).toBe(false)
    expect(new YearRange().parse('2022-2023-2024')).toBe(false)

    // Tracks distinct active years via addYear / realYear
    const dynamic = new YearRange()
    dynamic.addYear(2022)
    dynamic.addYear(2025)
    dynamic.addYear(2025)
    expect(dynamic.realYear).toBe(2)
    expect(dynamic.all()).toEqual([2022, 2023, 2024, 2025])
  })

  it('parses local date parts, timestamps, ISO week numbers, and Monday-based weekdays', () => {
    expect(parseLocalDateParts('2025-03-15T08:30:00')).toEqual({
      year: 2025,
      month: 3,
      day: 15,
      dateKey: '2025-03-15',
    })
    expect(parseLocalDateParts('invalid')).toBeNull()
    expect(parseLocalDateParts('2025-13-01')).toBeNull()

    expect(parseLocalTimestampMs('2025-03-15 08:30:00')).toBe(Date.UTC(2025, 2, 15, 8, 30, 0))
    expect(formatUtcDateKey(new Date(Date.UTC(2025, 2, 15)))).toBe('2025-03-15')

    // 2025-01-01 is a Wednesday (Monday=0 -> Wednesday=2, ISO week 1)
    expect(getMondayBasedWeekday(2025, 1, 1)).toBe(2)
    expect(getIsoWeekNumber(2025, 1, 1)).toBe(1)
    // 2025-01-06 is Monday (Monday=0, ISO week 2)
    expect(getMondayBasedWeekday(2025, 1, 6)).toBe(0)
    expect(getIsoWeekNumber(2025, 1, 6)).toBe(2)
  })
})

describe('coordinate timezone lookup and local datetime conversion', () => {
  it('resolves IANA timezones from coordinates and falls back to Asia/Shanghai', () => {
    expect(lookupTimezone(39.944, 116.482)).toBe('Asia/Shanghai')
    expect(lookupTimezone(40.7128, -74.006)).toBe('America/New_York')
    expect(lookupTimezone(51.5074, -0.1278)).toBe('Europe/London')

    expect(lookupTimezone(null, null)).toBe('Asia/Shanghai')
    expect(lookupTimezone(undefined, 116.482)).toBe('Asia/Shanghai')
    expect(lookupTimezone(999, 0)).toBe('Asia/Shanghai')
    expect(lookupTimezone(Number.NaN, 0)).toBe('Asia/Shanghai')
  })

  it('converts UTC instants to local wall-clock strings in target timezone', () => {
    const instant = new Date('2025-03-15T00:30:00Z')
    expect(formatDateInTimezone(instant, 'Asia/Shanghai')).toBe('2025-03-15T08:30:00')
    expect(formatDateInTimezone(instant, 'America/New_York')).toBe('2025-03-14T20:30:00')

    const beijing = parseDatetimeToLocal(
      '2025-03-15T00:30:00Z',
      '2025-03-15T00:55:30Z',
      [39.944, 116.482],
    )
    expect(beijing).toEqual({
      startDateLocal: '2025-03-15T08:30:00',
      endDateLocal: '2025-03-15T08:55:30',
      timeZone: 'Asia/Shanghai',
    })

    // Missing coordinates fall back to Asia/Shanghai
    const fallback = parseDatetimeToLocal('2025-03-15T00:30:00Z', null, null)
    expect(fallback.timeZone).toBe('Asia/Shanghai')
    expect(fallback.startDateLocal).toBe('2025-03-15T08:30:00')
    expect(fallback.endDateLocal).toBeUndefined()
  })
})
