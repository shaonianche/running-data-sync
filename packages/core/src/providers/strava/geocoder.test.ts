import type { FetchLike } from './types.js'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../foundation/logger.js'
import {
  DEFAULT_NOMINATIM_USER_AGENT,
  NominatimGeocoder,
  runWithConcurrencyLimit,
} from './geocoder.js'

describe('nominatimGeocoder', () => {
  it('calls Nominatim reverse endpoint with required User-Agent and language headers and returns country', async () => {
    const calls: Array<{ url: string, userAgent: string | null, acceptLanguage: string | null }> = []
    const mockFetch: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        userAgent: headers.get('user-agent'),
        acceptLanguage: headers.get('accept-language'),
      })
      return new Response(JSON.stringify({ address: { country: '中国' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const geocoder = new NominatimGeocoder({
      fetch: mockFetch,
      logger: createLogger('test.geocoder', { sink: () => {} }),
    })

    const country = await geocoder.reverseGeocode(39.94401, 116.48201)
    expect(country).toBe('中国')
    expect(calls).toHaveLength(1)
    expect(calls[0].userAgent).toBe(DEFAULT_NOMINATIM_USER_AGENT)
    expect(calls[0].acceptLanguage).toBe('zh-CN')

    const parsed = new URL(calls[0].url)
    expect(parsed.origin + parsed.pathname).toBe('https://nominatim.openstreetmap.org/reverse')
    expect(parsed.searchParams.get('lat')).toBe('39.94401')
    expect(parsed.searchParams.get('lon')).toBe('116.48201')
    expect(parsed.searchParams.get('accept-language')).toBe('zh-CN')
  })

  it('caches results by 4-decimal rounded coordinates and deduplicates concurrent in-flight requests', async () => {
    let fetchCount = 0
    const mockFetch: FetchLike = async () => {
      fetchCount += 1
      await new Promise(resolve => setTimeout(resolve, 15))
      return new Response(JSON.stringify({ address: { country: '日本' } }), { status: 200 })
    }

    const geocoder = new NominatimGeocoder({
      fetch: mockFetch,
      logger: createLogger('test.geocoder', { sink: () => {} }),
    })

    const [a, b] = await Promise.all([
      geocoder.reverseGeocode(35.67621, 139.65031),
      geocoder.reverseGeocode(35.67624, 139.65034),
    ])
    const c = await geocoder.reverseGeocode(35.6762, 139.6503)

    expect(a).toBe('日本')
    expect(b).toBe('日本')
    expect(c).toBe('日本')
    expect(fetchCount).toBe(1)
    expect(geocoder.cacheSize).toBe(1)
  })

  it('enforces bounded concurrency across distinct coordinates', async () => {
    let active = 0
    let maxActive = 0

    const mockFetch: FetchLike = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
      return new Response(JSON.stringify({ address: { country: '中国' } }), { status: 200 })
    }

    const geocoder = new NominatimGeocoder({
      concurrency: 3,
      fetch: mockFetch,
      logger: createLogger('test.geocoder', { sink: () => {} }),
    })

    const coords = Array.from({ length: 9 }, (_, i) => [30 + i * 0.1, 120 + i * 0.1] as const)
    const results = await Promise.all(coords.map(([lat, lon]) => geocoder.reverseGeocode(lat, lon)))

    expect(results).toHaveLength(9)
    expect(results.every(r => r === '中国')).toBe(true)
    expect(maxActive).toBe(3)
  })

  it('falls back to empty string on timeout without throwing', async () => {
    const mockFetch: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })

    const geocoder = new NominatimGeocoder({
      timeoutMs: 25,
      fetch: mockFetch,
      logger: createLogger('test.geocoder', { sink: () => {} }),
    })

    const result = await geocoder.reverseGeocode(39.9, 116.4)
    expect(result).toBe('')
  })

  it('falls back to empty string on HTTP errors, network failures, or invalid coordinates', async () => {
    let fetchCalls = 0
    const mockFetch: FetchLike = async (input) => {
      fetchCalls += 1
      const url = String(input)
      if (url.includes('lat=10')) {
        return new Response('Service Unavailable', { status: 503 })
      }
      if (url.includes('lat=20')) {
        throw new Error('ECONNRESET')
      }
      return new Response(JSON.stringify({ address: {} }), { status: 200 })
    }

    const geocoder = new NominatimGeocoder({
      fetch: mockFetch,
      logger: createLogger('test.geocoder', { sink: () => {} }),
    })

    expect(await geocoder.reverseGeocode(Number.NaN, 116.4)).toBe('')
    expect(await geocoder.reverseGeocode(95, 116.4)).toBe('')
    expect(fetchCalls).toBe(0)

    expect(await geocoder.reverseGeocode(10, 100)).toBe('')
    expect(await geocoder.reverseGeocode(20, 100)).toBe('')
    expect(await geocoder.reverseGeocode(30, 100)).toBe('')
    expect(fetchCalls).toBe(3)
  })

  it('runWithConcurrencyLimit preserves result order', async () => {
    const output = await runWithConcurrencyLimit([30, 10, 20, 5], 2, async (delay, idx) => {
      await new Promise(resolve => setTimeout(resolve, delay))
      return `${idx}:${delay}`
    })
    expect(output).toEqual(['0:30', '1:10', '2:20', '3:5'])
  })
})
