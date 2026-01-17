import { totalStat } from '@assets/index'

const svgCache = new Map<string, Promise<unknown>>()

function preloadSvg(path: string) {
  if (!svgCache.has(path) && totalStat[path]) {
    svgCache.set(path, totalStat[path]())
  }
}

export function preloadTotalSvgs() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const savedTheme = localStorage.getItem('theme')
  const useDark = savedTheme === 'dark' || (savedTheme !== 'light' && isDark)
  const suffix = useDark ? '' : '-light'

  preloadSvg(`./github${suffix}.svg`)
  preloadSvg(`./grid${suffix}.svg`)
}

export function preloadOtherThemeSvgs(currentTheme: 'light' | 'dark' | 'system') {
  const isDark = currentTheme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : currentTheme === 'dark'
  const otherSuffix = isDark ? '-light' : ''
  preloadSvg(`./github${otherSuffix}.svg`)
  preloadSvg(`./grid${otherSuffix}.svg`)
}
