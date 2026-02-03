import useActivities from '@/hooks/useActivities'
import { DISABLE_MAP } from '@/utils/const'
import styles from './style.module.css'

interface RunMapButtonsProps {
  changeYear: (_year: string) => void
  thisYear: string
  isMapVisible: boolean
  onToggleMapVisible: () => void
  showMapToggle?: boolean
}

function RunMapButtons({
  changeYear,
  thisYear,
  isMapVisible,
  onToggleMapVisible,
  showMapToggle = true,
}: RunMapButtonsProps) {
  const { years } = useActivities()
  const yearsButtons = years.slice()
  yearsButtons.push('Total')

  return (
    <>
      <ul className={styles.buttons}>
        {yearsButtons.map(year => (
          <li
            key={`${year}button`}
            className={
              `${styles.button} ${year === thisYear ? styles.selected : ''}`
            }
            onClick={() => {
              changeYear(year)
            }}
          >
            {year}
          </li>
        ))}
      </ul>
      {!DISABLE_MAP && showMapToggle && (
        <div
          className={styles.mapVisibleBar}
          tabIndex={0}
          role="button"
          aria-label={isMapVisible ? '收起地图' : '展开地图'}
          onClick={onToggleMapVisible}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ')
              onToggleMapVisible()
          }}
        >
          {/* <span
            className={
              styles.mapVisibleArrow + (isMapVisible ? ` ${styles.open}` : '')
            }
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 7l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className={styles.mapVisibleText}>
            {isMapVisible ? '收起地图' : '展开地图'}
          </span> */}
        </div>
      )}
    </>
  )
}

export default RunMapButtons
