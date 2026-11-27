export {
  assertValidIdentifier,
  type DuckDBConnectionOptions,
  type DuckDBHandle,
  escapeSqlString,
  formatDuckDBTimestamp,
  openDuckDBConnection,
  resolveEncryptionKey,
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
  encryptDatabase,
  type EncryptDatabaseOptions,
  type EncryptDatabaseResult,
  type EncryptDatabaseStatus,
} from './encryption.js'
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
