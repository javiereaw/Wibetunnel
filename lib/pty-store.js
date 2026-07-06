// Store de PTYs: ciclo de vida completo de las sesiones de terminal.
// Persiste entre reconexiones de socket; el socket propietario se reasigna via claimSession.
const pty = require('node-pty');
const {
  SHELL, CWD, BUFFER_SIZE, RECONNECT_GRACE, MAX_SESSIONS, MAX_PTYS,
  BP_HIGH, BP_LOW, OUTPUT_BATCH_MS,
} = require('./config');

let io = null;
function init(ioServer) { io = ioServer; }

let persistentCounter = 0;
const ptyStore = new Map();       // persistentId → entry
const socketSessions = new Map(); // socketId → Set<persistentId>
const outputBatch = new Map();    // persistentId → { data, timer }

function generatePersistentId() {
  return 'pty-' + (++persistentCounter) + '-' + Date.now().toString(36);
}

function registerSocket(socketId) {
  socketSessions.set(socketId, new Set());
}

// === Backpressure ===

// Bytes pendientes de enviar en la cola del transporte engine.io de un socket
function getPendingBytes(socket) {
  if (!socket || !socket.conn || !Array.isArray(socket.conn.writeBuffer)) return 0;
  let total = 0;
  for (const pkt of socket.conn.writeBuffer) {
    if (pkt && typeof pkt.data === 'string') total += pkt.data.length;
  }
  return total;
}

// Si el cliente no drena, pausar el PTY (flow control real via kernel)
function checkBackpressure(persistentId, entry, socket) {
  if (entry.paused) return;
  if (getPendingBytes(socket) > BP_HIGH) {
    entry.paused = true;
    try { entry.pty.pause(); } catch (e) {}
    console.log(`[BP] ${persistentId} pausado (cliente lento)`);
  }
}

function resumeIfPaused(persistentId, entry) {
  if (!entry.paused) return;
  entry.paused = false;
  try { entry.pty.resume(); } catch (e) {}
  console.log(`[BP] ${persistentId} reanudado`);
}

// Al drenar la cola de un socket, reanudar sus PTYs pausados
function onSocketDrain(socket) {
  if (getPendingBytes(socket) > BP_LOW) return;
  const myPtys = socketSessions.get(socket.id);
  if (!myPtys) return;
  for (const pid of myPtys) {
    const e = ptyStore.get(pid);
    if (e) resumeIfPaused(pid, e);
  }
}

// === Output batching ===

function flushOutput(persistentId) {
  const batch = outputBatch.get(persistentId);
  if (!batch) return;
  batch.timer = null;
  if (!batch.data) return;
  const entry = ptyStore.get(persistentId);
  if (entry) {
    const targetSocket = io.sockets.sockets.get(entry.socketId);
    if (targetSocket) {
      targetSocket.emit('output', { id: persistentId, data: batch.data });
      checkBackpressure(persistentId, entry, targetSocket);
    }
  }
  batch.data = '';
}

function batchOutput(persistentId, data) {
  const entry = ptyStore.get(persistentId);
  if (!entry) return;
  // Huerfano (sin socket conectado): no hay a quien enviar; appendBuffer ya
  // guarda el replay. Evita armar timers de flush cada 8ms durante la gracia.
  const target = io.sockets.sockets.get(entry.socketId);
  if (!target || !target.connected) return;
  let batch = outputBatch.get(persistentId);
  if (!batch) {
    batch = { data: '', timer: null };
    outputBatch.set(persistentId, batch);
  }
  batch.data += data;
  if (!batch.timer) {
    batch.timer = setTimeout(() => flushOutput(persistentId), OUTPUT_BATCH_MS);
  }
}

function clearBatch(persistentId) {
  const batch = outputBatch.get(persistentId);
  if (batch && batch.timer) clearTimeout(batch.timer);
  outputBatch.delete(persistentId);
}

// === Buffer de replay (lista de chunks: evita realloc por chunk) ===

