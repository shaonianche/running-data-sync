import type {
  ObjectStoreGetResult,
  ObjectStoreHeadResult,
  ObjectStoreListItem,
  ObjectStorePort,
  ObjectStorePutOptions,
  ObjectStorePutResult,
} from '../contracts/object-store.js'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { PreconditionFailedError } from '../contracts/object-store.js'
import { ConfigurationError, StorageError } from '../foundation/errors.js'
import { redactSensitiveMessage } from '../foundation/logger.js'

/**
 * Minimal S3 client interface required by {@link R2ObjectStore}.
 *
 * Accepts an AWS SDK v3 `S3Client` or a lightweight mock in unit tests.
 */
export interface S3LikeClient {
  send: (command: any) => Promise<any>
}

export interface R2ObjectStoreConfig {
  /** Cloudflare account ID used to build `https://<accountId>.r2.cloudflarestorage.com`. */
  readonly accountId?: string
  /** Explicit S3-compatible endpoint override (defaults to Cloudflare R2 S3 endpoint). */
  readonly endpoint?: string
  readonly bucket: string
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  /** Optional pre-configured S3 client (useful for testing or custom middleware). */
  readonly client?: S3LikeClient
}

interface S3ServiceErrorLike {
  readonly name?: string
  readonly Code?: string
  readonly code?: string
  readonly message?: string
  readonly $metadata?: {
    readonly httpStatusCode?: number
  }
}

interface GetObjectResponseLike {
  readonly Body?: {
    readonly transformToByteArray?: () => Promise<Uint8Array>
  } | Uint8Array | AsyncIterable<Uint8Array>
  readonly ETag?: string
  readonly ContentType?: string
}

interface HeadObjectResponseLike {
  readonly ETag?: string
  readonly ContentLength?: number
  readonly ContentType?: string
}

interface PutObjectResponseLike {
  readonly ETag?: string
}

interface ListObjectsV2ResponseLike {
  readonly Contents?: ReadonlyArray<{
    readonly Key?: string
    readonly ETag?: string
    readonly Size?: number
    readonly LastModified?: Date
  }>
  readonly IsTruncated?: boolean
  readonly NextContinuationToken?: string
}

export function buildR2Endpoint(accountId: string): string {
  const trimmed = accountId.trim()
  if (!trimmed) {
    throw new ConfigurationError('R2 accountId must be a non-empty string.')
  }
  return `https://${trimmed}.r2.cloudflarestorage.com`
}

function normalizeEtagHeader(etag: string): string {
  const trimmed = etag.trim()
  if (!trimmed) {
    throw new ConfigurationError('Conditional ifMatch ETag must be a non-empty string.')
  }
  if (trimmed === '*' || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed
  }
  return `"${trimmed}"`
}

function getHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  return (error as S3ServiceErrorLike).$metadata?.httpStatusCode
}

function getS3ErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const err = error as S3ServiceErrorLike
  return err.Code ?? err.code ?? err.name
}

function isNotFoundError(error: unknown): boolean {
  const status = getHttpStatusCode(error)
  if (status === 404) {
    return true
  }
  const code = getS3ErrorCode(error)
  return code === 'NoSuchKey' || code === 'NotFound' || code === '404'
}

function isPreconditionFailedError(error: unknown): boolean {
  const status = getHttpStatusCode(error)
  if (status === 412) {
    return true
  }
  const code = getS3ErrorCode(error)
  return code === 'PreconditionFailed'
}

function sanitizeR2ErrorMessage(
  operation: string,
  target: string,
  error: unknown,
  secrets: ReadonlyArray<string | undefined>,
): string {
  const status = getHttpStatusCode(error)
  const code = getS3ErrorCode(error)
  const rawMessage = error instanceof Error ? error.message : String(error)
  let sanitized = redactSensitiveMessage(rawMessage)
  // Scrub any query-string signatures or presigned URL tokens.
  sanitized = sanitized.replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s'"]+/gi, '$1***')
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join('***')
    }
  }
  const detailParts: string[] = []
  if (code) {
    detailParts.push(code)
  }
  if (status !== undefined) {
    detailParts.push(`HTTP ${status}`)
  }
  const meta = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : ''
  return `R2 ${operation} failed for "${target}"${meta}: ${sanitized}`
}

async function readBodyBytes(body: GetObjectResponseLike['Body']): Promise<Uint8Array> {
  if (body === undefined) {
    return new Uint8Array(0)
  }
  if (body instanceof Uint8Array) {
    return new Uint8Array(body)
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
    return new Uint8Array(bytes)
  }
  if (Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = []
    let totalLength = 0
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const normalized = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      chunks.push(normalized)
      totalLength += normalized.byteLength
    }
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }
  throw new StorageError('Unsupported R2 GetObject response body stream.')
}

/**
 * S3-compatible Cloudflare R2 implementation of {@link ObjectStorePort}.
 *
 * Uses R2's atomic `If-Match` / `If-None-Match` conditional write headers on
 * `PutObject` and does not rely on S3 Bucket Versioning or public `r2.dev` URLs.
 */
