import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createVendorSyncRow,
} from '../testing/fixtures.js'
import { openDuckDBConnection, withTransaction } from './connection.js'
import { DuckDBActivityStore } from './duckdb-store.js'
import { encryptDatabase } from './encryption.js'
import { ensureStorageSchema } from './schema.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-storage-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('duckDB connection, schema migration, and encryption', () => {
  it('opens DuckDB lazily and respects read-only mode', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'lazy.duckdb')

    const store = new DuckDBActivityStore({ dbPath, encryptionKey: null })
    // Lazy init: file does not exist until first operation
    expect(fs.existsSync(dbPath)).toBe(false)

    await store.upsertActivities([createOutdoorRunActivity()])
    expect(fs.existsSync(dbPath)).toBe(true)
    await store.close()

    const roStore = new DuckDBActivityStore({ dbPath, readOnly: true, encryptionKey: null })
    try {
      const fetched = await roStore.getActivityById(100001)
      expect(fetched?.name).toBe('Morning Run')
      await expect(roStore.upsertActivities([createIndoorWorkoutActivity()])).rejects.toThrow(StorageError)
    }
    finally {
      await roStore.close()
    }
  })

  it('automatically migrates missing columns and missing primary keys while preserving data', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'legacy.duckdb')

    // Create a legacy database missing columns (elapsed_time, elevation_gain) and missing PK constraints
    const handle = await openDuckDBConnection({ dbPath, encryptionKey: null })
    try {
      await handle.connection.run(`
        CREATE TABLE activities (
          run_id BIGINT,
          name VARCHAR,
          distance DOUBLE,
          moving_time BIGINT,
          type VARCHAR,
          subtype VARCHAR,
          start_date TIMESTAMP,
          start_date_local TIMESTAMP
        )
      `)
      await handle.connection.run(`
        INSERT INTO activities VALUES (
          100001, 'Legacy Run', 5000, 1500, 'Run', 'Run',
          TIMESTAMP '2025-03-15 00:30:00', TIMESTAMP '2025-03-15 08:30:00'
        )
      `)
      await handle.connection.run(`
        CREATE TABLE activities_flyby (
          activity_id BIGINT,
          time_offset INTEGER,
          lat DECIMAL(9, 6),
          lng DECIMAL(9, 6),
          pace DECIMAL(5, 2)
        )
      `)
      await handle.connection.run(`
        INSERT INTO activities_flyby VALUES (100001, 0, 39.944, 116.482, 5.0)
      `)
    }
    finally {
      await handle.close()
    }

    const store = new DuckDBActivityStore({ dbPath, encryptionKey: null })
    try {
      const migrated = await store.getActivityById(100001)
      expect(migrated?.name).toBe('Legacy Run')
      expect(migrated?.elevation_gain).toBeNull()

      // Upsert must work because PK was migrated onto run_id
      await store.upsertActivities([createOutdoorRunActivity({ run_id: 100001, name: 'After Migration', elevation_gain: 42 })])
      const updated = await store.getActivityById(100001)
      expect(updated?.name).toBe('After Migration')
      expect(updated?.elevation_gain).toBe(42)

      // Flyby composite PK must also work for upsert
      const points = await store.getFlybyPoints(100001)
      expect(points).toHaveLength(1)
      expect(points[0].lat).toBeCloseTo(39.944, 6)
      await store.storeFlybyPoints([{
        ...points[0],
        hr: 155,
      }])
      expect((await store.getFlybyPoints(100001))[0].hr).toBe(155)
    }
    finally {
      await store.close()
    }
  })

  it('rolls back withTransaction on error', async () => {
    const handle = await openDuckDBConnection({ dbPath: ':memory:', encryptionKey: null })
    try {
      await ensureStorageSchema(handle.connection)
      await expect(withTransaction(handle.connection, async (tx) => {
        await tx.run(`
          INSERT INTO activities (run_id, name, distance, moving_time, type, subtype, start_date, start_date_local)
          VALUES (1, 'Should Rollback', 1000, 300, 'Run', 'Run', TIMESTAMP '2025-01-01 00:00:00', TIMESTAMP '2025-01-01 08:00:00')
        `)
        throw new Error('boom')
      })).rejects.toThrow('boom')

      const res = await handle.connection.runAndReadAll('SELECT COUNT(*) AS cnt FROM activities')
      expect(Number(res.getRowObjects()[0]?.cnt)).toBe(0)
    }
    finally {
      await handle.close()
    }
  })

  it('reads/writes encrypted DBs, rejects wrong keys, and sanitizes keys from errors', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'secret.duckdb')
    const secretKey = 'super-secret-encryption-key-999'
    const wrongKey = 'wrong-secret-key-abc'

    const store = new DuckDBActivityStore({ dbPath, encryptionKey: secretKey })
    await store.upsertActivities([createOutdoorRunActivity()])
    await store.close()

    // Opening without key fails
    await expect(openDuckDBConnection({ dbPath, readOnly: true, encryptionKey: null })).rejects.toThrow(StorageError)

    // Opening with wrong key fails and never leaks key in error message
    try {
      await openDuckDBConnection({ dbPath, readOnly: true, encryptionKey: wrongKey })
      expect.unreachable('Expected wrong encryption key to fail')
    }
    catch (error) {
      expect(error).toBeInstanceOf(StorageError)
      expect((error as Error).message).not.toContain(wrongKey)
    }

    // Opening with correct key succeeds via envOptions (.env.local / processEnv)
    const roStore = new DuckDBActivityStore({
      dbPath,
      readOnly: true,
      envOptions: { processEnv: { DUCKDB_ENCRYPTION_KEY: secretKey } },
    })
    try {
      expect((await roStore.getActivityById(100001))?.name).toBe('Morning Run')
    }
    finally {
      await roStore.close()
    }
  })

  it('encryptDatabase encrypts unencrypted DB preserving FK/PK/data and is idempotent', async () => {
    const dir = makeTempDir()
    const missingPath = path.join(dir, 'does-not-exist.duckdb')
    const missingResult = await encryptDatabase({ dbPath: missingPath, encryptionKey: 'k' })
    expect(missingResult.status).toBe('missing')

    const dbPath = path.join(dir, 'plain.duckdb')
    const key = 'migrate-encrypt-key-2026'

    const plainStore = new DuckDBActivityStore({ dbPath, encryptionKey: null })
    await plainStore.upsertActivities([createOutdoorRunActivity(), createIndoorWorkoutActivity()])
    await plainStore.storeFlybyPoints(createOutdoorRunFlybyPoints())
    await plainStore.enqueueFlyby([100001])
    await plainStore.upsertVendorSyncRow(createVendorSyncRow())
    await plainStore.close()

    // Missing key throws ConfigurationError
    await expect(encryptDatabase({
      dbPath,
      envOptions: { envFilePath: path.join(dir, 'missing.env'), processEnv: {} },
    })).rejects.toThrow(ConfigurationError)

    // Encrypt in-place
    const encryptedResult = await encryptDatabase({ dbPath, encryptionKey: key })
    expect(encryptedResult.status).toBe('encrypted')
    expect(encryptedResult.backupPath).toBe(`${dbPath}.bak`)
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(true)
    expect(encryptedResult.tablesCopied).toContain('activities')
    expect(encryptedResult.tablesCopied).toContain('activities_flyby')

    // Re-running with same key is idempotent
    const secondResult = await encryptDatabase({ dbPath, encryptionKey: key })
    expect(secondResult.status).toBe('already_encrypted')

    // Re-running with wrong key throws StorageError
    await expect(encryptDatabase({ dbPath, encryptionKey: 'wrong-key' })).rejects.toThrow(StorageError)

    // Verify all tables, data, and upsert (PK) still work on encrypted DB
    const encryptedStore = new DuckDBActivityStore({ dbPath, encryptionKey: key })
    try {
      expect((await encryptedStore.listActivities()).map(a => a.run_id)).toEqual([100001, 100002])
      expect((await encryptedStore.getFlybyPoints(100001)).length).toBe(6)
      expect((await encryptedStore.listPendingFlyby()).map(q => q.activityId)).toEqual([100001])
      expect((await encryptedStore.getVendorSyncRow(100001, 'garmin', 'garmin_com'))?.status).toBe('synced')

      // Verify PK conflict handling survived encryption copy
      await encryptedStore.upsertActivities([createOutdoorRunActivity({ name: 'Updated After Encrypt' })])
      expect((await encryptedStore.getActivityById(100001))?.name).toBe('Updated After Encrypt')
    }
    finally {
      await encryptedStore.close()
    }
  })
})
