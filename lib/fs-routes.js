// Rutas HTTP de sistema de archivos, todas bajo /fs/ y todas jailed en CWD.
// Se extraen de server.js (que ya estaba por encima del limite de LOC) y se
// montan antes del static.
//
// Por que el contenido de fichero va por HTTP y no por socket: socket.io tiene
// maxHttpBufferSize = 1e6 y CIERRA la conexion ante un frame mayor, lo que
// tiraria todas las sesiones PTY vivas del usuario. Ademas el socket multiplexa
// la salida del terminal, asi que mover 500 KB por ahi produce stutter visible
// justo mientras guardas. Y /fs/ ya esta excluido del service worker.
const fs = require('fs');
const path = require('path');
const log = require('./log');
const metrics = require('./metrics');
const { httpAuthed, checkOpRate, getHttpClientIp } = require('./auth');
const { resolveJailed } = require('./fs-handler');
const { readTextFile, writeTextFile } = require('./fs-file');
const { UPLOAD_MAX, EDIT_MAX } = require('./config');

const MAX_PATH_CHARS = 4096;
const READ_PER_MIN = 120;
const WRITE_PER_MIN = 30;
const MINUTE = 60000;

// Codigo interno de lib/fs-file -> estado HTTP.
const HTTP_STATUS = {
  denied: 403,
  'not-found': 404,
  'not-file': 409,
  'too-large': 413,
  binary: 415,
  conflict: 412,
  'no-precondition': 428,
  'no-perm': 403,
  'bad-request': 400,
  io: 500,
};

function sendFailure(res, result) {
  const status = HTTP_STATUS[result.code] || 500;
  res.status(status).json({ error: result.error, ...(result.meta || {}) });
}

function badPath(res, value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS) {
    res.status(400).json({ error: 'ruta invalida' });
    return true;
  }
  return false;
}

// Acumula el cuerpo con tope duro, sin body-parser: igual que /fs/upload, pero
// en memoria porque el tope es EDIT_MAX (1 MiB) y hay que hashearlo entero.
function readBodyCapped(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > max) {
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function mountFsRoutes(app) {
  // --- Descarga de archivos (dentro del jail de CWD) ---
  app.get('/fs/download', async (req, res) => {
    try {
      if (!httpAuthed(req, res)) return;
      const r = await resolveJailed(String(req.query.path || ''));
      if (r.error) return res.status(r.error === 'denied' ? 403 : 404).json({ error: r.error });
      const st = await fs.promises.stat(r.path);
      if (!st.isFile()) return res.status(400).json({ error: 'no es un archivo' });
      const name = path.basename(r.path);
      metrics.inc('downloads');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.sendFile(r.path);
    } catch (err) {
      log.error('[FS] download:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error interno' });
    }
  });

  // --- Subida de archivos (streaming a disco, con limite de tamaño y jail) ---
  app.post('/fs/upload', async (req, res) => {
    try {
      if (!httpAuthed(req, res)) return;
      const name = path.basename(String(req.query.name || ''));
      if (!name || name === '.' || name === '..') return res.status(400).json({ error: 'nombre invalido' });
      const r = await resolveJailed(String(req.query.dir || ''));
      if (r.error) return res.status(r.error === 'denied' ? 403 : 404).json({ error: r.error });
      const st = await fs.promises.stat(r.path);
      if (!st.isDirectory()) return res.status(400).json({ error: 'destino no es un directorio' });

      const dest = path.join(r.path, name);
      // No escribir sobre symlinks preexistentes: un enlace plantado dentro del
      // jail permitiria escribir fuera (p.ej. ~/.ssh/authorized_keys)
      const lst = await fs.promises.lstat(dest).catch(() => null);
      if (lst && (lst.isSymbolicLink() || !lst.isFile())) {
        return res.status(400).json({ error: 'destino invalido' });
      }
      const out = fs.createWriteStream(dest);
      let bytes = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > UPLOAD_MAX && !aborted) {
          aborted = true;
          out.destroy();
          fs.promises.unlink(dest).catch(() => {});
          res.status(413).json({ error: 'archivo demasiado grande' });
          req.destroy();
        }
      });
      req.pipe(out);
      out.on('finish', () => {
        if (aborted) return;
        metrics.inc('uploads');
        log.info(`[FS] subido ${dest} (${bytes} bytes)`);
        res.json({ ok: true, name, bytes });
      });
      out.on('error', (err) => {
        if (aborted) return;
        log.error('[FS] upload:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'no se pudo guardar' });
      });
    } catch (err) {
      log.error('[FS] upload:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error interno' });
    }
  });

  // --- Leer un archivo de texto para editarlo ---
  app.get('/fs/file', async (req, res) => {
    try {
      if (!httpAuthed(req, res)) return;
      if (!checkOpRate(getHttpClientIp(req), 'fsread', READ_PER_MIN, MINUTE)) {
        return res.status(429).json({ error: 'demasiadas operaciones' });
      }
      const p = String(req.query.path || '');
      if (badPath(res, p)) return;
      const result = await readTextFile(p);
      if (!result.ok) return sendFailure(res, result);
      metrics.inc('fileReads');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('ETag', `"${result.data.etag}"`);
      res.json(result.data);
    } catch (err) {
      log.error('[FS] file get:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error interno' });
    }
  });

  // --- Guardar un archivo de texto existente ---
  // If-Match es obligatorio y NO se acepta "*": el "sobrescribir de todos
  // modos" del cliente se implementa releyendo el etag actual y reenviando,
  // nunca como un bypass. Asi la ventana de carrera sigue siendo estrecha.
  app.put('/fs/file', async (req, res) => {
    try {
      if (!httpAuthed(req, res)) return;
      if (!checkOpRate(getHttpClientIp(req), 'fswrite', WRITE_PER_MIN, MINUTE)) {
        return res.status(429).json({ error: 'demasiadas operaciones' });
      }
      const p = String(req.query.path || '');
      if (badPath(res, p)) return;

      const ifMatch = String(req.headers['if-match'] || '').replace(/^"|"$/g, '');
      if (!ifMatch || ifMatch === '*') {
        return res.status(428).json({ error: 'falta If-Match con el etag exacto' });
      }
      const eol = req.query.eol === 'crlf' ? 'crlf' : 'lf';
      const bom = req.query.bom === '1';

      let body;
      try {
        body = await readBodyCapped(req, EDIT_MAX);
      } catch (e) {
        if (e && e.tooLarge) return res.status(413).json({ error: 'contenido demasiado grande', max: EDIT_MAX });
        return res.status(400).json({ error: 'cuerpo invalido' });
      }
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch (_) {
        return res.status(400).json({ error: 'el cuerpo no es UTF-8 valido' });
      }

      const result = await writeTextFile(p, { content, eol, bom, ifMatch });
      if (!result.ok) {
        if (result.code === 'conflict') metrics.inc('fileConflicts');
        return sendFailure(res, result);
      }
      metrics.inc('fileWrites');
      log.info(`[FS] guardado ${p} (${result.data.size} bytes)`);
      res.json(result.data);
    } catch (err) {
      log.error('[FS] file put:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error interno' });
    }
  });
}

module.exports = { mountFsRoutes };
