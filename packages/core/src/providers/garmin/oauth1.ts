import { createHmac, randomBytes } from 'node:crypto'

export interface OAuth1SignOptions {
  readonly method: string
  readonly url: string
  readonly consumerKey: string
  readonly consumerSecret: string
  readonly token?: string
  readonly tokenSecret?: string
  readonly bodyParams?: Readonly<Record<string, string>>
  readonly timestamp?: string
  readonly nonce?: string
}

/**
 * RFC 3986 percent-encoding required by OAuth 1.0a (RFC 5849 §3.6).
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function normalizeBaseUrl(parsedUrl: URL): string {
  const protocol = parsedUrl.protocol.toLowerCase()
  const hostname = parsedUrl.hostname.toLowerCase()
  const isDefaultPort
    = (protocol === 'http:' && (parsedUrl.port === '' || parsedUrl.port === '80'))
      || (protocol === 'https:' && (parsedUrl.port === '' || parsedUrl.port === '443'))
  const port = isDefaultPort ? '' : `:${parsedUrl.port}`
  return `${protocol}//${hostname}${port}${parsedUrl.pathname}`
}

/**
 * Build an OAuth 1.0a `Authorization` header signed with HMAC-SHA1 using Node `node:crypto`.
 */
export function createOAuth1AuthorizationHeader(options: OAuth1SignOptions): string {
  const parsedUrl = new URL(options.url)
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString()
  const nonce = options.nonce ?? randomBytes(16).toString('hex')

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: options.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
  }

  if (options.token) {
    oauthParams.oauth_token = options.token
  }

  const signaturePairs: Array<[string, string]> = []

  for (const [key, value] of parsedUrl.searchParams.entries()) {
    signaturePairs.push([percentEncode(key), percentEncode(value)])
  }

  if (options.bodyParams) {
    for (const [key, value] of Object.entries(options.bodyParams)) {
      signaturePairs.push([percentEncode(key), percentEncode(value)])
    }
  }

  for (const [key, value] of Object.entries(oauthParams)) {
    signaturePairs.push([percentEncode(key), percentEncode(value)])
  }

  signaturePairs.sort((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] < b[0] ? -1 : 1
    }
    if (a[1] !== b[1]) {
      return a[1] < b[1] ? -1 : 1
    }
    return 0
  })

  const normalizedParams = signaturePairs
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

  const baseString = [
    options.method.toUpperCase(),
    percentEncode(normalizeBaseUrl(parsedUrl)),
    percentEncode(normalizedParams),
  ].join('&')

  const signingKey = `${percentEncode(options.consumerSecret)}&${percentEncode(options.tokenSecret ?? '')}`
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64')

  const headerParams: Array<[string, string]> = [
    ...Object.entries(oauthParams),
    ['oauth_signature', signature] as [string, string],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const headerValue = headerParams
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ')

  return `OAuth ${headerValue}`
}
