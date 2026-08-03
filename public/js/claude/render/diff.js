// Diff unificado a partir del structuredPatch que ya trae el JSONL, con
// resaltado intra-linea por palabras.
//
// El resaltado por palabras es lo que mas legibilidad aporta en un movil: sin
// el, cambiar un identificador en una linea de 120 caracteres pinta la linea
// entera en rojo y en verde y hay que buscar la diferencia a ojo.
import { el } from './dom.js';

const MAX_LINES = 140;          // por card; el resto se despliega bajo demanda
const WORD_DIFF_MAX_TOKENS = 220; // tope del LCS: es O(n*m)
const SIMILARITY_MIN = 0.5;     // por debajo, dos lineas no son "la misma editada"

function tokenize(s) { return s.match(/\s+|[A-Za-z0-9_$]+|[^\s]/g) || []; }

// Matriz LCS clasica. Solo se llama con <=220 tokens por lado.
function lcsFlags(a, b) {
  const n = a.length, m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const keepA = new Array(n).fill(false);
  const keepB = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keepA[i] = true; keepB[j] = true; i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return { keepA, keepB, common: keepA.filter(Boolean).length };
}

// Devuelve [fragDel, fragAdd] con los tokens que cambian envueltos en .c-dl-word,
// o null si las dos lineas no se parecen lo bastante como para compararlas.
function wordDiff(oldText, newText) {
  const a = tokenize(oldText), b = tokenize(newText);
  if (!a.length || !b.length) return null;
  if (a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) return null;
  const { keepA, keepB, common } = lcsFlags(a, b);
  if (common / Math.max(a.length, b.length) < SIMILARITY_MIN) return null;
  const build = (tokens, keep) => {
    const frag = document.createDocumentFragment();
    let buf = '', bufChanged = false;
    const flush = () => {
      if (!buf) return;
      frag.appendChild(bufChanged ? el('span', 'c-dl-word', buf) : document.createTextNode(buf));
      buf = '';
    };
    tokens.forEach((tok, idx) => {
      const changed = !keep[idx];
      if (changed !== bufChanged) { flush(); bufChanged = changed; }
      buf += tok;
    });
    flush();
    return frag;
  };
  return [build(a, keepA), build(b, keepB)];
}

function diffLine(sign, oldNum, newNum, content) {
  const cls = sign === '+' ? 'c-dl-add' : sign === '-' ? 'c-dl-del' : 'c-dl-ctx';
  const row = el('div', 'c-dl ' + cls);
  row.append(
    el('span', 'c-dl-num c-dl-num-old', oldNum == null ? '' : oldNum),
    el('span', 'c-dl-num', newNum == null ? '' : newNum),
  );
  const text = el('span', 'c-dl-text');
  if (content instanceof Node) text.appendChild(content);
  else text.textContent = (sign === ' ' ? ' ' : sign) + content;
  row.appendChild(text);
  return row;
}

// Empareja rachas -/- seguidas de +/+ para el diff por palabras.
function emitBlock(out, dels, adds, oldStart, newStart) {
  const paired = dels.length === adds.length ? dels.length : 0;
  for (let k = 0; k < dels.length; k++) {
    const w = k < paired ? wordDiff(dels[k], adds[k]) : null;
    if (w) {
      const frag = document.createDocumentFragment();
      frag.append(document.createTextNode('-'), w[0]);
      out.push(diffLine('-', oldStart + k, null, frag));
    } else {
      out.push(diffLine('-', oldStart + k, null, dels[k]));
    }
  }
  for (let k = 0; k < adds.length; k++) {
    const w = k < paired ? wordDiff(dels[k], adds[k]) : null;
    if (w) {
      const frag = document.createDocumentFragment();
      frag.append(document.createTextNode('+'), w[1]);
      out.push(diffLine('+', null, newStart + k, frag));
    } else {
      out.push(diffLine('+', null, newStart + k, adds[k]));
    }
  }
}

function hunkRows(hunk) {
  const rows = [];
  let oldNum = hunk.oldStart || 1;
  let newNum = hunk.newStart || 1;
  let dels = [], adds = [], delStart = oldNum, addStart = newNum;
  const flush = () => {
    if (dels.length || adds.length) emitBlock(rows, dels, adds, delStart, addStart);
    dels = []; adds = [];
  };
  for (const raw of hunk.lines || []) {
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '-') {
      if (!dels.length) delStart = oldNum;
      dels.push(text); oldNum++;
    } else if (sign === '+') {
      if (!adds.length) addStart = newNum;
      adds.push(text); newNum++;
    } else {
      flush();
      rows.push(diffLine(' ', oldNum, newNum, text));
      oldNum++; newNum++;
      delStart = oldNum; addStart = newNum;
    }
  }
  flush();
  return rows;
}

// Cuenta de +/- de un patch, para el chip de la cabecera.
export function patchStats(hunks) {
  let added = 0, removed = 0;
  for (const h of hunks || []) {
    for (const raw of h.lines || []) {
      if (raw[0] === '+') added++;
      else if (raw[0] === '-') removed++;
    }
  }
  return { added, removed };
}

export function renderPatch(hunks, opts = {}) {
  const box = el('div', 'c-diff');
  if (!Array.isArray(hunks) || !hunks.length) {
    box.appendChild(el('div', 'c-pending', 'Sin cambios en el patch'));
    return box;
  }
  const max = opts.maxLines || MAX_LINES;
  const all = [];
  for (const h of hunks) {
    all.push(el('div', 'c-hunk-head', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    all.push(...hunkRows(h));
  }
  const shown = all.slice(0, max);
  box.append(...shown);
  if (all.length > max) {
    const btn = el('button', 'c-show-all', `Mostrar ${all.length - max} líneas más`);
    btn.addEventListener('click', () => { btn.replaceWith(...all.slice(max)); });
    box.appendChild(btn);
  }
  return box;
}

// Diff de dos textos sueltos, para un Edit sin structuredPatch (poco comun:
// solo si el resultado estructurado no llego o vino recortado).
export function renderInlinePair(oldStr, newStr) {
  const box = el('div', 'c-diff');
  const w = wordDiff(oldStr || '', newStr || '');
  if (w) {
    const d = document.createDocumentFragment(); d.append(document.createTextNode('-'), w[0]);
    const a = document.createDocumentFragment(); a.append(document.createTextNode('+'), w[1]);
    box.append(diffLine('-', null, null, d), diffLine('+', null, null, a));
  } else {
    box.append(diffLine('-', null, null, oldStr || ''), diffLine('+', null, null, newStr || ''));
  }
  return box;
}
