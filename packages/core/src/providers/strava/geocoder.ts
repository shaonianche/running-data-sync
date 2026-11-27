import type { Logger } from '../../foundation/logger.js'
import type { FetchLike, NominatimGeocoderOptions, ReverseGeocoder } from './types.js'
import { createLogger } from '../../foundation/logger.js'

export const DEFAULT_NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'
export const DEFAULT_NOMINATIM_USER_AGENT = 'running-data-sync'
export const DEFAULT_NOMINATIM_LANGUAGE = 'zh-CN'
export const DEFAULT_NOMINATIM_TIMEOUT_MS = 10_000
export const DEFAULT_NOMINATIM_CONCURRENCY = 5

interface NominatimReverseResponse {
  readonly address?: {
    readonly country?: string
  }
}

export function formatGeocodeCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180
}

/**
 * Lightweight Nominatim reverse geocoder using Node.js native fetch.
 * Provides coordinate-rounded caching, bounded concurrency, timeouts,
 * and graceful fallback to an empty string on any failure.
 */
export class NominatimGeocoder implements ReverseGeocoder {
  private readonly endpoint: string
  private readonly userAgent: string
  private readonly language: string
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly fetchImpl: FetchLike
  private readonly logger: Logger
  private readonly cache = new Map<string, string>()
  private readonly inFlight = new Map<string, Promise<string>>()
  private activeRequests = 0
  private readonly waiters: Array<() => void> = []

  constructor(options: NominatimGeocoderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_NOMINATIM_ENDPOINT
    this.userAgent = options.userAgent ?? DEFAULT_NOMINATIM_USER_AGENT
    this.language = options.language ?? DEFAULT_NOMINATIM_LANGUAGE
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_NOMINATIM_TIMEOUT_MS)
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_NOMINATIM_CONCURRENCY))
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger ?? createLogger('strava.geocoder')
  }

  get cacheSize(): number {
    return this.cache.size
  }

  clearCache(): void {
    this.cache.clear()
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.concurrency) {
      this.activeRequests += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    this.activeRequests += 1
  }

  private releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    const next = this.waiters.shift()
    if (next) {
      next()
    }
  }

  async reverseGeocode(lat: number, lon: number): Promise<string> {
    if (!isValidCoordinate(lat, lon)) {
      return ''
    }

    const cacheKey = formatGeocodeCacheKey(lat, lon)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    const existingPromise = this.inFlight.get(cacheKey)
    if (existingPromise) {
      return existingPromise
    }

    const requestPromise = this.fetchCountry(lat, lon, cacheKey)
    this.inFlight.set(cacheKey, requestPromise)
    try {
      return await requestPromise
    }
    finally {
      this.inFlight.delete(cacheKey)
    }
  }

  private async fetchCountry(lat: number, lon: number, cacheKey: string): Promise<string> {
    await this.acquireSlot()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const url = new URL(this.endpoint)
      url.searchParams.set('format', 'jsonv2')
      url.searchParams.set('lat', String(lat))
      url.searchParams.set('lon', String(lon))
      url.searchParams.set('accept-language', this.language)

      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'application/json',
          'Accept-Language': this.language,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        this.logger.debug('Nominatim reverse geocode returned non-OK status', {
          status: response.status,
          cacheKey,
        })
        this.cache.set(cacheKey, '')
        return ''
      }

      const payload = await response.json() as NominatimReverseResponse
      const rawCountry = payload?.address?.country
      const country = typeof rawCountry === 'string' ? rawCountry.trim() : ''
      this.cache.set(cacheKey, country)
      return country
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.debug('Nominatim reverse geocode failed; falling back to empty string', {
        cacheKey,
        reason,
      })
      this.cache.set(cacheKey, '')
      return ''
    }
    finally {
      clearTimeout(timer)
      this.releaseSlot()
    }
  }
}

export async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length))
  const results = Array.from<R>({ length: items.length })
  let nextIndex = 0

  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex
      nextIndex += 1
      results[current] = await worker(items[current], current)
    }
  })

  await Promise.all(runners)
  return results
}
