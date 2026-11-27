import type {
  ActivityFormatPort,
  FitAdaptOptions,
  FitBuildOptions,
  GpxSummaryExtensions,
  ParsedTrack,
  ParseTrackOptions,
} from '../contracts/formats.js'
import type { Activity, FlybyPoint } from '../foundation/types.js'
import { adaptFit, isFitFile } from './fit-adaptor.js'
import { buildFit } from './fit-encoder.js'
import { buildGpx, injectGpxSummaryExtensions } from './gpx.js'
import { buildTcx } from './tcx.js'
import { parseTrack } from './track-parser.js'

/**
 * Production implementation of `ActivityFormatPort` backed by official `@garmin/fitsdk`
 * (`Encoder` / `Decoder`), `fast-xml-parser`, and `fflate`.
 */
export class GarminActivityFormatPort implements ActivityFormatPort {
  isFitFile(data: Uint8Array): boolean {
    return isFitFile(data)
  }

  buildFit(activity: Activity, flybyPoints: readonly FlybyPoint[], options?: FitBuildOptions): Uint8Array {
    return buildFit(activity, flybyPoints, options)
  }

  buildTcx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
    return buildTcx(activity, flybyPoints)
  }

  buildGpx(activity: Activity, flybyPoints: readonly FlybyPoint[]): string {
    return buildGpx(activity, flybyPoints)
  }

  adaptFit(fitData: Uint8Array, options: FitAdaptOptions): Uint8Array {
    return adaptFit(fitData, options)
  }

  parseTrack(data: Uint8Array | string, options?: ParseTrackOptions): Promise<ParsedTrack> {
    return parseTrack(data, options)
  }

  injectGpxSummaryExtensions(gpxData: Uint8Array | string, summary: GpxSummaryExtensions): string {
    return injectGpxSummaryExtensions(gpxData, summary)
  }
}

export function createActivityFormatPort(): ActivityFormatPort {
  return new GarminActivityFormatPort()
}
