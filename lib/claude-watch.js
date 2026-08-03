// Vista "/claude": localiza el proceso `claude` (Claude Code) que corre dentro
// de un PTY y sigue en vivo su transcript JSONL (~/.claude/projects/<slug>/<id>.jsonl)
// para que el frontend pueda renderizarlo como chat estructurado.
//
// Solo lectura: este modulo nunca escribe en ~/.claude. Nada aqui depende de
// pty-store (se le pasa el pid y una funcion emit, nada mas) — aislado a proposito
// para que un fallo en la deteccion nunca afecte al terminal real.
const fs = require('fs');
const path = require('path');
const log = require('./log');
const { CLAUDE_HOME } = require('./config');
const { parseLines, createParseContext, normalizeLine } = require('./claude-normalize');

const REPLAY_MAX_BYTES = 1.5 * 1024 * 1024; // cola inicial al enganchar (~1200 eventos tipicos)
const SEARCH_RETRY_MS = 2000;   // reintento mientras no aparece un proceso `claude`
const WATCH_INTERVAL_MS = 400;  // polling de fs.watchFile (mas fiable que inotify sobre NFS/contenedores)
const RECHECK_MS = 5000;        // re-verificar que el fichero enganchado sigue siendo el correcto
const EMIT_MAX_BYTES = 512 * 1024; // presupuesto por emit: un frame gigante ahoga socket.io en movil

const HAS_PROC = process.platform === 'linux';

// === Localizar el proceso claude y su transcript ===

function readProcField(pid, field) {
  try { return fs.readFileSync(`/proc/${pid}/${field}`, 'utf8'); } catch (_) { return null; }
}

// Vuelca /proc una sola vez y construye ppid → [pid,...]: mucho mas barato que
// una llamada por pid cuando el arbol de procesos es profundo (shell > claude > ...).
function pidChildrenMap() {
  const map = new Map();
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch (_) { return map; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const stat = readProcField(pid, 'stat');
    if (!stat) continue;
    // Formato: "pid (comm) state ppid ...". comm puede contener espacios o
    // parentesis, por eso se parte por el ULTIMO ')' antes de tokenizar el resto.
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    if (!Number.isFinite(ppid)) continue;
    if (!map.has(ppid)) map.set(ppid, []);
    map.get(ppid).push(pid);
  }
  return map;
}

// BFS desde el pid raiz (el PTY) buscando un descendiente (o el propio raiz,
// si un perfil lanza `claude` directamente como shell) cuyo comm sea "claude".
function findClaudePid(rootPid) {
  if (!HAS_PROC) return null;
  const rootComm = (readProcField(rootPid, 'comm') || '').trim();
  if (rootComm === 'claude') return rootPid;
  const childrenOf = pidChildrenMap();
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const pid = queue.shift();
    for (const kid of (childrenOf.get(pid) || [])) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      const comm = (readProcField(kid, 'comm') || '').trim();
      if (comm === 'claude') return kid;
      queue.push(kid);
    }
  }
  return null;
}

function slugify(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Lee los primeros bytes de un jsonl y comprueba que su campo "cwd" cuadra;
// si no se puede leer/parsear no bloquea (mejor un intento optimista que nada).
function validateFirstLineCwd(file, cwd) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
    if (!firstLine) return true;
    const obj = JSON.parse(firstLine);
    return !obj.cwd || obj.cwd === cwd;
  } catch (_) { return true; }
}

// { sessionId, file, cwd } del transcript activo para este pid de PTY, o null
function resolveTranscript(ptyPid) {
  const claudePid = findClaudePid(ptyPid);
  if (!claudePid) return null;
  let cwd;
  try { cwd = fs.readlinkSync(`/proc/${claudePid}/cwd`); } catch (_) { return null; }
  const dir = path.join(CLAUDE_HOME, 'projects', slugify(cwd));
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { return null; }
  if (!files.length) return null;
  const stats = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try { stats.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs, sessionId: f.slice(0, -'.jsonl'.length) }); }
    catch (_) { /* borrado entre readdir y stat: ignorar */ }
  }
  if (!stats.length) return null;
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = stats.find(s => validateFirstLineCwd(s.file, cwd)) || stats[0];
  return { sessionId: chosen.sessionId, file: chosen.file, cwd };
}

