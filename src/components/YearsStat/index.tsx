import YearStat from '@/components/YearStat'
import getActivities from '@/hooks/useActivities'
import { INFO_MESSAGE } from '@/utils/const'

function YearsStat({
  year,
}: {
  year: string
}) {
  const { years } = getActivities()
  // make sure the year click on front
  let yearsArrayUpdate = years.slice()
  yearsArrayUpdate.push('Total')
  yearsArrayUpdate = yearsArrayUpdate.filter(x => x !== year)
  yearsArrayUpdate.unshift(year)

  // for short solution need to refactor
  return (
    <div className="w-full pb-16 pr-14">
      <section className="pb-0">
        <p className="leading-relaxed">
          {INFO_MESSAGE(years.length, year)}
          <br />
        </p>
      </section>
      <hr />
      {yearsArrayUpdate.map(year => (
        <YearStat key={year} year={year} disableClick />
      ))}
      {
        // eslint-disable-next-line no-prototype-builtins
        yearsArrayUpdate.hasOwnProperty('Total')
          ? (
              <YearStat key="Total" year="Total" disableClick />
            )
          : (
              <div />
            )
      }
    </div>
  )
}

export default YearsStat
