import type { GarminActivityRecord, GarminClientLike, GarminUploadResult } from './types.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationError, SyncError } from '../../foundation/index.js'
import {
  createIndoorWorkoutActivity,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createParsedTrackFixture,
  createVendorSyncRow,
  FakeActivityFormatPort,
  InMemoryActivityStore,
} from '../../testing/index.js'
import { extractGarminSummaryExtensions, runWithConcurrency, syncGarminToStore } from './download.js'
import { computeActivityContentHash } from './matching.js'
import { getVendorStatus, resolveVendorAccount } from './status.js'
import { syncStoreToGarmin } from './sync.js'
import { collectActivityFiles, uploadFilesToGarmin } from './upload-files.js'

const createdTempDirs: string[] = []

afterEach(async () => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop()
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  createdTempDirs.push(dir)
  return dir
}

describe('syncStoreToGarmin', () => {
  it('handles idempotent unchanged skips, conflict detection, FIT adaptation, 204 fallback lookup, duplicates, and failed rows', async () => {
    const unchangedRun = createOutdoorRunActivity({
      run_id: 1001,
      start_date: '2024-03-10 06:00:00',
      distance: 5000,
    })
    const unchangedPoints = createOutdoorRunFlybyPoints(1001)
    const unchangedHash = computeActivityContentHash(unchangedRun, unchangedPoints)

    // Claims the same remote activity as 1001 (triggers conflict)
    const conflictingRun = createOutdoorRunActivity({
      run_id: 1002,
      start_date: '2024-03-10 06:00:20',
      distance: 5005,
    })

    // Fresh run uploaded with HTTP 204 -> resolved via fallback fetchAllActivities
    const freshUploadRun = createOutdoorRunActivity({
      run_id: 1003,
      start_date: '2024-03-11 07:00:00',
      distance: 10_000,
    })
    const freshPoints = createOutdoorRunFlybyPoints(1003)

    // Indoor workout with no flyby -> returns duplicate on upload
    const duplicateWorkout = createIndoorWorkoutActivity({
      run_id: 1004,
      start_date: '2024-03-12 18:00:00',
      distance: 0,
      moving_time: 1800,
      elapsed_time: 1800,
      type: 'WeightTraining',
    })

    // Activity whose upload fails with an error containing a secret-like bearer token
    const failingRun = createOutdoorRunActivity({
      run_id: 1005,
      start_date: '2024-03-13 07:00:00',
      distance: 3000,
    })

    const store = new InMemoryActivityStore({
      activities: [unchangedRun, conflictingRun, freshUploadRun, duplicateWorkout, failingRun],
      flybyPoints: [...unchangedPoints, ...freshPoints],
      vendorSyncRows: [
        createVendorSyncRow({
          activityId: 1001,
          vendor: 'garmin',
          account: 'garmin_com',
          status: 'synced',
          remoteActivityId: 7001,
          contentHash: unchangedHash,
        }),
      ],
    })

    const formatPort = new FakeActivityFormatPort()
    const uploadedFilenames: string[] = []
    let fetchCount = 0

    const remoteBeforeUpload: GarminActivityRecord[] = [
      {
        activityId: 7001,
        startTimeGMT: '2024-03-10 06:00:00',
        distance: 5000,
        activityType: { typeKey: 'running' },
      },
    ]

    const client: GarminClientLike = {
      domain: 'garmin.com',
      account: 'garmin_com',
      getActivities: async () => remoteBeforeUpload,
      fetchAllActivities: async () => {
        fetchCount += 1
        if (fetchCount === 1) {
          return remoteBeforeUpload
        }
        // Fallback fetch after HTTP 204 for 1003
        return [
          ...remoteBeforeUpload,
          {
            activityId: 7003,
            startTimeGMT: '2024-03-11 07:00:05',
            distance: 10_000,
            activityType: { typeKey: 'running' },
          },
        ]
      },
      getActivitySummary: async () => ({}),
      deleteActivity: async () => {},
      downloadActivity: async () => new Uint8Array(),
      uploadActivity: async (filename): Promise<GarminUploadResult> => {
        uploadedFilenames.push(filename)
        if (filename === '1003.fit') {
          return { status: 204, detailedImportResult: null, remoteActivityId: null, duplicate: false }
        }
        if (filename === '1004.fit') {
          return { status: 409, detailedImportResult: null, remoteActivityId: 7004, duplicate: true }
        }
        throw new SyncError('Upload failed with Authorization: Bearer secret-jwt-token-xyz')
      },
    }

    const result = await syncStoreToGarmin({
      store,
      formatPort,
      client,
      useFakeGarminDevice: true,
      fixHr: true,
      now: () => Date.UTC(2024, 2, 20, 8, 0, 0),
    })

    expect(result).toMatchObject({
      account: 'garmin_com',
      totalLocal: 5,
      deletedRemote: 0,
      synced: 1,
      skippedUnchanged: 1,
      skippedExists: 1,
      conflicts: 1,
      failed: 1,
    })
    expect(result.noFlybyTypeCounts).toEqual({
      Run: 2, // 1002 and 1005 had no flyby points
      WeightTraining: 1, // 1004 had no flyby points
    })
    expect(uploadedFilenames).toEqual(['1003.fit', '1004.fit', '1005.fit'])

    // Verify FIT adaptation options were passed to ActivityFormatPort
    expect(formatPort.calls.adaptFit).toHaveLength(3)
    expect(formatPort.calls.adaptFit[0]?.options).toEqual({
      useFakeGarminDevice: true,
      fixHeartRate: true,
    })

    const row1002 = await store.getVendorSyncRow(1002, 'garmin', 'garmin_com')
    expect(row1002?.status).toBe('conflict')
    expect(row1002?.remoteActivityId).toBe(7001)

    const row1003 = await store.getVendorSyncRow(1003, 'garmin', 'garmin_com')
    expect(row1003?.status).toBe('synced')
    expect(row1003?.remoteActivityId).toBe(7003)

    const row1004 = await store.getVendorSyncRow(1004, 'garmin', 'garmin_com')
    expect(row1004?.status).toBe('skipped_exists')
    expect(row1004?.remoteActivityId).toBe(7004)

    const row1005 = await store.getVendorSyncRow(1005, 'garmin', 'garmin_com')
    expect(row1005?.status).toBe('failed')
    expect(row1005?.attemptCount).toBe(1)
    expect(row1005?.lastError).not.toContain('secret-jwt-token-xyz')
  })

  it('deletes remote activities, clears sync state, and re-uploads in force mode', async () => {
    const run = createOutdoorRunActivity({ run_id: 2001 })
    const store = new InMemoryActivityStore({
      activities: [run],
      flybyPoints: createOutdoorRunFlybyPoints(2001),
      vendorSyncRows: [
        createVendorSyncRow({
          activityId: 2001,
          vendor: 'garmin',
          account: 'garmin_cn',
          status: 'synced',
          remoteActivityId: 8801,
        }),
      ],
    })

    const deletedIds: Array<number | string> = []
    const client: GarminClientLike = {
      domain: 'garmin.cn',
      account: 'garmin_cn',
      getActivities: async () => [{ activityId: 8801 }, { activityId: 8802 }],
      fetchAllActivities: async () => [{ activityId: 8801 }, { activityId: 8802 }],
      getActivitySummary: async () => ({}),
      deleteActivity: async (id) => {
        deletedIds.push(id)
      },
      downloadActivity: async () => new Uint8Array(),
      uploadActivity: async () => ({
        status: 200,
        detailedImportResult: null,
        remoteActivityId: 9901,
        duplicate: false,
      }),
    }

    const result = await syncStoreToGarmin({
      store,
      formatPort: new FakeActivityFormatPort(),
      client,
      force: true,
    })

    expect(deletedIds).toEqual([8801, 8802])
    expect(result.deletedRemote).toBe(2)
    expect(result.synced).toBe(1)
    expect((await store.getVendorSyncRow(2001, 'garmin', 'garmin_cn'))?.remoteActivityId).toBe(9901)
  })
})

