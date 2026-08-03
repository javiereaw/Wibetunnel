// Vista /claude: arranque, sesiones/tabs, composer y el conmutador Chat ⇄ Terminal.
// Pagina aparte de index.html — no importa ni modifica sessions.js/socket.js/ui.js
// (estan acoplados al DOM de "/"); solo reutiliza los helpers genericos de state.js
// y theme.js, que no asumen ninguna estructura de pagina concreta.
import {
  state, getPref, setPref, isMobile, parseEscapes, inputBatch,
  RESIZE_DEBOUNCE_DESKTOP_MS, RESIZE_DEBOUNCE_MOBILE_MS,
  findSessionByPersistentId, active, trackOutput,
} from '../state.js';
import { initTheme } from '../theme.js';
import * as net from './net.js';
import { createTranscript, applyEvents, prependEvents } from './stream.js';
import {
  initTabs, setupSession, switchSession, createNewSession, disposeSession,
  renderTabStatus, doResize,
} from './tabs.js';
import {
  appendItems, updateItems, prependItems, clearChat, initRender,
  nodeFor, openCard, setNoiseHidden,
} from './render/index.js';
import { initChrome, renderChrome } from './chrome.js';
import { initPeek, updatePeek, resetPeek } from './peek.js';
import { initStatus, noteOutput, syncFromTranscript, resetStatus, setState } from './status.js';
import { initFiles, openFiles } from './files.js';
import { initEditor, openEditor } from './editor.js';
import { quotePathForShell, buildCdCmd } from '../shell-quote.js';

const appEl = document.getElementById('c-app');
const emptyStateEl = document.getElementById('c-empty-state');
const loadMoreBtn = document.getElementById('c-load-more');
const statusEl = document.getElementById('status');

let mode = 'chat'; // 'chat' | 'term'

function setStatus(text) { statusEl.textContent = text; statusEl.style.display = 'block'; }
function hideStatus() { statusEl.style.display = 'none'; }

function showLogin(message) {
  appEl.style.display = 'none';
  hideStatus();
  document.getElementById('login').style.display = 'flex';
  document.getElementById('error').textContent = message || '';
}

