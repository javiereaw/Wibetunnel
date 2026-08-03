// Lectura y escritura de archivos de TEXTO dentro del jail, para el editor de
// la vista /claude. Puro y sin Express: devuelve codigos internos que
// lib/fs-routes.js traduce a HTTP, asi que se puede probar sin levantar nada.
//
// Tres decisiones que conviene no revertir sin leer el porque:
//
// 1. El token de concurrencia es un HASH DEL CONTENIDO, no el mtime. La
//    granularidad de mtime es de 1 s en varios sistemas de ficheros, asi que
//    dos escrituras en el mismo segundo son indistinguibles y producen un lost
//    update silencioso; ademas cp -p / rsync -t preservan mtime y enganarian al
//    control. Un hash tambien evita conflictos falsos cuando otro proceso
//    reescribio exactamente los mismos bytes.
//
// 2. Se escribe en un temporal y se hace rename. rename(2) NUNCA sigue un
//    symlink en el componente final: si alguien sustituye el destino por un
//    enlace a ~/.ssh/authorized_keys entre la validacion y la escritura, se
//    reemplaza el enlace, no el objetivo. Esto es un argumento de seguridad,
//    por encima del de atomicidad, y es la razon de no truncar in-place.
//    Contrapartida asumida: cambia el inodo y rompe hard links, igual que hacen
//    vim, VS Code y sed -i.
//
// 3. Un archivo demasiado grande devuelve error, nunca contenido recortado: un
//    recorte seguido de un guardado destruiria datos.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveJailed } = require('./fs-handler');
const { EDIT_MAX } = require('./config');

const BOM = '﻿';
const CONTROL_SAMPLE = 8192;
const CONTROL_RATIO = 0.1;
// O_NOFOLLOW no existe en Windows: alli se acepta la ventana (el realpath
// previo ya ha comprobado el jail).
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function ok(data) { return { ok: true, data }; }
function err(code, message, meta) { return { ok: false, code, error: message, meta: meta || null }; }

// === Primitivas ===

function computeEtag(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

// Se analiza el buffer COMPLETO, no una muestra: cortar a 8 KB puede partir una
// secuencia UTF-8 multibyte y marcar como binario un fichero de texto legitimo.
function sniffText(buf) {
  if (buf.includes(0)) return { text: false, reason: 'nul' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return { text: false, reason: 'utf8' };
  }
  const sample = buf.subarray(0, CONTROL_SAMPLE);
  let control = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 11 && byte !== 8 && byte !== 27) control++;
  }
  if (sample.length && control / sample.length > CONTROL_RATIO) return { text: false, reason: 'control' };
  return { text: true };
}

function detectEol(str) {
  const lf = (str.match(/\n/g) || []).length;
  if (!lf) return 'lf';
  const crlf = (str.match(/\r\n/g) || []).length;
  return crlf > lf / 2 ? 'crlf' : 'lf';
}

function stripBom(str) {
  return str.startsWith(BOM) ? { text: str.slice(1), bom: true } : { text: str, bom: false };
}

// El textarea del navegador normaliza siempre a LF. Sin reconstruir el final de
// linea original, cada guardado desde el movil convertiria un fichero CRLF
// entero y produciria un diff gigante espurio.
function applyEol(str, eol) {
  const lf = str.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

// === Serializacion por ruta ===

// Cola en memoria por ruta REAL. Elimina por completo la carrera entre dos
// peticiones del mismo proceso (dos dispositivos guardando a la vez); frente a
// editores externos, quien protege es el etag.
const locks = new Map();

function withPathLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // La cola se limpia cuando esta peticion resulta ser la ultima: si no, el Map
  // crece con una entrada por fichero tocado en toda la vida del proceso.
  const guard = next.catch(() => {}).then(() => {
    if (locks.get(key) === guard) locks.delete(key);
  });
  locks.set(key, guard);
  return next;
}

// === Lectura ===

