import type { BatchExportResult, ObjectStorePort } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import {
  ConfigurationError,
  exportActivitiesFromDb,
  parseEnvFile,
  PreconditionFailedError,
  R2ObjectStore,
} from '@running-data-sync/core'
import { parseIdRange, parseIntegerOption, resolveStoreBackedOptions } from './context.js'
import { formatSubcommandHelp } from './help.js'

const WORKOUT_CONTENT_TYPES: Readonly<Record<'fit' | 'gpx' | 'tcx', string>> = {
  fit: 'application/vnd.ant.fit',
  gpx: 'application/gpx+xml',
  tcx: 'application/vnd.garmin.tcx+xml',
}

export interface UploadedPrivateArtifact {
  readonly activityId: number
  readonly format: 'fit' | 'gpx' | 'tcx'
  readonly key: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly etag?: string
  readonly deduplicated: boolean
}

export interface FailedPrivateArtifactUpload {
  readonly activityId: number
  readonly filePath: string
  readonly error: string
}

export interface PrivateArtifactUploadSummary {
  readonly uploaded: readonly UploadedPrivateArtifact[]
  readonly failed: readonly FailedPrivateArtifactUpload[]
}

export interface ExportCommandResult extends BatchExportResult {
  readonly privateUploads?: PrivateArtifactUploadSummary
}

export interface ExportPrivateUploadHooks {
  /**
   * Optional object-store factory override (for tests or integration wiring).
   * When omitted, `--upload-private` resolves `R2ObjectStore.fromEnv(...)`.
   */
  readonly createObjectStore?: () => ObjectStorePort
}

async function resolveObjectStoreForUpload(
  ctx: CliCommandContext,
  hooks?: ExportPrivateUploadHooks,
): Promise<ObjectStorePort> {
  if (hooks?.createObjectStore) {
    return hooks.createObjectStore()
  }
  const depsWithObjectStore = ctx.deps as CliCommandContext['deps'] & {
    readonly createObjectStore?: () => ObjectStorePort
  }
  if (depsWithObjectStore.createObjectStore) {
    return depsWithObjectStore.createObjectStore()
  }
  const envFilePath = ctx.deps.envFilePath ?? path.join(ctx.runtime.projectRoot, '.env.local')
  const fileValues = existsSync(envFilePath)
    ? parseEnvFile(readFileSync(envFilePath, 'utf8'))
    : {}
  const mergedEnv: Record<string, string | undefined> = {
    ...fileValues,
    ...(ctx.deps.processEnv ?? process.env),
  }
  return R2ObjectStore.fromEnv(mergedEnv)
}

async function uploadExportedArtifactsToPrivateStore(
  result: BatchExportResult,
  objectStore: ObjectStorePort,
): Promise<PrivateArtifactUploadSummary> {
  const uploaded: UploadedPrivateArtifact[] = []
  const failed: FailedPrivateArtifactUpload[] = []

  for (const item of result.exported) {
    try {
      const body = new Uint8Array(await readFile(item.filePath))
      const sha256 = createHash('sha256').update(body).digest('hex')
      const key = `artifacts/${item.activityId}/${sha256}.${item.format}`
      const contentType = WORKOUT_CONTENT_TYPES[item.format]

      let deduplicated = false
      let etag: string | undefined

      try {
        const putResult = await objectStore.put(key, body, {
          ifNoneMatch: '*',
          contentType,
        })
        etag = putResult.etag
      }
      catch (error) {
        if (error instanceof PreconditionFailedError) {
          deduplicated = true
          const head = await objectStore.head(key)
          etag = head?.etag
        }
        else {
          throw error
        }
      }

      uploaded.push({
        activityId: item.activityId,
        format: item.format,
        key,
        sha256,
        sizeBytes: body.byteLength,
        ...(etag !== undefined ? { etag } : {}),
        deduplicated,
      })
    }
    catch (error) {
      failed.push({
        activityId: item.activityId,
        filePath: item.filePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { uploaded, failed }
}

export async function handleExport(
  args: readonly string[],
  ctx: CliCommandContext,
  hooks?: ExportPrivateUploadHooks,
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
      'upload-private': { type: 'boolean', default: false },
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

  const objectStore = parsed.values['upload-private']
    ? await resolveObjectStoreForUpload(ctx, hooks)
    : undefined

  const result: BatchExportResult = await exportActivitiesFromDb({
    ...resolveStoreBackedOptions(ctx, true),
    formatPort: ctx.deps.createFormatPort?.(),
    format,
    outputDir: parsed.values['output-dir'] ? path.resolve(parsed.values['output-dir']) : undefined,
    all: parsed.values.all,
    ids: ids.length > 0 ? ids : undefined,
    idRange,
  })

  if (objectStore) {
    const privateUploads = await uploadExportedArtifactsToPrivateStore(result, objectStore)
    const output: ExportCommandResult = {
      ...result,
      privateUploads,
    }
    ctx.io.stdout(`${JSON.stringify(output, null, 2)}\n`)
    return result.failed.length > 0 || privateUploads.failed.length > 0 ? 1 : 0
  }

  ctx.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  return result.failed.length > 0 ? 1 : 0
}
