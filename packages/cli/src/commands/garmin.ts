import type { ActivityFileFormat, SyncGarminToStoreResult } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import { parseArgs } from 'node:util'
import {
  ConfigurationError,
  getGarminSecret,
  loadEnvConfig,
  resolveGarminCredentials,
  syncGarminToDb,
} from '@running-data-sync/core'
import { createEnvOptions, resolveStoreBackedOptions } from './context.js'
import { formatSubcommandHelp } from './help.js'

export async function handleGarmin(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    ctx.io.stdout(formatSubcommandHelp('garmin'))
    return 0
  }

  const [target, ...rest] = args
  if (target === 'sync') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'is-cn': { type: 'boolean', default: false },
        'only-run': { type: 'boolean', default: false },
        'fit': { type: 'boolean', default: false },
        'tcx': { type: 'boolean', default: false },
        'gpx': { type: 'boolean', default: false },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('garmin'))
      return 0
    }

    const selectedFormats = (['fit', 'tcx', 'gpx'] as const).filter(fmt => parsed.values[fmt])
    if (selectedFormats.length > 1) {
      throw new ConfigurationError('Specify at most one of --fit, --tcx, or --gpx')
    }
    const fileType: ActivityFileFormat = selectedFormats[0] ?? 'gpx'

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.positionals[0],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(ctx.deps, ctx.runtime),
    )

    const result: SyncGarminToStoreResult = await syncGarminToDb({
      ...resolveStoreBackedOptions(ctx, false),
      formatPort: ctx.deps.createFormatPort?.(),
      client: ctx.deps.createGarminClient?.({ ...credentials, logger: ctx.logger }),
      credentials,
      fileType,
      onlyRunning: parsed.values['only-run'],
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'secret') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'is-cn': { type: 'boolean', default: false },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('garmin'))
      return 0
    }

    const env = loadEnvConfig(createEnvOptions(ctx.deps, ctx.runtime))
    const email = parsed.positionals[0] ?? env.garminEmail
    const password = parsed.positionals[1] ?? env.garminPassword
    const isCn = parsed.values['is-cn'] || env.garminIsCn?.toLowerCase() === 'true'
    if (!email || !password) {
      throw new ConfigurationError('Missing Garmin email or password. Provide positional args or set GARMIN_EMAIL/GARMIN_PASSWORD.')
    }

    const secretFn = ctx.deps.getGarminSecretFn ?? getGarminSecret
    const secret = await secretFn({ email, password, isCn })
    ctx.io.stdout(`${secret}\n`)
    return 0
  }

  ctx.io.stderr(`Unknown garmin subcommand: ${target}\n\n${formatSubcommandHelp('garmin')}`)
  return 1
}
