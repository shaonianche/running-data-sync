import type { KeyboardEvent } from 'react'
import type {
  Activity,
  RunIds,
} from '@/utils/utils'
import React from 'react'
import {
  formatPace,
  formatRunTime,
  titleForRun,
} from '@/utils/utils'
import styles from './style.module.css'

interface IRunRowProperties {
  isSelected: boolean
  locateActivity: (_runIds: RunIds) => void
  run: Activity
  onToggleSelect: () => void
}

function RunRow({
  isSelected,
  locateActivity,
  run,
  onToggleSelect,
}: IRunRowProperties) {
  const distance = ((run.distance || 0) / 1000.0).toFixed(2)
  const paceParts = formatPace(run.average_speed)
  const heartRate = run.average_heartrate
  const runTime = formatRunTime(run.moving_time)

  const handleClick = () => {
    if (isSelected) {
      onToggleSelect()
      locateActivity([])
      return
    }
    onToggleSelect()
    locateActivity([run.run_id])
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleClick()
    }
  }

  return (
    <tr
      className={`${styles.runRow} ${isSelected ? styles.selected : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="row"
      aria-selected={isSelected}
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

export default React.memo(RunRow)
