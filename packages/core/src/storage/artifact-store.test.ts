import type { ObjectStorePort } from '../contracts/object-store.js'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { InMemoryObjectStore } from '../testing/in-memory-object-store.js'
import {
  buildRawStravaArtifactKey,
  buildWorkoutArtifactKey,
  computeArtifactSha256,
  parseRawStravaArtifactKey,
  parseWorkoutArtifactKey,
  PrivateArtifactStore,
  resolveWorkoutContentType,
} from './artifact-store.js'

describe('artifact-store key builders and parsers', () => {
  it('builds and parses canonical FIT/GPX/TCX keys', () => {
    const hash = computeArtifactSha256(new Uint8Array([1, 2, 3, 4]))

    for (const format of ['fit', 'gpx', 'tcx'] as const) {
      const key = buildWorkoutArtifactKey(123456, hash, format)
      expect(key).toBe(`artifacts/123456/${hash}.${format}`)
      expect(parseWorkoutArtifactKey(key)).toEqual({
        activityId: 123456,
        sha256: hash,
        format,
      })
    }
  })

  it('rejects invalid activity IDs, hashes, and formats', () => {
    const validHash = 'a'.repeat(64)
    expect(() => buildWorkoutArtifactKey(-1, validHash, 'fit')).toThrow(ConfigurationError)
    expect(() => buildWorkoutArtifactKey(1.5, validHash, 'fit')).toThrow(ConfigurationError)
    expect(() => buildWorkoutArtifactKey(100, 'not-a-hash', 'fit')).toThrow(ConfigurationError)
    expect(() => buildWorkoutArtifactKey(100, validHash, 'csv' as never)).toThrow(ConfigurationError)

    expect(parseWorkoutArtifactKey('artifacts/100/short.fit')).toBeNull()
    expect(parseWorkoutArtifactKey('raw/strava/100/'.concat(validHash, '.json.gz'))).toBeNull()
  })

  it('provides an extensible key boundary for raw Strava JSON archiving', () => {
    const hash = computeArtifactSha256(Buffer.from('{"id":42}'))
    const key = buildRawStravaArtifactKey(42, hash)
    expect(key).toBe(`raw/strava/42/${hash}.json.gz`)
    expect(parseRawStravaArtifactKey(key)).toEqual({
      activityId: 42,
      sha256: hash,
    })
    expect(parseRawStravaArtifactKey(`artifacts/42/${hash}.fit`)).toBeNull()
  })
})

