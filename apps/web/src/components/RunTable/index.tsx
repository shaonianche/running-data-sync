import type {
  Activity,
  RunIds,
} from '@/utils/utils'
import { useCallback } from 'react'
import RunRow from './RunRow'
import styles from './style.module.css'

interface IRunTableProperties {
  runs: Activity[]
  locateActivity: (_runIds: RunIds) => void
  runIndex: number
  setRunIndex: (_index: number) => void
}

const columnHeaders = ['KM', 'ELEV', 'PACE', 'BPM', 'TIME', 'DATE'] as const

function RunTable({
  runs,
  locateActivity,
  runIndex,
  setRunIndex,
}: IRunTableProperties) {
  const handleToggleSelect = useCallback((elementIndex: number) => {
    if (runIndex === elementIndex) {
      setRunIndex(-1)
    }
    else {
      setRunIndex(elementIndex)
    }
  }, [runIndex, setRunIndex])

  return (
    <div className={styles.tableContainer}>
      <table className={styles.runTable} cellSpacing="0" cellPadding="0" role="grid">
        <thead>
          <tr>
            <th>ACTIVITY</th>
            {columnHeaders.map(k => (
              <th key={k} role="columnheader">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run, elementIndex) => (
            <RunRow
              key={run.run_id}
              isSelected={runIndex === elementIndex}
              locateActivity={locateActivity}
              run={run}
              onToggleSelect={() => handleToggleSelect(elementIndex)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default RunTable
