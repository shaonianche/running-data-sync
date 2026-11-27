import type {
  ActivityQueryFilter,
  ActivityStorePort,
  FlybyQueueEntry,
  FlybyQueueStatus,
  VendorSyncFilter,
  VendorSyncUpsertInput,
} from '../contracts/storage.js'
import type { Activity, FlybyPoint, VendorSyncRow } from '../foundation/types.js'
import { StorageError } from '../foundation/errors.js'

export interface InMemoryActivityStoreOptions {
  readonly activities?: readonly Activity[]
  readonly flybyPoints?: readonly FlybyPoint[]
  readonly vendorSyncRows?: readonly VendorSyncRow[]
  readonly now?: () => Date
}

function cloneActivity(activity: Activity): Activity {
  return { ...activity }
}

function cloneFlybyPoint(point: FlybyPoint): FlybyPoint {
  return { ...point }
}

function cloneTimestamp(value: string | Date | null): string | Date | null {
  if (value instanceof Date) {
    return new Date(value.getTime())
  }
  return value
}

function cloneVendorSyncRow(row: VendorSyncRow): VendorSyncRow {
  return {
    ...row,
    nextRetryAt: cloneTimestamp(row.nextRetryAt),
    uploadedAt: cloneTimestamp(row.uploadedAt),
    lastVerifiedAt: cloneTimestamp(row.lastVerifiedAt),
  }
}

function vendorKey(activityId: number, vendor: string, account: string): string {
  return `${activityId}\u0000${vendor}\u0000${account}`
}

function compareDateStrings(a: string, b: string): number {
  const timeA = Date.parse(a)
  const timeB = Date.parse(b)
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
    return timeA - timeB
  }
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

/**
 * Pure in-memory implementation of `ActivityStorePort` for unit testing Wave 2/3 modules
 * without DuckDB native dependencies.
 */
export class InMemoryActivityStore implements ActivityStorePort {
  private readonly activities = new Map<number, Activity>()
  private readonly flybyByActivity = new Map<number, Map<number, FlybyPoint>>()
  private readonly flybyQueue = new Map<number, FlybyQueueEntry>()
  private readonly vendorSync = new Map<string, VendorSyncRow>()
  private readonly now: () => Date
  private closed = false

  constructor(options: InMemoryActivityStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())

    if (options.activities) {
      for (const activity of options.activities) {
        this.activities.set(activity.run_id, cloneActivity(activity))
      }
    }

    if (options.flybyPoints) {
      for (const point of options.flybyPoints) {
        let pointsMap = this.flybyByActivity.get(point.activity_id)
        if (!pointsMap) {
          pointsMap = new Map<number, FlybyPoint>()
          this.flybyByActivity.set(point.activity_id, pointsMap)
        }
        pointsMap.set(point.time_offset, cloneFlybyPoint(point))
      }
    }

