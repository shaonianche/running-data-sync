import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import useHover from '../hooks/useHover'

describe('useHover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should initialize with hovered as false', () => {
    const { result } = renderHook(() => useHover())

    expect(result.current[0]).toBe(false)
  })

  it('should return event handlers', () => {
    const { result } = renderHook(() => useHover())

    expect(result.current[1]).toHaveProperty('onMouseOver')
    expect(result.current[1]).toHaveProperty('onMouseOut')
    expect(typeof result.current[1].onMouseOver).toBe('function')
    expect(typeof result.current[1].onMouseOut).toBe('function')
  })

  it('should set hovered to true after delay on mouse over', () => {
    const { result } = renderHook(() => useHover())

    act(() => {
      result.current[1].onMouseOver()
    })

    // Before timeout
    expect(result.current[0]).toBe(false)

    // After 500ms timeout
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(result.current[0]).toBe(true)
  })

  it('should set hovered to false on mouse out', () => {
    const { result } = renderHook(() => useHover())

    // First, trigger hover
    act(() => {
      result.current[1].onMouseOver()
      vi.advanceTimersByTime(500)
    })

    expect(result.current[0]).toBe(true)

    // Then mouse out
    act(() => {
      result.current[1].onMouseOut()
    })

    expect(result.current[0]).toBe(false)
  })

  it('should cancel timer if mouse out before delay', () => {
    const { result } = renderHook(() => useHover())

    act(() => {
      result.current[1].onMouseOver()
    })

    // Mouse out before 500ms
    act(() => {
      vi.advanceTimersByTime(200)
      result.current[1].onMouseOut()
    })

    // Even after more time passes, should still be false
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(result.current[0]).toBe(false)
  })
})
