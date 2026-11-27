import type {
  ReconcileGarminResult,
  SyncStoreToGarminResult,
  UploadFilesToGarminResult,
  VendorStatusSummary,
} from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import { parseArgs } from 'node:util'
import {
  ConfigurationError,
  getVendorStatusFromDb,
  reconcileGarminDb,
  resolveGarminCredentials,
  syncDbToGarmin,
  uploadLocalFilesToGarmin,
} from '@running-data-sync/core'
import {
  createEnvOptions,
  parseIntegerOption,
  parseNumberOption,
  resolveStoreBackedOptions,
} from './context.js'
import { formatSubcommandHelp } from './help.js'

export async function handleVendor(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    ctx.io.stdout(formatSubcommandHelp('vendor'))
    return 0
  }

  const [target, ...rest] = args
  if (target === 'garmin') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'is-cn': { type: 'boolean', default: false },
        'secret-string': { type: 'string' },
        'use-fake-garmin-device': { type: 'boolean', default: false },
        'fix-hr': { type: 'boolean', default: false },
        'force': { type: 'boolean', short: 'f', default: false },
        'match-window-sec': { type: 'string' },
        'distance-tolerance-m': { type: 'string' },
        'duration-tolerance-sec': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.values['secret-string'],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(ctx.deps, ctx.runtime),
    )

    const result: SyncStoreToGarminResult = await syncDbToGarmin({
      ...resolveStoreBackedOptions(ctx, false),
      formatPort: ctx.deps.createFormatPort?.(),
      client: ctx.deps.createGarminClient?.({ ...credentials, logger: ctx.logger }),
      credentials,
      useFakeGarminDevice: parsed.values['use-fake-garmin-device'],
      fixHr: parsed.values['fix-hr'],
      force: parsed.values.force,
      matchWindowSec: parseIntegerOption(parsed.values['match-window-sec'], '--match-window-sec'),
      distanceToleranceM: parseNumberOption(parsed.values['distance-tolerance-m'], '--distance-tolerance-m'),
      durationToleranceSec: parseIntegerOption(parsed.values['duration-tolerance-sec'], '--duration-tolerance-sec'),
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'garmin-reconcile') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'is-cn': { type: 'boolean', default: false },
        'secret-string': { type: 'string' },
        'match-window-sec': { type: 'string' },
        'distance-tolerance-m': { type: 'string' },
        'duration-tolerance-sec': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.values['secret-string'],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(ctx.deps, ctx.runtime),
    )

    const result: ReconcileGarminResult = await reconcileGarminDb({
      ...resolveStoreBackedOptions(ctx, false),
      client: ctx.deps.createGarminClient?.({ ...credentials, logger: ctx.logger }),
      credentials,
      matchWindowSec: parseIntegerOption(parsed.values['match-window-sec'], '--match-window-sec'),
      distanceToleranceM: parseNumberOption(parsed.values['distance-tolerance-m'], '--distance-tolerance-m'),
      durationToleranceSec: parseIntegerOption(parsed.values['duration-tolerance-sec'], '--duration-tolerance-sec'),
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'status') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'vendor': { type: 'string', default: 'garmin' },
        'account': { type: 'string' },
        'is-cn': { type: 'boolean', default: false },
        'retry-failed': { type: 'boolean', default: false },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const result: VendorStatusSummary = await getVendorStatusFromDb({
      ...resolveStoreBackedOptions(ctx, !parsed.values['retry-failed']),
      vendor: parsed.values.vendor,
      account: parsed.values.account,
      isCn: parsed.values['is-cn'],
      retryFailed: parsed.values['retry-failed'],
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'garmin-files') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'is-cn': { type: 'boolean', default: false },
        'secret-string': { type: 'string' },
        'recursive': { type: 'boolean', default: false },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }
    if (parsed.positionals.length === 0) {
      throw new ConfigurationError('vendor garmin-files requires at least one file or directory path')
    }

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.values['secret-string'],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(ctx.deps, ctx.runtime),
    )

    const result: UploadFilesToGarminResult = await uploadLocalFilesToGarmin({
      client: ctx.deps.createGarminClient?.({ ...credentials, logger: ctx.logger }),
      credentials,
      paths: parsed.positionals,
      recursive: parsed.values.recursive,
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return result.failures.length > 0 ? 1 : 0
  }

  ctx.io.stderr(`Unknown vendor subcommand: ${target}\n\n${formatSubcommandHelp('vendor')}`)
  return 1
}
