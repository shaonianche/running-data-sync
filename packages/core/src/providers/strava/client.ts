import type { Logger } from '../../foundation/logger.js'
import type {
  FetchLike,
  GetStravaStreamsOptions,
  ListStravaActivitiesOptions,
  SleepFn,
  StravaClientOptions,
  StravaDetailedActivity,
  StravaRateLimitInfo,
  StravaStream,
  StravaStreamsMap,
  StravaStreamType,
  StravaSummaryActivity,
  StravaTokenResponse,
  StravaUploadFileOptions,
  StravaUploadOptions,
  StravaUploadResponse,
} from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AuthenticationError, RateLimitError, SyncError } from '../../foundation/errors.js'
import { createLogger, REDACTED_VALUE, redactSensitiveMessage } from '../../foundation/logger.js'
import { DEFAULT_FLYBY_STREAM_TYPES } from './types.js'

export const DEFAULT_STRAVA_API_BASE_URL = 'https://www.strava.com/api/v3'
export const DEFAULT_STRAVA_OAUTH_TOKEN_URL = 'https://www.strava.com/oauth/token'
export const DEFAULT_STRAVA_PER_PAGE = 200
export const DEFAULT_STRAVA_TIMEOUT_MS = 30_000
export const DEFAULT_STRAVA_MAX_RATE_LIMIT_RETRIES = 2
export const DEFAULT_STRAVA_BASE_BACKOFF_MS = 1_000
export const DEFAULT_STRAVA_MAX_BACKOFF_MS = 60_000

const BEARER_TOKEN_REGEX = /\bBearer\s+[^\s,'"&;\]}]+/gi

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactSecretValues(text: string, secrets: readonly (string | undefined)[]): string {
  let result = redactSensitiveMessage(text).replace(BEARER_TOKEN_REGEX, `Bearer ${REDACTED_VALUE}`)

  const uniqueSecrets = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length > 0))]
    .sort((a, b) => b.length - a.length)

  for (const secret of uniqueSecrets) {
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED_VALUE)
  }
  return result
}

function parseRateLimitPair(headerValue: string | null): [number | null, number | null] {
  if (!headerValue) {
    return [null, null]
  }
  const parts = headerValue.split(',').map(part => part.trim())
  if (parts.length < 2) {
    const single = Number.parseInt(parts[0] ?? '', 10)
    return [Number.isFinite(single) ? single : null, null]
  }
  const shortTerm = Number.parseInt(parts[0], 10)
  const daily = Number.parseInt(parts[1], 10)
  return [
    Number.isFinite(shortTerm) ? shortTerm : null,
    Number.isFinite(daily) ? daily : null,
  ]
}

export function parseRetryAfterSeconds(headerValue: string | null, now: Date = new Date()): number | null {
  if (!headerValue) {
    return null
  }
  const trimmed = headerValue.trim()
  if (!trimmed) {
    return null
  }

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric
  }

  const targetMs = Date.parse(trimmed)
  if (!Number.isNaN(targetMs)) {
    const diffSeconds = Math.ceil((targetMs - now.getTime()) / 1000)
    return Math.max(0, diffSeconds)
  }

  return null
}

export function parseRateLimitHeaders(headers: Headers, now: Date = new Date()): StravaRateLimitInfo | null {
  const limitHeader = headers.get('x-ratelimit-limit') ?? headers.get('x-readratelimit-limit')
  const usageHeader = headers.get('x-ratelimit-usage') ?? headers.get('x-readratelimit-usage')
  const retryAfterHeader = headers.get('retry-after')

  if (!limitHeader && !usageHeader && !retryAfterHeader) {
    return null
  }

  const [shortTermLimit, dailyLimit] = parseRateLimitPair(limitHeader)
  const [shortTermUsage, dailyUsage] = parseRateLimitPair(usageHeader)
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader, now)

  return {
    shortTermLimit,
    dailyLimit,
    shortTermUsage,
    dailyUsage,
    retryAfterSeconds,
  }
}

export function toUnixEpochSeconds(value: number | Date | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SyncError(`Invalid timestamp number: ${value}`)
    }
    return Math.floor(value)
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms)) {
      throw new SyncError('Invalid Date timestamp')
    }
    return Math.floor(ms / 1000)
  }
  const trimmed = value.trim()
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  const parsedMs = Date.parse(hasTimezone ? normalized : `${normalized}Z`)
  if (Number.isNaN(parsedMs)) {
    throw new SyncError(`Invalid timestamp string: ${value}`)
  }
  return Math.floor(parsedMs / 1000)
}