describe('syncGarminToStore', () => {
  it('skips existing activities, enforces bounded concurrency, injects GPX summaries, writes outputDirs, and ingests store records', async () => {
    const outputRoot = await createTempDir('garmin-download-gpx-')
    const existingRun = createOutdoorRunActivity({ run_id: 500 })
    const store = new InMemoryActivityStore({ activities: [existingRun] })

    const formatPort = new FakeActivityFormatPort({
      parseTrack: async (_data, options) => {
        const id = Number(options?.fileName?.replace(/\..+$/, ''))
        return createParsedTrackFixture({
          fileName: options?.fileName,
          distance: id === 501 ? 8200 : 4100,
          movingTime: 2400,
          elapsedTime: 2460,
          averageHeartrate: 152,
          type: 'Run',
        })
      },
    })

    let inFlight = 0
    let maxInFlight = 0

    const client: GarminClientLike = {
      domain: 'garmin.com',
      account: 'garmin_com',
      getActivities: async () => [],
      fetchAllActivities: async () => [
        { activityId: 500, activityName: 'Already In Store' },
        { activityId: 501, activityName: 'Fallback Title 501' },
        { activityId: 502, activityName: 'Fallback Title 502' },
        { activityId: 503, activityName: 'Broken Download' },
      ],
      getActivitySummary: async (id) => {
        if (id === 501) {
          return {
            activityName: 'Garmin Tempo Run',
            summaryDTO: { distance: 8200, averageHR: 155, averageSpeed: 3.4 },
          }
        }
        throw new Error('Summary 500 error')
      },
      deleteActivity: async () => {},
      downloadActivity: async (id) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 10))
        inFlight -= 1

        if (id === 503) {
          throw new Error('Download failed for 503')
        }
        return new TextEncoder().encode('<gpx version="1.1"><trk></trk></gpx>')
      },
      uploadActivity: async () => ({
        status: 200,
        detailedImportResult: null,
        remoteActivityId: null,
        duplicate: false,
      }),
    }

    expect(
      extractGarminSummaryExtensions({
        summaryDTO: { distance: 5000, averageHR: 148, averageSpeed: 3.1 },
      }),
    ).toEqual({
      distance: 5000,
      averageHr: 148,
      averageSpeed: 3.1,
    })

    const result = await syncGarminToStore({
      store,
      formatPort,
      client,
      fileType: 'gpx',
      concurrency: 2,
      outputDirs: { gpxDir: outputRoot },
    })

    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(result).toMatchObject({
      account: 'garmin_com',
      fileType: 'gpx',
      fetched: 4,
      skippedExisting: 1,
      downloaded: 2,
      ingested: 2,
    })
    expect(result.flybyPointsStored).toBeGreaterThan(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.activityId).toBe(503)

    // Summary extensions were injected for 501 (not 502 since 502 summary failed)
    expect(formatPort.calls.injectGpxSummaryExtensions).toHaveLength(1)
    const persisted501 = await fs.readFile(path.join(outputRoot, '501.gpx'), 'utf8')
    expect(persisted501).toContain('<extensions><distance>8200</distance><average_hr>155</average_hr><average_speed>3.4</average_speed></extensions>')

    const stored501 = await store.getActivityById(501)
    expect(stored501?.name).toBe('Garmin Tempo Run')
    const stored502 = await store.getActivityById(502)
    expect(stored502?.name).toBe('Fallback Title 502')
  })

  it('detects ZIP vs raw FIT payloads when fileType is fit', async () => {
    const fitDir = await createTempDir('garmin-download-fit-')
    const store = new InMemoryActivityStore()
    const formatPort = new FakeActivityFormatPort()

    const client: GarminClientLike = {
      domain: 'garmin.cn',
      account: 'garmin_cn',
      getActivities: async () => [],
      fetchAllActivities: async () => [{ activityId: 601 }, { activityId: 602 }],
      getActivitySummary: async () => ({}),
      deleteActivity: async () => {},
      downloadActivity: async (id) => {
        if (id === 601) {
          return new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]) // PK\x03\x04 ZIP header
        }
        return new Uint8Array([0x0E, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2E, 0x46, 0x49, 0x54])
      },
      uploadActivity: async () => ({
        status: 200,
        detailedImportResult: null,
        remoteActivityId: null,
        duplicate: false,
      }),
    }

    const result = await syncGarminToStore({
      store,
      formatPort,
      client,
      fileType: 'fit',
      outputDirs: { fitDir },
    })

    expect(result.ingested).toBe(2)
    const formats = formatPort.calls.parseTrack.map(call => call.options?.format).sort()
    expect(formats).toEqual(['fit', 'zip'])

    const files = (await fs.readdir(fitDir)).sort()
    expect(files).toEqual(['601.zip', '602.fit'])
  })

  it('preserves input ordering in runWithConcurrency', async () => {
    const output = await runWithConcurrency(2, [30, 10, 20], async (ms) => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return ms * 2
    })
    expect(output).toEqual([60, 20, 40])
  })
})

