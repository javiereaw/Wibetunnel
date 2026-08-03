// Cabecera de /claude: titulo, chips de contexto (carpeta, rama, modelo,
// tokens), menu y barra de busqueda.
//
// Los contadores de tokens salen de transcript.stats, que acumula stream.js; el
// render no recorre nada. Se muestran DOS cifras porque significan cosas
// distintas: el acumulado de la sesion, y la ventana de contexto en uso ahora
// mismo — esta ultima es la que responde a "¿cuánto me queda?".
import { el, fmtTokens, shortModel, basename } from './render/dom.js';
import { search, gotoHit } from './render/search.js';
import { getPref, setPref } from '../state.js';

const titleEl = document.getElementById('c-title');
const ctxEl = document.getElementById('c-ctx');
const menuEl = document.getElementById('c-menu');
const searchBar = document.getElementById('c-search');
const searchInput = document.getElementById('c-search-input');
const searchCount = document.getElementById('c-search-count');

let hooks = {};
let hits = [];
let hitIndex = 0;
let debounce = null;

function chip(icon, text, title) {
  const c = el('span', 'c-ctx-chip');
  if (icon) c.appendChild(el('span', null, icon));
  c.appendChild(el('span', null, text));
  if (title) c.title = title;
  return c;
}

// Se llama tras cada lote de eventos y al cambiar de tab.
export function renderChrome(transcript) {
  const info = (transcript && transcript.info) || {};
  const stats = (transcript && transcript.stats) || {};

  titleEl.textContent = info.title || basename(info.cwd) || 'Claude';
  titleEl.title = info.cwd || '';

  const chips = [];
  if (info.cwd) chips.push(chip('\u{1F4C1}', basename(info.cwd), info.cwd));
  if (info.gitBranch && info.gitBranch !== 'HEAD') chips.push(chip('\u{2442}', info.gitBranch));
  if (stats.model) chips.push(chip('\u{273B}', shortModel(stats.model)));
  if (stats.ctx) chips.push(chip('', 'ctx ' + fmtTokens(stats.ctx), 'ventana de contexto en uso ahora'));
  if (stats.inTotal || stats.outTotal) {
    chips.push(chip('', `\u{2191}${fmtTokens(stats.inTotal)} \u{2193}${fmtTokens(stats.outTotal)}`, 'acumulado de la sesión'));
  }
  if (info.version) chips.push(chip('', 'v' + info.version));
  ctxEl.replaceChildren(...chips);
  ctxEl.style.display = chips.length ? 'flex' : 'none';
}

// === Busqueda ===

function paintCount() {
  searchCount.textContent = hits.length ? `${hitIndex + 1}/${hits.length}` : (searchInput.value.trim().length > 1 ? '0' : '');
}

function runSearch() {
  hits = search(hooks.getItems(), searchInput.value);
  hitIndex = 0;
  paintCount();
  if (hits.length) gotoHit(hits[0], hooks.nodeFor, hooks.openCard);
}

function step(delta) {
  if (!hits.length) return;
  hitIndex = (hitIndex + delta + hits.length) % hits.length;
  paintCount();
  gotoHit(hits[hitIndex], hooks.nodeFor, hooks.openCard);
}

export function toggleSearch(force) {
  const open = force !== undefined ? force : searchBar.style.display !== 'flex';
  searchBar.style.display = open ? 'flex' : 'none';
  if (open) searchInput.focus();
  else { searchInput.value = ''; hits = []; paintCount(); }
}

// === Menu ===

function toggleMenu(force) {
  const open = force !== undefined ? force : menuEl.style.display !== 'block';
  menuEl.style.display = open ? 'block' : 'none';
}

export function initChrome(h) {
  hooks = h || {};

  document.getElementById('c-btn-search').addEventListener('click', () => { toggleMenu(false); toggleSearch(); });
  document.getElementById('c-btn-menu').addEventListener('click', (e) => { e.stopPropagation(); toggleSearch(false); toggleMenu(); });
  document.addEventListener('click', (e) => {
    if (menuEl.style.display === 'block' && !menuEl.contains(e.target)) toggleMenu(false);
  });

  document.getElementById('c-search-prev').addEventListener('click', () => step(-1));
  document.getElementById('c-search-next').addEventListener('click', () => step(1));
  document.getElementById('c-search-close').addEventListener('click', () => toggleSearch(false));
  searchInput.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runSearch, 150);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (hits.length) step(e.shiftKey ? -1 : 1); else runSearch(); }
    if (e.key === 'Escape') toggleSearch(false);
  });

  // Interruptor de densidad: oculta en bloque las notas de bookkeeping.
  const noiseBtn = document.getElementById('c-menu-noise');
  const applyNoise = (hidden) => {
    hooks.setNoiseHidden(hidden);
    noiseBtn.textContent = hidden ? 'Mostrar eventos de sistema' : 'Ocultar eventos de sistema';
  };
  applyNoise(getPref('wibe-claude-noise', '1') === '1');
  noiseBtn.addEventListener('click', () => {
    const next = getPref('wibe-claude-noise', '1') !== '1';
    setPref('wibe-claude-noise', next ? '1' : '0');
    applyNoise(next);
    toggleMenu(false);
  });

  // theme.js sigue siendo el dueño del tema; el botón real está oculto en el
  // toolbar (no gasta hueco) y aquí solo se dispara y se refleja su icono.
  const themeBtn = document.getElementById('c-menu-theme');
  const themeToggle = document.getElementById('theme-toggle');
  const syncTheme = () => { themeBtn.textContent = 'Cambiar tema  ' + themeToggle.textContent; };
  syncTheme();
  themeBtn.addEventListener('click', () => {
    themeToggle.click();
    syncTheme();
    toggleMenu(false);
  });
}
