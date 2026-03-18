// Wibetunnel - Terminal web minimalista para Windows
// Servidor principal: Express + Socket.IO + node-pty

require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// === Configuración desde .env ===
const TOKEN = process.env.WIBE_TOKEN;
const PORT = parseInt(process.env.WIBE_PORT) || 4020;
const SHELL = process.env.WIBE_SHELL || 'powershell.exe';
const CWD = process.env.WIBE_CWD || process.env.USERPROFILE || process.env.HOME;

// Parsear atajos: "Label=comando,Label2=comando2"
const SHORTCUTS = (process.env.WIBE_SHORTCUTS || '').split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const idx = s.indexOf('=');
    return idx > 0 ? { label: s.slice(0, idx), cmd: s.slice(idx + 1) } : null;
  })
  .filter(Boolean);

// Seguridad: rate limiting de auth
const RATE_MAX = parseInt(process.env.WIBE_RATE_MAX) || 5;       // intentos max
const RATE_WINDOW = parseInt(process.env.WIBE_RATE_WINDOW) || 15; // minutos de bloqueo
// Session timeout (minutos, 0 = desactivado)
const SESSION_TIMEOUT = parseInt(process.env.WIBE_TIMEOUT) || 0;
// Reconexion persistente
const RECONNECT_GRACE = parseInt(process.env.WIBE_RECONNECT_GRACE) || 1800; // segundos (30 min para cross-device)
const BUFFER_SIZE = parseInt(process.env.WIBE_BUFFER_SIZE) || 51200;       // bytes
const MAX_CONNECTIONS = parseInt(process.env.WIBE_MAX_CONN, 10) || 10;
// HTTPS: rutas a cert y key (opcional)
const SSL_CERT = process.env.WIBE_SSL_CERT || '';
const SSL_KEY = process.env.WIBE_SSL_KEY || '';
// Origenes adicionales permitidos (ej. dominio de Cloudflare tunnel)
const ALLOWED_ORIGINS = new Set(
  (process.env.WIBE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Validar que el token esté configurado (obligatorio)
if (!TOKEN) {
  console.error('ERROR: WIBE_TOKEN no configurado en .env');
  console.error('Copia .env.example a .env y configura tu token');
  process.exit(1);
}

// === Inicializar servidor (HTTPS si hay certs, sino HTTP) ===
const app = express();
let server;
if (SSL_CERT && SSL_KEY) {
  try {
    const sslOpts = {
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY),
    };
    server = https.createServer(sslOpts, app);
    console.log('[SSL] HTTPS activado');
  } catch (err) {
    console.error('[SSL] Error cargando certificados:', err.message);
    console.error('[SSL] Cayendo a HTTP');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true); // same-origin (no Origin header)
    const host = req.headers.host || `localhost:${PORT}`;
    const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
    if (origin === `${proto}://${host}`) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    console.warn(`[CORS] Rechazando origen: ${origin}`);
    callback('Cross-origin not allowed', false);
  },
});

// === Rate limiting en memoria ===
const authAttempts = new Map(); // ip → { count, blockedUntil }

function checkRateLimit(ip) {
  const entry = authAttempts.get(ip);
  if (!entry) return true;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return false;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    authAttempts.delete(ip);
    return true;
  }
  return true;
}

function recordFailedAuth(ip) {
  const entry = authAttempts.get(ip) || { count: 0, blockedUntil: null };
  entry.count++;
  if (entry.count >= RATE_MAX) {
    entry.blockedUntil = Date.now() + RATE_WINDOW * 60 * 1000;
    console.log(`[RATE] IP ${ip} bloqueada por ${RATE_WINDOW} min (${entry.count} intentos fallidos)`);
  }
  authAttempts.set(ip, entry);
}

function clearAuthAttempts(ip) {
  authAttempts.delete(ip);
}

// Cleanup: eliminar entries de authAttempts expirados cada hora
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (!entry.blockedUntil || now >= entry.blockedUntil) {
      authAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000).unref();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "font-src 'self' https://unpkg.com data:",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '));
  if (SSL_CERT && SSL_KEY) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Servir archivos estáticos (public/)
