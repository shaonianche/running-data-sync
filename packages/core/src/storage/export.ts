import type { DuckDBConnection } from '@duckdb/node-api'
import type { Logger } from '../foundation/logger.js'
import type { PolylinePrivacyOptions } from './polyline.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolveRuntimeConfig } from '../foundation/config.js'
import { StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'
import {
  assertValidIdentifier,
  escapeSqlString,
  formatDuckDBTimestamp,
  openDuckDBConnection,
  toNullableNumber,
  toNumber,
} from './connection.js'
import { filterPolyline } from './polyline.js'
import { tableExists } from './schema.js'

export const DEFAULT_PARQUET_TABLES = ['activities', 'activities_flyby'] as const

/**
 * Explicit allowlist of DuckDB tables that may be projected to public Parquet files.
 * Internal operational tables (e.g. `vendor_activity_sync`, `activities_flyby_queue`)
 * are private authoritative state and must not be exported to public web assets.
 */
export const PUBLIC_PARQUET_TABLES = ['activities', 'activities_flyby'] as const
export type PublicParquetTable = (typeof PUBLIC_PARQUET_TABLES)[number]

/**
 * Explicit contract distinguishing public web projections from private authoritative storage.
 *
 * Public web projections are derived, sanitized artifacts consumed by `apps/web`.
 * Private authoritative data (`data/data.duckdb`, raw `FIT`/`GPX`/`TCX`) remains off-limits
 * to public web publishing.
 */
export const PUBLIC_PROJECTION_BOUNDARY = Object.freeze({
  publicProjections: Object.freeze({
    activitiesJson: 'apps/web/src/static/activities.json',
    parquetDir: 'apps/web/public/db',
    parquetTables: PUBLIC_PARQUET_TABLES,
    svgAssetsDir: 'apps/web/public/assets',
  }),
  privateAuthoritative: Object.freeze({
    duckdb: 'data/data.duckdb',
    rawWorkoutFormats: Object.freeze(['fit', 'gpx', 'tcx'] as const),
    privateTables: Object.freeze(['vendor_activity_sync', 'activities_flyby_queue'] as const),
  }),
})

export function isPublicParquetTable(tableName: string): tableName is PublicParquetTable {
  return (PUBLIC_PARQUET_TABLES as readonly string[]).includes(tableName)
}

/**
 * Resolves the effective list of public Parquet tables to export.
 *
 * - Rejects non-allowlisted / private tables (e.g. `vendor_activity_sync`, `activities_flyby_queue`)
 *   when `allowNonPublicTables` is not explicitly enabled.
 * - Honors `includeFlyby` (defaults to `true` for compatibility until user decides;
 *   can also be toggled via `EXCLUDE_FLYBY_PARQUET` env flag).
 */
export function resolvePublicParquetTables(options: {
  readonly tables?: readonly string[]
  readonly includeFlyby?: boolean
  readonly allowNonPublicTables?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
} = {}): string[] {
  const env = options.env ?? process.env
  const includeFlyby = options.includeFlyby ?? !isTruthyEnvFlag(env.EXCLUDE_FLYBY_PARQUET)

  const requested = options.tables && options.tables.length > 0
    ? options.tables.map(t => assertValidIdentifier(t, 'table name'))
    : [...DEFAULT_PARQUET_TABLES]

  const deduplicated: string[] = []
  for (const table of requested) {
    if (!options.allowNonPublicTables && !isPublicParquetTable(table)) {
      throw new StorageError(
        `Table "${table}" is not an approved public Parquet projection. Allowed tables: ${PUBLIC_PARQUET_TABLES.join(', ')}.`,
      )
    }
    if (!includeFlyby && table === 'activities_flyby') {
      continue
    }
    if (!deduplicated.includes(table)) {
      deduplicated.push(table)
    }
  }

  return deduplicated
}

/**
 * Serialized activity shape written to `apps/web/src/static/activities.json`.
 * Preserves the exact 15-field schema emitted by Python's `Generator.load()` + `ActivityJSONEncoder`.
 */
export interface ActivityJsonRecord {
  run_id: number
  name: string
  distance: number | null
  moving_time: number | null
  elapsed_time: number | null
  type: string | null
  subtype: string | null
  start_date: string | null
  start_date_local: string | null
  location_country: string | null
  summary_polyline: string | null
  average_heartrate: number | null
  average_speed: number | null
  elevation_gain: number | null
  streak: number
}

export interface LoadActivitiesOptions {
  /** Path to DuckDB file. Defaults to `resolveRuntimeConfig().sqlFile`. Ignored when `connection` is provided. */
  readonly dbPath?: string
  /** Optional pre-opened DuckDB connection. Caller retains ownership. */
  readonly connection?: DuckDBConnection
  /** Restrict exported records to `type === 'Run'`. Defaults to `false`. */
  readonly onlyRun?: boolean
  /**
   * Whether to apply privacy polyline filtering (`filterPolyline`).
   * Defaults to `true` unless `IGNORE_BEFORE_SAVING` is truthy in env.
   */
  readonly applyPolylineFilter?: boolean
  /** Privacy polyline filtering options. */
  readonly polylineOptions?: PolylinePrivacyOptions
  readonly logger?: Logger
}

export interface ExportActivitiesJsonOptions extends LoadActivitiesOptions {
  /** Output JSON path. Defaults to `resolveRuntimeConfig().jsonFile` (`apps/web/src/static/activities.json`). */
  readonly outputPath?: string
}

export interface ExportActivitiesJsonResult {
  readonly outputPath: string
  readonly count: number
  readonly activities: readonly ActivityJsonRecord[]
}

export interface ExportParquetOptions {
  /** Path to DuckDB file. Defaults to `resolveRuntimeConfig().sqlFile`. Ignored when `connection` is provided. */
  readonly dbPath?: string
  /** Optional pre-opened DuckDB connection. Caller retains ownership. */
  readonly connection?: DuckDBConnection
  /** Tables to export. Defaults to `['activities', 'activities_flyby']` (subject to `includeFlyby`). */
  readonly tables?: readonly string[]
  /**
   * Whether to include `activities_flyby` in the Parquet export.
   * Defaults to `true` (unless `EXCLUDE_FLYBY_PARQUET` is truthy in env) to preserve current public scope.
   * Set to `false` to omit raw GPS flyby points from public Parquet exports.
   */
  readonly includeFlyby?: boolean
  /**
   * Whether to allow exporting non-public tables outside `PUBLIC_PARQUET_TABLES`.
   * Defaults to `false` to prevent accidentally publishing internal tables (e.g. `vendor_activity_sync`).
   */
  readonly allowNonPublicTables?: boolean
  /**
   * Whether to apply privacy polyline filtering (`filterPolyline`) to `activities.summary_polyline`
   * when exporting `activities.parquet`.
   * Defaults to `true` unless `IGNORE_BEFORE_SAVING` is truthy in env.
   */
  readonly applyPolylineFilter?: boolean
  /** Privacy polyline filtering options. */
  readonly polylineOptions?: PolylinePrivacyOptions
  /** Output directory for `.parquet` files. Defaults to `resolveRuntimeConfig().dbDir` (`apps/web/public/db`). */
  readonly outputDir?: string
  readonly logger?: Logger
}

export interface ExportParquetResult {
  readonly outputDir: string
  readonly exportedFiles: readonly string[]
  readonly skippedTables: readonly string[]
}

function sanitizeFiniteNumber(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  return value
}

function parseUtcDayNumber(isoTimestamp: string | null): number | null {
  if (!isoTimestamp) {
    return null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoTimestamp)
  if (!match) {
    return null
  }
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

/**
 * Recursively sanitizes non-JSON-compliant values (`NaN`, `Infinity`, `-Infinity`, `Date`)
 * matching Python's `ActivityJSONEncoder`.
 */
export function sanitizeForActivityJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatDuckDBTimestamp(value, 'T')
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForActivityJson(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForActivityJson(v)
    }
    return out
  }
  return value
}

