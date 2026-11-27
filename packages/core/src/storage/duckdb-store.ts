import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api'
import type {
  ActivityQueryFilter,
  ActivityStorePort,
  FlybyQueueEntry,
  FlybyQueueStatus,
  VendorSyncFilter,
  VendorSyncUpsertInput,
} from '../contracts/storage.js'
import type { LoadEnvConfigOptions } from '../foundation/config.js'
import type { Logger } from '../foundation/logger.js'
import type { Activity, FlybyPoint, VendorSyncRow } from '../foundation/types.js'
import type { DuckDBHandle } from './connection.js'
import { resolveRuntimeConfig } from '../foundation/config.js'
import { StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'
import {
  formatDuckDBTimestamp,
  openDuckDBConnection,
  toNullableInt,
  toNullableNumber,
  toNumber,
  toTimestampSqlParam,
  withTransaction,
} from './connection.js'
import { ensureStorageSchema, tableExists } from './schema.js'

const DELETE_CHUNK_SIZE = 500

export interface DuckDBActivityStoreOptions {
  /** Path to the DuckDB file or `:memory:`. Defaults to `resolveRuntimeConfig().sqlFile`. */
  readonly dbPath?: string
  /** Open the database in read-only mode. Defaults to `false`. */
  readonly readOnly?: boolean
  /**
   * Explicit encryption key for DuckDB encrypted databases.
   * - Non-empty string: attach using this key.
   * - `null` or `''`: explicitly open unencrypted (skip `.env.local` / `process.env`).
   * - `undefined`: resolve `DUCKDB_ENCRYPTION_KEY` via `loadEnvConfig(envOptions)` for file-backed DBs.
   */
  readonly encryptionKey?: string | null
  /** Optional overrides when resolving `DUCKDB_ENCRYPTION_KEY`. */
  readonly envOptions?: LoadEnvConfigOptions
  /** Automatically create/migrate tables & primary keys on first writable open. Defaults to `true`. */
  readonly autoMigrate?: boolean
  readonly logger?: Logger
}

function toFiniteNullableNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return value
}

function toFiniteNumber(value: number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return value
}

function mapActivityRow(row: Record<string, unknown>): Activity {
  const elapsed = toNullableNumber(row.elapsed_time)
  const activity: Activity = {
    run_id: toNumber(row.run_id),
    name: row.name === null || row.name === undefined ? '' : String(row.name),
    distance: toNumber(row.distance, 0),
    moving_time: toNumber(row.moving_time, 0),
    type: row.type === null || row.type === undefined ? '' : String(row.type),
    subtype: row.subtype === null || row.subtype === undefined ? '' : String(row.subtype),
    start_date: formatDuckDBTimestamp(row.start_date, 'T') ?? '',
    start_date_local: formatDuckDBTimestamp(row.start_date_local, 'T') ?? '',
    location_country: row.location_country === null || row.location_country === undefined
      ? null
      : String(row.location_country),
    summary_polyline: row.summary_polyline === null || row.summary_polyline === undefined
      ? null
      : String(row.summary_polyline),
    average_heartrate: toNullableNumber(row.average_heartrate),
    average_speed: toNumber(row.average_speed, 0),
    elevation_gain: toNullableNumber(row.elevation_gain),
  }

  if (elapsed !== null) {
    activity.elapsed_time = elapsed
  }

  return activity
}

function mapFlybyRow(row: Record<string, unknown>): FlybyPoint {
  return {
    activity_id: toNumber(row.activity_id),
    time_offset: toNumber(row.time_offset),
    lat: toNullableNumber(row.lat),
    lng: toNullableNumber(row.lng),
    alt: toNullableNumber(row.alt),
    pace: toNumber(row.pace, 0),
    hr: toNullableNumber(row.hr),
    distance: toNullableNumber(row.distance),
    cadence: toNullableNumber(row.cadence),
    watts: toNullableNumber(row.watts),
  }
}