app.use(express.static(path.join(__dirname, 'public')));

// Maximo de sesiones simultaneas
const MAX_SESSIONS = parseInt(process.env.WIBE_MAX_SESSIONS) || 5;

// === Store global de PTYs (persiste entre reconexiones) ===
let persistentCounter = 0;
const ptyStore = new Map();       // persistentId → { pty, buffer, socketId, cleanupTimer, clientSessionId }
const socketSessions = new Map(); // socketId → Set<persistentId>

// === Output batching: agrupar datos del PTY antes de enviar ===
const OUTPUT_BATCH_MS = 8; // ms entre flushes (≈120fps)
const outputBatch = new Map(); // persistentId → { data, timer }

function flushOutput(persistentId) {
  const batch = outputBatch.get(persistentId);
  if (!batch || !batch.data) return;
  const entry = ptyStore.get(persistentId);
  if (entry) {
    const targetSocket = io.sockets.sockets.get(entry.socketId);
    if (targetSocket) {
      targetSocket.emit('output', { id: persistentId, data: batch.data });
    }
  }
  batch.data = '';
  batch.timer = null;
}

function batchOutput(persistentId, data) {
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

function appendBuffer(entry, data) {
  entry.buffer += data;
  if (entry.buffer.length > BUFFER_SIZE) {
    entry.buffer = entry.buffer.slice(-BUFFER_SIZE);
  }
}

function generatePersistentId() {
  return 'pty-' + (++persistentCounter) + '-' + Date.now().toString(36);
}

// === Listar sesiones activas (para cross-device reconnect) ===
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

// === Manejar conexiones WebSocket ===
io.on('connection', (socket) => {
  // Connection limit
  if (io.sockets.sockets.size > MAX_CONNECTIONS) {
    socket.disconnect(true);
    return;
  }
  let authenticated = false;
  let lastActivity = Date.now();
  let timeoutChecker = null;
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  // Disconnect sockets that never authenticate
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.disconnect(true);
  }, 30000);

  // Inicializar set de sesiones para este socket
  socketSessions.set(socket.id, new Set());

  // Autenticacion con rate limiting
  socket.on('auth', (clientToken) => {
    if (authenticated) return; // Prevent re-auth
    if (!checkRateLimit(ip)) {
      socket.emit('auth_ratelimited');
      socket.disconnect(true);
      return;
    }
    if (typeof clientToken !== 'string') {
      recordFailedAuth(ip);
      socket.emit('auth_failed');
      socket.disconnect(true);
      return;
    }
    // Timing-safe comparison to prevent token enumeration via timing attacks
    const clientBuf = Buffer.from(clientToken, 'utf8');
    const secretBuf = Buffer.from(TOKEN, 'utf8');
    const tokensMatch = clientBuf.length === secretBuf.length &&
                        crypto.timingSafeEqual(clientBuf, secretBuf);
    if (!tokensMatch) {
      recordFailedAuth(ip);
      socket.emit('auth_failed');
      socket.disconnect(true);
      return;
    }
    clearTimeout(authTimer);
    clearAuthAttempts(ip);
    authenticated = true;
    socket.emit('auth_success', {
      shortcuts: SHORTCUTS,
      maxSessions: MAX_SESSIONS,
      activeSessions: getActiveSessionsList(),
    });

    // Iniciar session timeout si esta configurado
    if (SESSION_TIMEOUT > 0) {
      timeoutChecker = setInterval(() => {
        const elapsed = (Date.now() - lastActivity) / 1000 / 60;
        if (elapsed >= SESSION_TIMEOUT) {
          console.log(`[TIMEOUT] Socket ${ip} desconectado por inactividad (${SESSION_TIMEOUT} min)`);
          socket.emit('session:timeout');
          socket.disconnect(true);
        }
      }, 60 * 1000);
    }
  });

  // Crear nueva sesion PTY
  socket.on('session:create', (clientSessionId) => {
    if (!authenticated) return;
    const myPtys = socketSessions.get(socket.id);
    if (myPtys && myPtys.size >= MAX_SESSIONS) return;

    // Guard: prevent duplicate clientSessionId from creating orphan PTYs
    if (typeof clientSessionId !== 'string') return;
    for (const entry of ptyStore.values()) {
      if (entry.socketId === socket.id && entry.clientSessionId === clientSessionId) return;
    }

    const safeEnv = { ...process.env };
    delete safeEnv.WIBE_TOKEN;
    delete safeEnv.WIBE_SSL_CERT;
    delete safeEnv.WIBE_SSL_KEY;

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
      socket.emit('session:error', { clientSessionId, error: err.message });
      return;
    }

    const persistentId = generatePersistentId();
    const entry = {
      pty: ptyProcess,
      buffer: '',
      socketId: socket.id,
      cleanupTimer: null,
      clientSessionId
    };
    ptyStore.set(persistentId, entry);
    if (myPtys) myPtys.add(persistentId);

    // Reenviar output al navegador (batched) y bufferear
    ptyProcess.onData((data) => {
      appendBuffer(entry, data);
      lastActivity = Date.now();
      batchOutput(persistentId, data);
    });

    // Terminal cerrado (usuario escribio exit, etc.)
    ptyProcess.onExit(() => {
      // Flush cualquier output pendiente antes de cerrar
      flushOutput(persistentId);
      const batch = outputBatch.get(persistentId);
      if (batch && batch.timer) clearTimeout(batch.timer);
      outputBatch.delete(persistentId);

      const targetSocket = io.sockets.sockets.get(entry.socketId);
      if (targetSocket) {
        targetSocket.emit('session:exit', persistentId);
      }
      // Limpiar del store
      const ownerSet = socketSessions.get(entry.socketId);
      if (ownerSet) ownerSet.delete(persistentId);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      ptyStore.delete(persistentId);
    });

    socket.emit('session:created', { clientSessionId, persistentId });
    console.log(`[+] Sesion ${persistentId} (PID: ${ptyProcess.pid})`);
  });

  // Reconectar sesiones existentes
  socket.on('session:reconnect', (persistentIds, callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    const restored = [];
    const myPtys = socketSessions.get(socket.id);

    for (const pid of persistentIds) {
      const entry = ptyStore.get(pid);
      if (!entry) continue;

      // Cancelar timer de limpieza
      if (entry.cleanupTimer) {
        clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = null;
      }

      // Notificar al socket anterior si es diferente (takeover cross-device)
      if (entry.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(entry.socketId);
        if (oldSocket && oldSocket.connected) {
          oldSocket.emit('session:taken', pid);
        }
      }

      // Desasociar del socket anterior si es diferente
      const oldSet = socketSessions.get(entry.socketId);
      if (oldSet) oldSet.delete(pid);

      // Reasignar al nuevo socket
      entry.socketId = socket.id;
      if (myPtys) myPtys.add(pid);

      restored.push({
        persistentId: pid,
        buffer: entry.buffer
      });

      console.log(`[~] Sesion ${pid} reconectada (PID: ${entry.pty.pid})`);
    }

    callback(restored);
  });

  // Listar sesiones activas (para cross-device discovery)
  socket.on('session:list', (callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    callback(getActiveSessionsList());
  });

  // Cerrar una sesion (usa persistentId)
  socket.on('session:kill', (persistentId) => {
    if (!authenticated) return;
    const entry = ptyStore.get(persistentId);
    if (entry) {
      console.log(`[-] Sesion ${persistentId} cerrada (PID: ${entry.pty.pid})`);
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      const batch = outputBatch.get(persistentId);
      if (batch && batch.timer) clearTimeout(batch.timer);
      outputBatch.delete(persistentId);
      entry.pty.kill();
      const ownerSet = socketSessions.get(entry.socketId);
      if (ownerSet) ownerSet.delete(persistentId);
      ptyStore.delete(persistentId);
    }
  });

  // Input del navegador → terminal (usa persistentId)
  socket.on('input', ({ id, data }) => {
    if (authenticated && typeof id === 'string' && typeof data === 'string' && data.length <= 65536) {
      lastActivity = Date.now();
      const entry = ptyStore.get(id);
      if (entry) entry.pty.write(data);
    }
  });

  // Heartbeat: mantiene la sesion viva (el cliente lo envia periodicamente)
  socket.on('heartbeat', () => {
    if (authenticated) lastActivity = Date.now();
  });

  // Resize de una sesion especifica (usa persistentId)
  socket.on('resize', ({ id, cols, rows }) => {
    if (authenticated &&
        typeof id === 'string' &&
        Number.isInteger(cols) && cols >= 1 && cols <= 500 &&
        Number.isInteger(rows) && rows >= 1 && rows <= 200) {
      lastActivity = Date.now();
      const entry = ptyStore.get(id);
      if (entry) {
        try { entry.pty.resize(cols, rows); } catch (e) {}
      }
    }
  });

  // File browser: listar directorio
  socket.on('fs:list', (dirPath, callback) => {
    if (!authenticated) return;
    if (typeof callback !== 'function') return;
    const resolved = path.resolve(dirPath || CWD);
    const normalizedCwd = path.resolve(CWD);
    // Case-insensitive comparison for Windows (NTFS is case-insensitive)
    const resolvedLC = resolved.toLowerCase();
    const cwdLC = normalizedCwd.toLowerCase();
    if (resolvedLC !== cwdLC && !resolvedLC.startsWith(cwdLC + path.sep.toLowerCase())) {
      callback({ path: normalizedCwd, items: [], error: 'Acceso denegado: fuera del directorio raiz' });
      return;
    }
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
      })).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      callback({ path: resolved, items, error: null });
    } catch (err) {
      callback({ path: resolved, items: [], error: err.message });
    }
  });

  // Desconexion: grace period en vez de kill inmediato
  socket.on('disconnect', () => {
    clearTimeout(authTimer);
    if (timeoutChecker) clearInterval(timeoutChecker);
    const myPtys = socketSessions.get(socket.id);
    if (!myPtys) return;

    for (const pid of myPtys) {
      const entry = ptyStore.get(pid);
      if (!entry) continue;

      if (RECONNECT_GRACE <= 0) {
        // Sin grace period: kill inmediato (comportamiento original)
        console.log(`[-] Sesion ${pid} cerrada (PID: ${entry.pty.pid})`);
        entry.pty.kill();
        ptyStore.delete(pid);
      } else {
        // Grace period: PTY sigue corriendo, output se buferea
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
  });
});

