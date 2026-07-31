// Tira "en vivo": lo que el transcript JSONL NO tiene (spinner, contador de
// tokens, y sobre todo los prompts de permiso de Claude Code) leido del buffer
// real de xterm tras cada 'output'. Heuristico a proposito — el modo Terminal
// es siempre la via de escape fiable si esto falla en detectar algo.
const peekEl = document.getElementById('c-peek');
const peekBody = document.getElementById('c-peek-body');
const peekChips = document.getElementById('c-peek-chips');
const peekToggle = document.getElementById('c-peek-toggle');

let lastSignature = null;

function readTailLines(term, n) {
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - n);
  const lines = [];
  for (let y = start; y < total; y++) {
    const line = buf.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

// Diálogos de permiso de Claude Code: pregunta + lista numerada de opciones
// (p.ej. "❯ 1. Yes"). Exige >=2 opciones para no disparar con falsos positivos.
function detectPrompt(lines) {
  const text = lines.join('\n');
  if (!/do you want|would you like to proceed|proceed\?/i.test(text)) return null;
  const options = [];
  for (const line of lines) {
    const m = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/);
    if (m) options.push({ num: m[1], label: m[2] });
  }
  return options.length >= 2 ? options : null;
}

export function initPeek(onChip) {
  peekToggle.addEventListener('click', () => peekEl.classList.toggle('expanded'));
  peekChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-send]');
    if (btn) onChip(btn.dataset.send);
  });
}

// Se llama tras cada output nuevo del PTY de la sesion activa
export function updatePeek(term) {
  if (!term) return;
  const lines = readTailLines(term, 24);
  const nonEmpty = lines.filter((l) => l.trim());
  peekBody.textContent = nonEmpty.slice(-6).join('\n');

  const options = detectPrompt(lines);
  if (!options) {
    lastSignature = null;
    peekEl.classList.remove('has-prompt');
    return;
  }
  peekEl.classList.add('has-prompt', 'expanded');
  const signature = options.map((o) => o.num).join(',');
  if (signature === lastSignature) return; // mismos chips ya pintados
  lastSignature = signature;
  peekChips.innerHTML = '';
  for (const o of options) {
    const b = document.createElement('button');
    b.dataset.send = o.num + '\r';
    b.textContent = `${o.num}. ${o.label.slice(0, 22)}`;
    peekChips.appendChild(b);
  }
  const esc = document.createElement('button');
  esc.dataset.send = '\x1b';
  esc.textContent = 'Esc';
  peekChips.appendChild(esc);
}

export function resetPeek() {
  lastSignature = null;
  peekBody.textContent = '';
  peekChips.innerHTML = '';
  peekEl.classList.remove('has-prompt', 'expanded');
}
