import { state, isMobile, active, parseEscapes, RESIZE_DEBOUNCE_DESKTOP_MS, RESIZE_DEBOUNCE_MOBILE_MS, LONG_PRESS_MS, notifEnabled, setNotifEnabled, outputTimers } from './state.js';
import { createSession, switchSession, closeSession, renameTab } from './sessions.js';
import { applyTheme, setThemeMode } from './theme.js';

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

function openSearch() {
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

function applyFontSize(size) {
  size = Math.max(8, Math.min(28, size));
  state.currentFontSize = size;
  try { localStorage.setItem('wibe-fontsize', size); } catch (_) {}
  state.sessions.forEach((s) => { s.term.options.fontSize = size; });
  doResize();
}

document.getElementById('btn-font-up').addEventListener('click', () => applyFontSize(state.currentFontSize + 2));
document.getElementById('btn-font-down').addEventListener('click', () => applyFontSize(state.currentFontSize - 2));

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

const fbEl = document.getElementById('filebrowser');
const fbPathEl = document.getElementById('fb-path');
const fbListEl = document.getElementById('fb-list');
let fbCurrentPath = '';

function openFileBrowser(dirPath) {
  if (!state.socket || !state.socket.connected) return;
  state.socket.emit('fs:list', dirPath || '', (res) => {
    if (res.error) return;
    fbCurrentPath = res.path;
    fbPathEl.textContent = res.path;
    fbListEl.innerHTML = '';

    const parentLi = document.createElement('li');
    parentLi.innerHTML = '<span class="fb-icon">..</span><span>Subir</span>';
    parentLi.addEventListener('click', () => {
      const parent = fbCurrentPath.replace(/[\\/][^\\/]+$/, '') || fbCurrentPath;
      openFileBrowser(parent);
    });
    fbListEl.appendChild(parentLi);

    res.items.forEach(item => {
      const li = document.createElement('li');
      const fullPath = fbCurrentPath + '\\' + item.name;
      if (item.isDir) {
        const icon = document.createElement('span');
        icon.className = 'fb-icon';
        icon.textContent = '\u{1F4C1}';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        const selBtn = document.createElement('button');
        selBtn.className = 'fb-select';
        selBtn.textContent = 'Sel';
        li.append(icon, nameSpan, selBtn);
        li.addEventListener('click', (e) => {
          if (e.target.classList.contains('fb-select')) return;
          openFileBrowser(fullPath);
        });
        selBtn.addEventListener('click', () => {
          const as = active();
          if (state.socket && state.socket.connected && as && as.persistentId) {
            const safePath = fullPath.replace(/'/g, "''");
            state.socket.emit('input', { id: as.persistentId, data: "cd '" + safePath + "'\r" });
          }
          closeFileBrowser();
        });
      } else {
        const icon = document.createElement('span');
        icon.className = 'fb-icon';
        icon.textContent = '\u{1F4C4}';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        li.append(icon, nameSpan);
        li.addEventListener('click', () => {
          const as = active();
          if (state.socket && state.socket.connected && as && as.persistentId) {
            const safePath = fullPath.replace(/'/g, "''");
            state.socket.emit('input', { id: as.persistentId, data: "'" + safePath + "'" });
          }
          closeFileBrowser();
        });
      }
      fbListEl.appendChild(li);
    });

    fbEl.style.display = 'flex';
  });
}

function closeFileBrowser() {
  fbEl.style.display = 'none';
  const s = active();
  if (s && !isMobile) s.term.focus();
}

fbEl.addEventListener('click', (e) => { if (e.target === fbEl) closeFileBrowser(); });
document.getElementById('btn-files').addEventListener('click', () => openFileBrowser(''));

const notifBtn = document.getElementById('btn-notif');
const NOTIF_ICONS = { on: '\u{1F514}', off: '\u{1F515}' };

function updateNotifBtn() {
  notifBtn.textContent = notifEnabled ? NOTIF_ICONS.on : NOTIF_ICONS.off;
}
updateNotifBtn();

notifBtn.addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (!notifEnabled && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (Notification.permission === 'denied') return;
  setNotifEnabled(!notifEnabled);
  try { localStorage.setItem('wibe-notif', notifEnabled); } catch (_) {}
  updateNotifBtn();
});

const paletteEl = document.getElementById('palette');
const paletteInputEl = document.getElementById('palette-input');
const paletteListEl = document.getElementById('palette-list');
let paletteIdx = 0;

function getPaletteCommands() {
  const cmds = [
    { name: 'Nueva sesi\u00f3n', hint: '', action: () => createSession() },
    { name: 'Cerrar sesi\u00f3n', hint: '', action: () => { if (state.activeId) closeSession(state.activeId); } },
    { name: 'Tema: Dark', hint: '', action: () => { try { localStorage.setItem('wibe-theme', 'dark'); } catch (_) {} setThemeMode('dark'); applyTheme('dark'); } },
    { name: 'Tema: Light', hint: '', action: () => { try { localStorage.setItem('wibe-theme', 'light'); } catch (_) {} setThemeMode('light'); applyTheme('light'); } },
    { name: 'Tema: Auto', hint: '', action: () => { try { localStorage.setItem('wibe-theme', 'auto'); } catch (_) {} setThemeMode('auto'); applyTheme('auto'); } },
    { name: 'Limpiar terminal', hint: 'cls', action: () => { const s = active(); if (s) s.term.clear(); } },
    { name: 'Copiar selecci\u00f3n', hint: '', action: () => { const s = active(); if (s) { const sel = s.term.getSelection(); if (sel) navigator.clipboard.writeText(sel); } } },
    { name: 'Pegar', hint: '', action: () => document.getElementById('btn-paste').click() },
    { name: 'Explorar archivos', hint: '', action: () => openFileBrowser('') },
    { name: 'Buscar en terminal', hint: 'Ctrl+F', action: () => openSearch() },
    { name: 'Letra m\u00e1s grande', hint: 'A+', action: () => applyFontSize(state.currentFontSize + 2) },
    { name: 'Letra m\u00e1s peque\u00f1a', hint: 'A-', action: () => applyFontSize(state.currentFontSize - 2) },
  ];
  state.sessions.forEach((s, id) => {
    const num = id.replace('ses-', '');
    cmds.push({ name: `Ir a Shell ${num}`, hint: '', action: () => switchSession(id) });
  });
  return cmds;
}

function renderPalette() {
  const q = paletteInputEl.value.toLowerCase();
  const cmds = getPaletteCommands().filter(c => c.name.toLowerCase().includes(q));
  paletteListEl.innerHTML = '';
  cmds.forEach((c, i) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = c.name;
    li.appendChild(nameSpan);
    if (c.hint) {
      const hintSpan = document.createElement('span');
      hintSpan.className = 'hint';
      hintSpan.textContent = c.hint;
      li.appendChild(hintSpan);
    }
    if (i === paletteIdx) li.classList.add('selected');
    li.addEventListener('click', () => { closePalette(); c.action(); });
    paletteListEl.appendChild(li);
  });
  if (paletteIdx >= cmds.length) paletteIdx = Math.max(0, cmds.length - 1);
}

function openPalette() {
  paletteEl.style.display = 'flex';
  paletteInputEl.value = '';
  paletteIdx = 0;
  renderPalette();
  paletteInputEl.focus();
}

function closePalette() {
  paletteEl.style.display = 'none';
  const s = active();
  if (s && !isMobile) s.term.focus();
}

paletteInputEl.addEventListener('input', () => { paletteIdx = 0; renderPalette(); });
paletteInputEl.addEventListener('keydown', (e) => {
  const items = paletteListEl.querySelectorAll('li');
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, items.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (items[paletteIdx]) items[paletteIdx].click(); }
  else if (e.key === 'Escape') { closePalette(); }
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

document.getElementById('btn-palette').addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); openPalette(); }
});
