import type { ObjectStorePort } from '../contracts/object-store.js'
import type { Logger } from '../foundation/logger.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { createLogger } from '../foundation/logger.js'

export const DEFAULT_MANIFEST_KEY = 'manifest.json'
export const DEFAULT_SNAPSHOT_PREFIX = 'snapshots/'
export const MANIFEST_SCHEMA_VERSION = 1

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const BINARY_CONTENT_TYPE = 'application/octet-stream'

/**
 * Authoritative pointer to the current immutable DuckDB snapshot in object storage.
 *
 * Concurrency boundary:
 * - GitHub Actions `concurrency` serializes scheduled/manual CI runs.
 * - `If-Match` on `manifest.json` is the cross-runner safety net (for example,
 *   local CLI vs. GitHub Actions) so concurrent writers fail with
 *   {@link PreconditionFailedError} instead of silently overwriting each other.
 *
 * Security boundary:
 * - `sha256` verifies snapshot integrity on download and upload; it does NOT
 *   encrypt the snapshot. Confidentiality relies on private bucket access controls
 *   and bucket-scoped credentials.
 */
export interface SnapshotManifest {
  readonly schemaVersion: 1
  readonly currentKey: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly updatedAt: string
  readonly previousKey?: string
}

export interface SnapshotManagerOptions {
  readonly store: ObjectStorePort
  readonly manifestKey?: string
  readonly snapshotPrefix?: string
  readonly logger?: Logger
  readonly now?: () => Date
}

export interface PullSnapshotOptions {
  /** Local destination path for the downloaded `.duckdb` file. */
  readonly targetPath: string
}

export interface PullSnapshotResult {
  readonly targetPath: string
  readonly manifest: SnapshotManifest
  readonly manifestEtag: string
  readonly sha256: string
  readonly sizeBytes: number
}

export interface BootstrapSnapshotOptions {
  /** Path to the checkpointed, closed local `.duckdb` file to upload as the first snapshot. */
  readonly sourcePath: string
}

export interface BootstrapSnapshotResult {
  readonly snapshotKey: string
  readonly manifest: SnapshotManifest
  readonly manifestEtag: string
  readonly sha256: string
  readonly sizeBytes: number
}

export interface PushSnapshotOptions {
  /** Path to the checkpointed, closed local `.duckdb` file. */
  readonly sourcePath: string
  /** ETag of `manifest.json` returned by the preceding {@link pullSnapshot} call. */
  readonly expectedManifestEtag: string
  /** SHA-256 of the previously pulled snapshot; if unchanged, push is a no-op. */
  readonly previousSha256?: string
  /** Snapshot key currently referenced by `manifest.json` (becomes `previousKey`). */
  readonly previousKey?: string
  /** Optional retention count: when provided, prunes older snapshots after manifest flip. */
  readonly retainCount?: number
}

export interface PushSnapshotResult {
  readonly uploaded: boolean
  readonly snapshotKey: string
  readonly manifest: SnapshotManifest | null
  readonly manifestEtag: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly prunedKeys: readonly string[]
}

export interface RollbackSnapshotOptions {
  /** Target snapshot key to restore. Defaults to `manifest.previousKey`. */
  readonly targetKey?: string
}

export interface RollbackSnapshotResult {
  readonly previousCurrentKey: string
  readonly restoredKey: string
  readonly manifest: SnapshotManifest
  readonly manifestEtag: string
}

export interface PruneSnapshotsOptions {
  /** Minimum number of most recent snapshots to keep (always keeps `currentKey` and `previousKey`). */
  readonly retainCount: number
}

export interface PruneSnapshotsResult {
  readonly keptKeys: readonly string[]
  readonly deletedKeys: readonly string[]
  readonly protectedKeys: readonly string[]
}

export interface SnapshotStatusResult {
  readonly initialized: boolean
  readonly manifest: SnapshotManifest | null
  readonly manifestEtag: string | null
  readonly snapshotCount: number
  readonly snapshots: readonly string[]
}

