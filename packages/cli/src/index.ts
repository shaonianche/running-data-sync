import type { CliDependencies, CliIO } from './commands/context.js'
import process from 'node:process'
import {
  createLogger,
  redactSensitiveMessage,
  resolveRuntimeConfig,
  RunningDataSyncError,
} from '@running-data-sync/core'
import { handleData } from './commands/data.js'
import { handleDb } from './commands/db.js'
import { handleExport } from './commands/export.js'
import { handleGarmin } from './commands/garmin.js'
import { formatUsage } from './commands/help.js'
import { handleSvg } from './commands/svg.js'
import { handleSync } from './commands/sync.js'
import { handleVendor } from './commands/vendor.js'

export type { CliDependencies, CliIO }
export { formatUsage }

export const CLI_VERSION = '0.1.0'

const DEFAULT_IO: CliIO = {
  stdout: chunk => process.stdout.write(chunk),
  stderr: chunk => process.stderr.write(chunk),
}

export async function runCli(
  argv: readonly string[],
  io: CliIO = DEFAULT_IO,
  deps: CliDependencies = {},
): Promise<number> {
  const logger = createLogger('cli', {
    sink: (record) => {
      io.stderr(`[${record.level.toUpperCase()}] ${record.message}\n`)
    },
  })

  try {
    if (argv.length === 0) {
      io.stdout(formatUsage())
      return 0
    }

    const [first, ...rest] = argv
    const runtime = resolveRuntimeConfig(deps.runtimeConfig)

    if (first === '-h' || first === '--help') {
      io.stdout(formatUsage())
      return 0
    }

    if (first === '-v' || first === '--version') {
      io.stdout(`${CLI_VERSION}\n`)
      return 0
    }

    if (first === '--show-paths') {
      io.stdout(`${JSON.stringify(runtime, null, 2)}\n`)
      return 0
    }

    const ctx = { io, deps, runtime, logger }

    switch (first) {
      case 'sync':
        return await handleSync(rest, ctx)
      case 'vendor':
        return await handleVendor(rest, ctx)
      case 'garmin':
        return await handleGarmin(rest, ctx)
      case 'export':
        return await handleExport(rest, ctx)
      case 'data':
        return await handleData(rest, ctx)
      case 'db':
        return await handleDb(rest, ctx, ctx.deps.createObjectStore
          ? { createObjectStore: () => ctx.deps.createObjectStore!() }
          : undefined)
      case 'svg':
        return await handleSvg(rest, ctx)
      default:
        io.stderr(`Unknown or unimplemented command: ${first}\n\n${formatUsage()}`)
        return 1
    }
  }
  catch (error) {
    if (error instanceof RunningDataSyncError) {
      logger.error(redactSensitiveMessage(error.message))
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`${redactSensitiveMessage(message)}\n`)
    return 1
  }
}
