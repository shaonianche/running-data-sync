import { totalStat } from '@assets/index'
import { lazy, Suspense } from 'react'
import { loadSvgComponent } from '@/utils/svgUtils'

// Lazy load both github.svg and grid.svg
const GithubSvg = lazy(() => loadSvgComponent(totalStat, './github.svg'))

const GridSvg = lazy(() => loadSvgComponent(totalStat, './grid.svg'))

function SVGStat() {
  return (
    <div id="svgStat">
      <Suspense fallback={<div className="text-center">Loading...</div>}>
        <GithubSvg className="mt-4 h-auto w-full" />
        <GridSvg className="mt-4 h-auto w-full" />
      </Suspense>
    </div>
  )
}

export default SVGStat
