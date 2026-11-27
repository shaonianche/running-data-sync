import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function createBoundaryEslint() {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
  })
}

async function lintBoundarySnippet(code: string, relativeFilePath: string) {
  const eslint = createBoundaryEslint()
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativeFilePath),
  })
  return (result?.messages ?? []).filter(m => m.ruleId === 'no-restricted-imports')
}

describe('module boundary ESLint rules', () => {
  it('rejects @running-data-sync/core value import in apps/web production code', async () => {
    const errors = await lintBoundarySnippet(
      `import { syncStravaToDb } from '@running-data-sync/core'\nexport { syncStravaToDb }\n`,
      'apps/web/src/utils/violation.ts',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toContain('@running-data-sync/core/types')
  })

  it('rejects node:* built-in import in apps/web production code', async () => {
    const errors = await lintBoundarySnippet(
      `import path from 'node:path'\nexport const p = path.join('a', 'b')\n`,
      'apps/web/src/utils/violation.ts',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toContain('Node.js built-in')
  })

  it('allows @running-data-sync/core/types in apps/web production code', async () => {
    const errors = await lintBoundarySnippet(
      `import type { Activity } from '@running-data-sync/core/types'\nexport type Run = Activity\n`,
      'apps/web/src/utils/allowed.ts',
    )
    expect(errors).toEqual([])
  })

  it('rejects @running-data-sync/core/testing in production package code', async () => {
    const errors = await lintBoundarySnippet(
      `import { InMemoryActivityStore } from '@running-data-sync/core/testing'\nexport const s = new InMemoryActivityStore()\n`,
      'packages/cli/src/commands/violation.ts',
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toContain('@running-data-sync/core/testing')
  })

  it('allows @running-data-sync/core/testing in test files', async () => {
    const errors = await lintBoundarySnippet(
      `import { InMemoryActivityStore } from '@running-data-sync/core/testing'\nexport const s = new InMemoryActivityStore()\n`,
      'packages/cli/src/cli.test.ts',
    )
    expect(errors).toEqual([])
  })
})
