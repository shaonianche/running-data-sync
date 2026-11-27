import type { ActivityFileFormat } from '../../contracts/index.js'
import type { Logger } from '../../foundation/index.js'
import type {
  GarminAccount,
  GarminActivityRecord,
  GarminActivitySummary,
  GarminClientLike,
  GarminClientOptions,
  GarminDomain,
  GarminFetchFn,
  GarminOAuth1Token,
  GarminOAuth2Token,
  GarminOAuthConsumer,
  GarminUploadResult,
  GarminUrls,
} from './types.js'
import path from 'node:path'
import { SyncError } from '../../foundation/index.js'
import {
  deserializeGarminSecret,
  exchangeOAuth1ForOAuth2,
  formatOAuth2AuthorizationHeader,
  getGarminUrls,
  isOAuth2TokenExpired,
  resolveGarminAccount,
  resolveGarminDomain,
  serializeGarminSecret,
} from './auth.js'
import { extractRemoteActivityIdFromUploadResult } from './matching.js'
import { redactGarminMessage, redactHeaders, wrapGarminLogger } from './redaction.js'
import {
  DEFAULT_GARMIN_PAGE_SIZE,
  GarminAuthenticationError,
  GarminConnectionError,
  GarminHttpError,
  GarminRateLimitError,
} from './types.js'

const GARMIN_API_USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36'

function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (!raw) {
    return null
  }
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric
  }
  const dateMs = Date.parse(raw)
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000))
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inspectImportFailures(detailedImportResult: Record<string, unknown>): {
  readonly duplicate: boolean
  readonly failureMessages: string[]
  readonly hasSuccesses: boolean
} {
  const successes = Array.isArray(detailedImportResult.successes) ? detailedImportResult.successes : []
  const failures = Array.isArray(detailedImportResult.failures) ? detailedImportResult.failures : []

  let duplicate = false
  const failureMessages: string[] = []

  for (const failure of failures) {
    if (!isRecord(failure)) {
      continue
    }
    const messages = Array.isArray(failure.messages) ? failure.messages : []
    for (const msg of messages) {
      if (!isRecord(msg)) {
        continue
      }
      const code = msg.code
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (code === 202 || /duplicate\s+activity/i.test(content)) {
        duplicate = true
      }
      if (content) {
        failureMessages.push(content)
      }
      else if (code !== undefined) {
        failureMessages.push(`Garmin import failure code ${String(code)}`)
      }
    }
  }

  return {
    duplicate,
    failureMessages,
    hasSuccesses: successes.length > 0,
  }
}

/**
 * Garmin Connect REST API client supporting both International (`garmin.com`)
 * and China (`garmin.cn`) domains with automatic OAuth1 -> OAuth2 token refresh.
 */
export class GarminClient implements GarminClientLike {
  readonly domain: GarminDomain
  readonly account: GarminAccount
  readonly urls: GarminUrls
  readonly onlyRunning: boolean

  private readonly fetchFn: GarminFetchFn
  private readonly oauthConsumer?: GarminOAuthConsumer
  private readonly oauthConsumerUrl?: string
  private readonly now: () => number
  private readonly logger: Logger
  private readonly onTokenRefreshed?: (secretString: string, oauth2Token: GarminOAuth2Token) => void

  private readonly oauth1Token: GarminOAuth1Token
  private oauth2Token: GarminOAuth2Token
  private initialSecretString: string
  private pendingRefresh: Promise<GarminOAuth2Token> | null = null

  constructor(options: GarminClientOptions) {
    const requestedDomain = options.domain !== undefined
      ? resolveGarminDomain(options.domain)
      : options.isCn !== undefined
        ? resolveGarminDomain(options.isCn)
        : undefined

    const bundle = deserializeGarminSecret(options.secretString, requestedDomain)
    this.domain = requestedDomain ?? bundle.domain
    this.account = resolveGarminAccount(this.domain)
    this.urls = getGarminUrls(this.domain)
    this.onlyRunning = options.onlyRunning ?? false

    this.fetchFn = options.fetch ?? globalThis.fetch
    this.oauthConsumer = options.oauthConsumer
    this.oauthConsumerUrl = options.oauthConsumerUrl
    this.now = options.now ?? Date.now
    this.onTokenRefreshed = options.onTokenRefreshed

    this.oauth1Token = {
      ...bundle.oauth1Token,
      domain: this.domain,
    }
    this.oauth2Token = bundle.oauth2Token
    this.initialSecretString = options.secretString

    this.logger = wrapGarminLogger(options.logger, 'garmin.client', () => this.collectSensitiveValues())
  }

  private collectSensitiveValues(): string[] {
    const values = [
      this.initialSecretString,
      this.oauth1Token.oauth_token,
      this.oauth1Token.oauth_token_secret,
      this.oauth2Token.access_token,
      this.oauth2Token.refresh_token,
    ]
    if (this.oauth1Token.mfa_token) {
      values.push(this.oauth1Token.mfa_token)
    }
    if (this.oauthConsumer?.consumer_secret) {
      values.push(this.oauthConsumer.consumer_secret)
    }
    return values
  }

