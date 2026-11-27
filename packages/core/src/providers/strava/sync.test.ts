import type { LogRecord } from '../../foundation/logger.js'
import type { FetchLike, StravaSummaryActivity } from './types.js'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../foundation/logger.js'
import { createOutdoorRunActivity, createOutdoorRunFlybyPoints, InMemoryActivityStore } from '../../testing/index.js'
import { StravaClient, toUnixEpochSeconds } from './client.js'
import { NominatimGeocoder } from './geocoder.js'
import { syncStravaActivityToStore, syncStravaToStore } from './sync.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

function makeStravaActivity(overrides: Partial<StravaSummaryActivity> & { id: number }): StravaSummaryActivity {
  return {
    name: `Run #${overrides.id}`,
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1520,
    total_elevation_gain: 30,
    type: 'Run',
    sport_type: 'Run',
    start_date: '2025-03-16T00:00:00Z',
    start_date_local: '2025-03-16T08:00:00Z',
    location_country: null,
    start_latlng: [39.944, 116.482],
    map: { summary_polyline: '_qxrFok}eU_XoK_XwQ' },
    average_speed: 3.333,
    average_heartrate: 155,
    ...overrides,
  }
}

describe('syncStravaToStore (InMemoryActivityStore + Mock HTTP)', () => {
  it('performs paginated incremental sync with after timestamp, geocoding, and flyby stream persistence', async () => {
    const existing = createOutdoorRunActivity({
      run_id: 100001,
      start_date: '2025-03-15T00:30:00Z',
      start_date_local: '2025-03-15T08:30:00',
    })
    const store = new InMemoryActivityStore({ activities: [existing] })

    const activityListUrls: string[] = []
    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1' })
      }
      if (url.includes('/athlete/activities')) {
        activityListUrls.push(url)
        const parsed = new URL(url)
        const page = Number(parsed.searchParams.get('page'))
        if (page === 1) {
          // Includes an already-existing activity plus one new activity
          return jsonResponse([
            makeStravaActivity({ id: 100001, name: 'Duplicate Existing' }),
            makeStravaActivity({ id: 100002, name: 'New Outdoor Run', start_date: '2025-03-16T00:00:00Z', start_date_local: '2025-03-16T08:00:00Z' }),
          ])
        }
        return jsonResponse([])
      }
      if (url.includes('/activities/100002/streams')) {
        return jsonResponse({
          time: { data: [0, 300] },
          latlng: { data: [[39.944, 116.482], [39.948, 116.484]] },
          velocity_smooth: { data: [3.3333, 3.3333] },
          heartrate: { data: [140, 155] },
          distance: { data: [0, 1000] },
        })
      }
      if (url.includes('nominatim.openstreetmap.org/reverse')) {
        return jsonResponse({ address: { country: '中国' } })
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.sync', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })
    const geocoder = new NominatimGeocoder({ fetch: mockFetch, logger: silentLogger })

    const result = await syncStravaToStore({
      store,
      client,
      geocoder,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      logger: silentLogger,
    })

    expect(result).toEqual({
      fetchedActivities: 2,
      syncedActivities: 1,
      prunedActivities: 0,
      enqueuedFlyby: 1,
      flybySyncedActivities: 1,
      flybySkippedActivities: 0,
      flybyFailedActivities: 0,
      flybyPointsStored: 2,
      remainingFlybyQueue: 0,
      stoppedByRateLimit: false,
    })

    // Verified incremental `after` parameter matches existing latest start_date
    const listUrl = new URL(activityListUrls[0])
    expect(listUrl.searchParams.get('after')).toBe(String(toUnixEpochSeconds('2025-03-15T00:30:00Z')))

    // Existing activity was not overwritten in incremental mode
    const storedExisting = await store.getActivityById(100001)
    expect(storedExisting?.name).toBe('Morning Run')

    // New activity was mapped, geocoded, and stored with flyby telemetry
    const storedNew = await store.getActivityById(100002)
    expect(storedNew?.name).toBe('New Outdoor Run')
    expect(storedNew?.location_country).toBe('中国')
    expect(storedNew?.start_date_local).toBe('2025-03-16T08:00:00')

    const flyby = await store.getFlybyPoints(100002)
    expect(flyby).toHaveLength(2)
    expect(flyby[0].pace).toBe(0)
    expect(flyby[1].pace).toBe(5)
    expect(await store.listPendingFlyby()).toEqual([])
  })

  it('supports --force full refresh and --only-run filtering', async () => {
    const existing = createOutdoorRunActivity({
      run_id: 200001,
      name: 'Old Name',
      start_date: '2025-03-20T00:00:00Z',
    })
    const store = new InMemoryActivityStore({
      activities: [existing],
      flybyPoints: createOutdoorRunFlybyPoints(200001),
    })

    const requestedUrls: string[] = []
    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'access-force', refresh_token: 'refresh-force' })
      }
      if (url.includes('/athlete/activities')) {
        return jsonResponse([
          makeStravaActivity({ id: 200001, name: 'Refreshed Run Name', type: 'Run' }),
          makeStravaActivity({ id: 200002, name: 'Backfilled Older Run', type: 'Run', start_date: '2025-03-01T00:00:00Z', start_date_local: '2025-03-01T08:00:00Z' }),
          makeStravaActivity({ id: 200003, name: 'Weekend Cycling', type: 'Ride', sport_type: 'Ride' }),
        ])
      }
      if (url.includes('/activities/200001/streams') || url.includes('/activities/200002/streams')) {
        return jsonResponse({
          time: { data: [0, 60] },
          heartrate: { data: [130, 150] },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.force', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })

    const result = await syncStravaToStore({
      store,
      client,
      force: true,
      onlyRun: true,
      geocoder: null,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      now: () => new Date('2025-04-01T00:00:00Z'),
      logger: silentLogger,
    })

    // Force must NOT send `after`, and sends `before`
    const listUrl = new URL(requestedUrls.find(u => u.includes('/athlete/activities'))!)
    expect(listUrl.searchParams.has('after')).toBe(false)
    expect(listUrl.searchParams.get('before')).toBe(String(toUnixEpochSeconds('2025-04-01T00:00:00Z')))

    expect(result.fetchedActivities).toBe(3)
    expect(result.syncedActivities).toBe(2)
    expect((await store.getActivityById(200001))?.name).toBe('Refreshed Run Name')
    expect((await store.getActivityById(200002))?.name).toBe('Backfilled Older Run')
    expect(await store.getActivityById(200003)).toBeNull()
  })

  it('prunes locally deleted activities and cascades flyby & queue deletions using full remote ID snapshot', async () => {
    const kept = createOutdoorRunActivity({ run_id: 300001, start_date: '2025-03-10T00:00:00Z' })
    const deleted = createOutdoorRunActivity({ run_id: 300002, start_date: '2025-03-12T00:00:00Z' })
    const store = new InMemoryActivityStore({
      activities: [kept, deleted],
      flybyPoints: [
        ...createOutdoorRunFlybyPoints(300001),
        ...createOutdoorRunFlybyPoints(300002),
      ],
    })
    await store.enqueueFlyby([300002])

    const listRequests: URL[] = []
    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'tok', refresh_token: 'ref' })
      }
      if (url.includes('/athlete/activities')) {
        const parsed = new URL(url)
        listRequests.push(parsed)
        if (parsed.searchParams.has('after')) {
          // Incremental window returns no new activities
          return jsonResponse([])
        }
        // Full snapshot for --prune contains only 300001 (300002 was deleted on Strava)
        return jsonResponse([makeStravaActivity({ id: 300001 })])
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.prune', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })

    const result = await syncStravaToStore({
      store,
      client,
      prune: true,
      geocoder: null,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      logger: silentLogger,
    })

    expect(listRequests).toHaveLength(2)
    expect(listRequests[0].searchParams.has('after')).toBe(true)
    expect(listRequests[1].searchParams.has('after')).toBe(false)

    expect(result.prunedActivities).toBe(1)
    expect(await store.getActivityById(300001)).not.toBeNull()
    expect(await store.getActivityById(300002)).toBeNull()
    expect(await store.getFlybyPoints(300002)).toEqual([])
    expect(await store.listPendingFlyby()).toEqual([])
  })

  it('persists rate_limited queue checkpoints on 429 backoff and resumes cleanly on the next sync run', async () => {
    const store = new InMemoryActivityStore()
    const sleepCalls: number[] = []
    let runPhase = 1

    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'tok', refresh_token: 'ref' })
      }
      if (url.includes('/athlete/activities')) {
        if (runPhase === 1) {
          return jsonResponse([
            makeStravaActivity({ id: 400001, start_date: '2025-03-01T00:00:00Z', start_date_local: '2025-03-01T08:00:00Z' }),
            makeStravaActivity({ id: 400002, start_date: '2025-03-02T00:00:00Z', start_date_local: '2025-03-02T08:00:00Z' }),
            makeStravaActivity({ id: 400003, start_date: '2025-03-03T00:00:00Z', start_date_local: '2025-03-03T08:00:00Z' }),
          ])
        }
        // Run 2 has no new activities
        return jsonResponse([])
      }
      if (url.includes('/activities/400001/streams')) {
        return jsonResponse({ time: { data: [0, 30] }, heartrate: { data: [130, 140] } })
      }
      if (url.includes('/activities/400002/streams')) {
        if (runPhase === 1) {
          return new Response('Rate Limit Exceeded', {
            status: 429,
            headers: {
              'X-RateLimit-Limit': '200,2000',
              'X-RateLimit-Usage': '200,1900',
            },
          })
        }
        return jsonResponse({ time: { data: [0, 45] }, heartrate: { data: [145, 155] } })
      }
      if (url.includes('/activities/400003/streams')) {
        return jsonResponse({ time: { data: [0, 60] }, heartrate: { data: [150, 160] } })
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.resume', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })

    // Run 1: 400001 succeeds, 400002 hits persistent 429 across 3 attempts -> checkpointed as rate_limited
    const run1 = await syncStravaToStore({
      store,
      client,
      geocoder: null,
      flybyMaxRetries: 3,
      flybyRequestDelayMs: 0,
      flybyBaseBackoffMs: 1000,
      flybyMaxBackoffMs: 10000,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
      logger: silentLogger,
    })

    expect(run1.syncedActivities).toBe(3)
    expect(run1.flybySyncedActivities).toBe(1)
    expect(run1.stoppedByRateLimit).toBe(true)
    expect(run1.remainingFlybyQueue).toBe(2)
    // 3 attempts -> 2 backoff sleeps: 1000 * 2^0 = 1000ms, 1000 * 2^1 = 2000ms
    expect(sleepCalls).toEqual([1000, 2000])

    const queueAfterRun1 = await store.listPendingFlyby()
    expect(queueAfterRun1.map(e => [e.activityId, e.status])).toEqual([
      [400002, 'rate_limited'],
      [400003, 'pending'],
    ])

    // Run 2: rate limit cleared; resumes 400002 and 400003 from queue without re-upserting activities
    runPhase = 2
    const run2 = await syncStravaToStore({
      store,
      client,
      geocoder: null,
      flybyMaxRetries: 3,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      logger: silentLogger,
    })

    expect(run2.syncedActivities).toBe(0)
    expect(run2.flybySyncedActivities).toBe(2)
    expect(run2.flybyPointsStored).toBe(4)
    expect(run2.remainingFlybyQueue).toBe(0)
    expect(run2.stoppedByRateLimit).toBe(false)
    expect(await store.getFlybyPoints(400002)).toHaveLength(2)
    expect(await store.getFlybyPoints(400003)).toHaveLength(2)
  })

  it('marks non-429 stream errors as failed, skips time-only streams cleanly, and continues queue', async () => {
    const store = new InMemoryActivityStore()

    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'tok', refresh_token: 'ref' })
      }
      if (url.includes('/athlete/activities')) {
        return jsonResponse([
          makeStravaActivity({ id: 500001 }),
          makeStravaActivity({ id: 500002 }),
          makeStravaActivity({ id: 500003 }),
        ])
      }
      if (url.includes('/activities/500001/streams')) {
        return new Response('Internal Server Error', { status: 500 })
      }
      if (url.includes('/activities/500002/streams')) {
        // Time-only stream with no meaningful data -> should mark done with 0 stored
        return jsonResponse({ time: { data: [0, 10, 20] } })
      }
      if (url.includes('/activities/500003/streams')) {
        return jsonResponse({ time: { data: [0, 10] }, heartrate: { data: [140, 145] } })
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.errors', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })

    const result = await syncStravaToStore({
      store,
      client,
      geocoder: null,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      logger: silentLogger,
    })

    expect(result.flybyFailedActivities).toBe(1)
    expect(result.flybySkippedActivities).toBe(1)
    expect(result.flybySyncedActivities).toBe(1)
    expect(result.remainingFlybyQueue).toBe(1)

    const remaining = await store.listPendingFlyby()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].activityId).toBe(500001)
    expect(remaining[0].status).toBe('failed')
    expect(await store.getFlybyPoints(500002)).toEqual([])
    expect(await store.getFlybyPoints(500003)).toHaveLength(2)
  })

  it('never leaks client_secret, refresh_token, or access_token in sync logs or persisted queue errors', async () => {
    const clientSecret = 'secret-client-abc123'
    const refreshToken = 'secret-refresh-def456'
    const accessToken = 'secret-access-ghi789'
    const logs: LogRecord[] = []
    const logger = createLogger('test.sync.redact', { sink: record => logs.push(record) })
    const store = new InMemoryActivityStore()

    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
      }
      if (url.includes('/athlete/activities')) {
        return jsonResponse([makeStravaActivity({ id: 600001 })])
      }
      if (url.includes('/activities/600001/streams')) {
        return new Response(
          `Rate limit hit for client_secret=${clientSecret} refresh_token=${refreshToken} Bearer ${accessToken}`,
          { status: 429, headers: { 'Retry-After': '1' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    }

    const client = new StravaClient({
      clientId: '999',
      clientSecret,
      refreshToken,
      fetch: mockFetch,
      logger,
    })

    await syncStravaToStore({
      store,
      client,
      geocoder: null,
      flybyMaxRetries: 1,
      flybyRequestDelayMs: 0,
      sleep: async () => {},
      logger,
    })

    const queue = await store.listPendingFlyby()
    const combinedOutput = `${JSON.stringify(logs)}\n${JSON.stringify(queue)}`
    expect(combinedOutput).not.toContain(clientSecret)
    expect(combinedOutput).not.toContain(refreshToken)
    expect(combinedOutput).not.toContain(accessToken)
  })

  it('syncStravaActivityToStore syncs a single activity and its streams with 429 retry', async () => {
    const store = new InMemoryActivityStore()
    let streamAttempts = 0
    const sleeps: number[] = []

    const mockFetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ access_token: 'tok', refresh_token: 'ref' })
      }
      if (url.endsWith('/activities/700001')) {
        return jsonResponse(makeStravaActivity({ id: 700001, name: 'Single Sync Run', location_country: 'Japan' }))
      }
      if (url.includes('/activities/700001/streams')) {
        streamAttempts += 1
        if (streamAttempts === 1) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '5' } })
        }
        return jsonResponse({ time: { data: [0, 30] }, heartrate: { data: [142, 158] } })
      }
      return new Response('Not Found', { status: 404 })
    }

    const silentLogger = createLogger('test.single', { sink: () => {} })
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'sec',
      refreshToken: 'ref',
      fetch: mockFetch,
      logger: silentLogger,
    })

    const result = await syncStravaActivityToStore({
      store,
      client,
      activityId: 700001,
      geocoder: null,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      logger: silentLogger,
    })

    expect(result).toEqual({
      activityId: 700001,
      synced: true,
      flybyPointsStored: 2,
    })
    expect(sleeps).toEqual([5000])
    expect((await store.getActivityById(700001))?.name).toBe('Single Sync Run')
    expect(await store.getFlybyPoints(700001)).toHaveLength(2)
  })
})
