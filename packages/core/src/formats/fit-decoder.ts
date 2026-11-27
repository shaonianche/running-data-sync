import type { ParsedTrack, ParseTrackOptions, TrackPoint } from '../contracts/formats.js'
import { Decoder, Stream } from '@garmin/fitsdk'
import { ParseError } from '../foundation/errors.js'
import { mapFitSportToActivityType, semicirclesToDegrees } from './fit-mapping.js'
import { encodePolyline } from './polyline.js'
import { computeElevationGain, formatUtcIso, parseUtcDate, resolveLocalDateBounds } from './time-utils.js'

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    return parseUtcDate(value)
  }
  return null
}

function stripExtension(fileName?: string): string {
  if (!fileName) {
    return ''
  }
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  return base.replace(/\.[^.]+$/, '')
}

function formatDeviceLabel(
  fileId: Record<string, unknown> | undefined,
  deviceInfo: Record<string, unknown> | undefined,
): string | undefined {
  const source = fileId ?? deviceInfo
  if (!source) {
    return undefined
  }
  const parts: string[] = []
  if (source.manufacturer != null && String(source.manufacturer).trim()) {
    parts.push(String(source.manufacturer).trim())
  }
  const product = source.garminProduct ?? source.productName ?? source.product
  if (product != null && String(product).trim()) {
    parts.push(String(product).trim())
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * Decode a `.fit` binary buffer into a normalized `ParsedTrack` using official `@garmin/fitsdk` `Decoder`.
 */
export function parseFitTrack(data: Uint8Array, options?: ParseTrackOptions): ParsedTrack {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new ParseError('Empty FIT file')
  }

  const decoder = new Decoder(Stream.fromByteArray(data))
  if (!decoder.isFIT()) {
    throw new ParseError('Data is not a valid FIT file')
  }
  if (!decoder.checkIntegrity()) {
    throw new ParseError('FIT file failed CRC integrity check')
  }

  const { messages, errors } = decoder.read()
  if (errors && errors.length > 0) {
    throw new ParseError(`FIT decode errors: ${errors.map(String).join('; ')}`)
  }

  const sessionMesgs = (messages.sessionMesgs ?? []) as Record<string, unknown>[]
  if (sessionMesgs.length === 0) {
    throw new ParseError('Session message missing in FIT file')
  }

  const session = sessionMesgs[0]
  const recordMesgs = (messages.recordMesgs ?? []) as Record<string, unknown>[]
  const sportMesgs = (messages.sportMesgs ?? []) as Record<string, unknown>[]
  const fileIdMesgs = (messages.fileIdMesgs ?? []) as Record<string, unknown>[]
  const deviceInfoMesgs = (messages.deviceInfoMesgs ?? []) as Record<string, unknown>[]

  const startDate = asDate(session.startTime)
    ?? asDate(recordMesgs[0]?.timestamp)
    ?? asDate(fileIdMesgs[0]?.timeCreated)

  if (!startDate) {
    throw new ParseError('Start timestamp missing in FIT file')
  }

  const rawElapsed = asFiniteNumber(session.totalElapsedTime)
    ?? asFiniteNumber(session.totalTimerTime)
  const rawMoving = asFiniteNumber(session.totalMovingTime)
    ?? asFiniteNumber(session.totalTimerTime)
    ?? rawElapsed

  const lastRecordDate = recordMesgs.length > 0 ? asDate(recordMesgs[recordMesgs.length - 1]?.timestamp) : null
  const sessionTimestamp = asDate(session.timestamp)

  const inferredElapsed = lastRecordDate
    ? Math.max(0, (lastRecordDate.getTime() - startDate.getTime()) / 1000)
    : sessionTimestamp
      ? Math.max(0, (sessionTimestamp.getTime() - startDate.getTime()) / 1000)
      : 0

  const elapsedTime = rawElapsed ?? inferredElapsed
  const movingTime = rawMoving ?? elapsedTime
  const endDate = new Date(startDate.getTime() + Math.round(elapsedTime * 1000))

  const points: TrackPoint[] = []
  const coords: Array<readonly [number, number]> = []
  const hrValues: number[] = []
  const altValues: Array<number | null> = []

  for (const record of recordMesgs) {
    const rawLat = asFiniteNumber(record.positionLat)
    const rawLng = asFiniteNumber(record.positionLong)
    const lat = rawLat !== null ? semicirclesToDegrees(rawLat) : null
    const lng = rawLng !== null ? semicirclesToDegrees(rawLng) : null

    if (lat !== null && lng !== null) {
      coords.push([lat, lng] as const)
    }

    const alt = asFiniteNumber(record.enhancedAltitude) ?? asFiniteNumber(record.altitude)
    altValues.push(alt)

    const pointDate = asDate(record.timestamp)
    const rawHr = asFiniteNumber(record.heartRate)
    const hr = rawHr !== null && rawHr !== 255 ? rawHr : null
    if (hr !== null) {
      hrValues.push(hr)
    }

    const cadence = asFiniteNumber(record.cadence)
    const speed = asFiniteNumber(record.enhancedSpeed) ?? asFiniteNumber(record.speed)
    const distance = asFiniteNumber(record.distance)
    const watts = asFiniteNumber(record.power)

    points.push({
      lat,
      lng,
      alt,
      timestamp: pointDate ? formatUtcIso(pointDate) : null,
      timeOffset: pointDate ? Math.round((pointDate.getTime() - startDate.getTime()) / 1000) : undefined,
      hr,
      cadence,
      speed,
      distance,
      watts,
    })
  }

  const distance = asFiniteNumber(session.totalDistance)
    ?? (points.length > 0 ? (points[points.length - 1].distance ?? 0) : 0)

  const averageSpeed = asFiniteNumber(session.enhancedAvgSpeed)
    ?? asFiniteNumber(session.avgSpeed)
    ?? (movingTime > 0 ? distance / movingTime : 0)

  const sessionAvgHr = asFiniteNumber(session.avgHeartRate)
  const averageHeartrate = sessionAvgHr !== null && sessionAvgHr !== 255
    ? sessionAvgHr
    : hrValues.length > 0
      ? hrValues.reduce((sum, v) => sum + v, 0) / hrValues.length
      : null

  const elevationGain = asFiniteNumber(session.totalAscent) ?? computeElevationGain(altValues)

  const sportName = typeof sportMesgs[0]?.name === 'string' && sportMesgs[0].name.trim()
    ? sportMesgs[0].name.trim()
    : typeof session.sportProfileName === 'string' && session.sportProfileName.trim()
      ? session.sportProfileName.trim()
      : stripExtension(options?.fileName) || formatUtcIso(startDate)

  const type = mapFitSportToActivityType(session.sport as string | number | null | undefined)
  const subtype = session.subSport != null ? String(session.subSport) : ''

  const { startDateLocal, endDateLocal } = resolveLocalDateBounds(startDate, endDate)
  const device = formatDeviceLabel(fileIdMesgs[0], deviceInfoMesgs[0])

  return {
    runId: startDate.getTime(),
    name: sportName,
    type,
    subtype,
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
