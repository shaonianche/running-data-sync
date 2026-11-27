import type { LoadEnvConfigOptions } from '../foundation/config.js'
import type { Logger } from '../foundation/logger.js'
import fs from 'node:fs'
import { DuckDBInstance } from '@duckdb/node-api'
import { loadEnvConfig, resolveRuntimeConfig } from '../foundation/config.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'
import { assertValidIdentifier, escapeSqlString, openDuckDBConnection } from './connection.js'

export interface EncryptDatabaseOptions {
  /** Path to the DuckDB database file. Defaults to `resolveRuntimeConfig().sqlFile`. */
  readonly dbPath?: string
  /** Encryption key. Defaults to `DUCKDB_ENCRYPTION_KEY` resolved via `loadEnvConfig(envOptions)`. */
  readonly encryptionKey?: string
  /** Optional `.env.local` / `process.env` options when resolving `DUCKDB_ENCRYPTION_KEY`. */
  readonly envOptions?: LoadEnvConfigOptions
  /** Backup path for the original unencrypted database. Defaults to `${dbPath}.bak`. */
  readonly backupPath?: string
  readonly logger?: Logger
}

export type EncryptDatabaseStatus = 'missing' | 'already_encrypted' | 'encrypted'

export interface EncryptDatabaseResult {
  readonly status: EncryptDatabaseStatus
  readonly dbPath: string
  readonly backupPath?: string
  readonly tablesCopied: readonly string[]
}

async function isReadableUnencrypted(dbPath: string): Promise<boolean> {
  try {
    const handle = await openDuckDBConnection({
      dbPath,
      readOnly: true,
      encryptionKey: null,
    })
    try {
      await handle.connection.run('SELECT 1')
      return true
    }
    finally {
      await handle.close()
    }
  }
  catch {
    return false
  }
}

async function isReadableWithKey(dbPath: string, key: string): Promise<boolean> {
  try {
    const handle = await openDuckDBConnection({
      dbPath,
      readOnly: true,
      encryptionKey: key,
    })
    try {
      await handle.connection.run('SELECT 1')
      return true
    }
    finally {
      await handle.close()
    }
  }
  catch {
    return false
  }
}

function sortTablesForForeignKeyCopy(
  tables: readonly string[],
  fkConstraints: readonly { tableName: string, constraintText: string }[],
): string[] {
  const tableSet = new Set(tables)
  const deps = new Map<string, Set<string>>()
  for (const table of tables) {
    deps.set(table, new Set())
  }

  for (const constraint of fkConstraints) {
    if (!tableSet.has(constraint.tableName)) {
      continue
    }
    const match = /REFERENCES\s+"?([A-Z_]\w*)"?/i.exec(constraint.constraintText)
    const referenced = match?.[1]
    if (referenced && tableSet.has(referenced) && referenced !== constraint.tableName) {
      deps.get(constraint.tableName)?.add(referenced)
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: string[] = []

  const visit = (table: string): void => {
    if (visited.has(table) || visiting.has(table)) {
      return
    }
    visiting.add(table)
    for (const parent of deps.get(table) ?? []) {
      visit(parent)
    }
    visiting.delete(table)
    visited.add(table)
    ordered.push(table)
  }

  for (const table of [...tables].sort()) {
    visit(table)
  }

  return ordered
}

function removeIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true })
  }
}

/**
 * Encrypts an unencrypted DuckDB database in-place (backing up the original to `${dbPath}.bak`).
 *
 * Mirrors `scripts/encrypt_db.py`, while preserving schema constraints (PK/FK/NOT NULL/DEFAULT)
 * via `COPY FROM DATABASE ... (SCHEMA)` and dependency-ordered table copy.
 */