// Al cambiar de tab: repintar el chat con el transcript de esa sesion.
function onSwitchSession(s) {
  clearChat();
  loadMoreBtn.style.display = s.claudeHasMore ? 'block' : 'none';
  emptyStateEl.classList.toggle('visible', s.transcript.items.length === 0);
  appendItems(s.transcript.items);
  resetPeek();
  resetStatus();
  updatePeek(s.term);
  syncFromTranscript(s.transcript);
  renderChrome(s.transcript);
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
  // Sin esto el citado de rutas seria POSIX contra un servidor PowerShell, que
  // es el default del proyecto: socket.js lo guarda para "/" pero esta pagina
  // tiene su propia capa de red y nunca lo estaba leyendo.
  state.shellType = (data && data.shellType) || 'posix';

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

// La creacion falla en cerrado (carpeta inexistente, fuera del jail...): se
// retira la tab fantasma y se avisa, en vez de dejar una pestana muerta.
function handleSessionError(payload) {
  if (!payload) return;
  const s = payload.clientSessionId && state.sessions.get(payload.clientSessionId);
  if (s && !s.persistentId) {
    disposeSession(payload.clientSessionId, s);
    if (state.sessions.size) switchSession([...state.sessions.keys()].pop());
  }
  setStatus(payload.error || 'No se pudo crear la sesión');
  setTimeout(hideStatus, 3000);
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
  if (match.id !== state.activeId) return;
  updatePeek(match.session.term);
  noteOutput();
}

function handleClaudeState(payload) {
  if (!payload) return;
  const match = findSessionByPersistentId(payload.id);
  if (!match) return;
  const s = match.session;
  s.claudeStatus = payload.status;
  // reset: detras viene un replay completo desde cero (reconexion de socket, o
  // `claude` relanzado en la misma shell). Sin vaciar antes, el historial se
  // apila sobre si mismo y cada mensaje de texto sale duplicado.
  if (payload.reset) {
    s.transcript = createTranscript();
    s.claudeHasMore = false;
    if (match.id === state.activeId) {
      clearChat();
      loadMoreBtn.style.display = 'none';
    }
  }
  renderTabStatus(s);
  if (match.id === state.activeId) {
    emptyStateEl.classList.toggle('visible', s.transcript.items.length === 0);
    renderEmptyState(payload);
  }
}

// 'searching' = no hay ningun proceso claude en esta shell.
// 'waiting'   = si lo hay, pero todavia no ha escrito su transcript. Antes se
//               enganchaba a la sesion mas reciente del proyecto, que podia ser
//               de otro dia y de otro tema.
function renderEmptyState(payload) {
  const text = document.getElementById('c-empty-text');
  const hint = document.getElementById('c-empty-hint');
  if (payload.status === 'waiting') {
    text.textContent = 'Sesión de claude detectada' + (payload.cwd ? ' en ' + payload.cwd.split(/[/\\]/).pop() : '');
    hint.textContent = 'Esperando a que escriba su primer mensaje…';
    return;
  }
  if (payload.status === 'searching') {
    text.textContent = 'Buscando una sesión de claude en esta shell…';
    hint.textContent = 'Lánzala con claude desde el modo Terminal.';
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
    syncFromTranscript(s.transcript);
    renderChrome(s.transcript);
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
    onSessionError: handleSessionError,
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

initTabs({
  onSwitch: onSwitchSession,
  getMode: () => mode,
  onLimit: (max) => { setStatus(`Máximo de ${max} sesiones`); setTimeout(hideStatus, 2000); },
});
// El "+" abre directamente el selector de carpeta: dos taps para crear una
// sesion donde quieras, dos para la de siempre ("Carpeta por defecto").
document.getElementById('c-tab-new').addEventListener('click', () => {
  openFiles({ mode: 'pick', startPath: getPref('wibe-claude-lastcwd', '') || '' });
});

initFiles({
  hasSession: () => { const s = active(); return !!(s && s.persistentId); },
  onCd: (fullPath) => {
    const s = active();
    if (!s || !s.persistentId) return;
    net.sendCommand(s.persistentId, buildCdCmd(fullPath, state.shellType));
    // Un salto corto al terminal para que se vea el prompt nuevo: el chat no
    // refleja un `cd` hasta que Claude vuelva a escribir en el transcript.
    setMode('term');
    setTimeout(() => setMode('chat'), 900);
  },
  onPickCwd: (fullPath) => {
    if (fullPath) setPref('wibe-claude-lastcwd', fullPath);
    createNewSession(fullPath || null);
  },
  onOpenFile: (fullPath, name) => openEditor(fullPath, name),
  onInsertPath: (fullPath) => {
    const quoted = quotePathForShell(fullPath, state.shellType);
    const at = inputEl.selectionStart != null ? inputEl.selectionStart : inputEl.value.length;
    inputEl.value = inputEl.value.slice(0, at) + quoted + inputEl.value.slice(at);
    inputEl.focus();
    inputEl.setSelectionRange(at + quoted.length, at + quoted.length);
  },
});
initEditor();

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

initPeek(
  (data) => {
    const s = active();
    if (s && s.persistentId) net.sendKey(s.persistentId, data);
  },
  // El prompt de permiso manda sobre cualquier otro estado: es lo unico que
  // deja a Claude parado esperandote.
  (waiting) => setState(waiting ? 'permission' : 'idle'),
);
initStatus();
// Una referencia a fichero en la prosa (ruta.js:123) abre el editor.
initRender({ onOpenRef: (p) => openEditor(p, p.split(/[/\\]/).pop()) });
initChrome({
  getItems: () => { const s = active(); return s ? s.transcript.items : []; },
  nodeFor,
  openCard,
  setNoiseHidden,
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
