import { state, isMobile, active, parseEscapes, setPref,
         RESIZE_DEBOUNCE_DESKTOP_MS, RESIZE_DEBOUNCE_MOBILE_MS, LONG_PRESS_MS } from './state.js';
import { createSession, switchSession, closeSession, renameTab } from './sessions.js';
let resizeTimer = null;

function doResize() {
  const s = active();
  if (!s) return;
  s.fitAddon.fit();
  if (state.socket && state.socket.connected && s.persistentId) {
    state.socket.emit('resize', { id: s.persistentId, cols: s.term.cols, rows: s.term.rows });
  }
}

function debouncedResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doResize, isMobile ? RESIZE_DEBOUNCE_MOBILE_MS : RESIZE_DEBOUNCE_DESKTOP_MS);
}

window.addEventListener('resize', debouncedResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', debouncedResize);
}

const tabsEl = document.getElementById('tabs');
const buttonsEl = document.getElementById('buttons');

tabsEl.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.tab-close');
  if (closeBtn) { closeSession(closeBtn.dataset.id); return; }
  const tab = e.target.closest('.tab');
  if (tab) switchSession(tab.dataset.id);
});
document.getElementById('tab-new').addEventListener('click', createSession);

let longPressTimer = null;
tabsEl.addEventListener('touchstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || e.target.closest('.tab-close')) return;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    e.preventDefault();
    renameTab(tab);
  }, LONG_PRESS_MS);
}, { passive: false });
tabsEl.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
tabsEl.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
tabsEl.addEventListener('touchcancel', () => { clearTimeout(longPressTimer); });
tabsEl.addEventListener('dblclick', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && !e.target.closest('.tab-close')) renameTab(tab);
});

const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');

export function openSearch() {
  searchBar.classList.add('visible');
  searchInput.value = '';
  searchInput.focus();
}
function closeSearch() {
  searchBar.classList.remove('visible');
  const s = active();
  if (s) { s.searchAddon.clearDecorations(); if (!isMobile) s.term.focus(); }
}
function doSearch(dir) {
  const s = active();
  if (!s || !searchInput.value) return;
  if (dir === 'prev') s.searchAddon.findPrevious(searchInput.value);
  else s.searchAddon.findNext(searchInput.value);
}

document.getElementById('btn-search').addEventListener('click', openSearch);
document.getElementById('search-close').addEventListener('click', closeSearch);
document.getElementById('search-next').addEventListener('click', () => doSearch('next'));
document.getElementById('search-prev').addEventListener('click', () => doSearch('prev'));
searchInput.addEventListener('input', () => doSearch('next'));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next'); }
  if (e.key === 'Escape') closeSearch();
});
document.addEventListener('keydown', (e) => {
  const containerEl = document.getElementById('terminal-container');
  if (e.ctrlKey && e.key === 'f' && containerEl.style.display === 'flex') {
    e.preventDefault();
    openSearch();
  }
});

export function applyFontSize(size) {
  size = Math.max(8, Math.min(28, size));
  state.currentFontSize = size;
  setPref('wibe-fontsize', size);
  state.sessions.forEach((s) => { s.term.options.fontSize = size; });
  doResize();
}

function preventFocusSteal(e) {
  const btn = e.target.closest('button');
  if (btn) e.preventDefault();
}
function blurActiveOnTouch(e) {
  if (!isMobile) return;
  if (!e.target.closest('button')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) a.blur();
}

const shortcutsEl2 = document.getElementById('shortcuts');
shortcutsEl2.addEventListener('mousedown', preventFocusSteal);
shortcutsEl2.addEventListener('touchstart', blurActiveOnTouch, { passive: true });
shortcutsEl2.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !state.socket || !state.socket.connected || !state.activeId) return;
  const s = active();
  if (s && s.persistentId) {
    state.socket.emit('input', { id: s.persistentId, data: btn.dataset.cmd + '\r' });
    if (!isMobile) s.term.focus();
  }
});

buttonsEl.addEventListener('mousedown', preventFocusSteal);
buttonsEl.addEventListener('touchstart', blurActiveOnTouch, { passive: true });
buttonsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !state.socket || !state.socket.connected || !state.activeId) return;
  if (btn.dataset.action === 'bottom') {
    const s = active();
    if (s) s.term.scrollToBottom();
    return;
  }
  if (btn.dataset.action) return;
  const s = active();
  if (s && s.persistentId) {
    state.socket.emit('input', { id: s.persistentId, data: parseEscapes(btn.dataset.key) });
    if (!isMobile) s.term.focus();
  }
});

document.getElementById('btn-copy').addEventListener('click', (e) => {
  e.stopPropagation();
  const s = active();
  if (!s) return;
  const sel = s.term.getSelection();
  if (sel) {
    navigator.clipboard.writeText(sel).then(() => {
      e.target.textContent = 'OK!';
      setTimeout(() => e.target.textContent = 'Copy', 800);
    }).catch(() => {});
  }
});

const pasteOverlay = document.getElementById('paste-overlay');
const pasteInput = document.getElementById('paste-input');

document.getElementById('btn-paste').addEventListener('click', (e) => {
  e.stopPropagation();
  pasteOverlay.style.display = 'flex';
  pasteInput.value = '';
  pasteInput.focus();
  navigator.clipboard.readText()
    .then(text => { if (text) pasteInput.value = text; })
    .catch(() => {});
});

document.getElementById('paste-send').addEventListener('click', () => {
  const text = pasteInput.value;
  const s = active();
  if (text && state.socket && state.socket.connected && s && s.persistentId) {
    state.socket.emit('input', { id: s.persistentId, data: text });
  }
  pasteOverlay.style.display = 'none';
  if (s && !isMobile) s.term.focus();
});

document.getElementById('paste-cancel').addEventListener('click', () => {
  pasteOverlay.style.display = 'none';
  const s = active();
  if (s && !isMobile) s.term.focus();
});

