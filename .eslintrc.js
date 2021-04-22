module.exports = {
  env: {
    browser: true,
    es6: true,
  },
  extends: ['airbnb'],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parser: 'babel-eslint',
  parserOptions: {
    sourceType: 'module',
    allowImportExportEverywhere: true,
  },
  plugins: [
    'jest',
    'react',
    'react-internal',
  ],
  rules: {
    indent: [
      'error',
      2,
      {
        ignoredNodes: ['TemplateLiteral'],
      },
    ],
    'template-curly-spacing': ['off'],
    'import/no-unresolved': [
      2,
      {
        ignore: ['src'],
        caseSensitive: false,
      },
    ],
  },
};
