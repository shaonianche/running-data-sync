import type { SyncStravaResult } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import { parseArgs } from 'node:util'
import { resolveStravaCredentials, syncStravaToDb } from '@running-data-sync/core'
import { createEnvOptions, resolveStoreBackedOptions } from './context.js'
import { formatSubcommandHelp } from './help.js'

export async function handleSync(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    ctx.io.stdout(formatSubcommandHelp('sync'))
    return 0
  }

  const [target, ...rest] = args
  if (target !== 'db') {
    ctx.io.stderr(`Unknown sync subcommand: ${target}\n\n${formatSubcommandHelp('sync')}`)
    return 1
  }

  const parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      'help': { type: 'boolean', short: 'h', default: false },
      'force': { type: 'boolean', default: false },
      'prune': { type: 'boolean', default: false },
      'only-run': { type: 'boolean', default: false },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'refresh-token': { type: 'string' },
    },
  })

  if (parsed.values.help) {
    ctx.io.stdout(formatSubcommandHelp('sync'))
    return 0
  }

  const credentials = resolveStravaCredentials(
    {
      clientId: parsed.values['client-id'],
      clientSecret: parsed.values['client-secret'],
      refreshToken: parsed.values['refresh-token'],
    },
    createEnvOptions(ctx.deps, ctx.runtime),
  )

  const client = ctx.deps.createStravaClient?.({ ...credentials, logger: ctx.logger })

  const result: SyncStravaResult = await syncStravaToDb({
    ...resolveStoreBackedOptions(ctx, false),
    credentials,
    client,
    force: parsed.values.force,
    prune: parsed.values.prune,
    onlyRun: parsed.values['only-run'],
    logger: ctx.logger,
  })

  ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
