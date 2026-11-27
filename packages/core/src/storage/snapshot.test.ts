import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { createIndoorWorkoutActivity, createOutdoorRunActivity } from '../testing/fixtures.js'
import { InMemoryObjectStore } from '../testing/in-memory-object-store.js'
import { openDuckDBConnection } from './connection.js'
import { DuckDBActivityStore } from './duckdb-store.js'
import {
  buildSnapshotKey,
  computeSha256Hex,
  DEFAULT_MANIFEST_KEY,
  DuckDBSnapshotManager,
} from './snapshot.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-snapshot-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('duckDB clean CHECKPOINT close', () => {
  it('flushes WAL on close so a copied .duckdb file reopens cleanly with all writes', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'source.duckdb')
    const copiedPath = path.join(dir, 'copied.duckdb')

    const store = new DuckDBActivityStore({ dbPath })
    await store.upsertActivities([createOutdoorRunActivity()])
    await store.close()

    const walPath = `${dbPath}.wal`
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0)
    }

    fs.copyFileSync(dbPath, copiedPath)

    const reopened = new DuckDBActivityStore({ dbPath: copiedPath, readOnly: true })
    try {
      const activity = await reopened.getActivityById(100001)
      expect(activity?.name).toBe('Morning Run')
    }
    finally {
      await reopened.close()
    }
  })

  it('closes read-only and in-memory connections without failing on CHECKPOINT', async () => {
    const memHandle = await openDuckDBConnection({ dbPath: ':memory:' })
    await memHandle.connection.run('CREATE TABLE t (id INTEGER)')
    await memHandle.close()
    // Idempotent second close
    await memHandle.close()
  })
})

