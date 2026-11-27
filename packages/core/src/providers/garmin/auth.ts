import type {
  GarminAccount,
  GarminDomain,
  GarminFetchFn,
  GarminLoginResult,
  GarminOAuth1Token,
  GarminOAuth2Token,
  GarminOAuthConsumer,
  GarminSecretBundle,
  GarminUrls,
  GetGarminSecretOptions,
} from './types.js'
import { Buffer } from 'node:buffer'
import { ConfigurationError, loadEnvConfig } from '../../foundation/index.js'
import { createOAuth1AuthorizationHeader } from './oauth1.js'
import { redactGarminMessage, wrapGarminLogger } from './redaction.js'
import { GarminAuthenticationError, GarminMfaRequiredError } from './types.js'

// Garmin Connect SSO / OAuth1-to-OAuth2 protocol details, serialized token format
// compatibility (`garth.client.dumps()`), and the default public OAuth consumer config
// endpoint reference Python `garth` (https://github.com/matin/garth, MIT License).
// Activity data itself is fetched directly from official Garmin Connect endpoints.
export const GARMIN_SSO_CLIENT_ID = 'GCM_ANDROID_DARK'
export const GARMIN_OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
export const GARMIN_OAUTH_USER_AGENT = 'com.garmin.android.apps.connectmobile'
export const GARMIN_SSO_USER_AGENT
  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

const SSO_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': GARMIN_SSO_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
}

const consumerCache = new Map<string, GarminOAuthConsumer>()

export function resolveGarminDomain(input?: boolean | string | null): GarminDomain {
  if (input === true) {
    return 'garmin.cn'
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase()
    if (normalized === 'cn' || normalized === 'garmin.cn' || normalized.endsWith('.garmin.cn')) {
      return 'garmin.cn'
    }
  }
  return 'garmin.com'
}

export function resolveGarminAccount(isCnOrDomain: boolean | GarminDomain): GarminAccount {
  const domain = resolveGarminDomain(isCnOrDomain)
  return domain === 'garmin.cn' ? 'garmin_cn' : 'garmin_com'
}

export function getGarminUrls(isCnOrDomain: boolean | GarminDomain = 'garmin.com'): GarminUrls {
  const domain = resolveGarminDomain(isCnOrDomain)
  const ssoOrigin = `https://sso.${domain}`
  const modernBase = `https://connectapi.${domain}`
  return {
    domain,
    ssoOrigin,
    ssoBase: `${ssoOrigin}/sso`,
    modernBase,
    signinUrl: `${ssoOrigin}/sso/signin`,
    uploadUrl: `${modernBase}/upload-service/upload/`,
    activityUrlTemplate: `${modernBase}/activity-service/activity/{activity_id}`,
  }
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GarminAuthenticationError(`Invalid Garmin secret: missing or empty "${field}".`)
  }
  return value
}

