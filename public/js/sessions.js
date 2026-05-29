import { state, isMobile, INPUT_BATCH_MS, inputBatch, active, saveSessions, loadSavedSessions, findSessionByPersistentId } from './state.js';

const tabsEl = document.getElementById('tabs');
const terminalsEl = document.getElementById('terminals');

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
    fontFamily: "'Courier New', monospace",
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
  term.open(panel);

  if (!isMobile) {
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => { webglAddon.dispose(); });
      term.loadAddon(webglAddon);
    } catch (e) {}
  }

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

  state.sessions.set(id, { term, fitAddon, searchAddon, tabEl: tab, panelEl: panel, name: displayName, persistentId: null });
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
  });
  const s = active();
  setTimeout(() => {
    s.fitAddon.fit();
    if (state.socket && state.socket.connected && s.persistentId) {
      state.socket.emit('resize', { id: s.persistentId, cols: s.term.cols, rows: s.term.rows });
    }
    if (!isMobile) s.term.focus();
  }, 50);
}

export function closeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.persistentId) {
    if (state.socket && state.socket.connected) {
      state.socket.emit('session:kill', s.persistentId);
    }
  }
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
