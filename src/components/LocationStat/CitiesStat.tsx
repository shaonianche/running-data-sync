import Stat from '@/components/Stat'
import getActivities from '@/hooks/useActivities'

// only support China for now
function CitiesStat({ onClick }: { onClick: (_city: string) => void }) {
  const { cities } = getActivities()

  const citiesArr = Object.entries(cities)
  citiesArr.sort((a, b) => b[1] - a[1])
  return (
    <div className="cursor-pointer">
      <section>
        {citiesArr.map(([city, distance]) => (
          <Stat
            key={city}
            value={city}
            description={` ${(distance / 1000).toFixed(0)} KM`}
            citySize={3}
            onClick={() => onClick(city)}
          />
        ))}
      </section>
      <hr />
    </div>
  )
}

export default CitiesStat
