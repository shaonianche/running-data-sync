#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_PATTERNS = [
  {
    name: 'DuckDB database file',
    test: path => /(?:^|\/)[^/]+\.duckdb(?:\.wal|\.tmp)?$/i.test(path),
  },
  {
    name: 'Raw workout track file (.fit/.gpx/.tcx)',
    test: path => /\.(?:fit|gpx|tcx)$/i.test(path),
  },
  {
    name: 'Raw workout output directory (FIT_OUT/GPX_OUT/TCX_OUT)',
    test: path => /(?:^|\/)(?:FIT_OUT|GPX_OUT|TCX_OUT)\//i.test(path),
  },
]

export function findPrivateDataViolations(paths) {
  const violations = []
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, '/').trim()
    if (!normalized) {
      continue
    }
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.test(normalized)) {
        violations.push({ path: normalized, reason: rule.name })
        break
      }
    }
  }
  return violations
}

function getStagedPaths(cwd) {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd, encoding: 'utf8' },
  )
  return output.split('\n').map(line => line.trim()).filter(Boolean)
}

function getStatusPaths(cwd) {
  const output = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-uall'],
    { cwd, encoding: 'utf8' },
  )
  return output
    .split('\n')
    .filter(line => line.length >= 4)
    .map((line) => {
      const status = line.slice(0, 2)
      if (status.includes('D')) {
        return ''
      }
      const rest = line.slice(3).trim()
      const arrowIdx = rest.indexOf(' -> ')
      return arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest
    })
    .filter(Boolean)
}

export function runGuardrail(argv = process.argv.slice(2), cwd = process.cwd()) {
  const mode = argv.includes('--staged')
    ? 'staged'
    : argv.includes('--status')
      ? 'status'
      : 'paths'

  let paths
  if (mode === 'staged') {
    paths = getStagedPaths(cwd)
  }
  else if (mode === 'status') {
    paths = getStatusPaths(cwd)
  }
  else {
    paths = argv.filter(arg => !arg.startsWith('--'))
    if (paths.length === 0) {
      paths = getStagedPaths(cwd)
    }
  }

  const violations = findPrivateDataViolations(paths)
  if (violations.length > 0) {
    process.stderr.write('Private data leakage guardrail failed:\n')
    for (const v of violations) {
      process.stderr.write(`  - ${v.path} (${v.reason})\n`)
    }
    return 1
  }
  return 0
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  process.exit(runGuardrail())
}
