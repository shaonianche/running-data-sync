import type { DuckDBConnection } from '@duckdb/node-api'
import type { Logger } from '../foundation/logger.js'
import { StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'
import { withTransaction } from './connection.js'

/**
 * Canonical schema for the `activities` table (14 columns, PK `run_id`).
 * Aligned 1-to-1 with Python `scripts/generator/db.py`.
 */
export const ACTIVITIES_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  run_id: 'BIGINT PRIMARY KEY',
  name: 'VARCHAR',
  distance: 'DOUBLE',
  moving_time: 'BIGINT',
  elapsed_time: 'BIGINT',
  type: 'VARCHAR',
  subtype: 'VARCHAR',
  start_date: 'TIMESTAMP',
  start_date_local: 'TIMESTAMP',
  location_country: 'VARCHAR',
  summary_polyline: 'VARCHAR',
  average_heartrate: 'DOUBLE',
  average_speed: 'DOUBLE',
  elevation_gain: 'DOUBLE',
})

/**
 * Canonical schema for the `activities_flyby` table (10 columns, composite PK `(activity_id, time_offset)`).
 * Aligned 1-to-1 with Python `scripts/generator/db.py`.
 */
export const ACTIVITIES_FLYBY_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  activity_id: 'BIGINT NOT NULL',
  time_offset: 'INTEGER NOT NULL',
  lat: 'DECIMAL(9, 6)',
  lng: 'DECIMAL(9, 6)',
  alt: 'SMALLINT',
  pace: 'DECIMAL(5, 2) NOT NULL DEFAULT 0.0',
  hr: 'SMALLINT',
  distance: 'INTEGER',
  cadence: 'SMALLINT',
  watts: 'SMALLINT',
})

/**
 * Canonical schema for the `activities_flyby_queue` table (4 columns, PK `activity_id`).
 */
export const FLYBY_QUEUE_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  activity_id: 'BIGINT PRIMARY KEY',
  status: 'VARCHAR',
  last_error: 'VARCHAR',
  updated_at: 'TIMESTAMP',
})

/**
 * Canonical schema for the `vendor_activity_sync` table (12 columns, composite PK `(activity_id, vendor, account)`).
 * Aligned 1-to-1 with Python `scripts/strava_cli_core/store.py`.
 */
export const VENDOR_ACTIVITY_SYNC_SCHEMA: Readonly<Record<string, string>> = Object.freeze({
  activity_id: 'BIGINT NOT NULL',
  vendor: 'VARCHAR NOT NULL',
  account: 'VARCHAR NOT NULL',
  status: 'VARCHAR NOT NULL',
  remote_activity_id: 'BIGINT',
  content_hash: 'VARCHAR',
  last_error: 'VARCHAR',
  attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  next_retry_at: 'TIMESTAMP',
  uploaded_at: 'TIMESTAMP',
  last_verified_at: 'TIMESTAMP',
  updated_at: 'TIMESTAMP NOT NULL DEFAULT NOW()',
})

export const ACTIVITIES_COLUMNS: readonly string[] = Object.freeze(Object.keys(ACTIVITIES_SCHEMA))
export const ACTIVITIES_FLYBY_COLUMNS: readonly string[] = Object.freeze(Object.keys(ACTIVITIES_FLYBY_SCHEMA))
export const FLYBY_QUEUE_COLUMNS: readonly string[] = Object.freeze(Object.keys(FLYBY_QUEUE_SCHEMA))
export const VENDOR_ACTIVITY_SYNC_COLUMNS: readonly string[] = Object.freeze(Object.keys(VENDOR_ACTIVITY_SYNC_SCHEMA))

interface TableColumnInfo {
  readonly name: string
  readonly pk: boolean
}

export async function tableExists(connection: DuckDBConnection, tableName: string): Promise<boolean> {
  const result = await connection.runAndReadAll(
    `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_catalog = current_catalog() AND table_schema = current_schema() AND table_name = ?`,
    [tableName],
  )
  const rows = result.getRowObjects()
  return Number(rows[0]?.cnt ?? 0) > 0
}

async function getTableColumns(connection: DuckDBConnection, tableName: string): Promise<TableColumnInfo[]> {
  const result = await connection.runAndReadAll(`PRAGMA table_info('${tableName}')`)
  return result.getRowObjects().map(row => ({
    name: String(row.name),
    pk: Boolean(row.pk),
  }))
}

