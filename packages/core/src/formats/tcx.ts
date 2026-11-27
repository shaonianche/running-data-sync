import type { ParsedTrack, ParseTrackOptions, TrackPoint } from '../contracts/formats.js'
import type { Activity, FlybyPoint } from '../foundation/types.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ParseError } from '../foundation/errors.js'
import { encodePolyline } from './polyline.js'
import {
  computeElevationGain,
  formatUtcIso,
  haversineDistanceMeters,
  parseUtcDate,
  resolveLocalDateBounds,
} from './time-utils.js'

const tcxXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
})

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function parseFiniteFloat(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function normalizeTcxSport(rawSport: unknown): string {
  if (typeof rawSport !== 'string' || !rawSport.trim()) {
    return 'Run'
  }
  const trimmed = rawSport.trim()
  if (trimmed.toLowerCase() === 'running') {
    return 'Run'
  }
  return trimmed
}

function stripExtension(fileName?: string): string {
  if (!fileName) {
    return ''
  }
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  return base.replace(/\.[^.]+$/, '')
}

/**
 * Build a Training Center XML (`.tcx`) document from an `Activity` and its `FlybyPoint` series.
 */
export function buildTcx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
  const startDate = parseUtcDate(activity.start_date)
  const startIso = formatUtcIso(startDate)
  const startMs = startDate.getTime()
  const elapsedSeconds = Number.isFinite(activity.elapsed_time)
    ? Number(activity.elapsed_time)
    : Number(activity.moving_time)
  const totalDistance = Number.isFinite(activity.distance) ? Number(activity.distance) : 0
  const sport = escapeXml(activity.type || 'Other')
  const sorted = [...flybyPoints].sort((a, b) => a.time_offset - b.time_offset)

  const hrValues = sorted
    .map(p => p.hr)
    .filter((hr): hr is number => hr != null && Number.isFinite(hr))

  const avgHr = hrValues.length > 0
    ? Math.round(hrValues.reduce((sum, v) => sum + v, 0) / hrValues.length)
    : activity.average_heartrate != null && Number.isFinite(activity.average_heartrate)
      ? Math.round(activity.average_heartrate)
      : null
  const maxHr = hrValues.length > 0 ? Math.round(Math.max(...hrValues)) : null

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">',
    '  <Activities>',
    `    <Activity Sport="${sport}">`,
    `      <Id>${startIso}</Id>`,
    `      <Lap StartTime="${startIso}">`,
    `        <TotalTimeSeconds>${elapsedSeconds}</TotalTimeSeconds>`,
    `        <DistanceMeters>${totalDistance}</DistanceMeters>`,
  ]

  if (avgHr !== null) {
    lines.push('        <AverageHeartRateBpm>')
    lines.push(`          <Value>${avgHr}</Value>`)
    lines.push('        </AverageHeartRateBpm>')
  }
  if (maxHr !== null) {
    lines.push('        <MaximumHeartRateBpm>')
    lines.push(`          <Value>${maxHr}</Value>`)
    lines.push('        </MaximumHeartRateBpm>')
  }

  lines.push('        <Intensity>Active</Intensity>')
  lines.push('        <TriggerMethod>Manual</TriggerMethod>')
  lines.push('        <Track>')

  for (const point of sorted) {
    const pointTime = formatUtcIso(new Date(startMs + Math.round(point.time_offset) * 1000))
    lines.push('          <Trackpoint>')
    lines.push(`            <Time>${pointTime}</Time>`)
    if (point.lat != null && Number.isFinite(point.lat) && point.lng != null && Number.isFinite(point.lng)) {
      lines.push('            <Position>')
      lines.push(`              <LatitudeDegrees>${point.lat}</LatitudeDegrees>`)
      lines.push(`              <LongitudeDegrees>${point.lng}</LongitudeDegrees>`)
      lines.push('            </Position>')
    }
    if (point.alt != null && Number.isFinite(point.alt)) {
      lines.push(`            <AltitudeMeters>${point.alt}</AltitudeMeters>`)
    }
    if (point.distance != null && Number.isFinite(point.distance)) {
      lines.push(`            <DistanceMeters>${point.distance}</DistanceMeters>`)
    }
    if (point.hr != null && Number.isFinite(point.hr)) {
      lines.push('            <HeartRateBpm>')
      lines.push(`              <Value>${Math.round(point.hr)}</Value>`)
      lines.push('            </HeartRateBpm>')
    }
    const hasCadence = point.cadence != null && Number.isFinite(point.cadence) && point.cadence > 0
    const hasWatts = point.watts != null && Number.isFinite(point.watts)
    if (hasCadence || hasWatts) {
      lines.push('            <Extensions>')
      lines.push('              <ns3:TPX>')
      if (hasCadence) {
        lines.push(`                <ns3:RunCadence>${Math.round(point.cadence!)}</ns3:RunCadence>`)
      }
      if (hasWatts) {
        lines.push(`                <ns3:Watts>${Math.round(point.watts!)}</ns3:Watts>`)
      }
      lines.push('              </ns3:TPX>')
      lines.push('            </Extensions>')
    }
    lines.push('          </Trackpoint>')
  }

  lines.push('        </Track>')
  lines.push('      </Lap>')
  if (activity.name) {
    lines.push(`      <Notes>${escapeXml(activity.name)}</Notes>`)
  }
  lines.push('      <Creator xsi:type="Device_t">')
  lines.push('        <Name>Strava</Name>')
  lines.push('      </Creator>')
  lines.push('    </Activity>')
  lines.push('  </Activities>')
  lines.push('</TrainingCenterDatabase>')

  return `${lines.join('\n')}\n`
}

