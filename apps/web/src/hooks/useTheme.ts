import type { ReactNode } from 'react'
import {
  createContext,
  createElement,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

export type Theme = 'light' | 'dark' | 'system'

export interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Resolved dark mode after applying system preference. */
  isDark: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') {
    return 'system'
  }
  try {
    const stored = localStorage.getItem('theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  }
  catch {
    return 'system'
  }
  return 'system'
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolve a theme preference to concrete dark/light (usable outside React). */
export function resolveIsDark(theme: Theme, systemDark = readSystemDark()): boolean {
  if (theme === 'dark')
    return true
  if (theme === 'light')
    return false
  return systemDark
}

function applyThemeToDocument(theme: Theme) {
  const root = window.document.documentElement
  const meta = window.document.querySelector('meta[name="color-scheme"]')
  if (theme === 'system') {
    root.removeAttribute('data-theme')
    if (meta) {
      meta.setAttribute('content', 'light dark')
    }
  }
  else {
    root.setAttribute('data-theme', theme)
    if (meta) {
      meta.setAttribute('content', theme)
    }
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [systemDark, setSystemDark] = useState(readSystemDark)

  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Cross-tab / external localStorage updates
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'theme' || e.key === null) {
        setThemeState(readStoredTheme())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme)
    try {
      if (newTheme === 'system') {
        localStorage.removeItem('theme')
      }
      else {
        localStorage.setItem('theme', newTheme)
      }
    }
    catch {
      // Storage may be blocked; still apply theme to the active document.
    }
    applyThemeToDocument(newTheme)
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    isDark: resolveIsDark(theme, systemDark),
  }), [theme, setTheme, systemDark])

  return createElement(ThemeContext.Provider, { value }, children)
}

export function useTheme(): ThemeContextValue {
  const ctx = use(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return ctx
}