export async function encryptDatabase(options: EncryptDatabaseOptions = {}): Promise<EncryptDatabaseResult> {
  const logger = options.logger ?? createLogger('storage.encryption')
  const dbPath = options.dbPath ?? resolveRuntimeConfig().sqlFile

  if (!fs.existsSync(dbPath)) {
    logger.info(`Database file ${dbPath} does not exist. No need to encrypt.`)
    return {
      status: 'missing',
      dbPath,
      tablesCopied: [],
    }
  }

  const key = options.encryptionKey?.trim() || loadEnvConfig(options.envOptions).duckdbEncryptionKey
  if (!key) {
    throw new ConfigurationError('No encryption key found. Provide encryptionKey or set DUCKDB_ENCRYPTION_KEY.')
  }

  const unencrypted = await isReadableUnencrypted(dbPath)
  if (!unencrypted) {
    const encryptedWithKey = await isReadableWithKey(dbPath, key)
    if (encryptedWithKey) {
      logger.info(`Database ${dbPath} is already encrypted with the provided key.`)
      return {
        status: 'already_encrypted',
        dbPath,
        tablesCopied: [],
      }
    }
    throw new StorageError(
      `Database "${dbPath}" could not be opened unencrypted or with the provided encryption key.`,
    )
  }

  const tempDbPath = `${dbPath}.new`
  const backupPath = options.backupPath ?? `${dbPath}.bak`
  removeIfExists(tempDbPath)
  removeIfExists(`${tempDbPath}.wal`)

  let instance: DuckDBInstance | null = null
  let connection: Awaited<ReturnType<DuckDBInstance['connect']>> | null = null
  let tablesCopied: string[] = []

  try {
    instance = await DuckDBInstance.create(':memory:')
    connection = await instance.connect()

    const escapedNewPath = escapeSqlString(tempDbPath)
    const escapedOldPath = escapeSqlString(dbPath)
    const escapedKey = escapeSqlString(key)

    await connection.run(
      `ATTACH '${escapedNewPath}' AS new_db (TYPE DUCKDB, ENCRYPTION_KEY '${escapedKey}')`,
    )
    await connection.run(
      `ATTACH '${escapedOldPath}' AS old_db (TYPE DUCKDB, READ_ONLY TRUE)`,
    )

    const tablesResult = await connection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_catalog = 'old_db' AND table_schema = 'main' AND table_type = 'BASE TABLE'`,
    )
    const rawTables = tablesResult.getRowObjects().map(row => assertValidIdentifier(String(row.table_name), 'table name'))

    const fkResult = await connection.runAndReadAll(
      `SELECT table_name, constraint_text FROM duckdb_constraints() WHERE database_name = 'old_db' AND schema_name = 'main' AND constraint_type = 'FOREIGN KEY'`,
    )
    const fkConstraints = fkResult.getRowObjects().map(row => ({
      tableName: String(row.table_name),
      constraintText: String(row.constraint_text),
    }))

    const orderedTables = sortTablesForForeignKeyCopy(rawTables, fkConstraints)

    if (orderedTables.length > 0) {
      await connection.run('COPY FROM DATABASE old_db TO new_db (SCHEMA)')
      for (const tableName of orderedTables) {
        logger.info(`Copying table '${tableName}' to encrypted database...`)
        await connection.run(`INSERT INTO new_db.main."${tableName}" SELECT * FROM old_db.main."${tableName}"`)
      }
    }

    tablesCopied = orderedTables
    await connection.run('DETACH new_db')
    await connection.run('DETACH old_db')
  }
  catch (error) {
    if (connection) {
      try {
        connection.closeSync()
      }
      catch {
        // Ignore cleanup failure.
      }
      connection = null
    }
    if (instance) {
      try {
        instance.closeSync()
      }
      catch {
        // Ignore cleanup failure.
      }
      instance = null
    }
    removeIfExists(tempDbPath)
    removeIfExists(`${tempDbPath}.wal`)
    const message = error instanceof Error ? error.message.split(key).join('***') : String(error)
    throw new StorageError(`Failed to encrypt database "${dbPath}": ${message}`, { cause: error })
  }
  finally {
    if (connection) {
      connection.closeSync()
    }
    if (instance) {
      instance.closeSync()
    }
  }

  removeIfExists(backupPath)
  fs.renameSync(dbPath, backupPath)
  removeIfExists(`${dbPath}.wal`)
  fs.renameSync(tempDbPath, dbPath)
  removeIfExists(`${tempDbPath}.wal`)

  logger.info(`Encrypted database "${dbPath}". Original backed up to "${backupPath}".`)
  return {
    status: 'encrypted',
    dbPath,
    backupPath,
    tablesCopied,
  }
}
