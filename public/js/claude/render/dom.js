// Helpers de construccion de DOM y formateo, compartidos por todo el render.
// Regla de la casa: todo se construye con createElement/textContent. El unico
// sitio donde entra HTML es el markdown, que escapa primero (ver render/md.js).

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

export function chip(text, tone) {
  return el('span', 'c-chip' + (tone ? ' c-chip--' + tone : ''), text);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

function toDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtTime(ts) {
  const d = toDate(ts);
  return d ? timeFmt.format(d) : '';
}

export function fmtFullTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleString() : '';
}

// Clave de agrupacion por dia local (no UTC: el separador debe cuadrar con el
// dia que ve el usuario, no con el que guardo el JSONL).
export function dayKey(ts) {
  const d = toDate(ts);
  if (!d) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function fmtDay(ts) {
  const d = toDate(ts);
  if (!d) return '';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey(d) === dayKey(today)) return 'Hoy';
  if (dayKey(d) === dayKey(yesterday)) return 'Ayer';
  return dayFmt.format(d);
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} m ${rest} s` : `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const OUTPUT_LINE_CAP = 400;

// Bloque de texto plano capado por lineas. Nunca descarta: el resto queda a un
// tap de distancia, porque un output truncado en silencio miente.
export function cappedBlock(text, cls, cap = OUTPUT_LINE_CAP) {
  const frag = document.createDocumentFragment();
  const str = typeof text === 'string' ? text : String(text == null ? '' : text);
  const lines = str.split('\n');
  const pre = el('pre', cls);
  if (lines.length <= cap) {
    pre.textContent = str;
    frag.appendChild(pre);
    return frag;
  }
  pre.textContent = lines.slice(0, cap).join('\n');
  frag.appendChild(pre);
  const btn = el('button', 'c-show-all', `Mostrar todo (${lines.length} líneas)`);
  btn.addEventListener('click', () => { pre.textContent = str; btn.remove(); });
  frag.appendChild(btn);
  return frag;
}

// stdout / stderr etiquetados por separado
export function streamBlock(text, label, isErr) {
  if (!text) return null;
  const box = el('div', 'c-stream' + (isErr ? ' c-stream--err' : ''));
  box.appendChild(el('div', 'c-stream-label', label));
  box.appendChild(cappedBlock(text, 'c-card-output'));
  return box;
}

// Tabla clave/valor: mucho mas legible que JSON.stringify para inputs planos.
export function kvTable(obj) {
  const table = el('table', 'c-kv');
  for (const [k, v] of Object.entries(obj || {})) {
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, typeof v === 'string' ? v : JSON.stringify(v)));
    table.appendChild(tr);
  }
  return table;
}

// true si el objeto es lo bastante plano y corto como para caber en una kvTable
export function isFlatSmall(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const entries = Object.entries(obj);
  if (!entries.length || entries.length > 12) return false;
  return entries.every(([, v]) => (typeof v !== 'object' || v === null)
    && String(v).length < 200 && !String(v).includes('\n'));
}

export function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// Ruta acortada a sus ultimos segmentos: "…/render/hl.js". Se hace en JS y no
// con CSS porque elipsar por la izquierda requiere direction:rtl, que reordena
// la puntuacion de los extremos y deja rutas ilegibles.
export function shortPath(p, segments = 2) {
  if (!p) return '';
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  if (parts.length <= segments) return String(p);
  return '…/' + parts.slice(-segments).join('/');
}

// "claude-opus-5[1m]" -> "opus-5 1M"; nunca devuelve el id crudo entero.
export function shortModel(model) {
  if (!model) return '';
  let m = String(model).replace(/^claude-/, '');
  const long = /\[1m\]$/i.test(m);
  m = m.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
  return long ? m + ' 1M' : m;
}
