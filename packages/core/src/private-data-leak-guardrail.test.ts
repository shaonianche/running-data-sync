import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const GUARDRAIL_SCRIPT = resolve(import.meta.dirname, '../../../scripts/check-private-data-leak.mjs')

function runGuardrailScript(args: string[]): { status: number, stderr: string } {
  try {
    execFileSync(process.execPath, [GUARDRAIL_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  }
  catch (error: unknown) {
    const err = error as { status?: number, stderr?: string }
    return {
      status: err.status ?? 1,
      stderr: err.stderr ?? '',
    }
  }
}

describe('check-private-data-leak guardrail', () => {
  it('flags DuckDB files and WAL sidecars', () => {
    const result = runGuardrailScript([
      'data/data.duckdb',
      'data/data.duckdb.wal',
      'tmp/backup.duckdb.tmp',
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('data/data.duckdb')
    expect(result.stderr).toContain('data/data.duckdb.wal')
    expect(result.stderr).toContain('tmp/backup.duckdb.tmp')
  })

  it('flags raw FIT/GPX/TCX files and output directories', () => {
    const result = runGuardrailScript([
      'data/FIT_OUT/12345.fit',
      'GPX_OUT/run.gpx',
      'exports/activity.TCX',
      'data/TCX_OUT/readme.txt',
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('data/FIT_OUT/12345.fit')
    expect(result.stderr).toContain('GPX_OUT/run.gpx')
    expect(result.stderr).toContain('exports/activity.TCX')
    expect(result.stderr).toContain('data/TCX_OUT/readme.txt')
  })

  it('allows public projection files and source code', () => {
    const result = runGuardrailScript([
      'apps/web/src/static/activities.json',
      'apps/web/public/assets/github.svg',
      'apps/web/public/assets/grid.svg',
      'apps/web/public/db/activities.parquet',
      'packages/core/src/storage/snapshot.ts',
    ])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})
