import type { Logger } from '../../foundation/logger.js'
import type {
  SleepFn,
  StravaSummaryActivity,
  SyncStravaActivityOptions,
  SyncStravaActivityResult,
  SyncStravaOptions,
  SyncStravaResult,
} from './types.js'
import { FlybySyncError, RateLimitError } from '../../foundation/errors.js'
import { createLogger, redactSensitiveMessage } from '../../foundation/logger.js'
import { toUnixEpochSeconds } from './client.js'
import { DEFAULT_NOMINATIM_CONCURRENCY, NominatimGeocoder } from './geocoder.js'
import { convertStreamsToFlybyPoints, mapStravaActivities, resolveActivityTypeAndSubtype } from './mapper.js'
import { DEFAULT_FLYBY_STREAM_TYPES } from './types.js'

export const DEFAULT_FLYBY_MAX_RETRIES = 3
export const DEFAULT_FLYBY_REQUEST_DELAY_MS = 500
export const DEFAULT_FLYBY_BASE_BACKOFF_MS = 60_000
export const DEFAULT_FLYBY_MAX_BACKOFF_MS = 900_000

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createRedactingLogger(logger: Logger, redact?: (text: string) => string): Logger {
  const scrub = (value: string): string => {
    const base = redactSensitiveMessage(value)
    return redact ? redact(base) : base
  }
  const scrubData = (data?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!data) {
      return undefined
    }
    const output: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(data)) {
      output[key] = typeof val === 'string' ? scrub(val) : val
    }
    return output
  }

  return {
    debug: (message, data) => logger.debug(scrub(message), scrubData(data)),
    info: (message, data) => logger.info(scrub(message), scrubData(data)),
    warn: (message, data) => logger.warn(scrub(message), scrubData(data)),
    error: (message, data) => logger.error(scrub(message), scrubData(data)),
  }
}

function scrubErrorMessage(error: unknown, redact?: (text: string) => string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const base = redactSensitiveMessage(raw)
  return redact ? redact(base) : base
}

function computeFlybyBackoffMs(
  error: RateLimitError,
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  if (error.retryAfter !== null) {
    return Math.max(0, error.retryAfter * 1000)
  }
  return Math.min(baseBackoffMs * (2 ** attempt), maxBackoffMs)
}

function isRunActivity(activity: StravaSummaryActivity): boolean {
  const { type } = resolveActivityTypeAndSubtype(activity)
  return type === 'Run'
}

/**
 * Synchronize Strava activities and queued Streams/Flyby telemetry into an injected storage port.
 * Supports incremental sync (`after` latest activity timestamp), `--force` full refresh,
 * `--only-run` filtering, `--prune` stale local activity cleanup, and resumable rate-limited flyby queues.
 */
