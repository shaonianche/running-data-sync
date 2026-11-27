import type { ActivityStorePort } from '../contracts/storage.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StorageError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createVendorSyncRow,
  FIXTURE_VENDOR_SYNC_ROWS,
} from '../testing/fixtures.js'
import { InMemoryActivityStore } from '../testing/in-memory-store.js'
import { DuckDBActivityStore } from './duckdb-store.js'

interface StoreFactory {
  readonly name: string
  create: () => Promise<{ store: ActivityStorePort, cleanup: () => Promise<void> }>
}

function normalizeNaiveTimestamp(value: string | Date | null): string | null {
  if (value === null) {
    return null
  }
  const iso = value instanceof Date ? value.toISOString() : value
  return iso.replace(' ', 'T').replace(/Z$/, '').replace(/\.000$/, '')
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-store-contract-'))
  tempDirs.push(dir)
  return dir
}

const factories: readonly StoreFactory[] = [
  {
    name: 'InMemoryActivityStore',
    async create() {
      const store = new InMemoryActivityStore()
      return {
        store,
        async cleanup() {
          await store.close()
        },
      }
    },
  },
  {
    name: 'DuckDBActivityStore (:memory:)',
    async create() {
      const store = new DuckDBActivityStore({ dbPath: ':memory:' })
      return {
        store,
        async cleanup() {
          await store.close()
        },
      }
    },
  },
  {
    name: 'DuckDBActivityStore (file)',
    async create() {
      const dir = makeTempDir()
      const dbPath = path.join(dir, 'contract.duckdb')
      const store = new DuckDBActivityStore({ dbPath })
      return {
        store,
        async cleanup() {
          await store.close()
        },
      }
    },
  },
]

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe.each(factories)('activityStorePort contract: $name', ({ create }) => {
  it('supports activity upsert idempotency, lookup, immutability, and latest date queries', async () => {
    const { store, cleanup } = await create()
    try {
      expect(await store.getActivityById(100001)).toBeNull()
      expect(await store.getLatestActivityDate()).toBeNull()
      expect(await store.getExistingActivityIds()).toEqual(new Set())
      expect(await store.upsertActivities([])).toBe(0)

      const outdoor = createOutdoorRunActivity()
      const indoor = createIndoorWorkoutActivity()
      expect(await store.upsertActivities([outdoor, indoor])).toBe(2)

      // Mutating caller object must not affect stored state
      outdoor.name = 'Mutated Caller Name'
      const fetched = await store.getActivityById(100001)
      expect(fetched?.name).toBe('Morning Run')
      expect(fetched?.elapsed_time).toBe(1530)

      // Mutating fetched object must not affect stored state
      if (fetched) {
        fetched.name = 'Mutated Fetched Name'
      }
      expect((await store.getActivityById(100001))?.name).toBe('Morning Run')

      // Upsert is idempotent and overwrites by run_id
      expect(await store.upsertActivities([createOutdoorRunActivity({ name: 'Updated Run', distance: 5200 })])).toBe(1)
      expect(await store.upsertActivities([createOutdoorRunActivity({ name: 'Updated Run', distance: 5200 })])).toBe(1)
      const updated = await store.getActivityById(100001)
      expect(updated?.name).toBe('Updated Run')
      expect(updated?.distance).toBe(5200)

      expect(await store.getExistingActivityIds()).toEqual(new Set([100001, 100002]))
      expect(normalizeNaiveTimestamp(await store.getLatestActivityDate())).toBe('2025-03-16T11:00:00')
    }
    finally {
      await cleanup()
    }
  })

  it('filters and deterministically sorts activities in listActivities', async () => {
    const { store, cleanup } = await create()
    try {
      await store.upsertActivities([
        createOutdoorRunActivity({ run_id: 200, start_date_local: '2025-04-01T07:00:00', distance: 10000 }),
        createOutdoorRunActivity({ run_id: 105, start_date_local: '2025-03-15T08:30:00', distance: 3000 }),
        createOutdoorRunActivity({ run_id: 100, start_date_local: '2025-03-15T08:30:00', distance: 5000 }),
        createIndoorWorkoutActivity({ run_id: 150, start_date_local: '2025-03-20T19:00:00', type: 'Workout' }),
      ])

      const all = await store.listActivities()
      expect(all.map(a => a.run_id)).toEqual([100, 105, 150, 200])

      expect((await store.listActivities({ ids: [200, 100] })).map(a => a.run_id)).toEqual([100, 200])
      expect(await store.listActivities({ ids: [] })).toEqual([])
      expect((await store.listActivities({ idRange: { min: 101, max: 199 } })).map(a => a.run_id)).toEqual([105, 150])
      expect((await store.listActivities({ onlyRun: true })).map(a => a.run_id)).toEqual([100, 105, 200])
      expect((await store.listActivities({ types: ['Workout'] })).map(a => a.run_id)).toEqual([150])
      expect(await store.listActivities({ types: [] })).toEqual([])
      expect((await store.listActivities({ minDistance: 5000 })).map(a => a.run_id)).toEqual([100, 200])
      expect((await store.listActivities({ hasPolyline: true })).map(a => a.run_id)).toEqual([100, 105, 200])
      expect(
        (await store.listActivities({
          startDateLocalFrom: '2025-03-16T00:00:00',
          startDateLocalTo: '2025-03-31T23:59:59',
        })).map(a => a.run_id),
      ).toEqual([150])
    }
    finally {
      await cleanup()
    }
  })

  it('cascades pruneActivitiesNotIn to flyby points and flyby queue', async () => {
    const { store, cleanup } = await create()
    try {
      await store.upsertActivities([createOutdoorRunActivity(), createIndoorWorkoutActivity()])
      await store.storeFlybyPoints([...createOutdoorRunFlybyPoints(), ...createIndoorWorkoutFlybyPoints()])
      await store.enqueueFlyby([100001, 100002])

      expect(await store.pruneActivitiesNotIn(new Set([100001]))).toBe(1)

      expect(await store.getActivityById(100001)).not.toBeNull()
      expect(await store.getActivityById(100002)).toBeNull()
      expect((await store.getFlybyPoints(100001)).length).toBeGreaterThan(0)
      expect(await store.getFlybyPoints(100002)).toEqual([])
      expect((await store.listPendingFlyby()).map(entry => entry.activityId)).toEqual([100001])

      // Pruning with empty set removes all remaining activities & child rows
      expect(await store.pruneActivitiesNotIn(new Set())).toBe(1)
      expect(await store.listActivities()).toEqual([])
      expect(await store.getFlybyPoints(100001)).toEqual([])
      expect(await store.listPendingFlyby()).toEqual([])
    }
    finally {
      await cleanup()
    }
  })

  it('upserts flyby points by (activity_id, time_offset) and returns sorted points', async () => {
    const { store, cleanup } = await create()
    try {
      await store.upsertActivities([
        createOutdoorRunActivity({ run_id: 500 }),
        createIndoorWorkoutActivity({ run_id: 501 }),
      ])

      const points = createOutdoorRunFlybyPoints(500)
      expect(await store.storeFlybyPoints([])).toBe(0)
      expect(await store.storeFlybyPoints([points[2], points[0], points[1]])).toBe(3)

      // Update existing time_offset=300
      expect(await store.storeFlybyPoints([{ ...points[1], hr: 199 }])).toBe(1)

      const stored = await store.getFlybyPoints(500)
      expect(stored.map(p => p.time_offset)).toEqual([0, 300, 600])
      expect(stored[1].hr).toBe(199)
      expect(stored[0].lat).toBeCloseTo(39.944, 6)
      expect(stored[0].lng).toBeCloseTo(116.482, 6)
      expect(stored[0].pace).toBeCloseTo(5.0, 2)

      // Indoor points with null lat/lng/alt/cadence/watts
      const indoorPoints = createIndoorWorkoutFlybyPoints(501)
      expect(await store.storeFlybyPoints(indoorPoints)).toBe(indoorPoints.length)
      const storedIndoor = await store.getFlybyPoints(501)
      expect(storedIndoor[0].lat).toBeNull()
      expect(storedIndoor[0].hr).toBe(115)

      expect(await store.getFlybyPoints(999)).toEqual([])
    }
    finally {
      await cleanup()
    }
  })

  it('manages flyby queue enqueue deduplication and status transitions', async () => {
    const { store, cleanup } = await create()
    try {
      expect(await store.enqueueFlyby([])).toBe(0)
      expect(await store.enqueueFlyby([202, 101, 202])).toBe(2)
      expect(await store.enqueueFlyby([101, 303])).toBe(1)

      const initial = await store.listPendingFlyby()
      expect(initial.map(entry => entry.activityId)).toEqual([101, 202, 303])
      expect(initial[0].status).toBe('pending')

      await store.markFlybyStatus(101, 'rate_limited', 'HTTP 429')
      await store.markFlybyStatus(202, 'done')
      await store.markFlybyStatus(999, 'failed', 'not in queue')

      const remaining = await store.listPendingFlyby()
      expect(remaining.map(entry => entry.activityId)).toEqual([101, 303])
      expect(remaining[0]).toMatchObject({
        activityId: 101,
        status: 'rate_limited',
        lastError: 'HTTP 429',
      })
    }
    finally {
      await cleanup()
    }
  })

  it('implements vendor sync COALESCE upsert, filtering, retry-failed, and clear', async () => {
    const { store, cleanup } = await create()
    try {
      for (const row of FIXTURE_VENDOR_SYNC_ROWS) {
        await store.upsertVendorSyncRow(row)
      }

      const comRows = await store.listVendorSyncRows({ vendor: 'garmin', account: 'garmin_com' })
      expect(comRows.map(r => r.activityId)).toEqual([100001, 100002])

      const failedRows = await store.listVendorSyncRows({ vendor: 'garmin', status: 'failed' })
      expect(failedRows.map(r => r.activityId)).toEqual([100002])

      // Upsert preserves existing non-null remoteActivityId/contentHash/attemptCount/uploadedAt/lastVerifiedAt
      // while overwriting status, lastError, and nextRetryAt
      await store.upsertVendorSyncRow({
        activityId: 100001,
        vendor: 'garmin',
        account: 'garmin_com',
        status: 'conflict',
        lastError: 'Remote mismatch',
        nextRetryAt: null,
      })
      const updated = await store.getVendorSyncRow(100001, 'garmin', 'garmin_com')
      expect(updated).not.toBeNull()
      expect({
        ...updated,
        nextRetryAt: normalizeNaiveTimestamp(updated!.nextRetryAt),
        uploadedAt: normalizeNaiveTimestamp(updated!.uploadedAt),
        lastVerifiedAt: normalizeNaiveTimestamp(updated!.lastVerifiedAt),
      }).toEqual({
        activityId: 100001,
        vendor: 'garmin',
        account: 'garmin_com',
        status: 'conflict',
        remoteActivityId: 900001,
        contentHash: 'sha256-fixture-100001',
        lastError: 'Remote mismatch',
        attemptCount: 1,
        nextRetryAt: null,
        uploadedAt: '2025-03-15T01:00:00',
        lastVerifiedAt: '2025-03-15T01:05:00',
      })

      // Add a failed row in garmin_cn to verify account scoping
      await store.upsertVendorSyncRow(createVendorSyncRow({
        activityId: 100002,
        account: 'garmin_cn',
        status: 'failed',
        lastError: 'timeout',
        nextRetryAt: new Date('2025-03-16T13:00:00Z'),
      }))

      expect(await store.retryFailedVendorSync('garmin', 'garmin_com')).toBe(1)
      const retriedCom = await store.getVendorSyncRow(100002, 'garmin', 'garmin_com')
      expect(retriedCom?.status).toBe('pending')
      expect(retriedCom?.lastError).toBeNull()
      expect(retriedCom?.nextRetryAt).toBeNull()

      // garmin_cn failed row remains untouched until retried without account filter
      expect((await store.getVendorSyncRow(100002, 'garmin', 'garmin_cn'))?.status).toBe('failed')
      expect(await store.retryFailedVendorSync('garmin')).toBe(1)
      expect((await store.getVendorSyncRow(100002, 'garmin', 'garmin_cn'))?.status).toBe('pending')

      // Clear rows for one account only
      expect(await store.clearVendorSyncRows('garmin', 'garmin_cn')).toBe(2)
      expect(await store.listVendorSyncRows({ vendor: 'garmin', account: 'garmin_cn' })).toEqual([])
      expect((await store.listVendorSyncRows({ vendor: 'garmin', account: 'garmin_com' })).length).toBe(2)
    }
    finally {
      await cleanup()
    }
  })

  it('closes idempotently and rejects operations after close', async () => {
    const { store, cleanup } = await create()
    try {
      await store.close()
      await store.close()

      await expect(store.listActivities()).rejects.toThrow(StorageError)
      await expect(store.upsertActivities([])).rejects.toThrow(StorageError)
      await expect(store.listVendorSyncRows({ vendor: 'garmin' })).rejects.toThrow(StorageError)
    }
    finally {
      await cleanup()
    }
  })
})
