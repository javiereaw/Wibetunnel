// ESLint flat config minima: recommended relajado a los patrones del proyecto
const js = require('@eslint/js');
const globals = require('globals');

const relaxed = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
};

// Errores silenciados. Las dos van JUNTAS: 'no-empty' sin 'no-empty-function'
// deja abierta la salida barata --- `p.catch(() => {})` no es un bloque vacio
// sino una FUNCION vacia, y no-empty no la mira. Cerrar una y dejar la otra
// empuja al antipatron en vez de quitarlo.
//
// 'warn' y no 'error' por lo mismo que las estructurales: en 'error' romperian
// el lint el primer dia y acabarian desactivadas. Quien impide que suban es la
// puerta 'eslint-estructural' del trinquete.
//
// Aqui NO hay 'no-floating-promises': esa regla necesita el checker de
// TypeScript y este repo es JavaScript sin tsconfig. La promesa suelta se queda
// sin vigilar; es una limitacion real, no un olvido.
const silenciado = {
  'no-empty': ['warn', { allowEmptyCatch: false }],
  'no-empty-function': ['warn', { allow: [] }],
};

// Reglas estructurales. Van como 'warn' a proposito: hoy hay 44 funciones por
// encima de complexity 10, asi que en 'error' romperian el lint el primer dia.
// Quien impide que suban es la puerta 'eslint-estructural' del trinquete
// (.gates/manifest.json): congela las actuales y bloquea cualquier clave nueva.
const estructurales = {
  complexity: ['warn', 10],
  'max-depth': ['warn', 4],
  'max-params': ['warn', 5],
  'max-nested-callbacks': ['warn', 3],
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
    rules: { ...js.configs.recommended.rules, ...relaxed, ...estructurales, ...silenciado },
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
    rules: { ...js.configs.recommended.rules, ...relaxed, ...estructurales, ...silenciado },
  },
];