export class R2ObjectStore implements ObjectStorePort {
  private readonly client: S3LikeClient
  private readonly bucket: string
  private readonly secrets: ReadonlyArray<string | undefined>

  constructor(config: R2ObjectStoreConfig) {
    const bucket = config.bucket.trim()
    if (!bucket) {
      throw new ConfigurationError('R2 bucket must be a non-empty string.')
    }
    this.bucket = bucket
    this.secrets = [config.accessKeyId, config.secretAccessKey]

    if (config.client) {
      this.client = config.client
      return
    }

    const endpoint = config.endpoint?.trim() || (config.accountId ? buildR2Endpoint(config.accountId) : '')
    if (!endpoint) {
      throw new ConfigurationError('R2ObjectStore requires either accountId or endpoint.')
    }
    const accessKeyId = config.accessKeyId?.trim()
    const secretAccessKey = config.secretAccessKey?.trim()
    if (!accessKeyId || !secretAccessKey) {
      throw new ConfigurationError('R2ObjectStore requires accessKeyId and secretAccessKey.')
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  /**
   * Creates an {@link R2ObjectStore} from environment variables:
   * `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
   */
  static fromEnv(env: Readonly<Record<string, string | undefined>>): R2ObjectStore {
    const accountId = env.R2_ACCOUNT_ID?.trim()
    const bucket = env.R2_BUCKET?.trim()
    const accessKeyId = env.R2_ACCESS_KEY_ID?.trim()
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim()

    const missing: string[] = []
    if (!accountId)
      missing.push('R2_ACCOUNT_ID')
    if (!bucket)
      missing.push('R2_BUCKET')
    if (!accessKeyId)
      missing.push('R2_ACCESS_KEY_ID')
    if (!secretAccessKey)
      missing.push('R2_SECRET_ACCESS_KEY')

    if (missing.length > 0) {
      throw new ConfigurationError(`Missing required R2 environment variables: ${missing.join(', ')}`)
    }

    return new R2ObjectStore({
      accountId: accountId!,
      bucket: bucket!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
    })
  }

  async get(key: string): Promise<ObjectStoreGetResult | null> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )) as GetObjectResponseLike

      const body = await readBodyBytes(response.Body)
      return {
        body,
        etag: response.ETag ?? '',
        ...(response.ContentType !== undefined ? { contentType: response.ContentType } : {}),
      }
    }
    catch (error) {
      if (isNotFoundError(error)) {
        return null
      }
      throw new StorageError(sanitizeR2ErrorMessage('get', key, error, this.secrets))
    }
  }

  async head(key: string): Promise<ObjectStoreHeadResult | null> {
    try {
      const response = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )) as HeadObjectResponseLike

      return {
        etag: response.ETag ?? '',
        sizeBytes: response.ContentLength ?? 0,
        ...(response.ContentType !== undefined ? { contentType: response.ContentType } : {}),
      }
    }
    catch (error) {
      if (isNotFoundError(error)) {
        return null
      }
      throw new StorageError(sanitizeR2ErrorMessage('head', key, error, this.secrets))
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    options?: ObjectStorePutOptions,
  ): Promise<ObjectStorePutResult> {
    if (options?.ifMatch !== undefined && options?.ifNoneMatch !== undefined) {
      throw new ConfigurationError('Cannot specify both ifMatch and ifNoneMatch on put().')
    }

    try {
      const response = (await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(options?.contentType !== undefined ? { ContentType: options.contentType } : {}),
          ...(options?.ifMatch !== undefined ? { IfMatch: normalizeEtagHeader(options.ifMatch) } : {}),
          ...(options?.ifNoneMatch !== undefined ? { IfNoneMatch: options.ifNoneMatch } : {}),
        }),
      )) as PutObjectResponseLike

      return {
        etag: response.ETag ?? '',
      }
    }
    catch (error) {
      if (isPreconditionFailedError(error)) {
        throw new PreconditionFailedError(
          key,
          `Precondition failed when writing object "${key}" to R2.`,
        )
      }
      throw new StorageError(sanitizeR2ErrorMessage('put', key, error, this.secrets))
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )
    }
    catch (error) {
      if (isNotFoundError(error)) {
        return
      }
      throw new StorageError(sanitizeR2ErrorMessage('delete', key, error, this.secrets))
    }
  }

  async list(prefix: string): Promise<ObjectStoreListItem[]> {
    const items: ObjectStoreListItem[] = []
    let continuationToken: string | undefined

    try {
      do {
        const response = (await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
          }),
        )) as ListObjectsV2ResponseLike

        for (const entry of response.Contents ?? []) {
          if (entry.Key === undefined) {
            continue
          }
          items.push({
            key: entry.Key,
            etag: entry.ETag ?? '',
            sizeBytes: entry.Size ?? 0,
            ...(entry.LastModified !== undefined ? { lastModified: entry.LastModified } : {}),
          })
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken !== undefined)

      return items
    }
    catch (error) {
      throw new StorageError(sanitizeR2ErrorMessage('list', prefix, error, this.secrets))
    }
  }
}
