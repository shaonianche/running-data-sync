import type { ObjectStorePort } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import type { ExportCommandResult } from './export.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ConfigurationError, createLogger, resolveRuntimeConfig, StorageError } from '@running-data-sync/core'
import {
  createOutdoorRunActivity,
  FakeActivityFormatPort,
  InMemoryActivityStore,
  InMemoryObjectStore,
} from '@running-data-sync/core/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleExport } from './export.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTestContext(
  activityStore: InMemoryActivityStore,
  processEnv: Record<string, string | undefined> = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rds-cli-export-'))
  tempDirs.push(dir)

  let stdout = ''
  let stderr = ''
  const runtime = resolveRuntimeConfig({ projectRoot: dir })
  const ctx: CliCommandContext = {
    io: {
      stdout: (chunk: string) => {
        stdout += chunk
      },
      stderr: (chunk: string) => {
        stderr += chunk
      },
    },
    deps: {
      runtimeConfig: runtime,
      processEnv,
      createStore: () => activityStore,
      createFormatPort: () => new FakeActivityFormatPort(),
    },
    runtime,
    logger: createLogger('cli.export.test', { sink: () => {} }),
  }

  return {
    dir,
    ctx,
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

describe('handleExport with --upload-private', () => {
  it('keeps default local export working without R2 credentials or privateUploads', async () => {
    const activityStore = new InMemoryActivityStore({
      activities: [createOutdoorRunActivity({ run_id: 5001 })],
    })
    const { dir, ctx, getStdout } = await createTestContext(activityStore, {})

    const code = await handleExport(
      ['--format', 'gpx', '--id', '5001', '--output-dir', path.join(dir, 'out')],
      ctx,
    )

    expect(code).toBe(0)
    const parsed = JSON.parse(getStdout()) as ExportCommandResult
    expect(parsed.exported).toHaveLength(1)
    expect(parsed.failed).toHaveLength(0)
    expect(parsed.privateUploads).toBeUndefined()
  })

  it('uploads exported FIT/GPX/TCX files to ObjectStorePort and deduplicates repeat runs', async () => {
    const activityStore = new InMemoryActivityStore({
      activities: [
        createOutdoorRunActivity({ run_id: 6001 }),
        createOutdoorRunActivity({ run_id: 6002 }),
      ],
    })
    const objectStore = new InMemoryObjectStore()

    const firstRun = await createTestContext(activityStore)
    const firstCode = await handleExport(
      ['--format', 'fit', '--all', '--output-dir', path.join(firstRun.dir, 'out'), '--upload-private'],
      firstRun.ctx,
      { createObjectStore: () => objectStore },
    )

    expect(firstCode).toBe(0)
    const firstOutput = JSON.parse(firstRun.getStdout()) as ExportCommandResult
    expect(firstOutput.exported).toHaveLength(2)
    expect(firstOutput.privateUploads?.failed).toHaveLength(0)
    expect(firstOutput.privateUploads?.uploaded).toHaveLength(2)
    expect(firstOutput.privateUploads?.uploaded.every(item => item.deduplicated === false)).toBe(true)
    expect(firstOutput.privateUploads?.uploaded[0]?.key).toMatch(/^artifacts\/6001\/[0-9a-f]{64}\.fit$/)
    expect(objectStore.size).toBe(2)

    // Repeat run with identical content must succeed idempotently.
    const secondRun = await createTestContext(activityStore)
    const secondCode = await handleExport(
      ['--format', 'fit', '--all', '--output-dir', path.join(secondRun.dir, 'out'), '--upload-private'],
      secondRun.ctx,
      { createObjectStore: () => objectStore },
    )

    expect(secondCode).toBe(0)
    const secondOutput = JSON.parse(secondRun.getStdout()) as ExportCommandResult
    expect(secondOutput.privateUploads?.failed).toHaveLength(0)
    expect(secondOutput.privateUploads?.uploaded).toHaveLength(2)
    expect(secondOutput.privateUploads?.uploaded.every(item => item.deduplicated === true)).toBe(true)
    expect(objectStore.size).toBe(2)
  })

  it('fails fast with ConfigurationError when --upload-private is set without R2 env', async () => {
    const activityStore = new InMemoryActivityStore({
      activities: [createOutdoorRunActivity({ run_id: 7001 })],
    })
    const { dir, ctx } = await createTestContext(activityStore, {})

    await expect(
      handleExport(
        ['--format', 'gpx', '--id', '7001', '--output-dir', path.join(dir, 'out'), '--upload-private'],
        ctx,
      ),
    ).rejects.toThrow(ConfigurationError)
  })

  it('reports per-activity upload failures and exits non-zero while preserving local exports', async () => {
    const activityStore = new InMemoryActivityStore({
      activities: [createOutdoorRunActivity({ run_id: 8001 })],
    })
    const failingObjectStore: ObjectStorePort = {
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      put: vi.fn(async () => {
        throw new StorageError('R2 unavailable')
      }),
    }

    const { dir, ctx, getStdout } = await createTestContext(activityStore)
    const code = await handleExport(
      ['--format', 'tcx', '--id', '8001', '--output-dir', path.join(dir, 'out'), '--upload-private'],
      ctx,
      { createObjectStore: () => failingObjectStore },
    )

    expect(code).toBe(1)
    const parsed = JSON.parse(getStdout()) as ExportCommandResult
    expect(parsed.exported).toHaveLength(1)
    expect(parsed.privateUploads?.uploaded).toHaveLength(0)
    expect(parsed.privateUploads?.failed).toEqual([
      expect.objectContaining({
        activityId: 8001,
        error: 'R2 unavailable',
      }),
    ])
  })
})
