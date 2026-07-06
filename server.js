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
// Techo global de PTYs vivos (incluye huerfanos en grace period)
const MAX_PTYS = parseInt(process.env.WIBE_MAX_PTYS, 10) || 15;
// Backpressure: pausar el PTY si la cola de escritura del socket supera HIGH, reanudar bajo LOW
const BP_HIGH = parseInt(process.env.WIBE_BP_HIGH, 10) || 262144; // 256 KB
const BP_LOW = parseInt(process.env.WIBE_BP_LOW, 10) || 65536;    // 64 KB
const AUTH_TIMEOUT_MS = 30000;
const AUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;
// HTTPS: rutas a cert y key (opcional)
const SSL_CERT = process.env.WIBE_SSL_CERT || '';
const SSL_KEY = process.env.WIBE_SSL_KEY || '';
// Origenes adicionales permitidos (ej. dominio de Cloudflare tunnel)
const ALLOWED_ORIGINS = new Set(
  (process.env.WIBE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Solo confiar en X-Forwarded-For si el servidor está detrás de un proxy conocido
const TRUST_PROXY = process.env.WIBE_TRUST_PROXY === 'true';
function getClientIp(socket) {
  if (TRUST_PROXY) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return socket.handshake.address;
}

// Validar que el token esté configurado (obligatorio)
if (!TOKEN) {
  console.error('ERROR: WIBE_TOKEN no configurado en .env');
  console.error('Copia .env.example a .env y configura tu token');
  process.exit(1);
}

// Comparacion timing-safe contra el token configurado
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    if (io && io.engine && io.engine.clientsCount >= MAX_CONNECTIONS) {
      console.warn('[CONN] Rechazando: max conexiones alcanzado');
      return callback('Too many connections', false);
    }
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
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
  const now = Date.now();
  let entry = authAttempts.get(ip);
  const windowMs = RATE_WINDOW * 60 * 1000;
  if (!entry || (now - entry.firstAttempt) > windowMs) {
    entry = { count: 0, firstAttempt: now, blockedUntil: null };
  }
  entry.count++;
  if (entry.count >= RATE_MAX) {
    entry.blockedUntil = now + windowMs;
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
}, AUTH_CLEANUP_INTERVAL_MS).unref();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '));
  if (SSL_CERT && SSL_KEY) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Health: estado de recursos, autenticado con el mismo token (Authorization: Bearer <token>)
app.get('/health', (req, res) => {
  const auth = req.headers.authorization || '';
  const candidate = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenMatches(candidate)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    uptime: Math.round(process.uptime()),
    rssBytes: process.memoryUsage.rss(),
    ptys: ptyStore.size,
    pausedPtys: [...ptyStore.values()].filter(e => e.paused).length,
    connections: io.engine ? io.engine.clientsCount : 0,
  });
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

// Bytes pendientes de enviar en la cola del transporte engine.io de un socket
function getPendingBytes(socket) {
  if (!socket || !socket.conn || !Array.isArray(socket.conn.writeBuffer)) return 0;
  let total = 0;
  for (const pkt of socket.conn.writeBuffer) {
    if (pkt && typeof pkt.data === 'string') total += pkt.data.length;
  }
  return total;
}

// Backpressure: si el cliente no drena, pausar el PTY (flow control real via kernel)
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

// Buffer de replay como lista de chunks: evita realloc de string por cada chunk
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

// Aisla errores de un handler: un throw no debe tumbar el proceso ni afectar a otras sesiones
function safe(name, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error(`[ERROR] Handler ${name}:`, err));
      }
    } catch (err) {
      console.error(`[ERROR] Handler ${name}:`, err);
    }
  };
}

// Reclamo determinista de una sesion: el propietario anterior siempre es notificado y desasociado
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