export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function normalizeSnapshotPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '')
  if (!trimmed) {
    throw new ConfigurationError('Snapshot prefix must be a non-empty string.')
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export function formatSnapshotTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

export function buildSnapshotKey(
  sha256: string,
  date: Date = new Date(),
  prefix: string = DEFAULT_SNAPSHOT_PREFIX,
): string {
  const normalizedPrefix = normalizeSnapshotPrefix(prefix)
  const shortHash = sha256.slice(0, 12)
  if (!/^[0-9a-f]{12}$/i.test(shortHash)) {
    throw new ConfigurationError(`Invalid sha256 digest for snapshot key: "${sha256}"`)
  }
  return `${normalizedPrefix}data-${formatSnapshotTimestamp(date)}-${shortHash.toLowerCase()}.duckdb`
}

export function parseSnapshotManifest(raw: Uint8Array): SnapshotManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
  }
  catch (error) {
    throw new StorageError('Remote manifest.json is not valid JSON.', { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new StorageError('Remote manifest.json must be a JSON object.')
  }

  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new StorageError(`Unsupported manifest schemaVersion: ${String(record.schemaVersion)}`)
  }
  if (typeof record.currentKey !== 'string' || record.currentKey.trim().length === 0) {
    throw new StorageError('Remote manifest.json is missing a valid currentKey.')
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.sha256)) {
    throw new StorageError('Remote manifest.json is missing a valid sha256 digest.')
  }
  if (typeof record.sizeBytes !== 'number' || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) {
    throw new StorageError('Remote manifest.json is missing a valid sizeBytes integer.')
  }
  if (typeof record.updatedAt !== 'string' || record.updatedAt.trim().length === 0) {
    throw new StorageError('Remote manifest.json is missing a valid updatedAt timestamp.')
  }
  if (record.previousKey !== undefined && (typeof record.previousKey !== 'string' || record.previousKey.trim().length === 0)) {
    throw new StorageError('Remote manifest.json has an invalid previousKey.')
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    currentKey: record.currentKey,
    sha256: record.sha256.toLowerCase(),
    sizeBytes: record.sizeBytes,
    updatedAt: record.updatedAt,
    ...(record.previousKey !== undefined ? { previousKey: record.previousKey } : {}),
  }
}

function serializeManifest(manifest: SnapshotManifest): Uint8Array {
  return new Uint8Array(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
}

function readLocalSnapshotFile(sourcePath: string): Uint8Array {
  if (!fs.existsSync(sourcePath)) {
    throw new StorageError(`Local DuckDB file does not exist: "${sourcePath}"`)
  }
  const walPath = `${sourcePath}.wal`
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new StorageError(
      `Non-empty WAL sidecar detected at "${walPath}". Close the DuckDB connection cleanly (CHECKPOINT) before uploading.`,
    )
  }
  return new Uint8Array(fs.readFileSync(sourcePath))
}

function writeFileAtomically(targetPath: string, bytes: Uint8Array): void {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(tempPath, bytes)
    fs.renameSync(tempPath, targetPath)
  }
  catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.rmSync(tempPath, { force: true })
      }
      catch {
        // Ignore temp file cleanup error.
      }
    }
    throw error
  }
}

export class DuckDBSnapshotManager {
  private readonly store: ObjectStorePort
  private readonly manifestKey: string
  private readonly snapshotPrefix: string
  private readonly logger: Logger
  private readonly now: () => Date

  constructor(options: SnapshotManagerOptions) {
    this.store = options.store
    this.manifestKey = options.manifestKey?.trim() || DEFAULT_MANIFEST_KEY
    this.snapshotPrefix = normalizeSnapshotPrefix(options.snapshotPrefix ?? DEFAULT_SNAPSHOT_PREFIX)
    this.logger = options.logger ?? createLogger('snapshot')
    this.now = options.now ?? (() => new Date())
  }

  async status(): Promise<SnapshotStatusResult> {
    const [manifestObj, listed] = await Promise.all([
      this.store.get(this.manifestKey),
      this.store.list(this.snapshotPrefix),
    ])

    const snapshots = listed
      .map(item => item.key)
      .filter(key => key.endsWith('.duckdb'))
      .sort((a, b) => b.localeCompare(a))

    if (!manifestObj) {
      return {
        initialized: false,
        manifest: null,
        manifestEtag: null,
        snapshotCount: snapshots.length,
        snapshots,
      }
    }

    const manifest = parseSnapshotManifest(manifestObj.body)
    return {
      initialized: true,
      manifest,
      manifestEtag: manifestObj.etag,
      snapshotCount: snapshots.length,
      snapshots,
    }
  }