async function createTableFromSchema(
  connection: DuckDBConnection,
  tableName: string,
  schema: Readonly<Record<string, string>>,
  extraConstraints?: string,
): Promise<void> {
  const columnsDef = Object.entries(schema)
    .map(([col, dtype]) => `${col} ${dtype}`)
    .join(', ')
  const suffix = extraConstraints ? `, ${extraConstraints}` : ''
  await connection.run(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnsDef}${suffix});`)
}

export async function createActivitiesTable(connection: DuckDBConnection): Promise<void> {
  await createTableFromSchema(connection, 'activities', ACTIVITIES_SCHEMA)
}

export async function createActivitiesFlybyTable(connection: DuckDBConnection): Promise<void> {
  await createTableFromSchema(
    connection,
    'activities_flyby',
    ACTIVITIES_FLYBY_SCHEMA,
    'PRIMARY KEY (activity_id, time_offset), FOREIGN KEY (activity_id) REFERENCES activities(run_id)',
  )
}

export async function createFlybyQueueTable(connection: DuckDBConnection): Promise<void> {
  await createTableFromSchema(connection, 'activities_flyby_queue', FLYBY_QUEUE_SCHEMA)
}

export async function createVendorSyncTable(connection: DuckDBConnection): Promise<void> {
  await createTableFromSchema(
    connection,
    'vendor_activity_sync',
    VENDOR_ACTIVITY_SYNC_SCHEMA,
    'PRIMARY KEY (activity_id, vendor, account)',
  )
}

async function addMissingColumns(
  connection: DuckDBConnection,
  tableName: string,
  schema: Readonly<Record<string, string>>,
  logger: Logger,
): Promise<string[]> {
  if (!(await tableExists(connection, tableName))) {
    return []
  }

  const existingCols = await getTableColumns(connection, tableName)
  const existingNames = new Set(existingCols.map(c => c.name))
  const added: string[] = []

  for (const [colName, colType] of Object.entries(schema)) {
    if (!existingNames.has(colName)) {
      await connection.run(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`)
      added.push(colName)
    }
  }

  if (added.length > 0) {
    logger.info(`Added missing columns to '${tableName}': ${added.join(', ')}`)
  }
  return added
}

/**
 * Adds any missing canonical columns to existing storage tables via `ALTER TABLE`.
 */
export async function migrateSchema(
  connection: DuckDBConnection,
  logger: Logger = createLogger('storage.schema'),
): Promise<void> {
  await addMissingColumns(connection, 'activities', ACTIVITIES_SCHEMA, logger)
  await addMissingColumns(connection, 'activities_flyby', ACTIVITIES_FLYBY_SCHEMA, logger)
  await addMissingColumns(connection, 'activities_flyby_queue', FLYBY_QUEUE_SCHEMA, logger)
  await addMissingColumns(connection, 'vendor_activity_sync', VENDOR_ACTIVITY_SYNC_SCHEMA, logger)
}

/**
 * Ensures `activities` has PK `run_id` and `activities_flyby` has composite PK `(activity_id, time_offset)`.
 * Recreates tables in a transaction while preserving data when PK constraints are missing.
 */
export async function ensurePrimaryKeys(
  connection: DuckDBConnection,
  logger: Logger = createLogger('storage.schema'),
): Promise<void> {
  try {
    if (await tableExists(connection, 'activities')) {
      const cols = await getTableColumns(connection, 'activities')
      const runIdCol = cols.find(c => c.name === 'run_id')
      if (!runIdCol?.pk) {
        logger.info(`Migrating 'activities' table to add Primary Key constraint...`)
        await withTransaction(connection, async (tx) => {
          await tx.run('ALTER TABLE activities RENAME TO activities_old')
          await createActivitiesTable(tx)
          const oldNames = new Set(cols.map(c => c.name))
          const commonCols = ACTIVITIES_COLUMNS.filter(c => oldNames.has(c))
          const colsSql = commonCols.join(', ')
          await tx.run(`INSERT INTO activities (${colsSql}) SELECT ${colsSql} FROM activities_old`)
          await tx.run('DROP TABLE activities_old')
        })
      }
    }

    if (await tableExists(connection, 'activities_flyby')) {
      const cols = await getTableColumns(connection, 'activities_flyby')
      const pkNames = new Set(cols.filter(c => c.pk).map(c => c.name))
      if (!pkNames.has('activity_id') || !pkNames.has('time_offset')) {
        logger.info(`Migrating 'activities_flyby' table to add composite Primary Key constraint...`)
        await withTransaction(connection, async (tx) => {
          await tx.run('ALTER TABLE activities_flyby RENAME TO activities_flyby_old')
          await createActivitiesFlybyTable(tx)
          const oldNames = new Set(cols.map(c => c.name))
          const commonCols = ACTIVITIES_FLYBY_COLUMNS.filter(c => oldNames.has(c))
          const colsSql = commonCols.join(', ')
          await tx.run(`INSERT INTO activities_flyby (${colsSql}) SELECT ${colsSql} FROM activities_flyby_old`)
          await tx.run('DROP TABLE activities_flyby_old')
        })
      }
    }
  }
  catch (error) {
    throw new StorageError(
      `Failed to verify or migrate primary key constraints: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/**
 * Ensures all 4 canonical tables exist and have up-to-date columns and primary keys.
 */
export async function ensureStorageSchema(
  connection: DuckDBConnection,
  logger: Logger = createLogger('storage.schema'),
): Promise<void> {
  await migrateSchema(connection, logger)
  await ensurePrimaryKeys(connection, logger)
  await createActivitiesTable(connection)
  await createActivitiesFlybyTable(connection)
  await createFlybyQueueTable(connection)
  await createVendorSyncTable(connection)
}
