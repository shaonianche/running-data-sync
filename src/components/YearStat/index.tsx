import { yearStats } from '@assets/index'
import { lazy, Suspense } from 'react'
import Stat from '@/components/Stat'
import useActivities from '@/hooks/useActivities'
import useHover from '@/hooks/useHover'
import { loadSvgComponent } from '@/utils/svgUtils'
import { formatPace } from '@/utils/utils'

function YearStat({
  year,
  onClick,
}: {
  year: string
  onClick: (_year: string) => void
}) {
  let { activities: runs, years } = useActivities()
  // for hover
  const [hovered, eventHandlers] = useHover()
  // lazy Component
  const YearSVG = lazy(() => loadSvgComponent(yearStats, `./year_${year}.svg`))

  if (years.includes(year)) {
    runs = runs.filter(run => run.start_date_local.slice(0, 4) === year)
  }
  let sumDistance = 0
  let streak = 0
  let pace = 0
  let paceNullCount = 0
  let heartRate = 0
  let heartRateNullCount = 0
  let totalMetersAvail = 0
  let totalSecondsAvail = 0
  runs.forEach((run) => {
    sumDistance += run.distance || 0
    if (run.average_speed) {
      pace += run.average_speed
      totalMetersAvail += run.distance || 0
      totalSecondsAvail += (run.distance || 0) / run.average_speed
    }
    else {
      paceNullCount++
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
  sumDistance = Number.parseFloat((sumDistance / 1000.0).toFixed(1))
  const avgPace = formatPace(totalMetersAvail / totalSecondsAvail)
  const hasHeartRate = !(heartRate === 0)
  const avgHeartRate = (heartRate / (runs.length - heartRateNullCount)).toFixed(
    0,
  )
  return (
    <div
      className="cursor-pointer"
      onClick={() => onClick(year)}
      {...eventHandlers}
    >
      <section>
        <Stat value={year} description=" Journey" />
        <Stat value={runs.length} description=" Runs" />
        <Stat value={sumDistance} description=" KM" />
        <Stat value={avgPace} description=" Avg Pace" />
        <Stat value={`${streak} day`} description=" Streak" />
        {hasHeartRate && (
          <Stat value={avgHeartRate} description=" Avg Heart Rate" />
        )}
      </section>
      {year !== 'Total' && hovered && (
        <Suspense fallback="loading...">
          <YearSVG className="my-4 h-4/6 w-4/6 border-0 p-0" />
        </Suspense>
      )}
      <hr color="red" />
    </div>
  )
}

export default YearStat
