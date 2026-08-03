// ESLint flat config minima: recommended relajado a los patrones del proyecto
const js = require('@eslint/js');
const globals = require('globals');

const relaxed = {
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'public/vendor/**'] },
  {
    // Backend, scripts y tests: CommonJS sobre Node
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: { ...js.configs.recommended.rules, ...relaxed },
  },
  {
    // Tests E2E: CommonJS sobre Node, pero con closures que Playwright evalua
    // DENTRO del navegador (page.evaluate / waitForFunction), asi que ahi
    // document y window son legitimos.
    files: ['tests/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Frontend: ES modules en navegador + globals de los vendor UMD
    files: ['public/js/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        Terminal: 'readonly',
        FitAddon: 'readonly',
        SearchAddon: 'readonly',
        WebglAddon: 'readonly',
        WebLinksAddon: 'readonly',
        io: 'readonly',
      },
    },
    rules: { ...js.configs.recommended.rules, ...relaxed },
  },
];
