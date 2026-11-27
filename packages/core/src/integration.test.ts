import type { GarminActivityRecord, GarminClientLike, StravaDetailedActivity, StravaStreamsMap, StravaSummaryActivity } from './index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Decoder, Stream } from '@garmin/fitsdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createActivityFormatPort,
  decodePolyline,
  decodeSvgPolyline,
  DuckDBActivityStore,
  encodePolyline,
  exportActivitiesFromDb,
  exportActivitiesJson,
  exportParquet,
  generatePosterSvg,
  getVendorStatus,
  reconcileGarminDb,
  syncDbToGarmin,
  syncStravaToDb,
  validateDataConsistency,
} from './index.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('core cross-module integration', () => {
  it('resolves decodePolyline and decodeSvgPolyline explicitly from the root barrel', () => {
    const encoded = encodePolyline([
      [31.2304, 121.4737],
      [31.2314, 121.4747],
    ])
    const decodedFormats = decodePolyline(encoded)
    const decodedSvg = decodeSvgPolyline(encoded)
    expect(decodedFormats).toHaveLength(2)
    expect(decodedSvg).toHaveLength(2)
    expect(decodedSvg[0][0]).toBeCloseTo(decodedFormats[0][0], 5)
    expect(decodedSvg[0][1]).toBeCloseTo(decodedFormats[0][1], 5)
  })

  it('runs end-to-end Strava -> DuckDB -> FIT/TCX/GPX -> Garmin -> JSON/Parquet/Validate -> SVG pipeline', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rds-core-e2e-'))
    tempDirs.push(tempDir)

    const dbPath = path.join(tempDir, 'test.duckdb')
    const jsonPath = path.join(tempDir, 'activities.json')
    const parquetDir = path.join(tempDir, 'parquet')
    const exportDir = path.join(tempDir, 'exports')
    const svgDir = path.join(tempDir, 'svg')

    const polyline = encodePolyline([
      [31.2304, 121.4737],
      [31.2315, 121.4749],
      [31.2328, 121.4761],
      [31.2340, 121.4775],
    ])

    const summary: StravaSummaryActivity = {
      id: 900001,
      name: 'Morning Tempo Run',
      distance: 5200,
      moving_time: 1500,
      elapsed_time: 1530,
      total_elevation_gain: 25,
      type: 'Run',
      sport_type: 'Run',
      start_date: '2025-05-10T00:30:00Z',
      start_date_local: '2025-05-10T08:30:00Z',
      average_speed: 3.467,
      average_heartrate: 152,
      start_latlng: [31.2304, 121.4737],
      map: {
        id: 'a900001',
        summary_polyline: polyline,
      },
    }

    const detailed: StravaDetailedActivity = {
      ...summary,
      location_country: 'China',
    }

    const streams: StravaStreamsMap = {
      time: { data: [0, 500, 1000, 1500] },
      latlng: {
        data: [
          [31.2304, 121.4737],
          [31.2315, 121.4749],
          [31.2328, 121.4761],
          [31.2340, 121.4775],
        ],
      },
      altitude: { data: [10, 14, 18, 22] },
      heartrate: { data: [142, 150, 156, 158] },
      distance: { data: [0, 1700, 3450, 5200] },
    }

    const store = new DuckDBActivityStore({ dbPath })
    try {
      // 1. Ingest from mocked Strava into real DuckDB
      const stravaRes = await syncStravaToDb({
        store,
        client: {
          refreshAccessToken: async () => ({
            access_token: 'mock-access',
            refresh_token: 'mock-refresh',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          listActivities: async () => [summary],
          getActivity: async () => detailed,
          getActivityStreams: async () => streams,
        },
        geocoder: null,
        sleep: async () => {},
      })
      expect(stravaRes.fetchedActivities).toBe(1)
      expect(stravaRes.syncedActivities).toBe(1)
      expect(stravaRes.flybySyncedActivities).toBe(1)

      // 2. Export real FIT, TCX, GPX and verify FIT integrity via @garmin/fitsdk
      const formatPort = createActivityFormatPort()
      const fitExport = await exportActivitiesFromDb({
        store,
        formatPort,
        format: 'fit',
        all: true,
        outputDir: path.join(exportDir, 'fit'),
      })
      expect(fitExport.exported).toHaveLength(1)
      expect(fitExport.failed).toHaveLength(0)

      const fitBytes = new Uint8Array(await readFile(fitExport.exported[0].filePath))
      const decoder = new Decoder(Stream.fromByteArray(Array.from(fitBytes)))
      expect(decoder.isFIT()).toBe(true)
      expect(decoder.checkIntegrity()).toBe(true)

      const adaptedBytes = formatPort.adaptFit(fitBytes, {
        useFakeGarminDevice: true,
        fixHeartRate: true,
      })
      const adaptedDecoder = new Decoder(Stream.fromByteArray(Array.from(adaptedBytes)))
      expect(adaptedDecoder.isFIT()).toBe(true)
      expect(adaptedDecoder.checkIntegrity()).toBe(true)

      const tcxExport = await exportActivitiesFromDb({
        store,
        formatPort,
        format: 'tcx',
        all: true,
        outputDir: path.join(exportDir, 'tcx'),
      })
      expect(tcxExport.exported).toHaveLength(1)

      const gpxExport = await exportActivitiesFromDb({
        store,
        formatPort,
        format: 'gpx',
        all: true,
        outputDir: path.join(exportDir, 'gpx'),
      })
      expect(gpxExport.exported).toHaveLength(1)

      // 3. Upload to mocked Garmin with idempotent sync + reconcile
      const uploadedRecords: GarminActivityRecord[] = []
      const garminClient: GarminClientLike = {
        account: 'garmin_com',
        domain: 'garmin.com',
        getActivities: async () => [...uploadedRecords],
        fetchAllActivities: async () => [...uploadedRecords],
        getActivitySummary: async () => ({}),
        uploadActivity: async (_filename, bytes) => {
          const uploadDecoder = new Decoder(Stream.fromByteArray(Array.from(bytes)))
          expect(uploadDecoder.isFIT()).toBe(true)
          expect(uploadDecoder.checkIntegrity()).toBe(true)
          uploadedRecords.push({
            activityId: 777001,
            activityName: 'Morning Tempo Run',
            startTimeGMT: '2025-05-10 00:30:00',
            startTimeLocal: '2025-05-10 08:30:00',
            distance: 5200,
            duration: 1500,
            activityType: { typeKey: 'running' },
          })
          return {
            status: 202,
            detailedImportResult: null,
            remoteActivityId: 777001,
            duplicate: false,
          }
        },
        deleteActivity: async () => {},
        downloadActivity: async () => fitBytes,
      }

      const firstSync = await syncDbToGarmin({
        store,
        formatPort,
        client: garminClient,
        useFakeGarminDevice: true,
        fixHr: true,
      })
      expect(firstSync.synced).toBe(1)

      const secondSync = await syncDbToGarmin({
        store,
        formatPort,
        client: garminClient,
        useFakeGarminDevice: true,
        fixHr: true,
      })
      expect(secondSync.skippedUnchanged).toBe(1)
      expect(secondSync.synced).toBe(0)

      const reconcileRes = await reconcileGarminDb({
        store,
        client: garminClient,
      })
      expect(reconcileRes.matched + reconcileRes.unchanged).toBeGreaterThanOrEqual(1)

      const status = await getVendorStatus({ store, vendor: 'garmin', account: 'garmin_com' })
      expect(status.total).toBe(1)
      expect(status.counts.synced).toBe(1)

      // 4. Render real GitHub & Grid SVGs from DuckDB
      const githubSvg = await generatePosterSvg({
        store,
        type: 'github',
        outputPath: path.join(svgDir, 'github.svg'),
      })
      expect(githubSvg.svg).toContain('<svg')
      expect(githubSvg.outputPath).toBe(path.join(svgDir, 'github.svg'))

      const gridSvg = await generatePosterSvg({
        store,
        type: 'grid',
        outputPath: path.join(svgDir, 'grid.svg'),
      })
      expect(gridSvg.svg).toContain('<svg')
    }
    finally {
      await store.close()
    }

    // 5. Export JSON & Parquet and verify 3-way consistency
    const jsonRes = await exportActivitiesJson({
      dbPath,
      outputPath: jsonPath,
    })
    expect(jsonRes.count).toBe(1)

    const parquetRes = await exportParquet({
      dbPath,
      outputDir: parquetDir,
    })
    expect(parquetRes.exportedFiles.some(file => file.endsWith('activities.parquet'))).toBe(true)

    const validation = await validateDataConsistency({
      dbPath,
      jsonPath,
      parquetPath: path.join(parquetDir, 'activities.parquet'),
    })
    expect(validation.ok).toBe(true)
    expect(validation.db.count).toBe(1)
    expect(validation.json.count).toBe(1)
    expect(validation.parquet.count).toBe(1)
  })
})
