import type { ActivityFileFormat } from '../contracts/formats.js'
import type { ObjectStorePort } from '../contracts/object-store.js'
import { createHash } from 'node:crypto'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'

export type WorkoutArtifactFormat = ActivityFileFormat

/**
 * Supported private object-store namespaces.
 *
 * `artifacts` stores content-hashed workout files (`FIT`/`GPX`/`TCX`).
 * `raw/strava` is reserved as an extensible boundary for optional raw Strava
 * payload archiving and is not enabled by default.
 */
export type PrivateArtifactNamespace = 'artifacts' | 'raw/strava'

const SUPPORTED_WORKOUT_FORMATS: ReadonlySet<string> = new Set<WorkoutArtifactFormat>([
  'fit',
  'gpx',
  'tcx',
])

const WORKOUT_CONTENT_TYPES: Readonly<Record<WorkoutArtifactFormat, string>> = {
  fit: 'application/vnd.ant.fit',
  gpx: 'application/gpx+xml',
  tcx: 'application/vnd.garmin.tcx+xml',
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const WORKOUT_KEY_PATTERN = /^artifacts\/([1-9]\d*|0)\/([0-9a-f]{64})\.(fit|gpx|tcx)$/
const RAW_STRAVA_KEY_PATTERN = /^raw\/strava\/([1-9]\d*|0)\/([0-9a-f]{64})\.json\.gz$/

/**
 * Immutable reference metadata describing a stored private workout artifact.
 */
export interface WorkoutArtifactReference {
  readonly key: string
  readonly activityId: number
  readonly format: WorkoutArtifactFormat
  readonly sha256: string
  readonly sizeBytes: number
  readonly etag?: string
  readonly contentType: string
  readonly createdAt?: Date
}

/**
 * Result returned by {@link PrivateArtifactStore.putWorkoutArtifact}.
 *
 * `deduplicated` is `true` when the identical content-hashed key already
 * existed in the object store (`PreconditionFailedError` on `ifNoneMatch: '*'`).
 */
export interface PutWorkoutArtifactResult {
  readonly reference: WorkoutArtifactReference
  readonly deduplicated: boolean
}

/**
 * Result returned by {@link PrivateArtifactStore.getWorkoutArtifact} and
 * {@link PrivateArtifactStore.getWorkoutArtifactByKey}.
 */
export interface GetWorkoutArtifactResult {
  readonly reference: WorkoutArtifactReference
  readonly body: Uint8Array
}

/**
 * Optional callback invoked only after the object upload has succeeded
 * (upload-first, commit-second ordering).
 */
export type CommitArtifactReferenceFn = (
  reference: WorkoutArtifactReference,
  meta: { readonly deduplicated: boolean },
) => Promise<void> | void

export interface PutWorkoutArtifactOptions {
  readonly activityId: number
  readonly format: WorkoutArtifactFormat
  readonly body: Uint8Array
  readonly contentType?: string
  /**
   * Optional persistence hook called strictly after the object is durably
   * present in `ObjectStorePort`. If the hook throws, the error is surfaced
   * while the content-hashed object remains safely idempotent for retries.
   */
  readonly onCommitReference?: CommitArtifactReferenceFn
}

export interface ParsedWorkoutArtifactKey {
  readonly activityId: number
  readonly sha256: string
  readonly format: WorkoutArtifactFormat
}

export interface ParsedRawStravaArtifactKey {
  readonly activityId: number
  readonly sha256: string
}

export function computeArtifactSha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

export function assertValidActivityId(activityId: number): number {
  if (!Number.isSafeInteger(activityId) || activityId < 0) {
    throw new ConfigurationError(`Invalid activityId for artifact key: ${String(activityId)}`)
  }
  return activityId
}

export function assertValidWorkoutFormat(format: string): WorkoutArtifactFormat {
  if (!SUPPORTED_WORKOUT_FORMATS.has(format)) {
    throw new ConfigurationError(`Unsupported workout artifact format "${format}". Expected fit, gpx, or tcx.`)
  }
  return format as WorkoutArtifactFormat
}

export function assertValidSha256(sha256: string): string {
  const normalized = sha256.trim().toLowerCase()
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new ConfigurationError(`Invalid SHA-256 digest: "${sha256}". Expected 64 lowercase hex characters.`)
  }
  return normalized
}

export function resolveWorkoutContentType(format: WorkoutArtifactFormat): string {
  return WORKOUT_CONTENT_TYPES[format]
}

/**
 * Builds the canonical private object key for a workout file:
 * `artifacts/{activity_id}/{sha256}.{ext}`
 */
export function buildWorkoutArtifactKey(
  activityId: number,
  sha256: string,
  format: WorkoutArtifactFormat,
): string {
  const validId = assertValidActivityId(activityId)
  const validHash = assertValidSha256(sha256)
  const validFormat = assertValidWorkoutFormat(format)
  return `artifacts/${validId}/${validHash}.${validFormat}`
}

/**
 * Parses a canonical workout artifact key (`artifacts/{activity_id}/{sha256}.{ext}`).
 * Returns `null` if the key does not match the expected layout.
 */
export function parseWorkoutArtifactKey(key: string): ParsedWorkoutArtifactKey | null {
  const match = WORKOUT_KEY_PATTERN.exec(key)
  if (!match) {
    return null
  }
  const activityId = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(activityId)) {
    return null
  }
  return {
    activityId,
    sha256: match[2],
    format: match[3] as WorkoutArtifactFormat,
  }
}

/**
 * Extensible key builder reserved for optional raw Strava payload archiving:
 * `raw/strava/{activity_id}/{sha256}.json.gz`
 *
 * Note: Raw Strava JSON archiving is not enabled by default; this helper only
 * defines the key layout boundary for future opt-in support.
 */