describe('duckDBSnapshotManager', () => {
  it('supports full round-trip: bootstrap -> pull -> write -> close -> push -> pull into fresh path', async () => {
    const dir = makeTempDir()
    const initialPath = path.join(dir, 'initial.duckdb')
    const workingPath = path.join(dir, 'working.duckdb')
    const verifyPath = path.join(dir, 'verify.duckdb')

    // Create initial local DuckDB
    const initialStore = new DuckDBActivityStore({ dbPath: initialPath })
    await initialStore.upsertActivities([createOutdoorRunActivity()])
    await initialStore.close()

    let clockMs = Date.parse('2026-11-27T01:00:00.000Z')
    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({
      store: objectStore,
      now: () => {
        clockMs += 1000
        return new Date(clockMs)
      },
    })

    const beforeStatus = await manager.status()
    expect(beforeStatus.initialized).toBe(false)
    expect(beforeStatus.manifest).toBeNull()

    // 1. Bootstrap
    const bootstrapped = await manager.bootstrap({ sourcePath: initialPath })
    expect(bootstrapped.snapshotKey).toMatch(/^snapshots\/data-20261127T010001Z-[0-9a-f]{12}\.duckdb$/)
    expect(bootstrapped.manifest.currentKey).toBe(bootstrapped.snapshotKey)
    expect(bootstrapped.manifest.previousKey).toBeUndefined()

    // 2. Pull
    const pulled = await manager.pull({ targetPath: workingPath })
    expect(pulled.sha256).toBe(bootstrapped.sha256)
    expect(pulled.manifestEtag).toBe(bootstrapped.manifestEtag)

    // 3. Local DuckDB write + clean close
    const workingStore = new DuckDBActivityStore({ dbPath: workingPath })
    await workingStore.upsertActivities([createIndoorWorkoutActivity()])
    await workingStore.close()

    // 4. Push
    const pushed = await manager.push({
      sourcePath: workingPath,
      expectedManifestEtag: pulled.manifestEtag,
      previousSha256: pulled.sha256,
      previousKey: pulled.manifest.currentKey,
    })
    expect(pushed.uploaded).toBe(true)
    expect(pushed.manifest?.previousKey).toBe(bootstrapped.snapshotKey)
    expect(pushed.manifestEtag).not.toBe(pulled.manifestEtag)

    // 5. Pull into fresh path and verify data integrity + sha256
    const verified = await manager.pull({ targetPath: verifyPath })
    expect(verified.sha256).toBe(pushed.sha256)
    expect(computeSha256Hex(new Uint8Array(fs.readFileSync(verifyPath)))).toBe(pushed.sha256)

    const verifyStore = new DuckDBActivityStore({ dbPath: verifyPath, readOnly: true })
    try {
      const a1 = await verifyStore.getActivityById(100001)
      const a2 = await verifyStore.getActivityById(100002)
      expect(a1?.name).toBe('Morning Run')
      expect(a2?.name).toBe('Indoor Strength Workout')
    }
    finally {
      await verifyStore.close()
    }
  })

  it('skips upload and manifest write when local .duckdb sha256 is unchanged (no-op)', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'noop.duckdb')
    const pulledPath = path.join(dir, 'pulled.duckdb')

    const store = new DuckDBActivityStore({ dbPath })
    await store.upsertActivities([createOutdoorRunActivity()])
    await store.close()

    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({ store: objectStore })

    const bootstrapped = await manager.bootstrap({ sourcePath: dbPath })
    const pulled = await manager.pull({ targetPath: pulledPath })

    const objectCountBefore = objectStore.size
    const pushResult = await manager.push({
      sourcePath: pulledPath,
      expectedManifestEtag: pulled.manifestEtag,
      previousSha256: pulled.sha256,
      previousKey: pulled.manifest.currentKey,
    })

    expect(pushResult.uploaded).toBe(false)
    expect(pushResult.manifest).toBeNull()
    expect(pushResult.manifestEtag).toBe(bootstrapped.manifestEtag)
    expect(objectStore.size).toBe(objectCountBefore)
  })

  it('prevents concurrent bootstrap overwrite with PreconditionFailedError', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'boot.duckdb')
    fs.writeFileSync(dbPath, Buffer.from('duckdb-v1'))

    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({ store: objectStore })

    await manager.bootstrap({ sourcePath: dbPath })
    await expect(manager.bootstrap({ sourcePath: dbPath })).rejects.toThrow(PreconditionFailedError)
  })

  it('fails push with PreconditionFailedError on CAS conflict without corrupting remote manifest', async () => {
    const dir = makeTempDir()
    const dbA = path.join(dir, 'a.duckdb')
    const dbB = path.join(dir, 'b.duckdb')

    const storeA = new DuckDBActivityStore({ dbPath: dbA })
    await storeA.upsertActivities([createOutdoorRunActivity()])
    await storeA.close()

    let clockMs = Date.parse('2026-11-27T02:00:00.000Z')
    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({
      store: objectStore,
      now: () => {
        clockMs += 1000
        return new Date(clockMs)
      },
    })

    await manager.bootstrap({ sourcePath: dbA })

    // Two concurrent runners pull the same manifest ETag
    const pullA = await manager.pull({ targetPath: dbA })
    const pullB = await manager.pull({ targetPath: dbB })
    expect(pullA.manifestEtag).toBe(pullB.manifestEtag)

    // Runner A writes and pushes first
    const writerA = new DuckDBActivityStore({ dbPath: dbA })
    await writerA.upsertActivities([createIndoorWorkoutActivity()])
    await writerA.close()

    const pushA = await manager.push({
      sourcePath: dbA,
      expectedManifestEtag: pullA.manifestEtag,
      previousSha256: pullA.sha256,
      previousKey: pullA.manifest.currentKey,
    })

    // Runner B writes different data and attempts to push with stale ETag
    fs.writeFileSync(dbB, Buffer.from('concurrent-runner-b-bytes'))
    await expect(
      manager.push({
        sourcePath: dbB,
        expectedManifestEtag: pullB.manifestEtag,
        previousSha256: pullB.sha256,
        previousKey: pullB.manifest.currentKey,
      }),
    ).rejects.toThrow(PreconditionFailedError)

    // Remote manifest must still point to Runner A's snapshot intact
    const status = await manager.status()
    expect(status.manifest?.currentKey).toBe(pushA.snapshotKey)
    expect(status.manifest?.sha256).toBe(pushA.sha256)
    expect(status.manifestEtag).toBe(pushA.manifestEtag)
  })

  it('rejects pull when remote snapshot sha256 does not match manifest', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'good.duckdb')
    const targetPath = path.join(dir, 'corrupted-target.duckdb')
    fs.writeFileSync(dbPath, Buffer.from('valid-duckdb-bytes'))

    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({ store: objectStore })
    const bootstrapped = await manager.bootstrap({ sourcePath: dbPath })

    // Tamper with snapshot object in store without updating manifest
    await objectStore.put(bootstrapped.snapshotKey, new Uint8Array(Buffer.from('tampered-bytes')))

    await expect(manager.pull({ targetPath })).rejects.toThrow(StorageError)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('rejects upload when a non-empty .wal sidecar is present', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'dirty.duckdb')
    fs.writeFileSync(dbPath, Buffer.from('duckdb-bytes'))
    fs.writeFileSync(`${dbPath}.wal`, Buffer.from('unflushed-wal'))

    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({ store: objectStore })

    await expect(manager.bootstrap({ sourcePath: dbPath })).rejects.toThrow(/WAL sidecar/)
  })

  it('rolls back atomically to previousKey via If-Match', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'rb.duckdb')
    fs.writeFileSync(dbPath, Buffer.from('snapshot-v1'))

    let clockMs = Date.parse('2026-11-27T03:00:00.000Z')
    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({
      store: objectStore,
      now: () => {
        clockMs += 1000
        return new Date(clockMs)
      },
    })

    const v1 = await manager.bootstrap({ sourcePath: dbPath })
    fs.writeFileSync(dbPath, Buffer.from('snapshot-v2'))
    const v2 = await manager.push({
      sourcePath: dbPath,
      expectedManifestEtag: v1.manifestEtag,
      previousSha256: v1.sha256,
      previousKey: v1.snapshotKey,
    })

    const rolledBack = await manager.rollback()
    expect(rolledBack.previousCurrentKey).toBe(v2.snapshotKey)
    expect(rolledBack.restoredKey).toBe(v1.snapshotKey)
    expect(rolledBack.manifest.currentKey).toBe(v1.snapshotKey)
    expect(rolledBack.manifest.previousKey).toBe(v2.snapshotKey)
    expect(rolledBack.manifest.sha256).toBe(v1.sha256)

    const pulledPath = path.join(dir, 'after-rollback.duckdb')
    const pulled = await manager.pull({ targetPath: pulledPath })
    expect(Buffer.from(fs.readFileSync(pulledPath)).toString('utf8')).toBe('snapshot-v1')
    expect(pulled.sha256).toBe(v1.sha256)
  })

  it('prunes old snapshots while never deleting currentKey or previousKey', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'prune.duckdb')

    let clockMs = Date.parse('2026-11-27T04:00:00.000Z')
    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({
      store: objectStore,
      now: () => {
        clockMs += 1000
        return new Date(clockMs)
      },
    })

    fs.writeFileSync(dbPath, Buffer.from('v1'))
    const v1 = await manager.bootstrap({ sourcePath: dbPath })

    fs.writeFileSync(dbPath, Buffer.from('v2'))
    const v2 = await manager.push({
      sourcePath: dbPath,
      expectedManifestEtag: v1.manifestEtag,
      previousSha256: v1.sha256,
      previousKey: v1.snapshotKey,
    })

    fs.writeFileSync(dbPath, Buffer.from('v3'))
    const v3 = await manager.push({
      sourcePath: dbPath,
      expectedManifestEtag: v2.manifestEtag,
      previousSha256: v2.sha256,
      previousKey: v2.snapshotKey,
    })

    fs.writeFileSync(dbPath, Buffer.from('v4'))
    const v4 = await manager.push({
      sourcePath: dbPath,
      expectedManifestEtag: v3.manifestEtag,
      previousSha256: v3.sha256,
      previousKey: v3.snapshotKey,
    })

    // Roll back to v1 so currentKey=v1 (oldest) and previousKey=v4 (newest)
    await manager.rollback({ targetKey: v1.snapshotKey })

    // Prune with retainCount=1: must STILL keep both currentKey (v1) and previousKey (v4)
    const pruned = await manager.prune({ retainCount: 1 })
    expect(pruned.protectedKeys).toContain(v1.snapshotKey)
    expect(pruned.protectedKeys).toContain(v4.snapshotKey)
    expect(pruned.keptKeys).toContain(v1.snapshotKey)
    expect(pruned.keptKeys).toContain(v4.snapshotKey)
    expect(pruned.deletedKeys).toEqual([v3.snapshotKey, v2.snapshotKey])

    expect(await objectStore.head(v1.snapshotKey)).not.toBeNull()
    expect(await objectStore.head(v4.snapshotKey)).not.toBeNull()
    expect(await objectStore.head(v2.snapshotKey)).toBeNull()
    expect(await objectStore.head(v3.snapshotKey)).toBeNull()
    expect(await objectStore.head(DEFAULT_MANIFEST_KEY)).not.toBeNull()
  })

  it('validates retainCount and snapshot key inputs', async () => {
    const objectStore = new InMemoryObjectStore()
    const manager = new DuckDBSnapshotManager({ store: objectStore })
    await expect(manager.prune({ retainCount: 0 })).rejects.toThrow(ConfigurationError)
    expect(() => buildSnapshotKey('not-hex')).toThrow(ConfigurationError)
  })
})
