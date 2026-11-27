import type {
  ActivityFileFormat,
  ActivityFormatPort,
  ActivityStorePort,
  BatchExportResult,
  DataConsistencyReport,
  ExportActivitiesJsonResult,
  ExportParquetResult,
  GarminClientLike,
  Logger,
  PosterType,
  ReconcileGarminResult,
  RuntimeConfig,
  StravaClient,
  SyncGarminToStoreResult,
  SyncStoreToGarminResult,
  SyncStravaResult,
  UploadFilesToGarminResult,
  VendorStatusSummary,
} from '@running-data-sync/core'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import {
  ConfigurationError,
  createActivityFormatPort,
  createLogger,
  StravaClient as DefaultStravaClient,
  DuckDBActivityStore,
  exportActivities,
  exportActivitiesJson,
  exportParquet,
  getGarminSecret,
  getVendorStatus,
  loadEnvConfig,
  reconcileGarmin,
  redactSensitiveMessage,
  renderPosterFromDirectory,
  renderPosterFromRepository,
  resolveGarminCredentials,
  resolveRuntimeConfig,
  resolveStravaCredentials,
  RunningDataSyncError,
  syncGarminToStore,
  syncStoreToGarmin,
  syncStravaToStore,
  uploadFilesToGarmin,
  validateDataConsistency,
} from '@running-data-sync/core'

export const CLI_VERSION = '0.1.0'

export interface CliIO {
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
}

export interface CliDependencies {
  readonly runtimeConfig?: Partial<RuntimeConfig>
  readonly processEnv?: Readonly<Record<string, string | undefined>>
  readonly envFilePath?: string
  readonly createStore?: (options: { readonly dbPath: string, readonly readOnly: boolean, readonly logger: Logger }) => ActivityStorePort
  readonly createFormatPort?: () => ActivityFormatPort
  readonly createStravaClient?: (options: {
    readonly clientId: string
    readonly clientSecret: string
    readonly refreshToken: string
    readonly logger: Logger
  }) => Pick<StravaClient, 'refreshAccessToken' | 'listActivities' | 'getActivity' | 'getActivityStreams'>
  readonly createGarminClient?: (options: {
    readonly secretString: string
    readonly isCn: boolean
    readonly logger: Logger
  }) => GarminClientLike
  readonly getGarminSecretFn?: typeof getGarminSecret
  readonly exportActivitiesJsonFn?: typeof exportActivitiesJson
  readonly exportParquetFn?: typeof exportParquet
  readonly validateDataConsistencyFn?: typeof validateDataConsistency
}

const DEFAULT_IO: CliIO = {
  stdout: chunk => process.stdout.write(chunk),
  stderr: chunk => process.stderr.write(chunk),
}

export function formatUsage(): string {
  return [
    'Usage: running-data-sync <command> [options]',
    '',
    'Commands:',
    '  sync db              Sync activities from Strava to DuckDB',
    '  vendor garmin        Sync DuckDB activities to Garmin (COM / CN)',
    '  vendor garmin-reconcile  Reconcile DuckDB activities with Garmin',
    '  vendor status        Show vendor sync status summary',
    '  vendor garmin-files  Upload local .fit/.gpx/.tcx files to Garmin',
    '  garmin sync          Download Garmin activities and ingest into DuckDB',
    '  garmin secret        Log in to Garmin and print a serialized secret string',
    '  export               Export FIT / TCX / GPX activity files from DuckDB',
    '  data json            Export activities.json from DuckDB',
    '  data parquet         Export Parquet tables from DuckDB',
    '  data validate        Validate 3-way consistency (DuckDB, JSON, Parquet)',
    '  svg                  Generate GitHub / Grid SVG posters',
    '',
    'Options:',
    '  -h, --help           Show help information',
    '  -v, --version        Show CLI version',
    '  --show-paths         Print resolved runtime paths',
    '',
  ].join('\n')
}

