// Vista /claude: arranque, sesiones/tabs, composer y el conmutador Chat ⇄ Terminal.
// Pagina aparte de index.html — no importa ni modifica sessions.js/socket.js/ui.js
// (estan acoplados al DOM de "/"); solo reutiliza los helpers genericos de state.js
// y theme.js, que no asumen ninguna estructura de pagina concreta.
import {
  state, getPref, isMobile, parseEscapes, inputBatch,
  RESIZE_DEBOUNCE_DESKTOP_MS, RESIZE_DEBOUNCE_MOBILE_MS,
  findSessionByPersistentId, active, trackOutput,
} from '../state.js';
import { initTheme } from '../theme.js';
import * as net from './net.js';
import { createTranscript, applyEvents, prependEvents } from './stream.js';
import { appendItems, updateItems, prependItems, clearChat } from './render.js';
import { initPeek, updatePeek, resetPeek } from './peek.js';

const tabsEl = document.getElementById('c-tabs');
const termPanelsEl = document.getElementById('c-term-panels');
const appEl = document.getElementById('c-app');
const emptyStateEl = document.getElementById('c-empty-state');
const loadMoreBtn = document.getElementById('c-load-more');
const statusEl = document.getElementById('status');

let mode = 'chat'; // 'chat' | 'term'

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setStatus(text) { statusEl.textContent = text; statusEl.style.display = 'block'; }
function hideStatus() { statusEl.style.display = 'none'; }

function showLogin(message) {
  appEl.style.display = 'none';
  hideStatus();
  document.getElementById('login').style.display = 'flex';
  document.getElementById('error').textContent = message || '';
}

// === Sesiones (tabs + terminal xterm oculto detras del chat) ===

function renderTabStatus(s) {
  s.tabEl.classList.remove('c-status-attached', 'c-status-searching');
  if (s.claudeStatus === 'attached') s.tabEl.classList.add('c-status-attached');
  else if (s.claudeStatus === 'searching') s.tabEl.classList.add('c-status-searching');
}

function doResize(s) {
  if (!s) return;
  s.fitAddon.fit();
  net.resize(s.persistentId, s.term.cols, s.term.rows);
}

function setupSession(id, name) {
  const tab = el('button', 'c-tab');
  tab.dataset.id = id;
  const close = el('span', 'c-tab-close', '×');
  close.dataset.id = id;
  tab.append(el('span', 'c-tab-dot'), el('span', 'c-tab-name', name), close);
  tabsEl.insertBefore(tab, document.getElementById('c-tab-new'));

  const panel = el('div', 'c-term-panel');
  panel.id = 'c-term-panel-' + id;
  termPanelsEl.appendChild(panel);

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontSize: state.currentFontSize || 14,
    fontFamily: getPref('wibe-fontfamily', "'Courier New', monospace"),
    theme: {
      background: cs.getPropertyValue('--term-bg').trim(),
      foreground: cs.getPropertyValue('--term-fg').trim(),
      cursor: cs.getPropertyValue('--accent').trim(),
    },
    cursorBlink: !isMobile,
    scrollback: isMobile ? 1000 : 5000,
    fastScrollModifier: 'alt',
    smoothScrollDuration: 0,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (_) { /* addon opcional */ }
  term.open(panel);
  term.onData((data) => {
    const s = state.sessions.get(id);
    if (s && s.persistentId) net.sendKey(s.persistentId, data);
  });
  panel.addEventListener('touchstart', () => term.focus());

  state.sessions.set(id, {
    id, term, fitAddon, tabEl: tab, panelEl: panel, name,
    persistentId: null, takenPid: null,
    transcript: createTranscript(), claudeStatus: 'idle', claudeHasMore: false,
  });
}

