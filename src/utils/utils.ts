import type { Feature, FeatureCollection, GeoJsonProperties, LineString } from 'geojson'
import type { RPGeometry } from '@/static/run_countries'
import * as duckdb from '@duckdb/duckdb-wasm'
import * as mapboxPolyline from '@mapbox/polyline'
import { WebMercatorViewport } from '@math.gl/web-mercator'

import worldGeoJson from '@surbowl/world-geo-json-zh/world.zh.json'
import gcoord from 'gcoord'
import { chinaCities } from '@/static/city'
import { chinaGeojson } from '@/static/run_countries'
import {
  ACTIVITY_TYPES,
  CYCLING_TITLES,
  MUNICIPALITY_CITIES_ARR,
  NEED_FIX_MAP,
  RICH_TITLE,
  RUN_TITLES,
} from './const'

export type Coordinate = [number, number]

export type RunIds = Array<number> | []

export interface Activity {
  run_id: number
  name: string
  distance: number
  moving_time: number
  type: string
  subtype: string
  start_date: string
  start_date_local: string
  location_country?: string | null
  summary_polyline?: string | null
  average_heartrate?: number | null
  average_speed: number
  streak: number
}

function titleForShow(run: Activity): string {
  const date = run.start_date_local.slice(0, 11)
  const distance = (run.distance / 1000.0).toFixed(2)
  let name = 'Run'
  if (run.name.slice(0, 7) === 'Running') {
    name = 'run'
  }
  if (run.name) {
    name = run.name
  }
  return `${name} ${date} ${distance} KM ${
    !run.summary_polyline ? '(No map data for this run)' : ''
  }`
}

function formatPace(d: number): string {
  if (!d || Number.isNaN(d)) {
    return `0'00"`
  }
  const pace = (1000.0 / 60.0) * (1.0 / d)
  const minutes = Math.floor(pace)
  const seconds = Math.floor((pace - minutes) * 60.0)
  return `${minutes}'${seconds.toFixed(0).toString().padStart(2, '0')}"`
}

