import { state, isMobile, HEARTBEAT_INTERVAL_MS, inputBatch, setPref, getClientId, saveSessions, loadSavedSessions, findSessionByPersistentId, trackOutput } from './state.js';
import { createSession, adoptSession, switchSession, closeSession, cleanupAllSessions } from './sessions.js';
import { initShortcuts } from './settings.js';

const outputBuffers = new Map();
let heartbeatInterval = null;
let reconnectBackoffMs = 1000;
const MAX_BACKOFF_MS = 30000;
const AUTO_REAP_MS = 10000; // cerrar tabs 'exited' no activas tras este tiempo

// === Overlay de estado con niveles: info, aviso escalado y error con reintento ===
// retry: true = accion por defecto (reconectar socket), o una funcion custom
let retryBtn = null;
let retryAction = null;
function setStatus(text, { retry = null } = {}) {
  const el = document.getElementById('status');
  el.textContent = text;
  if (retry) {
    retryAction = retry === true
      ? () => { setStatus('Reconectando...'); if (state.socket) state.socket.connect(); }
      : retry;
    if (!retryBtn) {
      retryBtn = document.createElement('button');
      retryBtn.textContent = 'Reintentar ahora';
      retryBtn.style.cssText = 'display:block;margin:10px auto 0;padding:6px 14px;background:var(--accent);color:var(--bg);border:none;border-radius:5px;cursor:pointer;font-size:13px;';
      retryBtn.addEventListener('click', () => { if (retryAction) retryAction(); });
    }
    el.appendChild(retryBtn);
  }
  el.style.display = 'block';
}

// Volver a la pantalla de login con un mensaje visible (token rotado, rate limit):
// sin esto el error se escribe en un nodo oculto y la app queda congelada en el overlay
function showLogin(message) {
  document.getElementById('terminal-container').style.display = 'none';
  document.getElementById('status').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('error').textContent = message;
}

// Restaurar sesiones persistentes: emite session:reconnect, escribe buffer, reajusta terminal.
// Con timeout de ack y reintentos: un ack perdido no puede dejar el overlay eterno.
function doReconnect(pids, statusEl, onRestored, attempt = 0) {
  state.socket.timeout(10000).emit('session:reconnect', pids, (err, restored) => {
    if (err) {
      if (state.socket && state.socket.connected && attempt < 2) {
        doReconnect(pids, statusEl, onRestored, attempt + 1);
        return;
      }
      if (state.socket && state.socket.connected) {
        setStatus('No se pudieron restaurar las sesiones', {
          retry: () => { setStatus('Reconectando sesiones...'); doReconnect(pids, statusEl, onRestored); },
        });
      }
      // Si el socket cayo entre medias, el proximo ciclo de reconexion relanza doReconnect
      return;
    }
    statusEl.style.display = 'none';
    if (!Array.isArray(restored)) restored = [];

    // Marcar las no restauradas (expiradas en el servidor) en vez de destruir todo
    const restoredIds = new Set(restored.map(r => r.persistentId));
    for (const pid of pids) {
      if (restoredIds.has(pid)) continue;
      const match = findSessionByPersistentId(pid);
      if (match) {
        match.session.term.write('\r\n\x1b[33m[Sesión expirada en el servidor]\x1b[0m\r\n');
        match.session.persistentId = null;
        match.session.tabEl.classList.add('exited');
      }
    }

    if (restored.length > 0) {
      for (const r of restored) {
        const match = findSessionByPersistentId(r.persistentId);
        if (match) {
          // Reset antes del replay: el buffer del servidor es la fuente de verdad,
          // sin esto una reconexion a mitad de sesion duplica el scrollback
          match.session.term.reset();
          if (r.buffer) match.session.term.write(r.buffer);
          // Solo la sesion visible se re-ajusta aqui (fit en panel oculto no hace
          // nada util); las demas se ajustan al activarse en switchSession
          if (match.id === state.activeId) {
            requestAnimationFrame(() => {
              match.session.fitAddon.fit();
              state.socket.emit('resize', {
                id: r.persistentId,
                cols: match.session.term.cols,
                rows: match.session.term.rows
              });
            });
          }
        }
      }
      if (onRestored) onRestored();
    } else {
      // Nada restaurado: solo arrasar y empezar de cero si no queda ninguna
      // sesion con vida (ni recuperable via takenPid)
      let anyAlive = false;
      state.sessions.forEach(s => { if (s.persistentId || s.takenPid) anyAlive = true; });
      if (!anyAlive) {
        setStatus('Sesiones expiradas en el servidor: abriendo una nueva');
        setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
        cleanupAllSessions();
        createSession();
      }
    }
    saveSessions();
  });
}

