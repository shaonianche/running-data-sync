import type { ActivityFileFormat, ActivityFormatPort, ActivityStorePort, PosterOptions, SvgPosterGenerator } from './contracts/index.js'
import type { BatchExportResult, ExportActivitiesOptions } from './formats/exporter.js'
import type { CredentialInput, RuntimeConfig, StravaCredentials } from './foundation/types.js'
import type {
  GarminClientFactoryOptions,
  ReconcileGarminOptions,
  ReconcileGarminResult,
  SyncGarminToStoreOptions,
  SyncGarminToStoreResult,
  SyncStoreToGarminOptions,
  SyncStoreToGarminResult,
  UploadFilesToGarminOptions,
  UploadFilesToGarminResult,
  VendorStatusOptions,
  VendorStatusSummary,
} from './providers/garmin/types.js'
import type { SyncStravaOptions, SyncStravaResult } from './providers/strava/types.js'
import type { DuckDBActivityStoreOptions } from './storage/duckdb-store.js'
import type { LoadPosterTracksFromRepositoryOptions, RenderPosterFromRepositoryOptions } from './svg/adapters.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportActivities as exportActivitiesFromRepository } from './formats/exporter.js'
import { createActivityFormatPort } from './formats/format-port.js'
import { resolveRuntimeConfig, resolveStravaCredentials } from './foundation/config.js'
import { syncGarminToStore } from './providers/garmin/download.js'
import { getVendorStatus } from './providers/garmin/status.js'
import { reconcileGarmin as reconcileGarminWithStore, syncStoreToGarmin } from './providers/garmin/sync.js'
import { uploadFilesToGarmin } from './providers/garmin/upload-files.js'
import { StravaClient } from './providers/strava/client.js'
import { syncStravaToStore } from './providers/strava/sync.js'
import { DuckDBActivityStore } from './storage/duckdb-store.js'
import { renderPosterFromDirectory, renderPosterFromRepository } from './svg/adapters.js'

export interface StoreBackedOptions {
  readonly store?: ActivityStorePort
  readonly storeOptions?: DuckDBActivityStoreOptions
  readonly runtimeConfig?: Partial<RuntimeConfig>
}

async function withManagedStore<T>(
  options: StoreBackedOptions,
  readOnly: boolean,
  fn: (store: ActivityStorePort, runtime: RuntimeConfig) => Promise<T>,
): Promise<T> {
  const runtime = resolveRuntimeConfig(options.runtimeConfig)
  if (options.store) {
    return fn(options.store, runtime)
  }

  const store = new DuckDBActivityStore({
    dbPath: runtime.sqlFile,
    readOnly,
    ...options.storeOptions,
  })
  try {
    return await fn(store, runtime)
  }
  finally {
    await store.close()
  }
}

export interface SyncStravaToDbOptions
  extends StoreBackedOptions,
  Omit<SyncStravaOptions, 'store' | 'client'> {
  readonly client?: SyncStravaOptions['client']
  readonly credentials?: StravaCredentials
  readonly credentialInput?: CredentialInput
}

export async function syncStravaToDb(options: SyncStravaToDbOptions = {}): Promise<SyncStravaResult> {
  const client = options.client ?? new StravaClient({
    ...(options.credentials ?? resolveStravaCredentials(options.credentialInput)),
    logger: options.logger,
  })

  return withManagedStore(options, false, async (store) => {
    return syncStravaToStore({
      ...options,
      store,
      client,
    })
  })
}

export interface SyncDbToGarminOptions
  extends StoreBackedOptions,
  Omit<SyncStoreToGarminOptions, 'store' | 'formatPort'> {
  readonly formatPort?: ActivityFormatPort
}

export async function syncDbToGarmin(options: SyncDbToGarminOptions = {}): Promise<SyncStoreToGarminResult> {
  const formatPort = options.formatPort ?? createActivityFormatPort()
  return withManagedStore(options, false, async (store) => {
    return syncStoreToGarmin({
      ...options,
      store,
      formatPort,
    })
  })
}

