import type {
  ActivityFileFormat,
  GpxSummaryExtensions,
  ParseableActivityFormat,
  ParsedTrack,
} from '../../contracts/index.js'
import type { Activity, FlybyPoint } from '../../foundation/index.js'
import type {
  GarminActivityRecord,
  GarminActivitySummary,
  SyncGarminToStoreFailure,
  SyncGarminToStoreOptions,
  SyncGarminToStoreResult,
} from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { redactGarminMessage, wrapGarminLogger } from './redaction.js'
import { DEFAULT_DOWNLOAD_CONCURRENCY } from './types.js'
import { resolveGarminClient } from './upload-files.js'

function isZipPayload(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4B
}

function parseActivityId(record: GarminActivityRecord): number | null {
  const raw = record.activityId
  if (raw === null || raw === undefined || raw === '') {
    return null
  }
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Extract GPX summary extensions (`distance`, `averageHr`, `averageSpeed`)
 * from a Garmin Connect activity summary payload.
 */
export function extractGarminSummaryExtensions(
  summary: GarminActivitySummary | null | undefined,
): GpxSummaryExtensions {
  const dto = summary?.summaryDTO
  if (!dto || typeof dto !== 'object') {
    return {}
  }
  return {
    distance: asNullableNumber(dto.distance),
    averageHr: asNullableNumber(dto.averageHR),
    averageSpeed: asNullableNumber(dto.averageSpeed),
  }
}

function hasSummaryExtensions(summary: GpxSummaryExtensions): boolean {
  return (
    (summary.distance !== undefined && summary.distance !== null)
    || (summary.averageHr !== undefined && summary.averageHr !== null)
    || (summary.averageSpeed !== undefined && summary.averageSpeed !== null)
  )
}

/**
 * Execute an async worker over `items` with bounded concurrency, preserving input order.
 */
export async function runWithConcurrency<T, R>(
  concurrency: number,
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  const results = Array.from<R>({ length: items.length })
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex
      if (currentIndex >= items.length) {
        return
      }
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return results
}

function parsedTrackToActivity(
  activityId: number,
  parsed: ParsedTrack,
  title: string | undefined,
  summary: GpxSummaryExtensions,
): Activity {
  return {
    run_id: activityId,
    name: title?.trim() || parsed.name || `Garmin ${activityId}`,
    distance: parsed.distance > 0 ? parsed.distance : (summary.distance ?? parsed.distance),
    moving_time: parsed.movingTime,
    elapsed_time: parsed.elapsedTime,
    type: parsed.type,
    subtype: parsed.subtype,
    start_date: parsed.startDate,
    start_date_local: parsed.startDateLocal,
    summary_polyline: parsed.summaryPolyline,
    average_heartrate: parsed.averageHeartrate ?? summary.averageHr ?? null,
    average_speed: parsed.averageSpeed > 0 ? parsed.averageSpeed : (summary.averageSpeed ?? parsed.averageSpeed),
    elevation_gain: parsed.elevationGain,
  }
}

function parsedTrackToFlybyPoints(activityId: number, parsed: ParsedTrack): FlybyPoint[] {
  return parsed.points.map((point, index) => ({
    activity_id: activityId,
    time_offset: point.timeOffset ?? index,
    lat: point.lat,
    lng: point.lng,
    alt: point.alt ?? null,
    pace: point.speed ?? 0,
    hr: point.hr ?? null,
    distance: point.distance ?? null,
    cadence: point.cadence ?? null,
    watts: point.watts ?? null,
  }))
}

async function maybePersistDownload(
  outputDirs: SyncGarminToStoreOptions['outputDirs'],
  activityId: number,
  fileType: ActivityFileFormat,
  parseFormat: ParseableActivityFormat,
  payload: Uint8Array | string,
): Promise<void> {
  if (!outputDirs) {
    return
  }
  const targetDir = fileType === 'fit'
    ? outputDirs.fitDir
    : fileType === 'tcx'
      ? outputDirs.tcxDir
      : outputDirs.gpxDir

  if (!targetDir) {
    return
  }

  await fs.mkdir(targetDir, { recursive: true })
  const ext = parseFormat === 'zip' ? 'zip' : fileType
  const filePath = path.join(targetDir, `${activityId}.${ext}`)
  await fs.writeFile(filePath, payload)
}

/**
 * Incrementally fetch Garmin Connect activities, download `gpx`/`tcx`/`fit` files with
 * bounded concurrency, inject GPX summary extensions, parse tracks through `ActivityFormatPort`,
 * and persist `Activity` + `FlybyPoint[]` into `ActivityStorePort`.
 */
export async function syncGarminToStore(
  options: SyncGarminToStoreOptions,
): Promise<SyncGarminToStoreResult> {
  const client = resolveGarminClient(options)
  const secretValues = options.credentials ? [options.credentials.secretString] : []
  const logger = wrapGarminLogger(options.logger, 'garmin.download', () => secretValues)
  const fileType: ActivityFileFormat = options.fileType ?? 'gpx'
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY))

  const existingIds = await options.store.getExistingActivityIds()
  const remoteActivities = await client.fetchAllActivities({
    pageSize: options.pageSize,
    maxPages: options.maxPages,
    onlyRunning: options.onlyRunning,
  })

  const uniqueNewActivities: Array<{ readonly activityId: number, readonly fallbackTitle: string | undefined }> = []
  const seenRemoteIds = new Set<number>()
  let skippedExisting = 0

  for (const remote of remoteActivities) {
    const activityId = parseActivityId(remote)
    if (activityId === null || seenRemoteIds.has(activityId)) {
      continue
    }
    seenRemoteIds.add(activityId)
    if (existingIds.has(activityId)) {
      skippedExisting += 1
      continue
    }
    uniqueNewActivities.push({
      activityId,
      fallbackTitle: typeof remote.activityName === 'string' ? remote.activityName : undefined,
    })
  }

  logger.info(
    `Found ${seenRemoteIds.size} Garmin activities (${skippedExisting} existing, ${uniqueNewActivities.length} new to download).`,
  )

  if (uniqueNewActivities.length === 0) {
    return {
      account: client.account,
      fileType,
      fetched: seenRemoteIds.size,
      skippedExisting,
      downloaded: 0,
      ingested: 0,
      flybyPointsStored: 0,
      failures: [],
    }
  }

  // Step 1: Fetch summaries with bounded concurrency
  const summaryMeta = await runWithConcurrency(concurrency, uniqueNewActivities, async (item) => {
    try {
      const summary = await client.getActivitySummary(item.activityId)
      const title = typeof summary.activityName === 'string' && summary.activityName.trim().length > 0
        ? summary.activityName
        : item.fallbackTitle
      return {
        activityId: item.activityId,
        title,
        extensions: extractGarminSummaryExtensions(summary),
      }
    }
    catch (err) {
      const safeError = redactGarminMessage(
        err instanceof Error ? err.message : String(err),
        secretValues,
      )
      logger.warn(`Could not retrieve summary for Garmin activity ${item.activityId}: ${safeError}`)
      return {
        activityId: item.activityId,
        title: item.fallbackTitle,
        extensions: {} as GpxSummaryExtensions,
      }
    }
  })

  // Step 2: Download, enrich GPX summaries, and parse tracks with bounded concurrency
  const activitiesToUpsert: Activity[] = []
  const flybyToStore: FlybyPoint[] = []
  const failures: SyncGarminToStoreFailure[] = []
  let downloaded = 0

  await runWithConcurrency(concurrency, summaryMeta, async (meta) => {
    try {
      const rawBytes = await client.downloadActivity(meta.activityId, fileType)
      downloaded += 1

      let parseInput: Uint8Array | string = rawBytes
      let parseFormat: ParseableActivityFormat = fileType

      if (fileType === 'gpx' && hasSummaryExtensions(meta.extensions)) {
        parseInput = options.formatPort.injectGpxSummaryExtensions(rawBytes, meta.extensions)
      }
      else if (fileType === 'fit') {
        parseFormat = isZipPayload(rawBytes) ? 'zip' : 'fit'
      }

      await maybePersistDownload(options.outputDirs, meta.activityId, fileType, parseFormat, parseInput)

      const parsed = await options.formatPort.parseTrack(parseInput, {
        format: parseFormat,
        fileName: `${meta.activityId}.${parseFormat}`,
      })

      activitiesToUpsert.push(parsedTrackToActivity(meta.activityId, parsed, meta.title, meta.extensions))
      flybyToStore.push(...parsedTrackToFlybyPoints(meta.activityId, parsed))
    }
    catch (err) {
      const safeError = redactGarminMessage(
        err instanceof Error ? err.message : String(err),
        secretValues,
      )
      failures.push({ activityId: meta.activityId, error: safeError })
      logger.error(`Failed downloading/ingesting Garmin activity ${meta.activityId}: ${safeError}`)
    }
  })

  const ingested = activitiesToUpsert.length > 0
    ? await options.store.upsertActivities(activitiesToUpsert)
    : 0
  const flybyPointsStored = flybyToStore.length > 0
    ? await options.store.storeFlybyPoints(flybyToStore)
    : 0

  return {
    account: client.account,
    fileType,
    fetched: seenRemoteIds.size,
    skippedExisting,
    downloaded,
    ingested,
    flybyPointsStored,
    failures,
  }
}