// La normalizacion vive en ./claude-normalize (pura, sin I/O). normalizeLine se
// re-exporta al final para no romper a quien la importe desde aqui.

// === Watchers activos (uno por persistentId enganchado) ===

const watchers = new Map();

function makeWatcher(persistentId, ptyPid, emit) {
  return {
    persistentId, ptyPid, emit,
    status: 'searching',
    file: null, sessionId: null,
    offset: 0, partial: '',
    counter: 0, headCounter: 0, headOffset: 0,
    truncated: false,
    ctx: createParseContext(),     // diferencial de cwd/gitBranch/version (ver claude-normalize)
    headCtx: createParseContext(), // el mismo, independiente, para los tramos de "cargar mas"
    searchTimer: null, recheckTimer: null, fsListener: null,
  };
}

// Trocea por presupuesto de bytes: el replay inicial puede ser un unico lote de
// varios MB, y socket.io + tunel + movil se atragantan con un frame asi.
function emitEvents(w, rawEvents) {
  if (!rawEvents.length) return;
  for (const ev of rawEvents) ev.i = w.counter++;
  let chunk = [];
  let bytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    w.emit('claude:events', { id: w.persistentId, events: chunk, hasMore: w.truncated });
    chunk = []; bytes = 0;
  };
  for (const ev of rawEvents) {
    let size = 256;
    try { size = JSON.stringify(ev).length; } catch (_) { /* estimacion por defecto */ }
    if (chunk.length && bytes + size > EMIT_MAX_BYTES) flush();
    chunk.push(ev);
    bytes += size;
  }
  flush();
}

