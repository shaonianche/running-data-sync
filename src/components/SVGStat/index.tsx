import { totalStat } from '@assets/index'
import { lazy, memo, Suspense, useEffect, useMemo } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { loadSvgComponent } from '@/utils/svgUtils'
import { preloadOtherThemeSvgs } from './preload'

function LoadingPlaceholder({ height = 200 }: { height?: number }) {
  return (
    <div
      className="mt-4 rounded overflow-hidden"
      style={{ height }}
      aria-live="polite"
    >
      <div className="h-full w-full bg-gradient-to-r from-[var(--color-hr)] via-[var(--color-background)] to-[var(--color-hr)] bg-[length:200%_100%] animate-[shimmer_1.5s_infinite]" />
    </div>
  )
}

function SVGStat() {
  const { theme } = useTheme()

  const { GithubSvg, GridSvg } = useMemo(() => {
    const isDark = theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : theme === 'dark'
    const suffix = isDark ? '' : '-light'

    return {
      GithubSvg: lazy(() => loadSvgComponent(totalStat, `./github${suffix}.svg`)),
      GridSvg: lazy(() => loadSvgComponent(totalStat, `./grid${suffix}.svg`)),
    }
  }, [theme])

  useEffect(() => {
    preloadOtherThemeSvgs(theme)
  }, [theme])

  return (
    <div id="svgStat" className="transition-colors duration-200">
      <Suspense fallback={<LoadingPlaceholder height={150} />}>
        <GithubSvg className="mt-4 h-auto w-full" />
      </Suspense>
      <Suspense fallback={<LoadingPlaceholder height={400} />}>
        <GridSvg className="mt-4 h-auto w-full" />
      </Suspense>
    </div>
  )
}

export default memo(SVGStat)