function switchSession(id) {
  if (!state.sessions.has(id)) return;
  state.activeId = id;
  tabsEl.querySelectorAll('.c-tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
  state.sessions.forEach((s, sid) => s.panelEl.classList.toggle('active', sid === id));

  const s = active();
  clearChat();
  loadMoreBtn.style.display = s.claudeHasMore ? 'block' : 'none';
  emptyStateEl.classList.toggle('visible', s.transcript.items.length === 0);
  appendItems(s.transcript.items);
  resetPeek();
  updatePeek(s.term);

  requestAnimationFrame(() => {
    if (state.activeId !== id) return;
    doResize(s);
    if (!isMobile && mode === 'term') s.term.focus();
  });
}

function releaseSessionResources(s) {
  if (!s.persistentId) return;
  net.detachClaude(s.persistentId);
  const batch = inputBatch.get(s.persistentId);
  if (batch && batch.timer) clearTimeout(batch.timer);
  inputBatch.delete(s.persistentId);
}

function createNewSession() {
  if (!state.socket || !state.socket.connected) return;
  if (state.sessions.size >= state.maxSessions) {
    setStatus(`Máximo de ${state.maxSessions} sesiones`);
    setTimeout(hideStatus, 2000);
    return;
  }
  const id = 'cses-' + (++state.sessionCounter);
  setupSession(id, 'Shell ' + state.sessionCounter);
  net.createSession(id);
  switchSession(id);
}

function closeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.persistentId) net.killSession(s.persistentId);
  releaseSessionResources(s);
  s.term.dispose();
  s.tabEl.remove();
  s.panelEl.remove();
  state.sessions.delete(id);
  if (state.sessions.size > 0) switchSession([...state.sessions.keys()].pop());
  else createNewSession();
}

// === Handlers de red ===

function attachAndRestore(persistentId) {
  net.attachClaude(persistentId);
}

function handleAuthSuccess(data) {
  document.getElementById('login').style.display = 'none';
  appEl.style.display = 'flex';
  appEl.classList.add('c-mode-chat');

  const serverSessions = (data && data.activeSessions) || [];
  if (data && data.maxSessions) state.maxSessions = data.maxSessions;

  if (!state.initialized) {
    if (serverSessions.length > 0) {
      const pids = [];
      for (const ss of serverSessions) {
        const id = 'cses-' + (++state.sessionCounter);
        setupSession(id, 'Shell ' + state.sessionCounter);
        state.sessions.get(id).persistentId = ss.persistentId;
        pids.push(ss.persistentId);
      }
      setStatus('Recuperando sesiones...');
      net.reconnectSessions(pids, (restored) => {
        hideStatus();
        for (const r of restored) {
          const match = findSessionByPersistentId(r.persistentId);
          if (!match) continue;
          match.session.term.reset();
          if (r.buffer) match.session.term.write(r.buffer);
          attachAndRestore(r.persistentId);
        }
        const firstId = [...state.sessions.keys()][0];
        if (firstId) switchSession(firstId);
      });
    } else {
      createNewSession();
    }
    state.initialized = true;
  } else {
    const pids = [];
    state.sessions.forEach((s) => { if (s.persistentId) pids.push(s.persistentId); });
    if (pids.length > 0) {
      setStatus('Reconectando...');
      net.reconnectSessions(pids, (restored) => {
        hideStatus();
        for (const r of restored) {
          const match = findSessionByPersistentId(r.persistentId);
          if (!match) continue;
          match.session.term.reset();
          if (r.buffer) match.session.term.write(r.buffer);
          attachAndRestore(r.persistentId);
          if (match.id === state.activeId) doResize(match.session);
        }
      });
    } else {
      createNewSession();
    }
  }
}

function handleSessionCreated(payload) {
  if (!payload || !payload.clientSessionId || !payload.persistentId) return;
  const s = state.sessions.get(payload.clientSessionId);
  if (!s) return;
  s.persistentId = payload.persistentId;
  attachAndRestore(payload.persistentId);
  if (state.activeId === payload.clientSessionId) doResize(s);
}

function handleSessionExit(persistentId) {
  const match = findSessionByPersistentId(persistentId);
  if (match) {
    match.session.term.write('\r\n[Sesión terminada]\r\n');
    match.session.tabEl.classList.add('c-exited');
  }
  const batch = inputBatch.get(persistentId);
  if (batch && batch.timer) clearTimeout(batch.timer);
  inputBatch.delete(persistentId);
}

function handleSessionTaken(persistentId) {
  const match = findSessionByPersistentId(persistentId);
  if (match) {
    match.session.term.write('\r\n\x1b[33m[Sesión movida a otro dispositivo]\x1b[0m\r\n');
    match.session.persistentId = null;
    match.session.tabEl.classList.add('c-taken');
  }
}

function handleOutput(persistentId, data) {
  const match = findSessionByPersistentId(persistentId);
  if (!match) return;
  match.session.term.write(data);
  trackOutput(match.id);
  if (match.id === state.activeId) updatePeek(match.session.term);
}

function handleClaudeState(payload) {
  if (!payload) return;
  const match = findSessionByPersistentId(payload.id);
  if (!match) return;
  match.session.claudeStatus = payload.status;
  renderTabStatus(match.session);
  if (match.id === state.activeId) {
    emptyStateEl.classList.toggle('visible', match.session.transcript.items.length === 0);
  }
}

