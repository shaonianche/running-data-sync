import type {
  CredentialInput,
  EnvConfig,
  GarminCredentials,
  RuntimeConfig,
  StravaCredentials,
} from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ConfigurationError } from './errors.js'

export interface LoadEnvConfigOptions {
  readonly projectRoot?: string
  readonly envFilePath?: string
  readonly processEnv?: Readonly<Record<string, string | undefined>>
}

function normalizeValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stripSurroundingQuotes(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\'')))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separatorIndex = withoutExport.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = withoutExport.slice(0, separatorIndex).trim()
    const rawValue = withoutExport.slice(separatorIndex + 1).trim()
    if (!key) {
      continue
    }

    result[key] = stripSurroundingQuotes(rawValue)
  }

  return result
}

export function resolveProjectRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir)

  while (true) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(startDir)
    }
    current = parent
  }
}

export function loadEnvConfig(options: LoadEnvConfigOptions = {}): EnvConfig {
  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : resolveProjectRoot()
  const envFilePath = options.envFilePath
    ? path.resolve(options.envFilePath)
    : path.join(projectRoot, '.env.local')

  let fileValues: Record<string, string> = {}
  if (fs.existsSync(envFilePath)) {
    const content = fs.readFileSync(envFilePath, 'utf8')
    fileValues = parseEnvFile(content)
  }

  const processEnv = options.processEnv ?? process.env
  const readKey = (key: string): string | undefined =>
    normalizeValue(processEnv[key]) ?? normalizeValue(fileValues[key])

  return {
    stravaClientId: readKey('STRAVA_CLIENT_ID'),
    stravaClientSecret: readKey('STRAVA_CLIENT_SECRET'),
    stravaRefreshToken: readKey('STRAVA_REFRESH_TOKEN'),
    garminEmail: readKey('GARMIN_EMAIL'),
    garminPassword: readKey('GARMIN_PASSWORD'),
    garminIsCn: readKey('GARMIN_IS_CN'),
    garminSecret: readKey('GARMIN_SECRET'),
    garminSecretCn: readKey('GARMIN_SECRET_CN'),
    duckdbEncryptionKey: readKey('DUCKDB_ENCRYPTION_KEY'),
  }
}

export function resolveRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const projectRoot = overrides.projectRoot
    ? path.resolve(overrides.projectRoot)
    : resolveProjectRoot()
  const dataRoot = overrides.dataRoot
    ? path.resolve(overrides.dataRoot)
    : path.join(projectRoot, 'data')
  const webRoot = path.join(projectRoot, 'apps', 'web')

  return {
    projectRoot,
    dataRoot,
    sqlFile: overrides.sqlFile ? path.resolve(overrides.sqlFile) : path.join(dataRoot, 'data.duckdb'),
    fitDir: overrides.fitDir ? path.resolve(overrides.fitDir) : path.join(dataRoot, 'FIT_OUT'),
    tcxDir: overrides.tcxDir ? path.resolve(overrides.tcxDir) : path.join(dataRoot, 'TCX_OUT'),
    gpxDir: overrides.gpxDir ? path.resolve(overrides.gpxDir) : path.join(dataRoot, 'GPX_OUT'),
    dbDir: overrides.dbDir ? path.resolve(overrides.dbDir) : path.join(webRoot, 'public', 'db'),
    jsonFile: overrides.jsonFile
      ? path.resolve(overrides.jsonFile)
      : path.join(webRoot, 'src', 'static', 'activities.json'),
    assetsDir: overrides.assetsDir ? path.resolve(overrides.assetsDir) : path.join(webRoot, 'public', 'assets'),
  }
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  const normalized = normalizeValue(value)?.toLowerCase()
  if (!normalized) {
    return undefined
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false
  }
  return undefined
}

export function resolveStravaCredentials(
  input: CredentialInput = {},
  envOptions: LoadEnvConfigOptions = {},
): StravaCredentials {
  const env = loadEnvConfig(envOptions)
  const clientId = normalizeValue(input.clientId) ?? env.stravaClientId
  const clientSecret = normalizeValue(input.clientSecret) ?? env.stravaClientSecret
  const refreshToken = normalizeValue(input.refreshToken) ?? env.stravaRefreshToken

  if (!clientId || !clientSecret || !refreshToken) {
    throw new ConfigurationError('Missing Strava credentials. Provide CLI arguments, environment variables, or .env.local values.')
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
  }
}

export function resolveGarminCredentials(
  input: CredentialInput = {},
  envOptions: LoadEnvConfigOptions = {},
): GarminCredentials {
  const env = loadEnvConfig(envOptions)
  const isCn = input.isCn ?? parseBooleanFlag(env.garminIsCn) ?? false
  const secretString = normalizeValue(input.garminSecret)
    ?? (isCn ? env.garminSecretCn : env.garminSecret)

  if (!secretString) {
    throw new ConfigurationError(
      `Missing Garmin ${isCn ? 'CN' : 'COM'} secret string. Provide CLI arguments, environment variables, or .env.local values.`,
    )
  }

  return {
    secretString,
    isCn,
  }
}