function asFiniteNumber(value: unknown, field: string, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new GarminAuthenticationError(`Invalid Garmin secret: "${field}" must be a finite number.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deserialize a `garth.client.dumps()` base64-encoded `[oauth1_token, oauth2_token]` JSON string.
 */
export function deserializeGarminSecret(
  secretString: string,
  fallbackDomain?: GarminDomain,
): GarminSecretBundle {
  const trimmed = secretString.trim()
  if (!trimmed) {
    throw new GarminAuthenticationError('Garmin secret string is empty.')
  }

  let decodedJson: string
  try {
    decodedJson = Buffer.from(trimmed, 'base64').toString('utf8')
  }
  catch (err) {
    throw new GarminAuthenticationError('Failed to base64-decode Garmin secret string.', { cause: err })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decodedJson)
  }
  catch (err) {
    throw new GarminAuthenticationError('Failed to parse Garmin secret JSON payload.', { cause: err })
  }

  if (!Array.isArray(parsed) || parsed.length < 2 || !isRecord(parsed[0]) || !isRecord(parsed[1])) {
    throw new GarminAuthenticationError(
      'Invalid Garmin secret payload: expected base64-encoded [oauth1_token, oauth2_token] JSON array.',
    )
  }

  const rawOAuth1 = parsed[0]
  const rawOAuth2 = parsed[1]

  const oauth1Domain = typeof rawOAuth1.domain === 'string' && rawOAuth1.domain.trim().length > 0
    ? resolveGarminDomain(rawOAuth1.domain)
    : undefined

  const domain = oauth1Domain ?? fallbackDomain ?? 'garmin.com'

  const oauth1Token: GarminOAuth1Token = {
    oauth_token: asNonEmptyString(rawOAuth1.oauth_token, 'oauth1.oauth_token'),
    oauth_token_secret: asNonEmptyString(rawOAuth1.oauth_token_secret, 'oauth1.oauth_token_secret'),
    mfa_token: typeof rawOAuth1.mfa_token === 'string' ? rawOAuth1.mfa_token : null,
    mfa_expiration_timestamp: typeof rawOAuth1.mfa_expiration_timestamp === 'string'
      ? rawOAuth1.mfa_expiration_timestamp
      : null,
    domain,
  }

  const oauth2Token: GarminOAuth2Token = {
    scope: typeof rawOAuth2.scope === 'string' ? rawOAuth2.scope : '',
    jti: typeof rawOAuth2.jti === 'string' ? rawOAuth2.jti : '',
    token_type: typeof rawOAuth2.token_type === 'string' && rawOAuth2.token_type.trim().length > 0
      ? rawOAuth2.token_type
      : 'Bearer',
    access_token: asNonEmptyString(rawOAuth2.access_token, 'oauth2.access_token'),
    refresh_token: typeof rawOAuth2.refresh_token === 'string' ? rawOAuth2.refresh_token : '',
    expires_in: asFiniteNumber(rawOAuth2.expires_in, 'oauth2.expires_in', 0),
    expires_at: asFiniteNumber(rawOAuth2.expires_at, 'oauth2.expires_at'),
    refresh_token_expires_in: asFiniteNumber(rawOAuth2.refresh_token_expires_in, 'oauth2.refresh_token_expires_in', 0),
    refresh_token_expires_at: asFiniteNumber(rawOAuth2.refresh_token_expires_at, 'oauth2.refresh_token_expires_at', 0),
  }

  return {
    oauth1Token,
    oauth2Token,
    domain,
  }
}

/**
 * Serialize `[oauth1Token, oauth2Token]` into the exact base64 JSON format used by `garth.client.dumps()`.
 */
export function serializeGarminSecret(
  oauth1Token: GarminOAuth1Token,
  oauth2Token: GarminOAuth2Token,
): string {
  const payload = [oauth1Token, oauth2Token]
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

export function isOAuth2TokenExpired(
  token: GarminOAuth2Token,
  nowMs: number = Date.now(),
  skewSeconds = 0,
): boolean {
  const nowSec = nowMs / 1000
  return token.expires_at <= nowSec + skewSeconds
}

export function formatOAuth2AuthorizationHeader(token: GarminOAuth2Token): string {
  const rawType = token.token_type.trim() || 'Bearer'
  const titledType = rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase()
  return `${titledType} ${token.access_token}`
}

export async function resolveOAuthConsumer(options: {
  readonly oauthConsumer?: GarminOAuthConsumer
  readonly oauthConsumerUrl?: string
  readonly fetch?: GarminFetchFn
}): Promise<GarminOAuthConsumer> {
  if (options.oauthConsumer) {
    return options.oauthConsumer
  }

  const url = options.oauthConsumerUrl ?? GARMIN_OAUTH_CONSUMER_URL
  const cached = consumerCache.get(url)
  if (cached) {
    return cached
  }

  const fetchFn = options.fetch ?? globalThis.fetch
  const response = await fetchFn(url, { method: 'GET' })
  if (!response.ok) {
    throw new GarminAuthenticationError(
      `Failed to fetch Garmin OAuth consumer credentials (HTTP ${response.status}).`,
    )
  }

  const parsed = await response.json() as unknown
  if (!isRecord(parsed)) {
    throw new GarminAuthenticationError('Invalid Garmin OAuth consumer response payload.')
  }

  const consumer: GarminOAuthConsumer = {
    consumer_key: asNonEmptyString(parsed.consumer_key, 'consumer_key'),
    consumer_secret: asNonEmptyString(parsed.consumer_secret, 'consumer_secret'),
  }
  consumerCache.set(url, consumer)
  return consumer
}

export function clearOAuthConsumerCache(): void {
  consumerCache.clear()
}

export interface ExchangeOAuth2Options {
  readonly oauth1Token: GarminOAuth1Token
  readonly domain?: GarminDomain
  readonly isLogin?: boolean
  readonly fetch?: GarminFetchFn
  readonly oauthConsumer?: GarminOAuthConsumer
  readonly oauthConsumerUrl?: string
  readonly cookieHeader?: string
  readonly now?: () => number
}

/**
 * Exchange an OAuth1 token for a fresh OAuth2 Bearer token via Garmin's
 * `connectapi.garmin.{com|cn}/oauth-service/oauth/exchange/user/2.0` endpoint.
 */
export async function exchangeOAuth1ForOAuth2(options: ExchangeOAuth2Options): Promise<GarminOAuth2Token> {
  const domain = options.domain ?? resolveGarminDomain(options.oauth1Token.domain)
  const urls = getGarminUrls(domain)
  const fetchFn = options.fetch ?? globalThis.fetch
  const consumer = await resolveOAuthConsumer({
    oauthConsumer: options.oauthConsumer,
    oauthConsumerUrl: options.oauthConsumerUrl,
    fetch: fetchFn,
  })

  const bodyParams: Record<string, string> = {}
  if (options.isLogin) {
    bodyParams.audience = 'GARMIN_CONNECT_MOBILE_ANDROID_DI'
  }
  if (options.oauth1Token.mfa_token) {
    bodyParams.mfa_token = options.oauth1Token.mfa_token
  }

  const url = `${urls.modernBase}/oauth-service/oauth/exchange/user/2.0`
  const nowMs = (options.now ?? Date.now)()
  const authorization = createOAuth1AuthorizationHeader({
    method: 'POST',
    url,
    consumerKey: consumer.consumer_key,
    consumerSecret: consumer.consumer_secret,
    token: options.oauth1Token.oauth_token,
    tokenSecret: options.oauth1Token.oauth_token_secret,
    bodyParams,
    timestamp: Math.floor(nowMs / 1000).toString(),
  })

  const headers: Record<string, string> = {
    'User-Agent': GARMIN_OAUTH_USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': authorization,
  }
  if (options.cookieHeader) {
    headers.Cookie = options.cookieHeader
  }

  const encodedBody = new URLSearchParams(bodyParams).toString()
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: encodedBody,
  })

  if (!response.ok) {
    const rawError = await response.text().catch(() => '')
    const safeError = redactGarminMessage(rawError.slice(0, 200), [
      options.oauth1Token.oauth_token,
      options.oauth1Token.oauth_token_secret,
      options.oauth1Token.mfa_token ?? '',
      consumer.consumer_secret,
    ])
    throw new GarminAuthenticationError(
      `Garmin OAuth2 token exchange failed for ${domain} (HTTP ${response.status})${safeError ? `: ${safeError}` : ''}`,
    )
  }

  const raw = await response.json() as unknown
  if (!isRecord(raw)) {
    throw new GarminAuthenticationError(`Invalid Garmin OAuth2 exchange response for ${domain}.`)
  }

  const nowSec = Math.floor((options.now ?? Date.now)() / 1000)
  const expiresIn = asFiniteNumber(raw.expires_in, 'expires_in', 3600)
  const refreshExpiresIn = asFiniteNumber(raw.refresh_token_expires_in, 'refresh_token_expires_in', 0)

  return {
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    jti: typeof raw.jti === 'string' ? raw.jti : '',
    token_type: typeof raw.token_type === 'string' && raw.token_type.trim().length > 0 ? raw.token_type : 'Bearer',
    access_token: asNonEmptyString(raw.access_token, 'access_token'),
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : '',
    expires_in: expiresIn,
    expires_at: asFiniteNumber(raw.expires_at, 'expires_at', nowSec + expiresIn),
    refresh_token_expires_in: refreshExpiresIn,
    refresh_token_expires_at: asFiniteNumber(
      raw.refresh_token_expires_at,
      'refresh_token_expires_at',
      nowSec + refreshExpiresIn,
    ),
  }
}

class CookieJar {
  private readonly cookies = new Map<string, string>()

  capture(headers: Headers): void {
    const rawCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (() => {
          const header = headers.get('set-cookie')
          return header ? [header] : []
        })()

    for (const cookieLine of rawCookies) {
      const firstPart = cookieLine.split(';', 1)[0]?.trim()
      if (!firstPart) {
        continue
      }
      const eqIndex = firstPart.indexOf('=')
      if (eqIndex <= 0) {
        continue
      }
      const name = firstPart.slice(0, eqIndex).trim()
      const value = firstPart.slice(eqIndex + 1).trim()
      if (name) {
        this.cookies.set(name, value)
      }
    }
  }

  toHeader(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined
    }
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
}

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function extractSsoResponseStatus(payload: Record<string, unknown>): {
  readonly type: string
  readonly message: string
} {
  const status = isRecord(payload.responseStatus) ? payload.responseStatus : {}
  const type = typeof status.type === 'string' ? status.type : 'UNKNOWN'
  const message = typeof status.message === 'string' ? status.message : ''
  return { type, message }
}

async function parseJsonResponse(
  response: Response,
  context: string,
  extraSecrets: readonly string[],
): Promise<Record<string, unknown>> {
  const bodyText = await response.text()
  if (!response.ok) {
    const safeBody = redactGarminMessage(bodyText.slice(0, 200), extraSecrets)
    throw new GarminAuthenticationError(
      `${context} failed (HTTP ${response.status})${safeBody ? `: ${safeBody}` : ''}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  }
  catch (err) {
    throw new GarminAuthenticationError(`${context} returned a non-JSON response.`, { cause: err })
  }

  if (!isRecord(parsed)) {
    throw new GarminAuthenticationError(`${context} returned an unexpected JSON payload.`)
  }
  return parsed
}

