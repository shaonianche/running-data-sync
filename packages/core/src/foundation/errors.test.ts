import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  ConfigurationError,
  FlybySyncError,
  ParseError,
  RateLimitError,
  RunningDataSyncError,
  StorageError,
  SyncError,
} from './errors.js'

describe('exception hierarchy', () => {
  it('preserves RunningDataSyncError base inheritance and error names', () => {
    const base = new RunningDataSyncError('base error')
    expect(base).toBeInstanceOf(Error)
    expect(base).toBeInstanceOf(RunningDataSyncError)
    expect(base.name).toBe('RunningDataSyncError')
    expect(base.message).toBe('base error')

    const nonSyncErrors = [
      [new ParseError('bad gpx'), ParseError, 'ParseError'],
      [new StorageError('db locked'), StorageError, 'StorageError'],
      [new ConfigurationError('missing env'), ConfigurationError, 'ConfigurationError'],
    ] as const

    for (const [err, Ctor, name] of nonSyncErrors) {
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(RunningDataSyncError)
      expect(err).toBeInstanceOf(Ctor)
      expect(err).not.toBeInstanceOf(SyncError)
      expect(err.name).toBe(name)
    }
  })

  it('preserves SyncError subtree inheritance', () => {
    const syncErr = new SyncError('sync failed')
    const flybyErr = new FlybySyncError('flyby failed')
    const authErr = new AuthenticationError('unauthorized')
    const rateLimitErr = new RateLimitError('too many requests', 900)

    for (const err of [syncErr, flybyErr, authErr, rateLimitErr]) {
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(RunningDataSyncError)
      expect(err).toBeInstanceOf(SyncError)
    }

    expect(flybyErr).toBeInstanceOf(FlybySyncError)
    expect(authErr).toBeInstanceOf(AuthenticationError)
    expect(rateLimitErr).toBeInstanceOf(RateLimitError)
    expect(rateLimitErr.name).toBe('RateLimitError')
  })

  it('sets RateLimitError.retryAfter accurately including 0 and default null', () => {
    const withSeconds = new RateLimitError('rate limited', 120.5)
    expect(withSeconds.retryAfter).toBe(120.5)

    const withZero = new RateLimitError('retry immediately', 0)
    expect(withZero.retryAfter).toBe(0)

    const withDefault = new RateLimitError('unknown retry window')
    expect(withDefault.retryAfter).toBeNull()
  })

  it('supports standard Error cause option', () => {
    const rootCause = new Error('ECONNRESET')
    const err = new RateLimitError('upstream failed', 60, { cause: rootCause })
    expect(err.cause).toBe(rootCause)
  })
})
