import { describe, expect, it } from 'vitest'
import * as coreProductionEntry from '../index.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createParsedTrackFixture,
  createPosterTrack,
  createVendorSyncRow,
  FIXTURE_INDOOR_WORKOUT_ACTIVITY,
  FIXTURE_INDOOR_WORKOUT_FLYBY_POINTS,
  FIXTURE_OUTDOOR_RUN_ACTIVITY,
  FIXTURE_OUTDOOR_RUN_FLYBY_POINTS,
  FIXTURE_OUTDOOR_RUN_POLYLINE,
} from './fixtures.js'

function decodePolyline(encoded: string): Array<[number, number]> {
  const coords: Array<[number, number]> = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let shift = 0
    let result = 0
    let byte = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)

    shift = 0
    result = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)

    coords.push([lat / 1e5, lng / 1e5])
  }

  return coords
}

describe('deterministic fixtures and production boundary', () => {
  it('aligns outdoor run polyline with outdoor flyby coordinates', () => {
    const decoded = decodePolyline(FIXTURE_OUTDOOR_RUN_POLYLINE)
    expect(decoded).toHaveLength(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS.length)

    for (let i = 0; i < decoded.length; i += 1) {
      expect(decoded[i][0]).toBeCloseTo(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS[i].lat!, 5)
      expect(decoded[i][1]).toBeCloseTo(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS[i].lng!, 5)
    }
    expect(FIXTURE_OUTDOOR_RUN_ACTIVITY.summary_polyline).toBe(FIXTURE_OUTDOOR_RUN_POLYLINE)
  })

  it('models indoor workout fixture without GPS coordinates', () => {
    expect(FIXTURE_INDOOR_WORKOUT_ACTIVITY.distance).toBe(0)
    expect(FIXTURE_INDOOR_WORKOUT_ACTIVITY.summary_polyline).toBeNull()
    expect(FIXTURE_INDOOR_WORKOUT_FLYBY_POINTS.length).toBeGreaterThan(0)
    for (const point of FIXTURE_INDOOR_WORKOUT_FLYBY_POINTS) {
      expect(point.lat).toBeNull()
      expect(point.lng).toBeNull()
      expect(point.alt).toBeNull()
      expect(point.hr).not.toBeNull()
    }
  })

  it('produces isolated mutable copies from factory helpers', () => {
    const run = createOutdoorRunActivity({ name: 'Tempo Run' })
    const indoor = createIndoorWorkoutActivity({ run_id: 999 })
    const runPoints = createOutdoorRunFlybyPoints(888)
    const indoorPoints = createIndoorWorkoutFlybyPoints(999)
    const vendorRow = createVendorSyncRow({ status: 'pending' })
    const posterTrack = createPosterTrack({ distance: 10000 })
    const parsedTrack = createParsedTrackFixture()

    expect(run.name).toBe('Tempo Run')
    expect(FIXTURE_OUTDOOR_RUN_ACTIVITY.name).toBe('Morning Run')
    expect(indoor.run_id).toBe(999)
    expect(runPoints.every(p => p.activity_id === 888)).toBe(true)
    expect(indoorPoints.every(p => p.activity_id === 999)).toBe(true)
    expect(vendorRow.status).toBe('pending')
    expect(posterTrack.distance).toBe(10000)
    expect(parsedTrack.points[0].timestamp).toBe('2025-03-15T00:30:00.000Z')
    expect(parsedTrack.points[5].timestamp).toBe('2025-03-15T00:55:00.000Z')
    expect(parsedTrack.points[0].speed).toBe(FIXTURE_OUTDOOR_RUN_ACTIVITY.average_speed)
  })

  it('keeps test doubles and fixtures out of production package entry', () => {
    expect('InMemoryActivityStore' in coreProductionEntry).toBe(false)
    expect('FakeActivityFormatPort' in coreProductionEntry).toBe(false)
    expect('FIXTURE_OUTDOOR_RUN_ACTIVITY' in coreProductionEntry).toBe(false)
  })
})
