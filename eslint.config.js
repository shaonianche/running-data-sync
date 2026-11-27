import antfu from '@antfu/eslint-config'

export default antfu({
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
})
