// Editor de archivos ligero: textarea + numeros de linea propios, sin
// dependencias (CodeMirror serian ~400 KB que ademas habria que vendorizar por
// la CSP, y aqui se trata de retocar un fichero desde el movil).
//
// Es MODAL y cubre la app a proposito: asi no se puede cambiar de tab ni de
// sesion con cambios pendientes, lo que elimina de raiz una clase entera de
// bugs de estado cruzado.
import { el, fmtBytes, basename, shortPath } from './render/dom.js';
import { readFile, writeFile, downloadUrl } from './fsapi.js';

const overlay = document.getElementById('c-editor');
const nameEl = document.getElementById('ce-name');
const dirEl = document.getElementById('ce-dir');
const dirtyEl = document.getElementById('ce-dirty');
const areaEl = document.getElementById('ce-area');
const gutterEl = document.getElementById('ce-gutter');
const saveBtn = document.getElementById('ce-save');
const closeBtn = document.getElementById('ce-close');
const wrapBtn = document.getElementById('ce-wrap');
const bannerEl = document.getElementById('ce-banner');
const toastEl = document.getElementById('ce-toast');

const DRAFT_PREFIX = 'wibe-claude-draft:';
const DRAFT_MAX = 256 * 1024;
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
const SOFT_WARN_BYTES = 256 * 1024;
const BIG_FILE_LINES = 5000;

let file = null;      // { path, name, dir, etag, eol, bom }
let baseline = '';    // contenido tal y como esta en disco
let dirty = false;
let lastLineCount = -1;
let gutterTimer = null;
let draftTimer = null;

// === Utilidades ===

function toast(msg, tone) {
  toastEl.textContent = msg;
  toastEl.className = 'ce-toast visible' + (tone ? ' ce-toast--' + tone : '');
  setTimeout(() => { toastEl.className = 'ce-toast'; }, 3000);
}

function clearBanner() { bannerEl.replaceChildren(); bannerEl.style.display = 'none'; }

function showBanner(text, actions) {
  bannerEl.replaceChildren(el('span', 'ce-banner-text', text));
  for (const [label, fn] of actions) {
    const b = el('button', 'ce-banner-btn', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    bannerEl.appendChild(b);
  }
  bannerEl.style.display = 'flex';
}

function setDirty(next) {
  dirty = next;
  dirtyEl.style.display = next ? 'inline-block' : 'none';
  saveBtn.disabled = !next;
  // beforeunload solo mientras hay cambios: registrarlo siempre penaliza el
  // bfcache del navegador sin dar nada a cambio.
  if (next) window.addEventListener('beforeunload', warnUnload);
  else window.removeEventListener('beforeunload', warnUnload);
}

function warnUnload(e) { e.preventDefault(); e.returnValue = ''; }

// === Numeros de linea ===

// Se reconstruye SOLO cuando cambia el numero de lineas, y con un unico
// textContent (un solo nodo de texto): reconstruir un span por linea en cada
// pulsacion hace inusable un fichero mediano en el movil.
function syncGutter(force) {
  const count = areaEl.value.split('\n').length;
  if (!force && count === lastLineCount) return;
  lastLineCount = count;
  const nums = new Array(count);
  for (let i = 0; i < count; i++) nums[i] = i + 1;
  gutterEl.textContent = nums.join('\n');
}

function scheduleGutter() {
  if (lastLineCount < BIG_FILE_LINES) { syncGutter(); return; }
  if (gutterTimer) clearTimeout(gutterTimer);
  gutterTimer = setTimeout(() => { gutterTimer = null; syncGutter(); }, 100);
}

// === Borradores ===
// La red de seguridad real: en movil el navegador mata pestanas de fondo sin
// avisar y beforeunload no es fiable en iOS Safari.

function draftKey(p) { return DRAFT_PREFIX + p; }

function saveDraft() {
  if (!file || !dirty) return;
  const value = areaEl.value;
  if (value.length > DRAFT_MAX) return;
  try {
    localStorage.setItem(draftKey(file.path), JSON.stringify({ content: value, etag: file.etag, savedAt: Date.now() }));
  } catch (_) { /* cuota llena: el editor sigue funcionando, solo sin red */ }
}

function dropDraft() {
  if (!file) return;
  try { localStorage.removeItem(draftKey(file.path)); } catch (_) { /* nada que hacer */ }
}

function readDraft(p) {
  try {
    const raw = localStorage.getItem(draftKey(p));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function purgeOldDrafts() {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(DRAFT_PREFIX)) continue;
      const d = JSON.parse(localStorage.getItem(key) || '{}');
      if (!d.savedAt || d.savedAt < cutoff) localStorage.removeItem(key);
    }
  } catch (_) { /* localStorage inaccesible: nada que purgar */ }
}

// === Contenido ===

function setContent(text) {
  areaEl.value = text;
  baseline = text;
  lastLineCount = -1;
  syncGutter(true);
  setDirty(false);
}

// === API ===

export function isEditorOpen() { return overlay.style.display === 'flex'; }
export function isDirty() { return dirty; }