function readInitial(w) {
  let stat;
  try { stat = fs.statSync(w.file); } catch (err) { return scheduleReAttach(w, true); }
  const size = stat.size;
  const start = size > REPLAY_MAX_BYTES ? size - REPLAY_MAX_BYTES : 0;
  let raw;
  try {
    const fd = fs.openSync(w.file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (err) {
    log.warn(`[CLAUDE] no se pudo leer ${w.file}: ${err.message}`);
    return;
  }
  w.truncated = start > 0;
  w.offset = size;
  w.headOffset = start;
  const lines = raw.split('\n');
  if (w.truncated) lines.shift(); // la primera linea del recorte puede venir partida a mitad
  emitEvents(w, parseLines(lines, w.ctx));
}

// Tramo anterior al que ya esta en memoria, para "cargar más" al hacer scroll arriba
function loadMore(persistentId, callback) {
  const cb = typeof callback === 'function' ? callback : () => {};
  const w = watchers.get(persistentId);
  if (!w || !w.file || w.headOffset <= 0) return cb({ events: [], hasMore: false });
  const end = w.headOffset;
  const start = Math.max(0, end - REPLAY_MAX_BYTES);
  let raw;
  try {
    const fd = fs.openSync(w.file, 'r');
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (err) { return cb({ events: [], hasMore: false }); }
  const lines = raw.split('\n');
  if (start > 0) lines.shift();
  const events = parseLines(lines, w.headCtx);
  // events[] viene en orden de fichero (mas viejo -> mas nuevo). Se recorre al
  // reves para que el mas nuevo del tramo (el que enlaza con lo ya cargado)
  // reciba el indice MENOS negativo, y el mas viejo el mas negativo — asi el
  // orden ascendente por "i" sigue siendo cronologico tras anteponer el tramo.
  for (let idx = events.length - 1; idx >= 0; idx--) { w.headCounter -= 1; events[idx].i = w.headCounter; }
  w.headOffset = start;
  cb({ events, hasMore: start > 0 });
}

function onFileChanged(w) {
  let stat;
  try { stat = fs.statSync(w.file); } catch (_) { return scheduleReAttach(w, true); }
  if (stat.size < w.offset) return scheduleReAttach(w, true); // truncado/compactado: re-resolver
  if (stat.size === w.offset) return;
  let raw;
  try {
    const fd = fs.openSync(w.file, 'r');
    const buf = Buffer.alloc(stat.size - w.offset);
    fs.readSync(fd, buf, 0, buf.length, w.offset);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (_) { return; }
  w.offset = stat.size;
  const chunk = w.partial + raw;
  const lines = chunk.split('\n');
  w.partial = lines.pop() || ''; // resto sin \n final, se completa en el proximo tick
  emitEvents(w, parseLines(lines, w.ctx));
}

function stopWatchOnly(w) {
  if (w.fsListener) { try { fs.unwatchFile(w.file, w.fsListener); } catch (_) {} w.fsListener = null; }
  if (w.recheckTimer) { clearInterval(w.recheckTimer); w.recheckTimer = null; }
}

function attachToFile(w, found) {
  w.file = found.file;
  w.sessionId = found.sessionId;
  w.status = 'attached';
  w.offset = 0; w.partial = '';
  w.counter = 0; w.headCounter = 0; w.headOffset = 0;
  w.ctx = createParseContext();
  w.headCtx = createParseContext();
  // reset: lo que viene detras es un replay COMPLETO desde cero. Sin esta senal
  // el cliente apila el historial sobre el que ya tenia y duplica los mensajes
  // en cada reconexion de socket o cada vez que se relanza `claude`.
  w.emit('claude:state', {
    id: w.persistentId, status: 'attached', reset: true,
    file: path.basename(w.file), sessionId: w.sessionId,
  });
  readInitial(w);
  w.fsListener = () => onFileChanged(w);
  fs.watchFile(w.file, { interval: WATCH_INTERVAL_MS }, w.fsListener);
  w.recheckTimer = setInterval(() => recheck(w), RECHECK_MS);
}

// Detecta que se ha lanzado una NUEVA sesion de claude en el mismo PTY
// (el usuario salio y volvio a lanzar `claude`) y re-engancha sobre ese fichero.
function recheck(w) {
  if (!watchers.get(w.persistentId)) return;
  const found = resolveTranscript(w.ptyPid);
  if (found && found.file !== w.file) {
    log.info(`[CLAUDE] ${w.persistentId}: nueva sesion detectada, re-enganchando (${found.sessionId})`);
    stopWatchOnly(w);
    attachToFile(w, found);
  }
}

function trySearch(w) {
  if (!watchers.get(w.persistentId)) return; // detach() gano la carrera
  const found = resolveTranscript(w.ptyPid);
  if (!found) {
    w.status = 'searching';
    w.emit('claude:state', { id: w.persistentId, status: 'searching' });
    w.searchTimer = setTimeout(() => trySearch(w), SEARCH_RETRY_MS);
    return;
  }
  attachToFile(w, found);
}

function scheduleReAttach(w, immediate) {
  stopWatchOnly(w);
  w.status = 'searching';
  w.emit('claude:state', { id: w.persistentId, status: 'searching' });
  w.searchTimer = setTimeout(() => trySearch(w), immediate ? 0 : SEARCH_RETRY_MS);
}

// Engancha (o re-engancha desde cero) el seguimiento del transcript de esta sesion.
function attach(persistentId, ptyPid, emit) {
  detach(persistentId);
  const w = makeWatcher(persistentId, ptyPid, emit);
  watchers.set(persistentId, w);
  trySearch(w);
}

function detach(persistentId) {
  const w = watchers.get(persistentId);
  if (!w) return;
  if (w.searchTimer) clearTimeout(w.searchTimer);
  stopWatchOnly(w);
  watchers.delete(persistentId);
}

module.exports = {
  attach, detach, loadMore,
  // expuestos para tests unitarios (deteccion pura, sin estado de watcher).
  // normalizeLine se re-exporta desde ./claude-normalize por compatibilidad.
  resolveTranscript, normalizeLine, slugify, findClaudePid,
};