function formatSubcommandHelp(topic: string): string {
  switch (topic) {
    case 'sync':
      return [
        'Usage: running-data-sync sync db [options]',
        '',
        'Options:',
        '  --force                  Force full resync from Strava API',
        '  --prune                  Remove local activities missing from Strava',
        '  --only-run               Only sync running activities',
        '  --client-id <id>         Strava client ID',
        '  --client-secret <sec>    Strava client secret',
        '  --refresh-token <tok>    Strava refresh token',
        '  -h, --help               Show help',
        '',
      ].join('\n')
    case 'vendor':
      return [
        'Usage: running-data-sync vendor <garmin|garmin-reconcile|status|garmin-files> [options]',
        '',
        'Subcommands:',
        '  garmin            Sync DuckDB activities to Garmin/Garmin CN',
        '    --is-cn, --secret-string <sec>, --use-fake-garmin-device, --fix-hr, -f/--force',
        '    --match-window-sec <n>, --distance-tolerance-m <n>, --duration-tolerance-sec <n>',
        '  garmin-reconcile  Reconcile DuckDB activities with Garmin',
        '    --is-cn, --secret-string <sec>, --match-window-sec <n>, --distance-tolerance-m <n>, --duration-tolerance-sec <n>',
        '  status            Show vendor sync status summary',
        '    --vendor <name>, --account <account>, --is-cn, --retry-failed',
        '  garmin-files      Upload local .fit/.gpx/.tcx files to Garmin',
        '    --is-cn, --secret-string <sec>, --recursive <paths...>',
        '',
      ].join('\n')
    case 'garmin':
      return [
        'Usage: running-data-sync garmin <sync|secret> [options]',
        '',
        'Subcommands:',
        '  sync [secret]     Download Garmin activities into DuckDB',
        '    --is-cn, --only-run, --fit | --tcx | --gpx',
        '  secret [email] [password]',
        '    --is-cn         Use Garmin CN account',
        '',
      ].join('\n')
    case 'export':
      return [
        'Usage: running-data-sync export --format <fit|tcx|gpx> (--all | --id <id>... | --id-range <a:b>) [--output-dir <dir>]',
        '',
        'Options:',
        '  --format <fmt>      Export format: fit, tcx, or gpx (required)',
        '  --all               Export all activities',
        '  --id <id>           Activity ID to export (repeatable)',
        '  --id-range <a:b>    Activity ID range, e.g. 100:200',
        '  --output-dir <dir>  Output directory override',
        '  -h, --help          Show help',
        '',
      ].join('\n')
    case 'data':
      return [
        'Usage: running-data-sync data <json|parquet|validate> [options]',
        '',
        'Subcommands:',
        '  json [--output <path>]',
        '  parquet [--tables <t1> <t2>...] [--output-dir <dir>]',
        '  validate',
        '',
      ].join('\n')
    case 'svg':
      return [
        'Usage: running-data-sync svg --type <github|grid> --output <path> [options]',
        '',
        'Options:',
        '  --from-db                  Load tracks from DuckDB',
        '  --gpx-dir <dir>            Load tracks from local directory',
        '  --type <github|grid>       Poster type (default: grid)',
        '  --output <path>            Output SVG file path (default: poster.svg)',
        '  --year <all|YYYY|YYYY-YYYY>',
        '  --title <text>, --athlete <text>, --language <lang>',
        '  --background-color <hex>, --track-color <hex>, --text-color <hex>',
        '  --special-color <hex>, --special-color2 <hex>, --no-activity <hex>',
        '  --special-distance <km>, --special-distance2 <km>, --min-distance <km>',
        '  --only-run, --with-animation',
        '  -h, --help                 Show help',
        '',
      ].join('\n')
    default:
      return formatUsage()
  }
}

function parseIntegerOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`Invalid integer for ${name}: ${raw}`)
  }
  return parsed
}

function parseNumberOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(`Invalid number for ${name}: ${raw}`)
  }
  return parsed
}

function parseIdRange(raw: string | undefined): readonly [number, number] | undefined {
  if (!raw) {
    return undefined
  }
  const parts = raw.split(':')
  if (parts.length !== 2) {
    throw new ConfigurationError('--id-range must be in start:end format')
  }
  const start = Number(parts[0])
  const end = Number(parts[1])
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new ConfigurationError('--id-range bounds must be integers')
  }
  if (start > end) {
    throw new ConfigurationError('--id-range start must be <= end')
  }
  return [start, end]
}

