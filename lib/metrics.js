// Metricas en memoria: contadores monotonicos desde el arranque + eventos JSONL.
// Sin timers ni persistencia: journald guarda el historico via lineas [EVT], y
// startedAt desambigua los resets por reinicio. Cero dependencias.
const log = require('./log');

const counters = {
  reconnects: 0, takeovers: 0, adoptions: 0,
  authOk: 0, authFail: 0, authRatelimited: 0,
  ptySpawns: 0, ptyKills: 0, ptyExits: 0, orphansExpired: 0,
  bytesOut: 0, bpPauses: 0, bpResumes: 0,
  uploads: 0, downloads: 0,
  fileReads: 0, fileWrites: 0, fileConflicts: 0,
};
const errors = {}; // tag → count
const startedAt = new Date().toISOString();

function inc(name, n = 1) {
  if (typeof counters[name] === 'number' && Number.isFinite(n)) counters[name] += n;
}

function err(tag) {
  errors[tag] = (errors[tag] || 0) + 1;
}

// Evento significativo como JSONL grep-able (prefijo [EVT]); journald pone el timestamp
function event(type, fields) {
  try {
    log.info('[EVT]', JSON.stringify({ evt: type, ...fields }));
  } catch (_) { /* un campo no serializable no debe tumbar nada */ }
}

function snapshot() {
  return { ...counters, errors: { ...errors }, startedAt };
}

module.exports = { inc, err, event, snapshot };