export function connect() {
  state.savedToken = document.getElementById('token').value.trim();
  if (!state.savedToken) return;
  document.getElementById('error').textContent = '';

  // Remember-me opt-in: persistir solo si el usuario lo marca
  const rememberEl = document.getElementById('remember-token');
  setPref('wibe-token', rememberEl && rememberEl.checked ? state.savedToken : null);

  // Guard: si ya hay un socket (doble click, Enter+click), desecharlo para no duplicar handlers
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  state.socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    timeout: 60000,
    // websocket primero; polling como fallback para redes que bloquean el upgrade
    // (tryAllTransports hace que engine.io pruebe el siguiente si el primero falla)
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
  });

  let connectErrors = 0;
  state.socket.on('connect_error', (err) => {
    connectErrors++;
    const detail = err && err.message ? err.message : 'sin respuesta';
    const loginVisible = document.getElementById('login').style.display !== 'none';
    if (loginVisible) {
      document.getElementById('error').textContent = `No se pudo conectar con el servidor (${detail})`;
      return;
    }
    if (connectErrors >= 8) {
      setStatus(`Sin conexión con el servidor (${detail})`, { retry: true });
    } else if (connectErrors >= 3) {
      setStatus(`Reconectando... el servidor no responde (intento ${connectErrors})`);
    }
  });

  state.socket.on('connect', () => {
    connectErrors = 0;
    reconnectBackoffMs = 1000;
    state.socket.emit('auth', { token: state.savedToken, clientId: getClientId() });

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (state.socket && state.socket.connected) state.socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  });

  state.socket.on('auth_success', (data) => {
    document.getElementById('login').style.display = 'none';
    document.getElementById('terminal-container').style.display = 'flex';
    if (data && data.maxSessions) state.maxSessions = data.maxSessions;
    if (data && data.shellType) state.shellType = data.shellType;
    state.profiles = (data && data.profiles) || [];

    initShortcuts((data && data.shortcuts) || []);

    const serverSessions = (data && data.activeSessions) || [];
    const savedMap = loadSavedSessions();
    const statusEl = document.getElementById('status');

    if (!state.initialized) {
      if (serverSessions.length > 0) {
        statusEl.textContent = 'Recuperando sesiones...';
        statusEl.style.display = 'block';

        const pidsToReconnect = [];
        for (const ss of serverSessions) {
          const savedName = savedMap[ss.persistentId] ? savedMap[ss.persistentId].name : null;
          // Solo reclamar lo que realmente se adopto: mas alla de maxSessions
          // adoptSession devuelve null y reclamarlo dejaria la sesion sin panel
          if (adoptSession(ss.persistentId, savedName)) {
            pidsToReconnect.push(ss.persistentId);
          }
        }

        doReconnect(pidsToReconnect, statusEl, () => {
          const firstId = [...state.sessions.keys()][0];
          if (firstId) switchSession(firstId);
        });
      } else {
        createSession();
      }
      state.initialized = true;
      if (serverSessions.length === 0) statusEl.style.display = 'none';
    } else {
      const pids = [];
      state.sessions.forEach(s => { if (s.persistentId) pids.push(s.persistentId); });
      if (pids.length > 0) {
        const statusEl2 = document.getElementById('status');
        statusEl2.textContent = 'Reconectando...';
        statusEl2.style.display = 'block';

        doReconnect(pids, statusEl2, () => {
          const s = state.sessions.get(state.activeId);
          if (s && !isMobile) s.term.focus();
        });
      } else {
        statusEl.style.display = 'none';
        createSession();
      }
    }
  });

  state.socket.on('auth_failed', () => {
    // showLogin: si ocurre en caliente (token rotado en el servidor) el usuario
    // debe ver el login con el error, no un overlay de reconexion eterno
    showLogin('Token incorrecto');
    // Olvidar el token guardado: evita bucles de auto-conexion fallida + rate limit
    setPref('wibe-token', null);
    const rememberEl = document.getElementById('remember-token');
    if (rememberEl) rememberEl.checked = false;
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
  });

  state.socket.on('auth_ratelimited', () => {
    showLogin('Demasiados intentos. Espera unos minutos.');
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
  });

  state.socket.on('session:timeout', () => {
    const statusEl = document.getElementById('status');
    statusEl.textContent = 'Sesi\u00f3n expirada, reconectando...';
    statusEl.style.display = 'block';
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
    setTimeout(() => {
      if (state.socket) state.socket.connect();
    }, reconnectBackoffMs);
    reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_BACKOFF_MS);
  });

  state.socket.on('session:created', (data) => {
    if (data && data.clientSessionId && data.persistentId) {
      const s = state.sessions.get(data.clientSessionId);
      if (s) {
        s.persistentId = data.persistentId;
        saveSessions();
      }
    }
  });

  state.socket.on('session:taken', (persistentId) => {
    const match = findSessionByPersistentId(persistentId);
    if (match) {
      match.session.term.write('\r\n\x1b[33m[Sesi\u00f3n movida a otro dispositivo \u2014 paleta: "Recuperar sesiones"]\x1b[0m\r\n');
      // Recordar el pid para poder recuperarla via session:adopt; sin persistentId
      // la tab no envia input (y se marca visualmente como movida)
      match.session.takenPid = persistentId;
      match.session.persistentId = null;
      match.session.tabEl.classList.add('taken');
    }
    cleanOutputBuffer(persistentId);
  });

  state.socket.on('output', ({ id, data }) => {
    const match = findSessionByPersistentId(id);
    if (!match) return;
    let buf = outputBuffers.get(id);
    if (!buf) {
      buf = { data: '', raf: null };
      outputBuffers.set(id, buf);
    }
    buf.data += data;
    if (!buf.raf) {
      buf.raf = requestAnimationFrame(() => {
        buf.raf = null;
        writeBufferedOutput(id);
      });
    }
  });

  state.socket.on('session:exit', (persistentId) => {
    const match = findSessionByPersistentId(persistentId);
    if (match) {
      match.session.term.write('\r\n[Sesi\u00f3n terminada]\r\n');
      match.session.tabEl.classList.add('exited');
      // Auto-reap: cerrar la tab muerta pasado un tiempo, salvo que sea la
      // activa (el usuario puede estar leyendo la salida final)
      const sid = match.id;
      setTimeout(() => {
        if (!state.sessions.has(sid)) return;
        if (state.activeId === sid) return;
        if (!state.socket || !state.socket.connected) return;
        closeSession(sid);
      }, AUTO_REAP_MS);
    }
    cleanOutputBuffer(persistentId);
    const batch = inputBatch.get(persistentId);
    if (batch && batch.timer) clearTimeout(batch.timer);
    inputBatch.delete(persistentId);
  });

  state.socket.on('disconnect', () => {
    const statusEl = document.getElementById('status');
    statusEl.textContent = 'Reconectando...';
    statusEl.style.display = 'block';
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    // Flush, no descarte: en movil el rAF no corre en background y aqui habia
    // output acumulado que se perdia en cada desconexion con la pantalla apagada
    flushAllOutputBuffers();
    outputBuffers.clear();
  });
}

// Escribir el output pendiente de una sesion (cancela su rAF si estaba armado)
function writeBufferedOutput(id) {
  const buf = outputBuffers.get(id);
  if (!buf) return;
  if (buf.raf) { cancelAnimationFrame(buf.raf); buf.raf = null; }
  if (!buf.data) return;
  const pending = buf.data;
  buf.data = '';
  const match = findSessionByPersistentId(id);
  if (match) {
    match.session.term.write(pending);
    trackOutput(match.id);
  }
}

// Vaciar todos los buffers pendientes (visibilitychange, disconnect)
export function flushAllOutputBuffers() {
  for (const id of [...outputBuffers.keys()]) writeBufferedOutput(id);
}

export function cleanOutputBuffer(persistentId) {
  const buf = outputBuffers.get(persistentId);
  if (buf && buf.raf) cancelAnimationFrame(buf.raf);
  outputBuffers.delete(persistentId);
}