// === Arrancar servidor ===
server.listen(PORT, () => {
  const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
  console.log(`Wibetunnel corriendo en ${proto}://localhost:${PORT}`);
  if (SESSION_TIMEOUT > 0) console.log(`[TIMEOUT] Inactividad: ${SESSION_TIMEOUT} min`);
  if (RATE_MAX) console.log(`[RATE] Max ${RATE_MAX} intentos fallidos, bloqueo ${RATE_WINDOW} min`);
  console.log(`[RECONNECT] Grace: ${RECONNECT_GRACE}s, Buffer: ${BUFFER_SIZE} bytes`);
});

// === Graceful shutdown: limpiar PTYs (incluyendo huerfanos) y cerrar servidor ===
function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Recibido ${signal}, limpiando...`);
  // Limpiar output batches pendientes
  for (const [pid, batch] of outputBatch) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  outputBatch.clear();
  // Matar todos los PTYs del store global (incluidos huerfanos con timer)
  for (const [pid, entry] of ptyStore) {
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    try { entry.pty.kill(); } catch (e) {}
    console.log(`[-] Shutdown: ${pid}`);
  }
  ptyStore.clear();
  socketSessions.clear();
  // Desconectar todos los sockets
  for (const [, socket] of io.sockets.sockets) {
    socket.disconnect(true);
  }
  server.close(() => {
    console.log('[SHUTDOWN] Servidor cerrado limpiamente');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[SHUTDOWN] Forzando salida');
    process.exit(1);
  }, 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
