// Indicador de "que esta haciendo Claude ahora mismo".
//
// Fusiona dos fuentes porque ninguna basta sola: el transcript JSONL sabe que
// herramienta esta en curso pero se escribe con retraso, y el buffer del PTY ve
// la actividad al instante pero no sabe interpretarla. La prioridad es siempre
// el prompt de permiso: es lo unico que bloquea a Claude esperandote.
const peekEl = document.getElementById('c-peek');
const labelEl = document.getElementById('c-peek-label');
const elapsedEl = document.getElementById('c-peek-elapsed');

const IDLE_AFTER_MS = 2500; // sin salida del PTY durante este rato = en reposo

let kind = 'idle';   // 'idle' | 'working' | 'tool' | 'permission'
let detail = '';
let since = 0;
let lastOutput = 0;
let ticker = null;

function label() {
  if (kind === 'permission') return 'Esperando tu respuesta';
  if (kind === 'tool') return 'Ejecutando ' + detail;
  if (kind === 'working') return 'Trabajando…';
  return 'En vivo';
}

function paint() {
  const working = kind === 'tool' || kind === 'working';
  peekEl.classList.toggle('c-working', working);
  labelEl.textContent = label();
  if (!working || !since) { elapsedEl.textContent = ''; return; }
  const s = Math.round((Date.now() - since) / 1000);
  elapsedEl.textContent = s < 60 ? s + 's' : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    // El PTY lleva callado un rato y no hay herramienta en curso: reposo.
    if (kind === 'working' && Date.now() - lastOutput > IDLE_AFTER_MS) setState('idle');
    else paint();
  }, 1000);
}

export function setState(next, nextDetail) {
  if (next === kind && nextDetail === detail) { paint(); return; }
  // El cronometro solo se reinicia al empezar a trabajar, no al cambiar de
  // herramienta dentro del mismo turno: lo util es "llevo 40s", no "llevo 2s".
  const wasWorking = kind === 'tool' || kind === 'working';
  const willWork = next === 'tool' || next === 'working';
  kind = next;
  detail = nextDetail || '';
  if (willWork && !wasWorking) since = Date.now();
  if (!willWork) since = 0;
  paint();
}

// Se llama en cada chunk de salida del PTY de la sesion activa.
export function noteOutput() {
  lastOutput = Date.now();
  if (kind === 'idle') setState('working');
}

// Deriva el estado del transcript: si la ultima herramienta sigue pendiente,
// eso es mas informativo que un generico "trabajando".
export function syncFromTranscript(transcript) {
  if (kind === 'permission') return;
  const items = transcript ? transcript.items : null;
  if (!items || !items.length) return;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== 'tool') continue;
    if (it.status === 'pending') setState('tool', it.name || 'herramienta');
    else if (kind === 'tool') setState(Date.now() - lastOutput < IDLE_AFTER_MS ? 'working' : 'idle');
    return;
  }
}

export function initStatus() { ensureTicker(); paint(); }

export function resetStatus() { setState('idle'); lastOutput = 0; }