function formatRunTime(moving_time: number): string {
  const totalSeconds = moving_time
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const minutesStr = minutes.toString().padStart(2, '0')
  const secondsStr = seconds.toString().padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${minutesStr}:${secondsStr}`
  }
  else {
    return `${minutesStr}:${secondsStr}`
  }
}

// for scroll to the map
function scrollToMap() {
  const el = document.querySelector('.fl.w-100.w-70-l')
  const rect = el?.getBoundingClientRect()
  if (rect) {
    window.scroll(rect.left + window.scrollX, rect.top + window.scrollY)
  }
}

function extractCities(str: string): string[] {
  const locations = []
  let match
  const pattern = /[\u4E00-\u9FA5]{2,}(?:市|自治州|特别行政区|盟|地区)/g
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(str)) !== null) {
    locations.push(match[0])
  }

  return locations
}

function extractDistricts(str: string): string[] {
  const locations = []
  let match
  // The existing eslint-disable might be for a different rule or can be combined if needed
  // eslint-disable-next-line regexp/no-unused-capturing-group
  const pattern = /([\u4E00-\u9FA5]{2,}(区|县))/g
  // OR, if you only want to disable no-cond-assign for the while loop:
  // const pattern = /([\u4E00-\u9FA5]{2,}(区 | 县))/g
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(str)) !== null) {
    locations.push(match[0])
  }

  return locations
}

function extractCoordinate(str: string): [number, number] | null {
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const pattern = /'latitude': (-?\d+\.\d+).*?'longitude': (-?\d+\.\d+)/
  const match = str.match(pattern)

  if (match) {
    const latitude = Number.parseFloat(match[1])
    const longitude = Number.parseFloat(match[2])
    return [longitude, latitude]
  }

  return null
}

const cities = chinaCities.map(c => c.name)
const locationCache = new Map<number, ReturnType<typeof locationForRun>>()
// what about oversea?
function locationForRun(run: Activity): {
  country: string
  province: string
  city: string
  coordinate: [number, number] | null
} {
  if (locationCache.has(run.run_id)) {
    return locationCache.get(run.run_id)!
  }
  const location = run.location_country
  let [city, province, country] = ['', '', '']
  let coordinate = null
  if (location) {
    // Only for Chinese now
    // should filter 臺灣
    const cityMatch = extractCities(location)
    const provinceMatch = location.match(/[\u4E00-\u9FA5]{2,}(省|自治区)/)

    if (cityMatch) {
      city = cities.find(value => cityMatch.includes(value)) as string

      if (!city) {
        city = ''
      }
    }
    if (provinceMatch) {
      [province] = provinceMatch
      // try to extract city coord from location_country info
      coordinate = extractCoordinate(location)
    }
    const l = location.split(',')
    // or to handle keep location format
    let countryMatch = l[l.length - 1].match(
      /[\u4E00-\u9FA5].*[\u4E00-\u9FA5]/,
    )
    if (!countryMatch && l.length >= 3) {
      countryMatch = l[2].match(/[\u4E00-\u9FA5].*[\u4E00-\u9FA5]/)
    }
    if (countryMatch) {
      [country] = countryMatch
    }
  }
  if (MUNICIPALITY_CITIES_ARR.includes(city)) {
    province = city
    if (location) {
      const districtMatch = extractDistricts(location)
      if (districtMatch.length > 0) {
        city = districtMatch[districtMatch.length - 1]
      }
    }
  }

  const r = { country, province, city, coordinate }
  locationCache.set(run.run_id, r)
  return r
}

function intComma(x = '') {
  if (x.toString().length <= 5) {
    return x
  }
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pathForRun(run: Activity): Coordinate[] {
  try {
    if (!run.summary_polyline) {
      return []
    }
    const c = mapboxPolyline.decode(run.summary_polyline)
    // reverse lat long for mapbox
    c.forEach((arr) => {
      [arr[0], arr[1]] = !NEED_FIX_MAP
        ? [arr[1], arr[0]]
        : gcoord.transform([arr[1], arr[0]], gcoord.GCJ02, gcoord.WGS84)
    })
    // try to use location city coordinate instead , if runpath is incomplete
    if (c.length === 2 && String(c[0]) === String(c[1])) {
      const { coordinate } = locationForRun(run)
      if (coordinate?.[0] && coordinate?.[1]) {
        return [coordinate, coordinate]
      }
    }
    return c
  }
  catch {
    return []
  }
}

function geoJsonForRuns(runs: Activity[]): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: runs.map((run) => {
      const points = pathForRun(run)

      return {
        type: 'Feature',
        properties: {
          color: getMainColor(),
        },
        geometry: {
          type: 'LineString',
          coordinates: points,
        },
      }
    }),
  }
}

function geoJsonForMap(): FeatureCollection<RPGeometry> {
  const combinedFeatures = (worldGeoJson.features as Feature<RPGeometry, GeoJsonProperties>[]).concat(
    chinaGeojson.features as Feature<RPGeometry, GeoJsonProperties>[],
  )
  return {
    type: 'FeatureCollection',
    features: combinedFeatures as Feature<RPGeometry, GeoJsonProperties>[],
  }
}

function getActivitySport(act: Activity): string {
  if (act.type === 'Run') {
    if (act.subtype === 'generic') {
      const runDistance = act.distance / 1000
      if (runDistance > 20 && runDistance < 40) {
        return RUN_TITLES.HALF_MARATHON_RUN_TITLE
      }
      else if (runDistance >= 40) {
        return RUN_TITLES.FULL_MARATHON_RUN_TITLE
      }
      return ACTIVITY_TYPES.RUN_GENERIC_TITLE
    }
    else if (act.subtype === 'trail') {
      return ACTIVITY_TYPES.RUN_TRAIL_TITLE
    }
    else if (act.subtype === 'treadmill') {
      return ACTIVITY_TYPES.RUN_TREADMILL_TITLE
    }
    else {
      return ACTIVITY_TYPES.RUN_GENERIC_TITLE
    }
  }
  else if (act.type === 'hiking') {
    return ACTIVITY_TYPES.HIKING_TITLE
  }
  else if (act.type === 'cycling' || act.type === 'Ride') {
    return ACTIVITY_TYPES.CYCLING_TITLE
  }
  else if (act.type === 'walking') {
    return ACTIVITY_TYPES.WALKING_TITLE
  }
  // if act.type contains 'skiing'
  else if (act.type.includes('skiing')) {
    return ACTIVITY_TYPES.SKIING_TITLE
  }
  return ''
}

function titleForRun(run: Activity): string {
  const activity_sport = getActivitySport(run)
  const runHour = +run.start_date_local.slice(11, 13)

  if (RICH_TITLE) {
    // 1. Cycling activities
    if (activity_sport === ACTIVITY_TYPES.CYCLING_TITLE) {
      if (runHour >= 0 && runHour <= 10)
        return CYCLING_TITLES.MORNING_CYCLING_TITLE
      if (runHour > 10 && runHour <= 14)
        return CYCLING_TITLES.MIDDAY_CYCLING_TITLE
      if (runHour > 14 && runHour <= 18)
        return CYCLING_TITLES.AFTERNOON_CYCLING_TITLE
      if (runHour > 18 && runHour <= 21)
        return CYCLING_TITLES.EVENING_CYCLING_TITLE
      return CYCLING_TITLES.NIGHT_CYCLING_TITLE
    }

    // 2. Running activities
    if (
      activity_sport === ACTIVITY_TYPES.RUN_GENERIC_TITLE
      || activity_sport === ACTIVITY_TYPES.RUN_TRAIL_TITLE
      || activity_sport === ACTIVITY_TYPES.RUN_TREADMILL_TITLE
    ) {
      const runDistance = run.distance / 1000
      if (runDistance > 20 && runDistance < 40)
        return RUN_TITLES.HALF_MARATHON_RUN_TITLE
      if (runDistance >= 40)
        return RUN_TITLES.FULL_MARATHON_RUN_TITLE
      if (runHour >= 0 && runHour <= 10)
        return RUN_TITLES.MORNING_RUN_TITLE
      if (runHour > 10 && runHour <= 14)
        return RUN_TITLES.MIDDAY_RUN_TITLE
      if (runHour > 14 && runHour <= 18)
        return RUN_TITLES.AFTERNOON_RUN_TITLE
      if (runHour > 18 && runHour <= 21)
        return RUN_TITLES.EVENING_RUN_TITLE
      return RUN_TITLES.NIGHT_RUN_TITLE
    }

    // 3. All other activities
    if (run.name !== '') {
      return run.name
    }
    return activity_sport // e.g. "Hiking", "Skiing"
  }

  // Fallback for when RICH_TITLE is false
  if (run.name !== '') {
    return run.name
  }
  const { city } = locationForRun(run)
  if (city && city.length > 0 && activity_sport.length > 0) {
    return `${city} ${activity_sport}`
  }
  const runDistance = run.distance / 1000
  if (runDistance > 20 && runDistance < 40)
    return RUN_TITLES.HALF_MARATHON_RUN_TITLE
  if (runDistance >= 40)
    return RUN_TITLES.FULL_MARATHON_RUN_TITLE
  if (runHour >= 0 && runHour <= 10)
    return RUN_TITLES.MORNING_RUN_TITLE
  if (runHour > 10 && runHour <= 14)
    return RUN_TITLES.MIDDAY_RUN_TITLE
  if (runHour > 14 && runHour <= 18)
    return RUN_TITLES.AFTERNOON_RUN_TITLE
  if (runHour > 18 && runHour <= 21)
    return RUN_TITLES.EVENING_RUN_TITLE
  return RUN_TITLES.NIGHT_RUN_TITLE
}

export interface IViewState {
  longitude?: number
  latitude?: number
  zoom?: number
}

function getBoundsForGeoData(geoData: FeatureCollection<LineString>): IViewState {
  const { features } = geoData
  let points: Coordinate[] = []
  // find first have data
  for (const f of features) {
    if (f.geometry.coordinates.length) {
      points = f.geometry.coordinates as Coordinate[]
      break
    }
  }
  if (points.length === 0) {
    return {
      longitude: 100,
      latitude: 40,
      zoom: 3,
    }
  }
  if (points.length === 2 && String(points[0]) === String(points[1])) {
    return { longitude: points[0][0], latitude: points[0][1], zoom: 10 }
  }
  // Calculate corner values of bounds
  const pointsLong = points.map(point => point[0]) as number[]
  const pointsLat = points.map(point => point[1]) as number[]
  const cornersLongLat: [Coordinate, Coordinate] = [
    [Math.min(...pointsLong), Math.min(...pointsLat)],
    [Math.max(...pointsLong), Math.max(...pointsLat)],
  ]
  const viewState = new WebMercatorViewport({
    width: 800,
    height: 500,
  }).fitBounds(cornersLongLat, { padding: 100 })
  let { longitude, latitude, zoom } = viewState
  if (features.length > 1) {
    zoom = 13
  }
  return { longitude, latitude, zoom }
}

function filterYearRuns(run: Activity, year: string) {
  if (run && run.start_date_local) {
    return run.start_date_local.slice(0, 4) === year
  }
  return false
}

function filterCityRuns(run: Activity, city: string) {
  if (run && run.location_country) {
    return run.location_country.includes(city)
  }
  return false
}
function filterTitleRuns(run: Activity, title: string) {
  return titleForRun(run) === title
}

function filterAndSortRuns(activities: Activity[], item: string, filterFunc: (_run: Activity, _bvalue: string) => boolean, sortFunc: (_a: Activity, _b: Activity) => number) {
  let s = activities
  if (item !== 'Total') {
    s = activities.filter(run => filterFunc(run, item))
  }
  return s.sort(sortFunc)
}

function sortDateFunc(a: Activity, b: Activity) {
  return (
    new Date(b.start_date_local.replace(' ', 'T')).getTime()
      - new Date(a.start_date_local.replace(' ', 'T')).getTime()
  )
}
const sortDateFuncReverse = (a: Activity, b: Activity) => sortDateFunc(b, a)

let duckdbInstance: duckdb.AsyncDuckDB | null = null
let duckdbConn: duckdb.AsyncDuckDBConnection | null = null

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()

async function initDuckDB(): Promise<{ db: duckdb.AsyncDuckDB, conn: duckdb.AsyncDuckDBConnection }> {
  if (duckdbInstance && duckdbConn) {
    return { db: duckdbInstance, conn: duckdbConn }
  }
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(worker_url)
  const logger = new duckdb.ConsoleLogger()
  duckdbInstance = new duckdb.AsyncDuckDB(logger, worker)
  await duckdbInstance.instantiate(bundle.mainModule, bundle.pthreadWorker)
  duckdbConn = await duckdbInstance.connect()
  URL.revokeObjectURL(worker_url)
  return { db: duckdbInstance, conn: duckdbConn }
}

function getDuckDBConnection(): duckdb.AsyncDuckDBConnection | null {
  return duckdbConn
}

async function loadDuckDBFile(db: duckdb.AsyncDuckDB, filePath: string = '/db/activities.parquet', dbName: string = 'activities.parquet') {
  const response = await fetch(filePath)
  if (!response.ok)
    throw new Error(`Failed to fetch duckdb file: ${filePath}`)
  const arrayBuffer = await response.arrayBuffer()
  await db.registerFileBuffer(dbName, new Uint8Array(arrayBuffer))
  const conn = await db.connect()
  return conn
}

function getMainColor(): string {
  if (typeof window !== 'undefined') {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--color-primary')
      .trim() || '#47b8e0'
  }
  return '#47b8e0'
}

export {
  filterAndSortRuns,
  filterCityRuns,
  filterTitleRuns,
  filterYearRuns,
  formatPace,
  formatRunTime,
  geoJsonForMap,
  geoJsonForRuns,
  getBoundsForGeoData,
  getDuckDBConnection,
  getMainColor,
  initDuckDB,
  intComma,
  loadDuckDBFile,
  locationForRun,
  pathForRun,
  scrollToMap,
  sortDateFunc,
  sortDateFuncReverse,
  titleForRun,
  titleForShow,
}
