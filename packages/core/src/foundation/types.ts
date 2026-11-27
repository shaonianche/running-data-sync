/**
 * Canonical activity record stored in DuckDB and exported to activities.json / Parquet.
 */
export interface Activity {
  run_id: number
  name: string
  distance: number
  moving_time: number
  elapsed_time?: number
  type: string
  subtype: string
  start_date: string
  start_date_local: string
  location_country?: string | null
  summary_polyline?: string | null
  average_heartrate?: number | null
  average_speed: number
  elevation_gain: number | null
  streak?: number
}

/**
 * Per-second / sampled GPS & telemetry point stored in activities_flyby.
 */
export interface FlybyPoint {
  activity_id: number
  time_offset: number
  lat: number | null
  lng: number | null
  alt: number | null
  pace: number
  hr: number | null
  distance: number | null
  cadence: number | null
  watts: number | null
}

export type VendorSyncStatus = 'pending' | 'synced' | 'skipped_exists' | 'failed' | 'conflict' | (string & {})

/**
 * Per-activity vendor synchronization tracking row in vendor_activity_sync.
 */
export interface VendorSyncRow {
  activityId: number
  vendor: string
  account: string
  status: VendorSyncStatus
  remoteActivityId: number | null
  contentHash: string | null
  lastError: string | null
  attemptCount: number
  nextRetryAt: string | Date | null
  uploadedAt: string | Date | null
  lastVerifiedAt: string | Date | null
}

export interface StravaCredentials {
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
}

export interface GarminCredentials {
  readonly secretString: string
  readonly isCn: boolean
}

export interface SyncConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
  readonly onlyRun?: boolean
  readonly forceSync?: boolean
}

export interface CredentialInput {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly refreshToken?: string
  readonly garminSecret?: string
  readonly isCn?: boolean
}

export interface RuntimeConfig {
  readonly projectRoot: string
  readonly dataRoot: string
  readonly sqlFile: string
  readonly fitDir: string
  readonly tcxDir: string
  readonly gpxDir: string
  readonly dbDir: string
  readonly jsonFile: string
  readonly assetsDir: string
}

export interface EnvConfig {
  stravaClientId?: string
  stravaClientSecret?: string
  stravaRefreshToken?: string
  garminEmail?: string
  garminPassword?: string
  garminIsCn?: string
  garminSecret?: string
  garminSecretCn?: string
  duckdbEncryptionKey?: string
}