function normalizeStreamsPayload(payload: unknown): StravaStreamsMap {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  if (Array.isArray(payload)) {
    const map: Record<string, StravaStream<unknown>> = {}
    for (const item of payload) {
      if (item && typeof item === 'object' && 'type' in item && 'data' in item) {
        const stream = item as StravaStream<unknown> & { type: StravaStreamType }
        if (typeof stream.type === 'string' && Array.isArray(stream.data)) {
          map[stream.type] = stream
        }
      }
    }
    return map as StravaStreamsMap
  }

  const map: Record<string, StravaStream<unknown>> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value && typeof value === 'object' && 'data' in value && Array.isArray((value as StravaStream<unknown>).data)) {
      map[key] = value as StravaStream<unknown>
    }
  }
  return map as StravaStreamsMap
}

/**
 * Lightweight Strava v3 REST API client using Node.js native fetch.
 * Handles OAuth2 token refresh, paginated activity queries, streams,
 * activity uploads, rate-limit header parsing, backoff retries, and secret redaction.
 */
export class StravaClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private currentRefreshToken: string
  private currentAccessToken: string | null
  private accessTokenExpiresAt: number | null = null
  private readonly apiBaseUrl: string
  private readonly oauthTokenUrl: string
  private readonly fetchImpl: FetchLike
  private readonly sleepFn: SleepFn
  private readonly now: () => Date
  private readonly logger: Logger
  private readonly maxRateLimitRetries: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly timeoutMs: number
  private latestRateLimit: StravaRateLimitInfo | null = null

  constructor(options: StravaClientOptions) {
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.currentRefreshToken = options.refreshToken
    this.currentAccessToken = options.accessToken ?? null
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_STRAVA_API_BASE_URL).replace(/\/+$/, '')
    this.oauthTokenUrl = options.oauthTokenUrl ?? DEFAULT_STRAVA_OAUTH_TOKEN_URL
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.sleepFn = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? createLogger('strava.client')
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? DEFAULT_STRAVA_MAX_RATE_LIMIT_RETRIES)
    this.baseBackoffMs = Math.max(0, options.baseBackoffMs ?? DEFAULT_STRAVA_BASE_BACKOFF_MS)
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? DEFAULT_STRAVA_MAX_BACKOFF_MS)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_STRAVA_TIMEOUT_MS)
  }

  get accessToken(): string | null {
    return this.currentAccessToken
  }

  get refreshToken(): string {
    return this.currentRefreshToken
  }

  get expiresAt(): number | null {
    return this.accessTokenExpiresAt
  }

  get lastRateLimit(): StravaRateLimitInfo | null {
    return this.latestRateLimit
  }

  redactSecrets(text: string): string {
    return redactSecretValues(text, [
      this.clientSecret,
      this.currentRefreshToken,
      this.currentAccessToken ?? undefined,
    ])
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      })
    }
    catch (error) {
      const detail = this.redactSecrets(error instanceof Error ? error.message : String(error))
      throw new SyncError(`Strava HTTP request failed: ${detail}`, { cause: error })
    }
    finally {
      clearTimeout(timer)
    }
  }

  private async readRedactedBody(response: Response): Promise<string> {
    try {
      const text = await response.text()
      return this.redactSecrets(text).slice(0, 500)
    }
    catch {
      return ''
    }
  }

  private buildRateLimitError(response: Response, rateLimit: StravaRateLimitInfo | null, bodyText: string): RateLimitError {
    const usageSummary = rateLimit
      ? ` (usage=${rateLimit.shortTermUsage ?? '?'}/${rateLimit.shortTermLimit ?? '?'} 15m, ${rateLimit.dailyUsage ?? '?'}/${rateLimit.dailyLimit ?? '?'} daily)`
      : ''
    const suffix = bodyText ? `: ${bodyText}` : ''
    const message = this.redactSecrets(
      `Strava API rate limit exceeded (HTTP ${response.status})${usageSummary}${suffix}`,
    )
    return new RateLimitError(message, rateLimit?.retryAfterSeconds ?? null)
  }

  private computeBackoffMs(rateLimit: StravaRateLimitInfo | null, attempt: number): number {
    if (rateLimit?.retryAfterSeconds !== null && rateLimit?.retryAfterSeconds !== undefined) {
      return Math.max(0, rateLimit.retryAfterSeconds * 1000)
    }
    const exponential = this.baseBackoffMs * (2 ** attempt)
    return Math.min(exponential, this.maxBackoffMs)
  }

  /**
   * Refresh Strava OAuth2 access token using client_id, client_secret, and refresh_token.
   */
  async refreshAccessToken(): Promise<StravaTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.currentRefreshToken,
      grant_type: 'refresh_token',
    })

    const response = await this.fetchWithTimeout(this.oauthTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    })

    const rateLimit = parseRateLimitHeaders(response.headers, this.now())
    if (rateLimit) {
      this.latestRateLimit = rateLimit
    }

    if (response.status === 429) {
      const text = await this.readRedactedBody(response)
      throw this.buildRateLimitError(response, rateLimit, text)
    }

    if (!response.ok) {
      const text = await this.readRedactedBody(response)
      const message = this.redactSecrets(
        `Failed to refresh Strava access token (HTTP ${response.status})${text ? `: ${text}` : ''}`,
      )
      this.logger.error(message, { status: response.status })
      throw new AuthenticationError(message)
    }

    const payload = await response.json() as Partial<StravaTokenResponse>
    if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new AuthenticationError('Strava OAuth token response did not contain a valid access_token')
    }

    this.currentAccessToken = payload.access_token
    if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0) {
      this.currentRefreshToken = payload.refresh_token
    }
    if (typeof payload.expires_at === 'number' && Number.isFinite(payload.expires_at)) {
      this.accessTokenExpiresAt = payload.expires_at
    }

    this.logger.info('Strava access token refreshed successfully', {
      expiresAt: this.accessTokenExpiresAt,
    })

    return {
      token_type: payload.token_type,
      access_token: payload.access_token,
      expires_at: payload.expires_at,
      expires_in: payload.expires_in,
      refresh_token: payload.refresh_token ?? this.currentRefreshToken,
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.currentAccessToken) {
      await this.refreshAccessToken()
    }
    return this.currentAccessToken!
  }

  private async requestApi(
    endpointPath: string,
    init: RequestInit,
    options: { readonly maxRetries?: number, readonly allowNotFound?: boolean } = {},
  ): Promise<Response> {
    const token = await this.ensureAccessToken()
    const maxRetries = Math.max(0, options.maxRetries ?? this.maxRateLimitRetries)
    const url = endpointPath.startsWith('http://') || endpointPath.startsWith('https://')
      ? endpointPath
      : `${this.apiBaseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${token}`)
      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json')
      }

      const response = await this.fetchWithTimeout(url, {
        ...init,
        headers,
      })

      const rateLimit = parseRateLimitHeaders(response.headers, this.now())
      if (rateLimit) {
        this.latestRateLimit = rateLimit
      }

      if (response.status === 429) {
        const bodyText = await this.readRedactedBody(response)
        const rateLimitError = this.buildRateLimitError(response, rateLimit, bodyText)
        if (attempt < maxRetries) {
          const waitMs = this.computeBackoffMs(rateLimit, attempt)
          this.logger.warn(this.redactSecrets(
            `Strava API rate limited on ${endpointPath}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          ), {
            endpoint: endpointPath,
            waitMs,
            attempt: attempt + 1,
            maxRetries,
            shortTermUsage: rateLimit?.shortTermUsage ?? null,
            shortTermLimit: rateLimit?.shortTermLimit ?? null,
          })
          await this.sleepFn(waitMs)
          continue
        }
        throw rateLimitError
      }

      if (response.status === 401) {
        const bodyText = await this.readRedactedBody(response)
        const message = this.redactSecrets(
          `Strava API authentication failed (HTTP 401) on ${endpointPath}${bodyText ? `: ${bodyText}` : ''}`,
        )
        throw new AuthenticationError(message)
      }

      if (response.status === 404 && options.allowNotFound) {
        return response
      }

      if (!response.ok) {
        const bodyText = await this.readRedactedBody(response)
        const message = this.redactSecrets(
          `Strava API request failed (HTTP ${response.status}) on ${endpointPath}${bodyText ? `: ${bodyText}` : ''}`,
        )
        throw new SyncError(message)
      }

      return response
    }

    throw new RateLimitError(`Strava API rate limit exceeded on ${endpointPath}`)
  }

  /**
   * Fetch athlete activities with automatic pagination across all pages.
   */
  async listActivities(options: ListStravaActivitiesOptions = {}): Promise<StravaSummaryActivity[]> {
    const perPage = Math.max(1, Math.min(200, Math.floor(options.perPage ?? DEFAULT_STRAVA_PER_PAGE)))
    const limit = options.limit !== undefined ? Math.max(0, Math.floor(options.limit)) : undefined
    if (limit === 0) {
      return []
    }

    const afterSeconds = options.after !== undefined ? toUnixEpochSeconds(options.after) : undefined
    const beforeSeconds = options.before !== undefined ? toUnixEpochSeconds(options.before) : undefined

    const collected: StravaSummaryActivity[] = []
    let page = Math.max(1, Math.floor(options.startPage ?? 1))

    while (true) {
      const remaining = limit !== undefined ? limit - collected.length : undefined
      const pageSize = remaining !== undefined ? Math.min(perPage, remaining) : perPage
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(pageSize),
      })
      if (afterSeconds !== undefined) {
        params.set('after', String(afterSeconds))
      }
      if (beforeSeconds !== undefined) {
        params.set('before', String(beforeSeconds))
      }

      const response = await this.requestApi(`/athlete/activities?${params.toString()}`, {
        method: 'GET',
      }, {
        maxRetries: options.maxRetries,
      })

      const batch = await response.json() as unknown
      if (!Array.isArray(batch)) {
        throw new SyncError('Strava /athlete/activities returned a non-array response')
      }

      const typedBatch = batch as StravaSummaryActivity[]
      collected.push(...typedBatch)

      if (typedBatch.length === 0 || typedBatch.length < pageSize) {
        break
      }
      if (limit !== undefined && collected.length >= limit) {
        break
      }
      page += 1
    }

    return limit !== undefined ? collected.slice(0, limit) : collected
  }

  /**
   * Fetch detailed metadata for a single activity by ID.
   */
  async getActivity(
    activityId: number,
    options: { readonly maxRetries?: number } = {},
  ): Promise<StravaDetailedActivity> {
    const response = await this.requestApi(`/activities/${activityId}`, {
      method: 'GET',
    }, {
      maxRetries: options.maxRetries,
    })
    return await response.json() as StravaDetailedActivity
  }

  /**
   * Fetch telemetry streams for a single activity.
   * Returns an empty map if Strava responds with HTTP 404 (e.g., manual activities with no streams).
   */
  async getActivityStreams(
    activityId: number,
    options: GetStravaStreamsOptions = {},
  ): Promise<StravaStreamsMap> {
    const keys = options.keys && options.keys.length > 0
      ? options.keys
      : DEFAULT_FLYBY_STREAM_TYPES
    const params = new URLSearchParams({
      keys: keys.join(','),
      key_by_type: 'true',
    })
    if (options.resolution) {
      params.set('resolution', options.resolution)
    }

    const response = await this.requestApi(`/activities/${activityId}/streams?${params.toString()}`, {
      method: 'GET',
    }, {
      maxRetries: options.maxRetries,
      allowNotFound: true,
    })

    if (response.status === 404) {
      return {}
    }

    const payload = await response.json() as unknown
    return normalizeStreamsPayload(payload)
  }

  /**
   * Upload an activity file payload (FIT/TCX/GPX) to Strava v3 /uploads endpoint.
   * Mirrors `upload_file_to_strava` with automatic HTTP 429 retry support.
   */
  async uploadActivity(options: StravaUploadOptions): Promise<StravaUploadResponse> {
    const formData = new FormData()
    const bytes = typeof options.content === 'string'
      ? new TextEncoder().encode(options.content)
      : new Uint8Array(options.content)
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    formData.append('file', blob, options.filename)
    formData.append('data_type', options.dataType)

    const activityType = options.activityType ?? (options.forceToRun !== false ? 'run' : undefined)
    if (activityType) {
      formData.append('activity_type', activityType)
    }
    if (options.name) {
      formData.append('name', options.name)
    }
    if (options.description) {
      formData.append('description', options.description)
    }
    if (options.externalId) {
      formData.append('external_id', options.externalId)
    }

    const response = await this.requestApi('/uploads', {
      method: 'POST',
      body: formData,
    }, {
      maxRetries: options.maxRetries ?? Math.max(1, this.maxRateLimitRetries),
    })

    const result = await response.json() as StravaUploadResponse
    this.logger.info('Uploaded activity file to Strava', {
      filename: options.filename,
      dataType: options.dataType,
      uploadId: result.id,
      status: result.status,
    })
    return result
  }

  /**
   * Read an activity file from disk and upload it to Strava.
   */
  async uploadActivityFile(options: StravaUploadFileOptions): Promise<StravaUploadResponse> {
    const buffer = await fs.readFile(options.filePath)
    return this.uploadActivity({
      content: buffer,
      filename: path.basename(options.filePath),
      dataType: options.dataType,
      forceToRun: options.forceToRun,
      activityType: options.activityType,
      name: options.name,
      description: options.description,
      externalId: options.externalId,
      maxRetries: options.maxRetries,
    })
  }
}

export async function uploadFileToStrava(
  client: Pick<StravaClient, 'uploadActivityFile'>,
  filePath: string,
  dataType: StravaUploadOptions['dataType'],
  forceToRun = true,
): Promise<StravaUploadResponse> {
  return client.uploadActivityFile({
    filePath,
    dataType,
    forceToRun,
  })
}
