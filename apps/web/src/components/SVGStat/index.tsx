import { totalStat } from '@assets/index'
import { lazy, memo, Suspense, useEffect, useMemo } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { loadSvgComponent } from '@/utils/svgUtils'
import { preloadOtherThemeSvgs } from './preload'
import styles from './style.module.css'

function LoadingPlaceholder({ height = 200 }: { height?: number }) {
  return (
    <div
      className={styles.placeholder}
      style={{ height }}
      aria-live="polite"
    >
      <div className={styles.shimmer} />
    </div>
  )
}

function SVGStat() {
  const { theme, isDark } = useTheme()

  const { GithubSvg, GridSvg } = useMemo(() => {
    const suffix = isDark ? '' : '-light'

    return {
      GithubSvg: lazy(() => loadSvgComponent(totalStat, `./github${suffix}.svg`)),
      GridSvg: lazy(() => loadSvgComponent(totalStat, `./grid${suffix}.svg`)),
    }
  }, [isDark])

  useEffect(() => {
    preloadOtherThemeSvgs(theme)
  }, [theme])

  return (
    <div id="svgStat" className={styles.container}>
      <Suspense fallback={<LoadingPlaceholder height={150} />}>
        <GithubSvg className={styles.svg} />
      </Suspense>
      <Suspense fallback={<LoadingPlaceholder height={400} />}>
        <GridSvg className={styles.svg} />
      </Suspense>
    </div>
  )
}

export default memo(SVGStat)