/**
 * Serializes activity records into strict JSON (no `NaN`/`Infinity`, naive ISO timestamps).
 */
export function serializeActivitiesJson(activities: readonly ActivityJsonRecord[]): string {
  return JSON.stringify(sanitizeForActivityJson(activities))
}

/**
 * Computes running streaks matching Python `Generator.load()`:
 * consecutive calendar days increment streak; same-day subsequent activities or gaps reset streak to 1.
 */
export function computeActivityStreaks<T extends { start_date_local: string | null }>(
  activities: readonly T[],
): (T & { streak: number })[] {
  let prevDay: number | null = null
  let currentStreak = 0

  return activities.map((activity) => {
    const day = parseUtcDayNumber(activity.start_date_local)
    if (prevDay !== null && day !== null && day - prevDay === 1) {
      currentStreak += 1
    }
    else {
      currentStreak = 1
    }
    prevDay = day
    return {
      ...activity,
      streak: currentStreak,
    }
  })
}

async function loadFromConnection(
  connection: DuckDBConnection,
  options: LoadActivitiesOptions,
): Promise<ActivityJsonRecord[]> {
  if (!(await tableExists(connection, 'activities'))) {
    return []
  }

  const whereClause = options.onlyRun ? `WHERE type = 'Run'` : ''
  const result = await connection.runAndReadAll(
    `SELECT
      run_id, name, distance, moving_time, elapsed_time,
      type, subtype, start_date, start_date_local,
      location_country, summary_polyline,
      average_heartrate, average_speed, elevation_gain
    FROM activities
    ${whereClause}
    ORDER BY start_date_local ASC, run_id ASC`,
  )

  const env = options.polylineOptions?.env ?? process.env
  const shouldFilterPolyline = options.applyPolylineFilter ?? !isTruthyEnvFlag(env.IGNORE_BEFORE_SAVING)

  const baseRecords = result.getRowObjects().map((row) => {
    const rawPolyline = row.summary_polyline === null || row.summary_polyline === undefined
      ? null
      : String(row.summary_polyline)

    return {
      run_id: toNumber(row.run_id),
      name: row.name === null || row.name === undefined ? '' : String(row.name),
      distance: sanitizeFiniteNumber(toNullableNumber(row.distance)),
      moving_time: sanitizeFiniteNumber(toNullableNumber(row.moving_time)),
      elapsed_time: sanitizeFiniteNumber(toNullableNumber(row.elapsed_time)),
      type: row.type === null || row.type === undefined ? null : String(row.type),
      subtype: row.subtype === null || row.subtype === undefined ? null : String(row.subtype),
      start_date: formatDuckDBTimestamp(row.start_date, 'T'),
      start_date_local: formatDuckDBTimestamp(row.start_date_local, 'T'),
      location_country: row.location_country === null || row.location_country === undefined
        ? null
        : String(row.location_country),
      summary_polyline: shouldFilterPolyline
        ? filterPolyline(rawPolyline, options.polylineOptions)
        : rawPolyline,
      average_heartrate: sanitizeFiniteNumber(toNullableNumber(row.average_heartrate)),
      average_speed: sanitizeFiniteNumber(toNullableNumber(row.average_speed)),
      elevation_gain: sanitizeFiniteNumber(toNullableNumber(row.elevation_gain)),
    }
  })

  return computeActivityStreaks(baseRecords)
}

