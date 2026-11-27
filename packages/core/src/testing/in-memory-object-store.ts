import type {
  ObjectStoreGetResult,
  ObjectStoreHeadResult,
  ObjectStoreListItem,
  ObjectStorePort,
  ObjectStorePutOptions,
  ObjectStorePutResult,
} from '../contracts/object-store.js'
import { createHash } from 'node:crypto'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError } from '../foundation/errors.js'

interface StoredObject {
  readonly body: Uint8Array
  readonly etag: string
  readonly contentType?: string
  readonly lastModified: Date
}

function computeQuotedMd5Etag(body: Uint8Array): string {
  const digest = createHash('md5').update(body).digest('hex')
  return `"${digest}"`
}

function normalizeEtagForComparison(etag: string): string {
  const trimmed = etag.trim()
  if (trimmed === '*' || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed
  }
  return `"${trimmed}"`
}

/**
 * Deterministic in-memory {@link ObjectStorePort} test double.
 *
 * Enforces `ifMatch` and `ifNoneMatch: '*'` preconditions with
 * {@link PreconditionFailedError} and clones binary buffers on write/read so
 * tests cannot accidentally mutate stored payloads.
 */
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, StoredObject>()

  async get(key: string): Promise<ObjectStoreGetResult | null> {
    const entry = this.objects.get(key)
    if (!entry) {
      return null
    }
    return {
      body: new Uint8Array(entry.body),
      etag: entry.etag,
      ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
    }
  }

  async head(key: string): Promise<ObjectStoreHeadResult | null> {
    const entry = this.objects.get(key)
    if (!entry) {
      return null
    }
    return {
      etag: entry.etag,
      sizeBytes: entry.body.byteLength,
      ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    options?: ObjectStorePutOptions,
  ): Promise<ObjectStorePutResult> {
    if (options?.ifMatch !== undefined && options?.ifNoneMatch !== undefined) {
      throw new ConfigurationError('Cannot specify both ifMatch and ifNoneMatch on put().')
    }

    const existing = this.objects.get(key)

    if (options?.ifNoneMatch === '*') {
      if (existing !== undefined) {
        throw new PreconditionFailedError(
          key,
          `Object "${key}" already exists (ifNoneMatch: "*").`,
        )
      }
    }

    if (options?.ifMatch !== undefined) {
      const expected = normalizeEtagForComparison(options.ifMatch)
      if (existing === undefined) {
        throw new PreconditionFailedError(
          key,
          `Object "${key}" does not exist (ifMatch: ${expected}).`,
        )
      }
      if (expected !== '*' && existing.etag !== expected) {
        throw new PreconditionFailedError(
          key,
          `ETag mismatch for "${key}": expected ${expected}, found ${existing.etag}.`,
        )
      }
    }

    const copy = new Uint8Array(body)
    const etag = computeQuotedMd5Etag(copy)
    this.objects.set(key, {
      body: copy,
      etag,
      ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
      lastModified: new Date(),
    })

    return { etag }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<ObjectStoreListItem[]> {
    const results: ObjectStoreListItem[] = []
    for (const [key, entry] of this.objects.entries()) {
      if (!key.startsWith(prefix)) {
        continue
      }
      results.push({
        key,
        etag: entry.etag,
        sizeBytes: entry.body.byteLength,
        lastModified: new Date(entry.lastModified.getTime()),
      })
    }
    results.sort((a, b) => a.key.localeCompare(b.key))
    return results
  }

  clear(): void {
    this.objects.clear()
  }

  get size(): number {
    return this.objects.size
  }
}