function appendBuffer(entry, data) {
  entry.bufChunks.push(data);
  entry.bufLen += data.length;
  while (entry.bufLen > BUFFER_SIZE) {
    const head = entry.bufChunks[0];
    const excess = entry.bufLen - BUFFER_SIZE;
    if (head.length <= excess) {
      entry.bufChunks.shift();
      entry.bufLen -= head.length;
    } else {
      entry.bufChunks[0] = head.slice(excess);
      entry.bufLen -= excess;
      break;
    }
  }
}

function bufferToString(entry) {
  return entry.bufChunks.join('');
}

// === Ciclo de vida ===

// Crear una sesion PTY para un socket. Devuelve { persistentId, pid } o { error }.
function createSession(socket, clientSessionId) {
  const myPtys = socketSessions.get(socket.id);
  if (myPtys && myPtys.size >= MAX_SESSIONS) return { error: 'Limite de sesiones por dispositivo alcanzado' };

  // Techo global: cuenta tambien PTYs huerfanos en grace period
  if (ptyStore.size >= MAX_PTYS) {
    console.warn(`[PTY] Limite global de ${MAX_PTYS} PTYs alcanzado, rechazando creacion`);
    return { error: 'Limite global de sesiones alcanzado' };
  }

  // Guard: prevenir clientSessionId duplicado creando PTYs huerfanos
  for (const entry of ptyStore.values()) {
    if (entry.socketId === socket.id && entry.clientSessionId === clientSessionId) return { error: null, duplicate: true };
  }

  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('WIBE_'))
  );

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: CWD,
      env: safeEnv
    });
  } catch (err) {
    console.error(`[PTY] Error creando proceso: ${err.message}`);
    return { error: err.message };
  }

  const persistentId = generatePersistentId();
  const entry = {
    pty: ptyProcess,
    bufChunks: [],
    bufLen: 0,
    socketId: socket.id,
    cleanupTimer: null,
    clientSessionId,
    lastActivity: Date.now(),
    paused: false
  };
  ptyStore.set(persistentId, entry);
  if (myPtys) myPtys.add(persistentId);

  ptyProcess.onData((data) => {
    try {
      appendBuffer(entry, data);
      entry.lastActivity = Date.now();
      batchOutput(persistentId, data);
    } catch (err) {
      console.error(`[ERROR] pty onData ${persistentId}:`, err);
    }
  });

  ptyProcess.onExit(() => {
    try {
      flushOutput(persistentId);
      clearBatch(persistentId);
      const targetSocket = io.sockets.sockets.get(entry.socketId);
      if (targetSocket) {
        targetSocket.emit('session:exit', persistentId);
      }
      const ownerSet = socketSessions.get(entry.socketId);
      if (ownerSet) ownerSet.delete(persistentId);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      ptyStore.delete(persistentId);
    } catch (err) {
      console.error(`[ERROR] pty onExit ${persistentId}:`, err);
      ptyStore.delete(persistentId);
      outputBatch.delete(persistentId);
    }
  });

  console.log(`[+] Sesion ${persistentId} (PID: ${ptyProcess.pid})`);
  return { persistentId, pid: ptyProcess.pid };
}

// Reclamo determinista de una sesion: el propietario anterior siempre es notificado
function claimSession(pid, entry, socket) {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  if (entry.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(entry.socketId);
    if (oldSocket) oldSocket.emit('session:taken', pid);
    const oldSet = socketSessions.get(entry.socketId);
    if (oldSet) oldSet.delete(pid);
  }
  entry.socketId = socket.id;
  const mySet = socketSessions.get(socket.id);
  if (mySet) mySet.add(pid);
  // El nuevo cliente puede drenar: si el PTY quedo pausado por el anterior, reanudar
  resumeIfPaused(pid, entry);
}

// Reconectar una lista de persistentIds a un socket; devuelve los restaurados con su buffer
function reconnectSessions(socket, persistentIds) {
  const restored = [];
  for (const pid of persistentIds) {
    const entry = ptyStore.get(pid);
    if (!entry) continue;
    claimSession(pid, entry, socket);
    restored.push({ persistentId: pid, buffer: bufferToString(entry) });
    console.log(`[~] Sesion ${pid} reconectada (PID: ${entry.pty.pid})`);
  }
  return restored;
}