async function withStore<T>(
  deps: CliDependencies,
  runtime: RuntimeConfig,
  readOnly: boolean,
  logger: Logger,
  fn: (store: ActivityStorePort) => Promise<T>,
): Promise<T> {
  const store = deps.createStore
    ? deps.createStore({ dbPath: runtime.sqlFile, readOnly, logger })
    : new DuckDBActivityStore({
      dbPath: runtime.sqlFile,
      readOnly,
      logger,
    })
  try {
    return await fn(store)
  }
  finally {
    if (!deps.createStore) {
      await store.close()
    }
  }
}

function createEnvOptions(deps: CliDependencies, runtime: RuntimeConfig) {
  return {
    projectRoot: runtime.projectRoot,
    envFilePath: deps.envFilePath,
    processEnv: deps.processEnv,
  }
}

async function handleSync(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    io.stdout(formatSubcommandHelp('sync'))
    return 0
  }

  const [target, ...rest] = args
  if (target !== 'db') {
    io.stderr(`Unknown sync subcommand: ${target}\n\n${formatSubcommandHelp('sync')}`)
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
    io.stdout(formatSubcommandHelp('sync'))
    return 0
  }

  const credentials = resolveStravaCredentials(
    {
      clientId: parsed.values['client-id'],
      clientSecret: parsed.values['client-secret'],
      refreshToken: parsed.values['refresh-token'],
    },
    createEnvOptions(deps, runtime),
  )

  const client = deps.createStravaClient
    ? deps.createStravaClient({ ...credentials, logger })
    : new DefaultStravaClient({ ...credentials, logger })

  const result: SyncStravaResult = await withStore(deps, runtime, false, logger, async (store) => {
    return syncStravaToStore({
      store,
      client,
      force: parsed.values.force,
      prune: parsed.values.prune,
      onlyRun: parsed.values['only-run'],
      logger,
    })
  })

  io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

async function handleVendor(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    io.stdout(formatSubcommandHelp('vendor'))
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
      io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.values['secret-string'],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(deps, runtime),
    )

    const client = deps.createGarminClient?.({ ...credentials, logger })
    const formatPort = deps.createFormatPort ? deps.createFormatPort() : createActivityFormatPort()

    const result: SyncStoreToGarminResult = await withStore(deps, runtime, false, logger, async (store) => {
      return syncStoreToGarmin({
        store,
        formatPort,
        client,
        credentials,
        useFakeGarminDevice: parsed.values['use-fake-garmin-device'],
        fixHr: parsed.values['fix-hr'],
        force: parsed.values.force,
        matchWindowSec: parseIntegerOption(parsed.values['match-window-sec'], '--match-window-sec'),
        distanceToleranceM: parseNumberOption(parsed.values['distance-tolerance-m'], '--distance-tolerance-m'),
        durationToleranceSec: parseIntegerOption(parsed.values['duration-tolerance-sec'], '--duration-tolerance-sec'),
        logger,
      })
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const credentials = resolveGarminCredentials(
      {
        garminSecret: parsed.values['secret-string'],
        isCn: parsed.values['is-cn'] ? true : undefined,
      },
      createEnvOptions(deps, runtime),
    )
    const client = deps.createGarminClient?.({ ...credentials, logger })

    const result: ReconcileGarminResult = await withStore(deps, runtime, false, logger, async (store) => {
      return reconcileGarmin({
        store,
        client,
        credentials,
        matchWindowSec: parseIntegerOption(parsed.values['match-window-sec'], '--match-window-sec'),
        distanceToleranceM: parseNumberOption(parsed.values['distance-tolerance-m'], '--distance-tolerance-m'),
        durationToleranceSec: parseIntegerOption(parsed.values['duration-tolerance-sec'], '--duration-tolerance-sec'),
        logger,
      })
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('vendor'))
      return 0
    }

    const result: VendorStatusSummary = await withStore(
      deps,
      runtime,
      !parsed.values['retry-failed'],
      logger,
      async (store) => {
        return getVendorStatus({
          store,
          vendor: parsed.values.vendor,
          account: parsed.values.account,
          isCn: parsed.values['is-cn'],
          retryFailed: parsed.values['retry-failed'],
          logger,
        })
      },
    )
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('vendor'))
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
      createEnvOptions(deps, runtime),
    )
    const client = deps.createGarminClient?.({ ...credentials, logger })

    const result: UploadFilesToGarminResult = await uploadFilesToGarmin({
      client,
      credentials,
      paths: parsed.positionals,
      recursive: parsed.values.recursive,
      logger,
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return result.failures.length > 0 ? 1 : 0
  }

  io.stderr(`Unknown vendor subcommand: ${target}\n\n${formatSubcommandHelp('vendor')}`)
  return 1
}

