import { describe, expect, it } from 'vitest'
import type { Activity } from '../utils/utils'
import {
  filterYearRuns,
  filterCityRuns,
  formatPace,
  formatRunTime,
  intComma,
  sortDateFunc,
  sortDateFuncReverse,
  getMainColor,
} from '../utils/utils'

describe('formatPace', () => {
  it('should format pace correctly for normal speed', () => {
    // 3 m/s = 5'33" pace
    const result = formatPace(3)
    expect(result).toMatch(/\d+'\d{2}"/)
  })

  it('should return 0\'00" for zero speed', () => {
    const result = formatPace(0)
    expect(result).toBe("0'00\"")
  })

  it('should return 0\'00" for NaN', () => {
    const result = formatPace(Number.NaN)
    expect(result).toBe("0'00\"")
  })

  it('should handle slow pace correctly', () => {
    // 1.5 m/s = 11'06" pace approximately
    const result = formatPace(1.5)
    expect(result).toMatch(/\d+'\d{2}"/)
  })
})

describe('formatRunTime', () => {
  it('should format time without hours', () => {
    const result = formatRunTime(1800) // 30 minutes
    expect(result).toBe('30:00')
  })

  it('should format time with hours', () => {
    const result = formatRunTime(3661) // 1 hour, 1 minute, 1 second
    expect(result).toBe('1:01:01')
  })

  it('should handle zero seconds', () => {
    const result = formatRunTime(0)
    expect(result).toBe('00:00')
  })

  it('should pad minutes and seconds with zeros', () => {
    const result = formatRunTime(65) // 1 minute, 5 seconds
    expect(result).toBe('01:05')
  })
})

describe('intComma', () => {
  it('should not add comma for numbers less than 6 digits', () => {
    expect(intComma('12345')).toBe('12345')
  })

  it('should add comma for numbers with 6 or more digits', () => {
    expect(intComma('123456')).toBe('123,456')
  })

  it('should handle large numbers', () => {
    expect(intComma('1234567890')).toBe('1,234,567,890')
  })

  it('should handle empty string', () => {
    expect(intComma('')).toBe('')
  })
})

describe('filterYearRuns', () => {
  const mockActivity: Activity = {
    run_id: 1,
    name: 'Test Run',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-15 10:30:00',
    start_date_local: '2024-01-15 18:30:00',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  it('should return true for matching year', () => {
    expect(filterYearRuns(mockActivity, '2024')).toBe(true)
  })

  it('should return false for non-matching year', () => {
    expect(filterYearRuns(mockActivity, '2023')).toBe(false)
  })

  it('should handle null activity', () => {
    expect(filterYearRuns(null as unknown as Activity, '2024')).toBe(false)
  })
})

describe('filterCityRuns', () => {
  const mockActivity: Activity = {
    run_id: 1,
    name: 'Test Run',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-15 10:30:00',
    start_date_local: '2024-01-15 18:30:00',
    location_country: '北京市朝阳区, 中国',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  it('should return true for matching city', () => {
    expect(filterCityRuns(mockActivity, '北京')).toBe(true)
  })

  it('should return false for non-matching city', () => {
    expect(filterCityRuns(mockActivity, '上海')).toBe(false)
  })

  it('should return false for activity without location', () => {
    const activityWithoutLocation = { ...mockActivity, location_country: null }
    expect(filterCityRuns(activityWithoutLocation, '北京')).toBe(false)
  })
})

describe('sortDateFunc', () => {
  const activity1: Activity = {
    run_id: 1,
    name: 'Run 1',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-15 10:30:00',
    start_date_local: '2024-01-15 10:30:00',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  const activity2: Activity = {
    run_id: 2,
    name: 'Run 2',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-16 10:30:00',
    start_date_local: '2024-01-16 10:30:00',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  it('should sort newer activities first', () => {
    const result = sortDateFunc(activity1, activity2)
    expect(result).toBeGreaterThan(0) // activity2 is newer, so activity1 should come after
  })

  it('should sort older activities last', () => {
    const result = sortDateFunc(activity2, activity1)
    expect(result).toBeLessThan(0)
  })

  it('should return 0 for same date', () => {
    const result = sortDateFunc(activity1, activity1)
    expect(result).toBe(0)
  })
})

describe('sortDateFuncReverse', () => {
  const activity1: Activity = {
    run_id: 1,
    name: 'Run 1',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-15 10:30:00',
    start_date_local: '2024-01-15 10:30:00',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  const activity2: Activity = {
    run_id: 2,
    name: 'Run 2',
    distance: 5000,
    moving_time: 1800,
    type: 'Run',
    subtype: 'generic',
    start_date: '2024-01-16 10:30:00',
    start_date_local: '2024-01-16 10:30:00',
    average_speed: 2.78,
    elevation_gain: 50,
    streak: 1,
  }

  it('should sort older activities first (reverse order)', () => {
    const result = sortDateFuncReverse(activity1, activity2)
    expect(result).toBeLessThan(0)
  })
})

describe('getMainColor', () => {
  it('should return a valid color string', () => {
    const result = getMainColor()
    expect(result).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
})
