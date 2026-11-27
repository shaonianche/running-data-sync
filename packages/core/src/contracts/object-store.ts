import { StorageError } from '../foundation/errors.js'

/**
 * Result of reading an object from an {@link ObjectStorePort}.
 */
export interface ObjectStoreGetResult {
  readonly body: Uint8Array
  readonly etag: string
  readonly contentType?: string
}

/**
 * Result of inspecting object metadata via {@link ObjectStorePort.head}.
 */
export interface ObjectStoreHeadResult {
  readonly etag: string
  readonly sizeBytes: number
  readonly contentType?: string
}

/**
 * Options for {@link ObjectStorePort.put}, including atomic conditional writes.
 */
export interface ObjectStorePutOptions {
  /**
   * Compare-and-swap precondition: write succeeds only if the current object's
   * ETag matches this value. Throws {@link PreconditionFailedError} on mismatch
   * or when the key does not exist.
   */
  readonly ifMatch?: string
  /**
   * Create-once precondition: write succeeds only if no object currently exists
   * at the key. Throws {@link PreconditionFailedError} if the key already exists.
   */
  readonly ifNoneMatch?: '*'
  readonly contentType?: string
}

/**
 * Result of writing an object via {@link ObjectStorePort.put}.
 */
export interface ObjectStorePutResult {
  readonly etag: string
}

/**
 * Metadata entry returned by {@link ObjectStorePort.list}.
 */
export interface ObjectStoreListItem {
  readonly key: string
  readonly etag: string
  readonly sizeBytes: number
  readonly lastModified?: Date
}

/**
 * Thrown when a conditional write (`ifMatch` or `ifNoneMatch`) fails due to an
 * HTTP 412 PreconditionFailed response or an in-memory ETag/existence mismatch.
 */
export class PreconditionFailedError extends StorageError {
  readonly key: string

  constructor(key: string, message?: string, options?: ErrorOptions) {
    super(message ?? `Precondition failed for object "${key}"`, options)
    this.key = key
  }
}

/**
 * Minimal, storage-agnostic object storage port.
 *
 * Designed so DuckDB snapshots and private workout artifacts (`FIT`/`GPX`/`TCX`)
 * can be stored in Cloudflare R2, S3-compatible stores, or in-memory test doubles
 * without coupling core logic to a vendor SDK.
 */
export interface ObjectStorePort {
  get: (key: string) => Promise<ObjectStoreGetResult | null>
  head: (key: string) => Promise<ObjectStoreHeadResult | null>
  put: (
    key: string,
    body: Uint8Array,
    options?: ObjectStorePutOptions,
  ) => Promise<ObjectStorePutResult>
  delete: (key: string) => Promise<void>
  list: (prefix: string) => Promise<ObjectStoreListItem[]>
}
