import type { GarminClientLike } from '@running-data-sync/core'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOutdoorRunActivity, FakeActivityFormatPort, InMemoryActivityStore } from '@running-data-sync/core/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_VERSION, runCli } from './index.js'

function createBufferIO() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (chunk: string) => {
        stdout += chunk
      },
      stderr: (chunk: string) => {
        stderr += chunk
      },
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

function createFakeGarminClient(): GarminClientLike {
  return {
    account: 'garmin_com',
    domain: 'garmin.com',
    getActivities: vi.fn(async () => []),
    fetchAllActivities: vi.fn(async () => []),
    getActivitySummary: vi.fn(async () => ({})),
    uploadActivity: vi.fn(async () => ({
      status: 202,
      detailedImportResult: null,
      remoteActivityId: 999001,
      duplicate: false,
    })),
    deleteActivity: vi.fn(async () => {}),
    downloadActivity: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('cli help, version, and validation', () => {
  it('prints usage and exits 0 on --help or empty args', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--help'], buf.io)
    expect(code).toBe(0)
    expect(buf.getStdout()).toContain('Usage: running-data-sync')
    expect(buf.getStderr()).toBe('')
  })

  it('prints subcommand help for every top-level command', async () => {
    for (const cmd of ['sync', 'vendor', 'garmin', 'export', 'data', 'svg']) {
      const buf = createBufferIO()
      const code = await runCli([cmd, '--help'], buf.io)
      expect(code).toBe(0)
      expect(buf.getStdout()).toContain(`Usage: running-data-sync ${cmd}`)
    }
  })

  it('prints version and exits 0 on --version', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--version'], buf.io)
    expect(code).toBe(0)
    expect(buf.getStdout().trim()).toBe(CLI_VERSION)
  })

  it('prints resolved monorepo runtime paths on --show-paths', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--show-paths'], buf.io)
    expect(code).toBe(0)
    const parsed = JSON.parse(buf.getStdout()) as Record<string, string>
    expect(parsed.sqlFile).toContain(path.join('data', 'data.duckdb'))
    expect(parsed.jsonFile).toContain(path.join('apps', 'web', 'src', 'static', 'activities.json'))
    expect(parsed.dbDir).toContain(path.join('apps', 'web', 'public', 'db'))
  })

  it('exits non-zero on unknown commands and invalid arguments', async () => {
    const unknown = createBufferIO()
    expect(await runCli(['unknown-cmd'], unknown.io)).toBe(1)
    expect(unknown.getStderr()).toContain('Unknown or unimplemented command: unknown-cmd')

    const badExport = createBufferIO()
    expect(await runCli(['export', '--format', 'csv', '--all'], badExport.io)).toBe(1)
    expect(badExport.getStderr()).toContain('export requires --format fit|tcx|gpx')

    const missingTarget = createBufferIO()
    expect(await runCli(['export', '--format', 'fit'], missingTarget.io)).toBe(1)
    expect(missingTarget.getStderr()).toContain('export requires one of --all, --id, or --id-range')

    const badRange = createBufferIO()
    expect(await runCli(['export', '--format', 'fit', '--id-range', '200:100'], badRange.io)).toBe(1)
    expect(badRange.getStderr()).toContain('--id-range start must be <= end')
  })
})