function mapVendorSyncRow(row: Record<string, unknown>): VendorSyncRow {
  return {
    activityId: toNumber(row.activity_id),
    vendor: String(row.vendor),
    account: String(row.account),
    status: String(row.status),
    remoteActivityId: toNullableNumber(row.remote_activity_id),
    contentHash: row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    attemptCount: toNumber(row.attempt_count, 0),
    nextRetryAt: formatDuckDBTimestamp(row.next_retry_at, 'T'),
    uploadedAt: formatDuckDBTimestamp(row.uploaded_at, 'T'),
    lastVerifiedAt: formatDuckDBTimestamp(row.last_verified_at, 'T'),
  }
}

function wrapStorageError(action: string, error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new StorageError(`${action}: ${message}`, { cause: error })
}

/**
 * DuckDB-backed implementation of `ActivityStorePort` using `@duckdb/node-api@1.4.4-r.4`.
 *
 * Connections are opened lazily on first operation to avoid unnecessary file creation or writes.
 */
export class DuckDBActivityStore implements ActivityStorePort {
  readonly dbPath: string
  readonly readOnly: boolean
  private readonly encryptionKey: string | null | undefined
  private readonly envOptions: LoadEnvConfigOptions | undefined
  private readonly autoMigrate: boolean
  private readonly logger: Logger
  private handle: DuckDBHandle | null = null
  private connectPromise: Promise<DuckDBHandle> | null = null
  private closed = false

  constructor(options: DuckDBActivityStoreOptions = {}) {
    this.dbPath = options.dbPath ?? resolveRuntimeConfig().sqlFile
    this.readOnly = options.readOnly ?? false
    this.encryptionKey = options.encryptionKey
    this.envOptions = options.envOptions
    this.autoMigrate = options.autoMigrate ?? true
    this.logger = options.logger ?? createLogger('storage.duckdb')
  }

