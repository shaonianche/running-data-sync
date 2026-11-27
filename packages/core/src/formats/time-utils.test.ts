import { describe, expect, it, vi } from 'vitest'
import { formatLocalDateTime } from './time-utils.js'

describe('formatLocalDateTime', () => {
  it('formats midnight as T00:00:00 and never T24:00:00', () => {
    const midnightShanghai = new Date('2025-03-15T16:00:00Z')
    expect(formatLocalDateTime(midnightShanghai, 'Asia/Shanghai')).toBe('2025-03-16T00:00:00')

    const midnightUtc = new Date('2025-03-16T00:00:00Z')
    expect(formatLocalDateTime(midnightUtc, 'UTC')).toBe('2025-03-16T00:00:00')

    const midnightNy = new Date('2025-03-16T04:00:00Z')
    expect(formatLocalDateTime(midnightNy, 'America/New_York')).toBe('2025-03-16T00:00:00')
  })

  it('normalizes ICU midnight hour "24" to "00"', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
      { type: 'year', value: '2025' },
      { type: 'literal', value: '-' },
      { type: 'month', value: '03' },
      { type: 'literal', value: '-' },
      { type: 'day', value: '16' },
      { type: 'literal', value: ', ' },
      { type: 'hour', value: '24' },
      { type: 'literal', value: ':' },
      { type: 'minute', value: '00' },
      { type: 'literal', value: ':' },
      { type: 'second', value: '00' },
    ])

    try {
      expect(formatLocalDateTime(new Date('2025-03-15T16:00:00Z'), 'Asia/Shanghai')).toBe('2025-03-16T00:00:00')
    }
    finally {
      spy.mockRestore()
    }
  })
})