export async function syncStravaToStore(options: SyncStravaOptions): Promise<SyncStravaResult> {
  const {
    store,
    client,
    force = false,
    onlyRun = false,
    prune = false,
  } = options

  const redact = client.redactSecrets ? (text: string) => client.redactSecrets!(text) : undefined
  const logger = createRedactingLogger(options.logger ?? createLogger('strava.sync'), redact)
  const sleep: SleepFn = options.sleep ?? defaultSleep
  const now = options.now ?? (() => new Date())
  const geocoder = options.geocoder !== undefined ? options.geocoder : new NominatimGeocoder({ logger })
  const geocoderConcurrency = options.geocoderConcurrency ?? DEFAULT_NOMINATIM_CONCURRENCY
  const streamTypes = options.streamTypes ?? DEFAULT_FLYBY_STREAM_TYPES
  const flybyMaxRetries = Math.max(1, options.flybyMaxRetries ?? DEFAULT_FLYBY_MAX_RETRIES)
  const flybyRequestDelayMs = Math.max(0, options.flybyRequestDelayMs ?? DEFAULT_FLYBY_REQUEST_DELAY_MS)
  const flybyBaseBackoffMs = Math.max(0, options.flybyBaseBackoffMs ?? DEFAULT_FLYBY_BASE_BACKOFF_MS)
  const flybyMaxBackoffMs = Math.max(flybyBaseBackoffMs, options.flybyMaxBackoffMs ?? DEFAULT_FLYBY_MAX_BACKOFF_MS)

  await client.refreshAccessToken()

  logger.info('Starting Strava sync', { force, onlyRun, prune })

  let usedIncrementalWindow = false
  let fetchedActivities: StravaSummaryActivity[]

  if (force) {
    fetchedActivities = await client.listActivities({ before: now() })
  }
  else {
    const latestDate = await store.getLatestActivityDate()
    if (latestDate) {
      usedIncrementalWindow = true
      const afterSeconds = toUnixEpochSeconds(latestDate)
      fetchedActivities = await client.listActivities({ after: afterSeconds })
    }
    else {
      fetchedActivities = await client.listActivities({ before: now() })
    }
  }

  let prunedActivities = 0
  if (prune) {
    // Prune requires a full remote ID snapshot independent of incremental sync windows.
    const fullSnapshot = usedIncrementalWindow
      ? await client.listActivities()
      : fetchedActivities
    const remoteIds = new Set<number>(fullSnapshot.map(activity => Math.trunc(activity.id)))
    prunedActivities = await store.pruneActivitiesNotIn(remoteIds)
    if (prunedActivities > 0) {
      logger.info('Pruned local activities missing on Strava', { prunedActivities })
    }
    else {
      logger.info('Prune completed with no stale local activities')
    }
  }

  const existingIds = await store.getExistingActivityIds()
  let activitiesToProcess = force
    ? fetchedActivities
    : fetchedActivities.filter(activity => !existingIds.has(Math.trunc(activity.id)))

  if (onlyRun) {
    activitiesToProcess = activitiesToProcess.filter(isRunActivity)
  }

  logger.info('Filtered Strava activities for sync', {
    fetchedActivities: fetchedActivities.length,
    activitiesToProcess: activitiesToProcess.length,
  })

  let syncedActivities = 0
  let enqueuedFlyby = 0

  if (activitiesToProcess.length > 0) {
    const mapped = await mapStravaActivities(activitiesToProcess, {
      geocoder,
      geocoderConcurrency,
      logger,
    })
    syncedActivities = await store.upsertActivities(mapped)
    enqueuedFlyby = await store.enqueueFlyby(mapped.map(activity => activity.run_id))
    logger.info('Synced Strava activities and enqueued flyby items', {
      syncedActivities,
      enqueuedFlyby,
    })
  }
  else {
    logger.info('No new Strava activities to upsert')
  }

  const pendingQueue = await store.listPendingFlyby()
  let flybySyncedActivities = 0
  let flybySkippedActivities = 0
  let flybyFailedActivities = 0
  let flybyPointsStored = 0
  let stoppedByRateLimit = false

  if (pendingQueue.length > 0) {
    logger.info('Processing pending flyby queue', { queueLength: pendingQueue.length })
  }

  for (const entry of pendingQueue) {
    const activityId = entry.activityId

    if (!force) {
      const existingFlyby = await store.getFlybyPoints(activityId)
      if (existingFlyby.length > 0) {
        logger.info('Flyby data already exists for activity; marking done', {
          activityId,
          existingPoints: existingFlyby.length,
        })
        await store.markFlybyStatus(activityId, 'done')
        flybySkippedActivities += 1
        continue
      }
    }

    let rateLimitExhausted = false

    for (let attempt = 0; attempt < flybyMaxRetries; attempt += 1) {
      try {
        if (flybyRequestDelayMs > 0) {
          await sleep(flybyRequestDelayMs)
        }

        const streams = await client.getActivityStreams(activityId, {
          keys: streamTypes,
          resolution: 'high',
          maxRetries: 0,
        })

        const points = convertStreamsToFlybyPoints(activityId, streams)
        if (points.length > 0) {
          const storedCount = await store.storeFlybyPoints(points)
          flybyPointsStored += storedCount
          flybySyncedActivities += 1
          logger.info('Stored flyby telemetry points', { activityId, storedCount })
        }
        else {
          flybySkippedActivities += 1
          logger.info('Activity has no meaningful stream data; skipping flyby persistence', { activityId })
        }

        await store.markFlybyStatus(activityId, 'done')
        break
      }
      catch (error) {
        if (error instanceof RateLimitError) {
          const errorMessage = scrubErrorMessage(error, redact)
          await store.markFlybyStatus(activityId, 'rate_limited', errorMessage)

          if (attempt < flybyMaxRetries - 1) {
            const waitMs = computeFlybyBackoffMs(error, attempt, flybyBaseBackoffMs, flybyMaxBackoffMs)
            logger.warn('Rate limit exceeded during flyby sync; backing off before retry', {
              activityId,
              attempt: attempt + 1,
              maxRetries: flybyMaxRetries,
              waitMs,
            })
            await sleep(waitMs)
            continue
          }

          logger.warn('Rate limit persists for flyby sync; leaving checkpoint in queue', {
            activityId,
            attempt: attempt + 1,
            maxRetries: flybyMaxRetries,
          })
          stoppedByRateLimit = true
          rateLimitExhausted = true
          break
        }

        const flybyError = error instanceof FlybySyncError
          ? error
          : new FlybySyncError(`Flyby sync failed for activity ${activityId}: ${scrubErrorMessage(error, redact)}`, {
            cause: error,
          })
        const errorMessage = scrubErrorMessage(flybyError, redact)
        await store.markFlybyStatus(activityId, 'failed', errorMessage)
        flybyFailedActivities += 1
        logger.warn('Flyby sync failed for activity; keeping item in queue', {
          activityId,
          error: errorMessage,
        })
        break
      }
    }

    if (rateLimitExhausted) {
      break
    }
  }

  const remainingFlybyQueue = (await store.listPendingFlyby()).length

  return {
    fetchedActivities: fetchedActivities.length,
    syncedActivities,
    prunedActivities,
    enqueuedFlyby,
    flybySyncedActivities,
    flybySkippedActivities,
    flybyFailedActivities,
    flybyPointsStored,
    remainingFlybyQueue,
    stoppedByRateLimit,
  }
}