/**
 * Perform Garmin SSO login (`sso.garmin.com` or `sso.garmin.cn`), exchange the service
 * ticket for OAuth1 + OAuth2 tokens, and return both the structured tokens and `garth`-compatible `secretString`.
 */
export async function loginGarmin(options: GetGarminSecretOptions = {}): Promise<GarminLoginResult> {
  let email = options.email?.trim()
  let password = options.password
  let isCn = options.isCn

  if (!email || !password) {
    const env = loadEnvConfig(options.envOptions)
    email = email || env.garminEmail?.trim()
    password = password || env.garminPassword
    if (isCn === undefined && env.garminIsCn !== undefined) {
      isCn = parseBooleanFlag(env.garminIsCn)
    }
  }

  if (!email || !password) {
    throw new ConfigurationError(
      'Missing Garmin credentials. Provide email and password as arguments or set GARMIN_EMAIL and GARMIN_PASSWORD in .env.local.',
    )
  }

  const domain = resolveGarminDomain(isCn ?? false)
  const urls = getGarminUrls(domain)
  const fetchFn = options.fetch ?? globalThis.fetch
  const secretValues = [password]
  const logger = wrapGarminLogger(options.logger, 'garmin.auth', () => secretValues)
  const cookieJar = new CookieJar()

  const serviceUrl = `https://mobile.integration.${domain}/gcm/android`
  const loginParams = new URLSearchParams({
    clientId: GARMIN_SSO_CLIENT_ID,
    locale: 'en-US',
    service: serviceUrl,
  })

  logger.info(`Starting Garmin SSO login for ${domain}.`)

  // Step 1: Prime SSO cookies
  const signInUrl = `${urls.ssoOrigin}/mobile/sso/en/sign-in?clientId=${encodeURIComponent(GARMIN_SSO_CLIENT_ID)}`
  const signInResp = await fetchFn(signInUrl, {
    method: 'GET',
    headers: {
      ...SSO_PAGE_HEADERS,
      'Sec-Fetch-Site': 'none',
    },
  })
  cookieJar.capture(signInResp.headers)
  if (!signInResp.ok) {
    throw new GarminAuthenticationError(`Garmin SSO sign-in page failed for ${domain} (HTTP ${signInResp.status}).`)
  }

  // Step 2: Submit credentials
  const loginUrl = `${urls.ssoOrigin}/mobile/api/login?${loginParams.toString()}`
  const loginHeaders: Record<string, string> = {
    ...SSO_PAGE_HEADERS,
    'Content-Type': 'application/json',
  }
  const initialCookies = cookieJar.toHeader()
  if (initialCookies) {
    loginHeaders.Cookie = initialCookies
  }

  const loginResp = await fetchFn(loginUrl, {
    method: 'POST',
    headers: loginHeaders,
    body: JSON.stringify({
      username: email,
      password,
      rememberMe: false,
      captchaToken: '',
    }),
  })
  cookieJar.capture(loginResp.headers)

  const loginJson = await parseJsonResponse(loginResp, `Garmin SSO login (${domain})`, secretValues)
  const status = extractSsoResponseStatus(loginJson)

  let serviceTicketId: string | undefined

  if (status.type === 'SUCCESSFUL') {
    serviceTicketId = asNonEmptyString(loginJson.serviceTicketId, 'serviceTicketId')
  }
  else if (status.type === 'MFA_REQUIRED') {
    const mfaInfo = isRecord(loginJson.customerMfaInfo) ? loginJson.customerMfaInfo : {}
    const mfaMethod = typeof mfaInfo.mfaLastMethodUsed === 'string' && mfaInfo.mfaLastMethodUsed.trim().length > 0
      ? mfaInfo.mfaLastMethodUsed
      : 'email'

    const mfaCode = options.mfaCode?.trim()
      || (options.promptMfa ? (await options.promptMfa(mfaMethod)).trim() : '')

    if (!mfaCode) {
      throw new GarminMfaRequiredError(
        `Garmin account requires MFA verification (${mfaMethod}). Re-run with an MFA verification code or provide promptMfa.`,
        mfaMethod,
      )
    }

    const mfaUrl = `${urls.ssoOrigin}/mobile/api/mfa/verifyCode?${loginParams.toString()}`
    const mfaHeaders: Record<string, string> = {
      ...SSO_PAGE_HEADERS,
      'Content-Type': 'application/json',
    }
    const mfaCookies = cookieJar.toHeader()
    if (mfaCookies) {
      mfaHeaders.Cookie = mfaCookies
    }

    const mfaResp = await fetchFn(mfaUrl, {
      method: 'POST',
      headers: mfaHeaders,
      body: JSON.stringify({
        mfaMethod,
        mfaVerificationCode: mfaCode,
        rememberMyBrowser: false,
        reconsentList: [],
        mfaSetup: false,
      }),
    })
    cookieJar.capture(mfaResp.headers)

    const mfaJson = await parseJsonResponse(mfaResp, `Garmin SSO MFA verification (${domain})`, secretValues)
    const mfaStatus = extractSsoResponseStatus(mfaJson)
    if (mfaStatus.type !== 'SUCCESSFUL') {
      const detail = mfaStatus.message ? `${mfaStatus.type}: ${mfaStatus.message}` : mfaStatus.type
      throw new GarminAuthenticationError(`Garmin MFA verification failed (${domain}): ${detail}`)
    }
    serviceTicketId = asNonEmptyString(mfaJson.serviceTicketId, 'serviceTicketId')
  }
  else {
    const detail = status.message ? `${status.type}: ${status.message}` : status.type
    throw new GarminAuthenticationError(
      `Garmin SSO login failed for ${domain}: ${redactGarminMessage(detail, secretValues)}`,
    )
  }

  // Step 3: Best-effort portal embed cookie pinning
  try {
    const embedHeaders: Record<string, string> = {
      ...SSO_PAGE_HEADERS,
      'Sec-Fetch-Site': 'same-origin',
      'Referer': loginUrl,
    }
    const embedCookies = cookieJar.toHeader()
    if (embedCookies) {
      embedHeaders.Cookie = embedCookies
    }
    const embedResp = await fetchFn(`${urls.ssoOrigin}/portal/sso/embed`, {
      method: 'GET',
      headers: embedHeaders,
    })
    cookieJar.capture(embedResp.headers)
  }
  catch {
    // Best-effort backend cookie pinning; safe to continue.
  }

  // Step 4: Exchange service ticket for OAuth1 token
  const consumer = await resolveOAuthConsumer({
    oauthConsumer: options.oauthConsumer,
    oauthConsumerUrl: options.oauthConsumerUrl,
    fetch: fetchFn,
  })
  secretValues.push(consumer.consumer_secret)

  const preauthorizedUrl
    = `${urls.modernBase}/oauth-service/oauth/preauthorized`
      + `?ticket=${encodeURIComponent(serviceTicketId)}`
      + `&login-url=${encodeURIComponent(serviceUrl)}`
      + '&accepts-mfa-tokens=true'

  const nowMs = (options.now ?? Date.now)()
  const preauthHeaders: Record<string, string> = {
    'User-Agent': GARMIN_OAUTH_USER_AGENT,
    'Authorization': createOAuth1AuthorizationHeader({
      method: 'GET',
      url: preauthorizedUrl,
      consumerKey: consumer.consumer_key,
      consumerSecret: consumer.consumer_secret,
      timestamp: Math.floor(nowMs / 1000).toString(),
    }),
  }
  const preauthCookies = cookieJar.toHeader()
  if (preauthCookies) {
    preauthHeaders.Cookie = preauthCookies
  }

  const preauthResp = await fetchFn(preauthorizedUrl, {
    method: 'GET',
    headers: preauthHeaders,
  })
  cookieJar.capture(preauthResp.headers)

  const preauthBody = await preauthResp.text()
  if (!preauthResp.ok) {
    const safeBody = redactGarminMessage(preauthBody.slice(0, 200), secretValues)
    throw new GarminAuthenticationError(
      `Garmin OAuth1 preauthorized exchange failed for ${domain} (HTTP ${preauthResp.status})${safeBody ? `: ${safeBody}` : ''}`,
    )
  }

  const preauthParams = new URLSearchParams(preauthBody)
  const oauth1Token: GarminOAuth1Token = {
    oauth_token: asNonEmptyString(preauthParams.get('oauth_token'), 'oauth_token'),
    oauth_token_secret: asNonEmptyString(preauthParams.get('oauth_token_secret'), 'oauth_token_secret'),
    mfa_token: preauthParams.get('mfa_token') ?? null,
    mfa_expiration_timestamp: preauthParams.get('mfa_expiration_timestamp') ?? null,
    domain,
  }
  secretValues.push(oauth1Token.oauth_token, oauth1Token.oauth_token_secret)

  // Step 5: Exchange OAuth1 token for OAuth2 Bearer token
  const oauth2Token = await exchangeOAuth1ForOAuth2({
    oauth1Token,
    domain,
    isLogin: true,
    fetch: fetchFn,
    oauthConsumer: consumer,
    cookieHeader: cookieJar.toHeader(),
    now: options.now,
  })
  secretValues.push(oauth2Token.access_token, oauth2Token.refresh_token)

  const secretString = serializeGarminSecret(oauth1Token, oauth2Token)
  secretValues.push(secretString)

  logger.info(`Garmin SSO login succeeded for ${domain}.`)

  return {
    secretString,
    oauth1Token,
    oauth2Token,
    domain,
  }
}

/**
 * Convenience wrapper matching `scripts/get_garmin_secret.py`: logs into Garmin COM or CN
 * and returns a `garth`-compatible base64-encoded `secret_string`.
 */
export async function getGarminSecret(options: GetGarminSecretOptions = {}): Promise<string> {
  const result = await loginGarmin(options)
  return result.secretString
}
