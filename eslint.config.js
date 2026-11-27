import antfu from '@antfu/eslint-config'

export default antfu(
  {
    formatters: true,
    react: true,
    ignores: [
      'apps/web/src/static/activities.json',
      'apps/web/public/**',
      'data/**',
      '**/*.md',
      '**/*.toml',
      '**/*.yaml',
      '**/*.yml',
      '**/*.json',
    ],
  },
  {
    name: 'boundaries/web-browser-only',
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@running-data-sync/core',
              message: 'Browser code must import types only from @running-data-sync/core/types.',
            },
            {
              name: '@running-data-sync/core/testing',
              message: 'Production browser code must not import test doubles.',
            },
          ],
          patterns: [
            {
              group: ['node:*'],
              message: 'Browser code must not import Node.js built-in modules.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'boundaries/no-testing-in-production',
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      'packages/core/src/testing/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@running-data-sync/core/testing',
              message: 'Production code must not import @running-data-sync/core/testing.',
            },
          ],
          patterns: [
            {
              group: ['**/testing', '**/testing/*'],
              message: 'Production code must not import internal testing helpers.',
            },
          ],
        },
      ],
    },
  },
)
