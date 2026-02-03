import { useMemo } from 'react'
import activitiesJson from '@/static/activities.json'
import { locationForRun, titleForRun } from '@/utils/utils'

interface ActivitiesData {
  activities: typeof activitiesJson
  years: string[]
  countries: string[]
  provinces: string[]
  cities: Record<string, number>
  runPeriod: Record<string, number>
  thisYear: string
}

let cachedData: ActivitiesData | null = null

function getActivitiesData(): ActivitiesData {
  if (cachedData) {
    return cachedData
  }

  const cities: Record<string, number> = {}
  const runPeriod: Record<string, number> = {}
  const provinces: Set<string> = new Set()
  const countries: Set<string> = new Set()
  const years: Set<string> = new Set()
  let thisYear = ''

  activitiesJson.forEach((run) => {
    const location = locationForRun(run)

    const periodName = titleForRun(run)
    if (periodName) {
      runPeriod[periodName] = runPeriod[periodName]
        ? runPeriod[periodName] + 1
        : 1
    }

    const { city, province, country } = location
    // drop only one char city
    if (city.length > 1) {
      cities[city] = cities[city] ? cities[city] + run.distance : run.distance
    }
    if (province)
      provinces.add(province)
    if (country)
      countries.add(country)
    const year = run.start_date_local.slice(0, 4)
    years.add(year)
  })

  const yearsArray = [...years].sort().reverse()
  if (yearsArray.length > 0) {
    thisYear = yearsArray[0]
  }

  cachedData = {
    activities: activitiesJson,
    years: yearsArray,
    countries: [...countries],
    provinces: [...provinces],
    cities,
    runPeriod,
    thisYear,
  }

  return cachedData
}

function useActivities(): ActivitiesData {
  return useMemo(() => getActivitiesData(), [])
}

export default useActivities
