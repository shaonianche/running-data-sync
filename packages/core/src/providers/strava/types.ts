import type {
  ActivityReadRepository,
  ActivityWriteRepository,
  FlybyRepository,
} from '../../contracts/storage.js'
import type { Logger } from '../../foundation/logger.js'
import type { StravaCredentials } from '../../foundation/types.js'

export type FetchLike = typeof fetch
export type SleepFn = (ms: number) => Promise<void>

export type StravaStreamType
  = | 'time'
    | 'latlng'
    | 'altitude'
    | 'heartrate'
    | 'cadence'
    | 'velocity_smooth'
    | 'distance'
    | 'watts'
    | (string & {})

export const DEFAULT_FLYBY_STREAM_TYPES: readonly StravaStreamType[] = [
  'time',
  'latlng',
  'altitude',
  'heartrate',
  'distance',
  'velocity_smooth',
  'cadence',
  'watts',
]

export interface StravaTokenResponse {
  readonly token_type?: string
  readonly access_token: string
  readonly expires_at?: number
  readonly expires_in?: number
  readonly refresh_token?: string
}

export interface StravaMap {
  readonly id?: string
  readonly summary_polyline?: string | null
  readonly polyline?: string | null
}

export type StravaLatLng = readonly [number, number] | { readonly lat: number, readonly lon?: number, readonly lng?: number }

export interface StravaSummaryActivity {
  readonly id: number
  readonly name: string
  readonly distance: number
  readonly moving_time: number
  readonly elapsed_time?: number
  readonly total_elevation_gain?: number | null
  readonly elevation_gain?: number | null
  readonly type?: string | null
  readonly sport_type?: string | null
  readonly subtype?: string | null
  readonly start_date: string
  readonly start_date_local: string
  readonly location_country?: string | null
  readonly start_latlng?: StravaLatLng | readonly number[] | null
  readonly map?: StravaMap | null
  readonly average_speed?: number | null
  readonly average_heartrate?: number | null
  readonly has_heartrate?: boolean
}

export interface StravaDetailedActivity extends StravaSummaryActivity {
  readonly description?: string | null
  readonly calories?: number | null
  readonly device_name?: string | null
}

export interface StravaStream<T = number | readonly [number, number] | null> {
  readonly type?: StravaStreamType
  readonly data: readonly T[]
  readonly series_type?: string
  readonly original_size?: number
  readonly resolution?: 'low' | 'medium' | 'high' | (string & {})
}

export type StravaStreamsMap = Partial<Record<StravaStreamType, StravaStream<unknown>>> & {
  time?: StravaStream<number>
  latlng?: StravaStream<readonly [number, number] | null>
  altitude?: StravaStream<number | null>
  heartrate?: StravaStream<number | null>
  cadence?: StravaStream<number | null>
  velocity_smooth?: StravaStream<number | null>
  distance?: StravaStream<number | null>
  watts?: StravaStream<number | null>
}

export interface StravaRateLimitInfo {
  readonly shortTermLimit: number | null
  readonly dailyLimit: number | null
  readonly shortTermUsage: number | null
  readonly dailyUsage: number | null
  readonly retryAfterSeconds: number | null
}

export type StravaUploadDataType = 'fit' | 'fit.gz' | 'tcx' | 'tcx.gz' | 'gpx' | 'gpx.gz'

export interface StravaUploadOptions {
  readonly content: Uint8Array | string
  readonly filename: string
  readonly dataType: StravaUploadDataType
  readonly forceToRun?: boolean
  readonly activityType?: string
  readonly name?: string
  readonly description?: string
  readonly externalId?: string
  readonly maxRetries?: number
}

export interface StravaUploadFileOptions {
  readonly filePath: string
  readonly dataType: StravaUploadDataType
  readonly forceToRun?: boolean
  readonly activityType?: string
  readonly name?: string
  readonly description?: string
  readonly externalId?: string
  readonly maxRetries?: number
}

export interface StravaUploadResponse {
  readonly id: number
  readonly id_str?: string
  readonly external_id?: string | null
  readonly error?: string | null
  readonly status?: string
  readonly activity_id?: number | null
}