  get isClosed(): boolean {
    return this.closed
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('DuckDBActivityStore is closed')
    }
  }

  private async ensureHandle(requireWrite = false): Promise<DuckDBHandle> {
    this.assertOpen()
    if (requireWrite && this.readOnly) {
      throw new StorageError('DuckDBActivityStore is opened in read-only mode')
    }
    if (this.handle) {
      return this.handle
    }
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        const handle = await openDuckDBConnection({
          dbPath: this.dbPath,
          readOnly: this.readOnly,
          encryptionKey: this.encryptionKey,
          envOptions: this.envOptions,
        })
        try {
          if (!this.readOnly && this.autoMigrate) {
            await ensureStorageSchema(handle.connection, this.logger)
          }
          if (this.closed) {
            await handle.close()
            throw new StorageError('DuckDBActivityStore is closed')
          }
          this.handle = handle
          return handle
        }
        catch (error) {
          await handle.close()
          throw error
        }
        finally {
          this.connectPromise = null
        }
      })()
    }
    return this.connectPromise
  }

  /**
   * Returns the underlying DuckDB connection (opening lazily if needed).
   */
  async getConnection(): Promise<DuckDBConnection> {
    const handle = await this.ensureHandle(false)
    return handle.connection
  }

  private async hasTable(connection: DuckDBConnection, tableName: string): Promise<boolean> {
    if (!this.readOnly && this.autoMigrate) {
      return true
    }
    return tableExists(connection, tableName)
  }

  async getActivityById(activityId: number): Promise<Activity | null> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities'))) {
        return null
      }
      const result = await connection.runAndReadAll(
        `SELECT
          run_id, name, distance, moving_time, elapsed_time,
          type, subtype, start_date, start_date_local,
          location_country, summary_polyline,
          average_heartrate, average_speed, elevation_gain
        FROM activities
        WHERE run_id = ?`,
        [Math.trunc(activityId)],
      )
      const rows = result.getRowObjects()
      if (rows.length === 0) {
        return null
      }
      return mapActivityRow(rows[0])
    }
    catch (error) {
      throw wrapStorageError(`Failed to fetch activity ${activityId}`, error)
    }
  }

  async listActivities(filter: ActivityQueryFilter = {}): Promise<Activity[]> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities'))) {
        return []
      }

      if (filter.ids && filter.ids.length === 0) {
        return []
      }
      if (filter.types && filter.types.length === 0) {
        return []
      }

      const conditions: string[] = []
      const params: DuckDBValue[] = []

      if (filter.ids && filter.ids.length > 0) {
        const placeholders = filter.ids.map(() => '?').join(', ')
        conditions.push(`run_id IN (${placeholders})`)
        for (const id of filter.ids) {
          params.push(Math.trunc(id))
        }
      }

      if (filter.idRange) {
        conditions.push('run_id >= ? AND run_id <= ?')
        params.push(Math.trunc(filter.idRange.min), Math.trunc(filter.idRange.max))
      }

      if (filter.onlyRun) {
        conditions.push(`type = 'Run'`)
      }

      if (filter.types && filter.types.length > 0) {
        const placeholders = filter.types.map(() => '?').join(', ')
        conditions.push(`type IN (${placeholders})`)
        for (const type of filter.types) {
          params.push(type)
        }
      }

      if (filter.minDistance !== undefined) {
        conditions.push('distance >= ?')
        params.push(filter.minDistance)
      }

      if (filter.hasPolyline) {
        conditions.push(`summary_polyline IS NOT NULL AND LENGTH(TRIM(summary_polyline)) > 0`)
      }

      if (filter.startDateLocalFrom !== undefined) {
        conditions.push('start_date_local >= CAST(? AS TIMESTAMP)')
        params.push(filter.startDateLocalFrom)
      }

      if (filter.startDateLocalTo !== undefined) {
        conditions.push('start_date_local <= CAST(? AS TIMESTAMP)')
        params.push(filter.startDateLocalTo)
      }

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const sql = `
        SELECT
          run_id, name, distance, moving_time, elapsed_time,
          type, subtype, start_date, start_date_local,
          location_country, summary_polyline,
          average_heartrate, average_speed, elevation_gain
        FROM activities
        ${whereSql}
        ORDER BY start_date_local ASC, run_id ASC
      `

      const result = params.length > 0
        ? await connection.runAndReadAll(sql, params)
        : await connection.runAndReadAll(sql)
      return result.getRowObjects().map(row => mapActivityRow(row))
    }
    catch (error) {
      throw wrapStorageError('Failed to list activities', error)
    }
  }

  async getExistingActivityIds(): Promise<Set<number>> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities'))) {
        return new Set()
      }
      const result = await connection.runAndReadAll('SELECT run_id FROM activities')
      const ids = new Set<number>()
      for (const row of result.getRowObjects()) {
        ids.add(toNumber(row.run_id))
      }
      return ids
    }
    catch (error) {
      throw wrapStorageError('Failed to fetch existing activity IDs', error)
    }
  }

  async getLatestActivityDate(): Promise<string | null> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities'))) {
        return null
      }
      const result = await connection.runAndReadAll('SELECT MAX(start_date) AS latest FROM activities')
      const rows = result.getRowObjects()
      return formatDuckDBTimestamp(rows[0]?.latest, 'T')
    }
    catch (error) {
      throw wrapStorageError('Failed to fetch latest activity date', error)
    }
  }

  async getFlybyPoints(activityId: number): Promise<FlybyPoint[]> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities_flyby'))) {
        return []
      }
      const result = await connection.runAndReadAll(
        `SELECT
          activity_id, time_offset, lat, lng, alt, pace, hr, distance, cadence, watts
        FROM activities_flyby
        WHERE activity_id = ?
        ORDER BY time_offset ASC`,
        [Math.trunc(activityId)],
      )
      return result.getRowObjects().map(row => mapFlybyRow(row))
    }
    catch (error) {
      throw wrapStorageError(`Failed to fetch flyby points for activity ${activityId}`, error)
    }
  }

  async upsertActivities(activities: readonly Activity[]): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      if (activities.length === 0) {
        return 0
      }

      const sql = `
        INSERT INTO activities (
          run_id, name, distance, moving_time, elapsed_time,
          type, subtype, start_date, start_date_local,
          location_country, summary_polyline,
          average_heartrate, average_speed, elevation_gain
        )
        VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP),
          ?, ?,
          ?, ?, ?
        )
        ON CONFLICT (run_id) DO UPDATE SET
          name = excluded.name,
          distance = excluded.distance,
          moving_time = excluded.moving_time,
          elapsed_time = excluded.elapsed_time,
          type = excluded.type,
          subtype = excluded.subtype,
          start_date = excluded.start_date,
          start_date_local = excluded.start_date_local,
          location_country = excluded.location_country,
          summary_polyline = excluded.summary_polyline,
          average_heartrate = excluded.average_heartrate,
          average_speed = excluded.average_speed,
          elevation_gain = excluded.elevation_gain
      `

      await withTransaction(connection, async (tx) => {
        const stmt = await tx.prepare(sql)
        try {
          for (const activity of activities) {
            stmt.bind([
              Math.trunc(activity.run_id),
              activity.name,
              toFiniteNumber(activity.distance, 0),
              toNullableInt(activity.moving_time) ?? 0,
              toNullableInt(activity.elapsed_time),
              activity.type,
              activity.subtype,
              toTimestampSqlParam(activity.start_date),
              toTimestampSqlParam(activity.start_date_local),
              activity.location_country ?? null,
              activity.summary_polyline ?? null,
              toFiniteNullableNumber(activity.average_heartrate),
              toFiniteNumber(activity.average_speed, 0),
              toFiniteNullableNumber(activity.elevation_gain),
            ])
            await stmt.run()
          }
        }
        finally {
          stmt.destroySync()
        }
      })

      return activities.length
    }
    catch (error) {
      throw wrapStorageError('Failed to upsert activities', error)
    }
  }

  async pruneActivitiesNotIn(remoteIds: ReadonlySet<number>): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      const existingIds = await this.getExistingActivityIds()
      const staleIds: number[] = []
      for (const id of existingIds) {
        if (!remoteIds.has(id)) {
          staleIds.push(id)
        }
      }
      if (staleIds.length === 0) {
        return 0
      }

      // Execute deletions in separate statements (without a shared transaction) to work around
      // DuckDB's foreign key constraint limitation when deleting parent and child rows together.
      for (let i = 0; i < staleIds.length; i += DELETE_CHUNK_SIZE) {
        const chunk = staleIds.slice(i, i + DELETE_CHUNK_SIZE)
        const placeholders = chunk.map(() => '?').join(', ')
        await connection.run(
          `DELETE FROM activities_flyby WHERE activity_id IN (${placeholders})`,
          chunk,
        )
        await connection.run(
          `DELETE FROM activities_flyby_queue WHERE activity_id IN (${placeholders})`,
          chunk,
        )
        await connection.run(
          `DELETE FROM activities WHERE run_id IN (${placeholders})`,
          chunk,
        )
      }

      return staleIds.length
    }
    catch (error) {
      throw wrapStorageError('Failed to prune stale activities', error)
    }
  }

  async storeFlybyPoints(points: readonly FlybyPoint[]): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      if (points.length === 0) {
        return 0
      }

      const sql = `
        INSERT INTO activities_flyby (
          activity_id, time_offset, lat, lng, alt, pace, hr, distance, cadence, watts
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (activity_id, time_offset) DO UPDATE SET
          lat = excluded.lat,
          lng = excluded.lng,
          alt = excluded.alt,
          pace = excluded.pace,
          hr = excluded.hr,
          distance = excluded.distance,
          cadence = excluded.cadence,
          watts = excluded.watts
      `

      await withTransaction(connection, async (tx) => {
        const stmt = await tx.prepare(sql)
        try {
          for (const point of points) {
            stmt.bind([
              Math.trunc(point.activity_id),
              Math.trunc(point.time_offset),
              toFiniteNullableNumber(point.lat),
              toFiniteNullableNumber(point.lng),
              toNullableInt(point.alt),
              toFiniteNumber(point.pace, 0),
              toNullableInt(point.hr),
              toNullableInt(point.distance),
              toNullableInt(point.cadence),
              toNullableInt(point.watts),
            ])
            await stmt.run()
          }
        }
        finally {
          stmt.destroySync()
        }
      })

      return points.length
    }
    catch (error) {
      throw wrapStorageError('Failed to store flyby points', error)
    }
  }

  async enqueueFlyby(activityIds: readonly number[]): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      if (activityIds.length === 0) {
        return 0
      }

      const uniqueIds = Array.from(new Set(activityIds.map(id => Math.trunc(id))))
      let added = 0

      await withTransaction(connection, async (tx) => {
        const beforeResult = await tx.runAndReadAll('SELECT COUNT(*) AS cnt FROM activities_flyby_queue')
        const beforeCount = toNumber(beforeResult.getRowObjects()[0]?.cnt, 0)

        const stmt = await tx.prepare(
          `INSERT INTO activities_flyby_queue (activity_id, status, last_error, updated_at)
           VALUES (?, 'pending', NULL, NOW())
           ON CONFLICT (activity_id) DO NOTHING`,
        )
        try {
          for (const activityId of uniqueIds) {
            stmt.bind([activityId])
            await stmt.run()
          }
        }
        finally {
          stmt.destroySync()
        }

        const afterResult = await tx.runAndReadAll('SELECT COUNT(*) AS cnt FROM activities_flyby_queue')
        const afterCount = toNumber(afterResult.getRowObjects()[0]?.cnt, 0)
        added = Math.max(0, afterCount - beforeCount)
      })

      return added
    }
    catch (error) {
      throw wrapStorageError('Failed to enqueue flyby activities', error)
    }
  }

  async listPendingFlyby(): Promise<FlybyQueueEntry[]> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'activities_flyby_queue'))) {
        return []
      }
      const result = await connection.runAndReadAll(
        `SELECT activity_id, status, last_error, updated_at
         FROM activities_flyby_queue
         ORDER BY activity_id ASC`,
      )
      return result.getRowObjects().map(row => ({
        activityId: toNumber(row.activity_id),
        status: String(row.status ?? 'pending') as FlybyQueueEntry['status'],
        lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
        updatedAt: formatDuckDBTimestamp(row.updated_at, 'T') ?? '',
      }))
    }
    catch (error) {
      throw wrapStorageError('Failed to list pending flyby activities', error)
    }
  }

  async markFlybyStatus(
    activityId: number,
    status: FlybyQueueStatus,
    lastError: string | null = null,
  ): Promise<void> {
    try {
      const { connection } = await this.ensureHandle(true)
      const normalizedId = Math.trunc(activityId)
      if (status === 'done') {
        await connection.run('DELETE FROM activities_flyby_queue WHERE activity_id = ?', [normalizedId])
        return
      }
      await connection.run(
        `UPDATE activities_flyby_queue
         SET status = ?, last_error = ?, updated_at = NOW()
         WHERE activity_id = ?
           AND (status IS DISTINCT FROM ? OR last_error IS DISTINCT FROM ?)`,
        [status, lastError, normalizedId, status, lastError],
      )
    }
    catch (error) {
      throw wrapStorageError(`Failed to update flyby status for activity ${activityId}`, error)
    }
  }

  async getVendorSyncRow(activityId: number, vendor: string, account: string): Promise<VendorSyncRow | null> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'vendor_activity_sync'))) {
        return null
      }
      const result = await connection.runAndReadAll(
        `SELECT
          activity_id, vendor, account, status,
          remote_activity_id, content_hash, last_error, attempt_count,
          next_retry_at, uploaded_at, last_verified_at
        FROM vendor_activity_sync
        WHERE activity_id = ? AND vendor = ? AND account = ?`,
        [Math.trunc(activityId), vendor, account],
      )
      const rows = result.getRowObjects()
      if (rows.length === 0) {
        return null
      }
      return mapVendorSyncRow(rows[0])
    }
    catch (error) {
      throw wrapStorageError('Failed to fetch vendor sync row', error)
    }
  }

  async listVendorSyncRows(filter: VendorSyncFilter): Promise<VendorSyncRow[]> {
    try {
      const { connection } = await this.ensureHandle(false)
      if (!(await this.hasTable(connection, 'vendor_activity_sync'))) {
        return []
      }

      const conditions = ['vendor = ?']
      const params: DuckDBValue[] = [filter.vendor]

      if (filter.account !== undefined) {
        conditions.push('account = ?')
        params.push(filter.account)
      }
      if (filter.status !== undefined) {
        conditions.push('status = ?')
        params.push(filter.status)
      }

      const result = await connection.runAndReadAll(
        `SELECT
          activity_id, vendor, account, status,
          remote_activity_id, content_hash, last_error, attempt_count,
          next_retry_at, uploaded_at, last_verified_at
        FROM vendor_activity_sync
        WHERE ${conditions.join(' AND ')}
        ORDER BY activity_id ASC, account ASC`,
        params,
      )
      return result.getRowObjects().map(row => mapVendorSyncRow(row))
    }
    catch (error) {
      throw wrapStorageError('Failed to list vendor sync rows', error)
    }
  }

  async upsertVendorSyncRow(input: VendorSyncUpsertInput): Promise<void> {
    try {
      const { connection } = await this.ensureHandle(true)
      const attemptCountParam = toNullableInt(input.attemptCount)

      await connection.run(
        `INSERT INTO vendor_activity_sync (
          activity_id, vendor, account, status,
          remote_activity_id, content_hash, last_error, attempt_count,
          next_retry_at, uploaded_at, last_verified_at, updated_at
        )
        VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, COALESCE(?, 0),
          CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), NOW()
        )
        ON CONFLICT (activity_id, vendor, account) DO UPDATE SET
          status = excluded.status,
          remote_activity_id = COALESCE(excluded.remote_activity_id, vendor_activity_sync.remote_activity_id),
          content_hash = COALESCE(excluded.content_hash, vendor_activity_sync.content_hash),
          last_error = excluded.last_error,
          attempt_count = COALESCE(?, vendor_activity_sync.attempt_count),
          next_retry_at = excluded.next_retry_at,
          uploaded_at = COALESCE(excluded.uploaded_at, vendor_activity_sync.uploaded_at),
          last_verified_at = COALESCE(excluded.last_verified_at, vendor_activity_sync.last_verified_at),
          updated_at = NOW()`,
        [
          Math.trunc(input.activityId),
          input.vendor,
          input.account,
          input.status,
          toNullableInt(input.remoteActivityId),
          input.contentHash ?? null,
          input.lastError ?? null,
          attemptCountParam,
          toTimestampSqlParam(input.nextRetryAt),
          toTimestampSqlParam(input.uploadedAt),
          toTimestampSqlParam(input.lastVerifiedAt),
          attemptCountParam,
        ],
      )
    }
    catch (error) {
      throw wrapStorageError('Failed to upsert vendor sync row', error)
    }
  }

  async retryFailedVendorSync(vendor: string, account?: string): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      const whereParts = [`vendor = ?`, `status = 'failed'`]
      const params: DuckDBValue[] = [vendor]
      if (account !== undefined) {
        whereParts.push('account = ?')
        params.push(account)
      }
      const whereSql = whereParts.join(' AND ')

      return await withTransaction(connection, async (tx) => {
        const countResult = await tx.runAndReadAll(
          `SELECT COUNT(*) AS cnt FROM vendor_activity_sync WHERE ${whereSql}`,
          params,
        )
        const count = toNumber(countResult.getRowObjects()[0]?.cnt, 0)
        if (count === 0) {
          return 0
        }

        await tx.run(
          `UPDATE vendor_activity_sync
           SET status = 'pending', last_error = NULL, next_retry_at = NULL, updated_at = NOW()
           WHERE ${whereSql}`,
          params,
        )
        return count
      })
    }
    catch (error) {
      throw wrapStorageError('Failed to retry failed vendor sync rows', error)
    }
  }

  async clearVendorSyncRows(vendor: string, account?: string): Promise<number> {
    try {
      const { connection } = await this.ensureHandle(true)
      const whereParts = ['vendor = ?']
      const params: DuckDBValue[] = [vendor]
      if (account !== undefined) {
        whereParts.push('account = ?')
        params.push(account)
      }
      const whereSql = whereParts.join(' AND ')

      return await withTransaction(connection, async (tx) => {
        const countResult = await tx.runAndReadAll(
          `SELECT COUNT(*) AS cnt FROM vendor_activity_sync WHERE ${whereSql}`,
          params,
        )
        const count = toNumber(countResult.getRowObjects()[0]?.cnt, 0)
        if (count === 0) {
          return 0
        }

        await tx.run(`DELETE FROM vendor_activity_sync WHERE ${whereSql}`, params)
        return count
      })
    }
    catch (error) {
      throw wrapStorageError('Failed to clear vendor sync rows', error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const activeHandle = this.handle
    this.handle = null
    if (activeHandle) {
      await activeHandle.close()
    }
  }
}