/**
 * Parse a Training Center XML (`.tcx`) document into a normalized `ParsedTrack`.
 */
export function parseTcxTrack(xmlText: string, options?: ParseTrackOptions): ParsedTrack {
  const trimmed = xmlText.trim()
  if (!trimmed) {
    throw new ParseError('Empty TCX file')
  }

  const validation = XMLValidator.validate(trimmed)
  if (validation !== true) {
    throw new ParseError(`Malformed TCX XML: ${validation.err.msg}`)
  }

  const parsed = tcxXmlParser.parse(trimmed) as Record<string, any>
  const db = parsed.TrainingCenterDatabase
  if (!db) {
    throw new ParseError('Missing TrainingCenterDatabase root element in TCX')
  }

  const activities = toArray(db.Activities?.Activity)
  if (activities.length === 0) {
    throw new ParseError('No Activity element found in TCX')
  }

  const activity = activities[0] as Record<string, any>
  const laps = toArray(activity.Lap) as Record<string, any>[]

  let lapTotalDistance = 0
  let hasLapDistance = false
  let lapTotalTime = 0
  let hasLapTime = false
  const lapAvgHrs: number[] = []
  let firstLapStartRaw: string | null = null

  const rawTrackpoints: Array<{
    lat: number | null
    lng: number | null
    alt: number | null
    rawTime: string | null
    date: Date | null
    hr: number | null
    cadence: number | null
    speed: number | null
    distance: number | null
    watts: number | null
  }> = []

  for (const lap of laps) {
    if (!firstLapStartRaw && typeof lap['@_StartTime'] === 'string') {
      firstLapStartRaw = lap['@_StartTime']
    }
    const lapDist = parseFiniteFloat(lap.DistanceMeters)
    if (lapDist !== null) {
      lapTotalDistance += lapDist
      hasLapDistance = true
    }
    const lapTime = parseFiniteFloat(lap.TotalTimeSeconds)
    if (lapTime !== null) {
      lapTotalTime += lapTime
      hasLapTime = true
    }
    const lapHr = parseFiniteFloat(lap.AverageHeartRateBpm?.Value)
    if (lapHr !== null) {
      lapAvgHrs.push(lapHr)
    }

    const tracks = toArray(lap.Track) as Record<string, any>[]
    for (const track of tracks) {
      const trackpoints = toArray(track.Trackpoint) as Record<string, any>[]
      for (const tp of trackpoints) {
        const lat = parseFiniteFloat(tp.Position?.LatitudeDegrees)
        const lng = parseFiniteFloat(tp.Position?.LongitudeDegrees)
        const alt = parseFiniteFloat(tp.AltitudeMeters)
        const rawTime = typeof tp.Time === 'string' && tp.Time.trim() ? tp.Time.trim() : null
        const date = rawTime ? parseUtcDate(rawTime) : null
        const hr = parseFiniteFloat(tp.HeartRateBpm?.Value)
        const tpx = tp.Extensions?.TPX
        const cadence = parseFiniteFloat(tp.Cadence) ?? parseFiniteFloat(tpx?.RunCadence)
        const speed = parseFiniteFloat(tpx?.Speed)
        const distance = parseFiniteFloat(tp.DistanceMeters)
        const watts = parseFiniteFloat(tpx?.Watts)

        rawTrackpoints.push({
          lat: lat !== null && lng !== null ? lat : null,
          lng: lat !== null && lng !== null ? lng : null,
          alt,
          rawTime,
          date,
          hr,
          cadence,
          speed,
          distance,
          watts,
        })
      }
    }
  }

  const timedPoints = rawTrackpoints.filter((p): p is typeof p & { date: Date } => p.date !== null)
  if (timedPoints.length === 0 && !firstLapStartRaw) {
    throw new ParseError('TCX track is empty or missing timestamps')
  }

  const startDate = timedPoints.length > 0
    ? timedPoints[0].date
    : parseUtcDate(firstLapStartRaw!)
  const rawStartTimestamp = timedPoints.length > 0 ? timedPoints[0].rawTime : firstLapStartRaw

  let endDate: Date
  let rawEndTimestamp: string | null = null
  if (timedPoints.length > 0) {
    const lastTimed = timedPoints[timedPoints.length - 1]
    endDate = lastTimed.date
    rawEndTimestamp = lastTimed.rawTime
  }
  else {
    endDate = new Date(startDate.getTime() + Math.round(lapTotalTime * 1000))
  }

  const coords: Array<readonly [number, number]> = []
  const hrValues: number[] = []
  const altValues: Array<number | null> = []
  const points: TrackPoint[] = []

  let haversineDistance = 0
  let lastPointDistance: number | null = null

  for (const tp of rawTrackpoints) {
    if (tp.lat !== null && tp.lng !== null) {
      if (coords.length > 0) {
        const prev = coords[coords.length - 1]
        haversineDistance += haversineDistanceMeters(prev[0], prev[1], tp.lat, tp.lng)
      }
      coords.push([tp.lat, tp.lng] as const)
    }
    if (tp.hr !== null) {
      hrValues.push(tp.hr)
    }
    altValues.push(tp.alt)
    if (tp.distance !== null) {
      lastPointDistance = tp.distance
    }
    points.push({
      lat: tp.lat,
      lng: tp.lng,
      alt: tp.alt,
      timestamp: tp.date ? formatUtcIso(tp.date) : null,
      timeOffset: tp.date ? Math.round((tp.date.getTime() - startDate.getTime()) / 1000) : undefined,
      hr: tp.hr,
      cadence: tp.cadence,
      speed: tp.speed,
      distance: tp.distance,
      watts: tp.watts,
    })
  }

  const distance = hasLapDistance && lapTotalDistance > 0
    ? lapTotalDistance
    : lastPointDistance !== null && lastPointDistance > 0
      ? lastPointDistance
      : haversineDistance

  if (coords.length === 0 && distance === 0 && points.length === 0) {
    throw new ParseError('TCX file has no trackpoints or distance data')
  }

  const spanSeconds = Math.max(0, (endDate.getTime() - startDate.getTime()) / 1000)
  const elapsedTime = hasLapTime && lapTotalTime > 0 ? lapTotalTime : spanSeconds
  const movingTime = spanSeconds > 0 ? spanSeconds : elapsedTime
  const averageSpeed = movingTime > 0 ? distance / movingTime : 0

  const averageHeartrate = hrValues.length > 0
    ? hrValues.reduce((sum, v) => sum + v, 0) / hrValues.length
    : lapAvgHrs.length > 0
      ? lapAvgHrs.reduce((sum, v) => sum + v, 0) / lapAvgHrs.length
      : null

  const elevationGain = computeElevationGain(altValues)
  const { startDateLocal, endDateLocal } = resolveLocalDateBounds(
    startDate,
    endDate,
    rawStartTimestamp,
    rawEndTimestamp,
  )

  const name = (typeof activity.Notes === 'string' && activity.Notes.trim())
    || stripExtension(options?.fileName)
    || (typeof activity.Id === 'string' && activity.Id.trim())
    || formatUtcIso(startDate)

  const device = typeof activity.Creator?.Name === 'string' && activity.Creator.Name.trim()
    ? activity.Creator.Name.trim()
    : undefined

  return {
    runId: startDate.getTime(),
    name,
    type: normalizeTcxSport(activity['@_Sport']),
    subtype: '',
    startDate: formatUtcIso(startDate),
    endDate: formatUtcIso(endDate),
    startDateLocal,
    endDateLocal,
    distance,
    movingTime,
    elapsedTime,
    averageSpeed,
    averageHeartrate,
    elevationGain,
    summaryPolyline: coords.length > 0 ? encodePolyline(coords) : null,
    startLatLng: coords[0] ?? null,
    polylines: coords.length > 0 ? [coords] : [],
    points,
    ...(device ? { device } : {}),
    ...(options?.fileName ? { fileName: options.fileName } : {}),
  }
}