  async pull(options: PullSnapshotOptions): Promise<PullSnapshotResult> {
    const manifestObj = await this.store.get(this.manifestKey)
    if (!manifestObj) {
      throw new StorageError(
        `Remote manifest "${this.manifestKey}" does not exist. Run bootstrap first to initialize remote snapshots.`,
      )
    }

    const manifest = parseSnapshotManifest(manifestObj.body)
    const snapshotObj = await this.store.get(manifest.currentKey)
    if (!snapshotObj) {
      throw new StorageError(
        `Snapshot "${manifest.currentKey}" referenced by "${this.manifestKey}" was not found in object storage.`,
      )
    }

    const actualSha256 = computeSha256Hex(snapshotObj.body)
    if (actualSha256 !== manifest.sha256) {
      throw new StorageError(
        `Snapshot integrity check failed for "${manifest.currentKey}": expected sha256 ${manifest.sha256}, got ${actualSha256}.`,
      )
    }

    if (snapshotObj.body.byteLength !== manifest.sizeBytes) {
      throw new StorageError(
        `Snapshot size mismatch for "${manifest.currentKey}": expected ${manifest.sizeBytes} bytes, got ${snapshotObj.body.byteLength}.`,
      )
    }

    const targetPath = path.resolve(options.targetPath)
    writeFileAtomically(targetPath, snapshotObj.body)

    this.logger.info(`Pulled DuckDB snapshot ${manifest.currentKey} (${manifest.sizeBytes} bytes, sha256=${actualSha256.slice(0, 12)}).`)

    return {
      targetPath,
      manifest,
      manifestEtag: manifestObj.etag,
      sha256: actualSha256,
      sizeBytes: snapshotObj.body.byteLength,
    }
  }

  async bootstrap(options: BootstrapSnapshotOptions): Promise<BootstrapSnapshotResult> {
    const bytes = readLocalSnapshotFile(path.resolve(options.sourcePath))
    const sha256 = computeSha256Hex(bytes)
    const now = this.now()
    const snapshotKey = buildSnapshotKey(sha256, now, this.snapshotPrefix)

    const existingManifest = await this.store.head(this.manifestKey)
    if (existingManifest) {
      throw new PreconditionFailedError(
        this.manifestKey,
        `Cannot bootstrap: remote manifest "${this.manifestKey}" already exists (ETag ${existingManifest.etag}). Use pull/push instead.`,
      )
    }

    await this.store.put(snapshotKey, bytes, {
      ifNoneMatch: '*',
      contentType: BINARY_CONTENT_TYPE,
    })

    const manifest: SnapshotManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      currentKey: snapshotKey,
      sha256,
      sizeBytes: bytes.byteLength,
      updatedAt: now.toISOString(),
    }

