// Sello de build sin build system: max mtime de public/ en hex.
// Se calcula una vez al arrancar; un deploy que toca cualquier estatico
// cambia el sello → /sw.js dinamico byte-distinto → el navegador reinstala el SW.
const fs = require('fs');
const path = require('path');

function maxMtime(dir) {
  let max = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        max = Math.max(max, maxMtime(p));
      } else {
        max = Math.max(max, fs.statSync(p).mtimeMs);
      }
    } catch (_) {}
  }
  return max;
}

function buildStamp(publicDir) {
  return Math.round(maxMtime(publicDir)).toString(16);
}

module.exports = { buildStamp };
