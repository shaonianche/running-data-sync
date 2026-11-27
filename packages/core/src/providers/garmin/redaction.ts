import type { Logger, LoggerOptions } from '../../foundation/index.js'
import {
  createLogger,
  isSensitiveKey,
  REDACTED_VALUE,
  redactSensitiveData,
  redactSensitiveMessage,
} from '../../foundation/index.js'

const GARMIN_SENSITIVE_KEY_SET = new Set<string>([
  'garmin_password',
  'garmin_secret',
  'garmin_secret_cn',
  'secret_string',
  'password',
  'oauth_token',
  'oauth_token_secret',
  'oauth_signature',
  'oauth1_token',
  'oauth2_token',
  'oauth1',
  'oauth2',
  'access_token',
  'refresh_token',
  'mfa_token',
  'consumer_secret',
  'authorization',
  'cookie',
  'set_cookie',
  'x_auth_token',
  'token',
])

const INLINE_GARMIN_KEYS = [
  ...GARMIN_SENSITIVE_KEY_SET,
  ...Array.from(GARMIN_SENSITIVE_KEY_SET, key => key.replace(/_/g, '-')),
  ...Array.from(GARMIN_SENSITIVE_KEY_SET, key =>
    key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())),
].sort((a, b) => b.length - a.length)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const GARMIN_KEY_ALTERNATION = INLINE_GARMIN_KEYS.map(escapeRegExp).join('|')

const GARMIN_QUOTED_ASSIGNMENT_REGEX = new RegExp(
  `((?:['"]?)(?:--)?\\b(?:${GARMIN_KEY_ALTERNATION})\\b(?:['"]?)\\s*[:=]\\s*)(?:(')[^']*'|(")[^"]*")`,
  'gi',
)

const GARMIN_CLI_QUOTED_REGEX = new RegExp(
  `(--(?:${GARMIN_KEY_ALTERNATION})\\b\\s+)(?:(')[^']*'|(")[^"]*")`,
  'gi',
)

const GARMIN_UNQUOTED_ASSIGNMENT_REGEX = new RegExp(
  `((?:['"]?)(?:--)?\\b(?:${GARMIN_KEY_ALTERNATION})\\b(?:['"]?)\\s*[:=]\\s*)([^\\s,'"&;\\]}]+)`,
  'gi',
)

const GARMIN_CLI_UNQUOTED_REGEX = new RegExp(
  `(--(?:${GARMIN_KEY_ALTERNATION})\\b\\s+)([^\\s,'"&;\\]}]+)`,
  'gi',
)

const BEARER_TOKEN_REGEX = /\b(Bearer\s+)([\w.~+/-]+=*)/gi
const OAUTH_HEADER_REGEX = /\b(OAuth\s+)(?:[a-z_]+="[^"]*"(?:,\s*)?)+/gi

function normalizeKey(key: string): string {
  return key
    .replace(/^-{2,}/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

export function isGarminSensitiveKey(key: string): boolean {
  return isSensitiveKey(key) || GARMIN_SENSITIVE_KEY_SET.has(normalizeKey(key))
}

export function redactGarminMessage(message: string, extraSecrets: readonly string[] = []): string {
  const replaceQuoted = (_match: string, prefix: string, singleQuote?: string, doubleQuote?: string): string => {
    const quote = singleQuote ?? doubleQuote ?? '"'
    return `${prefix}${quote}${REDACTED_VALUE}${quote}`
  }

  const replaceUnquoted = (match: string, prefix: string, value: string): string => {
    if (value.startsWith('"') || value.startsWith('\'')) {
      return match
    }
    return `${prefix}${REDACTED_VALUE}`
  }

  let redacted = redactSensitiveMessage(message)
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_VALUE}`)
    .replace(OAUTH_HEADER_REGEX, `$1${REDACTED_VALUE}`)
    .replace(GARMIN_QUOTED_ASSIGNMENT_REGEX, replaceQuoted)
    .replace(GARMIN_CLI_QUOTED_REGEX, replaceQuoted)
    .replace(GARMIN_UNQUOTED_ASSIGNMENT_REGEX, replaceUnquoted)
    .replace(GARMIN_CLI_UNQUOTED_REGEX, replaceUnquoted)

  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join(REDACTED_VALUE)
    }
  }

  return redacted
}

function redactGarminRecursive(
  value: unknown,
  seen: WeakSet<object>,
  extraSecrets: readonly string[],
): unknown {
  if (typeof value === 'string') {
    return redactGarminMessage(value, extraSecrets)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  if (value instanceof Date) {
    return new Date(value.getTime())
  }

  if (value instanceof Error) {
    const redactedError = new Error(redactGarminMessage(value.message, extraSecrets))
    redactedError.name = value.name
    if (value.stack) {
      redactedError.stack = redactGarminMessage(value.stack, extraSecrets)
    }
    return redactedError
  }

  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map(item => redactGarminRecursive(item, seen, extraSecrets))
  }

  if (value instanceof Map) {
    const redactedMap = new Map<unknown, unknown>()
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string' && isGarminSensitiveKey(k)) {
        redactedMap.set(k, REDACTED_VALUE)
      }
      else {
        redactedMap.set(k, redactGarminRecursive(v, seen, extraSecrets))
      }
    }
    return redactedMap
  }

  const output: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isGarminSensitiveKey(key)
      ? REDACTED_VALUE
      : redactGarminRecursive(entryValue, seen, extraSecrets)
  }
  return output
}

export function redactGarminData<T extends Record<string, unknown>>(
  data: T,
  extraSecrets: readonly string[] = [],
): Record<string, unknown> {
  const base = redactSensitiveData(data)
  return redactGarminRecursive(base, new WeakSet<object>(), extraSecrets) as Record<string, unknown>
}

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers)
  const safe: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (isGarminSensitiveKey(key)) {
      continue
    }
    safe[key] = redactGarminMessage(value)
  }
  return safe
}

export function wrapGarminLogger(
  logger: Logger | undefined,
  name: string,
  extraSecretsProvider?: () => readonly string[],
  options?: LoggerOptions,
): Logger {
  const target = logger ?? createLogger(name, options)
  const getSecrets = (): readonly string[] => extraSecretsProvider ? extraSecretsProvider() : []

  const forward = (
    method: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    const secrets = getSecrets()
    const safeMessage = redactGarminMessage(message, secrets)
    const safeData = data !== undefined ? redactGarminData(data, secrets) : undefined
    target[method](safeMessage, safeData)
  }

  return {
    debug: (message, data) => forward('debug', message, data),
    info: (message, data) => forward('info', message, data),
    warn: (message, data) => forward('warn', message, data),
    error: (message, data) => forward('error', message, data),
  }
}