/**
 * Synchronize a single Strava activity and its flyby streams into an injected storage port.
 */
export async function syncStravaActivityToStore(
  options: SyncStravaActivityOptions,
): Promise<SyncStravaActivityResult> {
  const {
    store,
    client,
    activityId,
    force = false,
  } = options

  const redact = client.redactSecrets ? (text: string) => client.redactSecrets!(text) : undefined
  const logger = createRedactingLogger(options.logger ?? createLogger('strava.sync'), redact)
  const sleep: SleepFn = options.sleep ?? defaultSleep
  const geocoder = options.geocoder !== undefined ? options.geocoder : new NominatimGeocoder({ logger })
  const streamTypes = options.streamTypes ?? DEFAULT_FLYBY_STREAM_TYPES
  const flybyMaxRetries = Math.max(1, options.flybyMaxRetries ?? DEFAULT_FLYBY_MAX_RETRIES)
  const flybyBaseBackoffMs = Math.max(0, options.flybyBaseBackoffMs ?? DEFAULT_FLYBY_BASE_BACKOFF_MS)
  const flybyMaxBackoffMs = Math.max(flybyBaseBackoffMs, options.flybyMaxBackoffMs ?? DEFAULT_FLYBY_MAX_BACKOFF_MS)

  await client.refreshAccessToken()

  const detail = await client.getActivity(activityId)
  const [mapped] = await mapStravaActivities([detail], { geocoder, logger })
  await store.upsertActivities([mapped])

  if (!force) {
    const existingFlyby = await store.getFlybyPoints(activityId)
    if (existingFlyby.length > 0) {
      await store.markFlybyStatus(activityId, 'done')
      return {
        activityId,
        synced: true,
        flybyPointsStored: existingFlyby.length,
      }
    }
  }

  for (let attempt = 0; attempt < flybyMaxRetries; attempt += 1) {
    try {
      const streams = await client.getActivityStreams(activityId, {
        keys: streamTypes,
        resolution: 'high',
        maxRetries: 0,
      })
      const points = convertStreamsToFlybyPoints(activityId, streams)
      const flybyPointsStored = points.length > 0 ? await store.storeFlybyPoints(points) : 0
      await store.markFlybyStatus(activityId, 'done')
      return {
        activityId,
        synced: true,
        flybyPointsStored,
      }
    }
    catch (error) {
      if (error instanceof RateLimitError && attempt < flybyMaxRetries - 1) {
        const waitMs = computeFlybyBackoffMs(error, attempt, flybyBaseBackoffMs, flybyMaxBackoffMs)
        logger.warn('Rate limit exceeded syncing single activity flyby; backing off', {
          activityId,
          waitMs,
          attempt: attempt + 1,
        })
        await sleep(waitMs)
        continue
      }
      throw error
    }
  }

  return {
    activityId,
    synced: true,
    flybyPointsStored: 0,
  }
}
