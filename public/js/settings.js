import { state, getPref, setPref, notifEnabled, setNotifEnabled } from './state.js';
import { setThemeMode, applyTheme, currentThemeMode } from './theme.js';
import { applyFontSize } from './ui.js';

let _serverShortcuts = [];

// === Shortcuts bar (server shortcuts + user snippets) ===

export function initShortcuts(serverShortcuts) {
  _serverShortcuts = serverShortcuts || [];
  renderShortcuts();
}

export function renderShortcuts() {
  const el = document.getElementById('shortcuts');
  el.innerHTML = '';
  const all = [..._serverShortcuts, ...getUserSnippets()];
  if (all.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  all.forEach(s => {
    const btn = document.createElement('button');
    btn.textContent = s.label;
    btn.dataset.cmd = s.cmd;
    el.appendChild(btn);
  });
}

function getUserSnippets() {
  try { return JSON.parse(getPref('wibe-snippets', '[]')); } catch { return []; }
}

function saveUserSnippets(snippets) {
  setPref('wibe-snippets', JSON.stringify(snippets));
  renderShortcuts();
  renderSnippetsList();
}

// === Font family ===

export function applyFontFamily(family) {
  document.documentElement.style.setProperty('--mono-font', family);
  setPref('wibe-fontfamily', family);
  state.sessions.forEach(s => {
    s.term.options.fontFamily = family;
    s.fitAddon.fit();
    if (state.socket && state.socket.connected && s.persistentId) {
      state.socket.emit('resize', { id: s.persistentId, cols: s.term.cols, rows: s.term.rows });
    }
  });
}

// === Settings overlay ===

const settingsEl = document.getElementById('settings');

export function openSettings() {
  syncSettingsUI();
  settingsEl.style.display = 'flex';
}

export function closeSettings() {
  settingsEl.style.display = 'none';
}

function syncSettingsUI() {
  document.getElementById('settings-font-size').textContent = state.currentFontSize;
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === currentThemeMode);
  });
  const fontSel = document.getElementById('settings-font-family');
  if (fontSel) fontSel.value = getPref('wibe-fontfamily', "'Courier New', monospace");
  updateNotifToggle();
  renderSnippetsList();
}

function updateNotifToggle() {
  const btn = document.getElementById('settings-notif-toggle');
  if (btn) btn.textContent = notifEnabled ? '\u{1F514} Activadas' : '\u{1F515} Desactivadas';
}

function renderSnippetsList() {
  const list = document.getElementById('snippets-list');
  if (!list) return;
  list.innerHTML = '';
  getUserSnippets().forEach((sn, i) => {
    const li = document.createElement('li');
    li.className = 'snippet-item';
    const label = document.createElement('span');
    label.className = 'snippet-label';
    label.textContent = sn.label;
    const cmd = document.createElement('span');
    cmd.className = 'snippet-cmd';
    cmd.textContent = sn.cmd;
    const del = document.createElement('button');
    del.className = 'snippet-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      saveUserSnippets(getUserSnippets().filter((_, j) => j !== i));
    });
    li.append(label, cmd, del);
    list.appendChild(li);
  });
}

// === Event wiring ===

settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('btn-settings').addEventListener('click', openSettings);

// Theme
settingsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  const mode = btn.dataset.theme;
  setPref('wibe-theme', mode);
  setThemeMode(mode);
  applyTheme(mode);
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === mode));
});

// Font size
document.getElementById('settings-font-down').addEventListener('click', () => {
  applyFontSize(state.currentFontSize - 2);
  document.getElementById('settings-font-size').textContent = state.currentFontSize;
});
document.getElementById('settings-font-up').addEventListener('click', () => {
  applyFontSize(state.currentFontSize + 2);
  document.getElementById('settings-font-size').textContent = state.currentFontSize;
});

// Font family
document.getElementById('settings-font-family').addEventListener('change', (e) => {
  applyFontFamily(e.target.value);
});

// Notifications
document.getElementById('settings-notif-toggle').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (!notifEnabled && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (Notification.permission === 'denied') return;
  setNotifEnabled(!notifEnabled);
  setPref('wibe-notif', notifEnabled);
  updateNotifToggle();
});

// Snippet add
document.getElementById('snippet-add').addEventListener('click', () => {
  const labelInput = document.getElementById('snippet-label-input');
  const cmdInput = document.getElementById('snippet-cmd-input');
  const label = labelInput.value.trim();
  const cmd = cmdInput.value.trim();
  if (!label || !cmd) return;
  saveUserSnippets([...getUserSnippets(), { label, cmd }]);
  labelInput.value = '';
  cmdInput.value = '';
});
document.getElementById('snippet-cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('snippet-add').click();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsEl.style.display === 'flex') closeSettings();
});
