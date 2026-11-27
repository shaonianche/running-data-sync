import Stat from '@/components/Stat'
import activitiesData from '@/data/activitiesData'
import styles from './style.module.css'

function PeriodStat({ onClick }: { onClick: (_period: string) => void }) {
  const { runPeriod } = activitiesData

  const periodArr = Object.entries(runPeriod)
  periodArr.sort((a, b) => b[1] - a[1])
  return (
    <div className={styles.clickable}>
      <section>
        {periodArr.map(([period, times]) => (
          <Stat
            key={period}
            value={period}
            description={` ${times} Runs`}
            citySize={3}
            onClick={() => onClick(period)}
          />
        ))}
      </section>
      <hr />
    </div>
  )
}

export default PeriodStat