export interface ListStravaActivitiesOptions {
  /** Unix timestamp in seconds or Date / ISO string. */
  readonly after?: number | Date | string
  /** Unix timestamp in seconds or Date / ISO string. */
  readonly before?: number | Date | string
  /** Items per page (Strava max is 200). */
  readonly perPage?: number
  /** Starting page (1-indexed). */
  readonly startPage?: number
  /** Optional maximum total number of activities to return. */
  readonly limit?: number
  readonly maxRetries?: number
}

export interface GetStravaStreamsOptions {
  readonly keys?: readonly StravaStreamType[]
  readonly resolution?: 'low' | 'medium' | 'high'
  readonly maxRetries?: number
}

export interface StravaClientOptions extends StravaCredentials {
  readonly accessToken?: string
  readonly apiBaseUrl?: string
  readonly oauthTokenUrl?: string
  readonly fetch?: FetchLike
  readonly sleep?: SleepFn
  readonly now?: () => Date
  readonly logger?: Logger
  /** Maximum retry attempts on HTTP 429 inside StravaClient methods (default: 2). */
  readonly maxRateLimitRetries?: number
  /** Base backoff delay in ms when Retry-After header is absent (default: 1000). */
  readonly baseBackoffMs?: number
  /** Maximum backoff delay in ms (default: 60_000). */
  readonly maxBackoffMs?: number
  /** Default request timeout in ms (default: 30_000). */
  readonly timeoutMs?: number
}

export interface ReverseGeocoder {
  reverseGeocode: (lat: number, lon: number) => Promise<string>
}

export interface NominatimGeocoderOptions {
  readonly endpoint?: string
  readonly userAgent?: string
  readonly language?: string
  readonly timeoutMs?: number
  readonly concurrency?: number
  readonly fetch?: FetchLike
  readonly logger?: Logger
}

export type StravaSyncStore = ActivityReadRepository & ActivityWriteRepository & FlybyRepository

export interface SyncStravaOptions {
  readonly store: StravaSyncStore
  readonly client: {
    refreshAccessToken: () => Promise<StravaTokenResponse>
    listActivities: (options?: ListStravaActivitiesOptions) => Promise<StravaSummaryActivity[]>
    getActivity: (activityId: number, options?: { readonly maxRetries?: number }) => Promise<StravaDetailedActivity>
    getActivityStreams: (activityId: number, options?: GetStravaStreamsOptions) => Promise<StravaStreamsMap>
    redactSecrets?: (text: string) => string
  }
  readonly force?: boolean
  readonly onlyRun?: boolean
  readonly prune?: boolean
  readonly geocoder?: ReverseGeocoder | null
  readonly geocoderConcurrency?: number
  readonly streamTypes?: readonly StravaStreamType[]
  readonly flybyMaxRetries?: number
  readonly flybyRequestDelayMs?: number
  readonly flybyBaseBackoffMs?: number
  readonly flybyMaxBackoffMs?: number
  readonly sleep?: SleepFn
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface SyncStravaResult {
  readonly fetchedActivities: number
  readonly syncedActivities: number
  readonly prunedActivities: number
  readonly enqueuedFlyby: number
  readonly flybySyncedActivities: number
  readonly flybySkippedActivities: number
  readonly flybyFailedActivities: number
  readonly flybyPointsStored: number
  readonly remainingFlybyQueue: number
  readonly stoppedByRateLimit: boolean
}

export interface SyncStravaActivityOptions {
  readonly store: StravaSyncStore
  readonly client: SyncStravaOptions['client']
  readonly activityId: number
  readonly force?: boolean
  readonly geocoder?: ReverseGeocoder | null
  readonly streamTypes?: readonly StravaStreamType[]
  readonly flybyMaxRetries?: number
  readonly flybyBaseBackoffMs?: number
  readonly flybyMaxBackoffMs?: number
  readonly sleep?: SleepFn
  readonly logger?: Logger
}

export interface SyncStravaActivityResult {
  readonly activityId: number
  readonly synced: boolean
  readonly flybyPointsStored: number
}
