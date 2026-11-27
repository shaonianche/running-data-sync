import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import polyline from '@mapbox/polyline'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  FIXTURE_OUTDOOR_RUN_POLYLINE,
} from '../testing/fixtures.js'
import { openDuckDBConnection } from './connection.js'
import { DuckDBActivityStore } from './duckdb-store.js'
import {
  computeActivityStreaks,
  exportActivitiesJson,
  exportParquet,
  loadActivities,
  serializeActivitiesJson,
} from './export.js'
import { filterPolyline, haversineDistanceKm } from './polyline.js'
import { validateDataConsistency } from './validation.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-export-'))
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

describe('privacy polyline processor', () => {
  it('computes haversine distance matching Earth radius 6371.0088 km', () => {
    expect(haversineDistanceKm([39.944, 116.482], [39.944, 116.482])).toBe(0)
    // ~1 degree latitude is ~111.195 km
    const dist = haversineDistanceKm([0, 0], [1, 0])
    expect(dist).toBeCloseTo(111.195, 2)
  })

  it('clips start/end distances and exclusion zones accurately', () => {
    expect(filterPolyline(null)).toBeNull()
    expect(filterPolyline('')).toBeNull()

    // 6-point fixture polyline (~500m between points)
    const rawPoints = polyline.decode(FIXTURE_OUTDOOR_RUN_POLYLINE)
    expect(rawPoints.length).toBe(6)

    // Default (0m): trims first and last point matching Python start_end_hiding(pl, 0)
    const defaultFiltered = filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
      ignoreRangeMeters: 0,
      ignoreStartEndRangeMeters: 0,
      ignorePoints: [],
    })
    expect(defaultFiltered).not.toBeNull()
    expect(polyline.decode(defaultFiltered!)).toEqual(rawPoints.slice(1, -1))

    // Larger start/end trim removes more points
    const largerTrim = filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
      ignoreStartEndRangeMeters: 700,
      ignoreRangeMeters: 0,
      ignorePoints: [],
    })
    expect(largerTrim).not.toBeNull()
    expect(polyline.decode(largerTrim!).length).toBeLessThan(rawPoints.slice(1, -1).length)

    // Overlapping start/end trim (> half track length) clips entire polyline to null
    expect(filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
      ignoreStartEndRangeMeters: 1500,
      ignoreRangeMeters: 0,
      ignorePoints: [],
    })).toBeNull()

    // Exclusion zone covering all points clips entire polyline to null
    expect(filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
      ignorePoints: [rawPoints[2]],
      ignoreRangeMeters: 5000,
      ignoreStartEndRangeMeters: 0,
    })).toBeNull()

    // Exclusion zone around point[2] removes point[2]
    const zoneEncoded = polyline.encode([rawPoints[2]])
    const zoneFiltered = filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
      ignorePolyline: zoneEncoded,
      ignoreRangeMeters: 200,
      ignoreStartEndRangeMeters: 0,
    })
    expect(zoneFiltered).not.toBeNull()
    const zoneDecoded = polyline.decode(zoneFiltered!)
    expect(zoneDecoded).not.toContainEqual(rawPoints[2])
    expect(zoneDecoded.length).toBe(rawPoints.length - 3)
  })

  it('throws ConfigurationError on invalid env numeric values', () => {
    expect(() =>
      filterPolyline(FIXTURE_OUTDOOR_RUN_POLYLINE, {
        env: { IGNORE_RANGE: 'not-a-number' },
      }),
    ).toThrow(ConfigurationError)
  })
})

