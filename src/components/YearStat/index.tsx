import { yearStats } from '@assets/index'
import { lazy, Suspense, useMemo } from 'react'
import Stat from '@/components/Stat'
import useActivities from '@/hooks/useActivities'
import useHover from '@/hooks/useHover'
import { loadSvgComponent } from '@/utils/svgUtils'
import { formatPace } from '@/utils/utils'

function YearStat({
  year,
  onClick,
  disableClick = false,
}: {
  year: string
  onClick?: (_year: string) => void
  disableClick?: boolean
}) {
  const { activities: runs, years } = useActivities()
  // for hover
  const [hovered, eventHandlers] = useHover()

  // 缓存 lazy 组件类型
  const YearSVG = useMemo(
    () =>
      lazy(async () => {
        try {
          return await loadSvgComponent(yearStats, `./year_${year}.svg`)
        }
        catch {
          return { default: () => null }
        }
      }),
    [year],
  )

  // 缓存过滤后的 runs
  const yearRuns = useMemo(() => {
    if (years.includes(year)) {
      return runs.filter(run => run.start_date_local.slice(0, 4) === year)
    }
    return runs
  }, [runs, years, year])

  // 缓存统计计算
  const stats = useMemo(() => {
    let sumDistance = 0
    let streak = 0
    let heartRate = 0
    let heartRateNullCount = 0
    let totalMetersAvail = 0
    let totalSecondsAvail = 0

    yearRuns.forEach((run) => {
      sumDistance += run.distance || 0
      if (run.average_speed) {
        totalMetersAvail += run.distance || 0
        totalSecondsAvail += (run.distance || 0) / run.average_speed
      }
      if (run.average_heartrate) {
        heartRate += run.average_heartrate
      }
      else {
        heartRateNullCount++
      }
      if (run.streak) {
        streak = Math.max(streak, run.streak)
      }
    })

    return {
      sumDistance: Number.parseFloat((sumDistance / 1000.0).toFixed(1)),
      avgPace: formatPace(totalMetersAvail / totalSecondsAvail),
      hasHeartRate: heartRate !== 0,
      avgHeartRate: (heartRate / (yearRuns.length - heartRateNullCount)).toFixed(0),
      streak,
      runsCount: yearRuns.length,
    }
  }, [yearRuns])
  return (
    <div
      className={`cursor-pointer${disableClick ? ' cursor-not-allowed opacity-80' : ''}`}
      {...(!disableClick && onClick ? { onClick: () => onClick(year) } : {})}
      {...eventHandlers}
    >
      <section className="grid grid-cols-2 gap-x-6 gap-y-3 md:block text-sm md:text-base">
        <Stat value={year} description=" Journey" />
        <Stat value={stats.runsCount} description=" Runs" />
        <Stat value={stats.sumDistance} description=" KM" />
        <Stat value={stats.avgPace} description=" Avg Pace" />
        <Stat value={`${stats.streak} day`} description=" Streak" />
        {stats.hasHeartRate && (
          <Stat value={stats.avgHeartRate} description=" Avg Heart Rate" />
        )}
      </section>
      {year !== 'Total' && hovered && !disableClick && (
        <Suspense fallback="loading...">
          <YearSVG className="my-4 h-4/6 w-4/6 border-0 p-0" />
        </Suspense>
      )}
      <hr className="my-3 md:my-8" />
    </div>
  )
}

export default YearStat