describe('cli command handlers with in-memory doubles', () => {
  it('runs sync db against in-memory store and mocked Strava client', async () => {
    const store = new InMemoryActivityStore()
    const buf = createBufferIO()
    const code = await runCli(
      ['sync', 'db', '--client-id', 'cid', '--client-secret', 'csec', '--refresh-token', 'rtok', '--only-run'],
      buf.io,
      {
        createStore: () => store,
        createStravaClient: () => ({
          refreshAccessToken: async () => ({
            access_token: 'access',
            refresh_token: 'rtok',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          listActivities: async () => [],
          getActivity: async () => {
            throw new Error('not called')
          },
          getActivityStreams: async () => ({}),
        }),
      },
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(buf.getStdout()) as { fetchedActivities: number }
    expect(parsed.fetchedActivities).toBe(0)
  })

  it('runs vendor garmin, garmin-reconcile, status, and garmin-files', async () => {
    const store = new InMemoryActivityStore({ activities: [createOutdoorRunActivity({ run_id: 101 })] })
    const formatPort = new FakeActivityFormatPort()
    const garminClient = createFakeGarminClient()

    const syncBuf = createBufferIO()
    expect(await runCli(['vendor', 'garmin', '--secret-string', 'fake-secret'], syncBuf.io, {
      createStore: () => store,
      createFormatPort: () => formatPort,
      createGarminClient: () => garminClient,
    })).toBe(0)
    expect(JSON.parse(syncBuf.getStdout())).toMatchObject({ account: 'garmin_com', synced: 1 })

    const reconcileBuf = createBufferIO()
    expect(await runCli(['vendor', 'garmin-reconcile', '--secret-string', 'fake-secret'], reconcileBuf.io, {
      createStore: () => store,
      createGarminClient: () => garminClient,
    })).toBe(0)
    expect(JSON.parse(reconcileBuf.getStdout())).toMatchObject({ account: 'garmin_com', totalLocal: 1 })

    const statusBuf = createBufferIO()
    expect(await runCli(['vendor', 'status', '--vendor', 'garmin'], statusBuf.io, {
      createStore: () => store,
    })).toBe(0)
    expect(JSON.parse(statusBuf.getStdout())).toMatchObject({ vendor: 'garmin', total: 1 })

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rds-cli-files-'))
    tempDirs.push(tempDir)
    const sampleFit = path.join(tempDir, 'sample.fit')
    await writeFile(sampleFit, new Uint8Array([0x0E, 0x10, 0x00, 0x00]))

    const uploadBuf = createBufferIO()
    expect(await runCli(['vendor', 'garmin-files', '--secret-string', 'fake-secret', sampleFit], uploadBuf.io, {
      createGarminClient: () => garminClient,
    })).toBe(0)
    expect(JSON.parse(uploadBuf.getStdout())).toMatchObject({ totalFiles: 1, uploaded: [sampleFit] })
  })

  it('runs garmin sync and garmin secret', async () => {
    const store = new InMemoryActivityStore()
    const formatPort = new FakeActivityFormatPort()
    const garminClient = createFakeGarminClient()

    const syncBuf = createBufferIO()
    expect(await runCli(['garmin', 'sync', '--fit', 'fake-secret'], syncBuf.io, {
      createStore: () => store,
      createFormatPort: () => formatPort,
      createGarminClient: () => garminClient,
    })).toBe(0)
    expect(JSON.parse(syncBuf.getStdout())).toMatchObject({ account: 'garmin_com', fileType: 'fit', fetched: 0 })

    const secretBuf = createBufferIO()
    expect(await runCli(['garmin', 'secret', 'runner@example.com', 'pw123'], secretBuf.io, {
      getGarminSecretFn: async () => 'serialized-garth-secret',
    })).toBe(0)
    expect(secretBuf.getStdout().trim()).toBe('serialized-garth-secret')
  })

  it('runs export and svg commands against in-memory store', async () => {
    const store = new InMemoryActivityStore({ activities: [createOutdoorRunActivity({ run_id: 202 })] })
    const formatPort = new FakeActivityFormatPort()
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rds-cli-out-'))
    tempDirs.push(tempDir)

    const exportBuf = createBufferIO()
    expect(await runCli(['export', '--format', 'fit', '--id', '202', '--output-dir', tempDir], exportBuf.io, {
      createStore: () => store,
      createFormatPort: () => formatPort,
    })).toBe(0)
    const exportResult = JSON.parse(exportBuf.getStdout()) as { exported: Array<{ filePath: string }> }
    expect(exportResult.exported).toHaveLength(1)

    const svgPath = path.join(tempDir, 'github.svg')
    const svgBuf = createBufferIO()
    expect(await runCli(['svg', '--from-db', '--type', 'github', '--output', svgPath], svgBuf.io, {
      createStore: () => store,
    })).toBe(0)
    const svgContent = await readFile(svgPath, 'utf8')
    expect(svgContent).toContain('<svg')
  })

  it('runs data json, parquet, and validate handlers', async () => {
    const jsonBuf = createBufferIO()
    expect(await runCli(['data', 'json'], jsonBuf.io, {
      exportActivitiesJsonFn: async () => ({
        outputPath: '/tmp/activities.json',
        count: 3,
        activities: [],
      }),
    })).toBe(0)
    expect(JSON.parse(jsonBuf.getStdout())).toMatchObject({ count: 3 })

    const parquetBuf = createBufferIO()
    let capturedIncludeFlyby: boolean | undefined
    expect(await runCli(['data', 'parquet', '--tables', 'activities,activities_flyby', '--exclude-flyby'], parquetBuf.io, {
      exportParquetFn: async (opts) => {
        capturedIncludeFlyby = opts?.includeFlyby
        return {
          outputDir: '/tmp/db',
          exportedFiles: ['/tmp/db/activities.parquet'],
          skippedTables: [],
        }
      },
    })).toBe(0)
    expect(capturedIncludeFlyby).toBe(false)
    expect(JSON.parse(parquetBuf.getStdout())).toMatchObject({ outputDir: '/tmp/db' })

    const validateBuf = createBufferIO()
    expect(await runCli(['data', 'validate'], validateBuf.io, {
      validateDataConsistencyFn: async () => ({
        ok: true,
        db: { count: 3, totalDistance: 15000, maxStartDateLocal: '2025-05-10 08:30:00' },
        json: { count: 3, totalDistance: 15000, maxStartDateLocal: '2025-05-10 08:30:00' },
        parquet: { count: 3, totalDistance: 15000, maxStartDateLocal: '2025-05-10 08:30:00' },
      }),
    })).toBe(0)
  })
})
