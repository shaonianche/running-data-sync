import type { LogRecord } from '../../foundation/logger.js'
import type { FetchLike } from './types.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthenticationError, RateLimitError, SyncError } from '../../foundation/errors.js'
import { createLogger } from '../../foundation/logger.js'
import {
  parseRateLimitHeaders,
  parseRetryAfterSeconds,
  redactSecretValues,
  StravaClient,
  toUnixEpochSeconds,
  uploadFileToStrava,
} from './client.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
})

describe('rate limit & timestamp helpers', () => {
  it('parses X-RateLimit-Limit, X-RateLimit-Usage, and numeric Retry-After headers', () => {
    const headers = new Headers({
      'X-RateLimit-Limit': '200,2000',
      'X-RateLimit-Usage': '199,1500',
      'Retry-After': '45',
    })

    expect(parseRateLimitHeaders(headers)).toEqual({
      shortTermLimit: 200,
      dailyLimit: 2000,
      shortTermUsage: 199,
      dailyUsage: 1500,
      retryAfterSeconds: 45,
    })
  })

  it('parses HTTP-date Retry-After headers relative to current clock', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    expect(parseRetryAfterSeconds('Thu, 01 Jan 2026 00:02:00 GMT', now)).toBe(120)
    expect(parseRetryAfterSeconds('Thu, 01 Jan 2025 00:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfterSeconds('not-a-date', now)).toBeNull()
  })

  it('parses ISO strings without Z as UTC epoch seconds', () => {
    expect(toUnixEpochSeconds('2025-03-15T00:30:00Z')).toBe(1742000000 - 1400)
    expect(toUnixEpochSeconds('2025-03-15T00:30:00')).toBe(toUnixEpochSeconds('2025-03-15T00:30:00Z'))
    expect(toUnixEpochSeconds('2025-03-15 00:30:00')).toBe(toUnixEpochSeconds('2025-03-15T00:30:00Z'))
    expect(toUnixEpochSeconds(new Date('2025-03-15T00:30:00Z'))).toBe(toUnixEpochSeconds('2025-03-15T00:30:00Z'))
    expect(toUnixEpochSeconds(1741998600.9)).toBe(1741998600)
  })
})

describe('stravaClient', () => {
  it('refreshes OAuth2 access token via form POST and updates rotated refresh token', async () => {
    const requests: Array<{ url: string, body: string, contentType: string | null }> = []
    const mockFetch: FetchLike = async (input, init) => {
      requests.push({
        url: String(input),
        body: String(init?.body ?? ''),
        contentType: new Headers(init?.headers).get('content-type'),
      })
      return jsonResponse({
        token_type: 'Bearer',
        access_token: 'fresh-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_at: 1800000000,
        expires_in: 21600,
      })
    }

    const client = new StravaClient({
      clientId: '12345',
      clientSecret: 'super-secret-xyz',
      refreshToken: 'initial-refresh-token',
      fetch: mockFetch,
    })

    const token = await client.refreshAccessToken()

    expect(token.access_token).toBe('fresh-access-token')
    expect(token.refresh_token).toBe('rotated-refresh-token')
    expect(client.accessToken).toBe('fresh-access-token')
    expect(client.refreshToken).toBe('rotated-refresh-token')
    expect(client.expiresAt).toBe(1800000000)

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://www.strava.com/oauth/token')
    expect(requests[0].contentType).toBe('application/x-www-form-urlencoded')

    const params = new URLSearchParams(requests[0].body)
    expect(params.get('client_id')).toBe('12345')
    expect(params.get('client_secret')).toBe('super-secret-xyz')
    expect(params.get('refresh_token')).toBe('initial-refresh-token')
    expect(params.get('grant_type')).toBe('refresh_token')
  })

  it('throws AuthenticationError on OAuth failure and redacts secrets from logs and error messages', async () => {
    const secret = 'strava-client-secret-999'
    const refresh = 'strava-refresh-token-888'
    const records: LogRecord[] = []
    const logger = createLogger('test.strava', { sink: record => records.push(record) })

    const mockFetch: FetchLike = async () =>
      new Response(
        `invalid grant for client_secret=${secret} refresh_token=${refresh} raw=${secret}`,
        { status: 401 },
      )

    const client = new StravaClient({
      clientId: '42',
      clientSecret: secret,
      refreshToken: refresh,
      fetch: mockFetch,
      logger,
    })

    let caught: unknown
    try {
      await client.refreshAccessToken()
    }
    catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AuthenticationError)
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(message).not.toContain(refresh)

    const serializedLogs = JSON.stringify(records)
    expect(serializedLogs).not.toContain(secret)
    expect(serializedLogs).not.toContain(refresh)
  })

  it('paginates /athlete/activities with after/before filters and stops on short page', async () => {
    const requestedUrls: string[] = []
    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      requestedUrls.push(url)

      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'tok-1', refresh_token: 'ref-1' })
      }

      const parsed = new URL(url)
      const page = Number(parsed.searchParams.get('page'))
      if (page === 1) {
        return jsonResponse([
          { id: 1, name: 'A', distance: 1000, moving_time: 300, start_date: '2025-03-01T00:00:00Z', start_date_local: '2025-03-01T08:00:00Z' },
          { id: 2, name: 'B', distance: 2000, moving_time: 600, start_date: '2025-03-02T00:00:00Z', start_date_local: '2025-03-02T08:00:00Z' },
        ])
      }
      if (page === 2) {
        return jsonResponse([
          { id: 3, name: 'C', distance: 3000, moving_time: 900, start_date: '2025-03-03T00:00:00Z', start_date_local: '2025-03-03T08:00:00Z' },
        ])
      }
      return jsonResponse([])
    }

    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
    })

    const activities = await client.listActivities({
      after: '2025-02-28T00:00:00Z',
      perPage: 2,
    })

    expect(activities.map(a => a.id)).toEqual([1, 2, 3])
    expect(requestedUrls).toHaveLength(3)
    const page1 = new URL(requestedUrls[1])
    expect(page1.searchParams.get('after')).toBe(String(toUnixEpochSeconds('2025-02-28T00:00:00Z')))
    expect(page1.searchParams.get('per_page')).toBe('2')
    expect(page1.searchParams.get('page')).toBe('1')
    const page2 = new URL(requestedUrls[2])
    expect(page2.searchParams.get('page')).toBe('2')
  })

  it('fetches single activity details and streams (object, array fallback, and 404 empty map)', async () => {
    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.endsWith('/activities/101')) {
        return jsonResponse({
          id: 101,
          name: 'Detail Run',
          distance: 5000,
          moving_time: 1500,
          start_date: '2025-03-10T00:00:00Z',
          start_date_local: '2025-03-10T08:00:00Z',
        })
      }
      if (url.includes('/activities/101/streams')) {
        return jsonResponse({
          time: { data: [0, 10] },
          heartrate: { data: [130, 145] },
        })
      }
      if (url.includes('/activities/102/streams')) {
        return jsonResponse([
          { type: 'time', data: [0, 5] },
          { type: 'distance', data: [0, 20] },
        ])
      }
      if (url.includes('/activities/103/streams')) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response('Unexpected', { status: 500 })
    }

    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      accessToken: 'existing-token',
      fetch: mockFetch,
    })

    const detail = await client.getActivity(101)
    expect(detail.name).toBe('Detail Run')

    const streamsObject = await client.getActivityStreams(101)
    expect(streamsObject.time?.data).toEqual([0, 10])
    expect(streamsObject.heartrate?.data).toEqual([130, 145])

    const streamsArray = await client.getActivityStreams(102)
    expect(streamsArray.time?.data).toEqual([0, 5])
    expect(streamsArray.distance?.data).toEqual([0, 20])

    const missingStreams = await client.getActivityStreams(103)
    expect(missingStreams).toEqual({})
  })

  it('retries HTTP 429 with Retry-After or exponential backoff and throws RateLimitError when exhausted', async () => {
    const sleepCalls: number[] = []
    let attemptCount = 0

    const mockFetch: FetchLike = async () => {
      attemptCount += 1
      if (attemptCount === 1) {
        return new Response('Rate Limit Exceeded', {
          status: 429,
          headers: {
            'X-RateLimit-Limit': '200,2000',
            'X-RateLimit-Usage': '200,800',
            'Retry-After': '3',
          },
        })
      }
      if (attemptCount === 2) {
        return new Response('Rate Limit Exceeded', {
          status: 429,
          headers: {
            'X-RateLimit-Limit': '200,2000',
            'X-RateLimit-Usage': '200,801',
          },
        })
      }
      return jsonResponse({ id: 55, name: 'Recovered', distance: 1000, moving_time: 300, start_date: '2025-03-01T00:00:00Z', start_date_local: '2025-03-01T08:00:00Z' })
    }

    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      accessToken: 'tok',
      fetch: mockFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      maxRateLimitRetries: 2,
      baseBackoffMs: 500,
      maxBackoffMs: 5000,
    })

    const recovered = await client.getActivity(55)
    expect(recovered.id).toBe(55)
    // Attempt 0 used Retry-After=3s (3000ms), attempt 1 had no Retry-After so 500 * 2^1 = 1000ms
    expect(sleepCalls).toEqual([3000, 1000])
    expect(client.lastRateLimit?.shortTermUsage).toBe(200)

    // Exhausted retries throws RateLimitError with parsed retryAfter
    const always429: FetchLike = async () =>
      new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '12' },
      })

    const strictClient = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      accessToken: 'tok',
      fetch: always429,
      sleep: async () => {},
      maxRateLimitRetries: 0,
    })

    await expect(strictClient.getActivity(55)).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: 12,
    })
  })

  it('uploads activity file via FormData and retries once on HTTP 429', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rds-strava-upload-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'sample.fit')
    await fs.writeFile(filePath, new Uint8Array([14, 16, 46, 8]))

    const captured: Array<{ dataType: unknown, activityType: unknown }> = []
    let calls = 0
    const sleepSpy = vi.fn(async () => {})

    const mockFetch: FetchLike = async (_input, init) => {
      calls += 1
      const form = init?.body as FormData
      captured.push({
        dataType: form.get('data_type'),
        activityType: form.get('activity_type'),
      })
      if (calls === 1) {
        return new Response('Rate Limited', { status: 429, headers: { 'Retry-After': '2' } })
      }
      return jsonResponse({ id: 98765, status: 'Your activity is still being processed.' })
    }

    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      accessToken: 'tok',
      fetch: mockFetch,
      sleep: sleepSpy,
      maxRateLimitRetries: 1,
    })

    const response = await uploadFileToStrava(client, filePath, 'fit', true)
    expect(response.id).toBe(98765)
    expect(sleepSpy).toHaveBeenCalledWith(2000)
    expect(captured).toHaveLength(2)
    expect(captured[0]).toEqual({ dataType: 'fit', activityType: 'run' })
  })

  it('never leaks client_secret, refresh_token, or access_token in logs or thrown SyncError/RateLimitError', async () => {
    const clientSecret = 'ultra-secret-client-val'
    const refreshToken = 'ultra-secret-refresh-val'
    const accessToken = 'ultra-secret-access-val'
    const logs: LogRecord[] = []
    const logger = createLogger('test.redact', { sink: r => logs.push(r) })

    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
      }
      return new Response(
        `Upstream debug echo: Authorization: Bearer ${accessToken}, client_secret=${clientSecret}, refresh_token=${refreshToken}`,
        { status: 500 },
      )
    }

    const client = new StravaClient({
      clientId: '777',
      clientSecret,
      refreshToken,
      fetch: mockFetch,
      logger,
    })

    await client.refreshAccessToken()

    let thrown: unknown
    try {
      await client.getActivity(12345)
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(SyncError)
    const combined = `${(thrown as Error).message}\n${JSON.stringify(logs)}`
    expect(combined).not.toContain(clientSecret)
    expect(combined).not.toContain(refreshToken)
    expect(combined).not.toContain(accessToken)
    expect(redactSecretValues(`Bearer ${accessToken} ${clientSecret}`, [clientSecret, accessToken])).toBe('Bearer *** ***')
  })

  it('throws RateLimitError when OAuth refresh itself is rate-limited', async () => {
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }),
    })

    await expect(client.refreshAccessToken()).rejects.toBeInstanceOf(RateLimitError)
  })
})
