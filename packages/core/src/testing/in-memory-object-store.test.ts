import { describe, expect, it } from 'vitest'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError } from '../foundation/errors.js'
import { InMemoryObjectStore } from './in-memory-object-store.js'

describe('inMemoryObjectStore', () => {
  it('returns null for missing objects on get and head', async () => {
    const store = new InMemoryObjectStore()

    expect(await store.get('snapshots/missing.duckdb')).toBeNull()
    expect(await store.head('snapshots/missing.duckdb')).toBeNull()
  })

  it('stores and retrieves binary payloads without aliasing buffers', async () => {
    const store = new InMemoryObjectStore()
    const payload = new Uint8Array([0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF])

    const putResult = await store.put('artifacts/fit/abc.fit', payload, {
      contentType: 'application/octet-stream',
    })
    expect(putResult.etag).toMatch(/^"[0-9a-f]{32}"$/)

    // Mutating caller buffer after put must not affect stored bytes.
    payload[0] = 0xAA

    const fetched = await store.get('artifacts/fit/abc.fit')
    expect(fetched).not.toBeNull()
    expect(fetched!.etag).toBe(putResult.etag)
    expect(fetched!.contentType).toBe('application/octet-stream')
    expect(Array.from(fetched!.body)).toEqual([0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF])

    // Mutating returned buffer must not affect subsequent reads.
    fetched!.body[1] = 0xBB
    const fetchedAgain = await store.get('artifacts/fit/abc.fit')
    expect(Array.from(fetchedAgain!.body)).toEqual([0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF])

    const head = await store.head('artifacts/fit/abc.fit')
    expect(head).toEqual({
      etag: putResult.etag,
      sizeBytes: 6,
      contentType: 'application/octet-stream',
    })
  })

  it('enforces ifNoneMatch: "*" create-once semantics', async () => {
    const store = new InMemoryObjectStore()
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5, 6])

    const created = await store.put('manifest.json', first, {
      ifNoneMatch: '*',
      contentType: 'application/json',
    })
    expect(created.etag).toBeTruthy()

    await expect(
      store.put('manifest.json', second, { ifNoneMatch: '*' }),
    ).rejects.toThrow(PreconditionFailedError)

    // Original payload must remain intact.
    const fetched = await store.get('manifest.json')
    expect(Array.from(fetched!.body)).toEqual([1, 2, 3])
  })

  it('enforces ifMatch CAS update and rejects stale ETags or missing keys', async () => {
    const store = new InMemoryObjectStore()

    // Missing key fails ifMatch.
    await expect(
      store.put('manifest.json', new Uint8Array([1]), { ifMatch: '"deadbeef"' }),
    ).rejects.toThrow(PreconditionFailedError)

    const v1 = await store.put('manifest.json', new Uint8Array([1]))
    const v2 = await store.put('manifest.json', new Uint8Array([2]), {
      ifMatch: v1.etag,
    })
    expect(v2.etag).not.toBe(v1.etag)

    // Stale ETag fails with PreconditionFailedError.
    await expect(
      store.put('manifest.json', new Uint8Array([3]), { ifMatch: v1.etag }),
    ).rejects.toThrow(PreconditionFailedError)

    // Unquoted ETag also matches when normalized.
    const unquotedV2 = v2.etag.replace(/^"|"$/g, '')
    const v3 = await store.put('manifest.json', new Uint8Array([3]), {
      ifMatch: unquotedV2,
    })
    expect(v3.etag).not.toBe(v2.etag)
  })

  it('rejects specifying both ifMatch and ifNoneMatch', async () => {
    const store = new InMemoryObjectStore()
    await expect(
      store.put('k', new Uint8Array([1]), { ifMatch: '"abc"', ifNoneMatch: '*' }),
    ).rejects.toThrow(ConfigurationError)
  })

  it('deletes objects idempotently and lists by prefix in sorted key order', async () => {
    const store = new InMemoryObjectStore()
    await store.put('snapshots/2026-02.duckdb', new Uint8Array([1, 2]))
    await store.put('snapshots/2026-01.duckdb', new Uint8Array([1]))
    await store.put('artifacts/100.fit', new Uint8Array([9, 8, 7]))

    const snapshots = await store.list('snapshots/')
    expect(snapshots.map(s => s.key)).toEqual([
      'snapshots/2026-01.duckdb',
      'snapshots/2026-02.duckdb',
    ])
    expect(snapshots[0]?.sizeBytes).toBe(1)
    expect(snapshots[1]?.sizeBytes).toBe(2)
    expect(snapshots[0]?.lastModified).toBeInstanceOf(Date)

    await store.delete('snapshots/2026-01.duckdb')
    await store.delete('snapshots/does-not-exist.duckdb')

    const afterDelete = await store.list('snapshots/')
    expect(afterDelete.map(s => s.key)).toEqual(['snapshots/2026-02.duckdb'])
    expect(store.size).toBe(2)

    store.clear()
    expect(store.size).toBe(0)
  })
})
