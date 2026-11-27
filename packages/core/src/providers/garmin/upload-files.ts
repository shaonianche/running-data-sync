import type {
  GarminClientFactoryOptions,
  GarminClientLike,
  UploadFileFailure,
  UploadFilesToGarminOptions,
  UploadFilesToGarminResult,
} from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigurationError, SyncError } from '../../foundation/index.js'
import { GarminClient } from './client.js'
import { redactGarminMessage, wrapGarminLogger } from './redaction.js'
import { SUPPORTED_GARMIN_UPLOAD_EXTS } from './types.js'

export function resolveGarminClient(options: GarminClientFactoryOptions): GarminClientLike {
  if (options.client) {
    return options.client
  }
  if (!options.credentials) {
    throw new ConfigurationError('Either a GarminClient instance or GarminCredentials must be provided.')
  }
  return new GarminClient({
    secretString: options.credentials.secretString,
    isCn: options.credentials.isCn,
    fetch: options.fetch,
    oauthConsumer: options.oauthConsumer,
    oauthConsumerUrl: options.oauthConsumerUrl,
    now: options.now,
    logger: options.logger,
  })
}

function isSupportedActivityFile(filePath: string): boolean {
  return SUPPORTED_GARMIN_UPLOAD_EXTS.has(path.extname(filePath).toLowerCase())
}

async function walkDirectory(dirPath: string, recursive: boolean, collected: Set<string>): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (recursive) {
        await walkDirectory(fullPath, true, collected)
      }
      continue
    }
    if (entry.isFile() && isSupportedActivityFile(fullPath)) {
      collected.add(path.resolve(fullPath))
    }
  }
}

/**
 * Scan input file/directory paths for `.fit`, `.gpx`, and `.tcx` files (optionally recursively).
 */
export async function collectActivityFiles(
  paths: readonly string[],
  options: { readonly recursive?: boolean } = {},
): Promise<string[]> {
  const recursive = options.recursive ?? false
  const uniqueFiles = new Set<string>()

  for (const rawPath of paths) {
    let stats
    try {
      stats = await fs.stat(rawPath)
    }
    catch (err) {
      throw new ConfigurationError(`Path does not exist: ${rawPath}`, { cause: err })
    }

    if (stats.isFile()) {
      if (isSupportedActivityFile(rawPath)) {
        uniqueFiles.add(path.resolve(rawPath))
      }
      continue
    }

    if (stats.isDirectory()) {
      await walkDirectory(rawPath, recursive, uniqueFiles)
    }
  }

  const sorted = Array.from(uniqueFiles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (sorted.length === 0) {
    throw new ConfigurationError('No uploadable files found. Supported extensions: .fit, .gpx, .tcx')
  }
  return sorted
}

/**
 * Collect and upload local `.fit`, `.gpx`, and `.tcx` files to Garmin Connect.
 */
export async function uploadFilesToGarmin(
  options: UploadFilesToGarminOptions,
): Promise<UploadFilesToGarminResult> {
  const files = await collectActivityFiles(options.paths, { recursive: options.recursive })
  const client = resolveGarminClient(options)
  const secretValues = options.credentials ? [options.credentials.secretString] : []
  const logger = wrapGarminLogger(options.logger, 'garmin.uploadFiles', () => secretValues)

  const uploaded: string[] = []
  const duplicates: string[] = []
  const failures: UploadFileFailure[] = []

  logger.info(`Uploading ${files.length} activity file(s) to ${client.account}.`)

  for (const filePath of files) {
    try {
      const content = new Uint8Array(await fs.readFile(filePath))
      const result = await client.uploadActivity(path.basename(filePath), content)
      if (result.duplicate) {
        duplicates.push(filePath)
        logger.info(`Skipped duplicate upload for ${filePath}.`)
      }
      else {
        uploaded.push(filePath)
        logger.info(`Uploaded ${filePath}.`)
      }
    }
    catch (err) {
      const message = redactGarminMessage(
        err instanceof Error ? err.message : String(err),
        secretValues,
      )
      failures.push({ filePath, error: message })
      logger.error(`Failed uploading ${filePath}: ${message}`)
    }
  }

  const summary: UploadFilesToGarminResult = {
    account: client.account,
    totalFiles: files.length,
    uploaded,
    duplicates,
    failures,
  }

  if (failures.length > 0 && (options.throwOnError ?? true)) {
    const preview = failures.slice(0, 5).map(item => item.filePath).join(', ')
    throw new SyncError(`Failed to upload ${failures.length} file(s): ${preview}`)
  }

  return summary
}
