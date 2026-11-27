import type { CliCommandContext } from './context.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger, PreconditionFailedError, resolveRuntimeConfig } from '@running-data-sync/core'
import { InMemoryObjectStore } from '@running-data-sync/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_COMMAND_HELP, handleDb } from './db.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-cli-db-'))
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

function createContext(sqlFile: string) {
  let stdout = ''
  let stderr = ''
  const runtime = {
    ...resolveRuntimeConfig(),
    sqlFile,
  }
  const ctx: CliCommandContext = {
    io: {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
    },
    deps: {
      processEnv: {},
    },
    runtime,
    logger: createLogger('cli-db-test', { level: 'error' }),
  }
  return {
    ctx,
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

describe('handleDb CLI subcommands', () => {
  it('prints help when invoked with no args or --help', async () => {
    const dir = makeTempDir()
    const { ctx, getStdout } = createContext(path.join(dir, 'data.duckdb'))
    const code = await handleDb([], ctx)
    expect(code).toBe(0)
    expect(getStdout()).toBe(DB_COMMAND_HELP)
  })

  it('supports bootstrap -> status -> pull -> push (no-op & update) -> rollback -> prune', async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'data.duckdb')
    const pulledPath = path.join(dir, 'pulled.duckdb')
    fs.writeFileSync(dbPath, Buffer.from('cli-db-v1'))

    const store = new InMemoryObjectStore()
    let clockMs = Date.parse('2026-11-27T05:00:00.000Z')
    const opts = {
      createObjectStore: () => store,
      now: () => {
        clockMs += 1000
        return new Date(clockMs)
      },
    }

    // bootstrap
    const bootRun = createContext(dbPath)
    expect(await handleDb(['bootstrap', '--input', dbPath], bootRun.ctx, opts)).toBe(0)
    const bootJson = JSON.parse(bootRun.getStdout())
    expect(bootJson.snapshotKey).toMatch(/^snapshots\/data-20261127T050001Z-/)

    // status
    const statusRun = createContext(dbPath)
    expect(await handleDb(['status'], statusRun.ctx, opts)).toBe(0)
    const statusJson = JSON.parse(statusRun.getStdout())
    expect(statusJson.initialized).toBe(true)
    expect(statusJson.manifest.currentKey).toBe(bootJson.snapshotKey)

    // pull
    const pullRun = createContext(dbPath)
    expect(await handleDb(['pull', '--output', pulledPath], pullRun.ctx, opts)).toBe(0)
    const pullJson = JSON.parse(pullRun.getStdout())
    expect(fs.readFileSync(pulledPath, 'utf8')).toBe('cli-db-v1')

    // push unchanged -> no-op
    const noopRun = createContext(pulledPath)
    expect(await handleDb(['push', '--input', pulledPath], noopRun.ctx, opts)).toBe(0)
    const noopJson = JSON.parse(noopRun.getStdout())
    expect(noopJson.uploaded).toBe(false)

    // modify and push
    fs.writeFileSync(pulledPath, Buffer.from('cli-db-v2'))
    const pushRun = createContext(pulledPath)
    expect(await handleDb(['push', '--input', pulledPath], pushRun.ctx, opts)).toBe(0)
    const pushJson = JSON.parse(pushRun.getStdout())
    expect(pushJson.uploaded).toBe(true)
    expect(pushJson.manifest.previousKey).toBe(bootJson.snapshotKey)

    // stale push conflict
    fs.writeFileSync(pulledPath, Buffer.from('cli-db-v3-stale'))
    const conflictRun = createContext(pulledPath)
    await expect(
      handleDb(
        ['push', '--input', pulledPath, '--expected-etag', pullJson.manifestEtag],
        conflictRun.ctx,
        opts,
      ),
    ).rejects.toThrow(PreconditionFailedError)

    // rollback
    const rollbackRun = createContext(dbPath)
    expect(await handleDb(['rollback'], rollbackRun.ctx, opts)).toBe(0)
    const rollbackJson = JSON.parse(rollbackRun.getStdout())
    expect(rollbackJson.restoredKey).toBe(bootJson.snapshotKey)

    // prune (keeps currentKey, previousKey, and latest N=1 -> deletes the orphaned stale upload)
    const pruneRun = createContext(dbPath)
    expect(await handleDb(['prune', '--retain', '1'], pruneRun.ctx, opts)).toBe(0)
    const pruneJson = JSON.parse(pruneRun.getStdout())
    expect(pruneJson.protectedKeys).toContain(bootJson.snapshotKey)
    expect(pruneJson.protectedKeys).toContain(pushJson.snapshotKey)
    expect(pruneJson.keptKeys).toContain(bootJson.snapshotKey)
    expect(pruneJson.keptKeys).toContain(pushJson.snapshotKey)
  })
})
