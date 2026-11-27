import type {
  DataConsistencyReport,
  ExportActivitiesJsonResult,
  ExportParquetResult,
} from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  exportActivitiesJson,
  exportParquet,
  validateDataConsistency,
} from '@running-data-sync/core'
import { formatSubcommandHelp } from './help.js'

export async function handleData(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    ctx.io.stdout(formatSubcommandHelp('data'))
    return 0
  }

  const [target, ...rest] = args

  if (target === 'json') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        output: { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const fn = ctx.deps.exportActivitiesJsonFn ?? exportActivitiesJson
    const result: ExportActivitiesJsonResult = await fn({
      dbPath: ctx.runtime.sqlFile,
      outputPath: parsed.values.output ? path.resolve(parsed.values.output) : ctx.runtime.jsonFile,
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'parquet') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        'help': { type: 'boolean', short: 'h', default: false },
        'tables': { type: 'string', multiple: true },
        'output-dir': { type: 'string' },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const tableList = [
      ...(parsed.values.tables ?? []).flatMap(item => item.split(',').map(s => s.trim()).filter(Boolean)),
      ...parsed.positionals,
    ]
    const fn = ctx.deps.exportParquetFn ?? exportParquet
    const result: ExportParquetResult = await fn({
      dbPath: ctx.runtime.sqlFile,
      outputDir: parsed.values['output-dir'] ? path.resolve(parsed.values['output-dir']) : ctx.runtime.dbDir,
      tables: tableList.length > 0 ? tableList : undefined,
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (target === 'validate') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.help) {
      ctx.io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const fn = ctx.deps.validateDataConsistencyFn ?? validateDataConsistency
    const report: DataConsistencyReport = await fn({
      dbPath: ctx.runtime.sqlFile,
      jsonPath: ctx.runtime.jsonFile,
      parquetPath: path.join(ctx.runtime.dbDir, 'activities.parquet'),
      logger: ctx.logger,
    })
    ctx.io.stdout(`${JSON.stringify(report, null, 2)}\n`)
    return report.ok ? 0 : 1
  }

  ctx.io.stderr(`Unknown data subcommand: ${target}\n\n${formatSubcommandHelp('data')}`)
  return 1
}
