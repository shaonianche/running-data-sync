import type { BatchExportResult } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigurationError, exportActivitiesFromDb } from '@running-data-sync/core'
import { parseIdRange, parseIntegerOption, resolveStoreBackedOptions } from './context.js'
import { formatSubcommandHelp } from './help.js'

export async function handleExport(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      'help': { type: 'boolean', short: 'h', default: false },
      'format': { type: 'string' },
      'all': { type: 'boolean', default: false },
      'id': { type: 'string', multiple: true },
      'id-range': { type: 'string' },
      'output-dir': { type: 'string' },
    },
  })

  if (parsed.values.help) {
    ctx.io.stdout(formatSubcommandHelp('export'))
    return 0
  }

  const format = parsed.values.format
  if (format !== 'fit' && format !== 'tcx' && format !== 'gpx') {
    throw new ConfigurationError('export requires --format fit|tcx|gpx')
  }

  const ids = (parsed.values.id ?? []).map(raw => parseIntegerOption(raw, '--id')!)
  const idRange = parseIdRange(parsed.values['id-range'])
  if (!parsed.values.all && ids.length === 0 && !idRange) {
    throw new ConfigurationError('export requires one of --all, --id, or --id-range')
  }

  const result: BatchExportResult = await exportActivitiesFromDb({
    ...resolveStoreBackedOptions(ctx, true),
    formatPort: ctx.deps.createFormatPort?.(),
    format,
    outputDir: parsed.values['output-dir'] ? path.resolve(parsed.values['output-dir']) : undefined,
    all: parsed.values.all,
    ids: ids.length > 0 ? ids : undefined,
    idRange,
  })

  ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  return result.failed.length > 0 ? 1 : 0
}
