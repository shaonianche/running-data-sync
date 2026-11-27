import type { Activity, FlybyPoint, VendorSyncRow, VendorSyncStatus } from '../foundation/types.js'

/**
 * Inclusive `[min, max]` activity ID (`run_id`) range filter.
 */
export interface ActivityIdRange {
  readonly min: number
  readonly max: number
}

/**
 * Query filter for reading activities from an `ActivityReadRepository`.
 */
export interface ActivityQueryFilter {
  /** Restrict results to specific activity IDs (`run_id`). */
  readonly ids?: readonly number[]
  /** Restrict results to an inclusive `[min, max]` activity ID range. */
  readonly idRange?: ActivityIdRange
  /** Restrict results to activities matching any of these `type` values. */
  readonly types?: readonly string[]
  /** Shorthand for filtering to running activities (`type === 'Run'`). */
  readonly onlyRun?: boolean
  /** Inclusive minimum distance in meters. */
  readonly minDistance?: number
  /** When true, only return activities with a non-empty `summary_polyline`. */
  readonly hasPolyline?: boolean
  /** Inclusive lower bound on `start_date_local` (ISO-8601 timestamp/date string). */
  readonly startDateLocalFrom?: string
  /** Inclusive upper bound on `start_date_local` (ISO-8601 timestamp/date string). */
  readonly startDateLocalTo?: string
}

export type FlybyQueueStatus = 'pending' | 'rate_limited' | 'failed' | 'done' | (string & {})

/**
 * Pending item tracked in `activities_flyby_queue`.
 */
export interface FlybyQueueEntry {
  readonly activityId: number
  readonly status: Exclude<FlybyQueueStatus, 'done'>
  readonly lastError: string | null
  readonly updatedAt: string
}

/**
 * Filter criteria for querying `vendor_activity_sync` rows.
 */
export interface VendorSyncFilter {
  readonly vendor: string
  readonly account?: string
  readonly status?: VendorSyncStatus
}

/**
 * Input payload for upserting a `vendor_activity_sync` row.
 *
 * Conflict semantics match `vendor_activity_sync` SQL upsert behavior:
 * - `status`, `lastError`, and `nextRetryAt` overwrite existing values (defaulting optional errors/retry to `null`).
 * - `remoteActivityId`, `contentHash`, `attemptCount`, `uploadedAt`, and `lastVerifiedAt` preserve existing values when omitted or `null`.
 */
export interface VendorSyncUpsertInput {
  readonly activityId: number
  readonly vendor: string
  readonly account: string
  readonly status: VendorSyncStatus
  readonly remoteActivityId?: number | null
  readonly contentHash?: string | null
  readonly lastError?: string | null
  readonly attemptCount?: number | null
  readonly nextRetryAt?: string | Date | null
  readonly uploadedAt?: string | Date | null
  readonly lastVerifiedAt?: string | Date | null
}

/**
 * Read-only activity and flyby repository port.
 */
export interface ActivityReadRepository {
  /** Fetch a single activity by `run_id`, or `null` when not found. */
  getActivityById: (activityId: number) => Promise<Activity | null>
  /** List activities matching `filter`, ordered by `start_date_local` asc then `run_id` asc. */
  listActivities: (filter?: ActivityQueryFilter) => Promise<Activity[]>
  /** Return the set of all stored activity `run_id` values. */
  getExistingActivityIds: () => Promise<Set<number>>
  /** Return the maximum `start_date` across stored activities, or `null` when empty. */
  getLatestActivityDate: () => Promise<string | null>
  /** Return flyby points for `activityId`, ordered by `time_offset` ascending. */
  getFlybyPoints: (activityId: number) => Promise<FlybyPoint[]>
}

/**
 * Activity mutation repository port.
 */
export interface ActivityWriteRepository {
  /** Batch upsert activities keyed by `run_id`. Returns number of processed records. */
  upsertActivities: (activities: readonly Activity[]) => Promise<number>
  /**
   * Delete local activities whose `run_id` is absent from `remoteIds`,
   * cascading deletions to `activities_flyby` and `activities_flyby_queue`.
   * Returns the count of pruned activities.
   */
  pruneActivitiesNotIn: (remoteIds: ReadonlySet<number>) => Promise<number>
}

/**
 * Flyby telemetry and sync-queue repository port.
 */
export interface FlybyRepository {
  /** Upsert flyby points keyed by `(activity_id, time_offset)`. Returns number of processed points. */
  storeFlybyPoints: (points: readonly FlybyPoint[]) => Promise<number>
  /** Enqueue activity IDs for flyby sync (`ON CONFLICT DO NOTHING`). Returns newly enqueued count. */
  enqueueFlyby: (activityIds: readonly number[]) => Promise<number>
  /** List remaining queued flyby entries ordered by `activityId` ascending. */
  listPendingFlyby: () => Promise<FlybyQueueEntry[]>
  /**
   * Update queue status/error for an activity, or remove it from the queue when `status === 'done'`.
   * Updating an activity not currently in the queue is a no-op.
   */
  markFlybyStatus: (activityId: number, status: FlybyQueueStatus, lastError?: string | null) => Promise<void>
}

/**
 * Vendor synchronization tracking repository port (`vendor_activity_sync`).
 */
export interface VendorSyncRepository {
  /** Fetch a single vendor sync row by `(activityId, vendor, account)`, or `null` when absent. */
  getVendorSyncRow: (activityId: number, vendor: string, account: string) => Promise<VendorSyncRow | null>
  /** List vendor sync rows matching `filter`, ordered by `activityId` asc then `account` asc. */
  listVendorSyncRows: (filter: VendorSyncFilter) => Promise<VendorSyncRow[]>
  /** Insert or update a vendor sync row with COALESCE preservation for nullable metadata fields. */
  upsertVendorSyncRow: (input: VendorSyncUpsertInput) => Promise<void>
  /**
   * Reset `'failed'` rows for `vendor` (and optional `account`) back to `'pending'`,
   * clearing `lastError` and `nextRetryAt`. Returns the count of reset rows.
   */
  retryFailedVendorSync: (vendor: string, account?: string) => Promise<number>
  /**
   * Delete vendor sync rows for `vendor` (and optional `account`), used by `--force` resyncs.
   * Returns the count of deleted rows.
   */
  clearVendorSyncRows: (vendor: string, account?: string) => Promise<number>
}

/**
 * Composed storage port implemented by `DuckDBActivityStore` and `InMemoryActivityStore`.
 */
export interface ActivityStorePort
  extends ActivityReadRepository,
  ActivityWriteRepository,
  FlybyRepository,
  VendorSyncRepository {
  /** Release underlying storage resources. Calling multiple times is safe and idempotent. */
  close: () => Promise<void>
}
