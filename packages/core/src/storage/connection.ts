import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import type { LoadEnvConfigOptions } from '../foundation/config.js'
import fs from 'node:fs'
import path from 'node:path'
import { DuckDBDecimalValue, DuckDBInstance as DuckDBInstanceClass, DuckDBTimestampValue } from '@duckdb/node-api'
import { loadEnvConfig, resolveRuntimeConfig } from '../foundation/config.js'
import { StorageError } from '../foundation/errors.js'

const IDENTIFIER_PATTERN = /^[A-Z_]\w*$/i

export interface DuckDBConnectionOptions {
  /** Path to DuckDB database file, or `:memory:` for an in-memory DB. Defaults to `resolveRuntimeConfig().sqlFile`. */
  readonly dbPath?: string
  /** Open database in read-only mode. Defaults to `false`. */
  readonly readOnly?: boolean
  /**
   * Explicit encryption key for DuckDB encrypted databases.
   * - Non-empty string: attach using this key.
   * - `null` or `''`: explicitly open unencrypted (skip `.env.local` / `process.env` lookup).
   * - `undefined`: automatically resolve `DUCKDB_ENCRYPTION_KEY` via `loadEnvConfig(envOptions)` for file-backed DBs.
   */
  readonly encryptionKey?: string | null
  /** Optional overrides when resolving `DUCKDB_ENCRYPTION_KEY` from `.env.local` / environment variables. */
  readonly envOptions?: LoadEnvConfigOptions
}

export interface DuckDBHandle {
  readonly dbPath: string
  readonly readOnly: boolean
  readonly encrypted: boolean
  readonly instance: DuckDBInstance
  readonly connection: DuckDBConnection
  close: () => Promise<void>
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, '\'\'')
}

export function assertValidIdentifier(identifier: string, label = 'SQL identifier'): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new StorageError(`Invalid ${label}: "${identifier}"`)
  }
  return identifier
}

export function resolveEncryptionKey(
  options: Pick<DuckDBConnectionOptions, 'dbPath' | 'encryptionKey' | 'envOptions'> = {},
): string | undefined {
  if (options.dbPath === ':memory:') {
    return undefined
  }
  if (options.encryptionKey === null) {
    return undefined
  }
  if (typeof options.encryptionKey === 'string') {
    const trimmed = options.encryptionKey.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return loadEnvConfig(options.envOptions).duckdbEncryptionKey
}

function sanitizeErrorMessage(error: unknown, secret?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (!secret) {
    return raw
  }
  return raw.split(secret).join('***')
}

export async function openDuckDBConnection(options: DuckDBConnectionOptions = {}): Promise<DuckDBHandle> {
  const dbPath = options.dbPath ?? resolveRuntimeConfig().sqlFile
  const readOnly = options.readOnly ?? false
  const isMemory = dbPath === ':memory:'
  const encryptionKey = resolveEncryptionKey({
    dbPath,
    encryptionKey: options.encryptionKey,
    envOptions: options.envOptions,
  })

  if (!isMemory && !readOnly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }

  let instance: DuckDBInstance | null = null
  let connection: DuckDBConnection | null = null

  try {
    if (encryptionKey) {
      instance = await DuckDBInstanceClass.create(':memory:')
      connection = await instance.connect()
      const readOnlyFlag = readOnly ? 'TRUE' : 'FALSE'
      const escapedPath = escapeSqlString(dbPath)
      const escapedKey = escapeSqlString(encryptionKey)
      await connection.run(
        `ATTACH '${escapedPath}' AS main_db (TYPE DUCKDB, READ_ONLY ${readOnlyFlag}, ENCRYPTION_KEY '${escapedKey}')`,
      )
      await connection.run('USE main_db')
    }
    else if (isMemory) {
      instance = await DuckDBInstanceClass.create(':memory:')
      connection = await instance.connect()
    }
    else {
      const config = readOnly ? { access_mode: 'READ_ONLY' } : undefined
      instance = await DuckDBInstanceClass.create(dbPath, config)
      connection = await instance.connect()
    }
  }
  catch (error) {
    if (connection) {
      try {
        connection.closeSync()
      }
      catch {
        // Ignore cleanup failure when open fails.
      }
    }
    if (instance) {
      try {
        instance.closeSync()
      }
      catch {
        // Ignore cleanup failure when open fails.
      }
    }
    const detail = sanitizeErrorMessage(error, encryptionKey)
    const context = encryptionKey
      ? `Failed to open encrypted DuckDB database "${dbPath}": ${detail}`
      : `Failed to open DuckDB database "${dbPath}": ${detail}`
    throw new StorageError(context, { cause: error })
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    try {
      connection?.closeSync()
    }
    finally {
      instance?.closeSync()
    }
  }

  return {
    dbPath,
    readOnly,
    encrypted: Boolean(encryptionKey),
    instance,
    connection,
    close,
  }
}

export async function withTransaction<T>(
  connection: DuckDBConnection,
  work: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  await connection.run('BEGIN TRANSACTION')
  try {
    const result = await work(connection)
    await connection.run('COMMIT')
    return result
  }
  catch (error) {
    try {
      await connection.run('ROLLBACK')
    }
    catch {
      // Ignore rollback error if transaction is already aborted.
    }
    throw error
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

function pad6(value: number): string {
  return String(value).padStart(6, '0')
}

/**
 * Format a DuckDB `TIMESTAMP` value (timezone-naive microseconds since Unix epoch)
 * into Python `datetime.isoformat()` format: `YYYY-MM-DDTHH:MM:SS` (with `.ffffff` only when sub-second micros != 0).
 */
export function formatDuckDBTimestamp(value: unknown, separator: 'T' | ' ' = 'T'): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof DuckDBTimestampValue) {
    const micros = value.micros
    // Floor division so negative timestamps (before 1970) keep sub-second remainder in [0, 999999].
    let wholeSeconds = micros / 1_000_000n
    let remMicros = micros % 1_000_000n
    if (remMicros < 0n) {
      remMicros += 1_000_000n
      wholeSeconds -= 1n
    }
    const date = new Date(Number(wholeSeconds) * 1000)
    const base = `${pad4(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}${separator}${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
    return remMicros === 0n ? base : `${base}.${pad6(Number(remMicros))}`
  }
  if (value instanceof Date) {
    const ms = value.getUTCMilliseconds()
    const base = `${pad4(value.getUTCFullYear())}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}${separator}${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`
    return ms === 0 ? base : `${base}.${pad6(ms * 1000)}`
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    return separator === 'T' ? trimmed.replace(' ', 'T') : trimmed.replace('T', ' ')
  }
  return String(value)
}

/**
 * Normalize an incoming JS timestamp (`string | Date | null | undefined`) for DuckDB `TIMESTAMP` parameter binding.
 */
export function toTimestampSqlParam(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    return formatDuckDBTimestamp(value, 'T')
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  if (value instanceof DuckDBDecimalValue) {
    return Number(value.toString())
  }
  const parsed = Number(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function toNumber(value: unknown, fallback = 0): number {
  return toNullableNumber(value) ?? fallback
}

export function toNullableInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Math.trunc(value)
}
