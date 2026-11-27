import type { Logger } from '../../foundation/index.js'
import type { GarminOAuth1Token, GarminOAuth2Token, GarminOAuthConsumer, GarminRateLimitError } from './types.js'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { REDACTED_VALUE, SyncError } from '../../foundation/index.js'
import { serializeGarminSecret } from './auth.js'
import { GarminClient } from './client.js'
import {
  isGarminSensitiveKey,
  redactGarminData,
  redactGarminMessage,
  redactHeaders,
  wrapGarminLogger,
} from './redaction.js'
import {
  GarminAuthenticationError,
  GarminConnectionError,
  GarminHttpError,
} from './types.js'

const TEST_CONSUMER: GarminOAuthConsumer = {
  consumer_key: 'consumer-key-123',
  consumer_secret: 'consumer-secret-super-sensitive',
}

function createSecret(options: {
  domain?: 'garmin.com' | 'garmin.cn'
  expiresAt?: number
  accessToken?: string
} = {}): string {
  const oauth1: GarminOAuth1Token = {
    oauth_token: 'oauth1-tok-sensitive-1',
    oauth_token_secret: 'oauth1-sec-sensitive-2',
    mfa_token: null,
    mfa_expiration_timestamp: null,
    domain: options.domain ?? 'garmin.com',
  }
  const oauth2: GarminOAuth2Token = {
    scope: 'CONNECT_READ CONNECT_WRITE',
    jti: 'jti-abc',
    token_type: 'bearer',
    access_token: options.accessToken ?? 'oauth2-access-sensitive-3',
    refresh_token: 'oauth2-refresh-sensitive-4',
    expires_in: 3600,
    expires_at: options.expiresAt ?? 2_000_000_000,
    refresh_token_expires_in: 86400,
    refresh_token_expires_at: 2_000_086_400,
  }
  return serializeGarminSecret(oauth1, oauth2)
}

function createTokenExchangeResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({
      scope: 'CONNECT_READ CONNECT_WRITE',
      jti: 'fresh-jti',
      token_type: 'bearer',
      access_token: accessToken,
      refresh_token: 'fresh-refresh-token',
      expires_in: expiresIn,
      refresh_token_expires_in: 86400,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function createRecordingLogger(): {
  logger: Logger
  entries: Array<{ level: string, message: string, data?: Record<string, unknown> }>
} {
  const entries: Array<{ level: string, message: string, data?: Record<string, unknown> }> = []
  const logger: Logger = {
    debug: (message, data) => entries.push({ level: 'debug', message, data }),
    info: (message, data) => entries.push({ level: 'info', message, data }),
    warn: (message, data) => entries.push({ level: 'warn', message, data }),
    error: (message, data) => entries.push({ level: 'error', message, data }),
  }
  return { logger, entries }
}

describe('garmin redaction utilities', () => {
  it('identifies sensitive keys and redacts tokens, headers, CLI flags, and extra secrets', () => {
    expect(isGarminSensitiveKey('secret_string')).toBe(true)
    expect(isGarminSensitiveKey('oauthTokenSecret')).toBe(true)
    expect(isGarminSensitiveKey('GARMIN_SECRET_CN')).toBe(true)
    expect(isGarminSensitiveKey('activityId')).toBe(false)

    const raw = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def --secret-string mySecretVal123 oauth_token=tok999'
    const redacted = redactGarminMessage(raw, ['extra-raw-secret-value'])
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redacted).not.toContain('mySecretVal123')
    expect(redacted).not.toContain('tok999')
    expect(redactGarminMessage('leaked extra-raw-secret-value here', ['extra-raw-secret-value'])).not.toContain(
      'extra-raw-secret-value',
    )

    const safeHeaders = redactHeaders(
      new Headers({
        'authorization': 'Bearer top-secret-token',
        'cookie': 'SESSION=abc',
        'content-type': 'application/json',
      }),
    )
    expect(safeHeaders.authorization).toBeUndefined()
    expect(safeHeaders.cookie).toBeUndefined()
    expect(safeHeaders['content-type']).toBe('application/json')

    const safeData = redactGarminData(
      {
        secretString: 'base64-payload',
        nested: { oauth_token_secret: 'hidden', safe: 'ok' },
      },
      ['base64-payload'],
    )
    expect(safeData.secretString).toBe(REDACTED_VALUE)
    expect((safeData.nested as Record<string, unknown>).oauth_token_secret).toBe(REDACTED_VALUE)
    expect((safeData.nested as Record<string, unknown>).safe).toBe('ok')
  })

  it('wraps loggers to scrub secrets from both messages and structured payloads', () => {
    const { logger, entries } = createRecordingLogger()
    const wrapped = wrapGarminLogger(logger, 'test.garmin', () => ['top-secret-bundle-xyz'])

    wrapped.error('Failed with top-secret-bundle-xyz and Bearer abc.def.ghi', {
      token: 'should-hide',
      detail: 'contains top-secret-bundle-xyz',
      activityId: 42,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).not.toContain('top-secret-bundle-xyz')
    expect(entries[0]?.message).not.toContain('abc.def.ghi')
    expect(entries[0]?.data?.token).toBe(REDACTED_VALUE)
    expect(String(entries[0]?.data?.detail)).not.toContain('top-secret-bundle-xyz')
    expect(entries[0]?.data?.activityId).toBe(42)
  })
})

describe('garminClient', () => {
  it('supports COM and CN domains, pagination, summary, download, and delete endpoints', async () => {
    const requests: Array<{ url: string, method: string, auth: string, origin: string }> = []
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        auth: headers.get('authorization') ?? '',
        origin: headers.get('origin') ?? '',
      })

      if (url.includes('/activitylist-service/activities/search/activities')) {
        const parsedUrl = new URL(url)
        const start = Number(parsedUrl.searchParams.get('start') ?? '0')
        if (start === 0) {
          return new Response(JSON.stringify([{ activityId: 101 }, { activityId: 102 }]), { status: 200 })
        }
        return new Response(JSON.stringify([{ activityId: 103 }]), { status: 200 })
      }
      if (url.includes('/activity-service/activity/101') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ activityId: 101, activityName: 'Morning Run' }), { status: 200 })
      }
      if (url.includes('/download-service/export/gpx/activity/101')) {
        return new Response('<gpx></gpx>', { status: 200 })
      }
      if (url.includes('/download-service/files/activity/101')) {
        return new Response(new Uint8Array([0x50, 0x4B, 0x03, 0x04]), { status: 200 })
      }
      if (url.includes('/activity-service/activity/101') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return new Response('not found', { status: 404 })
    }

    const client = new GarminClient({
      secretString: createSecret({ domain: 'garmin.cn' }),
      isCn: true,
      fetch: mockFetch,
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    expect(client.domain).toBe('garmin.cn')
    expect(client.account).toBe('garmin_cn')

    const all = await client.fetchAllActivities({ pageSize: 2, onlyRunning: true })
    expect(all.map(a => a.activityId)).toEqual([101, 102, 103])
    expect(requests[0]?.url).toContain('https://connectapi.garmin.cn/activitylist-service/activities/search/activities?')
    expect(requests[0]?.url).toContain('activityType=running')
    expect(requests[0]?.origin).toBe('https://sso.garmin.cn')
    expect(requests[0]?.auth).toBe('Bearer oauth2-access-sensitive-3')

    const summary = await client.getActivitySummary(101)
    expect(summary.activityName).toBe('Morning Run')

    const gpxBytes = await client.downloadActivity(101, 'gpx')
    expect(Buffer.from(gpxBytes).toString('utf8')).toBe('<gpx></gpx>')

    const fitBytes = await client.downloadActivity(101, 'fit')
    expect(Array.from(fitBytes)).toEqual([0x50, 0x4B, 0x03, 0x04])

    await client.deleteActivity(101)
    expect(requests.at(-1)?.method).toBe('DELETE')
    expect(requests.at(-1)?.url).toBe('https://connectapi.garmin.cn/activity-service/activity/101')
  })

  it('deduplicates concurrent proactive OAuth2 refreshes and notifies onTokenRefreshed', async () => {
    let exchangeCount = 0
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/oauth-service/oauth/exchange/user/2.0')) {
        exchangeCount += 1
        return createTokenExchangeResponse('refreshed-concurrent-token')
      }
      return new Response(JSON.stringify([{ activityId: 55 }]), { status: 200 })
    }

    const onTokenRefreshed = vi.fn()
    const client = new GarminClient({
      secretString: createSecret({ expiresAt: 1_699_999_000 }),
      fetch: mockFetch,
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
      onTokenRefreshed,
    })

    const [first, second] = await Promise.all([
      client.getActivities(0, 10),
      client.getActivities(0, 10),
    ])

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(exchangeCount).toBe(1)
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1)
    expect(client.getCurrentOAuth2Token().access_token).toBe('refreshed-concurrent-token')
  })

  it('refreshes OAuth2 token once on HTTP 401 and retries, or throws GarminAuthenticationError if still 401', async () => {
    let apiAttempts = 0
    const mockFetchRecover: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const auth = new Headers(init?.headers).get('authorization')
      if (url.includes('/oauth-service/oauth/exchange/user/2.0')) {
        return createTokenExchangeResponse('recovered-access-token')
      }
      apiAttempts += 1
      if (apiAttempts === 1) {
        return new Response('Unauthorized', { status: 401 })
      }
      expect(auth).toBe('Bearer recovered-access-token')
      return new Response(JSON.stringify([{ activityId: 777 }]), { status: 200 })
    }

    const client = new GarminClient({
      secretString: createSecret(),
      fetch: mockFetchRecover,
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    const activities = await client.getActivities(0, 10)
    expect(activities[0]?.activityId).toBe(777)
    expect(apiAttempts).toBe(2)

    const mockFetchAlways401: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/oauth-service/oauth/exchange/user/2.0')) {
        return createTokenExchangeResponse('still-bad-token')
      }
      return new Response('Unauthorized', { status: 401 })
    }

    const failingClient = new GarminClient({
      secretString: createSecret(),
      fetch: mockFetchAlways401,
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    await expect(failingClient.getActivities(0, 10)).rejects.toThrow(GarminAuthenticationError)
  })

  it('maps HTTP 429 Retry-After to GarminRateLimitError and network errors to redacted GarminConnectionError', async () => {
    const rateLimitedClient = new GarminClient({
      secretString: createSecret(),
      fetch: async () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '45' } }),
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    await expect(rateLimitedClient.getActivities()).rejects.toMatchObject({
      name: 'GarminRateLimitError',
      retryAfter: 45,
    } satisfies Partial<GarminRateLimitError>)

    const secret = createSecret({ accessToken: 'super-secret-access-999' })
    const networkFailClient = new GarminClient({
      secretString: secret,
      fetch: async () => {
        throw new Error('ECONNRESET while using super-secret-access-999')
      },
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    try {
      await networkFailClient.getActivities()
      expect.unreachable('Expected GarminConnectionError')
    }
    catch (err) {
      expect(err).toBeInstanceOf(GarminConnectionError)
      expect((err as Error).message).not.toContain('super-secret-access-999')
    }
  })

  it('handles uploadActivity responses for 200 success, 204 empty, 409 duplicate, 409 conflict error, and import rejection', async () => {
    const createUploadClient = (responder: () => Response): GarminClient => new GarminClient({
      secretString: createSecret(),
      fetch: async () => responder(),
      oauthConsumer: TEST_CONSUMER,
      now: () => 1_700_000_000_000,
    })

    const sampleFit = new Uint8Array([0x0E, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2E, 0x46, 0x49, 0x54])

    // 200 success with activityId
    const okResult = await createUploadClient(() =>
      new Response(
        JSON.stringify({
          detailedImportResult: {
            successes: [{ internalId: 9001, activityId: 888001 }],
            failures: [],
          },
        }),
        { status: 200 },
      ),
    ).uploadActivity('/tmp/123.fit', sampleFit)
    expect(okResult.status).toBe(200)
    expect(okResult.duplicate).toBe(false)
    expect(okResult.remoteActivityId).toBe(888001)

    // 204 empty response
    const empty204 = await createUploadClient(() => new Response(null, { status: 204 })).uploadActivity('123.fit', sampleFit)
    expect(empty204).toEqual({
      status: 204,
      detailedImportResult: null,
      remoteActivityId: null,
      duplicate: false,
    })

    // 409 duplicate with Garmin code 202
    const dup409 = await createUploadClient(() =>
      new Response(
        JSON.stringify({
          detailedImportResult: {
            successes: [],
            failures: [
              {
                internalId: 777002,
                messages: [{ code: 202, content: 'Duplicate Activity.' }],
              },
            ],
          },
        }),
        { status: 409 },
      ),
    ).uploadActivity('123.fit', sampleFit)
    expect(dup409.status).toBe(409)
    expect(dup409.duplicate).toBe(true)
    expect(dup409.remoteActivityId).toBe(777002)

    // 409 non-duplicate error
    await expect(
      createUploadClient(() => new Response('Quota exceeded', { status: 409 })).uploadActivity('123.fit', sampleFit),
    ).rejects.toThrow(GarminHttpError)

    // 200 rejected by Garmin import pipeline
    await expect(
      createUploadClient(() =>
        new Response(
          JSON.stringify({
            detailedImportResult: {
              successes: [],
              failures: [{ messages: [{ code: 500, content: 'Corrupt FIT header' }] }],
            },
          }),
          { status: 200 },
        ),
      ).uploadActivity('123.fit', sampleFit),
    ).rejects.toThrow(SyncError)
  })
})