async function handleGarmin(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    io.stdout(formatSubcommandHelp('garmin'))
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
      io.stdout(formatSubcommandHelp('garmin'))
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
      createEnvOptions(deps, runtime),
    )
    const client = deps.createGarminClient?.({ ...credentials, logger })
    const formatPort = deps.createFormatPort ? deps.createFormatPort() : createActivityFormatPort()

    const result: SyncGarminToStoreResult = await withStore(deps, runtime, false, logger, async (store) => {
      return syncGarminToStore({
        store,
        formatPort,
        client,
        credentials,
        fileType,
        onlyRunning: parsed.values['only-run'],
        outputDirs: {
          fitDir: runtime.fitDir,
          tcxDir: runtime.tcxDir,
          gpxDir: runtime.gpxDir,
        },
        logger,
      })
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('garmin'))
      return 0
    }

    const env = loadEnvConfig(createEnvOptions(deps, runtime))
    const email = parsed.positionals[0] ?? env.garminEmail
    const password = parsed.positionals[1] ?? env.garminPassword
    const isCn = parsed.values['is-cn'] || env.garminIsCn?.toLowerCase() === 'true'
    if (!email || !password) {
      throw new ConfigurationError('Missing Garmin email or password. Provide positional args or set GARMIN_EMAIL/GARMIN_PASSWORD.')
    }

    const secretFn = deps.getGarminSecretFn ?? getGarminSecret
    const secret = await secretFn({ email, password, isCn })
    io.stdout(`${secret}\n`)
    return 0
  }

  io.stderr(`Unknown garmin subcommand: ${target}\n\n${formatSubcommandHelp('garmin')}`)
  return 1
}

async function handleExport(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
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
    io.stdout(formatSubcommandHelp('export'))
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

  const defaultDir = format === 'fit' ? runtime.fitDir : format === 'tcx' ? runtime.tcxDir : runtime.gpxDir
  const outputDir = parsed.values['output-dir'] ? path.resolve(parsed.values['output-dir']) : defaultDir
  const formatPort = deps.createFormatPort ? deps.createFormatPort() : createActivityFormatPort()

  const result: BatchExportResult = await withStore(deps, runtime, true, logger, async (store) => {
    return exportActivities({
      repository: store,
      formatPort,
      format,
      outputDir,
      all: parsed.values.all,
      ids: ids.length > 0 ? ids : undefined,
      idRange,
    })
  })

  io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  return result.failed.length > 0 ? 1 : 0
}