function handleClaudeEvents(payload) {
  if (!payload) return;
  const match = findSessionByPersistentId(payload.id);
  if (!match) return;
  const s = match.session;
  s.claudeHasMore = !!payload.hasMore;
  const { added, updated } = applyEvents(s.transcript, payload.events || []);
  if (match.id === state.activeId) {
    loadMoreBtn.style.display = s.claudeHasMore ? 'block' : 'none';
    emptyStateEl.classList.remove('visible');
    appendItems(added);
    updateItems(updated);
  }
}

function connectFlow() {
  document.getElementById('error').textContent = '';
  net.connect({
    onAuthSuccess: handleAuthSuccess,
    onAuthFailed: () => showLogin('Token incorrecto'),
    onAuthRatelimited: () => showLogin('Demasiados intentos. Espera unos minutos.'),
    onSessionTimeout: () => setStatus('Sesión expirada, reconectando...'),
    onSessionCreated: handleSessionCreated,
    onSessionExit: handleSessionExit,
    onSessionTaken: handleSessionTaken,
    onOutput: handleOutput,
    onClaudeState: handleClaudeState,
    onClaudeEvents: handleClaudeEvents,
    onConnectError: () => {
      const loginVisible = document.getElementById('login').style.display !== 'none';
      if (loginVisible) document.getElementById('error').textContent = 'No se pudo conectar con el servidor';
    },
    onDisconnect: () => setStatus('Reconectando...'),
  });
}

// === Login ===

document.getElementById('btn-eye').addEventListener('click', () => {
  const inp = document.getElementById('token');
  const btn = document.getElementById('btn-eye');
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  btn.style.opacity = showing ? '0.5' : '1';
});
document.getElementById('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectFlow(); });
document.getElementById('btn-connect').addEventListener('click', connectFlow);

const saved = getPref('wibe-token', null);
if (saved) {
  document.getElementById('token').value = saved;
  const rememberEl = document.getElementById('remember-token');
  if (rememberEl) rememberEl.checked = true;
  connectFlow();
}

// === Tabs ===

tabsEl.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.c-tab-close');
  if (closeBtn) { closeSession(closeBtn.dataset.id); return; }
  const tab = e.target.closest('.c-tab');
  if (tab) switchSession(tab.dataset.id);
});
document.getElementById('c-tab-new').addEventListener('click', createNewSession);

// === Conmutador Chat / Terminal ===

const btnMode = document.getElementById('c-btn-mode');
function setMode(next) {
  mode = next;
  appEl.classList.toggle('c-mode-chat', mode === 'chat');
  appEl.classList.toggle('c-mode-term', mode === 'term');
  btnMode.textContent = mode === 'chat' ? 'Terminal' : 'Chat';
  if (mode === 'term') {
    requestAnimationFrame(() => {
      const s = active();
      if (s) { doResize(s); if (!isMobile) s.term.focus(); }
    });
  }
}
btnMode.addEventListener('click', () => setMode(mode === 'chat' ? 'term' : 'chat'));

// === Composer ===

const inputEl = document.getElementById('c-input');
function doSend() {
  const s = active();
  const text = inputEl.value;
  if (!s || !s.persistentId || !text.trim()) return;
  net.sendMessage(s.persistentId, text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
}
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});
document.getElementById('c-send').addEventListener('click', doSend);

document.getElementById('c-keys').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn) return;
  const s = active();
  if (s && s.persistentId) net.sendKey(s.persistentId, parseEscapes(btn.dataset.key));
});

loadMoreBtn.addEventListener('click', () => {
  const s = active();
  if (!s || !s.persistentId) return;
  net.requestMore(s.persistentId, ({ events, hasMore }) => {
    s.claudeHasMore = !!hasMore;
    const { added, updated } = prependEvents(s.transcript, events || []);
    loadMoreBtn.style.display = s.claudeHasMore ? 'block' : 'none';
    prependItems(added);
    updateItems(updated);
  });
});

initPeek((data) => {
  const s = active();
  if (s && s.persistentId) net.sendKey(s.persistentId, data);
});

// === Resize / visibilidad ===

let resizeTimer = null;
function debouncedResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => doResize(active()), isMobile ? RESIZE_DEBOUNCE_MOBILE_MS : RESIZE_DEBOUNCE_DESKTOP_MS);
}
window.addEventListener('resize', debouncedResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', debouncedResize);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  debouncedResize();
  if (state.socket) {
    if (!state.socket.connected) { if (state.savedToken) state.socket.connect(); }
    else state.socket.emit('heartbeat');
  }
});

initTheme();
