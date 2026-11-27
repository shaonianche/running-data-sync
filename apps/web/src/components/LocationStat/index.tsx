import YearStat from '@/components/YearStat'
import {
  CHINESE_LOCATION_INFO_MESSAGE_FIRST,
  CHINESE_LOCATION_INFO_MESSAGE_SECOND,
} from '@/utils/const'
import CitiesStat from './CitiesStat'
import LocationSummary from './LocationSummary'
import PeriodStat from './PeriodStat'
import styles from './style.module.css'

interface ILocationStatProps {
  changeYear: (_year: string) => void
  changeCity: (_city: string) => void
  changeTitle: (_title: string) => void
}

function LocationStat({
  changeYear,
  changeCity,
  changeTitle,
}: ILocationStatProps) {
  return (
    <div className={styles.wrapper}>
      <section className={styles.intro}>
        <p className={styles.lead}>
          {CHINESE_LOCATION_INFO_MESSAGE_FIRST}
          .
          <br />
          {CHINESE_LOCATION_INFO_MESSAGE_SECOND}
          .
          <br />
          <br />
          Yesterday you said tomorrow.
        </p>
      </section>
      <hr />
      <LocationSummary />
      <CitiesStat onClick={changeCity} />
      <PeriodStat onClick={changeTitle} />
      <YearStat year="Total" onClick={changeYear} />
    </div>
  )
}

export default LocationStat
