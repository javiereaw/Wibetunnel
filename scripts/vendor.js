// Copia los bundles de xterm desde node_modules a public/vendor/.
// Ejecutar tras actualizar los paquetes @xterm/*: npm run vendor
const fs = require('fs');
const path = require('path');

const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm-addon-fit.js'],
  ['@xterm/addon-search/lib/addon-search.js', 'xterm-addon-search.js'],
  ['@xterm/addon-webgl/lib/addon-webgl.js', 'xterm-addon-webgl.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'xterm-addon-web-links.js'],
];

const root = path.join(__dirname, '..');
const dest = path.join(root, 'public', 'vendor');
fs.mkdirSync(dest, { recursive: true });
for (const [src, name] of FILES) {
  fs.copyFileSync(path.join(root, 'node_modules', src), path.join(dest, name));
  console.log(`vendor: ${src} -> public/vendor/${name}`);
}
