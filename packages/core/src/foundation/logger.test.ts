import type { LogRecord } from './logger.js'
import { describe, expect, it } from 'vitest'
import {
  createLogger,
  isSensitiveKey,
  REDACTED_VALUE,
  redactSensitiveData,
  redactSensitiveMessage,
  SENSITIVE_KEYS,
} from './logger.js'

describe('sensitive log redaction', () => {
  it('recognizes all required sensitive keys across snake_case, camelCase, and UPPER_CASE', () => {
    const requiredKeys = [
      'client_id',
      'client_secret',
      'refresh_token',
      'access_token',
      'garmin_password',
      'garmin_secret',
      'garmin_secret_cn',
      'duckdb_encryption_key',
    ]

    for (const key of requiredKeys) {
      expect(SENSITIVE_KEYS).toContain(key)
      expect(isSensitiveKey(key)).toBe(true)
      expect(isSensitiveKey(key.toUpperCase())).toBe(true)
    }

    expect(isSensitiveKey('clientSecret')).toBe(true)
    expect(isSensitiveKey('garminSecretCn')).toBe(true)
    expect(isSensitiveKey('duckdbEncryptionKey')).toBe(true)
    expect(isSensitiveKey('strava_refresh_token')).toBe(true)
    expect(isSensitiveKey('activity_id')).toBe(false)
    expect(isSensitiveKey('distance')).toBe(false)
  })

  it('redacts nested objects, arrays, maps, errors, and handles circular refs', () => {
    const circular: Record<string, unknown> = {
      activityId: 1001,
      client_id: '12345',
      nested: {
        client_secret: 'secret-val',
        refresh_token: 'refresh-val',
        access_token: 'access-val',
        garmin_password: 'pw',
        garmin_secret: 'gs-com',
        garmin_secret_cn: 'gs-cn',
        duckdb_encryption_key: 'enc-key',
        safe: 'visible',
      },
      items: [
        { accessToken: 'tok-1', name: 'Morning Run' },
      ],
      err: new Error('Auth failed with refresh_token=top-secret'),
    }
    circular.self = circular

    const redacted = redactSensitiveData(circular)
    expect(redacted.activityId).toBe(1001)
    expect(redacted.client_id).toBe(REDACTED_VALUE)
    expect(redacted.nested).toEqual({
      client_secret: REDACTED_VALUE,
      refresh_token: REDACTED_VALUE,
      access_token: REDACTED_VALUE,
      garmin_password: REDACTED_VALUE,
      garmin_secret: REDACTED_VALUE,
      garmin_secret_cn: REDACTED_VALUE,
      duckdb_encryption_key: REDACTED_VALUE,
      safe: 'visible',
    })
    expect(redacted.items).toEqual([
      { accessToken: REDACTED_VALUE, name: 'Morning Run' },
    ])
    expect((redacted.err as Error).message).toBe('Auth failed with refresh_token=***')
    expect(redacted.self).toBe('[Circular]')
  })

  it('redacts quoted, unquoted, and CLI flag values in messages without corrupting prose', () => {
    const jsonMsg = '{"client_id": "123", "garmin_secret_cn": "cn-token", "name": "Run"}'
    expect(redactSensitiveMessage(jsonMsg)).toBe(
      '{"client_id": "***", "garmin_secret_cn": "***", "name": "Run"}',
    )

    const dictMsg = 'payload={\'client_secret\': \'abc\', \'duckdb_encryption_key\': \'key999\'}'
    expect(redactSensitiveMessage(dictMsg)).toBe(
      'payload={\'client_secret\': \'***\', \'duckdb_encryption_key\': \'***\'}',
    )

    const queryAndCli = 'url?access_token=tok_abc&limit=10 --garmin-secret mySecret --garmin-password "p w"'
    expect(redactSensitiveMessage(queryAndCli)).toBe(
      'url?access_token=***&limit=10 --garmin-secret *** --garmin-password "***"',
    )

    const prose = 'Missing client_id in configuration'
    expect(redactSensitiveMessage(prose)).toBe('Missing client_id in configuration')
  })

  it('creates a logger that filters by level and redacts messages and data', () => {
    const records: LogRecord[] = []
    const logger = createLogger('sync', {
      level: 'info',
      sink: record => records.push(record),
    })

    logger.debug('hidden debug message')
    logger.info('Connected with client_secret=supersecret', {
      garmin_secret_cn: 'secret-cn',
      count: 42,
    })

    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('info')
    expect(records[0]?.logger).toBe('sync')
    expect(records[0]?.message).toBe('Connected with client_secret=***')
    expect(records[0]?.data).toEqual({
      garmin_secret_cn: '***',
      count: 42,
    })
  })
})
