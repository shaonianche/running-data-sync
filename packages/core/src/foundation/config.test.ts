import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadEnvConfig,
  parseEnvFile,
  resolveGarminCredentials,
  resolveRuntimeConfig,
  resolveStravaCredentials,
} from './config.js'
import { BASE_TIMEZONE, STRAVA_GARMIN_TYPE_DICT, UTC_TIMEZONE } from './constants.js'
import { ConfigurationError } from './errors.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-config-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('parseEnvFile', () => {
  it('parses comments, quotes, export prefixes, and values containing =', () => {
    const parsed = parseEnvFile([
      '# comment line',
      '',
      'STRAVA_CLIENT_ID=12345',
      'export STRAVA_CLIENT_SECRET="sec=ret=val"',
      'GARMIN_SECRET=\'single-quoted\'',
      'INVALID_LINE_WITHOUT_EQUALS',
      'DUCKDB_ENCRYPTION_KEY = spaced-key ',
    ].join('\r\n'))

    expect(parsed).toEqual({
      STRAVA_CLIENT_ID: '12345',
      STRAVA_CLIENT_SECRET: 'sec=ret=val',
      GARMIN_SECRET: 'single-quoted',
      DUCKDB_ENCRYPTION_KEY: 'spaced-key',
    })
  })
})

describe('loadEnvConfig & credential resolution precedence', () => {
  it('loads .env.local, prefers processEnv over .env.local, and omits STRAVA_JWT', () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, '.env.local'),
      [
        'STRAVA_CLIENT_ID=file-id',
        'STRAVA_CLIENT_SECRET=file-secret',
        'STRAVA_REFRESH_TOKEN=file-refresh',
        'STRAVA_JWT=legacy-jwt-should-not-appear',
        'GARMIN_SECRET=file-garmin-com',
        'GARMIN_SECRET_CN=file-garmin-cn',
      ].join('\n'),
    )

    const env = loadEnvConfig({
      projectRoot: dir,
      processEnv: {
        STRAVA_CLIENT_SECRET: 'env-secret',
        STRAVA_REFRESH_TOKEN: '   ',
      },
    })

    expect(env.stravaClientId).toBe('file-id')
    expect(env.stravaClientSecret).toBe('env-secret')
    expect(env.stravaRefreshToken).toBe('file-refresh')
    expect(env.garminSecret).toBe('file-garmin-com')
    expect(env.garminSecretCn).toBe('file-garmin-cn')
    expect('stravaJwt' in env).toBe(false)
  })

  it('gives CLI arguments priority over processEnv and .env.local for Strava credentials', () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, '.env.local'),
      [
        'STRAVA_CLIENT_ID=file-id',
        'STRAVA_CLIENT_SECRET=file-secret',
        'STRAVA_REFRESH_TOKEN=file-refresh',
      ].join('\n'),
    )

    const creds = resolveStravaCredentials(
      { clientId: 'cli-id' },
      {
        projectRoot: dir,
        processEnv: {
          STRAVA_CLIENT_ID: 'env-id',
          STRAVA_CLIENT_SECRET: 'env-secret',
        },
      },
    )

    expect(creds).toEqual({
      clientId: 'cli-id',
      clientSecret: 'env-secret',
      refreshToken: 'file-refresh',
    })
  })

  it('throws ConfigurationError when required Strava credentials are missing', () => {
    const dir = makeTempDir()
    expect(() =>
      resolveStravaCredentials({}, { projectRoot: dir, processEnv: {} }),
    ).toThrow(ConfigurationError)
  })

  it('resolves Garmin COM vs CN credentials with CLI flag override', () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, '.env.local'),
      [
        'GARMIN_IS_CN=true',
        'GARMIN_SECRET=com-secret',
        'GARMIN_SECRET_CN=cn-secret',
      ].join('\n'),
    )

    // Uses GARMIN_IS_CN=true from .env.local
    expect(
      resolveGarminCredentials({}, { projectRoot: dir, processEnv: {} }),
    ).toEqual({
      secretString: 'cn-secret',
      isCn: true,
    })

    // Explicit CLI isCn=false overrides GARMIN_IS_CN=true
    expect(
      resolveGarminCredentials({ isCn: false }, { projectRoot: dir, processEnv: {} }),
    ).toEqual({
      secretString: 'com-secret',
      isCn: false,
    })

    // Explicit CLI garminSecret overrides env
    expect(
      resolveGarminCredentials({ garminSecret: 'cli-cn-secret', isCn: true }, { projectRoot: dir, processEnv: {} }),
    ).toEqual({
      secretString: 'cli-cn-secret',
      isCn: true,
    })
  })

  it('throws ConfigurationError when Garmin secret is missing', () => {
    const dir = makeTempDir()
    expect(() =>
      resolveGarminCredentials({ isCn: true }, { projectRoot: dir, processEnv: {} }),
    ).toThrow(ConfigurationError)
  })
})

describe('resolveRuntimeConfig & constants', () => {
  it('defaults derived web output paths to apps/web and allows caller overrides', () => {
    const root = makeTempDir()
    const defaults = resolveRuntimeConfig({ projectRoot: root })

    expect(defaults.sqlFile).toBe(path.join(root, 'data', 'data.duckdb'))
    expect(defaults.fitDir).toBe(path.join(root, 'data', 'FIT_OUT'))
    expect(defaults.tcxDir).toBe(path.join(root, 'data', 'TCX_OUT'))
    expect(defaults.gpxDir).toBe(path.join(root, 'data', 'GPX_OUT'))
    expect(defaults.dbDir).toBe(path.join(root, 'apps', 'web', 'public', 'db'))
    expect(defaults.jsonFile).toBe(path.join(root, 'apps', 'web', 'src', 'static', 'activities.json'))
    expect(defaults.assetsDir).toBe(path.join(root, 'apps', 'web', 'public', 'assets'))

    const customJson = path.join(root, 'custom', 'activities.json')
    const customDbDir = path.join(root, 'custom', 'db')
    const overridden = resolveRuntimeConfig({
      projectRoot: root,
      jsonFile: customJson,
      dbDir: customDbDir,
    })
    expect(overridden.jsonFile).toBe(customJson)
    expect(overridden.dbDir).toBe(customDbDir)
    expect(overridden.sqlFile).toBe(defaults.sqlFile)
  })

  it('exports timezone and sport mapping constants', () => {
    expect(BASE_TIMEZONE).toBe('Asia/Shanghai')
    expect(UTC_TIMEZONE).toBe('UTC')
    expect(STRAVA_GARMIN_TYPE_DICT).toMatchObject({
      Run: 'running',
      Hike: 'hiking',
      Walk: 'walking',
      Swim: 'swimming',
      EBikeRide: 'cycling',
    })
  })
})
