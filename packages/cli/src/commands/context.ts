import type {
  ActivityFormatPort,
  ActivityStorePort,
  exportActivitiesJson,
  exportParquet,
  GarminClientLike,
  getGarminSecret,
  Logger,
  ObjectStorePort,
  RuntimeConfig,
  StravaClient,
  validateDataConsistency,
} from '@running-data-sync/core'
import { ConfigurationError } from '@running-data-sync/core'

export interface CliIO {
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
}

export interface CliDependencies {
  readonly runtimeConfig?: Partial<RuntimeConfig>
  readonly processEnv?: Readonly<Record<string, string | undefined>>
  readonly envFilePath?: string
  readonly createStore?: (options: { readonly dbPath: string, readonly readOnly: boolean, readonly logger: Logger }) => ActivityStorePort
  readonly createObjectStore?: () => ObjectStorePort
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

export interface CliCommandContext {
  readonly io: CliIO
  readonly deps: CliDependencies
  readonly runtime: RuntimeConfig
  readonly logger: Logger
}

export function createEnvOptions(deps: CliDependencies, runtime: RuntimeConfig) {
  return {
    projectRoot: runtime.projectRoot,
    envFilePath: deps.envFilePath,
    processEnv: deps.processEnv,
  }
}

export function resolveStoreBackedOptions(ctx: CliCommandContext, readOnly: boolean) {
  if (ctx.deps.createStore) {
    return {
      store: ctx.deps.createStore({
        dbPath: ctx.runtime.sqlFile,
        readOnly,
        logger: ctx.logger,
      }),
      runtimeConfig: ctx.runtime,
    }
  }
  return {
    storeOptions: { logger: ctx.logger },
    runtimeConfig: ctx.runtime,
  }
}

export function parseIntegerOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || String(value) !== raw.trim()) {
    throw new ConfigurationError(`Invalid integer for ${name}: ${raw}`)
  }
  return value
}

export function parseNumberOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) {
    throw new ConfigurationError(`Invalid number for ${name}: ${raw}`)
  }
  return value
}

export function parseIdRange(raw: string | undefined): readonly [number, number] | undefined {
  if (!raw) {
    return undefined
  }
  const parts = raw.split(':')
  if (parts.length !== 2) {
    throw new ConfigurationError(`Invalid --id-range format: ${raw}. Expected START:END`)
  }
  const start = parseIntegerOption(parts[0], '--id-range start')
  const end = parseIntegerOption(parts[1], '--id-range end')
  if (start === undefined || end === undefined) {
    throw new ConfigurationError(`Invalid --id-range format: ${raw}. Expected START:END`)
  }
  if (start > end) {
    throw new ConfigurationError(`Invalid --id-range: ${raw}. --id-range start must be <= end`)
  }
  return [start, end]
}
