export {
  assertValidIdentifier,
  type DuckDBConnectionOptions,
  type DuckDBHandle,
  escapeSqlString,
  formatDuckDBTimestamp,
  openDuckDBConnection,
  toNullableInt,
  toNullableNumber,
  toNumber,
  toTimestampSqlParam,
  withTransaction,
} from './connection.js'
export {
  DuckDBActivityStore,
  type DuckDBActivityStoreOptions,
} from './duckdb-store.js'
export {
  type ActivityJsonRecord,
  computeActivityStreaks,
  DEFAULT_PARQUET_TABLES,
  exportActivitiesJson,
  type ExportActivitiesJsonOptions,
  type ExportActivitiesJsonResult,
  exportParquet,
  type ExportParquetOptions,
  type ExportParquetResult,
  loadActivities,
  type LoadActivitiesOptions,
  sanitizeForActivityJson,
  serializeActivitiesJson,
} from './export.js'
export {
  EARTH_RADIUS_KM,
  filterPolyline,
  haversineDistanceKm,
  hidePointsInRange,
  hideStartEndPoints,
  type LatLngPoint,
  type PolylinePrivacyOptions,
  type ResolvedPolylinePrivacyConfig,
  resolvePolylinePrivacyConfig,
} from './polyline.js'
export {
  buildR2Endpoint,
  R2ObjectStore,
  type R2ObjectStoreConfig,
  type S3LikeClient,
} from './r2-object-store.js'
export {
  ACTIVITIES_COLUMNS,
  ACTIVITIES_FLYBY_COLUMNS,
  ACTIVITIES_FLYBY_SCHEMA,
  ACTIVITIES_SCHEMA,
  createActivitiesFlybyTable,
  createActivitiesTable,
  createFlybyQueueTable,
  createVendorSyncTable,
  ensurePrimaryKeys,
  ensureStorageSchema,
  FLYBY_QUEUE_COLUMNS,
  FLYBY_QUEUE_SCHEMA,
  migrateSchema,
  tableExists,
  VENDOR_ACTIVITY_SYNC_COLUMNS,
  VENDOR_ACTIVITY_SYNC_SCHEMA,
} from './schema.js'
export {
  type ConsistencySourceStats,
  type DataConsistencyReport,
  validateDataConsistency,
  type ValidateDataConsistencyOptions,
} from './validation.js'
