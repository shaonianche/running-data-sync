import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_VERSION, runCli } from './index.js'

function createBufferIO() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (chunk: string) => {
        stdout += chunk
      },
      stderr: (chunk: string) => {
        stderr += chunk
      },
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

describe('cli skeleton', () => {
  it('prints usage and exits 0 on --help or empty args', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--help'], buf.io)
    expect(code).toBe(0)
    expect(buf.getStdout()).toContain('Usage: running-data-sync')
    expect(buf.getStderr()).toBe('')
  })

  it('prints version and exits 0 on --version', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--version'], buf.io)
    expect(code).toBe(0)
    expect(buf.getStdout().trim()).toBe(CLI_VERSION)
  })

  it('prints resolved monorepo runtime paths on --show-paths', async () => {
    const buf = createBufferIO()
    const code = await runCli(['--show-paths'], buf.io)
    expect(code).toBe(0)
    const parsed = JSON.parse(buf.getStdout()) as Record<string, string>
    expect(parsed.sqlFile).toContain(path.join('data', 'data.duckdb'))
    expect(parsed.jsonFile).toContain(path.join('apps', 'web', 'src', 'static', 'activities.json'))
    expect(parsed.dbDir).toContain(path.join('apps', 'web', 'public', 'db'))
  })

  it('exits non-zero on unknown commands', async () => {
    const buf = createBufferIO()
    const code = await runCli(['unknown-cmd'], buf.io)
    expect(code).toBe(1)
    expect(buf.getStderr()).toContain('Unknown or unimplemented command: unknown-cmd')
  })
})
