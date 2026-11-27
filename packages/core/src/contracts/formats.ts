import type { Activity, FlybyPoint } from '../foundation/types.js'

/**
 * Supported activity export file formats.
 */
export type ActivityFileFormat = 'fit' | 'tcx' | 'gpx'

/**
 * Supported input formats for track parsing (includes `.zip`-wrapped FIT downloads).
 */
export type ParseableActivityFormat = ActivityFileFormat | 'zip'

/**
 * Normalized point extracted from a `.fit`, `.gpx`, or `.tcx` activity file.
 *
 * All numeric telemetry fields use standard physical / SI units (degrees, meters,
 * seconds, bpm, m/s, watts) matching official `@garmin/fitsdk` decoded output
 * without legacy `fit-tool` raw scaling offsets.
 */
export interface TrackPoint {
  readonly lat: number | null
  readonly lng: number | null
  readonly alt?: number | null
  readonly timestamp?: string | null
  readonly timeOffset?: number
  readonly hr?: number | null
  readonly cadence?: number | null
  readonly speed?: number | null
  readonly distance?: number | null
  readonly watts?: number | null
}

/**
 * Unified track summary and geometry decoded from `.fit`, `.zip`, `.gpx`, or `.tcx`.
 */
export interface ParsedTrack {
  readonly runId: number
  readonly name: string
  readonly type: string
  readonly subtype: string
  readonly startDate: string
  readonly endDate: string
  readonly startDateLocal: string
  readonly endDateLocal: string
  readonly distance: number
  readonly movingTime: number
  readonly elapsedTime: number
  readonly averageSpeed: number
  readonly averageHeartrate: number | null
  readonly elevationGain: number | null
  readonly summaryPolyline: string | null
  readonly startLatLng: readonly [number, number] | null
  readonly polylines: readonly (readonly (readonly [number, number])[])[]
  readonly points: readonly TrackPoint[]
  readonly device?: string
  readonly fileName?: string
}

/**
 * Garmin summary fields injected into or read from GPX root `<extensions>`.
 */
export interface GpxSummaryExtensions {
  readonly distance?: number | null
  readonly averageHr?: number | null
  readonly averageSpeed?: number | null
}

/**
 * Optional device metadata and lap settings when building a `.fit` binary.
 *
 * Device identifiers use standard FIT protocol profile values accepted by
 * `@garmin/fitsdk` `Encoder` (e.g. `manufacturer: 1` for Garmin, `productId: 3589`
 * for Forerunner 245, `softwareVersion: 5.5`).
 */
export interface FitBuildOptions {
  readonly manufacturer?: number
  readonly productId?: number
  readonly softwareVersion?: number
  readonly serialNumber?: number
  /** Distance interval in meters for auto-lap generation (default: 1000). */
  readonly autoLapDistanceMeters?: number
}

/**
 * Options for post-processing an existing `.fit` binary before Garmin upload
 * (implemented via `@garmin/fitsdk` `Decoder` + `Encoder` round-trip).
 */
export interface FitAdaptOptions {
  readonly useFakeGarminDevice?: boolean
  readonly fixHeartRate?: boolean
  readonly manufacturer?: number
  readonly productId?: number
  readonly softwareVersion?: number
  readonly serialNumber?: number
}

/**
 * Optional hints for parsing raw activity file bytes/text.
 */
export interface ParseTrackOptions {
  readonly format?: ParseableActivityFormat
  readonly fileName?: string
}

/**
 * Format encoding, decoding, and Garmin device adaptation port.
 *
 * Designed around standard `Uint8Array` / `string` payloads for `@garmin/fitsdk`
 * (`Encoder` / `Decoder`) and lightweight XML/ZIP implementations without tying
 * callers to any underlying encoder/decoder library.
 */
export interface ActivityFormatPort {
  /** Check whether `data` is a valid FIT binary payload (compatible with `@garmin/fitsdk` `Decoder.isFIT`). */
  isFitFile: (data: Uint8Array) => boolean
  /** Build a `.fit` binary from an `Activity` and its `FlybyPoint` series. */
  buildFit: (activity: Activity, flybyPoints: readonly FlybyPoint[], options?: FitBuildOptions) => Uint8Array
  /** Build a Training Center XML (`.tcx`) document from an `Activity` and its `FlybyPoint` series. */
  buildTcx: (activity: Activity, flybyPoints: readonly FlybyPoint[]) => string
  /** Build a GPS Exchange Format (`.gpx`) document from an `Activity` and its `FlybyPoint` series. */
  buildGpx: (activity: Activity, flybyPoints: readonly FlybyPoint[]) => string
  /** Adapt an existing `.fit` binary (e.g. inject fake Garmin device info and/or repair HR). */
  adaptFit: (fitData: Uint8Array, options: FitAdaptOptions) => Uint8Array
  /** Parse a `.fit`, `.zip` (containing `.fit`), `.gpx`, or `.tcx` payload into a `ParsedTrack`. */
  parseTrack: (data: Uint8Array | string, options?: ParseTrackOptions) => Promise<ParsedTrack>
  /** Inject Garmin summary metadata into a GPX document's root `<extensions>` element. */
  injectGpxSummaryExtensions: (gpxData: Uint8Array | string, summary: GpxSummaryExtensions) => string
}
