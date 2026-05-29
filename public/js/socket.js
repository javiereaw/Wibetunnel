import { state, isMobile, HEARTBEAT_INTERVAL_MS, saveSessions, loadSavedSessions, findSessionByPersistentId, trackOutput } from './state.js';
import { createSession, adoptSession, switchSession, cleanupAllSessions } from './sessions.js';

const outputBuffers = new Map();
let heartbeatInterval = null;
let reconnectBackoffMs = 1000;
const MAX_BACKOFF_MS = 30000;

export function connect() {
  state.savedToken = document.getElementById('token').value.trim();
  if (!state.savedToken) return;
  document.getElementById('error').textContent = '';

  state.socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    timeout: 60000,
    transports: ['websocket'],
  });

  state.socket.on('connect', () => {
    reconnectBackoffMs = 1000;
    state.socket.emit('auth', state.savedToken);

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (state.socket && state.socket.connected) state.socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  });

  state.socket.on('auth_success', (data) => {
    document.getElementById('login').style.display = 'none';
    document.getElementById('terminal-container').style.display = 'flex';
    if (data && data.maxSessions) state.maxSessions = data.maxSessions;

    if (!state.initialized && data && data.shortcuts && data.shortcuts.length) {
      const shortcutsEl = document.getElementById('shortcuts');
      shortcutsEl.style.display = 'flex';
      data.shortcuts.forEach(s => {
        const btn = document.createElement('button');
        btn.textContent = s.label;
        btn.dataset.cmd = s.cmd;
        shortcutsEl.appendChild(btn);
      });
    }

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
          adoptSession(ss.persistentId, savedName);
          pidsToReconnect.push(ss.persistentId);
        }

        state.socket.emit('session:reconnect', pidsToReconnect, (restored) => {
          statusEl.style.display = 'none';
          if (restored && restored.length > 0) {
            for (const r of restored) {
              const match = findSessionByPersistentId(r.persistentId);
              if (match) {
                if (r.buffer) match.session.term.write(r.buffer);
                setTimeout(() => {
                  match.session.fitAddon.fit();
                  state.socket.emit('resize', {
                    id: r.persistentId,
                    cols: match.session.term.cols,
                    rows: match.session.term.rows
                  });
                }, 50);
              }
            }
            const firstId = [...state.sessions.keys()][0];
            if (firstId) switchSession(firstId);
          } else {
            cleanupAllSessions();
            createSession();
          }
          saveSessions();
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

        state.socket.emit('session:reconnect', pids, (restored) => {
          statusEl2.style.display = 'none';
          if (restored && restored.length > 0) {
            for (const r of restored) {
              const match = findSessionByPersistentId(r.persistentId);
              if (match) {
                if (r.buffer) match.session.term.write(r.buffer);
                setTimeout(() => {
                  match.session.fitAddon.fit();
                  state.socket.emit('resize', {
                    id: r.persistentId,
                    cols: match.session.term.cols,
                    rows: match.session.term.rows
                  });
                }, 50);
              }
            }
            const s = state.sessions.get(state.activeId);
            if (s && !isMobile) s.term.focus();
          } else {
            cleanupAllSessions();
            createSession();
          }
          saveSessions();
        });
      } else {
        statusEl.style.display = 'none';
        createSession();
      }
    }
  });

  state.socket.on('auth_failed', () => {
    document.getElementById('error').textContent = 'Token incorrecto';
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    state.socket.disconnect();
  });

  state.socket.on('auth_ratelimited', () => {
    document.getElementById('error').textContent = 'Demasiados intentos. Espera unos minutos.';
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
      match.session.term.write('\r\n\x1b[33m[Sesi\u00f3n transferida a otro dispositivo]\x1b[0m\r\n');
      match.session.persistentId = null;
      saveSessions();
    }
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
        const pending = buf.data;
        buf.data = '';
        buf.raf = null;
        match.session.term.write(pending);
        trackOutput(match.id);
      });
    }
  });

  state.socket.on('session:exit', (persistentId) => {
    const match = findSessionByPersistentId(persistentId);
    if (match) {
      match.session.term.write('\r\n[Sesi\u00f3n terminada]\r\n');
      match.session.tabEl.classList.add('exited');
      outputBuffers.delete(persistentId);
    }
  });

  state.socket.on('disconnect', () => {
    const statusEl = document.getElementById('status');
    statusEl.textContent = 'Reconectando...';
    statusEl.style.display = 'block';
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    outputBuffers.forEach(buf => { if (buf.raf) cancelAnimationFrame(buf.raf); });
    outputBuffers.clear();
  });
}

export function cleanOutputBuffer(persistentId) {
  const buf = outputBuffers.get(persistentId);
  if (buf && buf.raf) cancelAnimationFrame(buf.raf);
  outputBuffers.delete(persistentId);
}
