import type { ObjectStorePort } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { ConfigurationError, DuckDBSnapshotManager, R2ObjectStore } from '@running-data-sync/core'
import { parseIntegerOption } from './context.js'

export const DB_COMMAND_HELP = `Usage: running-data-sync db <subcommand> [options]

Manage versioned DuckDB snapshots in private R2/S3 object storage.

Subcommands:
  status      Show remote manifest status and available snapshots
  pull        Download and verify the current snapshot to a local path
  push        Upload a checkpointed local .duckdb snapshot and flip manifest.json via If-Match
  bootstrap   Initialize remote snapshots for the first time (If-None-Match: *)
  rollback    Atomically roll back manifest.json to previousKey or a specified snapshot key
  prune       Delete old snapshots while keeping the latest N, currentKey, and previousKey

Common options:
  --manifest-key <key>        Remote manifest key (default: manifest.json)
  --snapshot-prefix <prefix>  Remote snapshot key prefix (default: snapshots/)
  -h, --help                  Show this help message
`

export interface DbCommandOptions {
  readonly createObjectStore?: (env: Readonly<Record<string, string | undefined>>) => ObjectStorePort
  readonly now?: () => Date
}

interface LocalPullState {
  readonly manifestEtag: string
  readonly sha256: string
  readonly currentKey: string
  readonly pulledAt: string
}

function defaultStateFilePath(dbPath: string): string {
  return `${dbPath}.snapshot-state.json`
}

function writePullState(statePath: string, state: LocalPullState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function readPullState(statePath: string): LocalPullState | null {
  if (!fs.existsSync(statePath)) {
    return null
  }
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<LocalPullState>
  if (!raw.manifestEtag || !raw.sha256 || !raw.currentKey) {
    throw new ConfigurationError(`Invalid snapshot state file: "${statePath}"`)
  }
  return {
    manifestEtag: raw.manifestEtag,
    sha256: raw.sha256,
    currentKey: raw.currentKey,
    pulledAt: raw.pulledAt ?? '',
  }
}

function resolveObjectStore(ctx: CliCommandContext, options?: DbCommandOptions): ObjectStorePort {
  const env = ctx.deps.processEnv ?? process.env
  if (options?.createObjectStore) {
    return options.createObjectStore(env)
  }
  return R2ObjectStore.fromEnv(env)
}

function createManager(
  ctx: CliCommandContext,
  flags: { readonly 'manifest-key'?: string, readonly 'snapshot-prefix'?: string },
  options?: DbCommandOptions,
): DuckDBSnapshotManager {
  const store = resolveObjectStore(ctx, options)
  return new DuckDBSnapshotManager({
    store,
    manifestKey: flags['manifest-key'],
    snapshotPrefix: flags['snapshot-prefix'],
    logger: ctx.logger,
    now: options?.now,
  })
}

export async function handleDb(
  args: readonly string[],
  ctx: CliCommandContext,
  options?: DbCommandOptions,
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    ctx.io.stdout(DB_COMMAND_HELP)
    return 0
  }

  const [subcommand, ...rest] = args

  if (subcommand === 'status') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const manager = createManager(ctx, parsed.values, options)
    const status = await manager.status()
    ctx.io.stdout(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'pull') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'output': { type: 'string' },
        'state-file': { type: 'string' },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const targetPath = parsed.values.output ? path.resolve(parsed.values.output) : ctx.runtime.sqlFile
    const statePath = parsed.values['state-file']
      ? path.resolve(parsed.values['state-file'])
      : defaultStateFilePath(targetPath)

    const manager = createManager(ctx, parsed.values, options)
    const result = await manager.pull({ targetPath })
    writePullState(statePath, {
      manifestEtag: result.manifestEtag,
      sha256: result.sha256,
      currentKey: result.manifest.currentKey,
      pulledAt: (options?.now?.() ?? new Date()).toISOString(),
    })

    ctx.io.stdout(`${JSON.stringify({ ...result, stateFile: statePath }, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'bootstrap') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'input': { type: 'string' },
        'state-file': { type: 'string' },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const sourcePath = parsed.values.input ? path.resolve(parsed.values.input) : ctx.runtime.sqlFile
    const statePath = parsed.values['state-file']
      ? path.resolve(parsed.values['state-file'])
      : defaultStateFilePath(sourcePath)

    const manager = createManager(ctx, parsed.values, options)
    const result = await manager.bootstrap({ sourcePath })
    writePullState(statePath, {
      manifestEtag: result.manifestEtag,
      sha256: result.sha256,
      currentKey: result.snapshotKey,
      pulledAt: (options?.now?.() ?? new Date()).toISOString(),
    })

    ctx.io.stdout(`${JSON.stringify({ ...result, stateFile: statePath }, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'push') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'input': { type: 'string' },
        'state-file': { type: 'string' },
        'expected-etag': { type: 'string' },
        'previous-sha256': { type: 'string' },
        'previous-key': { type: 'string' },
        'retain': { type: 'string' },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const sourcePath = parsed.values.input ? path.resolve(parsed.values.input) : ctx.runtime.sqlFile
    const statePath = parsed.values['state-file']
      ? path.resolve(parsed.values['state-file'])
      : defaultStateFilePath(sourcePath)
    const savedState = readPullState(statePath)

    const expectedManifestEtag = parsed.values['expected-etag'] ?? savedState?.manifestEtag
    if (!expectedManifestEtag) {
      throw new ConfigurationError(
        'db push requires --expected-etag or a state file created by `db pull` / `db bootstrap`.',
      )
    }

    const retainCount = parseIntegerOption(parsed.values.retain, '--retain')
    const manager = createManager(ctx, parsed.values, options)
    const result = await manager.push({
      sourcePath,
      expectedManifestEtag,
      previousSha256: parsed.values['previous-sha256'] ?? savedState?.sha256,
      previousKey: parsed.values['previous-key'] ?? savedState?.currentKey,
      retainCount,
    })

    if (result.uploaded && result.manifest) {
      writePullState(statePath, {
        manifestEtag: result.manifestEtag,
        sha256: result.sha256,
        currentKey: result.snapshotKey,
        pulledAt: (options?.now?.() ?? new Date()).toISOString(),
      })
    }

    ctx.io.stdout(`${JSON.stringify({ ...result, stateFile: statePath }, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'rollback') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'target-key': { type: 'string' },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const manager = createManager(ctx, parsed.values, options)
    const result = await manager.rollback({
      targetKey: parsed.values['target-key'],
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'prune') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'retain': { type: 'string' },
        'manifest-key': { type: 'string' },
        'snapshot-prefix': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(DB_COMMAND_HELP)
      return 0
    }
    const retainCount = parseIntegerOption(parsed.values.retain, '--retain')
    if (retainCount === undefined) {
      throw new ConfigurationError('db prune requires --retain <N> (integer >= 1).')
    }
    const manager = createManager(ctx, parsed.values, options)
    const result = await manager.prune({ retainCount })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  ctx.io.stderr(`Unknown db subcommand: ${subcommand}\n\n${DB_COMMAND_HELP}`)
  return 1
}