async function readTextFile(requestedPath) {
  const r = await resolveJailed(requestedPath);
  if (r.error) return err(r.error, r.error === 'denied' ? 'fuera del directorio permitido' : 'no encontrado');

  const lst = await fs.promises.lstat(r.path).catch(() => null);
  if (!lst) return err('not-found', 'no encontrado');
  // realpath ya siguio los enlaces: si aqui sigue siendo uno, es una carrera.
  if (lst.isSymbolicLink() || !lst.isFile()) return err('not-file', 'no es un archivo regular');
  if (lst.size > EDIT_MAX) return err('too-large', 'archivo demasiado grande', { size: lst.size, max: EDIT_MAX });

  let handle;
  try {
    handle = await fs.promises.open(r.path, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    return err(e.code === 'ELOOP' ? 'not-file' : 'io', 'no se pudo abrir');
  }
  let buf;
  try {
    buf = await handle.readFile();
  } catch (_) {
    return err('io', 'no se pudo leer');
  } finally {
    await handle.close().catch(() => {});
  }

  const sniff = sniffText(buf);
  if (!sniff.text) return err('binary', 'el archivo no es texto', { reason: sniff.reason });

  const raw = buf.toString('utf8');
  const eol = detectEol(raw);
  const { text, bom } = stripBom(raw);
  return ok({
    path: r.path,
    name: path.basename(r.path),
    dir: path.dirname(r.path),
    size: lst.size,
    mtimeMs: lst.mtimeMs,
    etag: computeEtag(buf),
    eol,
    bom,
    content: text.replace(/\r\n/g, '\n'), // el cliente siempre recibe LF
  });
}

// === Escritura ===

async function writeOnce(realPath, buf, mode) {
  const dir = path.dirname(realPath);
  const tmp = path.join(dir, '.wibe-' + path.basename(realPath) + '-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'wx', 0o600); // wx: falla si ya existe
    await handle.writeFile(buf);
    await handle.chmod(mode & 0o7777); // preservar los permisos del original
    await handle.sync();               // fsync antes del rename
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, realPath);
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function writeTextFile(requestedPath, opts) {
  const { content, eol, bom, ifMatch } = opts || {};
  if (typeof content !== 'string') return err('bad-request', 'contenido invalido');
  if (!ifMatch) return err('no-precondition', 'falta If-Match');

  const first = await resolveJailed(requestedPath);
  if (first.error) return err(first.error, first.error === 'denied' ? 'fuera del directorio permitido' : 'no encontrado');

  // El lock se toma sobre la ruta REAL (no la pedida): dos alias del mismo
  // inodo tienen que serializar, o ambos leerian el mismo etag, ambos pasarian
  // la comprobacion y uno perderia su escritura.
  return withPathLock(first.path, async () => {
    const r = await resolveJailed(requestedPath);
    if (r.error) return err(r.error, 'no encontrado');

    const lst = await fs.promises.lstat(r.path).catch(() => null);
    if (!lst) return err('not-found', 'no encontrado');
    if (lst.isSymbolicLink() || !lst.isFile()) return err('not-file', 'el destino ya no es un archivo regular');
    if (lst.size > EDIT_MAX) return err('too-large', 'archivo demasiado grande', { size: lst.size, max: EDIT_MAX });

    const current = await fs.promises.readFile(r.path).catch(() => null);
    if (!current) return err('io', 'no se pudo leer el estado actual');
    const currentEtag = computeEtag(current);
    if (currentEtag !== ifMatch) {
      const st = await fs.promises.stat(r.path).catch(() => null);
      return err('conflict', 'el archivo cambió en disco', {
        etag: currentEtag, mtimeMs: st ? st.mtimeMs : null, size: current.length,
      });
    }

    const body = (bom ? BOM : '') + applyEol(content, eol === 'crlf' ? 'crlf' : 'lf');
    const buf = Buffer.from(body, 'utf8');
    if (buf.length > EDIT_MAX) return err('too-large', 'contenido demasiado grande', { max: EDIT_MAX });

    try {
      await writeOnce(r.path, buf, lst.mode);
    } catch (e) {
      // Escritura in-place como alternativa NO: reabriria la ventana de symlink
      // y la de escritura parcial. Si el directorio es de solo lectura, se dice.
      if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
        return err('no-perm', 'sin permiso de escritura en el directorio');
      }
      return err('io', 'no se pudo guardar');
    }

    const st = await fs.promises.stat(r.path).catch(() => null);
    return ok({ ok: true, etag: computeEtag(buf), mtimeMs: st ? st.mtimeMs : null, size: buf.length });
  });
}

module.exports = {
  readTextFile, writeTextFile,
  computeEtag, sniffText, detectEol, stripBom, applyEol, withPathLock,
};