/**
 * Loads activities from DuckDB, sorted chronologically by `start_date_local`,
 * with running streaks calculated and optional privacy polyline filtering applied.
 */
export async function loadActivities(options: LoadActivitiesOptions = {}): Promise<ActivityJsonRecord[]> {
  const logger = options.logger ?? createLogger('storage.export')
  if (options.connection) {
    return loadFromConnection(options.connection, options)
  }

  const dbPath = options.dbPath ?? resolveRuntimeConfig().sqlFile
  if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) {
    logger.info(`Database file "${dbPath}" not found, returning empty list.`)
    return []
  }

  const handle = await openDuckDBConnection({
    dbPath,
    readOnly: true,
  })
  try {
    return await loadFromConnection(handle.connection, options)
  }
  finally {
    await handle.close()
  }
}

/**
 * Exports activities from DuckDB to `activities.json` (defaults to `apps/web/src/static/activities.json`).
 */
export async function exportActivitiesJson(
  options: ExportActivitiesJsonOptions = {},
): Promise<ExportActivitiesJsonResult> {
  const logger = options.logger ?? createLogger('storage.export')
  const outputPath = path.resolve(options.outputPath ?? resolveRuntimeConfig().jsonFile)
  const activities = await loadActivities(options)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tempPath, serializeActivitiesJson(activities), 'utf8')
    fs.renameSync(tempPath, outputPath)
  }
  catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true })
    }
    throw new StorageError(
      `Failed to write activities JSON to "${outputPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  logger.info(`Exported ${activities.length} activities to "${outputPath}".`)
  return {
    outputPath,
    count: activities.length,
    activities,
  }
}

async function exportSanitizedActivitiesParquet(
  connection: DuckDBConnection,
  escapedTempPath: string,
  options: ExportParquetOptions,
): Promise<void> {
  const result = await connection.runAndReadAll(
    'SELECT run_id, summary_polyline FROM activities WHERE summary_polyline IS NOT NULL',
  )
  const rows = result.getRowObjects()
  const filteredPairs: { runId: number, summaryPolyline: string | null }[] = []
  for (const row of rows) {
    const runId = toNumber(row.run_id)
    const rawPolyline = String(row.summary_polyline)
    const sanitized = filterPolyline(rawPolyline, options.polylineOptions)
    if (sanitized !== rawPolyline) {
      filteredPairs.push({ runId, summaryPolyline: sanitized })
    }
  }

  if (filteredPairs.length === 0) {
    await connection.run(`COPY (SELECT * FROM "activities") TO '${escapedTempPath}' (FORMAT PARQUET);`)
    return
  }

  const memHandle = await openDuckDBConnection({ dbPath: ':memory:' })
  try {
    const rawTempPath = `${escapedTempPath.replace(/''/g, '\'')}.raw`
    const escapedRawTempPath = escapeSqlString(rawTempPath)
    try {
      await connection.run(`COPY (SELECT * FROM "activities") TO '${escapedRawTempPath}' (FORMAT PARQUET);`)
      await memHandle.connection.run(
        `CREATE TABLE activities_sanitized AS SELECT * FROM read_parquet('${escapedRawTempPath}');`,
      )
      const stmt = await memHandle.connection.prepare(
        'UPDATE activities_sanitized SET summary_polyline = ? WHERE run_id = ?',
      )
      try {
        for (const pair of filteredPairs) {
          if (pair.summaryPolyline === null) {
            stmt.bindNull(1)
          }
          else {
            stmt.bindVarchar(1, pair.summaryPolyline)
          }
          stmt.bindBigInt(2, BigInt(pair.runId))
          await stmt.run()
        }
      }
      finally {
        stmt.destroySync()
      }
      await memHandle.connection.run(
        `COPY (SELECT * FROM activities_sanitized) TO '${escapedTempPath}' (FORMAT PARQUET);`,
      )
    }
    finally {
      if (fs.existsSync(rawTempPath)) {
        fs.rmSync(rawTempPath, { force: true })
      }
    }
  }
  finally {
    await memHandle.close()
  }
}

async function exportParquetFromConnection(
  connection: DuckDBConnection,
  tables: readonly string[],
  outputDir: string,
  options: ExportParquetOptions,
  logger: Logger,
): Promise<ExportParquetResult> {
  fs.mkdirSync(outputDir, { recursive: true })

  const env = options.polylineOptions?.env ?? process.env
  const shouldFilterPolyline = options.applyPolylineFilter ?? !isTruthyEnvFlag(env.IGNORE_BEFORE_SAVING)

  const exportedFiles: string[] = []
  const skippedTables: string[] = []

  for (const rawTable of tables) {
    const tableName = assertValidIdentifier(rawTable, 'table name')
    if (!(await tableExists(connection, tableName))) {
      logger.warn(`Table "${tableName}" does not exist in the database. Skipping.`)
      skippedTables.push(tableName)
      continue
    }

    const parquetPath = path.join(outputDir, `${tableName}.parquet`)
    const tempParquetPath = path.join(outputDir, `.${tableName}.parquet.tmp-${process.pid}-${Date.now()}`)
    const escapedTempPath = escapeSqlString(tempParquetPath)

    try {
      logger.info(`Exporting table "${tableName}" to "${parquetPath}"...`)
      if (tableName === 'activities' && shouldFilterPolyline) {
        await exportSanitizedActivitiesParquet(connection, escapedTempPath, options)
      }
      else {
        await connection.run(`COPY (SELECT * FROM "${tableName}") TO '${escapedTempPath}' (FORMAT PARQUET);`)
      }
      fs.renameSync(tempParquetPath, parquetPath)
      exportedFiles.push(parquetPath)
      logger.info(`Successfully exported "${tableName}".`)
    }
    catch (error) {
      if (fs.existsSync(tempParquetPath)) {
        fs.rmSync(tempParquetPath, { force: true })
      }
      throw new StorageError(
        `Failed to export table "${tableName}" to Parquet: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  return {
    outputDir,
    exportedFiles,
    skippedTables,
  }
}

