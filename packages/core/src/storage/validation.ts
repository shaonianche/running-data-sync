import type { DuckDBConnection } from '@duckdb/node-api'
import type { Logger } from '../foundation/logger.js'
import fs from 'node:fs'
import path from 'node:path'
import { resolveRuntimeConfig } from '../foundation/config.js'
import { StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'
import {
  escapeSqlString,
  formatDuckDBTimestamp,
  openDuckDBConnection,
  toNumber,
} from './connection.js'

export interface ConsistencySourceStats {
  readonly count: number
  readonly maxStartDateLocal: string | null
}

export interface DataConsistencyReport {
  readonly ok: true
  readonly db: ConsistencySourceStats
  readonly parquet: ConsistencySourceStats
  readonly json: ConsistencySourceStats
}

export interface ValidateDataConsistencyOptions {
  /** Path to DuckDB database file. Defaults to `resolveRuntimeConfig().sqlFile`. Ignored when `connection` is provided. */
  readonly dbPath?: string
  /** Optional pre-opened DuckDB connection. Caller retains ownership. */
  readonly connection?: DuckDBConnection
  /** Path to `activities.parquet`. Defaults to `${resolveRuntimeConfig().dbDir}/activities.parquet`. */
  readonly parquetPath?: string
  /** Path to `activities.json`. Defaults to `resolveRuntimeConfig().jsonFile`. */
  readonly jsonPath?: string
  readonly logger?: Logger
}

function normalizeComparisonTimestamp(value: unknown): string | null {
  return formatDuckDBTimestamp(value, ' ')
}

function readJsonStats(jsonPath: string): ConsistencySourceStats {
  let parsed: unknown
  try {
    const content = fs.readFileSync(jsonPath, 'utf8')
    parsed = JSON.parse(content)
  }
  catch (error) {
    throw new StorageError(
      `Failed to read or parse JSON file "${jsonPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  if (!Array.isArray(parsed)) {
    throw new StorageError(`Expected JSON array in "${jsonPath}"`)
  }

  let maxStartDateLocal: string | null = null
  for (const item of parsed) {
    if (item && typeof item === 'object' && 'start_date_local' in item) {
      const candidate = normalizeComparisonTimestamp((item as Record<string, unknown>).start_date_local)
      if (candidate !== null && (maxStartDateLocal === null || candidate > maxStartDateLocal)) {
        maxStartDateLocal = candidate
      }
    }
  }

  return {
    count: parsed.length,
    maxStartDateLocal,
  }
}

async function readDbStats(connection: DuckDBConnection): Promise<ConsistencySourceStats> {
  const result = await connection.runAndReadAll(
    'SELECT COUNT(*) AS cnt, MAX(start_date_local) AS max_ts FROM activities',
  )
  const row = result.getRowObjects()[0]
  return {
    count: toNumber(row?.cnt, 0),
    maxStartDateLocal: normalizeComparisonTimestamp(row?.max_ts),
  }
}

async function readParquetStats(parquetPath: string): Promise<ConsistencySourceStats> {
  const handle = await openDuckDBConnection({ dbPath: ':memory:' })
  try {
    const escapedPath = escapeSqlString(parquetPath)
    const result = await handle.connection.runAndReadAll(
      `SELECT COUNT(*) AS cnt, MAX(start_date_local) AS max_ts FROM read_parquet('${escapedPath}')`,
    )
    const row = result.getRowObjects()[0]
    return {
      count: toNumber(row?.cnt, 0),
      maxStartDateLocal: normalizeComparisonTimestamp(row?.max_ts),
    }
  }
  finally {
    await handle.close()
  }
}

/**
 * Validates 3-way consistency across DuckDB (`activities`), `activities.parquet`, and `activities.json`,
 * comparing record counts and max `start_date_local`.
 *
 * Mirrors `scripts/validate_data_consistency.py`.
 */
export async function validateDataConsistency(
  options: ValidateDataConsistencyOptions = {},
): Promise<DataConsistencyReport> {
  const logger = options.logger ?? createLogger('storage.validation')
  const runtime = resolveRuntimeConfig()
  const parquetPath = path.resolve(options.parquetPath ?? path.join(runtime.dbDir, 'activities.parquet'))
  const jsonPath = path.resolve(options.jsonPath ?? runtime.jsonFile)

  if (!fs.existsSync(parquetPath)) {
    throw new StorageError(`Parquet file not found: ${parquetPath}`)
  }
  if (!fs.existsSync(jsonPath)) {
    throw new StorageError(`JSON file not found: ${jsonPath}`)
  }

  let dbStats: ConsistencySourceStats
  if (options.connection) {
    dbStats = await readDbStats(options.connection)
  }
  else {
    const dbPath = options.dbPath ?? runtime.sqlFile
    const handle = await openDuckDBConnection({
      dbPath,
      readOnly: true,
    })
    try {
      dbStats = await readDbStats(handle.connection)
    }
    finally {
      await handle.close()
    }
  }

  const parquetStats = await readParquetStats(parquetPath)
  const jsonStats = readJsonStats(jsonPath)

  const errors: string[] = []
  if (dbStats.count !== parquetStats.count || dbStats.count !== jsonStats.count) {
    errors.push(
      `count mismatch: db=${dbStats.count}, parquet=${parquetStats.count}, json=${jsonStats.count}`,
    )
  }

  if (
    dbStats.maxStartDateLocal !== parquetStats.maxStartDateLocal
    || dbStats.maxStartDateLocal !== jsonStats.maxStartDateLocal
  ) {
    errors.push(
      `max start_date_local mismatch: db=${dbStats.maxStartDateLocal}, parquet=${parquetStats.maxStartDateLocal}, json=${jsonStats.maxStartDateLocal}`,
    )
  }

  if (errors.length > 0) {
    throw new StorageError(`Consistency check failed: ${errors.join('; ')}`)
  }

  logger.info(
    `Consistency check passed: count=${dbStats.count}, max_start_date_local=${dbStats.maxStartDateLocal}`,
  )

  return {
    ok: true,
    db: dbStats,
    parquet: parquetStats,
    json: jsonStats,
  }
}
