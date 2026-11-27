import type {
  ActivityMesg,
  DeviceInfoMesg,
  EventMesg,
  FileCreatorMesg,
  FileIdMesg,
  LapMesg,
  RecordMesg,
  SessionMesg,
  SportMesg,
} from '@garmin/fitsdk'
import type { FitBuildOptions } from '../contracts/formats.js'
import type { Activity, FlybyPoint } from '../foundation/types.js'
import type { ComputedFitLap, NormalizedFitRecord } from './fit-mapping.js'
import { Encoder, Profile } from '@garmin/fitsdk'
import {
  calculateLapsFromRecords,
  calculateStrideLengthMeters,
  DEFAULT_AUTO_LAP_DISTANCE_METERS,
  DEFAULT_GARMIN_MANUFACTURER,
  DEFAULT_GARMIN_PRODUCT_ID,
  DEFAULT_GARMIN_SERIAL_NUMBER,
  DEFAULT_GARMIN_SOFTWARE_VERSION,
  degreesToSemicircles,
  mapStravaSportToFit,
  paceToSpeed,
  sanitizeFitActivityName,
} from './fit-mapping.js'
import { parseUtcDate } from './time-utils.js'

const MIN_FIT_UINT16_ALTITUDE = -500
const MAX_FIT_UINT16_ALTITUDE = 12606.8
const MAX_UINT8_VALID = 254
const MAX_UINT16_VALID = 65534

function clampUint8(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined
  }
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > MAX_UINT8_VALID) {
    return undefined
  }
  return rounded
}

function clampUint16(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined
  }
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > MAX_UINT16_VALID) {
    return undefined
  }
  return rounded
}

function buildNormalizedRecords(
  startDate: Date,
  flybyPoints: readonly FlybyPoint[],
  isStationary: boolean,
): NormalizedFitRecord[] {
  const sorted = [...flybyPoints].sort((a, b) => a.time_offset - b.time_offset)
  const startMs = startDate.getTime()

  return sorted.map((point) => {
    const timestamp = new Date(startMs + Math.round(point.time_offset) * 1000)
    const hr = point.hr != null && Number.isFinite(point.hr) ? Math.round(point.hr) : null
    const cadence = point.cadence != null && Number.isFinite(point.cadence) && point.cadence > 0
      ? Math.round(point.cadence)
      : null
    const power = point.watts != null && Number.isFinite(point.watts)
      ? Math.round(point.watts)
      : null

    if (isStationary) {
      return {
        timestamp,
        positionLat: null,
        positionLong: null,
        distance: null,
        altitude: null,
        speed: null,
        heartRate: hr,
        cadence,
        power,
        stepLengthMm: null,
      }
    }

    const speed = paceToSpeed(point.pace)
    const strideMeters = calculateStrideLengthMeters(speed, cadence)
    const hasCoords = point.lat != null && Number.isFinite(point.lat) && point.lng != null && Number.isFinite(point.lng)

    return {
      timestamp,
      positionLat: hasCoords ? degreesToSemicircles(point.lat!) : null,
      positionLong: hasCoords ? degreesToSemicircles(point.lng!) : null,
      distance: point.distance != null && Number.isFinite(point.distance) ? point.distance : null,
      altitude: point.alt != null && Number.isFinite(point.alt) ? point.alt : null,
      speed,
      heartRate: hr,
      cadence,
      power,
      stepLengthMm: strideMeters != null ? Math.round(strideMeters * 10000) / 10 : null,
    }
  })
}

/**
 * Build a Garmin FIT binary payload from an `Activity` and its `FlybyPoint` series
 * using the official `@garmin/fitsdk` `Encoder`.
 *
 * Message order follows the FIT activity profile:
 * `file_id`, `file_creator`, `device_info`, `sport`, `event(start)`, `record*`,
 * `lap*`, `event(stopAll)`, `session`, `activity`.
 */
