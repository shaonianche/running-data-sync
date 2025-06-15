import { totalStat } from '@assets/index'
import { lazy, Suspense, useMemo } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { loadSvgComponent } from '@/utils/svgUtils'

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

  return (
    <div id="svgStat" className="transition-colors duration-200">
      <Suspense fallback={<div className="text-center">Loading...</div>}>
        <GithubSvg className="mt-4 h-auto w-full" />
        <GridSvg className="mt-4 h-auto w-full" />
      </Suspense>
    </div>
  )
}

export default SVGStat