/**
 * Exports DuckDB tables to Parquet files (defaults to `activities` and `activities_flyby`
 * under `apps/web/public/db`).
 *
 * Enforces the public projection boundary:
 * - Rejects non-public tables unless `allowNonPublicTables: true` is passed.
 * - Applies `filterPolyline` to `activities.summary_polyline` by default so Parquet
 *   matches `activities.json` privacy clipping.
 * - Supports omitting `activities_flyby` via `includeFlyby: false` or `EXCLUDE_FLYBY_PARQUET=1`.
 */
export async function exportParquet(options: ExportParquetOptions = {}): Promise<ExportParquetResult> {
  const logger = options.logger ?? createLogger('storage.export')
  const tables = resolvePublicParquetTables({
    tables: options.tables,
    includeFlyby: options.includeFlyby,
    allowNonPublicTables: options.allowNonPublicTables,
    env: options.polylineOptions?.env,
  })
  const outputDir = path.resolve(options.outputDir ?? resolveRuntimeConfig().dbDir)

  if (options.connection) {
    return exportParquetFromConnection(options.connection, tables, outputDir, options, logger)
  }

  const dbPath = options.dbPath ?? resolveRuntimeConfig().sqlFile
  const handle = await openDuckDBConnection({
    dbPath,
    readOnly: true,
  })
  try {
    return await exportParquetFromConnection(handle.connection, tables, outputDir, options, logger)
  }
  finally {
    await handle.close()
  }
}