    try {
      const putResult = await this.store.put(this.manifestKey, serializeManifest(manifest), {
        ifNoneMatch: '*',
        contentType: JSON_CONTENT_TYPE,
      })
      this.logger.info(`Bootstrapped DuckDB snapshot ${snapshotKey} (${bytes.byteLength} bytes).`)
      return {
        snapshotKey,
        manifest,
        manifestEtag: putResult.etag,
        sha256,
        sizeBytes: bytes.byteLength,
      }
    }
    catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new PreconditionFailedError(
          this.manifestKey,
          `Bootstrap conflict: "${this.manifestKey}" was created concurrently by another writer. Pull the latest snapshot instead.`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async push(options: PushSnapshotOptions): Promise<PushSnapshotResult> {
    const expectedEtag = options.expectedManifestEtag.trim()
    if (!expectedEtag) {
      throw new ConfigurationError('push() requires a non-empty expectedManifestEtag from pull().')
    }

    const bytes = readLocalSnapshotFile(path.resolve(options.sourcePath))
    const sha256 = computeSha256Hex(bytes)

    if (options.previousSha256 && sha256 === options.previousSha256.toLowerCase()) {
      this.logger.info(`Local DuckDB snapshot unchanged (sha256=${sha256.slice(0, 12)}); skipping upload.`)
      return {
        uploaded: false,
        snapshotKey: options.previousKey ?? '',
        manifest: null,
        manifestEtag: expectedEtag,
        sha256,
        sizeBytes: bytes.byteLength,
        prunedKeys: [],
      }
    }

    const now = this.now()
    const snapshotKey = buildSnapshotKey(sha256, now, this.snapshotPrefix)

    await this.store.put(snapshotKey, bytes, {
      ifNoneMatch: '*',
      contentType: BINARY_CONTENT_TYPE,
    })

    const manifest: SnapshotManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      currentKey: snapshotKey,
      sha256,
      sizeBytes: bytes.byteLength,
      updatedAt: now.toISOString(),
      ...(options.previousKey ? { previousKey: options.previousKey } : {}),
    }

    let manifestEtag: string
    try {
      const putResult = await this.store.put(this.manifestKey, serializeManifest(manifest), {
        ifMatch: expectedEtag,
        contentType: JSON_CONTENT_TYPE,
      })
      manifestEtag = putResult.etag
    }
    catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new PreconditionFailedError(
          this.manifestKey,
          `Manifest CAS conflict on "${this.manifestKey}" (expected ETag ${expectedEtag}). Another writer updated the remote database; pull the latest snapshot and re-apply your changes.`,
          { cause: error },
        )
      }
      throw error
    }

    let prunedKeys: readonly string[] = []
    if (options.retainCount !== undefined) {
      const pruneResult = await this.prune({ retainCount: options.retainCount })
      prunedKeys = pruneResult.deletedKeys
    }

    this.logger.info(`Pushed DuckDB snapshot ${snapshotKey} (${bytes.byteLength} bytes, ETag=${manifestEtag}).`)

    return {
      uploaded: true,
      snapshotKey,
      manifest,
      manifestEtag,
      sha256,
      sizeBytes: bytes.byteLength,
      prunedKeys,
    }
  }

  async rollback(options: RollbackSnapshotOptions = {}): Promise<RollbackSnapshotResult> {
    const manifestObj = await this.store.get(this.manifestKey)
    if (!manifestObj) {
      throw new StorageError(`Cannot rollback: remote manifest "${this.manifestKey}" does not exist.`)
    }

    const currentManifest = parseSnapshotManifest(manifestObj.body)
    const targetKey = options.targetKey?.trim() || currentManifest.previousKey
    if (!targetKey) {
      throw new StorageError(
        'Cannot rollback: no target snapshot key was specified and manifest.json has no previousKey.',
      )
    }

    if (targetKey === currentManifest.currentKey) {
      throw new ConfigurationError(`Target snapshot "${targetKey}" is already the current snapshot.`)
    }

    const targetObj = await this.store.get(targetKey)
    if (!targetObj) {
      throw new StorageError(`Cannot rollback: target snapshot "${targetKey}" does not exist in object storage.`)
    }

    const targetSha256 = computeSha256Hex(targetObj.body)
    const nextManifest: SnapshotManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      currentKey: targetKey,
      sha256: targetSha256,
      sizeBytes: targetObj.body.byteLength,
      updatedAt: this.now().toISOString(),
      previousKey: currentManifest.currentKey,
    }

    try {
      const putResult = await this.store.put(this.manifestKey, serializeManifest(nextManifest), {
        ifMatch: manifestObj.etag,
        contentType: JSON_CONTENT_TYPE,
      })

      this.logger.info(`Rolled back DuckDB manifest from ${currentManifest.currentKey} to ${targetKey}.`)

      return {
        previousCurrentKey: currentManifest.currentKey,
        restoredKey: targetKey,
        manifest: nextManifest,
        manifestEtag: putResult.etag,
      }
    }
    catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new PreconditionFailedError(
          this.manifestKey,
          `Rollback conflict on "${this.manifestKey}" (expected ETag ${manifestObj.etag}). Retry rollback after inspecting current status.`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async prune(options: PruneSnapshotsOptions): Promise<PruneSnapshotsResult> {
    if (!Number.isInteger(options.retainCount) || options.retainCount < 1) {
      throw new ConfigurationError(`retainCount must be an integer >= 1, got ${options.retainCount}.`)
    }

    const manifestObj = await this.store.get(this.manifestKey)
    if (!manifestObj) {
      throw new StorageError(`Cannot prune: remote manifest "${this.manifestKey}" does not exist.`)
    }

    const manifest = parseSnapshotManifest(manifestObj.body)
    const protectedSet = new Set<string>([manifest.currentKey])
    if (manifest.previousKey) {
      protectedSet.add(manifest.previousKey)
    }

    const listed = await this.store.list(this.snapshotPrefix)
    const snapshotKeys = listed
      .map(item => item.key)
      .filter(key => key.endsWith('.duckdb'))
      .sort((a, b) => b.localeCompare(a))

    const keptSet = new Set<string>(snapshotKeys.slice(0, options.retainCount))
    for (const key of protectedSet) {
      keptSet.add(key)
    }

    const deletedKeys: string[] = []
    for (const key of snapshotKeys) {
      if (keptSet.has(key)) {
        continue
      }
      await this.store.delete(key)
      deletedKeys.push(key)
    }

    const keptKeys = snapshotKeys.filter(key => keptSet.has(key))
    const protectedKeys = Array.from(protectedSet)

    if (deletedKeys.length > 0) {
      this.logger.info(`Pruned ${deletedKeys.length} old DuckDB snapshot(s), kept ${keptKeys.length}.`)
    }

    return {
      keptKeys,
      deletedKeys,
      protectedKeys,
    }
  }
}
