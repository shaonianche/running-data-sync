import type { Theme } from '@/hooks/useTheme'
import { totalStat } from '@assets/index'
import { resolveIsDark } from '@/hooks/useTheme'

const svgCache = new Map<string, Promise<unknown>>()

function preloadSvg(path: string) {
  if (!svgCache.has(path) && totalStat[path]) {
    svgCache.set(path, totalStat[path]())
  }
}

function readThemePreference(): Theme {
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
  }
  return 'system'
}

/** Preload SVGs for the currently active theme only. */
export function preloadTotalSvgs() {
  const useDark = resolveIsDark(readThemePreference())
  const suffix = useDark ? '' : '-light'
  preloadSvg(`./github${suffix}.svg`)
  preloadSvg(`./grid${suffix}.svg`)
}

/** Warm the alternate theme SVGs after the user opens Total view. */
export function preloadOtherThemeSvgs(currentTheme: Theme) {
  const isDark = resolveIsDark(currentTheme)
  const otherSuffix = isDark ? '-light' : ''
  preloadSvg(`./github${otherSuffix}.svg`)
  preloadSvg(`./grid${otherSuffix}.svg`)
}
