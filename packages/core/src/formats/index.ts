export {
  exportActivities,
} from './exporter.js'
export type {
  BatchExportResult,
  ExportActivitiesOptions,
  ExportActivityFailure,
  ExportedActivityFile,
} from './exporter.js'
export {
  adaptFit,
  isFitFile,
} from './fit-adaptor.js'
export {
  parseFitTrack,
} from './fit-decoder.js'
export {
  buildFit,
} from './fit-encoder.js'
export {
  calculateLapsFromRecords,
  calculateStrideLengthMeters,
  DEFAULT_AUTO_LAP_DISTANCE_METERS,
  DEFAULT_GARMIN_MANUFACTURER,
  DEFAULT_GARMIN_PRODUCT_ID,
  DEFAULT_GARMIN_SERIAL_NUMBER,
  DEFAULT_GARMIN_SOFTWARE_VERSION,
  degreesToSemicircles,
  mapFitSportToActivityType,
  mapStravaSportToFit,
  paceToSpeed,
  sanitizeFitActivityName,
  SEMICIRCLES_PER_DEGREE,
  semicirclesToDegrees,
} from './fit-mapping.js'
export type {
  ComputedFitLap,
  FitSportMapping,
  NormalizedFitRecord,
} from './fit-mapping.js'
export {
  createActivityFormatPort,
  GarminActivityFormatPort,
} from './format-port.js'
export {
  buildGpx,
  injectGpxSummaryExtensions,
  parseGpxTrack,
} from './gpx.js'
export {
  decodePolyline,
  encodePolyline,
} from './polyline.js'
export {
  buildTcx,
  parseTcxTrack,
} from './tcx.js'
export {
  computeElevationGain,
  formatLocalDateTime,
  formatUtcIso,
  haversineDistanceMeters,
  parseUtcDate,
  resolveLocalDateBounds,
} from './time-utils.js'
export {
  parseTrack,
} from './track-parser.js'