describe('uploadFilesToGarmin & getVendorStatus', () => {
  it('collects supported files (with optional recursion) and uploads them with duplicate and error reporting', async () => {
    const dir = await createTempDir('garmin-upload-files-')
    const nested = path.join(dir, 'nested')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(dir, 'a.fit'), new Uint8Array([1, 2, 3]))
    await fs.writeFile(path.join(dir, 'ignore.txt'), 'not an activity')
    await fs.writeFile(path.join(nested, 'b.gpx'), '<gpx></gpx>')
    await fs.writeFile(path.join(nested, 'c.tcx'), '<TrainingCenterDatabase />')

    const nonRecursive = await collectActivityFiles([dir], { recursive: false })
    expect(nonRecursive.map(f => path.basename(f))).toEqual(['a.fit'])

    const recursive = await collectActivityFiles([dir], { recursive: true })
    expect(recursive.map(f => path.basename(f))).toEqual(['a.fit', 'b.gpx', 'c.tcx'])

    await expect(collectActivityFiles([path.join(dir, 'does-not-exist')])).rejects.toThrow(ConfigurationError)

    const uploadMock = vi.fn(async (filename: string): Promise<GarminUploadResult> => {
      if (filename === 'b.gpx') {
        return { status: 409, detailedImportResult: null, remoteActivityId: null, duplicate: true }
      }
      if (filename === 'c.tcx') {
        throw new Error('HTTP 500 internal error')
      }
      return { status: 200, detailedImportResult: null, remoteActivityId: 123, duplicate: false }
    })

    const client: GarminClientLike = {
      domain: 'garmin.com',
      account: 'garmin_com',
      getActivities: async () => [],
      fetchAllActivities: async () => [],
      getActivitySummary: async () => ({}),
      deleteActivity: async () => {},
      downloadActivity: async () => new Uint8Array(),
      uploadActivity: uploadMock,
    }

    const result = await uploadFilesToGarmin({
      client,
      paths: [dir],
      recursive: true,
      throwOnError: false,
    })

    expect(result.totalFiles).toBe(3)
    expect(result.uploaded.map(f => path.basename(f))).toEqual(['a.fit'])
    expect(result.duplicates.map(f => path.basename(f))).toEqual(['b.gpx'])
    expect(result.failures).toHaveLength(1)
    expect(path.basename(result.failures[0]!.filePath)).toBe('c.tcx')

    await expect(
      uploadFilesToGarmin({
        client,
        paths: [dir],
        recursive: true,
        throwOnError: true,
      }),
    ).rejects.toThrow(SyncError)
  })

  it('summarizes vendor status by account and resets failed rows when retryFailed is enabled', async () => {
    expect(resolveVendorAccount('garmin', undefined, false)).toBe('garmin_com')
    expect(resolveVendorAccount('garmin', undefined, true)).toBe('garmin_cn')
    expect(resolveVendorAccount('garmin', 'custom_acct', true)).toBe('custom_acct')
    expect(resolveVendorAccount('other', undefined, false)).toBeUndefined()

    const store = new InMemoryActivityStore({
      vendorSyncRows: [
        createVendorSyncRow({ activityId: 1, vendor: 'garmin', account: 'garmin_cn', status: 'synced' }),
        createVendorSyncRow({ activityId: 2, vendor: 'garmin', account: 'garmin_cn', status: 'failed' }),
        createVendorSyncRow({ activityId: 3, vendor: 'garmin', account: 'garmin_cn', status: 'conflict' }),
        createVendorSyncRow({ activityId: 4, vendor: 'garmin', account: 'garmin_com', status: 'failed' }),
      ],
    })

    const beforeRetry = await getVendorStatus({ store, isCn: true })
    expect(beforeRetry.account).toBe('garmin_cn')
    expect(beforeRetry.total).toBe(3)
    expect(beforeRetry.retriedCount).toBe(0)
    expect(beforeRetry.counts).toEqual({ conflict: 1, failed: 1, synced: 1 })

    const afterRetry = await getVendorStatus({ store, isCn: true, retryFailed: true })
    expect(afterRetry.retriedCount).toBe(1)
    expect(afterRetry.counts).toEqual({ conflict: 1, pending: 1, synced: 1 })

    // Ensure garmin_com row was untouched
    const comStatus = await getVendorStatus({ store, isCn: false })
    expect(comStatus.counts).toEqual({ failed: 1 })
  })
})
