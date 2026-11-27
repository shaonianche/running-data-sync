import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Decoder, Stream } from '@garmin/fitsdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigurationError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createIndoorWorkoutFlybyPoints,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
} from '../testing/fixtures.js'
import { InMemoryActivityStore } from '../testing/in-memory-store.js'
import {
  createActivityFormatPort,
  exportActivities,
} from './index.js'

describe('exportActivities (repository-injected batch exporter)', () => {
  let store: InMemoryActivityStore
  let tempDir: string
  const formatPort = createActivityFormatPort()

  beforeEach(async () => {
    store = new InMemoryActivityStore()
    const act1 = createOutdoorRunActivity({ run_id: 100001, name: 'Morning Run 1' })
    const act2 = createIndoorWorkoutActivity({ run_id: 100002, name: 'Strength Session 2' })
    const act3 = createOutdoorRunActivity({
      run_id: 100005,
      name: 'Evening Run 5',
      start_date: '2025-03-17T00:30:00Z',
      start_date_local: '2025-03-17T08:30:00',
    })

    await store.upsertActivities([act1, act2, act3])
    await store.storeFlybyPoints([
      ...createOutdoorRunFlybyPoints(100001),
      ...createIndoorWorkoutFlybyPoints(100002),
      ...createOutdoorRunFlybyPoints(100005),
    ])

    tempDir = await mkdtemp(join(tmpdir(), 'rds-formats-export-'))
  })

  afterEach(async () => {
    await store.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exports all activities to real @garmin/fitsdk FIT files passing isFIT() and checkIntegrity()', async () => {
    const outDir = join(tempDir, 'fit-all')
    const result = await exportActivities({
      repository: store,
      formatPort,
      format: 'fit',
      outputDir: outDir,
      all: true,
    })

    expect(result.requestedIds).toEqual([100001, 100002, 100005])
    expect(result.exported).toHaveLength(3)
    expect(result.failed).toEqual([])

    for (const item of result.exported) {
      const bytes = new Uint8Array(await readFile(item.filePath))
      expect(bytes.byteLength).toBe(item.bytesWritten)
      expect(formatPort.isFitFile(bytes)).toBe(true)

      const decoder = new Decoder(Stream.fromByteArray(bytes))
      expect(decoder.isFIT()).toBe(true)
      expect(decoder.checkIntegrity()).toBe(true)
      const { errors } = decoder.read()
      expect(errors).toEqual([])
    }
  })

  it('exports selected ids to TCX and records missing ids as failures without aborting', async () => {
    const outDir = join(tempDir, 'tcx-ids')
    const result = await exportActivities({
      repository: store,
      formatPort,
      format: 'tcx',
      outputDir: outDir,
      ids: [100005, 999999, 100001, 100001],
    })

    expect(result.requestedIds).toEqual([100001, 100005, 999999])
    expect(result.exported.map(e => e.activityId)).toEqual([100001, 100005])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].activityId).toBe(999999)

    const tcx1 = await readFile(join(outDir, '100001.tcx'), 'utf8')
    const parsed1 = await formatPort.parseTrack(tcx1)
    expect(parsed1.name).toBe('Morning Run 1')
    expect(parsed1.distance).toBe(5000)
  })

  it('exports activities matching inclusive idRange to GPX', async () => {
    const outDir = join(tempDir, 'gpx-range')
    const result = await exportActivities({
      repository: store,
      format: 'gpx',
      outputDir: outDir,
      idRange: [100001, 100003],
    })

    expect(result.requestedIds).toEqual([100001, 100002])
    expect(result.exported.map(e => e.activityId)).toEqual([100001, 100002])
    expect(result.failed).toEqual([])

    const gpx1 = await readFile(join(outDir, '100001.gpx'), 'utf8')
    const parsed1 = await formatPort.parseTrack(gpx1)
    expect(parsed1.name).toBe('Morning Run 1')
    expect(parsed1.points).toHaveLength(6)
  })

  it('validates export configuration and rejects invalid options with ConfigurationError', async () => {
    await expect(
      exportActivities({
        repository: store,
        format: 'fit',
        outputDir: tempDir,
      }),
    ).rejects.toThrow(ConfigurationError)

    await expect(
      exportActivities({
        repository: store,
        format: 'csv' as unknown as 'fit',
        outputDir: tempDir,
        all: true,
      }),
    ).rejects.toThrow(ConfigurationError)

    await expect(
      exportActivities({
        repository: store,
        format: 'fit',
        outputDir: tempDir,
        idRange: [100010, 100001],
      }),
    ).rejects.toThrow(ConfigurationError)

    await expect(
      exportActivities({
        repository: store,
        format: 'fit',
        outputDir: '   ',
        all: true,
      }),
    ).rejects.toThrow(ConfigurationError)
  })
})