export function buildFit(
  activity: Activity,
  flybyPoints: readonly FlybyPoint[],
  options: FitBuildOptions = {},
): Uint8Array {
  const startDate = parseUtcDate(activity.start_date)
  const elapsedTime = Number.isFinite(activity.elapsed_time)
    ? Number(activity.elapsed_time)
    : Number(activity.moving_time)
  const movingTime = Number(activity.moving_time)
  const endDate = new Date(startDate.getTime() + Math.round(elapsedTime) * 1000)

  const manufacturer = options.manufacturer ?? DEFAULT_GARMIN_MANUFACTURER
  const productId = options.productId ?? DEFAULT_GARMIN_PRODUCT_ID
  const softwareVersion = options.softwareVersion ?? DEFAULT_GARMIN_SOFTWARE_VERSION
  const serialNumber = options.serialNumber ?? DEFAULT_GARMIN_SERIAL_NUMBER
  const autoLapDistanceMeters = options.autoLapDistanceMeters ?? DEFAULT_AUTO_LAP_DISTANCE_METERS

  const { sport, subSport, isStationary } = mapStravaSportToFit(activity.type, activity.name)
  const fitSafeName = sanitizeFitActivityName(activity.name, activity.run_id)

  const records = buildNormalizedRecords(startDate, flybyPoints, isStationary)

  const totalDistance = isStationary ? 0 : Math.max(0, Number(activity.distance) || 0)
  const avgSpeed = isStationary ? 0 : Math.max(0, Number(activity.average_speed) || 0)
  const avgHeartRate = clampUint8(activity.average_heartrate)

  let laps: ComputedFitLap[] = []
  if (!isStationary) {
    laps = calculateLapsFromRecords(records, autoLapDistanceMeters)
    if (laps.length === 0) {
      laps = [
        {
          timestamp: endDate,
          startTime: startDate,
          totalElapsedTime: elapsedTime,
          totalTimerTime: movingTime,
          totalDistance,
          avgSpeed,
          avgHeartRate: avgHeartRate ?? null,
          avgCadence: null,
          avgPower: null,
        },
      ]
    }
  }

  const encoder = new Encoder()

  // 1. file_id
  const fileIdMesg: FileIdMesg = {
    type: 'activity',
    manufacturer,
    product: productId,
    serialNumber,
    timeCreated: startDate,
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileIdMesg)

  // 2. file_creator
  const fileCreatorMesg: FileCreatorMesg = {
    softwareVersion: 0,
    hardwareVersion: 0,
  }
  encoder.onMesg(Profile.MesgNum.FILE_CREATOR, fileCreatorMesg)

  // 3. device_info
  const deviceInfoMesg: DeviceInfoMesg = {
    timestamp: startDate,
    deviceIndex: 0,
    manufacturer,
    product: productId,
    serialNumber,
    softwareVersion,
    sourceType: 'local',
  }
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, deviceInfoMesg)

  // 4. sport
  const sportMesg: SportMesg = {
    sport: sport as SportMesg['sport'],
    subSport: subSport as SportMesg['subSport'],
    name: fitSafeName,
  }
  encoder.onMesg(Profile.MesgNum.SPORT, sportMesg)

  // 5. event (start)
  const startEventMesg: EventMesg = {
    timestamp: startDate,
    event: 'timer',
    eventType: 'start',
    data: 0,
  }
  encoder.onMesg(Profile.MesgNum.EVENT, startEventMesg)

  // 6. record*
  for (const record of records) {
    const mesg: RecordMesg = {
      timestamp: record.timestamp,
    }
    if (record.positionLat != null && record.positionLong != null) {
      mesg.positionLat = record.positionLat
      mesg.positionLong = record.positionLong
    }
    if (record.distance != null) {
      mesg.distance = Math.max(0, record.distance)
    }
    if (record.altitude != null) {
      if (record.altitude >= MIN_FIT_UINT16_ALTITUDE && record.altitude <= MAX_FIT_UINT16_ALTITUDE) {
        mesg.altitude = record.altitude
      }
      mesg.enhancedAltitude = record.altitude
    }
    if (record.speed != null) {
      const clampedSpeed = Math.max(0, record.speed)
      if (clampedSpeed <= 65.534) {
        mesg.speed = clampedSpeed
      }
      mesg.enhancedSpeed = clampedSpeed
    }
    const hr = clampUint8(record.heartRate)
    if (hr !== undefined) {
      mesg.heartRate = hr
    }
    const cadence = clampUint8(record.cadence)
    if (cadence !== undefined) {
      mesg.cadence = cadence
    }
    const power = clampUint16(record.power)
    if (power !== undefined) {
      mesg.power = power
    }
    if (record.stepLengthMm != null && record.stepLengthMm >= 0 && record.stepLengthMm <= 6553.4) {
      mesg.stepLength = record.stepLengthMm
    }
    encoder.onMesg(Profile.MesgNum.RECORD, mesg)
  }

  // 7. lap*
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i]
    const lapMesg: LapMesg = {
      messageIndex: i,
      timestamp: lap.timestamp,
      startTime: lap.startTime,
      totalElapsedTime: Math.max(0, lap.totalElapsedTime),
      totalTimerTime: Math.max(0, lap.totalTimerTime),
      totalDistance: Math.max(0, lap.totalDistance),
    }
    if (Number.isFinite(lap.avgSpeed)) {
      const clampedAvgSpeed = Math.max(0, lap.avgSpeed)
      if (clampedAvgSpeed <= 65.534) {
        lapMesg.avgSpeed = clampedAvgSpeed
      }
      lapMesg.enhancedAvgSpeed = clampedAvgSpeed
    }
    const lapHr = clampUint8(lap.avgHeartRate)
    if (lapHr !== undefined) {
      lapMesg.avgHeartRate = lapHr
    }
    const lapCadence = clampUint8(lap.avgCadence)
    if (lapCadence !== undefined) {
      lapMesg.avgCadence = lapCadence
    }
    const lapPower = clampUint16(lap.avgPower)
    if (lapPower !== undefined) {
      lapMesg.avgPower = lapPower
    }
    encoder.onMesg(Profile.MesgNum.LAP, lapMesg)
  }

  // 8. event (stopAll)
  const stopEventMesg: EventMesg = {
    timestamp: endDate,
    event: 'timer',
    eventType: 'stopAll',
    data: 0,
  }
  encoder.onMesg(Profile.MesgNum.EVENT, stopEventMesg)

  // 9. session
  const sessionMesg: SessionMesg = {
    timestamp: endDate,
    startTime: startDate,
    totalElapsedTime: Math.max(0, elapsedTime),
    totalTimerTime: Math.max(0, movingTime),
    totalDistance,
    sport: sport as SessionMesg['sport'],
    subSport: subSport as SessionMesg['subSport'],
    numLaps: Math.max(1, laps.length),
    firstLapIndex: 0,
    event: 'session',
    eventType: 'stop',
    trigger: 'activityEnd',
    avgSpeed: avgSpeed <= 65.534 ? avgSpeed : undefined,
    enhancedAvgSpeed: avgSpeed,
    sportProfileName: fitSafeName,
  }
  if (avgHeartRate !== undefined) {
    sessionMesg.avgHeartRate = avgHeartRate
  }
  if (!isStationary) {
    const totalAscent = clampUint16(activity.elevation_gain)
    if (totalAscent !== undefined) {
      sessionMesg.totalAscent = totalAscent
    }
  }
  encoder.onMesg(Profile.MesgNum.SESSION, sessionMesg)

  // 10. activity
  const activityMesg: ActivityMesg = {
    timestamp: endDate,
    totalTimerTime: Math.max(0, movingTime),
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  }
  encoder.onMesg(Profile.MesgNum.ACTIVITY, activityMesg)

  return encoder.close()
}
