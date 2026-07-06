import { state, isMobile, INPUT_BATCH_MS, inputBatch, active, saveSessions, loadSavedSessions, findSessionByPersistentId, getPref } from './state.js';
import { cleanOutputBuffer } from './socket.js';

const tabsEl = document.getElementById('tabs');
const terminalsEl = document.getElementById('terminals');

// WebGL solo en la pestaña activa: 1 contexto GPU en vez de uno por sesion.
// Las pestañas ocultas (display:none) caen al renderer DOM, que no pinta nada.
function enableWebgl(s) {
  if (isMobile || s.webglAddon) return;
  try {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => {
      try { addon.dispose(); } catch (e) {}
      if (s.webglAddon === addon) s.webglAddon = null;
      // Reintento diferido: si la GPU se recupera y la tab sigue activa, recrear
      setTimeout(() => {
        if (state.sessions.has(s.id) && state.activeId === s.id) enableWebgl(s);
      }, 2000);
    });
    s.term.loadAddon(addon);
    s.webglAddon = addon;
  } catch (e) {
    s.webglAddon = null;
  }
}

function disableWebgl(s) {
  if (!s.webglAddon) return;
  try { s.webglAddon.dispose(); } catch (e) {}
  s.webglAddon = null;
}

export function setupSessionUI(id, displayName) {
  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.dataset.id = id;
  const tabName = document.createElement('span');
  tabName.className = 'tab-name';
  tabName.textContent = displayName;
  const tabClose = document.createElement('span');
  tabClose.className = 'tab-close';
  tabClose.dataset.id = id;
  tabClose.textContent = '\u00D7';
  tab.append(tabName, document.createTextNode(' '), tabClose);
  tabsEl.insertBefore(tab, document.getElementById('tab-new'));

  const panel = document.createElement('div');
  panel.className = 'term-panel';
  panel.id = 'panel-' + id;
  terminalsEl.appendChild(panel);

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontSize: state.currentFontSize || 14,
    fontFamily: getPref('wibe-fontfamily', "'Courier New', monospace"),
    theme: {
      background: cs.getPropertyValue('--term-bg').trim(),
      foreground: cs.getPropertyValue('--term-fg').trim(),
      cursor: cs.getPropertyValue('--accent').trim()
    },
    cursorBlink: !isMobile,
    scrollback: isMobile ? 1000 : 5000,
    fastScrollModifier: 'alt',
    smoothScrollDuration: 0,
  });
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  // URLs clicables en la salida del terminal
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  term.open(panel);

  term.onScroll(() => {
    const buf = term.buffer.active;
    const s = state.sessions.get(id);
    if (s) s.atBottom = buf.viewportY >= buf.baseY;
    if (state.activeId === id) {
      document.getElementById('btn-bottom').classList.toggle('scrolled-up', !s.atBottom);
    }
  });

  term.onData((data) => {
    if (!state.socket || !state.socket.connected) return;
    const s = state.sessions.get(id);
    const pid = s ? s.persistentId : null;
    if (!pid) return;
    let batch = inputBatch.get(pid);
    if (!batch) {
      batch = { data: '', timer: null };
      inputBatch.set(pid, batch);
    }
    batch.data += data;
    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        const pending = batch.data;
        batch.data = '';
        batch.timer = null;
        if (pending && state.socket && state.socket.connected) {
          state.socket.emit('input', { id: pid, data: pending });
        }
      }, INPUT_BATCH_MS);
    }
  });

  panel.addEventListener('touchstart', () => term.focus());

  state.sessions.set(id, { id, term, fitAddon, searchAddon, webglAddon: null, tabEl: tab, panelEl: panel, name: displayName, persistentId: null, atBottom: true });
  return id;
}

export function createSession() {
  const statusEl = document.getElementById('status');
  if (!state.socket || !state.socket.connected) return;
  if (state.sessions.size >= state.maxSessions) {
    statusEl.textContent = `M\u00e1ximo de ${state.maxSessions} sesiones`;
    statusEl.style.display = 'block';
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    return;
  }
  const id = 'ses-' + (++state.sessionCounter);
  setupSessionUI(id, 'Shell ' + state.sessionCounter);
  state.socket.emit('session:create', id);
  switchSession(id);
}

export function adoptSession(persistentId, name) {
  if (state.sessions.size >= state.maxSessions) return null;
  const id = 'ses-' + (++state.sessionCounter);
  setupSessionUI(id, name || 'Shell ' + state.sessionCounter);
  const s = state.sessions.get(id);
  if (s) s.persistentId = persistentId;
  return id;
}

export function switchSession(id) {
  if (!state.sessions.has(id)) return;
  state.activeId = id;
  tabsEl.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  state.sessions.forEach((s, sid) => {
    s.panelEl.classList.toggle('active', sid === id);
    if (sid === id) enableWebgl(s); else disableWebgl(s);
  });
  const s = active();
  document.getElementById('btn-bottom').classList.toggle('scrolled-up', !s.atBottom);
  // rAF en vez de setTimeout: garantiza que el layout del panel recien activado
  // ya esta aplicado cuando fit() mide las dimensiones
  requestAnimationFrame(() => {
    if (state.activeId !== id) return; // el usuario ya cambio a otra tab
    s.fitAddon.fit();
    if (state.socket && state.socket.connected && s.persistentId) {
      state.socket.emit('resize', { id: s.persistentId, cols: s.term.cols, rows: s.term.rows });
    }
    if (!isMobile) s.term.focus();
  });
}

function releaseSessionResources(s) {
  if (!s.persistentId) return;
  cleanOutputBuffer(s.persistentId);
  const batch = inputBatch.get(s.persistentId);
  if (batch && batch.timer) clearTimeout(batch.timer);
  inputBatch.delete(s.persistentId);
}

export function closeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.persistentId) {
    if (state.socket && state.socket.connected) {
      state.socket.emit('session:kill', s.persistentId);
    }
  }
  releaseSessionResources(s);
  s.term.dispose();
  s.tabEl.remove();
  s.panelEl.remove();
  state.sessions.delete(id);
  saveSessions();
  if (state.sessions.size > 0) {
    switchSession([...state.sessions.keys()].pop());
  } else {
    createSession();
  }
}

export function cleanupAllSessions() {
  state.sessions.forEach(s => {
    releaseSessionResources(s);
    s.term.dispose();
    s.tabEl.remove();
    s.panelEl.remove();
  });
  state.sessions.clear();
  state.activeId = null;
}

export function renameTab(tab) {
  const nameSpan = tab.querySelector('.tab-name');
  if (!nameSpan) return;
  const sid = tab.dataset.id;
  const s = state.sessions.get(sid);
  if (!s) return;
  const oldName = s.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.style.cssText = 'width:80px;padding:2px 4px;font-size:12px;font-family:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--accent);border-radius:3px;outline:none;';
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  const finish = () => {
    const newName = input.value.trim() || oldName;
    s.name = newName;
    const span = document.createElement('span');
    span.className = 'tab-name';
    span.textContent = newName;
    input.replaceWith(span);
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') input.blur();
    if (ev.key === 'Escape') { input.value = oldName; input.blur(); }
  });
}

export { saveSessions, loadSavedSessions, findSessionByPersistentId };