function killSession(persistentId) {
  const entry = ptyStore.get(persistentId);
  if (!entry) return false;
  console.log(`[-] Sesion ${persistentId} cerrada (PID: ${entry.pty.pid})`);
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  clearBatch(persistentId);
  entry.pty.kill();
  const ownerSet = socketSessions.get(entry.socketId);
  if (ownerSet) ownerSet.delete(persistentId);
  ptyStore.delete(persistentId);
  return true;
}

function writeInput(persistentId, data) {
  const entry = ptyStore.get(persistentId);
  if (!entry) return;
  entry.lastActivity = Date.now();
  entry.pty.write(data);
}

function resizeSession(persistentId, cols, rows) {
  const entry = ptyStore.get(persistentId);
  if (!entry) return;
  try { entry.pty.resize(cols, rows); } catch (e) {
    console.warn(`[PTY] resize fallido en ${persistentId}:`, e.message);
  }
}

// Desconexion de un socket: grace period (o kill inmediato si esta desactivado)
function handleDisconnect(socket) {
  const myPtys = socketSessions.get(socket.id);
  if (!myPtys) return;

  for (const pid of myPtys) {
    const entry = ptyStore.get(pid);
    if (!entry) continue;

    if (RECONNECT_GRACE <= 0) {
      console.log(`[-] Sesion ${pid} cerrada (PID: ${entry.pty.pid})`);
      entry.pty.kill();
      ptyStore.delete(pid);
    } else {
      // Si estaba pausado por backpressure, reanudar: los procesos del dueño deben seguir
      resumeIfPaused(pid, entry);
      console.log(`[!] Sesion ${pid} huerfana, grace ${RECONNECT_GRACE}s (PID: ${entry.pty.pid})`);
      entry.cleanupTimer = setTimeout(() => {
        const e = ptyStore.get(pid);
        if (e) {
          console.log(`[-] Grace expirado, cerrando ${pid} (PID: ${e.pty.pid})`);
          e.pty.kill();
          ptyStore.delete(pid);
        }
      }, RECONNECT_GRACE * 1000);
    }
  }

  socketSessions.delete(socket.id);
}

// Listar sesiones activas (para cross-device reconnect)
function getActiveSessionsList() {
  const list = [];
  for (const [pid, entry] of ptyStore) {
    const ownerSocket = io.sockets.sockets.get(entry.socketId);
    list.push({
      persistentId: pid,
      orphan: !ownerSocket || !ownerSocket.connected,
      pid: entry.pty.pid,
    });
  }
  return list;
}

// Actividad mas reciente entre las sesiones de un socket (para session timeout)
function latestActivity(socketId, fallback) {
  let mostRecent = fallback;
  const myPtys = socketSessions.get(socketId);
  if (myPtys) {
    for (const pid of myPtys) {
      const e = ptyStore.get(pid);
      if (e && e.lastActivity > mostRecent) mostRecent = e.lastActivity;
    }
  }
  return mostRecent;
}

function stats() {
  let paused = 0;
  for (const e of ptyStore.values()) if (e.paused) paused++;
  return { ptys: ptyStore.size, paused };
}

// Shutdown: matar todos los PTYs (incluidos huerfanos con timer) y limpiar batches
function shutdownAll() {
  for (const [, batch] of outputBatch) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  outputBatch.clear();
  for (const [pid, entry] of ptyStore) {
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    try { entry.pty.kill(); } catch (e) {}
    console.log(`[-] Shutdown: ${pid}`);
  }
  ptyStore.clear();
  socketSessions.clear();
}

module.exports = {
  init, registerSocket, onSocketDrain,
  createSession, reconnectSessions, killSession, writeInput, resizeSession,
  handleDisconnect, getActiveSessionsList, latestActivity, stats, shutdownAll,
};
