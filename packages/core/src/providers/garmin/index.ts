export {
  clearOAuthConsumerCache,
  deserializeGarminSecret,
  exchangeOAuth1ForOAuth2,
  formatOAuth2AuthorizationHeader,
  GARMIN_OAUTH_CONSUMER_URL,
  GARMIN_OAUTH_USER_AGENT,
  GARMIN_SSO_CLIENT_ID,
  GARMIN_SSO_USER_AGENT,
  getGarminSecret,
  getGarminUrls,
  isOAuth2TokenExpired,
  loginGarmin,
  resolveGarminAccount,
  resolveGarminDomain,
  resolveOAuthConsumer,
  serializeGarminSecret,
} from './auth.js'
export type { ExchangeOAuth2Options } from './auth.js'
export { GarminClient } from './client.js'
export {
  extractGarminSummaryExtensions,
  runWithConcurrency,
  syncGarminToStore,
} from './download.js'
export {
  computeActivityContentHash,
  extractGarminTypeKey,
  extractRemoteActivityIdFromUploadResult,
  findMatchingGarminActivity,
  getStravaTypeAliases,
  parseGarminDurationSeconds,
  parseGarminStartTime,
  preferDurationMatch,
} from './matching.js'
export {
  createOAuth1AuthorizationHeader,
  percentEncode,
} from './oauth1.js'
export type { OAuth1SignOptions } from './oauth1.js'
export {
  isGarminSensitiveKey,
  redactGarminData,
  redactGarminMessage,
  redactHeaders,
  wrapGarminLogger,
} from './redaction.js'
export {
  getVendorStatus,
  resolveVendorAccount,
} from './status.js'
export {
  reconcileGarmin,
  syncStoreToGarmin,
} from './sync.js'
export {
  DEFAULT_DISTANCE_TOLERANCE_M,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DURATION_TOLERANCE_SEC,
  DEFAULT_GARMIN_PAGE_SIZE,
  DEFAULT_MATCH_WINDOW_SEC,
  GARMIN_SYNCED_STATUSES,
  GARMIN_VENDOR,
  GarminAuthenticationError,
  GarminConnectionError,
  GarminHttpError,
  GarminMfaRequiredError,
  GarminRateLimitError,
  SUPPORTED_GARMIN_UPLOAD_EXTS,
} from './types.js'
export type {
  GarminAccount,
  GarminActivityRecord,
  GarminActivitySummary,
  GarminActivityTypeDTO,
  GarminClientFactoryOptions,
  GarminClientLike,
  GarminClientOptions,
  GarminDomain,
  GarminFetchFn,
  GarminLoginResult,
  GarminMatchOptions,
  GarminOAuth1Token,
  GarminOAuth2Token,
  GarminOAuthConsumer,
  GarminSecretBundle,
  GarminSummaryDTO,
  GarminUploadResult,
  GarminUrls,
  GetGarminSecretOptions,
  ReconcileGarminOptions,
  ReconcileGarminResult,
  SyncGarminToStoreFailure,
  SyncGarminToStoreOptions,
  SyncGarminToStoreResult,
  SyncStoreToGarminFailure,
  SyncStoreToGarminOptions,
  SyncStoreToGarminResult,
  UploadFileFailure,
  UploadFilesToGarminOptions,
  UploadFilesToGarminResult,
  VendorStatusOptions,
  VendorStatusSummary,
} from './types.js'
export {
  collectActivityFiles,
  resolveGarminClient,
  uploadFilesToGarmin,
} from './upload-files.js'