export interface ReconcileGarminDbOptions
  extends StoreBackedOptions,
  Omit<ReconcileGarminOptions, 'store'> {}

export async function reconcileGarminDb(options: ReconcileGarminDbOptions = {}): Promise<ReconcileGarminResult> {
  return withManagedStore(options, false, async (store) => {
    return reconcileGarminWithStore({
      ...options,
      store,
    })
  })
}

export interface SyncGarminToDbOptions
  extends StoreBackedOptions,
  Omit<SyncGarminToStoreOptions, 'store' | 'formatPort'> {
  readonly formatPort?: ActivityFormatPort
}

export async function syncGarminToDb(options: SyncGarminToDbOptions = {}): Promise<SyncGarminToStoreResult> {
  const formatPort = options.formatPort ?? createActivityFormatPort()
  return withManagedStore(options, false, async (store, runtime) => {
    return syncGarminToStore({
      ...options,
      store,
      formatPort,
      outputDirs: {
        fitDir: runtime.fitDir,
        tcxDir: runtime.tcxDir,
        gpxDir: runtime.gpxDir,
        ...options.outputDirs,
      },
    })
  })
}

export interface ExportActivitiesFromDbOptions
  extends StoreBackedOptions,
  Omit<ExportActivitiesOptions, 'repository' | 'outputDir'> {
  readonly outputDir?: string
}

function resolveDefaultExportDir(runtime: RuntimeConfig, format: ActivityFileFormat): string {
  switch (format) {
    case 'fit':
      return runtime.fitDir
    case 'tcx':
      return runtime.tcxDir
    case 'gpx':
      return runtime.gpxDir
  }
}

export async function exportActivitiesFromDb(
  options: ExportActivitiesFromDbOptions,
): Promise<BatchExportResult> {
  return withManagedStore(options, true, async (store, runtime) => {
    return exportActivitiesFromRepository({
      ...options,
      repository: store,
      formatPort: options.formatPort ?? createActivityFormatPort(),
      outputDir: options.outputDir ?? resolveDefaultExportDir(runtime, options.format),
    })
  })
}

export interface GetVendorStatusFromDbOptions
  extends StoreBackedOptions,
  Omit<VendorStatusOptions, 'store'> {}

export async function getVendorStatusFromDb(
  options: GetVendorStatusFromDbOptions = {},
): Promise<VendorStatusSummary> {
  return withManagedStore(options, !options.retryFailed, async (store) => {
    return getVendorStatus({
      ...options,
      store,
    })
  })
}

export async function uploadLocalFilesToGarmin(
  options: UploadFilesToGarminOptions,
): Promise<UploadFilesToGarminResult> {
  return uploadFilesToGarmin(options)
}

export interface GeneratePosterSvgOptions
  extends StoreBackedOptions,
  Omit<RenderPosterFromRepositoryOptions, 'type'>,
  Pick<PosterOptions, 'type'>,
  Pick<LoadPosterTracksFromRepositoryOptions, 'onlyRun' | 'types' | 'hasPolyline' | 'specialRunIds'> {
  readonly gpxDir?: string
  readonly formatPort?: ActivityFormatPort
  readonly withAnimation?: boolean
  readonly outputPath?: string
  readonly generator?: SvgPosterGenerator
}

export interface GeneratePosterSvgResult {
  readonly svg: string
  readonly outputPath?: string
}

export async function generatePosterSvg(options: GeneratePosterSvgOptions): Promise<GeneratePosterSvgResult> {
  let svg: string
  if (options.gpxDir) {
    const formatPort = options.formatPort ?? createActivityFormatPort()
    svg = await renderPosterFromDirectory(
      path.resolve(options.gpxDir),
      formatPort,
      options,
      options.generator,
    )
  }
  else {
    svg = await withManagedStore(options, true, async (store) => {
      return renderPosterFromRepository(store, options, options.generator)
    })
  }

  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath)
    await mkdir(path.dirname(resolvedOutput), { recursive: true })
    await writeFile(resolvedOutput, svg, 'utf8')
    return { svg, outputPath: resolvedOutput }
  }

  return { svg }
}

export type { GarminClientFactoryOptions }
