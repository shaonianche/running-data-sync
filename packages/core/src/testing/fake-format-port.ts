import type {
  ActivityFormatPort,
  FitAdaptOptions,
  FitBuildOptions,
  GpxSummaryExtensions,
  ParsedTrack,
  ParseTrackOptions,
} from '../contracts/formats.js'
import type { Activity, FlybyPoint } from '../foundation/types.js'
import { ParseError } from '../foundation/errors.js'
import { createParsedTrackFixture } from './fixtures.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// Build a structurally valid 12-byte FIT header (headerSize=12, protocol=2.0, ".FIT" magic)
// with little-endian dataSize and 2-byte CRC placeholder trailer.
function wrapSyntheticFitPayload(payload: Uint8Array): Uint8Array {
  const headerSize = 12
  const dataSize = payload.length
  const output = new Uint8Array(headerSize + dataSize + 2)
  output[0] = headerSize
  output[1] = 0x20 // Protocol version 2.0
  output[2] = 0x55 // Profile version LSB
  output[3] = 0x08 // Profile version MSB
  output[4] = dataSize & 0xFF
  output[5] = (dataSize >>> 8) & 0xFF
  output[6] = (dataSize >>> 16) & 0xFF
  output[7] = (dataSize >>> 24) & 0xFF
  output[8] = 0x2E // '.'
  output[9] = 0x46 // 'F'
  output[10] = 0x49 // 'I'
  output[11] = 0x54 // 'T'
  output.set(payload, headerSize)
  return output
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

export interface FakeFormatCallRecord {
  readonly buildFit: Array<{
    readonly activity: Activity
    readonly flybyPoints: readonly FlybyPoint[]
    readonly options?: FitBuildOptions
  }>
  readonly buildTcx: Array<{
    readonly activity: Activity
    readonly flybyPoints: readonly FlybyPoint[]
  }>
  readonly buildGpx: Array<{
    readonly activity: Activity
    readonly flybyPoints: readonly FlybyPoint[]
  }>
  readonly adaptFit: Array<{
    readonly fitData: Uint8Array
    readonly options: FitAdaptOptions
  }>
  readonly parseTrack: Array<{
    readonly data: Uint8Array | string
    readonly options?: ParseTrackOptions
  }>
  readonly injectGpxSummaryExtensions: Array<{
    readonly gpxData: Uint8Array | string
    readonly summary: GpxSummaryExtensions
  }>
}

export interface FakeActivityFormatPortOptions {
  readonly isFitFile?: ActivityFormatPort['isFitFile']
  readonly buildFit?: ActivityFormatPort['buildFit']
  readonly buildTcx?: ActivityFormatPort['buildTcx']
  readonly buildGpx?: ActivityFormatPort['buildGpx']
  readonly adaptFit?: ActivityFormatPort['adaptFit']
  readonly parseTrack?: ActivityFormatPort['parseTrack']
  readonly injectGpxSummaryExtensions?: ActivityFormatPort['injectGpxSummaryExtensions']
  readonly defaultParsedTrack?: ParsedTrack
}

/**
 * Configurable in-memory `ActivityFormatPort` test double with call recording
 * for unit testing Garmin, SVG, and CLI modules without binary FIT/XML dependencies.
 */
export class FakeActivityFormatPort implements ActivityFormatPort {
  readonly calls: FakeFormatCallRecord = {
    buildFit: [],
    buildTcx: [],
    buildGpx: [],
    adaptFit: [],
    parseTrack: [],
    injectGpxSummaryExtensions: [],
  }

  private readonly options: FakeActivityFormatPortOptions

  constructor(options: FakeActivityFormatPortOptions = {}) {
    this.options = options
  }

  reset(): void {
    this.calls.buildFit.length = 0
    this.calls.buildTcx.length = 0
    this.calls.buildGpx.length = 0
    this.calls.adaptFit.length = 0
    this.calls.parseTrack.length = 0
    this.calls.injectGpxSummaryExtensions.length = 0
  }

  isFitFile(data: Uint8Array): boolean {
    if (this.options.isFitFile) {
      return this.options.isFitFile(data)
    }
    const headerSize = data[0]
    return (
      data.length >= 12
      && (headerSize === 12 || headerSize === 14)
      && data[8] === 0x2E
      && data[9] === 0x46
      && data[10] === 0x49
      && data[11] === 0x54
    )
  }

  buildFit(activity: Activity, flybyPoints: readonly FlybyPoint[], options?: FitBuildOptions): Uint8Array {
    this.calls.buildFit.push({ activity, flybyPoints, options })
    if (this.options.buildFit) {
      return this.options.buildFit(activity, flybyPoints, options)
    }
    const payload = textEncoder.encode(
      JSON.stringify({
        run_id: activity.run_id,
        type: activity.type,
        distance: activity.distance,
        pointCount: flybyPoints.length,
        options: options ?? null,
      }),
    )
    return wrapSyntheticFitPayload(payload)
  }

  buildTcx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
    this.calls.buildTcx.push({ activity, flybyPoints })
    if (this.options.buildTcx) {
      return this.options.buildTcx(activity, flybyPoints)
    }
    const trackpoints = flybyPoints
      .filter(point => point.lat !== null && point.lng !== null)
      .map(
        point =>
          `<Trackpoint><Position><LatitudeDegrees>${point.lat}</LatitudeDegrees><LongitudeDegrees>${point.lng}</LongitudeDegrees></Position></Trackpoint>`,
      )
      .join('')
    return `<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase><Activities><Activity Sport="${escapeXml(activity.type)}"><Id>${escapeXml(activity.start_date)}</Id><Lap StartTime="${escapeXml(activity.start_date)}"><DistanceMeters>${activity.distance}</DistanceMeters><Track>${trackpoints}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`
  }

  buildGpx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
    this.calls.buildGpx.push({ activity, flybyPoints })
    if (this.options.buildGpx) {
      return this.options.buildGpx(activity, flybyPoints)
    }
    const trackpoints = flybyPoints
      .filter(point => point.lat !== null && point.lng !== null)
      .map(point => `<trkpt lat="${point.lat}" lon="${point.lng}"></trkpt>`)
      .join('')
    return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="running-data-sync"><trk><name>${escapeXml(activity.name)}</name><trkseg>${trackpoints}</trkseg></trk></gpx>`
  }

  adaptFit(fitData: Uint8Array, options: FitAdaptOptions): Uint8Array {
    this.calls.adaptFit.push({ fitData, options })
    if (this.options.adaptFit) {
      return this.options.adaptFit(fitData, options)
    }
    if (!this.isFitFile(fitData)) {
      throw new ParseError('Input data is not a valid FIT payload')
    }
    if (!options.useFakeGarminDevice && !options.fixHeartRate) {
      return new Uint8Array(fitData)
    }
    const headerSize = fitData[0]
    const bodyEnd = fitData.length >= headerSize + 2 ? fitData.length - 2 : fitData.length
    const existingBody = fitData.subarray(headerSize, bodyEnd)
    const marker = textEncoder.encode(`|adapted:${JSON.stringify(options)}`)
    const combinedBody = new Uint8Array(existingBody.length + marker.length)
    combinedBody.set(existingBody, 0)
    combinedBody.set(marker, existingBody.length)
    return wrapSyntheticFitPayload(combinedBody)
  }

  async parseTrack(data: Uint8Array | string, options?: ParseTrackOptions): Promise<ParsedTrack> {
    this.calls.parseTrack.push({ data, options })
    if (this.options.parseTrack) {
      return this.options.parseTrack(data, options)
    }
    if (this.options.defaultParsedTrack) {
      return {
        ...this.options.defaultParsedTrack,
        ...(options?.fileName ? { fileName: options.fileName } : {}),
      }
    }
    return createParsedTrackFixture(options?.fileName ? { fileName: options.fileName } : {})
  }

  injectGpxSummaryExtensions(gpxData: Uint8Array | string, summary: GpxSummaryExtensions): string {
    this.calls.injectGpxSummaryExtensions.push({ gpxData, summary })
    if (this.options.injectGpxSummaryExtensions) {
      return this.options.injectGpxSummaryExtensions(gpxData, summary)
    }
    const xml = typeof gpxData === 'string' ? gpxData : textDecoder.decode(gpxData)
    const fields: Array<[string, number | null | undefined]> = [
      ['distance', summary.distance],
      ['average_hr', summary.averageHr],
      ['average_speed', summary.averageSpeed],
    ]
    const tags = fields
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => `<${name}>${value}</${name}>`)
      .join('')
    if (!tags) {
      return xml
    }
    const extensionsXml = `<extensions>${tags}</extensions>`
    const openGpxMatch = /<gpx\b[^>]*>/i.exec(xml)
    if (!openGpxMatch) {
      throw new ParseError('Invalid GPX payload: missing <gpx> root element')
    }
    const insertIndex = openGpxMatch.index + openGpxMatch[0].length
    return `${xml.slice(0, insertIndex)}${extensionsXml}${xml.slice(insertIndex)}`
  }
}