async function handleData(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    io.stdout(formatSubcommandHelp('data'))
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
      io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const fn = deps.exportActivitiesJsonFn ?? exportActivitiesJson
    const result: ExportActivitiesJsonResult = await fn({
      dbPath: runtime.sqlFile,
      outputPath: parsed.values.output ? path.resolve(parsed.values.output) : runtime.jsonFile,
      logger,
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const tableList = [
      ...(parsed.values.tables ?? []).flatMap(item => item.split(',').map(s => s.trim()).filter(Boolean)),
      ...parsed.positionals,
    ]
    const fn = deps.exportParquetFn ?? exportParquet
    const result: ExportParquetResult = await fn({
      dbPath: runtime.sqlFile,
      outputDir: parsed.values['output-dir'] ? path.resolve(parsed.values['output-dir']) : runtime.dbDir,
      tables: tableList.length > 0 ? tableList : undefined,
      logger,
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
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
      io.stdout(formatSubcommandHelp('data'))
      return 0
    }
    const fn = deps.validateDataConsistencyFn ?? validateDataConsistency
    const report: DataConsistencyReport = await fn({
      dbPath: runtime.sqlFile,
      jsonPath: runtime.jsonFile,
      parquetPath: path.join(runtime.dbDir, 'activities.parquet'),
      logger,
    })
    io.stdout(`${JSON.stringify(report, null, 2)}\n`)
    return report.ok ? 0 : 1
  }

  io.stderr(`Unknown data subcommand: ${target}\n\n${formatSubcommandHelp('data')}`)
  return 1
}

async function handleSvg(
  args: readonly string[],
  io: CliIO,
  deps: CliDependencies,
  runtime: RuntimeConfig,
  logger: Logger,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      'help': { type: 'boolean', short: 'h', default: false },
      'from-db': { type: 'boolean', default: false },
      'gpx-dir': { type: 'string' },
      'type': { type: 'string', default: 'grid' },
      'output': { type: 'string', default: 'poster.svg' },
      'year': { type: 'string', default: 'all' },
      'title': { type: 'string' },
      'athlete': { type: 'string' },
      'language': { type: 'string' },
      'background-color': { type: 'string' },
      'track-color': { type: 'string' },
      'text-color': { type: 'string' },
      'special-color': { type: 'string' },
      'special-color2': { type: 'string' },
      'no-activity': { type: 'string' },
      'special-distance': { type: 'string' },
      'special-distance2': { type: 'string' },
      'min-distance': { type: 'string' },
      'only-run': { type: 'boolean', default: false },
      'with-animation': { type: 'boolean', default: false },
    },
  })

  if (parsed.values.help) {
    io.stdout(formatSubcommandHelp('svg'))
    return 0
  }

  const posterType = parsed.values.type
  if (posterType !== 'github' && posterType !== 'grid') {
    throw new ConfigurationError(`Unsupported SVG poster type: ${posterType}. Expected "github" or "grid".`)
  }

  const theme = {
    ...(parsed.values['background-color'] ? { background: parsed.values['background-color'] } : {}),
    ...(parsed.values['track-color'] ? { track: parsed.values['track-color'] } : {}),
    ...(parsed.values['text-color'] ? { text: parsed.values['text-color'] } : {}),
    ...(parsed.values['special-color'] ? { special: parsed.values['special-color'] } : {}),
    ...(parsed.values['special-color2'] ? { special2: parsed.values['special-color2'] } : {}),
    ...(parsed.values['no-activity'] ? { noActivity: parsed.values['no-activity'] } : {}),
  }

  const specialDistanceKm = parseNumberOption(parsed.values['special-distance'], '--special-distance')
  const specialDistance2Km = parseNumberOption(parsed.values['special-distance2'], '--special-distance2')
  const minDistanceKm = parseNumberOption(parsed.values['min-distance'], '--min-distance')

  const posterOptions = {
    type: posterType as PosterType,
    year: parsed.values.year,
    title: parsed.values.title,
    athlete: parsed.values.athlete,
    language: parsed.values.language,
    minDistanceKm,
    withAnimation: parsed.values['with-animation'],
    theme: Object.keys(theme).length > 0 ? theme : undefined,
    specialDistance: specialDistanceKm !== undefined || specialDistance2Km !== undefined
      ? {
          specialDistance: specialDistanceKm ?? 10,
          specialDistance2: specialDistance2Km ?? 20,
        }
      : undefined,
  }

  let svg: string
  if (parsed.values['from-db'] || !parsed.values['gpx-dir']) {
    svg = await withStore(deps, runtime, true, logger, async (store) => {
      return renderPosterFromRepository(store, {
        ...posterOptions,
        onlyRun: parsed.values['only-run'] ? true : undefined,
      })
    })
  }
  else {
    const formatPort = deps.createFormatPort ? deps.createFormatPort() : createActivityFormatPort()
    svg = await renderPosterFromDirectory(
      path.resolve(parsed.values['gpx-dir']),
      formatPort,
      posterOptions,
    )
  }

  const outputPath = path.resolve(parsed.values.output ?? 'poster.svg')
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, svg, 'utf8')
  io.stdout(`Generated ${posterType} SVG at ${outputPath}\n`)
  return 0
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

    switch (first) {
      case 'sync':
        return await handleSync(rest, io, deps, runtime, logger)
      case 'vendor':
        return await handleVendor(rest, io, deps, runtime, logger)
      case 'garmin':
        return await handleGarmin(rest, io, deps, runtime, logger)
      case 'export':
        return await handleExport(rest, io, deps, runtime, logger)
      case 'data':
        return await handleData(rest, io, deps, runtime, logger)
      case 'svg':
        return await handleSvg(rest, io, deps, runtime, logger)
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