  getSecretString(): string {
    return serializeGarminSecret(this.oauth1Token, this.oauth2Token)
  }

  getCurrentOAuth2Token(): GarminOAuth2Token {
    return { ...this.oauth2Token }
  }

  async refreshOAuth2Token(): Promise<GarminOAuth2Token> {
    if (this.pendingRefresh) {
      return this.pendingRefresh
    }

    const refreshTask = (async () => {
      this.logger.info(`Refreshing Garmin OAuth2 token for ${this.domain}.`)
      const refreshed = await exchangeOAuth1ForOAuth2({
        oauth1Token: this.oauth1Token,
        domain: this.domain,
        isLogin: false,
        fetch: this.fetchFn,
        oauthConsumer: this.oauthConsumer,
        oauthConsumerUrl: this.oauthConsumerUrl,
        now: this.now,
      })
      this.oauth2Token = refreshed
      const serialized = this.getSecretString()
      this.initialSecretString = serialized
      this.onTokenRefreshed?.(serialized, refreshed)
      return refreshed
    })()

    this.pendingRefresh = refreshTask
    try {
      return await refreshTask
    }
    finally {
      if (this.pendingRefresh === refreshTask) {
        this.pendingRefresh = null
      }
    }
  }

  private async ensureValidToken(): Promise<void> {
    if (isOAuth2TokenExpired(this.oauth2Token, this.now())) {
      await this.refreshOAuth2Token()
    }
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'User-Agent': GARMIN_API_USER_AGENT,
      'origin': this.urls.ssoOrigin,
      'nk': 'NT',
      'Authorization': formatOAuth2AuthorizationHeader(this.oauth2Token),
      ...extraHeaders,
    }
  }

  private async sendWithAuthRetry(
    url: string,
    buildInit: () => RequestInit,
    allowStatusCodes: ReadonlySet<number> = new Set(),
  ): Promise<Response> {
    await this.ensureValidToken()

    const execute = async (): Promise<Response> => {
      try {
        const init = buildInit()
        const extraHeaders = isRecord(init.headers) ? (init.headers as Record<string, string>) : undefined
        return await this.fetchFn(url, {
          ...init,
          headers: this.buildHeaders(extraHeaders),
        })
      }
      catch (err) {
        const msg = err instanceof Error ? redactGarminMessage(err.message, this.collectSensitiveValues()) : String(err)
        throw new GarminConnectionError(`Error connecting to Garmin (${this.domain}): ${msg}`, { cause: err })
      }
    }

    let response = await execute()

    if (response.status === 401) {
      this.logger.warn(`Garmin API returned HTTP 401 for ${this.domain}; refreshing OAuth2 token and retrying once.`)
      await this.refreshOAuth2Token()
      response = await execute()
    }

    if (response.status === 429) {
      const retryAfter = parseRetryAfterSeconds(response.headers)
      throw new GarminRateLimitError(`Garmin API rate limit exceeded (${this.domain}).`, retryAfter)
    }

    if (response.status === 401) {
      throw new GarminAuthenticationError(`Garmin API authentication failed after token refresh (${this.domain}).`)
    }

    if (!response.ok && !allowStatusCodes.has(response.status)) {
      const rawBody = await response.text().catch(() => '')
      const safeBody = redactGarminMessage(rawBody.slice(0, 200), this.collectSensitiveValues())
      throw new GarminHttpError(
        `Garmin API request failed with HTTP ${response.status} (${this.domain})${safeBody ? `: ${safeBody}` : ''}`,
        response.status,
      )
    }

    return response
  }

  async getActivities(
    start = 0,
    limit = DEFAULT_GARMIN_PAGE_SIZE,
    onlyRunning: boolean = this.onlyRunning,
  ): Promise<GarminActivityRecord[]> {
    const params = new URLSearchParams({
      start: String(start),
      limit: String(limit),
    })
    if (onlyRunning) {
      params.set('activityType', 'running')
    }
    const url = `${this.urls.modernBase}/activitylist-service/activities/search/activities?${params.toString()}`
    const response = await this.sendWithAuthRetry(url, () => ({ method: 'GET' }))
    const data = await response.json() as unknown
    if (!Array.isArray(data)) {
      throw new GarminHttpError(`Unexpected Garmin activities response payload for ${this.domain}.`, response.status)
    }
    return data as GarminActivityRecord[]
  }

  async fetchAllActivities(options: {
    readonly pageSize?: number
    readonly maxPages?: number | null
    readonly onlyRunning?: boolean
  } = {}): Promise<GarminActivityRecord[]> {
    const pageSize = options.pageSize ?? DEFAULT_GARMIN_PAGE_SIZE
    const maxPages = options.maxPages ?? null
    const onlyRunning = options.onlyRunning ?? this.onlyRunning

    const allActivities: GarminActivityRecord[] = []
    let page = 0

    while (true) {
      if (maxPages !== null && page >= maxPages) {
        break
      }
      const batch = await this.getActivities(page * pageSize, pageSize, onlyRunning)
      if (batch.length === 0) {
        break
      }
      allActivities.push(...batch)
      if (batch.length < pageSize) {
        break
      }
      page += 1
    }

    return allActivities
  }

  async getActivitySummary(activityId: number | string): Promise<GarminActivitySummary> {
    const url = `${this.urls.modernBase}/activity-service/activity/${encodeURIComponent(String(activityId))}`
    const response = await this.sendWithAuthRetry(url, () => ({ method: 'GET' }))
    const data = await response.json() as unknown
    if (!isRecord(data)) {
      throw new GarminHttpError(`Unexpected Garmin summary payload for activity ${activityId}.`, response.status)
    }
    return data as GarminActivitySummary
  }

  async deleteActivity(activityId: number | string): Promise<void> {
    const url = `${this.urls.modernBase}/activity-service/activity/${encodeURIComponent(String(activityId))}`
    await this.sendWithAuthRetry(url, () => ({ method: 'DELETE' }))
  }

  async downloadActivity(activityId: number | string, format: ActivityFileFormat = 'gpx'): Promise<Uint8Array> {
    const encodedId = encodeURIComponent(String(activityId))
    const url = format === 'fit'
      ? `${this.urls.modernBase}/download-service/files/activity/${encodedId}`
      : `${this.urls.modernBase}/download-service/export/${encodeURIComponent(format)}/activity/${encodedId}`

    this.logger.info(`Downloading Garmin activity ${activityId} (${format}) from ${this.domain}.`)
    const response = await this.sendWithAuthRetry(url, () => ({ method: 'GET' }))
    return new Uint8Array(await response.arrayBuffer())
  }

  async uploadActivity(filename: string, buffer: Uint8Array): Promise<GarminUploadResult> {
    const baseName = path.basename(filename)
    const uploadBytes = new Uint8Array(buffer)

    const response = await this.sendWithAuthRetry(
      this.urls.uploadUrl,
      () => {
        const formData = new FormData()
        formData.append('file', new Blob([uploadBytes]), baseName)
        return {
          method: 'POST',
          body: formData,
        }
      },
      new Set([409]),
    )

    this.logger.info(`Upload response for ${baseName}: HTTP ${response.status}.`)
    this.logger.debug(`Upload response headers for ${baseName}.`, {
      headers: redactHeaders(response.headers),
    })

    if (response.status === 204) {
      return {
        status: 204,
        detailedImportResult: null,
        remoteActivityId: null,
        duplicate: false,
      }
    }

    const rawText = await response.text()
    const bodyPreview = rawText.length > 500 ? `${rawText.slice(0, 500)}...` : rawText
    this.logger.debug(`Upload response body for ${baseName}: ${bodyPreview}`)

    if (response.status === 409) {
      let detailedImportResult: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(rawText) as unknown
        if (isRecord(parsed) && isRecord(parsed.detailedImportResult)) {
          detailedImportResult = parsed.detailedImportResult
        }
        else if (isRecord(parsed)) {
          detailedImportResult = parsed
        }
      }
      catch {
        // Non-JSON 409 body; check plain text for Duplicate Activity below.
      }

      const inspection = detailedImportResult
        ? inspectImportFailures(detailedImportResult)
        : { duplicate: /duplicate\s+activity/i.test(rawText), failureMessages: [], hasSuccesses: false }

      if (inspection.duplicate || /duplicate/i.test(rawText)) {
        const remoteActivityId = detailedImportResult
          ? extractRemoteActivityIdFromUploadResult(detailedImportResult)
          : null
        return {
          status: 409,
          detailedImportResult,
          remoteActivityId,
          duplicate: true,
        }
      }

      throw new GarminHttpError(
        `Garmin upload conflict for ${baseName} (HTTP 409): ${redactGarminMessage(rawText.slice(0, 200), this.collectSensitiveValues())}`,
        409,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    }
    catch (err) {
      throw new GarminHttpError(
        `Failed to parse Garmin upload JSON response for ${baseName} (HTTP ${response.status}).`,
        response.status,
        { cause: err },
      )
    }

    if (!isRecord(parsed) || !isRecord(parsed.detailedImportResult)) {
      throw new GarminHttpError(
        `Missing detailedImportResult in Garmin upload response for ${baseName} (HTTP ${response.status}).`,
        response.status,
      )
    }

    const detailedImportResult = parsed.detailedImportResult
    const inspection = inspectImportFailures(detailedImportResult)
    const remoteActivityId = extractRemoteActivityIdFromUploadResult(detailedImportResult)

    if (inspection.duplicate && !inspection.hasSuccesses) {
      return {
        status: response.status,
        detailedImportResult,
        remoteActivityId,
        duplicate: true,
      }
    }

    if (inspection.failureMessages.length > 0 && !inspection.hasSuccesses) {
      throw new SyncError(
        `Garmin rejected upload for ${baseName}: ${redactGarminMessage(inspection.failureMessages.join('; '), this.collectSensitiveValues())}`,
      )
    }

    return {
      status: response.status,
      detailedImportResult,
      remoteActivityId,
      duplicate: false,
    }
  }
}
