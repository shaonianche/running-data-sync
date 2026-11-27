import type { Activity, FlybyPoint } from '../foundation/types.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Decoder, Stream } from '@garmin/fitsdk'
import { describe, expect, it } from 'vitest'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
} from '../testing/fixtures.js'
import {
  buildFit,
  calculateStrideLengthMeters,
  decodePolyline,
  encodePolyline,
  mapStravaSportToFit,
  sanitizeFitActivityName,
} from './index.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

function decodeWithOfficialSdk(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  const isFIT = decoder.isFIT()
  const integrity = decoder.checkIntegrity()
  const { messages, errors } = decoder.read()
  return { isFIT, integrity, messages, errors }
}

const PYTHON_REF_OUTDOOR_ACTIVITY: Activity = {
  run_id: 200001,
  name: 'Morning Tempo: Park Loop',
  distance: 2500,
  moving_time: 750,
  elapsed_time: 760,
  type: 'Run',
  subtype: 'street',
  start_date: '2025-05-10T00:00:00Z',
  start_date_local: '2025-05-10T08:00:00',
  average_heartrate: 155,
  average_speed: 2500 / 750,
  elevation_gain: 28,
}

const PYTHON_REF_OUTDOOR_POINTS: readonly FlybyPoint[] = [
  { activity_id: 200001, time_offset: 0, lat: 31.23, lng: 121.47, alt: 10, pace: 5.0, hr: 140, distance: 0, cadence: 176, watts: 240 },
  { activity_id: 200001, time_offset: 150, lat: 31.2345, lng: 121.471, alt: 15, pace: 5.0, hr: 150, distance: 500, cadence: 178, watts: 250 },
  { activity_id: 200001, time_offset: 300, lat: 31.239, lng: 121.472, alt: 20, pace: 5.0, hr: 155, distance: 1000, cadence: 180, watts: 255 },
  { activity_id: 200001, time_offset: 450, lat: 31.2435, lng: 121.473, alt: 25, pace: 5.0, hr: 158, distance: 1500, cadence: 180, watts: 260 },
  { activity_id: 200001, time_offset: 600, lat: 31.248, lng: 121.474, alt: 32, pace: 5.0, hr: 162, distance: 2000, cadence: 182, watts: 265 },
  { activity_id: 200001, time_offset: 750, lat: 31.2525, lng: 121.475, alt: 38, pace: 5.0, hr: 165, distance: 2500, cadence: 182, watts: 270 },
]

const PYTHON_REF_INDOOR_ACTIVITY: Activity = {
  run_id: 200002,
  name: 'Evening Boxing Session: Heavy Bag',
  distance: 0,
  moving_time: 1800,
  elapsed_time: 1860,
  type: 'Workout',
  subtype: '',
  start_date: '2025-05-11T10:00:00Z',
  start_date_local: '2025-05-11T18:00:00',
  average_heartrate: 142,
  average_speed: 0,
  elevation_gain: 0,
}

const PYTHON_REF_INDOOR_POINTS: readonly FlybyPoint[] = [
  { activity_id: 200002, time_offset: 0, lat: null, lng: null, alt: null, pace: 0, hr: 120, distance: 0, cadence: null, watts: null },
  { activity_id: 200002, time_offset: 600, lat: null, lng: null, alt: null, pace: 0, hr: 145, distance: 0, cadence: null, watts: null },
  { activity_id: 200002, time_offset: 1200, lat: null, lng: null, alt: null, pace: 0, hr: 155, distance: 0, cadence: null, watts: null },
  { activity_id: 200002, time_offset: 1800, lat: null, lng: null, alt: null, pace: 0, hr: 148, distance: 0, cadence: null, watts: null },
]

