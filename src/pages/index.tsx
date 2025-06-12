import type {
  Activity,
  IViewState,
  RunIds,
} from '@/utils/utils'
import { Analytics } from '@vercel/analytics/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout from '@/components/Layout'
import LocationStat from '@/components/LocationStat'
import RunMap from '@/components/RunMap'
import RunTable from '@/components/RunTable'
import SVGStat from '@/components/SVGStat'
import YearsStat from '@/components/YearsStat'
import getActivities from '@/hooks/useActivities'
import { IS_CHINESE } from '@/utils/const'
import {
  filterAndSortRuns,
  filterCityRuns,
  filterTitleRuns,
  filterYearRuns,
  geoJsonForRuns,
  getBoundsForGeoData,
  scrollToMap,
  sortDateFunc,
  titleForShow,
} from '@/utils/utils'

function Index() {
  const { activities, thisYear } = getActivities()
  const [year, setYear] = useState(thisYear)
  const [runIndex, setRunIndex] = useState(-1)
  const [runs, setActivity] = useState(() =>
    filterAndSortRuns(activities, year, filterYearRuns, sortDateFunc),
  )
  const [title, setTitle] = useState('')
  const [geoData, setGeoData] = useState(() => geoJsonForRuns(runs))
  const bounds = useMemo(() => getBoundsForGeoData(geoData), [geoData])
  const intervalIdRef = useRef<number | undefined>()

  const [viewState, setViewState] = useState<IViewState>({
    ...bounds,
  })

  const changeByItem = (
    item: string,
    name: string,
    func: (_run: Activity, _value: string) => boolean,
  ) => {
    scrollToMap()
    if (name !== 'Year') {
      setYear(thisYear)
    }
    setActivity(() => filterAndSortRuns(activities, item, func, sortDateFunc))
    setRunIndex(-1)
    setTitle(`${item} ${name} Running Heatmap`)
  }

  const changeYear = (y: string) => {
    // default year
    setYear(y)

    if ((viewState.zoom ?? 0) > 3 && bounds) {
      setViewState({
        ...bounds,
      })
    }

    changeByItem(y, 'Year', filterYearRuns)
    if (intervalIdRef.current !== undefined) {
      clearInterval(intervalIdRef.current)
    }
  }

  const changeCity = (city: string) => {
    changeByItem(city, 'City', filterCityRuns)
  }

  const changeTitle = (title: string) => {
    changeByItem(title, 'Title', filterTitleRuns)
  }

  const locateActivity = useCallback((runIds: RunIds) => {
    const ids = new Set(runIds)

    const selectedRuns = !runIds.length
      ? runs
      : runs.filter((r: any) => ids.has(r.run_id))

    if (!selectedRuns.length) {
      return
    }

    const lastRun = selectedRuns.sort(sortDateFunc)[0]

    if (!lastRun) {
      return
    }
    setGeoData(() => geoJsonForRuns(selectedRuns))
    setTitle(titleForShow(lastRun))
    if (intervalIdRef.current !== undefined) {
      clearInterval(intervalIdRef.current)
    }
    scrollToMap()
  }, [runs, setGeoData, setTitle])

  useEffect(() => {
    // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect
    setViewState({
      ...bounds,
    })
  }, [bounds])

  useEffect(() => {
    const runsNum = runs.length
    const sliceNum = runsNum >= 20 ? runsNum / 20 : 1
    let i = sliceNum

    const id = setInterval(() => {
      if (i >= runsNum) {
        clearInterval(id)
      }
      else {
        const tempRuns = runs.slice(0, i)
        setGeoData(() => geoJsonForRuns(tempRuns))
        i += sliceNum
      }
    }, 100)

    intervalIdRef.current = id

    return () => {
      clearInterval(id)
    }
  }, [runs, setGeoData])

  useEffect(() => {
    if (year !== 'Total') {
      return
    }

    const svgStat = document.getElementById('svgStat')
    if (!svgStat) {
      return
    }

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement
      if (target.tagName.toLowerCase() === 'path') {
        // Use querySelector to get the <desc> element and the <title> element.
        const descEl = target.querySelector('desc')
        if (descEl) {
          // If the runId exists in the <desc> element, it means that a running route has been clicked.
          const runId = Number(descEl.innerHTML)
          if (!runId) {
            return
          }
          locateActivity([runId])
          return
        }

        const titleEl = target.querySelector('title')
        if (titleEl) {
          // If the runDate exists in the <title> element, it means that a date square has been clicked.
          const [runDate] = titleEl.innerHTML.match(
            /\d{4}-\d{1,2}-\d{1,2}/,
          ) || [`${+thisYear + 1}`]
          const runIDsOnDate = runs
            .filter(r => r.start_date_local.slice(0, 10) === runDate)
            .map(r => r.run_id)
          if (!runIDsOnDate.length) {
            return
          }
          locateActivity(runIDsOnDate)
        }
      }
    }
    svgStat.addEventListener('click', handleClick)
    return () => {
      svgStat && svgStat.removeEventListener('click', handleClick)
    }
  }, [year, locateActivity, runs, thisYear])

  return (
    <Layout>
      <div className="w-full lg:w-1/3">
        {(viewState.zoom ?? 0) <= 1.5 && IS_CHINESE
          ? (
              <LocationStat
                changeYear={changeYear}
                changeCity={changeCity}
                changeTitle={changeTitle}
              />
            )
          : (
              <YearsStat year={year} />
            )}
      </div>
      <div className="w-full lg:w-2/3">
        <RunMap
          title={title}
          viewState={viewState}
          geoData={geoData}
          setViewState={setViewState}
          changeYear={changeYear}
          thisYear={year}
        />
        {year === 'Total'
          ? (
              <SVGStat />
            )
          : (
              <RunTable
                runs={runs}
                locateActivity={locateActivity}
                setActivity={setActivity}
                runIndex={runIndex}
                setRunIndex={setRunIndex}
              />
            )}
      </div>
      {/* Enable Audiences in Vercel Analytics: https://vercel.com/docs/concepts/analytics/audiences/quickstart */}
      {import.meta.env.VERCEL && <Analytics />}
    </Layout>
  )
}

export default Index
