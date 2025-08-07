import type {
  Activity,
  RunIds,
} from '@/utils/utils'
import {
  formatPace,
  formatRunTime,
  titleForRun,
} from '@/utils/utils'
import styles from './style.module.css'

interface IRunRowProperties {
  elementIndex: number
  locateActivity: (_runIds: RunIds) => void
  run: Activity
  runIndex: number
  setRunIndex: (_index: number) => void
}

function RunRow({
  elementIndex,
  locateActivity,
  run,
  runIndex,
  setRunIndex,
}: IRunRowProperties) {
  const distance = ((run.distance || 0) / 1000.0).toFixed(2)
  const paceParts = formatPace(run.average_speed)
  const heartRate = run.average_heartrate
  const runTime = formatRunTime(run.moving_time)
  const handleClick = () => {
    if (runIndex === elementIndex) {
      setRunIndex(-1)
      locateActivity([])
      return
    }
    setRunIndex(elementIndex)
    locateActivity([run.run_id])
  }

  return (
    <tr
      className={`${styles.runRow} ${runIndex === elementIndex ? styles.selected : ''}`}
      key={run.start_date_local}
      onClick={handleClick}
    >
      <td>{titleForRun(run)}</td>
      <td>{distance}</td>
      <td>{(run.elevation_gain ?? 0.0).toFixed(1)}</td>
      <td>{paceParts}</td>
      <td>{heartRate && heartRate.toFixed(0)}</td>
      <td>{runTime}</td>
      <td>{run.start_date_local}</td>
    </tr>
  )
}

export default RunRow