    if (options.vendorSyncRows) {
      for (const row of options.vendorSyncRows) {
        this.vendorSync.set(vendorKey(row.activityId, row.vendor, row.account), cloneVendorSyncRow(row))
      }
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('InMemoryActivityStore is closed')
    }
  }

  async getActivityById(activityId: number): Promise<Activity | null> {
    this.assertOpen()
    const existing = this.activities.get(activityId)
    return existing ? cloneActivity(existing) : null
  }

  async listActivities(filter: ActivityQueryFilter = {}): Promise<Activity[]> {
    this.assertOpen()

    const idSet = filter.ids ? new Set(filter.ids) : null
    const typeSet = filter.types ? new Set(filter.types) : null

    const results: Activity[] = []
    for (const activity of this.activities.values()) {
      if (idSet && !idSet.has(activity.run_id)) {
        continue
      }
      if (filter.idRange && (activity.run_id < filter.idRange.min || activity.run_id > filter.idRange.max)) {
        continue
      }
      if (typeSet && !typeSet.has(activity.type)) {
        continue
      }
      if (filter.onlyRun && activity.type !== 'Run') {
        continue
      }
      if (filter.minDistance !== undefined && activity.distance < filter.minDistance) {
        continue
      }
      if (filter.hasPolyline && (!activity.summary_polyline || activity.summary_polyline.length === 0)) {
        continue
      }
      if (filter.startDateLocalFrom !== undefined && activity.start_date_local < filter.startDateLocalFrom) {
        continue
      }
      if (filter.startDateLocalTo !== undefined && activity.start_date_local > filter.startDateLocalTo) {
        continue
      }
      results.push(cloneActivity(activity))
    }

    results.sort((a, b) => {
      if (a.start_date_local < b.start_date_local) {
        return -1
      }
      if (a.start_date_local > b.start_date_local) {
        return 1
      }
      return a.run_id - b.run_id
    })

    return results
  }

  async getExistingActivityIds(): Promise<Set<number>> {
    this.assertOpen()
    return new Set(this.activities.keys())
  }

  async getLatestActivityDate(): Promise<string | null> {
    this.assertOpen()
    let latest: string | null = null
    for (const activity of this.activities.values()) {
      if (latest === null || compareDateStrings(activity.start_date, latest) > 0) {
        latest = activity.start_date
      }
    }
    return latest
  }

  async getFlybyPoints(activityId: number): Promise<FlybyPoint[]> {
    this.assertOpen()
    const pointsMap = this.flybyByActivity.get(activityId)
    if (!pointsMap) {
      return []
    }
    return Array.from(pointsMap.values())
      .sort((a, b) => a.time_offset - b.time_offset)
      .map(cloneFlybyPoint)
  }

  async upsertActivities(activities: readonly Activity[]): Promise<number> {
    this.assertOpen()
    if (activities.length === 0) {
      return 0
    }
    for (const activity of activities) {
      this.activities.set(activity.run_id, cloneActivity(activity))
    }
    return activities.length
  }

  async pruneActivitiesNotIn(remoteIds: ReadonlySet<number>): Promise<number> {
    this.assertOpen()
    const staleIds: number[] = []
    for (const runId of this.activities.keys()) {
      if (!remoteIds.has(runId)) {
        staleIds.push(runId)
      }
    }
    for (const staleId of staleIds) {
      this.flybyByActivity.delete(staleId)
      this.flybyQueue.delete(staleId)
      this.activities.delete(staleId)
    }
    return staleIds.length
  }

  async storeFlybyPoints(points: readonly FlybyPoint[]): Promise<number> {
    this.assertOpen()
    if (points.length === 0) {
      return 0
    }
    for (const point of points) {
      let pointsMap = this.flybyByActivity.get(point.activity_id)
      if (!pointsMap) {
        pointsMap = new Map<number, FlybyPoint>()
        this.flybyByActivity.set(point.activity_id, pointsMap)
      }
      pointsMap.set(point.time_offset, cloneFlybyPoint(point))
    }
    return points.length
  }

  async enqueueFlyby(activityIds: readonly number[]): Promise<number> {
    this.assertOpen()
    if (activityIds.length === 0) {
      return 0
    }
    const timestamp = this.now().toISOString()
    let added = 0
    for (const activityId of activityIds) {
      if (!this.flybyQueue.has(activityId)) {
        this.flybyQueue.set(activityId, {
          activityId,
          status: 'pending',
          lastError: null,
          updatedAt: timestamp,
        })
        added += 1
      }
    }
    return added
  }

  async listPendingFlyby(): Promise<FlybyQueueEntry[]> {
    this.assertOpen()
    return Array.from(this.flybyQueue.values())
      .sort((a, b) => a.activityId - b.activityId)
      .map(entry => ({ ...entry }))
  }

  async markFlybyStatus(
    activityId: number,
    status: FlybyQueueStatus,
    lastError: string | null = null,
  ): Promise<void> {
    this.assertOpen()
    if (status === 'done') {
      this.flybyQueue.delete(activityId)
      return
    }
    const existing = this.flybyQueue.get(activityId)
    if (!existing) {
      return
    }
    if (existing.status === status && existing.lastError === lastError) {
      return
    }
    this.flybyQueue.set(activityId, {
      activityId,
      status,
      lastError,
      updatedAt: this.now().toISOString(),
    })
  }

  async getVendorSyncRow(activityId: number, vendor: string, account: string): Promise<VendorSyncRow | null> {
    this.assertOpen()
    const row = this.vendorSync.get(vendorKey(activityId, vendor, account))
    return row ? cloneVendorSyncRow(row) : null
  }

  async listVendorSyncRows(filter: VendorSyncFilter): Promise<VendorSyncRow[]> {
    this.assertOpen()
    const results: VendorSyncRow[] = []
    for (const row of this.vendorSync.values()) {
      if (row.vendor !== filter.vendor) {
        continue
      }
      if (filter.account !== undefined && row.account !== filter.account) {
        continue
      }
      if (filter.status !== undefined && row.status !== filter.status) {
        continue
      }
      results.push(cloneVendorSyncRow(row))
    }

    results.sort((a, b) => {
      if (a.activityId !== b.activityId) {
        return a.activityId - b.activityId
      }
      if (a.account < b.account) {
        return -1
      }
      if (a.account > b.account) {
        return 1
      }
      return 0
    })

    return results
  }

  async upsertVendorSyncRow(input: VendorSyncUpsertInput): Promise<void> {
    this.assertOpen()
    const key = vendorKey(input.activityId, input.vendor, input.account)
    const existing = this.vendorSync.get(key)

    const merged: VendorSyncRow = {
      activityId: input.activityId,
      vendor: input.vendor,
      account: input.account,
      status: input.status,
      remoteActivityId: input.remoteActivityId ?? existing?.remoteActivityId ?? null,
      contentHash: input.contentHash ?? existing?.contentHash ?? null,
      lastError: input.lastError ?? null,
      attemptCount: input.attemptCount ?? existing?.attemptCount ?? 0,
      nextRetryAt: cloneTimestamp(input.nextRetryAt ?? null),
      uploadedAt: cloneTimestamp(input.uploadedAt ?? existing?.uploadedAt ?? null),
      lastVerifiedAt: cloneTimestamp(input.lastVerifiedAt ?? existing?.lastVerifiedAt ?? null),
    }

    this.vendorSync.set(key, merged)
  }

  async retryFailedVendorSync(vendor: string, account?: string): Promise<number> {
    this.assertOpen()
    let retried = 0
    for (const [key, row] of this.vendorSync.entries()) {
      if (row.vendor !== vendor) {
        continue
      }
      if (account !== undefined && row.account !== account) {
        continue
      }
      if (row.status !== 'failed') {
        continue
      }
      this.vendorSync.set(key, {
        ...row,
        status: 'pending',
        lastError: null,
        nextRetryAt: null,
      })
      retried += 1
    }
    return retried
  }

  async clearVendorSyncRows(vendor: string, account?: string): Promise<number> {
    this.assertOpen()
    let deleted = 0
    for (const [key, row] of this.vendorSync.entries()) {
      if (row.vendor !== vendor) {
        continue
      }
      if (account !== undefined && row.account !== account) {
        continue
      }
      this.vendorSync.delete(key)
      deleted += 1
    }
    return deleted
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
