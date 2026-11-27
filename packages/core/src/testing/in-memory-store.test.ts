import { describe, expect, it } from 'vitest'
import { StorageError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createVendorSyncRow,
  FIXTURE_VENDOR_SYNC_ROWS,
} from './fixtures.js'
import { InMemoryActivityStore } from './in-memory-store.js'

describe('inMemoryActivityStore', () => {
  it('supports activity upsert, lookup, immutability, and latest date queries', async () => {
    const store = new InMemoryActivityStore()

    expect(await store.getActivityById(100001)).toBeNull()
    expect(await store.getLatestActivityDate()).toBeNull()
    expect(await store.getExistingActivityIds()).toEqual(new Set())
    expect(await store.upsertActivities([])).toBe(0)

    const outdoor = createOutdoorRunActivity()
    const indoor = createIndoorWorkoutActivity()
    expect(await store.upsertActivities([outdoor, indoor])).toBe(2)

    // Mutating the caller's object must not mutate stored state
    outdoor.name = 'Mutated Caller Name'
    const fetched = await store.getActivityById(100001)
    expect(fetched?.name).toBe('Morning Run')

    // Mutating returned object must not mutate stored state
    if (fetched) {
      fetched.name = 'Mutated Fetched Name'
    }
    expect((await store.getActivityById(100001))?.name).toBe('Morning Run')

    // Upsert overwrites by run_id
    expect(await store.upsertActivities([createOutdoorRunActivity({ name: 'Updated Run', distance: 5200 })])).toBe(1)
    expect((await store.getActivityById(100001))?.name).toBe('Updated Run')
    expect((await store.getActivityById(100001))?.distance).toBe(5200)

    expect(await store.getExistingActivityIds()).toEqual(new Set([100001, 100002]))
    expect(await store.getLatestActivityDate()).toBe('2025-03-16T11:00:00Z')
  })

  it('filters and deterministically sorts activities in listActivities', async () => {
    const store = new InMemoryActivityStore({
      activities: [
        createOutdoorRunActivity({ run_id: 200, start_date_local: '2025-04-01T07:00:00', distance: 10000 }),
        createOutdoorRunActivity({ run_id: 100, start_date_local: '2025-03-15T08:30:00', distance: 5000 }),
        createOutdoorRunActivity({ run_id: 105, start_date_local: '2025-03-15T08:30:00', distance: 3000 }),
        createIndoorWorkoutActivity({ run_id: 150, start_date_local: '2025-03-20T19:00:00', type: 'Workout' }),
      ],
    })

    const all = await store.listActivities()
    expect(all.map(a => a.run_id)).toEqual([100, 105, 150, 200])

    expect((await store.listActivities({ ids: [200, 100] })).map(a => a.run_id)).toEqual([100, 200])
    expect((await store.listActivities({ idRange: { min: 101, max: 199 } })).map(a => a.run_id)).toEqual([105, 150])
    expect((await store.listActivities({ onlyRun: true })).map(a => a.run_id)).toEqual([100, 105, 200])
    expect((await store.listActivities({ types: ['Workout'] })).map(a => a.run_id)).toEqual([150])
    expect((await store.listActivities({ minDistance: 5000 })).map(a => a.run_id)).toEqual([100, 200])
    expect((await store.listActivities({ hasPolyline: true })).map(a => a.run_id)).toEqual([100, 105, 200])
    expect(
      (await store.listActivities({
        startDateLocalFrom: '2025-03-16T00:00:00',
        startDateLocalTo: '2025-03-31T23:59:59',
      })).map(a => a.run_id),
    ).toEqual([150])
  })

  it('cascades pruneActivitiesNotIn to flyby points and flyby queue', async () => {
    const store = new InMemoryActivityStore({
      activities: [createOutdoorRunActivity(), createIndoorWorkoutActivity()],
      flybyPoints: [...createOutdoorRunFlybyPoints(), ...createIndoorWorkoutFlybyPoints()],
    })
    await store.enqueueFlyby([100001, 100002])

    const pruned = await store.pruneActivitiesNotIn(new Set([100001]))
    expect(pruned).toBe(1)

    expect(await store.getActivityById(100001)).not.toBeNull()
    expect(await store.getActivityById(100002)).toBeNull()
    expect((await store.getFlybyPoints(100001)).length).toBeGreaterThan(0)
    expect(await store.getFlybyPoints(100002)).toEqual([])
    expect((await store.listPendingFlyby()).map(entry => entry.activityId)).toEqual([100001])
  })

  it('upserts flyby points by (activity_id, time_offset) and returns sorted points', async () => {
    const store = new InMemoryActivityStore()
    const points = createOutdoorRunFlybyPoints(500)
    expect(await store.storeFlybyPoints([])).toBe(0)
    expect(await store.storeFlybyPoints([points[2], points[0], points[1]])).toBe(3)

    // Update existing time_offset=300
    expect(await store.storeFlybyPoints([{ ...points[1], hr: 199 }])).toBe(1)

    const stored = await store.getFlybyPoints(500)
    expect(stored.map(p => p.time_offset)).toEqual([0, 300, 600])
    expect(stored[1].hr).toBe(199)
    expect(await store.getFlybyPoints(999)).toEqual([])
  })

  it('manages flyby queue enqueue deduplication and status transitions', async () => {
    let tick = 0
    const store = new InMemoryActivityStore({
      now: () => new Date(Date.UTC(2025, 2, 15, 0, 0, tick++)),
    })

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
  })

  it('implements vendor sync COALESCE upsert, filtering, retry-failed, and clear', async () => {
    const store = new InMemoryActivityStore({
      vendorSyncRows: FIXTURE_VENDOR_SYNC_ROWS,
    })

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
    expect(updated).toEqual({
      activityId: 100001,
      vendor: 'garmin',
      account: 'garmin_com',
      status: 'conflict',
      remoteActivityId: 900001,
      contentHash: 'sha256-fixture-100001',
      lastError: 'Remote mismatch',
      attemptCount: 1,
      nextRetryAt: null,
      uploadedAt: '2025-03-15T01:00:00Z',
      lastVerifiedAt: '2025-03-15T01:05:00Z',
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
  })

  it('closes idempotently and rejects operations after close', async () => {
    const store = new InMemoryActivityStore()
    expect(store.isClosed).toBe(false)
    await store.close()
    await store.close()
    expect(store.isClosed).toBe(true)

    await expect(store.listActivities()).rejects.toThrow(StorageError)
    await expect(store.upsertActivities([])).rejects.toThrow(StorageError)
    await expect(store.listVendorSyncRows({ vendor: 'garmin' })).rejects.toThrow(StorageError)
  })
})
