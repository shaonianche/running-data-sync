import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  react: true,
  ignorePatterns: ['pyproject.toml', 'scripts/*'],
})
