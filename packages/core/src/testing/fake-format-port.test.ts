import { describe, expect, it } from 'vitest'
import { ParseError } from '../foundation/errors.js'
import { FakeActivityFormatPort } from './fake-format-port.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createParsedTrackFixture,
} from './fixtures.js'

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0
}

describe('fakeActivityFormatPort', () => {
  it('validates FIT binary headers cleanly', () => {
    const port = new FakeActivityFormatPort()
    const valid12 = new Uint8Array([12, 0x20, 0, 0, 0, 0, 0, 0, 0x2E, 0x46, 0x49, 0x54])
    const valid14 = new Uint8Array([14, 0x20, 0, 0, 0, 0, 0, 0, 0x2E, 0x46, 0x49, 0x54, 0, 0])
    const badHeaderSize = new Uint8Array([10, 0x20, 0, 0, 0, 0, 0, 0, 0x2E, 0x46, 0x49, 0x54])
    const tooShort = new Uint8Array([12, 0x20, 0x2E, 0x46, 0x49, 0x54])
    const gpxBytes = new TextEncoder().encode('<gpx></gpx>')

    expect(port.isFitFile(valid12)).toBe(true)
    expect(port.isFitFile(valid14)).toBe(true)
    expect(port.isFitFile(badHeaderSize)).toBe(false)
    expect(port.isFitFile(tooShort)).toBe(false)
    expect(port.isFitFile(gpxBytes)).toBe(false)
  })

  it('builds synthetic FIT, TCX, and GPX payloads and records calls', () => {
    const port = new FakeActivityFormatPort()
    const outdoor = createOutdoorRunActivity()
    const outdoorPoints = createOutdoorRunFlybyPoints()

    const fit = port.buildFit(outdoor, outdoorPoints, {
      manufacturer: 1,
      productId: 3589,
      softwareVersion: 5.5,
      autoLapDistanceMeters: 1000,
    })
    expect(port.isFitFile(fit)).toBe(true)
    expect(readUint32LE(fit, 4)).toBe(fit.length - 14)

    const tcx = port.buildTcx(outdoor, outdoorPoints)
    expect(tcx).toContain('<TrainingCenterDatabase>')
    expect(tcx).toContain('Sport="Run"')
    expect(tcx).toContain('<LatitudeDegrees>39.944</LatitudeDegrees>')

    const gpx = port.buildGpx(outdoor, outdoorPoints)
    expect(gpx).toContain('<gpx version="1.1"')
    expect(gpx).toContain('<name>Morning Run</name>')
    expect(gpx).toContain('lat="39.944" lon="116.482"')

    // Indoor GPS-less workout omits coordinates cleanly
    const indoor = createIndoorWorkoutActivity({ name: 'Push & Pull <Gym>' })
    const indoorGpx = port.buildGpx(indoor, createIndoorWorkoutFlybyPoints())
    expect(indoorGpx).toContain('<name>Push &amp; Pull &lt;Gym&gt;</name>')
    expect(indoorGpx).not.toContain('<trkpt')

    expect(port.calls.buildFit).toHaveLength(1)
    expect(port.calls.buildTcx).toHaveLength(1)
    expect(port.calls.buildGpx).toHaveLength(2)

    port.reset()
    expect(port.calls.buildFit).toHaveLength(0)
    expect(port.calls.buildTcx).toHaveLength(0)
    expect(port.calls.buildGpx).toHaveLength(0)
  })

  it('adapts FIT payloads and rejects non-FIT inputs', () => {
    const port = new FakeActivityFormatPort()
    const baseFit = port.buildFit(createOutdoorRunActivity(), createOutdoorRunFlybyPoints())

    const unchanged = port.adaptFit(baseFit, { useFakeGarminDevice: false, fixHeartRate: false })
    expect(unchanged).toEqual(baseFit)
    expect(unchanged).not.toBe(baseFit)

    const adapted = port.adaptFit(baseFit, { useFakeGarminDevice: true, fixHeartRate: true, productId: 3589 })
    expect(port.isFitFile(adapted)).toBe(true)
    expect(readUint32LE(adapted, 4)).toBe(adapted.length - 14)
    expect(adapted).not.toEqual(baseFit)

    expect(() => port.adaptFit(new Uint8Array([1, 2, 3]), { useFakeGarminDevice: true })).toThrow(ParseError)
    expect(port.calls.adaptFit).toHaveLength(3)
  })

  it('parses tracks and injects GPX summary extensions', async () => {
    const port = new FakeActivityFormatPort()
    const parsed = await port.parseTrack('<gpx></gpx>', { format: 'gpx', fileName: '100001.gpx' })
    expect(parsed.runId).toBe(100001)
    expect(parsed.fileName).toBe('100001.gpx')
    expect(parsed.points).toHaveLength(6)

    const gpx = '<gpx version="1.1"><trk><name>Test</name></trk></gpx>'
    const withExt = port.injectGpxSummaryExtensions(gpx, {
      distance: 5000,
      averageHr: 152,
      averageSpeed: 3.333,
    })
    expect(withExt).toContain(
      '<gpx version="1.1"><extensions><distance>5000</distance><average_hr>152</average_hr><average_speed>3.333</average_speed></extensions><trk>',
    )

    const fromBytes = port.injectGpxSummaryExtensions(new TextEncoder().encode(gpx), { distance: 1200 })
    expect(fromBytes).toContain('<extensions><distance>1200</distance></extensions>')

    // No-op when all summary fields are empty
    expect(port.injectGpxSummaryExtensions(gpx, { distance: null, averageHr: undefined })).toBe(gpx)

    // Missing <gpx> throws ParseError
    expect(() => port.injectGpxSummaryExtensions('<xml></xml>', { distance: 100 })).toThrow(ParseError)
  })

  it('supports custom handler overrides for unit testing', async () => {
    const customTrack = createParsedTrackFixture({ runId: 777, name: 'Custom Override' })
    const port = new FakeActivityFormatPort({
      defaultParsedTrack: customTrack,
      buildTcx: () => '<custom-tcx/>',
    })

    expect(port.buildTcx(createOutdoorRunActivity(), [])).toBe('<custom-tcx/>')
    const parsed = await port.parseTrack(new Uint8Array([1, 2]), { format: 'zip', fileName: '777.zip' })
    expect(parsed.runId).toBe(777)
    expect(parsed.name).toBe('Custom Override')
    expect(parsed.fileName).toBe('777.zip')
  })
})
