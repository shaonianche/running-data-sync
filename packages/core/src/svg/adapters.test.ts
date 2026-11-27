import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ParseError } from '../foundation/errors.js'
import {
  createIndoorWorkoutActivity,
  createOutdoorRunActivity,
  createParsedTrackFixture,
  FakeActivityFormatPort,
  InMemoryActivityStore,
} from '../testing/index.js'
import {
  activityToPosterTrack,
  loadPosterTracksFromDirectory,
  loadPosterTracksFromFiles,
  loadPosterTracksFromRepository,
  parsedTrackToPosterTrack,
  renderPosterFromDirectory,
  renderPosterFromRepository,
} from './adapters.js'
import { ParameterError } from './errors.js'
import { DARK_POSTER_THEME, LIGHT_POSTER_THEME } from './poster.js'

describe('decoupled SVG data-source adapters', () => {
  it('loads and renders posters from an injected InMemoryActivityStore (fromDb mode)', async () => {
    const store = new InMemoryActivityStore({
      activities: [
        createOutdoorRunActivity({
          run_id: 101,
          name: '2024 Run',
          start_date_local: '2024-06-15T07:30:00',
          distance: 6500,
        }),
        createOutdoorRunActivity({
          run_id: 102,
          name: '2025 Long Run',
          start_date_local: '2025-03-15T08:30:00',
          distance: 21500,
        }),
        createIndoorWorkoutActivity({
          run_id: 103,
          name: 'Strength',
          start_date_local: '2025-03-16T19:00:00',
          distance: 0,
        }),
      ],
    })

    // Default onlyRun=true excludes Workout activity
    const runTracks = await loadPosterTracksFromRepository(store, {
      specialRunIds: [102],
    })
    expect(runTracks.map(t => t.runId)).toEqual([101, 102])
    expect(runTracks[0].special).toBe(false)
    expect(runTracks[1].special).toBe(true)

    // Year + minDistance filtering
    const year2025 = await loadPosterTracksFromRepository(store, {
      year: '2025',
      minDistanceKm: 10,
      hasPolyline: true,
    })
    expect(year2025.map(t => t.runId)).toEqual([102])

    // Explicit types filter can include non-run activities
    const allTypes = await loadPosterTracksFromRepository(store, {
      types: ['Run', 'Workout'],
    })
    expect(allTypes.map(t => t.runId)).toEqual([101, 102, 103])

    // Render directly from repository
    const svg = await renderPosterFromRepository(store, {
      type: 'github',
      title: 'From Store',
      athlete: 'TESTER',
      theme: DARK_POSTER_THEME,
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })
    expect(svg).toContain('viewBox="0,0,200,141"')
    expect(svg).toContain('>From Store</text>')
    expect(svg).toContain('>Total: 28.0 km</text>')

    await expect(loadPosterTracksFromRepository(store, { year: '2026-2020' })).rejects.toThrow(ParameterError)
  })

  it('loads, merges nearby segments, converts UTC to local time, and renders via FakeActivityFormatPort', async () => {
    const track1 = createParsedTrackFixture({
      runId: 501,
      name: 'Morning Warmup',
      startDate: '2025-03-15T00:00:00Z',
      endDate: '2025-03-15T00:20:00Z',
      startDateLocal: '2025-03-15T00:00:00Z',
      endDateLocal: '2025-03-15T00:20:00Z',
      distance: 3000,
    })
    const track2 = createParsedTrackFixture({
      runId: 502,
      name: 'Morning Main Set',
      startDate: '2025-03-15T00:30:00Z',
      endDate: '2025-03-15T01:00:00Z',
      startDateLocal: '2025-03-15T00:30:00Z',
      endDateLocal: '2025-03-15T01:00:00Z',
      distance: 7000,
    })
    const track3 = createParsedTrackFixture({
      runId: 503,
      name: 'Next Day Run',
      startDate: '2025-03-16T01:00:00Z',
      endDate: '2025-03-16T01:40:00Z',
      startDateLocal: '2025-03-16T09:00:00',
      endDateLocal: '2025-03-16T09:40:00',
      distance: 8000,
    })

    const tracksByFile: Record<string, ReturnType<typeof createParsedTrackFixture>> = {
      'run1.gpx': track1,
      'run2.gpx': track2,
      'run3.tcx': track3,
    }

    const formatPort = new FakeActivityFormatPort({
      parseTrack: async (_data, options) => {
        const name = options?.fileName ?? ''
        if (name === 'corrupt.gpx') {
          throw new ParseError('Corrupt GPX payload')
        }
        return tracksByFile[name] ?? createParsedTrackFixture()
      },
    })

    const parseErrors: string[] = []
    const tracks = await loadPosterTracksFromFiles(
      [
        { fileName: 'run2.gpx', data: '<gpx />' },
        { fileName: 'run1.gpx', data: '<gpx />' },
        { fileName: 'run3.tcx', data: '<tcx />' },
        { fileName: 'corrupt.gpx', data: 'bad' },
      ],
      formatPort,
      {
        useLocalTime: true,
        mergeWithinSeconds: 1800,
        specialFileNames: ['run2.gpx'],
        onParseError: fileName => parseErrors.push(fileName),
      },
    )

    expect(parseErrors).toEqual(['corrupt.gpx'])
    // track1 (08:00-08:20) and track2 (08:30-09:00) merge into one 10km special track; track3 stays separate
    expect(tracks).toHaveLength(2)
    expect(tracks[0].startDateLocal).toBe('2025-03-15T08:00:00')
    expect(tracks[0].distance).toBe(10000)
    expect(tracks[0].special).toBe(true)
    expect(tracks[0].polylines).toHaveLength(2)
    expect(tracks[1].runId).toBe(503)
    expect(tracks[1].distance).toBe(8000)
  })

  it('loads and renders tracks from a directory using FakeActivityFormatPort without native parsers', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rds-svg-dir-'))
    try {
      await writeFile(path.join(tmpDir, 'a.gpx'), '<gpx version="1.1"></gpx>', 'utf8')
      await writeFile(path.join(tmpDir, 'b.tcx'), '<TrainingCenterDatabase />', 'utf8')
      await writeFile(path.join(tmpDir, 'skip.gpx'), '<gpx />', 'utf8')
      await writeFile(path.join(tmpDir, 'empty.gpx'), '', 'utf8')
      await writeFile(path.join(tmpDir, '.hidden.gpx'), '<gpx />', 'utf8')
      await writeFile(path.join(tmpDir, 'notes.txt'), 'ignored', 'utf8')

      const dirTracksByFile: Record<string, ReturnType<typeof createParsedTrackFixture>> = {
        'a.gpx': createParsedTrackFixture({ runId: 601, startDateLocal: '2025-04-01T07:00:00', distance: 6000 }),
        'b.tcx': createParsedTrackFixture({ runId: 602, startDateLocal: '2025-04-05T07:00:00', distance: 15000 }),
        'skip.gpx': createParsedTrackFixture({ runId: 603, startDateLocal: '2025-04-06T07:00:00', distance: 9000 }),
      }
      const formatPort = new FakeActivityFormatPort({
        parseTrack: async (_data, options) => dirTracksByFile[options?.fileName ?? ''] ?? createParsedTrackFixture(),
      })

      const tracks = await loadPosterTracksFromDirectory(tmpDir, formatPort, {
        skipFileNames: ['skip.gpx'],
      })
      expect(tracks.map(t => t.runId)).toEqual([601, 602])

      const svg = await renderPosterFromDirectory(tmpDir, formatPort, {
        type: 'grid',
        title: 'Dir Grid',
        athlete: 'DIR',
        minDistanceKm: 5,
        skipFileNames: ['skip.gpx'],
        theme: LIGHT_POSTER_THEME,
      })
      expect(svg).toContain('>Dir Grid</text>')
      expect(svg).toContain('<desc>602</desc>')
      expect(svg).toContain('<desc>601</desc>')
      expect(svg).not.toContain('<desc>603</desc>')

      await expect(loadPosterTracksFromDirectory(path.join(tmpDir, 'missing'), formatPort))
        .rejects
        .toThrow(ParameterError)
    }
    finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps Activity and ParsedTrack entities cleanly into PosterTrack projections', () => {
    const activity = createOutdoorRunActivity()
    const mapped = activityToPosterTrack(activity, { special: true })
    expect(mapped).toEqual({
      runId: activity.run_id,
      name: activity.name,
      type: activity.type,
      startDateLocal: activity.start_date_local,
      distance: activity.distance,
      summaryPolyline: activity.summary_polyline,
      special: true,
    })

    const utcParsed = createParsedTrackFixture({
      startDate: '2025-03-15T00:30:00Z',
      startDateLocal: '2025-03-15T00:30:00Z',
    })
    const converted = parsedTrackToPosterTrack(utcParsed, { useLocalTime: true })
    expect(converted.startDateLocal).toBe('2025-03-15T08:30:00')
  })

  it('applies filterPolyline privacy clipping when loading poster tracks from repository', async () => {
    const activity = createOutdoorRunActivity({ run_id: 9001 })
    const repo = new InMemoryActivityStore({ activities: [activity] })

    const clippedTracks = await loadPosterTracksFromRepository(repo, {
      polylineOptions: {
        ignoreStartEndRangeMeters: 700,
        ignoreRangeMeters: 0,
        ignorePoints: [],
      },
    })
    expect(clippedTracks).toHaveLength(1)
    expect(clippedTracks[0]?.summaryPolyline).not.toBe(activity.summary_polyline)
    expect(clippedTracks[0]?.summaryPolyline).not.toBeNull()

    const unfilteredTracks = await loadPosterTracksFromRepository(repo, {
      applyPolylineFilter: false,
    })
    expect(unfilteredTracks[0]?.summaryPolyline).toBe(activity.summary_polyline)
  })
})