// === Manejar conexiones WebSocket ===
io.on('connection', (socket) => {
  let authenticated = false;
  let socketLastActivity = Date.now();
  let timeoutChecker = null;
  const ip = getClientIp(socket);

  socket.on('error', (err) => {
    console.error(`[ERROR] Socket ${socket.id}:`, err && err.message ? err.message : err);
  });

  // Al drenar la cola del transporte, reanudar los PTYs pausados por backpressure
  socket.conn.on('drain', safe('drain', () => {
    if (getPendingBytes(socket) > BP_LOW) return;
    const myPtys = socketSessions.get(socket.id);
    if (!myPtys) return;
    for (const pid of myPtys) {
      const e = ptyStore.get(pid);
      if (e) resumeIfPaused(pid, e);
    }
  }));

  // Disconnect sockets that never authenticate
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.disconnect(true);
  }, AUTH_TIMEOUT_MS);

  // Inicializar set de sesiones para este socket
  socketSessions.set(socket.id, new Set());

  // Autenticacion con rate limiting
  socket.on('auth', safe('auth', (clientToken) => {
    if (authenticated) return; // Prevent re-auth
    if (!checkRateLimit(ip)) {
      socket.emit('auth_ratelimited');
      socket.disconnect(true);
      return;
    }
    if (!tokenMatches(clientToken)) {
      recordFailedAuth(ip);
      socket.emit('auth_failed');
      socket.disconnect(true);
      return;
    }
    clearTimeout(authTimer);
    clearAuthAttempts(ip);
    authenticated = true;
    const shellType = SHELL.toLowerCase().includes('powershell') ? 'powershell' : 'posix';
    socket.emit('auth_success', {
      shortcuts: SHORTCUTS,
      maxSessions: MAX_SESSIONS,
      activeSessions: getActiveSessionsList(),
      shellType,
    });

    // Iniciar session timeout si esta configurado
    if (SESSION_TIMEOUT > 0) {
      timeoutChecker = setInterval(() => {
        const myPtys = socketSessions.get(socket.id);
        let mostRecent = socketLastActivity;
        if (myPtys) {
          for (const pid of myPtys) {
            const e = ptyStore.get(pid);
            if (e && e.lastActivity > mostRecent) mostRecent = e.lastActivity;
          }
        }
        if ((Date.now() - mostRecent) / 1000 / 60 >= SESSION_TIMEOUT) {
          console.log(`[TIMEOUT] Socket ${ip} desconectado por inactividad (${SESSION_TIMEOUT} min)`);
          socket.emit('session:timeout');
          socket.disconnect(true);
        }
      }, 60 * 1000);
    }
  }));

  // Crear nueva sesion PTY
  socket.on('session:create', safe('session:create', (clientSessionId) => {
    if (!authenticated) return;
    const myPtys = socketSessions.get(socket.id);
    if (myPtys && myPtys.size >= MAX_SESSIONS) return;

    // Techo global: cuenta tambien PTYs huerfanos en grace period
    if (ptyStore.size >= MAX_PTYS) {
      console.warn(`[PTY] Limite global de ${MAX_PTYS} PTYs alcanzado, rechazando creacion`);
      socket.emit('session:error', { clientSessionId, error: 'Limite global de sesiones alcanzado' });
      return;
    }

    // Guard: prevent duplicate clientSessionId from creating orphan PTYs
    if (typeof clientSessionId !== 'string') return;
    for (const entry of ptyStore.values()) {
      if (entry.socketId === socket.id && entry.clientSessionId === clientSessionId) return;
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
      socket.emit('session:error', { clientSessionId, error: err.message });
      return;
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

    // Reenviar output al navegador (batched) y bufferear
    ptyProcess.onData((data) => {
      try {
        appendBuffer(entry, data);
        entry.lastActivity = Date.now();
        socketLastActivity = entry.lastActivity;
        batchOutput(persistentId, data);
      } catch (err) {
        console.error(`[ERROR] pty onData ${persistentId}:`, err);
      }
    });

    // Terminal cerrado (usuario escribio exit, etc.)
    ptyProcess.onExit(() => {
      try {
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
      } catch (err) {
        console.error(`[ERROR] pty onExit ${persistentId}:`, err);
        ptyStore.delete(persistentId);
        outputBatch.delete(persistentId);
      }
    });

    socket.emit('session:created', { clientSessionId, persistentId });
    console.log(`[+] Sesion ${persistentId} (PID: ${ptyProcess.pid})`);
  }));

  // Reconectar sesiones existentes
  socket.on('session:reconnect', safe('session:reconnect', (persistentIds, callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    if (!Array.isArray(persistentIds)) { callback([]); return; }
    const restored = [];

    for (const pid of persistentIds) {
      const entry = ptyStore.get(pid);
      if (!entry) continue;

      // Reclamo atomico: cancela grace timer, notifica SIEMPRE al dueño anterior y reasigna
      claimSession(pid, entry, socket);

      restored.push({
        persistentId: pid,
        buffer: bufferToString(entry)
      });

      console.log(`[~] Sesion ${pid} reconectada (PID: ${entry.pty.pid})`);
    }

    callback(restored);
  }));

  // Listar sesiones activas (para cross-device discovery)
  socket.on('session:list', safe('session:list', (callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    callback(getActiveSessionsList());
  }));

  // Cerrar una sesion (usa persistentId)
  socket.on('session:kill', safe('session:kill', (persistentId) => {
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
  }));

  // Input del navegador → terminal (usa persistentId)
  socket.on('input', safe('input', ({ id, data }) => {
    if (authenticated && typeof id === 'string' && typeof data === 'string' && data.length <= 65536) {
      socketLastActivity = Date.now();
      const entry = ptyStore.get(id);
      if (entry) {
        entry.lastActivity = Date.now();
        entry.pty.write(data);
      }
    }
  }));

  // Heartbeat: mantiene la sesion viva (el cliente lo envia periodicamente)
  socket.on('heartbeat', safe('heartbeat', () => {
    if (authenticated) socketLastActivity = Date.now();
  }));

  // Resize de una sesion especifica (usa persistentId)
  socket.on('resize', safe('resize', ({ id, cols, rows }) => {
    if (authenticated &&
        typeof id === 'string' &&
        Number.isInteger(cols) && cols >= 1 && cols <= 500 &&
        Number.isInteger(rows) && rows >= 1 && rows <= 200) {
      socketLastActivity = Date.now();
      const entry = ptyStore.get(id);
      if (entry) {
        try { entry.pty.resize(cols, rows); } catch (e) {
          console.warn(`[PTY] resize fallido en ${id}:`, e.message);
        }
      }
    }
  }));

  // File browser: listar directorio
  socket.on('fs:list', safe('fs:list', async (dirPath, callback) => {
    if (!authenticated) return;
    if (typeof callback !== 'function') return;
    if (typeof dirPath !== 'string' && dirPath != null) {
      callback({ path: '', items: [], error: 'No se pudo listar el directorio' });
      return;
    }
    const resolved = path.resolve(dirPath || CWD);
    const normalizedCwd = path.resolve(CWD);
    // Case-insensitive jail on Windows (NTFS), case-sensitive on POSIX
    const ci = process.platform === 'win32';
    const rNorm = ci ? resolved.toLowerCase() : resolved;
    const cNorm = ci ? normalizedCwd.toLowerCase() : normalizedCwd;
    if (rNorm !== cNorm && !rNorm.startsWith(cNorm + path.sep)) {
      callback({ path: normalizedCwd, items: [], error: 'Acceso denegado: fuera del directorio raiz' });
      return;
    }
    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        fullPath: path.join(resolved, e.name),
      })).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      callback({ path: resolved, items, error: null });
    } catch (err) {
      console.error('[FS] Error listando directorio:', err.message);
      callback({ path: resolved, items: [], error: 'No se pudo listar el directorio' });
    }
  }));

  // Desconexion: grace period en vez de kill inmediato
  socket.on('disconnect', safe('disconnect', () => {
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
  }));
});

