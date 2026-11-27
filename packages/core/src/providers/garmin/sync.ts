import type { ActivityStorePort } from '../../contracts/index.js'
import type { Activity } from '../../foundation/index.js'
import type {
  GarminAccount,
  GarminActivityRecord,
  ReconcileGarminOptions,
  ReconcileGarminResult,
  SyncStoreToGarminFailure,
  SyncStoreToGarminOptions,
  SyncStoreToGarminResult,
} from './types.js'
import { computeActivityContentHash, findMatchingGarminActivity } from './matching.js'
import { redactGarminMessage, wrapGarminLogger } from './redaction.js'
import {
  DEFAULT_DISTANCE_TOLERANCE_M,
  DEFAULT_DURATION_TOLERANCE_SEC,
  DEFAULT_MATCH_WINDOW_SEC,
  GARMIN_SYNCED_STATUSES,
  GARMIN_VENDOR,
} from './types.js'
import { resolveGarminClient } from './upload-files.js'

function parseRemoteActivityId(record: GarminActivityRecord): number | null {
  const raw = record.activityId
  if (raw === null || raw === undefined || raw === '') {
    return null
  }
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function sortByRunIdAsc(activities: readonly Activity[]): Activity[] {
  return [...activities].sort((a, b) => a.run_id - b.run_id)
}

interface ReconcileRowsInput {
  readonly store: ActivityStorePort
  readonly activities: readonly Activity[]
  readonly garminActivities: readonly GarminActivityRecord[]
  readonly account: GarminAccount
  readonly matchWindowSec: number
  readonly distanceToleranceM: number
  readonly durationToleranceSec: number
  readonly now: () => number
}

async function reconcileGarminRows(input: ReconcileRowsInput): Promise<ReconcileGarminResult> {
  const existingRows = await input.store.listVendorSyncRows({
    vendor: GARMIN_VENDOR,
    account: input.account,
  })
  const stateMap = new Map(existingRows.map(row => [row.activityId, row]))

  const garminIds = new Set<number>()
  for (const activity of input.garminActivities) {
    const id = parseRemoteActivityId(activity)
    if (id !== null) {
      garminIds.add(id)
    }
  }

  const reservedRemoteIds = new Set<number>()
  let matched = 0
  let missingRemote = 0
  let unchanged = 0

  for (const activity of input.activities) {
    const activityId = activity.run_id
    const state = stateMap.get(activityId)

    let matchedRemoteId: number | null = null
    if (
      state?.remoteActivityId !== null
      && state?.remoteActivityId !== undefined
      && garminIds.has(state.remoteActivityId)
      && !reservedRemoteIds.has(state.remoteActivityId)
    ) {
      matchedRemoteId = state.remoteActivityId
    }
    else {
      matchedRemoteId = findMatchingGarminActivity(activity, input.garminActivities, {
        matchWindowSec: input.matchWindowSec,
        distanceToleranceM: input.distanceToleranceM,
        durationToleranceSec: input.durationToleranceSec,
        reservedActivityIds: reservedRemoteIds,
      })
    }

    if (matchedRemoteId !== null) {
      reservedRemoteIds.add(matchedRemoteId)
      await input.store.upsertVendorSyncRow({
        activityId,
        vendor: GARMIN_VENDOR,
        account: input.account,
        status: 'synced',
        remoteActivityId: matchedRemoteId,
        lastError: null,
        lastVerifiedAt: new Date(input.now()).toISOString(),
      })
      matched += 1
      continue
    }

    if (state && GARMIN_SYNCED_STATUSES.has(state.status)) {
      await input.store.upsertVendorSyncRow({
        activityId,
        vendor: GARMIN_VENDOR,
        account: input.account,
        status: 'missing_remote',
        remoteActivityId: state.remoteActivityId,
        contentHash: state.contentHash,
        lastError: 'Remote activity not found during reconcile.',
        attemptCount: state.attemptCount,
      })
      missingRemote += 1
      continue
    }

    unchanged += 1
  }

  return {
    account: input.account,
    totalLocal: input.activities.length,
    totalRemote: input.garminActivities.length,
    matched,
    missingRemote,
    unchanged,
  }
}

/**
 * Reconcile local store activities against remote Garmin Connect activities,
 * updating `vendor_activity_sync` rows to `synced` or `missing_remote`.
 */
export async function reconcileGarmin(options: ReconcileGarminOptions): Promise<ReconcileGarminResult> {
  const client = resolveGarminClient(options)
  const secretValues = options.credentials ? [options.credentials.secretString] : []
  const logger = wrapGarminLogger(options.logger, 'garmin.reconcile', () => secretValues)
  const now = options.now ?? Date.now
  const matchWindowSec = options.matchWindowSec ?? DEFAULT_MATCH_WINDOW_SEC
  const distanceToleranceM = options.distanceToleranceM ?? DEFAULT_DISTANCE_TOLERANCE_M
  const durationToleranceSec = options.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC

  const activities = sortByRunIdAsc(await options.store.listActivities(options.filter))
  if (activities.length === 0) {
    logger.info(`No local activities found for account=${client.account}.`)
    return {
      account: client.account,
      totalLocal: 0,
      totalRemote: 0,
      matched: 0,
      missingRemote: 0,
      unchanged: 0,
    }
  }

  const garminActivities = await client.fetchAllActivities()
  logger.info(`Loaded ${garminActivities.length} Garmin activities for reconcile (${client.account}).`)

  const result = await reconcileGarminRows({
    store: options.store,
    activities,
    garminActivities,
    account: client.account,
    matchWindowSec,
    distanceToleranceM,
    durationToleranceSec,
    now,
  })

  logger.info(
    `Reconciled ${result.totalLocal} local activities against ${result.totalRemote} remote (${client.account}): matched=${result.matched}, missing_remote=${result.missingRemote}.`,
  )
  return result
}

/**
 * Idempotently sync local activities from `ActivityStorePort` to Garmin Connect.
 *
 * Supports SHA-256 content-hash skipping, outdoor distance-first and indoor duration-first
 * remote deduplication, reserved-ID conflict detection, `--use-fake-garmin-device` / `--fix-hr`
 * adaptation via `ActivityFormatPort`, and `--force` remote wipe & re-upload.
 */
export async function syncStoreToGarmin(
  options: SyncStoreToGarminOptions,
): Promise<SyncStoreToGarminResult> {
  const client = resolveGarminClient(options)
  const secretValues = options.credentials ? [options.credentials.secretString] : []
  const logger = wrapGarminLogger(options.logger, 'garmin.sync', () => secretValues)
  const now = options.now ?? Date.now
  const account = client.account
  const force = options.force ?? false
  const useFakeGarminDevice = options.useFakeGarminDevice ?? false
  const fixHr = options.fixHr ?? false
  const matchWindowSec = options.matchWindowSec ?? DEFAULT_MATCH_WINDOW_SEC
  const distanceToleranceM = options.distanceToleranceM ?? DEFAULT_DISTANCE_TOLERANCE_M
  const durationToleranceSec = options.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC

  const activities = sortByRunIdAsc(await options.store.listActivities(options.filter))
  if (activities.length === 0) {
    logger.info(`No local activities found for account=${account}.`)
    return {
      account,
      totalLocal: 0,
      deletedRemote: 0,
      synced: 0,
      skippedUnchanged: 0,
      skippedExists: 0,
      conflicts: 0,
      failed: 0,
      noFlybyTypeCounts: {},
      failures: [],
    }
  }

  let garminActivities = await client.fetchAllActivities()
  let deletedRemote = 0

  if (force) {
    for (const remote of garminActivities) {
      const remoteId = parseRemoteActivityId(remote)
      if (remoteId === null) {
        continue
      }
      await client.deleteActivity(remoteId)
      deletedRemote += 1
    }
    logger.info(`Force mode enabled: deleted ${deletedRemote} remote Garmin activities for ${account}.`)
    garminActivities = []

    await options.store.clearVendorSyncRows(GARMIN_VENDOR, account)
    logger.info(`Force mode enabled: cleared local sync status for ${account}.`)
  }
  else {
    await reconcileGarminRows({
      store: options.store,
      activities,
      garminActivities,
      account,
      matchWindowSec,
      distanceToleranceM,
      durationToleranceSec,
      now,
    })
  }

  const initialRows = await options.store.listVendorSyncRows({
    vendor: GARMIN_VENDOR,
    account,
  })
  const stateMap = new Map(initialRows.map(row => [row.activityId, row]))
  const reservedRemoteOwners = new Map<number, number>()
  for (const row of initialRows) {
    if (GARMIN_SYNCED_STATUSES.has(row.status) && row.remoteActivityId !== null) {
      reservedRemoteOwners.set(row.remoteActivityId, row.activityId)
    }
  }

  const remoteIdSet = new Set<number>()
  for (const remote of garminActivities) {
    const id = parseRemoteActivityId(remote)
    if (id !== null) {
      remoteIdSet.add(id)
    }
  }

  const noFlybyTypeCounts: Record<string, number> = {}
  const failures: SyncStoreToGarminFailure[] = []
  let synced = 0
  let skippedUnchanged = 0
  let skippedExists = 0
  let conflicts = 0
  let failed = 0

  for (const activity of activities) {
    const activityId = activity.run_id
    const flybyPoints = await options.store.getFlybyPoints(activityId)
    if (flybyPoints.length === 0) {
      const activityType = activity.type || 'Unknown'
      noFlybyTypeCounts[activityType] = (noFlybyTypeCounts[activityType] ?? 0) + 1
    }

    const contentHash = computeActivityContentHash(activity, flybyPoints)
    const state = stateMap.get(activityId)

    if (!force && state && GARMIN_SYNCED_STATUSES.has(state.status) && state.contentHash === contentHash) {
      skippedUnchanged += 1
      continue
    }

    const reservedByOthers = new Set<number>()
    for (const [remoteId, ownerId] of reservedRemoteOwners.entries()) {
      if (ownerId !== activityId) {
        reservedByOthers.add(remoteId)
      }
    }

    try {
      if (!force) {
        // Already reconciled to a remote Garmin activity before any local hash was recorded.
        if (
          state?.remoteActivityId !== null
          && state?.remoteActivityId !== undefined
          && state.contentHash === null
          && remoteIdSet.has(state.remoteActivityId)
          && !reservedByOthers.has(state.remoteActivityId)
        ) {
          reservedRemoteOwners.set(state.remoteActivityId, activityId)
          await options.store.upsertVendorSyncRow({
            activityId,
            vendor: GARMIN_VENDOR,
            account,
            status: 'skipped_exists',
            remoteActivityId: state.remoteActivityId,
            contentHash,
            lastError: null,
            attemptCount: state.attemptCount,
            lastVerifiedAt: new Date(now()).toISOString(),
          })
          skippedExists += 1
          const updated = await options.store.getVendorSyncRow(activityId, GARMIN_VENDOR, account)
          if (updated) {
            stateMap.set(activityId, updated)
          }
          continue
        }

        const existingGarminId = findMatchingGarminActivity(activity, garminActivities, {
          matchWindowSec,
          distanceToleranceM,
          durationToleranceSec,
          reservedActivityIds: reservedByOthers,
        })

        if (existingGarminId !== null) {
          reservedRemoteOwners.set(existingGarminId, activityId)
          await options.store.upsertVendorSyncRow({
            activityId,
            vendor: GARMIN_VENDOR,
            account,
            status: 'skipped_exists',
            remoteActivityId: existingGarminId,
            contentHash,
            lastError: null,
            attemptCount: state?.attemptCount ?? 0,
            lastVerifiedAt: new Date(now()).toISOString(),
          })
          skippedExists += 1
          const updated = await options.store.getVendorSyncRow(activityId, GARMIN_VENDOR, account)
          if (updated) {
            stateMap.set(activityId, updated)
          }
          continue
        }

        // If an equivalent remote activity exists but has already been claimed by another local activity,
        // record a conflict instead of uploading a duplicate.
        const reservedMatch = findMatchingGarminActivity(activity, garminActivities, {
          matchWindowSec,
          distanceToleranceM,
          durationToleranceSec,
        })
        if (reservedMatch !== null && reservedByOthers.has(reservedMatch)) {
          await options.store.upsertVendorSyncRow({
            activityId,
            vendor: GARMIN_VENDOR,
            account,
            status: 'conflict',
            remoteActivityId: reservedMatch,
            contentHash,
            lastError: 'Matched remote activity already reserved by another local activity.',
            attemptCount: state?.attemptCount ?? 0,
          })
          conflicts += 1
          const updated = await options.store.getVendorSyncRow(activityId, GARMIN_VENDOR, account)
          if (updated) {
            stateMap.set(activityId, updated)
          }
          continue
        }
      }

      await options.store.upsertVendorSyncRow({
        activityId,
        vendor: GARMIN_VENDOR,
        account,
        status: 'uploading',
        contentHash,
        attemptCount: state?.attemptCount ?? 0,
      })

      let fitBytes = options.formatPort.buildFit(activity, flybyPoints, options.fitBuildOptions)
      if (useFakeGarminDevice || fixHr) {
        fitBytes = options.formatPort.adaptFit(fitBytes, {
          useFakeGarminDevice,
          fixHeartRate: fixHr,
        })
      }

      const uploadResult = await client.uploadActivity(`${activityId}.fit`, fitBytes)
      let remoteActivityId = uploadResult.remoteActivityId

      // Some Garmin responses (e.g. HTTP 204) omit the created activity ID; re-fetch recent activities as fallback.
      if (remoteActivityId === null) {
        const recentActivities = await client.fetchAllActivities({ pageSize: 50, maxPages: 2 })
        garminActivities = recentActivities
        remoteIdSet.clear()
        for (const remote of recentActivities) {
          const id = parseRemoteActivityId(remote)
          if (id !== null) {
            remoteIdSet.add(id)
          }
        }
        remoteActivityId = findMatchingGarminActivity(activity, recentActivities, {
          matchWindowSec,
          distanceToleranceM,
          durationToleranceSec,
          reservedActivityIds: reservedByOthers,
        })
      }

      if (remoteActivityId !== null) {
        reservedRemoteOwners.set(remoteActivityId, activityId)
        remoteIdSet.add(remoteActivityId)
      }

      const nowIso = new Date(now()).toISOString()
      if (uploadResult.duplicate) {
        await options.store.upsertVendorSyncRow({
          activityId,
          vendor: GARMIN_VENDOR,
          account,
          status: 'skipped_exists',
          remoteActivityId,
          contentHash,
          lastError: null,
          attemptCount: state?.attemptCount ?? 0,
          lastVerifiedAt: nowIso,
        })
        skippedExists += 1
        logger.info(`Activity ${activityId} already exists on ${account} (duplicate upload response).`)
      }
      else {
        await options.store.upsertVendorSyncRow({
          activityId,
          vendor: GARMIN_VENDOR,
          account,
          status: 'synced',
          remoteActivityId,
          contentHash,
          lastError: null,
          attemptCount: state?.attemptCount ?? 0,
          uploadedAt: nowIso,
          lastVerifiedAt: nowIso,
        })
        synced += 1
        logger.info(`Synced activity ${activityId} to ${account}.`)
      }
    }
    catch (err) {
      const nextAttempt = (state?.attemptCount ?? 0) + 1
      const safeMessage = redactGarminMessage(
        err instanceof Error ? err.message : String(err),
        secretValues,
      )
      await options.store.upsertVendorSyncRow({
        activityId,
        vendor: GARMIN_VENDOR,
        account,
        status: 'failed',
        contentHash,
        lastError: safeMessage,
        attemptCount: nextAttempt,
      })
      failed += 1
      failures.push({ activityId, error: safeMessage })
      logger.error(`Failed syncing activity ${activityId} to ${account}: ${safeMessage}`)
    }

    const refreshedRow = await options.store.getVendorSyncRow(activityId, GARMIN_VENDOR, account)
    if (refreshedRow) {
      stateMap.set(activityId, refreshedRow)
    }
  }

  return {
    account,
    totalLocal: activities.length,
    deletedRemote,
    synced,
    skippedUnchanged,
    skippedExists,
    conflicts,
    failed,
    noFlybyTypeCounts,
    failures,
  }
}
