import type {
  ActivityFileFormat,
  ActivityFormatPort,
  ActivityQueryFilter,
  ActivityStorePort,
  FitBuildOptions,
} from '../../contracts/index.js'
import type {
  GarminCredentials,
  LoadEnvConfigOptions,
  Logger,
  VendorSyncRow,
} from '../../foundation/index.js'
import {
  AuthenticationError,
  RateLimitError,
  SyncError,
} from '../../foundation/index.js'

export type GarminDomain = 'garmin.com' | 'garmin.cn'
export type GarminAccount = 'garmin_com' | 'garmin_cn'
export type GarminFetchFn = typeof globalThis.fetch

export const GARMIN_VENDOR = 'garmin' as const
export const GARMIN_SYNCED_STATUSES: ReadonlySet<string> = new Set(['synced', 'skipped_exists'])

export const DEFAULT_MATCH_WINDOW_SEC = 300
export const DEFAULT_DISTANCE_TOLERANCE_M = 50
export const DEFAULT_DURATION_TOLERANCE_SEC = 120
export const DEFAULT_DOWNLOAD_CONCURRENCY = 10
export const DEFAULT_GARMIN_PAGE_SIZE = 100

export const SUPPORTED_GARMIN_UPLOAD_EXTS: ReadonlySet<string> = new Set(['.fit', '.gpx', '.tcx'])

/**
 * `garth`-compatible OAuth1 token payload serialized in `GARMIN_SECRET` / `GARMIN_SECRET_CN`.
 */
export interface GarminOAuth1Token {
  readonly oauth_token: string
  readonly oauth_token_secret: string
  readonly mfa_token?: string | null
  readonly mfa_expiration_timestamp?: string | null
  readonly domain?: string | null
}

/**
 * `garth`-compatible OAuth2 token payload serialized in `GARMIN_SECRET` / `GARMIN_SECRET_CN`.
 */
export interface GarminOAuth2Token {
  readonly scope: string
  readonly jti: string
  readonly token_type: string
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
  readonly expires_at: number
  readonly refresh_token_expires_in: number
  readonly refresh_token_expires_at: number
}

/**
 * Deserialized Garmin `garth` session bundle.
 */
export interface GarminSecretBundle {
  readonly oauth1Token: GarminOAuth1Token
  readonly oauth2Token: GarminOAuth2Token
  readonly domain: GarminDomain
}

/**
 * OAuth1 consumer credentials used to sign Garmin OAuth1 preauthorized/exchange requests.
 */
export interface GarminOAuthConsumer {
  readonly consumer_key: string
  readonly consumer_secret: string
}

/**
 * Resolved Garmin Connect & SSO URLs for COM or CN domains.
 */
export interface GarminUrls {
  readonly domain: GarminDomain
  readonly ssoOrigin: string
  readonly ssoBase: string
  readonly modernBase: string
  readonly signinUrl: string
  readonly uploadUrl: string
  readonly activityUrlTemplate: string
}

export interface GarminActivityTypeDTO {
  readonly typeKey?: string
  readonly [key: string]: unknown
}

/**
 * Raw Garmin Connect activity list record.
 */
export interface GarminActivityRecord {
  readonly activityId?: number | string
  readonly activityName?: string
  readonly startTimeGMT?: string
  readonly distance?: number | null
  readonly duration?: number | null
  readonly elapsedDuration?: number | null
  readonly movingDuration?: number | null
  readonly durationInSeconds?: number | null
  readonly elapsedDurationInSeconds?: number | null
  readonly movingDurationInSeconds?: number | null
  readonly activityType?: GarminActivityTypeDTO | null
  readonly activityTypeDTO?: GarminActivityTypeDTO | null
  readonly averageHR?: number | null
  readonly averageSpeed?: number | null
  readonly [key: string]: unknown
}

export interface GarminSummaryDTO {
  readonly distance?: number | null
  readonly averageHR?: number | null
  readonly averageSpeed?: number | null
  readonly [key: string]: unknown
}

/**
 * Raw Garmin Connect single-activity summary response.
 */
export interface GarminActivitySummary {
  readonly activityId?: number | string
  readonly activityName?: string
  readonly summaryDTO?: GarminSummaryDTO | null
  readonly [key: string]: unknown
}

/**
 * Normalized result of uploading an activity file to Garmin Connect.
 */
export interface GarminUploadResult {
  readonly status: number
  readonly detailedImportResult: Record<string, unknown> | null
  readonly remoteActivityId: number | null
  readonly duplicate: boolean
}

export interface GarminClientOptions {
  readonly secretString: string
  readonly isCn?: boolean
  readonly domain?: GarminDomain
  readonly onlyRunning?: boolean
  readonly fetch?: GarminFetchFn
  readonly oauthConsumer?: GarminOAuthConsumer
  readonly oauthConsumerUrl?: string
  readonly now?: () => number
  readonly logger?: Logger
  readonly onTokenRefreshed?: (secretString: string, oauth2Token: GarminOAuth2Token) => void
}

export interface GetGarminSecretOptions {
  readonly email?: string
  readonly password?: string
  readonly isCn?: boolean
  readonly mfaCode?: string
  readonly promptMfa?: (mfaMethod: string) => Promise<string> | string
  readonly fetch?: GarminFetchFn
  readonly oauthConsumer?: GarminOAuthConsumer
  readonly oauthConsumerUrl?: string
  readonly envOptions?: LoadEnvConfigOptions
  readonly now?: () => number
  readonly logger?: Logger
}