export async function openEditor(fullPath, name) {
  purgeOldDrafts();
  overlay.style.display = 'flex';
  clearBanner();
  nameEl.textContent = name || basename(fullPath);
  dirEl.textContent = '';
  areaEl.value = '';
  areaEl.disabled = true;
  gutterEl.textContent = '';
  saveBtn.disabled = true;

  const res = await readFile(fullPath);
  if (!res.ok) {
    areaEl.disabled = true;
    const detail = res.status === 415 ? 'No es un archivo de texto.'
      : res.status === 413 ? `Demasiado grande (${fmtBytes(res.meta.size || 0)}).`
        : res.error;
    showBanner(detail, [
      ['Descargar', () => { window.location.href = downloadUrl(fullPath); }],
      ['Cerrar', () => closeEditor({ force: true })],
    ]);
    return;
  }

  file = {
    path: res.data.path, name: res.data.name, dir: res.data.dir,
    etag: res.data.etag, eol: res.data.eol, bom: res.data.bom,
  };
  nameEl.textContent = file.name;
  dirEl.textContent = shortPath(file.dir, 2);
  dirEl.title = file.dir;
  areaEl.disabled = false;
  setContent(res.data.content);

  if (res.data.size > SOFT_WARN_BYTES) toast('Archivo grande: la edición puede ir lenta', 'warn');

  const draft = readDraft(file.path);
  if (draft && draft.content !== res.data.content) {
    showBanner('Hay cambios sin guardar de una sesión anterior.', [
      ['Restaurar', () => { areaEl.value = draft.content; syncGutter(true); setDirty(true); clearBanner(); }],
      ['Descartar', () => { dropDraft(); clearBanner(); }],
    ]);
  }
}

async function doSave(overrideEtag) {
  if (!file) return;
  saveBtn.disabled = true;
  const content = areaEl.value;
  const res = await writeFile(file.path, {
    content, eol: file.eol, bom: file.bom, etag: overrideEtag || file.etag,
  });

  if (res.ok) {
    file.etag = res.data.etag;
    baseline = content;
    setDirty(false);
    dropDraft();
    clearBanner();
    toast('Guardado', 'ok');
    return;
  }

  saveBtn.disabled = false;
  if (res.status === 412) {
    // Sobrescribir NO usa If-Match:*: relee el etag actual y reenvia, para que
    // la ventana de carrera siga siendo estrecha y la semantica siga siendo honesta.
    showBanner('El archivo cambió en disco.', [
      ['Recargar', async () => {
        const fresh = await readFile(file.path);
        if (!fresh.ok) { toast(fresh.error, 'err'); return; }
        file.etag = fresh.data.etag;
        setContent(fresh.data.content);
        dropDraft();
        clearBanner();
      }],
      ['Sobrescribir', async () => {
        const fresh = await readFile(file.path);
        if (!fresh.ok) { toast(fresh.error, 'err'); return; }
        await doSave(fresh.data.etag);
      }],
      ['Cancelar', clearBanner],
    ]);
    return;
  }
  // Cualquier otro fallo deja el editor abierto y el contenido sucio: no se
  // pierde nada de lo escrito.
  toast(res.error, 'err');
}

export function closeEditor({ force = false } = {}) {
  if (dirty && !force) {
    showBanner('Tienes cambios sin guardar.', [
      ['Guardar y cerrar', async () => { await doSave(); if (!dirty) closeEditor({ force: true }); }],
      ['Descartar', () => { dropDraft(); setDirty(false); closeEditor({ force: true }); }],
      ['Seguir editando', clearBanner],
    ]);
    return false;
  }
  setDirty(false);
  overlay.style.display = 'none';
  file = null;
  clearBanner();
  return true;
}

export function initEditor() {
  // wrap="off" por defecto: con ajuste de linea una linea logica ocupa N filas
  // visuales y la numeracion mentiria. El boton cambia a soft wrap y OCULTA el
  // gutter, que es lo honesto.
  areaEl.setAttribute('wrap', 'off');

  areaEl.addEventListener('input', () => {
    scheduleGutter();
    if (areaEl.value !== baseline) setDirty(true);
    else setDirty(false);
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1000);
  });

  areaEl.addEventListener('scroll', () => { gutterEl.scrollTop = areaEl.scrollTop; }, { passive: true });

  areaEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) doSave(); return; }
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    // execCommand esta deprecado pero es lo unico que PRESERVA la pila de
    // undo nativa; setRangeText la rompe. El fallback la sacrifica.
    let inserted;
    try { inserted = document.execCommand('insertText', false, '  '); } catch (_) { inserted = false; }
    if (!inserted) {
      const { selectionStart: s, selectionEnd: t } = areaEl;
      areaEl.setRangeText('  ', s, t, 'end');
      areaEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  saveBtn.addEventListener('click', () => doSave());
  closeBtn.addEventListener('click', () => closeEditor());
  wrapBtn.addEventListener('click', () => {
    const soft = areaEl.getAttribute('wrap') === 'soft';
    areaEl.setAttribute('wrap', soft ? 'off' : 'soft');
    overlay.classList.toggle('ce-wrapped', !soft);
    wrapBtn.classList.toggle('active', !soft);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isEditorOpen() && document.activeElement !== areaEl) closeEditor();
  });
}
