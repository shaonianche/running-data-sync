import process from 'node:process'
import { parseArgs } from 'node:util'
import {
  createLogger,
  redactSensitiveMessage,
  resolveRuntimeConfig,
  RunningDataSyncError,
} from '@running-data-sync/core'

export const CLI_VERSION = '0.1.0'

export interface CliIO {
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
}

const DEFAULT_IO: CliIO = {
  stdout: chunk => process.stdout.write(chunk),
  stderr: chunk => process.stderr.write(chunk),
}

export function formatUsage(): string {
  return [
    'Usage: running-data-sync <command> [options]',
    '',
    'Commands (planned in subsequent migration phases):',
    '  sync       Sync activities from Strava to DuckDB',
    '  vendor     Sync activities to Garmin (COM / CN) and manage sync status',
    '  garmin     Garmin auth and activity helpers',
    '  export     Export FIT / TCX / GPX activity files from DuckDB',
    '  data       Export Parquet/JSON and validate data consistency',
    '  svg        Generate GitHub / Grid SVG posters',
    '',
    'Options:',
    '  -h, --help          Show help information',
    '  -v, --version       Show CLI version',
    '  --show-paths        Print resolved runtime paths',
    '',
  ].join('\n')
}

export async function runCli(argv: readonly string[], io: CliIO = DEFAULT_IO): Promise<number> {
  const logger = createLogger('cli', {
    sink: (record) => {
      io.stderr(`[${record.level.toUpperCase()}] ${record.message}\n`)
    },
  })

  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: false,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'version': { type: 'boolean', short: 'v', default: false },
        'show-paths': { type: 'boolean', default: false },
      },
    })

    if (parsed.values.version) {
      io.stdout(`${CLI_VERSION}\n`)
      return 0
    }

    if (parsed.values['show-paths']) {
      const runtime = resolveRuntimeConfig()
      io.stdout(`${JSON.stringify(runtime, null, 2)}\n`)
      return 0
    }

    if (parsed.values.help || parsed.positionals.length === 0) {
      io.stdout(formatUsage())
      return 0
    }

    const [command] = parsed.positionals
    io.stderr(`Unknown or unimplemented command: ${command}\n\n${formatUsage()}`)
    return 1
  }
  catch (error) {
    if (error instanceof RunningDataSyncError) {
      logger.error(error.message)
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`${redactSensitiveMessage(message)}\n`)
    return 1
  }
}
