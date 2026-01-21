import Stat from '@/components/Stat'
import activitiesData from '@/hooks/useActivities'

// only support China for now
function LocationSummary() {
  const { years, countries, provinces, cities } = activitiesData
  return (
    <div className="cursor-pointer">
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