describe('fit-encoder with official @garmin/fitsdk', () => {
  it('matches Python reference outdoor FIT output across session, 1km laps, sport, and records', () => {
    const pyRefBytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'python-ref-outdoor.fit')))
    const tsBytes = buildFit(PYTHON_REF_OUTDOOR_ACTIVITY, PYTHON_REF_OUTDOOR_POINTS)

    const pyDecoded = decodeWithOfficialSdk(pyRefBytes)
    const tsDecoded = decodeWithOfficialSdk(tsBytes)

    expect(tsDecoded.isFIT).toBe(true)
    expect(tsDecoded.integrity).toBe(true)
    expect(tsDecoded.errors).toEqual([])
    expect(pyDecoded.isFIT).toBe(true)
    expect(pyDecoded.integrity).toBe(true)

    const pySport = pyDecoded.messages.sportMesgs?.[0]
    const tsSport = tsDecoded.messages.sportMesgs?.[0]
    expect(tsSport?.sport).toBe(pySport?.sport)
    expect(tsSport?.subSport).toBe(pySport?.subSport)
    expect(tsSport?.name).toBe('Morning Tempo')
    expect(tsSport?.name).toBe(pySport?.name)

    const pySession = pyDecoded.messages.sessionMesgs?.[0]
    const tsSession = tsDecoded.messages.sessionMesgs?.[0]
    expect(tsSession?.startTime).toEqual(pySession?.startTime)
    expect(tsSession?.timestamp).toEqual(pySession?.timestamp)
    expect(tsSession?.totalDistance).toBeCloseTo(pySession?.totalDistance ?? 0, 2)
    expect(tsSession?.totalElapsedTime).toBeCloseTo(pySession?.totalElapsedTime ?? 0, 2)
    expect(tsSession?.totalTimerTime).toBeCloseTo(pySession?.totalTimerTime ?? 0, 2)
    expect(tsSession?.avgSpeed).toBeCloseTo(pySession?.avgSpeed ?? 0, 3)
    expect(tsSession?.avgHeartRate).toBe(pySession?.avgHeartRate)
    expect(tsSession?.sportProfileName).toBe(pySession?.sportProfileName)
    expect(tsSession?.numLaps).toBe(3)
    expect(tsSession?.numLaps).toBe(pySession?.numLaps)
    expect(tsSession?.totalAscent).toBe(28)

    const pyLaps = pyDecoded.messages.lapMesgs ?? []
    const tsLaps = tsDecoded.messages.lapMesgs ?? []
    expect(tsLaps).toHaveLength(pyLaps.length)
    for (let i = 0; i < pyLaps.length; i++) {
      expect(tsLaps[i].totalDistance).toBeCloseTo(pyLaps[i].totalDistance ?? 0, 2)
      expect(tsLaps[i].totalElapsedTime).toBeCloseTo(pyLaps[i].totalElapsedTime ?? 0, 2)
      expect(tsLaps[i].avgHeartRate).toBe(pyLaps[i].avgHeartRate)
      expect(tsLaps[i].avgCadence).toBe(pyLaps[i].avgCadence)
      expect(tsLaps[i].avgPower).toBe(pyLaps[i].avgPower)
    }

    const pyRecords = pyDecoded.messages.recordMesgs ?? []
    const tsRecords = tsDecoded.messages.recordMesgs ?? []
    expect(tsRecords).toHaveLength(pyRecords.length)
    for (let i = 0; i < pyRecords.length; i++) {
      expect(tsRecords[i].timestamp).toEqual(pyRecords[i].timestamp)
      expect(tsRecords[i].positionLat).toBe(pyRecords[i].positionLat)
      expect(tsRecords[i].positionLong).toBe(pyRecords[i].positionLong)
      expect(tsRecords[i].altitude).toBeCloseTo(pyRecords[i].altitude ?? 0, 1)
      expect(tsRecords[i].enhancedAltitude).toBeCloseTo(pyRecords[i].enhancedAltitude ?? 0, 1)
      expect(tsRecords[i].distance).toBeCloseTo(pyRecords[i].distance ?? 0, 2)
      expect(tsRecords[i].speed).toBeCloseTo(pyRecords[i].speed ?? 0, 3)
      expect(tsRecords[i].heartRate).toBe(pyRecords[i].heartRate)
      expect(tsRecords[i].cadence).toBe(pyRecords[i].cadence)
      expect(tsRecords[i].power).toBe(pyRecords[i].power)
      // Official FIT stepLength is in millimeters (~1100mm for 5:00/km at 180 spm)
      expect(tsRecords[i].stepLength).toBeGreaterThan(1000)
      expect(tsRecords[i].stepLength).toBeLessThan(1200)
    }
  })

  it('matches Python reference indoor stationary FIT output including Boxing heuristic', () => {
    const pyRefBytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'python-ref-indoor.fit')))
    const tsBytes = buildFit(PYTHON_REF_INDOOR_ACTIVITY, PYTHON_REF_INDOOR_POINTS)

    const pyDecoded = decodeWithOfficialSdk(pyRefBytes)
    const tsDecoded = decodeWithOfficialSdk(tsBytes)

    expect(tsDecoded.isFIT).toBe(true)
    expect(tsDecoded.integrity).toBe(true)
    expect(tsDecoded.errors).toEqual([])

    expect(tsDecoded.messages.sportMesgs?.[0]).toMatchObject({
      sport: 'boxing',
      subSport: 'generic',
      name: 'Evening Boxing Session',
    })
    expect(tsDecoded.messages.lapMesgs ?? []).toHaveLength(0)
    expect(tsDecoded.messages.sessionMesgs?.[0]?.numLaps).toBe(1)
    expect(tsDecoded.messages.sessionMesgs?.[0]?.totalDistance).toBe(0)
    expect(tsDecoded.messages.sessionMesgs?.[0]?.avgSpeed).toBe(0)
    expect(tsDecoded.messages.sessionMesgs?.[0]?.avgHeartRate).toBe(pyDecoded.messages.sessionMesgs?.[0]?.avgHeartRate)

    const tsRecords = tsDecoded.messages.recordMesgs ?? []
    expect(tsRecords).toHaveLength(4)
    expect(tsRecords.map(r => r.heartRate)).toEqual([120, 145, 155, 148])
    for (const rec of tsRecords) {
      expect(rec.positionLat).toBeUndefined()
      expect(rec.positionLong).toBeUndefined()
      expect(rec.distance).toBeUndefined()
      expect(rec.speed).toBeUndefined()
    }
  })

  it('encodes exact physical altitude values (negative and high elevation) without legacy +500 distortion', () => {
    const activity = createOutdoorRunActivity({
      run_id: 200010,
      distance: 1000,
      moving_time: 300,
      elapsed_time: 300,
    })
    const points: FlybyPoint[] = [
      { activity_id: 200010, time_offset: 0, lat: 31.23, lng: 121.47, alt: -25.4, pace: 5.0, hr: 140, distance: 0, cadence: 175, watts: 220 },
      { activity_id: 200010, time_offset: 150, lat: 31.235, lng: 121.471, alt: 45.2, pace: 5.0, hr: 150, distance: 500, cadence: 178, watts: 230 },
      { activity_id: 200010, time_offset: 300, lat: 31.24, lng: 121.472, alt: 3850.6, pace: 5.0, hr: 160, distance: 1000, cadence: 180, watts: 240 },
    ]

    const bytes = buildFit(activity, points)
    const decoded = decodeWithOfficialSdk(bytes)
    expect(decoded.isFIT).toBe(true)
    expect(decoded.integrity).toBe(true)
    expect(decoded.errors).toEqual([])

    const recs = decoded.messages.recordMesgs ?? []
    expect(recs[0].altitude).toBeCloseTo(-25.4, 1)
    expect(recs[0].enhancedAltitude).toBeCloseTo(-25.4, 1)
    expect(recs[1].altitude).toBeCloseTo(45.2, 1)
    expect(recs[2].altitude).toBeCloseTo(3850.6, 1)
    expect(recs[2].enhancedAltitude).toBeCloseTo(3850.6, 1)
  })

  it('honors custom FitBuildOptions and falls back to a single lap when outdoor points are empty', () => {
    const activity = createOutdoorRunActivity()
    const bytes = buildFit(activity, [], {
      manufacturer: 1,
      productId: 3076,
      softwareVersion: 9.2,
      serialNumber: 987654321,
    })
    const decoded = decodeWithOfficialSdk(bytes)

    expect(decoded.isFIT).toBe(true)
    expect(decoded.integrity).toBe(true)
    expect(decoded.errors).toEqual([])
    expect(decoded.messages.fileIdMesgs?.[0]).toMatchObject({
      manufacturer: 'garmin',
      product: 3076,
      serialNumber: 987654321,
    })
    expect(decoded.messages.deviceInfoMesgs?.[0]).toMatchObject({
      manufacturer: 'garmin',
      product: 3076,
      serialNumber: 987654321,
      softwareVersion: 9.2,
    })
    expect(decoded.messages.lapMesgs).toHaveLength(1)
    expect(decoded.messages.lapMesgs?.[0].totalDistance).toBeCloseTo(activity.distance, 2)
  })

  it('generates valid FIT files from shared outdoor & indoor test fixtures with custom auto-lap intervals', () => {
    const outdoorBytes = buildFit(createOutdoorRunActivity(), createOutdoorRunFlybyPoints(), {
      autoLapDistanceMeters: 2000,
    })
    const outdoorDecoded = decodeWithOfficialSdk(outdoorBytes)
    expect(outdoorDecoded.isFIT).toBe(true)
    expect(outdoorDecoded.integrity).toBe(true)
    expect(outdoorDecoded.errors).toEqual([])
    // 5000m split at 2000m -> 2000m, 2000m, 1000m = 3 laps
    expect(outdoorDecoded.messages.lapMesgs).toHaveLength(3)

    const indoorBytes = buildFit(createIndoorWorkoutActivity(), createIndoorWorkoutFlybyPoints())
    const indoorDecoded = decodeWithOfficialSdk(indoorBytes)
    expect(indoorDecoded.isFIT).toBe(true)
    expect(indoorDecoded.integrity).toBe(true)
    expect(indoorDecoded.errors).toEqual([])
    expect(indoorDecoded.messages.sportMesgs?.[0]).toMatchObject({
      sport: 'training',
      subSport: 'strengthTraining',
    })
  })

  it('handles sport mapping, name sanitization, stride length bounds, and polyline round-trips', () => {
    expect(mapStravaSportToFit('Workout', 'Friday Boxing Sparring')).toEqual({
      sport: 'boxing',
      subSport: 'generic',
      isStationary: true,
    })
    expect(mapStravaSportToFit('TrailRun')).toEqual({
      sport: 'running',
      subSport: 'trail',
      isStationary: false,
    })
    expect(mapStravaSportToFit('UnknownSport')).toEqual({
      sport: 'generic',
      subSport: 'generic',
      isStationary: false,
    })

    expect(sanitizeFitActivityName('Intervals: 5x1k\0', 42)).toBe('Intervals')
    expect(sanitizeFitActivityName('晨跑：世纪公园', 42)).toBe('晨跑')
    expect(sanitizeFitActivityName('   ', 42)).toBe('Strava 42')
    expect(sanitizeFitActivityName(null, 42)).toBe('Strava 42')

    expect(calculateStrideLengthMeters(3.333, 180)).toBeCloseTo(1.111, 3)
    expect(calculateStrideLengthMeters(10, 60)).toBeNull() // > 3.0m filtered
    expect(calculateStrideLengthMeters(0.1, 180)).toBeNull() // < 0.2m filtered

    const coords: readonly [number, number][] = [
      [31.2304, 121.4737],
      [31.2412, 121.4825],
      [31.2519, 121.4911],
    ]
    const decodedCoords = decodePolyline(encodePolyline(coords))
    expect(decodedCoords).toHaveLength(coords.length)
    for (let i = 0; i < coords.length; i++) {
      expect(decodedCoords[i][0]).toBeCloseTo(coords[i][0], 5)
      expect(decodedCoords[i][1]).toBeCloseTo(coords[i][1], 5)
    }
  })
})
