export class RunningDataSyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class SyncError extends RunningDataSyncError {}

export class RateLimitError extends SyncError {
  readonly retryAfter: number | null

  constructor(message: string, retryAfter: number | null = null, options?: ErrorOptions) {
    super(message, options)
    this.retryAfter = retryAfter
  }
}

export class FlybySyncError extends SyncError {}

export class AuthenticationError extends SyncError {}

export class ParseError extends RunningDataSyncError {}

export class StorageError extends RunningDataSyncError {}

export class ConfigurationError extends RunningDataSyncError {}