describe('privateArtifactStore', () => {
  it('stores and retrieves FIT, GPX, and TCX artifacts by activityId and sha256', async () => {
    const objectStore = new InMemoryObjectStore()
    const artifactStore = new PrivateArtifactStore(objectStore)

    const cases = [
      { id: 1001, format: 'fit' as const, body: new Uint8Array([0x0E, 0x10, 0x2E, 0x46, 0x49, 0x54]) },
      { id: 1001, format: 'gpx' as const, body: Buffer.from('<gpx version="1.1"></gpx>') },
      { id: 1002, format: 'tcx' as const, body: Buffer.from('<TrainingCenterDatabase/>') },
    ]

    for (const item of cases) {
      const putResult = await artifactStore.putWorkoutArtifact({
        activityId: item.id,
        format: item.format,
        body: item.body,
      })

      const expectedHash = computeArtifactSha256(item.body)
      expect(putResult.deduplicated).toBe(false)
      expect(putResult.reference).toMatchObject({
        key: `artifacts/${item.id}/${expectedHash}.${item.format}`,
        activityId: item.id,
        format: item.format,
        sha256: expectedHash,
        sizeBytes: item.body.byteLength,
        contentType: resolveWorkoutContentType(item.format),
      })
      expect(putResult.reference.etag).toBeTruthy()

      const fetched = await artifactStore.getWorkoutArtifact(item.id, expectedHash, item.format)
      expect(fetched).not.toBeNull()
      expect(Buffer.from(fetched!.body)).toEqual(Buffer.from(item.body))
      expect(fetched!.reference.key).toBe(putResult.reference.key)

      const byKey = await artifactStore.getWorkoutArtifactByKey(putResult.reference.key)
      expect(byKey).not.toBeNull()
      expect(Buffer.from(byKey!.body)).toEqual(Buffer.from(item.body))

      const head = await artifactStore.headWorkoutArtifact(item.id, expectedHash, item.format)
      expect(head).toMatchObject({
        key: putResult.reference.key,
        sizeBytes: item.body.byteLength,
        etag: putResult.reference.etag,
      })
    }

    const list1001 = await artifactStore.listWorkoutArtifacts(1001)
    expect(list1001).toHaveLength(2)
    expect(list1001.map(r => r.format).sort()).toEqual(['fit', 'gpx'])

    const listAll = await artifactStore.listWorkoutArtifacts()
    expect(listAll).toHaveLength(3)
  })

  it('treats uploading identical content twice as an idempotent cache hit', async () => {
    const objectStore = new InMemoryObjectStore()
    const putSpy = vi.spyOn(objectStore, 'put')
    const artifactStore = new PrivateArtifactStore(objectStore)

    const payload = Buffer.from('<gpx><trk><name>Morning Run</name></trk></gpx>')
    const first = await artifactStore.putWorkoutArtifact({
      activityId: 2001,
      format: 'gpx',
      body: payload,
    })
    const second = await artifactStore.putWorkoutArtifact({
      activityId: 2001,
      format: 'gpx',
      body: payload,
    })

    expect(putSpy).toHaveBeenCalledTimes(2)
    expect(putSpy).toHaveBeenNthCalledWith(
      1,
      first.reference.key,
      payload,
      expect.objectContaining({ ifNoneMatch: '*' }),
    )
    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.reference).toEqual(first.reference)
    expect(objectStore.size).toBe(1)
  })

  it('enforces upload-first, commit-second ordering and recovers cleanly on retry', async () => {
    const objectStore = new InMemoryObjectStore()
    const artifactStore = new PrivateArtifactStore(objectStore)
    const events: string[] = []

    const originalPut = objectStore.put.bind(objectStore)
    vi.spyOn(objectStore, 'put').mockImplementation(async (key, body, options) => {
      events.push('upload')
      return originalPut(key, body, options)
    })

    const payload = new Uint8Array([9, 8, 7, 6])

    // 1. If upload fails, onCommitReference must NEVER be called.
    const failingStore: ObjectStorePort = {
      get: objectStore.get.bind(objectStore),
      head: objectStore.head.bind(objectStore),
      delete: objectStore.delete.bind(objectStore),
      list: objectStore.list.bind(objectStore),
      put: vi.fn(async () => {
        throw new StorageError('transient network error')
      }),
    }
    const failingArtifactStore = new PrivateArtifactStore(failingStore)
    const neverCalledCommit = vi.fn()

    await expect(
      failingArtifactStore.putWorkoutArtifact({
        activityId: 3001,
        format: 'fit',
        body: payload,
        onCommitReference: neverCalledCommit,
      }),
    ).rejects.toThrow(StorageError)
    expect(neverCalledCommit).not.toHaveBeenCalled()

    // 2. If upload succeeds and commit fails, retry hits idempotent cache and completes commit.
    let commitAttempts = 0
    await expect(
      artifactStore.putWorkoutArtifact({
        activityId: 3001,
        format: 'fit',
        body: payload,
        onCommitReference: async () => {
          commitAttempts += 1
          events.push(`commit-${commitAttempts}`)
          throw new Error('local metadata write failed')
        },
      }),
    ).rejects.toThrow('local metadata write failed')

    expect(events).toEqual(['upload', 'commit-1'])
    expect(objectStore.size).toBe(1)

    const retryCommitted: string[] = []
    const retryResult = await artifactStore.putWorkoutArtifact({
      activityId: 3001,
      format: 'fit',
      body: payload,
      onCommitReference: async (ref, meta) => {
        retryCommitted.push(`${ref.key}:${meta.deduplicated}`)
      },
    })

    expect(retryResult.deduplicated).toBe(true)
    expect(retryCommitted).toEqual([`${retryResult.reference.key}:true`])
  })

  it('detects corrupted payload on read when content hash mismatches', async () => {
    const objectStore = new InMemoryObjectStore()
    const artifactStore = new PrivateArtifactStore(objectStore)

    const original = Buffer.from('<gpx>valid</gpx>')
    const sha256 = computeArtifactSha256(original)
    const key = buildWorkoutArtifactKey(4001, sha256, 'gpx')

    // Deliberately write mismatched bytes directly into the underlying store.
    await objectStore.put(key, Buffer.from('<gpx>corrupted</gpx>'))

    await expect(artifactStore.getWorkoutArtifact(4001, sha256, 'gpx')).rejects.toThrow(StorageError)
  })

  it('returns null for missing objects and skips unrelated keys when listing', async () => {
    const objectStore = new InMemoryObjectStore()
    const artifactStore = new PrivateArtifactStore(objectStore)
    const missingHash = '0'.repeat(64)

    expect(await artifactStore.getWorkoutArtifact(9999, missingHash, 'fit')).toBeNull()
    expect(await artifactStore.headWorkoutArtifact(9999, missingHash, 'fit')).toBeNull()
    await expect(artifactStore.getWorkoutArtifactByKey('invalid/key')).rejects.toThrow(ConfigurationError)

    await objectStore.put('artifacts/9999/not-a-valid-key.txt', new Uint8Array([1]))
    expect(await artifactStore.listWorkoutArtifacts(9999)).toEqual([])
  })
})
