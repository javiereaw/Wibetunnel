import { state, active, isMobile, setPref } from './state.js';
import { createSession, closeSession, switchSession } from './sessions.js';
import { setThemeMode, applyTheme } from './theme.js';
import { openSearch, applyFontSize, showToast } from './ui.js';
import { openFileBrowser } from './filebrowser.js';
import { openStatusPanel } from './statuspanel.js';

const paletteEl = document.getElementById('palette');
const paletteInputEl = document.getElementById('palette-input');
const paletteListEl = document.getElementById('palette-list');
let paletteIdx = 0;

function getPaletteCommands() {
  const cmds = [
    { name: 'Nueva sesión', hint: '', action: () => createSession() },
    { name: 'Cerrar sesión', hint: '', action: () => { if (state.activeId) closeSession(state.activeId); } },
    { name: 'Tema: Dark', hint: '', action: () => { setPref('wibe-theme', 'dark'); setThemeMode('dark'); applyTheme('dark'); } },
    { name: 'Tema: Light', hint: '', action: () => { setPref('wibe-theme', 'light'); setThemeMode('light'); applyTheme('light'); } },
    { name: 'Tema: Auto', hint: '', action: () => { setPref('wibe-theme', 'auto'); setThemeMode('auto'); applyTheme('auto'); } },
    { name: 'Limpiar terminal', hint: 'cls', action: () => { const s = active(); if (s) s.term.clear(); } },
    { name: 'Copiar selección', hint: '', action: () => { const s = active(); if (s) { const sel = s.term.getSelection(); if (sel) navigator.clipboard.writeText(sel).catch(() => showToast('No se pudo copiar al portapapeles')); } } },
    { name: 'Olvidar token guardado', hint: '', action: () => { setPref('wibe-token', null); showToast('Token olvidado en este dispositivo'); } },
    { name: 'Estado del servidor', hint: '', action: () => openStatusPanel() },
    { name: 'Grabar / detener grabación', hint: 'REC', action: () => {
      const s = active();
      if (!s || !s.persistentId || !state.socket || !state.socket.connected) return;
      state.socket.emit('session:record', s.persistentId, (r) => {
        if (!r || r.error) showToast((r && r.error) || 'No se pudo grabar');
        else showToast(r.recording ? 'Grabando sesión en el servidor' : 'Grabación guardada: ' + r.file);
      });
    } },
    { name: 'Pegar', hint: '', action: () => document.getElementById('btn-paste').click() },
    { name: 'Explorar archivos', hint: '', action: () => openFileBrowser('') },
    { name: 'Buscar en terminal', hint: 'Ctrl+F', action: () => openSearch() },
    { name: 'Letra más grande', hint: 'A+', action: () => applyFontSize(state.currentFontSize + 2) },
    { name: 'Letra más pequeña', hint: 'A-', action: () => applyFontSize(state.currentFontSize - 2) },
  ];
  state.profiles.forEach((label) => {
    cmds.push({ name: `Nueva sesión: ${label}`, hint: '', action: () => createSession(label) });
  });
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
  else if (e.key === 'Escape' && paletteEl.style.display === 'flex') closePalette();
});