export interface GarminLoginResult {
  readonly secretString: string
  readonly oauth1Token: GarminOAuth1Token
  readonly oauth2Token: GarminOAuth2Token
  readonly domain: GarminDomain
}

export interface GarminMatchOptions {
  readonly matchWindowSec?: number
  readonly distanceToleranceM?: number
  readonly durationToleranceSec?: number
  readonly reservedActivityIds?: ReadonlySet<number>
}

export interface GarminClientFactoryOptions {
  readonly client?: GarminClientLike
  readonly credentials?: GarminCredentials
  readonly fetch?: GarminFetchFn
  readonly oauthConsumer?: GarminOAuthConsumer
  readonly oauthConsumerUrl?: string
  readonly now?: () => number
  readonly logger?: Logger
}

export interface GarminClientLike {
  readonly domain: GarminDomain
  readonly account: GarminAccount
  getActivities: (start?: number, limit?: number, onlyRunning?: boolean) => Promise<GarminActivityRecord[]>
  fetchAllActivities: (options?: {
    readonly pageSize?: number
    readonly maxPages?: number | null
    readonly onlyRunning?: boolean
  }) => Promise<GarminActivityRecord[]>
  getActivitySummary: (activityId: number | string) => Promise<GarminActivitySummary>
  deleteActivity: (activityId: number | string) => Promise<void>
  downloadActivity: (activityId: number | string, format?: ActivityFileFormat) => Promise<Uint8Array>
  uploadActivity: (filename: string, buffer: Uint8Array) => Promise<GarminUploadResult>
}

export interface ReconcileGarminOptions extends GarminClientFactoryOptions {
  readonly store: ActivityStorePort
  readonly filter?: ActivityQueryFilter
  readonly matchWindowSec?: number
  readonly distanceToleranceM?: number
  readonly durationToleranceSec?: number
}

export interface ReconcileGarminResult {
  readonly account: GarminAccount
  readonly totalLocal: number
  readonly totalRemote: number
  readonly matched: number
  readonly missingRemote: number
  readonly unchanged: number
}

export interface SyncStoreToGarminOptions extends GarminClientFactoryOptions {
  readonly store: ActivityStorePort
  readonly formatPort: ActivityFormatPort
  readonly filter?: ActivityQueryFilter
  readonly useFakeGarminDevice?: boolean
  readonly fixHr?: boolean
  readonly force?: boolean
  readonly matchWindowSec?: number
  readonly distanceToleranceM?: number
  readonly durationToleranceSec?: number
  readonly fitBuildOptions?: FitBuildOptions
}

export interface SyncStoreToGarminFailure {
  readonly activityId: number
  readonly error: string
}

export interface SyncStoreToGarminResult {
  readonly account: GarminAccount
  readonly totalLocal: number
  readonly deletedRemote: number
  readonly synced: number
  readonly skippedUnchanged: number
  readonly skippedExists: number
  readonly conflicts: number
  readonly failed: number
  readonly noFlybyTypeCounts: Readonly<Record<string, number>>
  readonly failures: readonly SyncStoreToGarminFailure[]
}

export interface VendorStatusOptions {
  readonly store: ActivityStorePort
  readonly vendor?: string
  readonly account?: string
  readonly isCn?: boolean
  readonly retryFailed?: boolean
  readonly logger?: Logger
}

export interface VendorStatusSummary {
  readonly vendor: string
  readonly account: string | null
  readonly total: number
  readonly retriedCount: number
  readonly counts: Readonly<Record<string, number>>
  readonly rows: readonly VendorSyncRow[]
}

export interface UploadFilesToGarminOptions extends GarminClientFactoryOptions {
  readonly paths: readonly string[]
  readonly recursive?: boolean
  readonly throwOnError?: boolean
}

export interface UploadFileFailure {
  readonly filePath: string
  readonly error: string
}

export interface UploadFilesToGarminResult {
  readonly account: GarminAccount
  readonly totalFiles: number
  readonly uploaded: readonly string[]
  readonly duplicates: readonly string[]
  readonly failures: readonly UploadFileFailure[]
}

export interface SyncGarminToStoreOptions extends GarminClientFactoryOptions {
  readonly store: ActivityStorePort
  readonly formatPort: ActivityFormatPort
  readonly fileType?: ActivityFileFormat
  readonly onlyRunning?: boolean
  readonly concurrency?: number
  readonly pageSize?: number
  readonly maxPages?: number | null
  readonly outputDirs?: {
    readonly gpxDir?: string
    readonly tcxDir?: string
    readonly fitDir?: string
  }
}

export interface SyncGarminToStoreFailure {
  readonly activityId: number
  readonly error: string
}

export interface SyncGarminToStoreResult {
  readonly account: GarminAccount
  readonly fileType: ActivityFileFormat
  readonly fetched: number
  readonly skippedExisting: number
  readonly downloaded: number
  readonly ingested: number
  readonly flybyPointsStored: number
  readonly failures: readonly SyncGarminToStoreFailure[]
}

export class GarminAuthenticationError extends AuthenticationError {}

export class GarminMfaRequiredError extends GarminAuthenticationError {
  readonly mfaMethod: string

  constructor(message: string, mfaMethod = 'email', options?: ErrorOptions) {
    super(message, options)
    this.mfaMethod = mfaMethod
  }
}

export class GarminConnectionError extends SyncError {}

export class GarminRateLimitError extends RateLimitError {}

export class GarminHttpError extends SyncError {
  readonly statusCode: number

  constructor(message: string, statusCode: number, options?: ErrorOptions) {
    super(message, options)
    this.statusCode = statusCode
  }
}
