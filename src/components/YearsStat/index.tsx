import React, { useEffect, useState } from 'react'
import RunMapButtons from '@/components/RunMap/RunMapButtons'
import YearStat from '@/components/YearStat'
import getActivities from '@/hooks/useActivities'
import { INFO_MESSAGE } from '@/utils/const'

function YearsStat({
  year,
}: {
  year: string
}) {
  const { years } = getActivities()

  const [isSmallScreen, setIsSmallScreen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
  const [selectedYear, setSelectedYear] = useState<string>('')

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const update = () => setIsSmallScreen(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // On mobile, initialize a default year once; do not override user's choice (e.g., 'Total')
  useEffect(() => {
    if (!isSmallScreen)
      return
    // If user has selected a year already (including 'Total'), don't auto-change
    if (selectedYear)
      return
    let next = 'Total'
    if (year && years.includes(year))
      next = year
    else if (years && years.length > 0)
      next = years[0]
    if (next !== selectedYear) {
      Promise.resolve().then(() => setSelectedYear(next))
    }
  }, [isSmallScreen, year, years, selectedYear])

  // make sure the year click on front
  let yearsArrayUpdate = years.slice()
  yearsArrayUpdate.push('Total')
  yearsArrayUpdate = yearsArrayUpdate.filter(x => x !== year)
  yearsArrayUpdate.unshift(year)

  // for short solution need to refactor
  return (
    <div className="w-full pr-0 md:pr-14 md:pb-16">
      <section>
        <p className="leading-relaxed">
          {INFO_MESSAGE(years.length, isSmallScreen ? (selectedYear || year) : year)}
          <br />
        </p>
      </section>
      <hr />
      {
        isSmallScreen
          ? (
              <>
                <div className="mb-2">
                  <RunMapButtons
                    changeYear={(y) => {
                      setSelectedYear(y)
                      try {
                        window.dispatchEvent(new CustomEvent('app:changeYear', { detail: { year: y } }))
                      }
                      catch {}
                    }}
                    thisYear={selectedYear || year}
                    isMapVisible={true}
                    onToggleMapVisible={() => {}}
                    showMapToggle={false}
                  />
                </div>
                {selectedYear && <YearStat key={selectedYear} year={selectedYear} disableClick />}
              </>
            )
          : (
              <>
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
              </>
            )
      }
    </div>
  )
}

export default YearsStat
