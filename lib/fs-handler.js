// File browser: listado de directorios con jail sobre CWD
const path = require('path');
const fs = require('fs');
const { CWD } = require('./config');

const GENERIC_ERROR = 'No se pudo listar el directorio';

async function listDirectory(dirPath) {
  if (typeof dirPath !== 'string' && dirPath != null) {
    return { path: '', items: [], error: GENERIC_ERROR };
  }
  const requested = path.resolve(dirPath || CWD);

  // realpath sigue symlinks: el jail se comprueba sobre el destino REAL,
  // asi un symlink dentro de CWD apuntando fuera no puede escapar
  let resolved, rootReal;
  try {
    rootReal = await fs.promises.realpath(CWD);
    resolved = await fs.promises.realpath(requested);
  } catch (err) {
    return { path: CWD, items: [], error: GENERIC_ERROR };
  }

  // Case-insensitive jail en Windows (NTFS), case-sensitive en POSIX
  const ci = process.platform === 'win32';
  const rNorm = ci ? resolved.toLowerCase() : resolved;
  const cNorm = ci ? rootReal.toLowerCase() : rootReal;
  if (rNorm !== cNorm && !rNorm.startsWith(cNorm + path.sep)) {
    return { path: rootReal, items: [], error: 'Acceso denegado: fuera del directorio raiz' };
  }

  try {
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      fullPath: path.join(resolved, e.name),
    })).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: resolved, items, error: null };
  } catch (err) {
    console.error('[FS] Error listando directorio:', err.message);
    return { path: resolved, items: [], error: GENERIC_ERROR };
  }
}

module.exports = { listDirectory };