describe('activities.json export, Parquet export, and 3-way consistency validator', () => {
  it('calculates streaks across consecutive days, same-day runs, and gaps', () => {
    const result = computeActivityStreaks([
      { run_id: 1, start_date_local: '2025-03-10T08:00:00' },
      { run_id: 2, start_date_local: '2025-03-11T08:00:00' },
      { run_id: 3, start_date_local: '2025-03-11T19:00:00' },
      { run_id: 4, start_date_local: '2025-03-12T07:30:00' },
      { run_id: 5, start_date_local: '2025-03-15T07:30:00' },
    ])

    expect(result.map(r => r.streak)).toEqual([1, 2, 1, 2, 1])
  })

  it('sanitizes NaN and Infinity to null in serialized JSON', () => {
    const json = serializeActivitiesJson([
      {
        run_id: 1,
        name: 'Test',
        distance: Number.NaN,
        moving_time: 100,
        elapsed_time: 100,
        type: 'Run',
        subtype: 'Run',
        start_date: '2025-03-15T00:00:00',
        start_date_local: '2025-03-15T08:00:00',
        location_country: null,
        summary_polyline: null,
        average_heartrate: Number.POSITIVE_INFINITY,
        average_speed: Number.NEGATIVE_INFINITY,
        elevation_gain: 10,
        streak: 1,
      },
    ])
    const parsed = JSON.parse(json)
    expect(parsed[0].distance).toBeNull()
    expect(parsed[0].average_heartrate).toBeNull()
    expect(parsed[0].average_speed).toBeNull()
  })

  it('returns empty list when loading activities from a missing DB file', async () => {
    const dir = makeTempDir()
    const missingDb = path.join(dir, 'absent.duckdb')
    expect(await loadActivities({ dbPath: missingDb })).toEqual([])
  })

  it('exports JSON + Parquet and passes/fails validateDataConsistency accurately', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'data.duckdb')
    const parquetDir = path.join(dir, 'db')
    const jsonPath = path.join(dir, 'static', 'activities.json')

    const store = new DuckDBActivityStore({ dbPath })
    await store.upsertActivities([
      createOutdoorRunActivity({
        run_id: 100001,
        start_date: '2025-03-15T00:30:00Z',
        start_date_local: '2025-03-15T08:30:00',
      }),
      createIndoorWorkoutActivity({
        run_id: 100002,
        start_date: '2025-03-16T11:00:00Z',
        start_date_local: '2025-03-16T19:00:00',
      }),
      createOutdoorRunActivity({
        run_id: 100003,
        name: 'Evening Run',
        start_date: '2025-03-17T09:00:00Z',
        start_date_local: '2025-03-17T17:00:00',
      }),
    ])
    await store.storeFlybyPoints(createOutdoorRunFlybyPoints(100001))
    await store.close()

    // Test onlyRun filter in loadActivities
    const runsOnly = await loadActivities({ dbPath, onlyRun: true })
    expect(runsOnly.map(a => a.run_id)).toEqual([100001, 100003])

    // Export full activities.json
    const jsonResult = await exportActivitiesJson({
      dbPath,
      outputPath: jsonPath,
      polylineOptions: { ignoreRangeMeters: 0, ignoreStartEndRangeMeters: 0, ignorePoints: [] },
    })
    expect(jsonResult.count).toBe(3)
    expect(jsonResult.activities.map(a => a.streak)).toEqual([1, 2, 3])
    expect(fs.existsSync(jsonPath)).toBe(true)

    // Export Parquet (including a nonexistent table to verify graceful skip)
    const pqResult = await exportParquet({
      dbPath,
      outputDir: parquetDir,
      tables: ['activities', 'activities_flyby', 'nonexistent_table'],
    })
    expect(pqResult.exportedFiles).toEqual([
      path.join(parquetDir, 'activities.parquet'),
      path.join(parquetDir, 'activities_flyby.parquet'),
    ])
    expect(pqResult.skippedTables).toEqual(['nonexistent_table'])

    // Validate 3-way consistency -> passes
    const report = await validateDataConsistency({
      dbPath,
      parquetPath: path.join(parquetDir, 'activities.parquet'),
      jsonPath,
    })
    expect(report).toEqual({
      ok: true,
      db: { count: 3, maxStartDateLocal: '2025-03-17 17:00:00' },
      parquet: { count: 3, maxStartDateLocal: '2025-03-17 17:00:00' },
      json: { count: 3, maxStartDateLocal: '2025-03-17 17:00:00' },
    })

    // Tamper JSON count -> fails with count mismatch
    const originalJson = fs.readFileSync(jsonPath, 'utf8')
    const tamperedCount = JSON.parse(originalJson).slice(0, 2)
    fs.writeFileSync(jsonPath, JSON.stringify(tamperedCount), 'utf8')
    await expect(validateDataConsistency({
      dbPath,
      parquetPath: path.join(parquetDir, 'activities.parquet'),
      jsonPath,
    })).rejects.toThrow(/count mismatch/)

    // Tamper JSON max start_date_local (same count = 3) -> fails with max start_date_local mismatch
    const tamperedMax = JSON.parse(originalJson)
    tamperedMax[2].start_date_local = '2025-03-18T00:00:00'
    fs.writeFileSync(jsonPath, JSON.stringify(tamperedMax), 'utf8')
    await expect(validateDataConsistency({
      dbPath,
      parquetPath: path.join(parquetDir, 'activities.parquet'),
      jsonPath,
    })).rejects.toThrow(/max start_date_local mismatch/)

    // Restore JSON, tamper Parquet -> fails
    fs.writeFileSync(jsonPath, originalJson, 'utf8')
    const memHandle = await openDuckDBConnection({ dbPath: ':memory:' })
    try {
      const pqPath = path.join(parquetDir, 'activities.parquet')
      await memHandle.connection.run(
        `COPY (SELECT * FROM read_parquet('${pqPath}') LIMIT 2) TO '${pqPath}.tampered' (FORMAT PARQUET)`,
      )
      fs.renameSync(`${pqPath}.tampered`, pqPath)
    }
    finally {
      await memHandle.close()
    }
    await expect(validateDataConsistency({
      dbPath,
      parquetPath: path.join(parquetDir, 'activities.parquet'),
      jsonPath,
    })).rejects.toThrow(/count mismatch/)

    // Missing file -> throws StorageError
    await expect(validateDataConsistency({
      dbPath,
      parquetPath: path.join(parquetDir, 'missing.parquet'),
      jsonPath,
    })).rejects.toThrow(StorageError)
  })
})
