import type {
  ActivityFileFormat,
  ActivityFormatPort,
  FitBuildOptions,
} from '../contracts/formats.js'
import type { ActivityReadRepository } from '../contracts/storage.js'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigurationError } from '../foundation/errors.js'
import { GarminActivityFormatPort } from './format-port.js'

const SUPPORTED_EXPORT_FORMATS: ReadonlySet<string> = new Set<ActivityFileFormat>(['fit', 'tcx', 'gpx'])

export interface ExportActivitiesOptions {
  readonly repository: ActivityReadRepository
  readonly formatPort?: ActivityFormatPort
  readonly format: ActivityFileFormat
  readonly outputDir: string
  readonly all?: boolean
  readonly ids?: readonly number[]
  readonly idRange?: readonly [number, number]
  readonly fitOptions?: FitBuildOptions
}

export interface ExportedActivityFile {
  readonly activityId: number
  readonly format: ActivityFileFormat
  readonly filePath: string
  readonly bytesWritten: number
}

export interface ExportActivityFailure {
  readonly activityId: number
  readonly error: string
}

export interface BatchExportResult {
  readonly format: ActivityFileFormat
  readonly outputDir: string
  readonly requestedIds: readonly number[]
  readonly exported: readonly ExportedActivityFile[]
  readonly failed: readonly ExportActivityFailure[]
}

async function resolveTargetActivityIds(
  repository: ActivityReadRepository,
  options: Pick<ExportActivitiesOptions, 'all' | 'ids' | 'idRange'>,
): Promise<number[]> {
  if (options.all) {
    const existing = await repository.getExistingActivityIds()
    return [...existing].sort((a, b) => a - b)
  }

  const targetIds = new Set<number>()
  if (options.ids) {
    for (const id of options.ids) {
      if (Number.isInteger(id)) {
        targetIds.add(id)
      }
    }
  }

  if (options.idRange) {
    const [startId, endId] = options.idRange
    if (!Number.isInteger(startId) || !Number.isInteger(endId) || startId > endId) {
      throw new ConfigurationError(`Invalid idRange: [${startId}, ${endId}]. Start must be <= end.`)
    }
    const existing = await repository.getExistingActivityIds()
    for (const id of existing) {
      if (id >= startId && id <= endId) {
        targetIds.add(id)
      }
    }
  }

  return [...targetIds].sort((a, b) => a - b)
}

/**
 * Batch-export activities from any `ActivityReadRepository` into `.fit`, `.tcx`, or `.gpx` files
 * using an injected `ActivityFormatPort` (defaults to `GarminActivityFormatPort`).
 *
 * Matches the CLI selection semantics (`all`, `ids`, `idRange`, `outputDir`) without coupling
 * to DuckDB or any specific storage implementation.
 */
export async function exportActivities(options: ExportActivitiesOptions): Promise<BatchExportResult> {
  const format = options.format.toLowerCase() as ActivityFileFormat
  if (!SUPPORTED_EXPORT_FORMATS.has(format)) {
    throw new ConfigurationError(`Unsupported export format: "${options.format}". Expected one of fit, tcx, gpx.`)
  }

  const hasIds = Boolean(options.ids && options.ids.length > 0)
  if (!options.all && !hasIds && !options.idRange) {
    throw new ConfigurationError('Export target is empty. Specify all, ids, or idRange.')
  }

  if (!options.outputDir || !options.outputDir.trim()) {
    throw new ConfigurationError('Export outputDir must be a non-empty path.')
  }

  const formatPort = options.formatPort ?? new GarminActivityFormatPort()
  const requestedIds = await resolveTargetActivityIds(options.repository, options)

  if (requestedIds.length === 0) {
    return {
      format,
      outputDir: options.outputDir,
      requestedIds: [],
      exported: [],
      failed: [],
    }
  }

  await mkdir(options.outputDir, { recursive: true })

  const exported: ExportedActivityFile[] = []
  const failed: ExportActivityFailure[] = []

  for (const activityId of requestedIds) {
    try {
      const activity = await options.repository.getActivityById(activityId)
      if (!activity) {
        throw new Error(`Activity ${activityId} not found`)
      }
      const flybyPoints = await options.repository.getFlybyPoints(activityId)
      const filePath = join(options.outputDir, `${activityId}.${format}`)

      let bytesWritten: number
      if (format === 'fit') {
        const fitBytes = formatPort.buildFit(activity, flybyPoints, options.fitOptions)
        await writeFile(filePath, fitBytes)
        bytesWritten = fitBytes.byteLength
      }
      else if (format === 'tcx') {
        const tcxText = formatPort.buildTcx(activity, flybyPoints)
        await writeFile(filePath, tcxText, 'utf8')
        bytesWritten = Buffer.byteLength(tcxText, 'utf8')
      }
      else {
        const gpxText = formatPort.buildGpx(activity, flybyPoints)
        await writeFile(filePath, gpxText, 'utf8')
        bytesWritten = Buffer.byteLength(gpxText, 'utf8')
      }

      exported.push({
        activityId,
        format,
        filePath,
        bytesWritten,
      })
    }
    catch (err) {
      failed.push({
        activityId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    format,
    outputDir: options.outputDir,
    requestedIds,
    exported,
    failed,
  }
}
