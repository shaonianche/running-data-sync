import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ParseError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
} from '../testing/fixtures.js'
import {
  createActivityFormatPort,
  GarminActivityFormatPort,
} from './index.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

describe('garminActivityFormatPort GPX / TCX / FIT / ZIP round-trip parsing', () => {
  const port = createActivityFormatPort()

  it('constructs GarminActivityFormatPort implementing ActivityFormatPort', () => {
    expect(port).toBeInstanceOf(GarminActivityFormatPort)
  })

  it('parses independent Python-generated outdoor & indoor FIT files and ZIP-wrapped FIT archives', async () => {
    const outdoorFit = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'python-ref-outdoor.fit')))
    const parsedFit = await port.parseTrack(outdoorFit, { fileName: '200001.fit' })

    expect(parsedFit.name).toBe('Morning Tempo')
    expect(parsedFit.type).toBe('Run')
    expect(parsedFit.subtype).toBe('street')
    expect(parsedFit.startDate).toBe('2025-05-10T00:00:00Z')
    expect(parsedFit.startDateLocal).toBe('2025-05-10T08:00:00')
    expect(parsedFit.distance).toBeCloseTo(2500, 2)
    expect(parsedFit.movingTime).toBeCloseTo(750, 2)
    expect(parsedFit.elapsedTime).toBeCloseTo(760, 2)
    expect(parsedFit.averageHeartrate).toBe(155)
    expect(parsedFit.points).toHaveLength(6)
    expect(parsedFit.startLatLng?.[0]).toBeCloseTo(31.23, 4)
    expect(parsedFit.startLatLng?.[1]).toBeCloseTo(121.47, 4)
    expect(parsedFit.summaryPolyline).toBeTruthy()
    expect(parsedFit.device).toContain('garmin')
    expect(parsedFit.fileName).toBe('200001.fit')

    // Wrap the FIT in a ZIP archive alongside macOS metadata noise
    const zipBytes = zipSync({
      '__MACOSX/._200001.fit': new Uint8Array([0, 1, 2]),
      '200001_ACTIVITY.fit': outdoorFit,
    })
    const parsedFromZip = await port.parseTrack(zipBytes)
    expect(parsedFromZip.name).toBe(parsedFit.name)
    expect(parsedFromZip.distance).toBeCloseTo(parsedFit.distance, 2)
    expect(parsedFromZip.points).toHaveLength(parsedFit.points.length)
    expect(parsedFromZip.fileName).toBe('200001_ACTIVITY.fit')

    // Parse independent GPS-less indoor FIT
    const indoorFit = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'python-ref-indoor.fit')))
    const parsedIndoor = await port.parseTrack(indoorFit)
    expect(parsedIndoor.type).toBe('boxing')
    expect(parsedIndoor.distance).toBe(0)
    expect(parsedIndoor.averageHeartrate).toBe(142)
    expect(parsedIndoor.startLatLng).toBeNull()
    expect(parsedIndoor.summaryPolyline).toBeNull()
    expect(parsedIndoor.polylines).toEqual([])
    expect(parsedIndoor.points).toHaveLength(4)
  })

  it('parses independent multi-segment GPX fixture with TrackPointExtension HR/cadence', async () => {
    const gpxText = readFileSync(join(FIXTURES_DIR, 'sample-outdoor.gpx'), 'utf8')
    const parsed = await port.parseTrack(gpxText, { fileName: 'sample-outdoor.gpx' })

    expect(parsed.name).toBe('Riverside Loop')
    expect(parsed.type).toBe('Run')
    expect(parsed.device).toBe('Garmin Connect')
    expect(parsed.startDate).toBe('2025-04-01T00:00:00Z')
    expect(parsed.endDate).toBe('2025-04-01T00:07:30Z')
    expect(parsed.startDateLocal).toBe('2025-04-01T08:00:00')
    expect(parsed.elapsedTime).toBe(450)
    expect(parsed.polylines).toHaveLength(2)
    expect(parsed.points).toHaveLength(4)
    expect(parsed.points[0]).toMatchObject({ lat: 31.2304, lng: 121.4737, alt: 12.5, hr: 142, cadence: 86 })
    expect(parsed.averageHeartrate).toBeCloseTo((142 + 150 + 158 + 162) / 4, 2)
    // Uphill: (18 - 12.5) + (24.5 - 16) = 5.5 + 8.5 = 14.0m
    expect(parsed.elevationGain).toBeCloseTo(14.0, 2)
    expect(parsed.distance).toBeGreaterThan(900)
    expect(parsed.summaryPolyline).toBeTruthy()
  })

  it('injects and idempotently updates Garmin GPX summary <extensions> and applies overrides on parse', async () => {
    const gpxText = readFileSync(join(FIXTURES_DIR, 'sample-outdoor.gpx'), 'utf8')

    const injected = port.injectGpxSummaryExtensions(gpxText, {
      distance: 5120.5,
      averageHr: 159.5,
      averageSpeed: 3.45,
    })

    expect(injected).toContain('<distance>5120.5</distance>')
    expect(injected).toContain('<average_hr>159.5</average_hr>')
    expect(injected).toContain('<average_speed>3.45</average_speed>')
    // Preserves inner trackpoint extensions untouched
    expect(injected).toContain('<gpxtpx:hr>142</gpxtpx:hr>')

    const parsed = await port.parseTrack(injected)
    expect(parsed.distance).toBeCloseTo(5120.5, 2)
    expect(parsed.averageHeartrate).toBeCloseTo(159.5, 2)
    expect(parsed.averageSpeed).toBeCloseTo(3.45, 2)

    // Re-injecting replaces the root <extensions> instead of duplicating it
    const updated = port.injectGpxSummaryExtensions(new TextEncoder().encode(injected), {
      distance: 5200,
      averageHr: 161,
      averageSpeed: 3.5,
    })
    expect(updated.match(/<distance>/g)).toHaveLength(1)
    const parsedUpdated = await port.parseTrack(updated)
    expect(parsedUpdated.distance).toBe(5200)
    expect(parsedUpdated.averageHeartrate).toBe(161)
    expect(parsedUpdated.averageSpeed).toBe(3.5)
  })

  it('round-trips buildGpx -> parseTrack', async () => {
    const activity = createOutdoorRunActivity()
    const points = createOutdoorRunFlybyPoints()
    const gpx = port.buildGpx(activity, points)
    const parsed = await port.parseTrack(gpx)

    expect(parsed.name).toBe(activity.name)
    expect(parsed.type).toBe('Run')
    expect(parsed.startDate).toBe(activity.start_date)
    expect(parsed.points).toHaveLength(points.length)
    expect(parsed.points[0].hr).toBe(points[0].hr)
    expect(parsed.points[0].cadence).toBe(points[0].cadence)
    expect(parsed.startLatLng?.[0]).toBeCloseTo(points[0].lat!, 4)
    expect(parsed.startLatLng?.[1]).toBeCloseTo(points[0].lng!, 4)
  })

  it('parses independent outdoor multi-lap TCX and indoor GPS-less TCX fixtures', async () => {
    const outdoorTcx = readFileSync(join(FIXTURES_DIR, 'sample-outdoor.tcx'), 'utf8')
    const parsedOutdoor = await port.parseTrack(outdoorTcx, { fileName: 'sample-outdoor.tcx' })

    expect(parsedOutdoor.name).toBe('Two Lap Threshold')
    expect(parsedOutdoor.type).toBe('Run')
    expect(parsedOutdoor.device).toBe('Forerunner 245')
    expect(parsedOutdoor.distance).toBe(2000)
    expect(parsedOutdoor.elapsedTime).toBe(600)
    expect(parsedOutdoor.averageSpeed).toBeCloseTo(2000 / 600, 3)
    expect(parsedOutdoor.points).toHaveLength(3)
    expect(parsedOutdoor.points[0]).toMatchObject({
      lat: 31.23,
      lng: 121.47,
      alt: 10,
      hr: 142,
      cadence: 88,
      speed: 3.3,
      watts: 235,
    })
    expect(parsedOutdoor.elevationGain).toBeCloseTo(20, 2)

    const indoorTcx = readFileSync(join(FIXTURES_DIR, 'sample-indoor.tcx'), 'utf8')
    const parsedIndoor = await port.parseTrack(indoorTcx)
    expect(parsedIndoor.name).toBe('Indoor Core Session')
    expect(parsedIndoor.type).toBe('Other')
    expect(parsedIndoor.startDate).toBe('2025-04-03T03:00:00Z')
    expect(parsedIndoor.startDateLocal).toBe('2025-04-03T11:00:00')
    expect(parsedIndoor.endDateLocal).toBe('2025-04-03T11:20:00')
    expect(parsedIndoor.distance).toBe(0)
    expect(parsedIndoor.startLatLng).toBeNull()
    expect(parsedIndoor.averageHeartrate).toBeCloseTo((120 + 138 + 138) / 3, 2)
  })

  it('round-trips buildTcx -> parseTrack for both outdoor and indoor activities', async () => {
    const outdoor = createOutdoorRunActivity()
    const outdoorPts = createOutdoorRunFlybyPoints()
    const tcx = port.buildTcx(outdoor, outdoorPts)
    const parsedOutdoor = await port.parseTrack(tcx)

    expect(parsedOutdoor.name).toBe(outdoor.name)
    expect(parsedOutdoor.type).toBe('Run')
    expect(parsedOutdoor.distance).toBe(outdoor.distance)
    expect(parsedOutdoor.points).toHaveLength(outdoorPts.length)
    expect(parsedOutdoor.points[0].watts).toBe(outdoorPts[0].watts)

    const indoor = createIndoorWorkoutActivity()
    const indoorPts = createIndoorWorkoutFlybyPoints()
    const indoorTcx = port.buildTcx(indoor, indoorPts)
    const parsedIndoor = await port.parseTrack(indoorTcx)
    expect(parsedIndoor.name).toBe(indoor.name)
    expect(parsedIndoor.distance).toBe(0)
    expect(parsedIndoor.points).toHaveLength(indoorPts.length)
    expect(parsedIndoor.averageHeartrate).toBeCloseTo(127.6, 1)
  })

  it('throws ParseError on malformed XML, empty payloads, and corrupt or empty ZIP archives', async () => {
    await expect(port.parseTrack('')).rejects.toThrow(ParseError)
    await expect(port.parseTrack('<gpx><unclosed></gpx>', { format: 'gpx' })).rejects.toThrow(ParseError)
    await expect(port.parseTrack('<TrainingCenterDatabase><bad>', { format: 'tcx' })).rejects.toThrow(ParseError)
    await expect(port.parseTrack('not-binary', { format: 'fit' })).rejects.toThrow(ParseError)
    await expect(port.parseTrack(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x00]), { format: 'zip' })).rejects.toThrow(ParseError)

    const emptyZip = zipSync({ 'readme.txt': new TextEncoder().encode('hello') })
    await expect(port.parseTrack(emptyZip)).rejects.toThrow(ParseError)

    expect(() => port.injectGpxSummaryExtensions('<broken>', { distance: 100 })).toThrow(ParseError)
  })
})