export function buildRawStravaArtifactKey(activityId: number, sha256: string): string {
  const validId = assertValidActivityId(activityId)
  const validHash = assertValidSha256(sha256)
  return `raw/strava/${validId}/${validHash}.json.gz`
}

/**
 * Parses a reserved raw Strava archive key (`raw/strava/{activity_id}/{sha256}.json.gz`).
 */
export function parseRawStravaArtifactKey(key: string): ParsedRawStravaArtifactKey | null {
  const match = RAW_STRAVA_KEY_PATTERN.exec(key)
  if (!match) {
    return null
  }
  const activityId = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(activityId)) {
    return null
  }
  return {
    activityId,
    sha256: match[2],
  }
}

/**
 * Content-hashed private object storage for synthesized or archived
 * `FIT`/`GPX`/`TCX` workout artifacts backed by {@link ObjectStorePort}.
 *
 * Guarantees:
 * - Deterministic content-addressed keys (`artifacts/{activity_id}/{sha256}.{ext}`).
 * - Conditional create-once writes (`ifNoneMatch: '*'`); `PreconditionFailedError`
 *   is treated as an idempotent cache hit.
 * - Upload-first, commit-second ordering via optional `onCommitReference`.
 * - Decoupled from Garmin upload and local file export.
 */
export class PrivateArtifactStore {
  private readonly objectStore: ObjectStorePort

  constructor(objectStore: ObjectStorePort) {
    this.objectStore = objectStore
  }

  async putWorkoutArtifact(options: PutWorkoutArtifactOptions): Promise<PutWorkoutArtifactResult> {
    const activityId = assertValidActivityId(options.activityId)
    const format = assertValidWorkoutFormat(options.format)
    const body = options.body
    const sha256 = computeArtifactSha256(body)
    const key = buildWorkoutArtifactKey(activityId, sha256, format)
    const contentType = options.contentType ?? resolveWorkoutContentType(format)

    let deduplicated = false
    let etag: string | undefined

    try {
      const putResult = await this.objectStore.put(key, body, {
        ifNoneMatch: '*',
        contentType,
      })
      etag = putResult.etag
    }
    catch (error) {
      if (error instanceof PreconditionFailedError) {
        deduplicated = true
        const head = await this.objectStore.head(key)
        etag = head?.etag
      }
      else {
        throw error
      }
    }

    const reference: WorkoutArtifactReference = {
      key,
      activityId,
      format,
      sha256,
      sizeBytes: body.byteLength,
      ...(etag !== undefined ? { etag } : {}),
      contentType,
    }

    if (options.onCommitReference) {
      await options.onCommitReference(reference, { deduplicated })
    }

    return {
      reference,
      deduplicated,
    }
  }

  async headWorkoutArtifact(
    activityId: number,
    sha256: string,
    format: WorkoutArtifactFormat,
  ): Promise<WorkoutArtifactReference | null> {
    const validId = assertValidActivityId(activityId)
    const validHash = assertValidSha256(sha256)
    const validFormat = assertValidWorkoutFormat(format)
    const key = buildWorkoutArtifactKey(validId, validHash, validFormat)

    const head = await this.objectStore.head(key)
    if (!head) {
      return null
    }

    return {
      key,
      activityId: validId,
      format: validFormat,
      sha256: validHash,
      sizeBytes: head.sizeBytes,
      etag: head.etag,
      contentType: head.contentType ?? resolveWorkoutContentType(validFormat),
    }
  }

  async getWorkoutArtifact(
    activityId: number,
    sha256: string,
    format: WorkoutArtifactFormat,
  ): Promise<GetWorkoutArtifactResult | null> {
    const validId = assertValidActivityId(activityId)
    const validHash = assertValidSha256(sha256)
    const validFormat = assertValidWorkoutFormat(format)
    const key = buildWorkoutArtifactKey(validId, validHash, validFormat)

    const result = await this.objectStore.get(key)
    if (!result) {
      return null
    }

    const actualSha256 = computeArtifactSha256(result.body)
    if (actualSha256 !== validHash) {
      throw new StorageError(
        `Integrity mismatch for workout artifact "${key}": expected sha256 ${validHash}, got ${actualSha256}.`,
      )
    }

    return {
      reference: {
        key,
        activityId: validId,
        format: validFormat,
        sha256: validHash,
        sizeBytes: result.body.byteLength,
        etag: result.etag,
        contentType: result.contentType ?? resolveWorkoutContentType(validFormat),
      },
      body: result.body,
    }
  }

  async getWorkoutArtifactByKey(key: string): Promise<GetWorkoutArtifactResult | null> {
    const parsed = parseWorkoutArtifactKey(key)
    if (!parsed) {
      throw new ConfigurationError(`Invalid workout artifact key: "${key}"`)
    }
    return this.getWorkoutArtifact(parsed.activityId, parsed.sha256, parsed.format)
  }

  async listWorkoutArtifacts(activityId?: number): Promise<WorkoutArtifactReference[]> {
    const prefix = activityId === undefined
      ? 'artifacts/'
      : `artifacts/${assertValidActivityId(activityId)}/`

    const items = await this.objectStore.list(prefix)
    const refs: WorkoutArtifactReference[] = []

    for (const item of items) {
      const parsed = parseWorkoutArtifactKey(item.key)
      if (!parsed) {
        continue
      }
      refs.push({
        key: item.key,
        activityId: parsed.activityId,
        format: parsed.format,
        sha256: parsed.sha256,
        sizeBytes: item.sizeBytes,
        etag: item.etag,
        contentType: resolveWorkoutContentType(parsed.format),
        ...(item.lastModified !== undefined ? { createdAt: item.lastModified } : {}),
      })
    }

    return refs
  }
}
