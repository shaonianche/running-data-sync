import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './useTheme'

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(ThemeProvider, null, children)
  }
}

describe('useTheme', () => {
  let colorSchemeMeta: HTMLMetaElement
  let matchesDark = false
  let listeners: Array<() => void> = []
  let storage: Record<string, string> = {}

  beforeEach(() => {
    storage = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key in storage ? storage[key] : null),
      setItem: (key: string, value: string) => {
        storage[key] = value
      },
      removeItem: (key: string) => {
        delete storage[key]
      },
      clear: () => {
        storage = {}
      },
    })
    document.documentElement.removeAttribute('data-theme')
    colorSchemeMeta = document.createElement('meta')
    colorSchemeMeta.name = 'color-scheme'
    colorSchemeMeta.content = 'light dark'
    document.head.appendChild(colorSchemeMeta)

    matchesDark = false
    listeners = []
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      get matches() {
        return matchesDark
      },
      media: '(prefers-color-scheme: dark)',
      addEventListener: (_event: string, cb: () => void) => {
        listeners.push(cb)
      },
      removeEventListener: (_event: string, cb: () => void) => {
        listeners = listeners.filter(fn => fn !== cb)
      },
    })))
  })

  afterEach(() => {
    colorSchemeMeta?.remove()
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
  })

  it('defaults to system and keeps meta color-scheme as light dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper() })

    expect(result.current.theme).toBe('system')
    expect(result.current.isDark).toBe(false)
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
    expect(colorSchemeMeta.getAttribute('content')).toBe('light dark')
  })

  it('syncs data-theme, meta color-scheme, and localStorage across light/dark/system', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper() })

    act(() => {
      result.current.setTheme('dark')
    })
    expect(result.current.theme).toBe('dark')
    expect(result.current.isDark).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(colorSchemeMeta.getAttribute('content')).toBe('dark')
    expect(localStorage.getItem('theme')).toBe('dark')

    act(() => {
      result.current.setTheme('light')
    })
    expect(result.current.theme).toBe('light')
    expect(result.current.isDark).toBe(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(colorSchemeMeta.getAttribute('content')).toBe('light')
    expect(localStorage.getItem('theme')).toBe('light')

    act(() => {
      result.current.setTheme('system')
    })
    expect(result.current.theme).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
    expect(colorSchemeMeta.getAttribute('content')).toBe('light dark')
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('follows system preference changes in system mode without unpinning explicit overrides', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: createWrapper() })

    act(() => {
      matchesDark = true
      listeners.forEach(cb => cb())
    })
    expect(result.current.theme).toBe('system')
    expect(result.current.isDark).toBe(true)

    act(() => {
      result.current.setTheme('light')
    })
    expect(result.current.isDark).toBe(false)

    act(() => {
      matchesDark = false
      listeners.forEach(cb => cb())
    })
    expect(result.current.theme).toBe('light')
    expect(localStorage.getItem('theme')).toBe('light')
  })
})
