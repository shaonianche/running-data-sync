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
import RunMapButtons from '@/components/RunMap/RunMapButtons'
import RunTable from '@/components/RunTable'
import SVGStat from '@/components/SVGStat'
import { preloadTotalSvgs } from '@/components/SVGStat/preload'
import YearsStat from '@/components/YearsStat'
import useActivities from '@/hooks/useActivities'
import { IS_CHINESE } from '@/utils/const'
import {
  filterAndSortRuns,
  filterYearRuns,
  geoJsonForRuns,
  getBoundsForGeoData,
  scrollToMap,
  sortDateFunc,
  titleForShow,
} from '@/utils/utils'

function Index() {
  const { activities, thisYear } = useActivities()
  const [year, setYear] = useState(thisYear)
  const [runIndex, setRunIndex] = useState(-1)
  const [title, setTitle] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<RunIds>([])
  const [zoom, setZoom] = useState(0)
  const [viewStateOverride, setViewStateOverride] = useState<IViewState | null>(null)
  const prevYearRef = useRef(year)

  useEffect(() => {
    preloadTotalSvgs()
  }, [])

  const runs = useMemo(
    () => filterAndSortRuns(activities, year, filterYearRuns, sortDateFunc),
    [activities, year],
  )

  const geoData = useMemo(() => {
    if (year === 'Total') {
      return { type: 'FeatureCollection' as const, features: [] }
    }
    if (selectedRunIds.length === 0) {
      return geoJsonForRuns(runs)
    }
    const ids = new Set(selectedRunIds)
    const selectedRuns = runs.filter((r: Activity) => ids.has(r.run_id))
    return geoJsonForRuns(selectedRuns.length > 0 ? selectedRuns : runs)
  }, [runs, selectedRunIds, year])

  const bounds = useMemo(() => getBoundsForGeoData(geoData), [geoData])

  const viewState = useMemo<IViewState>(() => {
    if (viewStateOverride) {
      return viewStateOverride
    }
    return { ...bounds }
  }, [bounds, viewStateOverride])

  const changeByItem = useCallback(
    (item: string, name: string) => {
      scrollToMap()
      if (name !== 'Year') {
        setYear(thisYear)
      }
      setSelectedRunIds([])
      setRunIndex(-1)
      setTitle(`${item} ${name} Running Heatmap`)
    },
    [thisYear],
  )

  const changeYear = useCallback(
    (y: string) => {
      setYear(y)

      if ((zoom ?? 0) > 3 && bounds) {
        setViewStateOverride({
          ...bounds,
        })
      }

      changeByItem(y, 'Year')
    },
    [zoom, bounds, changeByItem],
  )

  const changeCity = useCallback(
    (city: string) => {
      changeByItem(city, 'City')
    },
    [changeByItem],
  )

  const changeTitle = useCallback(
    (title: string) => {
      changeByItem(title, 'Title')
    },
    [changeByItem],
  )

  const locateActivity = useCallback(
    (runIds: RunIds) => {
      const ids = new Set(runIds)

      const selectedRuns = !runIds.length
        ? runs
        : runs.filter((r: Activity) => ids.has(r.run_id))

      if (!selectedRuns.length) {
        return
      }

      const lastRun = selectedRuns.reduce((latest, cur) =>
        new Date(cur.start_date_local) > new Date(latest.start_date_local) ? cur : latest,
      )

      if (!lastRun) {
        return
      }
      setSelectedRunIds(runIds)
      setViewStateOverride(null)
      setTitle(titleForShow(lastRun))
      scrollToMap()
    },
    [runs],
  )

  const handleViewStateChange = useCallback(
    (newViewState: IViewState) => {
      setViewStateOverride(newViewState)
      if (newViewState.zoom !== undefined) {
        setZoom(newViewState.zoom)
      }
    },
    [],
  )

  if (prevYearRef.current !== year) {
    prevYearRef.current = year
    if (selectedRunIds.length > 0) {
      setSelectedRunIds([])
    }
    if (title !== '') {
      setTitle('')
    }
    if (viewStateOverride !== null) {
      setViewStateOverride(null)
    }
  }

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
        const descEl = target.querySelector('desc')
        if (descEl) {
          const runId = Number(descEl.innerHTML)
          if (!runId) {
            return
          }
          locateActivity([runId])
          return
        }

        const titleEl = target.querySelector('title')
        if (titleEl) {
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
        {year === 'Total'
          ? (
              <>
                <RunMapButtons
                  changeYear={changeYear}
                  thisYear={year}
                  isMapVisible={false}
                  onToggleMapVisible={() => {}}
                  showMapToggle={false}
                />
                <SVGStat />
              </>
            )
          : (
              <>
                <div className="z-10 bg-[var(--color-background)] lg:sticky lg:top-0">
                  <RunMap
                    title={title}
                    viewState={viewState}
                    geoData={geoData}
                    setViewState={handleViewStateChange}
                    changeYear={changeYear}
                    thisYear={year}
                  />
                </div>
                <RunTable
                  runs={runs}
                  locateActivity={locateActivity}
                  runIndex={runIndex}
                  setRunIndex={setRunIndex}
                />
              </>
            )}
      </div>
      {/* Enable Audiences in Vercel Analytics: https://vercel.com/docs/concepts/analytics/audiences/quickstart */}
      {import.meta.env.VERCEL && <Analytics />}
    </Layout>
  )
}

export default Index