// Log periodico de recursos (journald se encarga de la rotacion)
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const rssMb = Math.round(process.memoryUsage.rss() / 1048576);
  const conns = io.engine ? io.engine.clientsCount : 0;
  console.log(`[HEALTH] RSS ${rssMb}MB | PTYs ${ptyStore.size} | conexiones ${conns}`);
}, HEALTH_LOG_INTERVAL_MS).unref();

// === Arrancar servidor ===
server.listen(PORT, () => {
  const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
  console.log(`Wibetunnel corriendo en ${proto}://localhost:${PORT}`);
  if (SESSION_TIMEOUT > 0) console.log(`[TIMEOUT] Inactividad: ${SESSION_TIMEOUT} min`);
  if (RATE_MAX) console.log(`[RATE] Max ${RATE_MAX} intentos fallidos, bloqueo ${RATE_WINDOW} min`);
  console.log(`[RECONNECT] Grace: ${RECONNECT_GRACE}s, Buffer: ${BUFFER_SIZE} bytes`);
});

// === Graceful shutdown: limpiar PTYs (incluyendo huerfanos) y cerrar servidor ===
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
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
  }, SHUTDOWN_GRACE_MS);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Politica de crashes: un error aislado se registra y el proceso sigue (las sesiones
// sobreviven). Solo si hay una rafaga de errores (estado probablemente corrupto)
// se apaga de forma ordenada; systemd se encarga de reiniciar.
const CRASH_BURST_MAX = 3;
const CRASH_BURST_WINDOW_MS = 60000;
let crashTimes = [];
function recordCrash(kind, err) {
  console.error(`[ERROR] ${kind}:`, err);
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < CRASH_BURST_WINDOW_MS);
  crashTimes.push(now);
  if (crashTimes.length > CRASH_BURST_MAX) {
    console.error(`[ERROR] ${crashTimes.length} errores en ${CRASH_BURST_WINDOW_MS / 1000}s, apagando`);
    gracefulShutdown(kind);
  }
}
process.on('uncaughtException', (err) => recordCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => recordCrash('unhandledRejection', reason));
