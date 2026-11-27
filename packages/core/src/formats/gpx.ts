import type { GpxSummaryExtensions, ParsedTrack, ParseTrackOptions, TrackPoint } from '../contracts/formats.js'
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

const textDecoder = new TextDecoder('utf-8')

const gpxXmlParser = new XMLParser({
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

function normalizeGpxType(rawType: unknown): string {
  if (typeof rawType !== 'string' || !rawType.trim()) {
    return 'Run'
  }
  const trimmed = rawType.trim()
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
 * Build a GPX 1.1 XML document from an `Activity` and its `FlybyPoint` series.
 */
export function buildGpx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
  const startDate = parseUtcDate(activity.start_date)
  const startIso = formatUtcIso(startDate)
  const startMs = startDate.getTime()
  const trackName = escapeXml(activity.name || String(activity.run_id))
  const trackType = escapeXml(activity.type || 'Run')
  const sorted = [...flybyPoints].sort((a, b) => a.time_offset - b.time_offset)

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="running-data-sync" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
    '  <metadata>',
    `    <time>${startIso}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${trackName}</name>`,
    `    <type>${trackType}</type>`,
    '    <trkseg>',
  ]

  for (const point of sorted) {
    if (point.lat == null || !Number.isFinite(point.lat) || point.lng == null || !Number.isFinite(point.lng)) {
      continue
    }
    const pointIso = formatUtcIso(new Date(startMs + Math.round(point.time_offset) * 1000))
    lines.push(`      <trkpt lat="${point.lat}" lon="${point.lng}">`)
    if (point.alt != null && Number.isFinite(point.alt)) {
      lines.push(`        <ele>${point.alt}</ele>`)
    }
    lines.push(`        <time>${pointIso}</time>`)

    const hasHr = point.hr != null && Number.isFinite(point.hr)
    const hasCadence = point.cadence != null && Number.isFinite(point.cadence) && point.cadence > 0
    if (hasHr || hasCadence) {
      lines.push('        <extensions>')
      lines.push('          <gpxtpx:TrackPointExtension>')
      if (hasHr) {
        lines.push(`            <gpxtpx:hr>${Math.round(point.hr!)}</gpxtpx:hr>`)
      }
      if (hasCadence) {
        lines.push(`            <gpxtpx:cad>${Math.round(point.cadence!)}</gpxtpx:cad>`)
      }
      lines.push('          </gpxtpx:TrackPointExtension>')
      lines.push('        </extensions>')
    }
    lines.push('      </trkpt>')
  }

  lines.push('    </trkseg>')
  lines.push('  </trk>')
  lines.push('</gpx>')

  return `${lines.join('\n')}\n`
}

/**
 * Inject Garmin summary metadata (`distance`, `average_hr`, `average_speed`) into a GPX document's
 * root `<extensions>` element, matching `scripts/garmin_sync.py` `add_summary_info`.
 */
export function injectGpxSummaryExtensions(
  gpxData: Uint8Array | string,
  summary: GpxSummaryExtensions,
): string {
  const xml = typeof gpxData === 'string' ? gpxData : textDecoder.decode(gpxData)
  const trimmed = xml.trim()
  if (!trimmed) {
    throw new ParseError('Empty GPX document')
  }

  const validation = XMLValidator.validate(trimmed)
  if (validation !== true) {
    throw new ParseError(`Malformed GPX XML: ${validation.err.msg}`)
  }

  const openTagMatch = /<(?:\w+:)?gpx\b[^>]*>/i.exec(xml)
  if (!openTagMatch) {
    throw new ParseError('Missing <gpx> root element')
  }

  const fieldEntries: Array<[string, number]> = []
  if (summary.distance != null && Number.isFinite(summary.distance)) {
    fieldEntries.push(['distance', summary.distance])
  }
  if (summary.averageHr != null && Number.isFinite(summary.averageHr)) {
    fieldEntries.push(['average_hr', summary.averageHr])
  }
  if (summary.averageSpeed != null && Number.isFinite(summary.averageSpeed)) {
    fieldEntries.push(['average_speed', summary.averageSpeed])
  }

  if (fieldEntries.length === 0) {
    return xml
  }

  const extensionBlock = [
    '  <extensions>',
    ...fieldEntries.map(([tag, value]) => `    <${tag}>${value}</${tag}>`),
    '  </extensions>',
  ].join('\n')

  const insertPos = openTagMatch.index + openTagMatch[0].length
  const afterOpenTag = xml.slice(insertPos)

  // Replace an existing direct-child root <extensions> element if present immediately after <gpx ...>.
  const leadingRootExtMatch = /^\s*<(?:\w+:)?extensions\b[^>]*>[\s\S]*?<\/(?:\w+:)?extensions>/i.exec(afterOpenTag)
  if (leadingRootExtMatch) {
    return `${xml.slice(0, insertPos)}\n${extensionBlock}${afterOpenTag.slice(leadingRootExtMatch[0].length)}`
  }

  return `${xml.slice(0, insertPos)}\n${extensionBlock}${afterOpenTag}`
}

function extractPointTelemetry(extensions: unknown): {
  hr: number | null
  cadence: number | null
  speed: number | null
  watts: number | null
} {
  if (!extensions || typeof extensions !== 'object') {
    return { hr: null, cadence: null, speed: null, watts: null }
  }
  const ext = extensions as Record<string, any>
  const tpx = (ext.TrackPointExtension && typeof ext.TrackPointExtension === 'object'
    ? ext.TrackPointExtension
    : ext) as Record<string, any>

  const hr = parseFiniteFloat(tpx.hr) ?? parseFiniteFloat(tpx.heartrate) ?? parseFiniteFloat(ext.hr)
  const cadence = parseFiniteFloat(tpx.cad) ?? parseFiniteFloat(tpx.cadence) ?? parseFiniteFloat(ext.cad)
  const speed = parseFiniteFloat(tpx.speed) ?? parseFiniteFloat(ext.speed)
  const watts = parseFiniteFloat(tpx.power) ?? parseFiniteFloat(ext.power) ?? parseFiniteFloat(tpx.watts)

  return { hr, cadence, speed, watts }
}

/**
 * Parse a GPX document (including optional Garmin root `<extensions>` summary overrides)
 * into a normalized `ParsedTrack`.
 */
export function parseGpxTrack(xmlText: string, options?: ParseTrackOptions): ParsedTrack {
  const trimmed = xmlText.trim()
  if (!trimmed) {
    throw new ParseError('Empty GPX file')
  }

  const validation = XMLValidator.validate(trimmed)
  if (validation !== true) {
    throw new ParseError(`Malformed GPX XML: ${validation.err.msg}`)
  }

  const parsed = gpxXmlParser.parse(trimmed) as Record<string, any>
  const gpx = parsed.gpx
  if (!gpx) {
    throw new ParseError('Missing <gpx> root element')
  }

  const rootExt = gpx.extensions as Record<string, unknown> | undefined
  const extDistance = parseFiniteFloat(rootExt?.distance)
  const extAverageHr = parseFiniteFloat(rootExt?.average_hr)
  const extAverageSpeed = parseFiniteFloat(rootExt?.average_speed)

  const tracks = toArray(gpx.trk) as Record<string, any>[]
  let trackName = ''
  let trackType = 'Run'

  const polylines: Array<Array<readonly [number, number]>> = []
  const allCoords: Array<readonly [number, number]> = []
  const rawPoints: Array<{
    lat: number
    lng: number
    alt: number | null
    rawTime: string | null
    date: Date | null
    hr: number | null
    cadence: number | null
    speed: number | null
    watts: number | null
    distance: number
  }> = []

  let cumulativeDistance = 0
  const hrValues: number[] = []
  const altValues: Array<number | null> = []

  for (const trk of tracks) {
    if (!trackName && typeof trk.name === 'string' && trk.name.trim()) {
      trackName = trk.name.trim()
    }
    if (trk.type != null && String(trk.type).trim()) {
      trackType = normalizeGpxType(trk.type)
    }

    const segments = toArray(trk.trkseg) as Record<string, any>[]
    for (const seg of segments) {
      const segCoords: Array<readonly [number, number]> = []
      const trkpts = toArray(seg.trkpt) as Record<string, any>[]
      for (const pt of trkpts) {
        const lat = parseFiniteFloat(pt['@_lat'])
        const lng = parseFiniteFloat(pt['@_lon'])
        if (lat === null || lng === null) {
          continue
        }
        if (segCoords.length > 0) {
          const prev = segCoords[segCoords.length - 1]
          cumulativeDistance += haversineDistanceMeters(prev[0], prev[1], lat, lng)
        }
        segCoords.push([lat, lng] as const)
        allCoords.push([lat, lng] as const)

        const alt = parseFiniteFloat(pt.ele)
        altValues.push(alt)

        const rawTime = typeof pt.time === 'string' && pt.time.trim() ? pt.time.trim() : null
        const date = rawTime ? parseUtcDate(rawTime) : null

        const telemetry = extractPointTelemetry(pt.extensions)
        if (telemetry.hr !== null) {
          hrValues.push(telemetry.hr)
        }

        rawPoints.push({
          lat,
          lng,
          alt,
          rawTime,
          date,
          hr: telemetry.hr,
          cadence: telemetry.cadence,
          speed: telemetry.speed,
          watts: telemetry.watts,
          distance: cumulativeDistance,
        })
      }
      if (segCoords.length > 0) {
        polylines.push(segCoords)
      }
    }
  }

  const timedPoints = rawPoints.filter((p): p is typeof p & { date: Date } => p.date !== null)
  const metadataTimeRaw = typeof gpx.metadata?.time === 'string' && gpx.metadata.time.trim()
    ? gpx.metadata.time.trim()
    : null

  if (timedPoints.length === 0 && !metadataTimeRaw) {
    throw new ParseError('GPX track has no timestamps')
  }

  const startDate = timedPoints.length > 0
    ? timedPoints[0].date
    : parseUtcDate(metadataTimeRaw!)
  const endDate = timedPoints.length > 0
    ? timedPoints[timedPoints.length - 1].date
    : startDate
  const rawStartTimestamp = timedPoints.length > 0 ? timedPoints[0].rawTime : metadataTimeRaw
  const rawEndTimestamp = timedPoints.length > 0 ? timedPoints[timedPoints.length - 1].rawTime : metadataTimeRaw

  const distance = extDistance ?? cumulativeDistance
  if (rawPoints.length === 0 && distance === 0) {
    throw new ParseError('GPX track is empty')
  }

  const elapsedTime = Math.max(0, (endDate.getTime() - startDate.getTime()) / 1000)
  const movingTime = elapsedTime
  const computedAvgSpeed = movingTime > 0 ? distance / movingTime : 0
  const averageSpeed = extAverageSpeed ?? computedAvgSpeed

  const computedAvgHr = hrValues.length > 0
    ? hrValues.reduce((sum, v) => sum + v, 0) / hrValues.length
    : null
  const averageHeartrate = extAverageHr ?? computedAvgHr

  const elevationGain = computeElevationGain(altValues)
  const { startDateLocal, endDateLocal } = resolveLocalDateBounds(
    startDate,
    endDate,
    rawStartTimestamp,
    rawEndTimestamp,
  )

  const points: TrackPoint[] = rawPoints.map(p => ({
    lat: p.lat,
    lng: p.lng,
    alt: p.alt,
    timestamp: p.date ? formatUtcIso(p.date) : null,
    timeOffset: p.date ? Math.round((p.date.getTime() - startDate.getTime()) / 1000) : undefined,
    hr: p.hr,
    cadence: p.cadence,
    speed: p.speed,
    distance: p.distance,
    watts: p.watts,
  }))

  const resolvedName = trackName
    || (typeof gpx.metadata?.name === 'string' ? gpx.metadata.name.trim() : '')
    || stripExtension(options?.fileName)
    || formatUtcIso(startDate)

  const device = typeof gpx['@_creator'] === 'string' && gpx['@_creator'].trim()
    ? gpx['@_creator'].trim()
    : undefined

  return {
    runId: startDate.getTime(),
    name: resolvedName,
    type: trackType,
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
    summaryPolyline: allCoords.length > 0 ? encodePolyline(allCoords) : null,
    startLatLng: allCoords[0] ?? null,
    polylines,
    points,
    ...(device ? { device } : {}),
    ...(options?.fileName ? { fileName: options.fileName } : {}),
  }
}
