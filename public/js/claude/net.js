// Capa de socket para /claude: mismo protocolo y convenciones que
// public/js/socket.js (mismo state.socket singleton, mismo esquema de
// transports/reconexion/batching) pero orientado a callbacks en vez de
// acoplado al DOM de index.html — esta pagina tiene su propio DOM.
import { state, getClientId, setPref, inputBatch, INPUT_BATCH_MS, HEARTBEAT_INTERVAL_MS } from '../state.js';

let heartbeatInterval = null;
let handlers = {};

// Abre el socket y engancha los handlers. Devuelve false si no hay token.
export function connect(h) {
  handlers = h || {};
  state.savedToken = document.getElementById('token').value.trim();
  if (!state.savedToken) return false;

  const rememberEl = document.getElementById('remember-token');
  setPref('wibe-token', rememberEl && rememberEl.checked ? state.savedToken : null);

  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

  state.socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    timeout: 60000,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
  });

  state.socket.on('connect_error', (err) => { if (handlers.onConnectError) handlers.onConnectError(err); });

  state.socket.on('connect', () => {
    state.socket.emit('auth', { token: state.savedToken, clientId: getClientId() });
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (state.socket && state.socket.connected) state.socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  });

  state.socket.on('auth_success', (data) => { if (handlers.onAuthSuccess) handlers.onAuthSuccess(data); });

  state.socket.on('auth_failed', () => {
    setPref('wibe-token', null);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
    if (handlers.onAuthFailed) handlers.onAuthFailed();
  });

  state.socket.on('auth_ratelimited', () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
    if (handlers.onAuthRatelimited) handlers.onAuthRatelimited();
  });

  state.socket.on('session:timeout', () => { if (handlers.onSessionTimeout) handlers.onSessionTimeout(); });
  state.socket.on('session:created', (data) => { if (handlers.onSessionCreated) handlers.onSessionCreated(data); });
  state.socket.on('session:error', (data) => { if (handlers.onSessionError) handlers.onSessionError(data); });
  state.socket.on('session:taken', (pid) => { if (handlers.onSessionTaken) handlers.onSessionTaken(pid); });
  state.socket.on('session:exit', (pid) => { if (handlers.onSessionExit) handlers.onSessionExit(pid); });
  state.socket.on('output', ({ id, data }) => { if (handlers.onOutput) handlers.onOutput(id, data); });
  state.socket.on('claude:state', (payload) => { if (handlers.onClaudeState) handlers.onClaudeState(payload); });
  state.socket.on('claude:events', (payload) => { if (handlers.onClaudeEvents) handlers.onClaudeEvents(payload); });

  state.socket.on('disconnect', () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (handlers.onDisconnect) handlers.onDisconnect();
  });

  return true;
}

export function disconnect() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (state.socket) { state.socket.disconnect(); }
}

export function reconnectSessions(persistentIds, cb) {
  if (!state.socket) { cb([]); return; }
  state.socket.timeout(10000).emit('session:reconnect', persistentIds, (err, restored) => {
    cb(err || !Array.isArray(restored) ? [] : restored);
  });
}

// cwd (opcional) es la carpeta elegida en el explorador; el servidor la valida
// contra el jail y falla en cerrado si no existe — nunca cae al CWD por defecto.
export function createSession(clientSessionId, profileLabel, cwd) {
  if (!state.socket || !state.socket.connected) return;
  if (!profileLabel && !cwd) { state.socket.emit('session:create', clientSessionId); return; }
  const payload = { id: clientSessionId };
  if (profileLabel) payload.profile = profileLabel;
  if (cwd) payload.cwd = cwd;
  state.socket.emit('session:create', payload);
}

export function listDir(dirPath, cb) {
  if (!state.socket || !state.socket.connected) { cb({ path: '', items: [], error: 'sin conexión' }); return; }
  state.socket.emit('fs:list', dirPath || '', cb);
}

// Comando completo (p.ej. un `cd`) SIN batching: no debe intercalarse con las
// pulsaciones sueltas que el usuario esté enviando por otro camino.
export function sendCommand(persistentId, text) {
  if (!state.socket || !state.socket.connected || !persistentId || !text) return;
  state.socket.emit('input', { id: persistentId, data: text });
}

export function killSession(persistentId) {
  if (state.socket && state.socket.connected) state.socket.emit('session:kill', persistentId);
}

export function resize(persistentId, cols, rows) {
  if (state.socket && state.socket.connected && persistentId) {
    state.socket.emit('resize', { id: persistentId, cols, rows });
  }
}

// Teclas sueltas (botonera, tipeo directo en modo Terminal): mismo batching
// que public/js/sessions.js, reutilizando el Map generico de state.js.
export function sendKey(persistentId, data) {
  if (!state.socket || !state.socket.connected || !persistentId) return;
  let batch = inputBatch.get(persistentId);
  if (!batch) { batch = { data: '', timer: null }; inputBatch.set(persistentId, batch); }
  batch.data += data;
  if (!batch.timer) {
    batch.timer = setTimeout(() => {
      const pending = batch.data;
      batch.data = '';
      batch.timer = null;
      if (pending && state.socket && state.socket.connected) {
        state.socket.emit('input', { id: persistentId, data: pending });
      }
    }, INPUT_BATCH_MS);
  }
}

// Mensaje del composer: bracketed paste para que el multilinea no se ejecute
// linea a linea en la shell/TUI, con Enter aparte para confirmar el envio.
export function sendMessage(persistentId, text) {
  if (!state.socket || !state.socket.connected || !persistentId || !text) return;
  state.socket.emit('input', { id: persistentId, data: '\x1b[200~' + text + '\x1b[201~\r' });
}

export function attachClaude(persistentId) {
  if (state.socket && state.socket.connected && persistentId) state.socket.emit('claude:attach', persistentId);
}
export function detachClaude(persistentId) {
  if (state.socket && state.socket.connected && persistentId) state.socket.emit('claude:detach', persistentId);
}
export function requestMore(persistentId, cb) {
  if (!state.socket || !state.socket.connected || !persistentId) { cb({ events: [], hasMore: false }); return; }
  state.socket.emit('claude:more', persistentId, cb);
}
