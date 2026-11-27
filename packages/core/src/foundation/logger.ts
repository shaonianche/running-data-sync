import process from 'node:process'

export const REDACTED_VALUE = '***'

export const SENSITIVE_KEYS = [
  'client_id',
  'client_secret',
  'refresh_token',
  'access_token',
  'garmin_password',
  'garmin_secret',
  'garmin_secret_cn',
  'duckdb_encryption_key',
] as const

const NORMALIZED_SENSITIVE_KEY_SET = new Set<string>([
  ...SENSITIVE_KEYS,
  'strava_client_id',
  'strava_client_secret',
  'strava_refresh_token',
])

const INLINE_PATTERN_KEYS = [
  ...NORMALIZED_SENSITIVE_KEY_SET,
  ...Array.from(NORMALIZED_SENSITIVE_KEY_SET, key => key.replace(/_/g, '-')),
  ...Array.from(NORMALIZED_SENSITIVE_KEY_SET, key =>
    key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())),
].sort((a, b) => b.length - a.length)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const KEY_ALTERNATION = INLINE_PATTERN_KEYS.map(escapeRegExp).join('|')

const QUOTED_ASSIGNMENT_REGEX = new RegExp(
  `((?:['"]?)(?:--)?\\b(?:${KEY_ALTERNATION})\\b(?:['"]?)\\s*[:=]\\s*)(?:(')[^']*'|(")[^"]*")`,
  'gi',
)

const CLI_FLAG_QUOTED_REGEX = new RegExp(
  `(--(?:${KEY_ALTERNATION})\\b\\s+)(?:(')[^']*'|(")[^"]*")`,
  'gi',
)

const UNQUOTED_ASSIGNMENT_REGEX = new RegExp(
  `((?:['"]?)(?:--)?\\b(?:${KEY_ALTERNATION})\\b(?:['"]?)\\s*[:=]\\s*)([^\\s,'"&;\\]}]+)`,
  'gi',
)

const CLI_FLAG_UNQUOTED_REGEX = new RegExp(
  `(--(?:${KEY_ALTERNATION})\\b\\s+)([^\\s,'"&;\\]}]+)`,
  'gi',
)

function normalizeKey(key: string): string {
  return key
    .replace(/^-{2,}/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

export function isSensitiveKey(key: string): boolean {
  return NORMALIZED_SENSITIVE_KEY_SET.has(normalizeKey(key))
}

export function redactSensitiveMessage(message: string): string {
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

  return message
    .replace(QUOTED_ASSIGNMENT_REGEX, replaceQuoted)
    .replace(CLI_FLAG_QUOTED_REGEX, replaceQuoted)
    .replace(UNQUOTED_ASSIGNMENT_REGEX, replaceUnquoted)
    .replace(CLI_FLAG_UNQUOTED_REGEX, replaceUnquoted)
}

function redactRecursive(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveMessage(value)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  if (value instanceof Date) {
    return new Date(value.getTime())
  }

  if (value instanceof Error) {
    const redactedError = new Error(redactSensitiveMessage(value.message))
    redactedError.name = value.name
    if (value.stack) {
      redactedError.stack = redactSensitiveMessage(value.stack)
    }
    return redactedError
  }

  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map(item => redactRecursive(item, seen))
  }

  if (value instanceof Map) {
    const redactedMap = new Map<unknown, unknown>()
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string' && isSensitiveKey(k)) {
        redactedMap.set(k, REDACTED_VALUE)
      }
      else {
        redactedMap.set(k, redactRecursive(v, seen))
      }
    }
    return redactedMap
  }

  const output: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactRecursive(entryValue, seen)
  }
  return output
}

export function redactSensitiveData<T>(value: T): T {
  return redactRecursive(value, new WeakSet<object>()) as T
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly timestamp: string
  readonly level: LogLevel
  readonly logger: string
  readonly message: string
  readonly data?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

export interface LoggerOptions {
  readonly level?: LogLevel
  readonly sink?: LogSink
}

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function defaultSink(record: LogRecord): void {
  const suffix = record.data ? ` ${JSON.stringify(record.data)}` : ''
  const line = `[${record.timestamp}] [${record.level.toUpperCase()}] [${record.logger}] ${record.message}${suffix}\n`
  if (record.level === 'warn' || record.level === 'error') {
    process.stderr.write(line)
  }
  else {
    process.stdout.write(line)
  }
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const minWeight = LOG_LEVEL_WEIGHT[options.level ?? 'info']
  const sink = options.sink ?? defaultSink

  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (LOG_LEVEL_WEIGHT[level] < minWeight) {
      return
    }
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      logger: name,
      message: redactSensitiveMessage(message),
      ...(data !== undefined ? { data: redactSensitiveData(data) } : {}),
    }
    sink(record)
  }

  return {
    debug: (message, data) => emit('debug', message, data),
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
  }
}
