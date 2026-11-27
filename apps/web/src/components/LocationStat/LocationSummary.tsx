import Stat from '@/components/Stat'
import activitiesData from '@/data/activitiesData'
import styles from './style.module.css'

// only support China for now
function LocationSummary() {
  const { years, countries, provinces, cities } = activitiesData
  return (
    <div className={styles.clickable}>
      <section>
        {years
          ? (
              <Stat value={`${years.length}`} description=" 年里我跑过" />
            )
          : null}
        {countries
          ? (
              <Stat value={countries.length} description=" 个国家" />
            )
          : null}
        {provinces
          ? (
              <Stat value={provinces.length} description=" 个省份" />
            )
          : null}
        {cities
          ? (
              <Stat value={Object.keys(cities).length} description=" 个城市" />
            )
          : null}
      </section>
      <hr />
    </div>
  )
}

export default LocationSummary
