// Wibetunnel - Terminal web minimalista
// Servidor principal: Express + Socket.IO; la logica vive en lib/
const log = require('./lib/log');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const config = require('./lib/config');
const { getClientIp, getHttpClientIp, tokenMatches, checkRateLimit, recordFailedAuth, clearAuthAttempts } = require('./lib/auth');
const metrics = require('./lib/metrics');
const ptyStore = require('./lib/pty-store');
const claudeWatch = require('./lib/claude-watch');
const { listDirectory, resolveJailed } = require('./lib/fs-handler');

const {
  TOKEN, PORT, SHELL, SHORTCUTS, SESSION_TIMEOUT, RATE_MAX, RATE_WINDOW,
  RECONNECT_GRACE, BUFFER_SIZE, MAX_CONNECTIONS, MAX_SESSIONS,
  AUTH_TIMEOUT_MS, SHUTDOWN_GRACE_MS, SSL_CERT, SSL_KEY, ALLOWED_ORIGINS,
  PROFILES, UPLOAD_MAX, CLAUDE_VIEW,
} = config;

// Validar que el token esté configurado (obligatorio)
if (!TOKEN) {
  log.error('ERROR: WIBE_TOKEN no configurado en .env');
  log.error('Copia .env.example a .env y configura tu token');
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
    log.info('[SSL] HTTPS activado');
  } catch (err) {
    log.error('[SSL] Error cargando certificados:', err.message);
    log.error('[SSL] Cayendo a HTTP');
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
      log.warn('[CONN] Rechazando: max conexiones alcanzado');
      return callback('Too many connections', false);
    }
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    const host = req.headers.host || `localhost:${PORT}`;
    const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
    if (origin === `${proto}://${host}`) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    log.warn(`[CORS] Rechazando origen: ${origin}`);
    callback('Cross-origin not allowed', false);
  },
});
ptyStore.init(io);

// Vista /claude (experimental, pagina aparte — no toca la UI principal): al
// morir un PTY, desenganchar tambien su watcher de transcript si lo tuviera.
if (CLAUDE_VIEW) {
  ptyStore.onSessionExit((persistentId) => claudeWatch.detach(persistentId));
}

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

// Auth HTTP compartida: Authorization: Bearer <token>, con el mismo rate
// limiter que el auth de socket (antes los endpoints HTTP permitian brute-force)
function httpAuthed(req, res) {
  const ip = getHttpClientIp(req);
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'too many attempts' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const candidate = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (tokenMatches(candidate)) {
    clearAuthAttempts(ip);
    return true;
  }
  // Solo cuenta como intento si se presento un token: los probes sin header
  // (401 esperado) no deben poder bloquear al usuario real
  if (candidate) recordFailedAuth(ip);
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Liveness sin auth: solo "ok", ningun dato mas (probes, smoke, uptime checkers)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Health: estado de recursos + detalle por sesion (para el panel de estado)
app.get('/health', (req, res) => {
  if (!httpAuthed(req, res)) return;
  const s = ptyStore.stats();
  res.json({
    uptime: Math.round(process.uptime()),
    rssBytes: process.memoryUsage.rss(),
    ptys: s.ptys,
    pausedPtys: s.paused,
    connections: io.engine ? io.engine.clientsCount : 0,
    sessions: ptyStore.sessionsDetail(),
    metrics: metrics.snapshot(),
  });
});

// Descarga de archivos (dentro del jail de CWD)
app.get('/fs/download', async (req, res) => {
  try {
    if (!httpAuthed(req, res)) return;
    const r = await resolveJailed(String(req.query.path || ''));
    if (r.error) return res.status(r.error === 'denied' ? 403 : 404).json({ error: r.error });
    const st = await fs.promises.stat(r.path);
    if (!st.isFile()) return res.status(400).json({ error: 'no es un archivo' });
    const name = path.basename(r.path);
    metrics.inc('downloads');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.sendFile(r.path);
  } catch (err) {
    log.error('[FS] download:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'error interno' });
  }
});

// Subida de archivos (streaming a disco, con limite de tamaño y jail)
app.post('/fs/upload', async (req, res) => {
  try {
    if (!httpAuthed(req, res)) return;
    const name = path.basename(String(req.query.name || ''));
    if (!name || name === '.' || name === '..') return res.status(400).json({ error: 'nombre invalido' });
    const r = await resolveJailed(String(req.query.dir || ''));
    if (r.error) return res.status(r.error === 'denied' ? 403 : 404).json({ error: r.error });
    const st = await fs.promises.stat(r.path);
    if (!st.isDirectory()) return res.status(400).json({ error: 'destino no es un directorio' });

    const dest = path.join(r.path, name);
    // No escribir sobre symlinks preexistentes: un enlace plantado dentro del
    // jail permitiria escribir fuera (p.ej. ~/.ssh/authorized_keys)
    const lst = await fs.promises.lstat(dest).catch(() => null);
    if (lst && (lst.isSymbolicLink() || !lst.isFile())) {
      return res.status(400).json({ error: 'destino invalido' });
    }
    const out = fs.createWriteStream(dest);
    let bytes = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > UPLOAD_MAX && !aborted) {
        aborted = true;
        out.destroy();
        fs.promises.unlink(dest).catch(() => {});
        res.status(413).json({ error: 'archivo demasiado grande' });
        req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      metrics.inc('uploads');
      log.info(`[FS] subido ${dest} (${bytes} bytes)`);
      res.json({ ok: true, name, bytes });
    });
    out.on('error', (err) => {
      if (aborted) return;
      log.error('[FS] upload:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'no se pudo guardar' });
    });
  } catch (err) {
    log.error('[FS] upload:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'error interno' });
  }
});

// /sw.js dinamico (ANTES del static, o ganaria el fichero en disco): sustituye
// __WIBE_BUILD__ por el sello de build — cada deploy que toca public/ produce
// un SW byte-distinto y fuerza reinstalacion + refresco del precache
const { buildStamp } = require('./lib/build-stamp');
const PUBLIC_DIR = path.join(__dirname, 'public');
const swBody = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
  .replaceAll('__WIBE_BUILD__', buildStamp(PUBLIC_DIR));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(swBody);
});

// Vista /claude: pagina nueva y separada de "/" (la UI de siempre no se toca).
// El propio archivo tambien es servible como /claude.html via el static de abajo;
// esta ruta es solo el alias sin extension.
if (CLAUDE_VIEW) {
  app.get('/claude', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'claude.html')));
}

// Servir archivos estáticos (public/) con revalidacion forzada: sin esto el
// navegador aplica cache heuristica y puede quedarse con JS viejo tras un deploy
// (el ETag hace que la revalidacion sea un 304 barato)
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Aisla errores de un handler: un throw no debe tumbar el proceso ni afectar a otras sesiones
function safe(name, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          metrics.err(name);
          log.error(`[ERROR] Handler ${name}:`, err);
        });
      }
    } catch (err) {
      metrics.err(name);
      log.error(`[ERROR] Handler ${name}:`, err);
    }
  };
}

// === Manejar conexiones WebSocket ===
io.on('connection', (socket) => {
  let authenticated = false;
  let clientId = null;
  let socketLastActivity = Date.now();
  let timeoutChecker = null;
  const ip = getClientIp(socket);
  const claudeAttached = new Set(); // persistentIds con watcher de /claude activo en ESTE socket

  socket.on('error', (err) => {
    log.error(`[ERROR] Socket ${socket.id}:`, err && err.message ? err.message : err);
  });

  // Al drenar la cola del transporte, reanudar los PTYs pausados por backpressure
  socket.conn.on('drain', safe('drain', () => ptyStore.onSocketDrain(socket)));

  // Disconnect sockets that never authenticate
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.disconnect(true);
  }, AUTH_TIMEOUT_MS);

  ptyStore.registerSocket(socket.id);

  // Autenticacion con rate limiting. Acepta string (back-compat) o { token, clientId }
  socket.on('auth', safe('auth', (payload) => {
    if (authenticated) return; // Prevent re-auth
    let clientToken = payload;
    if (payload && typeof payload === 'object') {
      clientToken = payload.token;
      if (typeof payload.clientId === 'string' && payload.clientId.length > 0 && payload.clientId.length <= 64) {
        clientId = payload.clientId;
      }
    }
    if (!checkRateLimit(ip)) {
      metrics.inc('authRatelimited');
      metrics.event('auth_ratelimited', { ip });
      socket.emit('auth_ratelimited');
      socket.disconnect(true);
      return;
    }
    if (!tokenMatches(clientToken)) {
      metrics.inc('authFail');
      metrics.event('auth_fail', { ip });
      recordFailedAuth(ip);
      socket.emit('auth_failed');
      socket.disconnect(true);
      return;
    }
    clearTimeout(authTimer);
    clearAuthAttempts(ip);
    metrics.inc('authOk');
    authenticated = true;
    if (clientId) ptyStore.setSocketClient(socket.id, clientId);
    const shellType = SHELL.toLowerCase().includes('powershell') ? 'powershell' : 'posix';
    socket.emit('auth_success', {
      shortcuts: SHORTCUTS,
      maxSessions: MAX_SESSIONS,
      // Solo las sesiones propias (o legacy sin dueño): las de otros dispositivos
      // se descubren via session:list y se adoptan explicitamente
      activeSessions: ptyStore.getActiveSessionsList(clientId),
      shellType,
      // Solo labels: las rutas de shell/cwd no salen del servidor
      profiles: PROFILES.map(p => p.label),
    });

    // Iniciar session timeout si esta configurado
    if (SESSION_TIMEOUT > 0) {
      timeoutChecker = setInterval(() => {
        const mostRecent = ptyStore.latestActivity(socket.id, socketLastActivity);
        if ((Date.now() - mostRecent) / 1000 / 60 >= SESSION_TIMEOUT) {
          log.info(`[TIMEOUT] Socket ${ip} desconectado por inactividad (${SESSION_TIMEOUT} min)`);
          socket.emit('session:timeout');
          socket.disconnect(true);
        }
      }, 60 * 1000);
    }
  }));

  // Crear nueva sesion PTY. Acepta string (back-compat) o { id, profile }
  socket.on('session:create', safe('session:create', (payload) => {
    if (!authenticated) return;
    let clientSessionId = payload;
    let profileLabel = null;
    if (payload && typeof payload === 'object') {
      clientSessionId = payload.id;
      profileLabel = payload.profile;
    }
    if (typeof clientSessionId !== 'string') return;

    // El perfil se valida contra la lista del servidor: el cliente solo envia el label
    let profile = null;
    if (profileLabel) {
      profile = PROFILES.find(p => p.label === profileLabel) || null;
      if (!profile) {
        socket.emit('session:error', { clientSessionId, error: 'Perfil desconocido' });
        return;
      }
    }

    const result = ptyStore.createSession(socket, clientSessionId, profile);
    if (result.duplicate) {
      // Idempotente: re-emitir el created cura tabs que perdieron el ack original
      socket.emit('session:created', { clientSessionId, persistentId: result.persistentId });
      return;
    }
    if (result.error) {
      socket.emit('session:error', { clientSessionId, error: result.error });
      return;
    }
    socket.emit('session:created', { clientSessionId, persistentId: result.persistentId });
  }));

  // Alternar grabacion de una sesion a fichero
  socket.on('session:record', safe('session:record', (persistentId, callback) => {
    if (!authenticated || typeof persistentId !== 'string' || typeof callback !== 'function') return;
    callback(ptyStore.toggleRecording(persistentId));
  }));

  // Reconectar sesiones existentes
  socket.on('session:reconnect', safe('session:reconnect', (persistentIds, callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    if (!Array.isArray(persistentIds)) { callback([]); return; }
    callback(ptyStore.reconnectSessions(socket, persistentIds));
  }));

  // Listar sesiones activas, incluidas las de otros dispositivos (mine:false)
  socket.on('session:list', safe('session:list', (callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    callback(ptyStore.getActiveSessionsList(clientId, true));
  }));

  // Adoptar explicitamente una sesion (de otro dispositivo o recuperar una movida)
  socket.on('session:adopt', safe('session:adopt', (persistentId, callback) => {
    if (!authenticated || typeof persistentId !== 'string' || typeof callback !== 'function') return;
    callback(ptyStore.adoptSession(socket, persistentId));
  }));

  // Cerrar una sesion (usa persistentId)
  socket.on('session:kill', safe('session:kill', (persistentId) => {
    if (!authenticated || typeof persistentId !== 'string') return;
    ptyStore.killSession(persistentId);
  }));

  // Input del navegador → terminal (usa persistentId)
  socket.on('input', safe('input', ({ id, data }) => {
    if (authenticated && typeof id === 'string' && typeof data === 'string' && data.length <= 65536) {
      socketLastActivity = Date.now();
      ptyStore.writeInput(id, data);
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
      ptyStore.resizeSession(id, cols, rows);
    }
  }));

  // File browser: listar directorio
  socket.on('fs:list', safe('fs:list', async (dirPath, callback) => {
    if (!authenticated || typeof callback !== 'function') return;
    callback(await listDirectory(dirPath));
  }));

  // Vista /claude: enganchar/desenganchar el seguimiento del transcript JSONL
  // de una sesion. Requiere ademas de auth la misma propiedad que reconnect
  // (mismo clientId, o sesion legacy sin dueño) — leer el chat de Claude Code
  // es mas sensible que el replay de terminal que ya usa este mismo persistentId.
  if (CLAUDE_VIEW) {
    socket.on('claude:attach', safe('claude:attach', (persistentId) => {
      if (!authenticated || typeof persistentId !== 'string') return;
      if (!ptyStore.isOwnedBy(persistentId, clientId)) return;
      const pid = ptyStore.getSessionPid(persistentId);
      if (!pid) return;
      claudeAttached.add(persistentId);
      claudeWatch.attach(persistentId, pid, (event, payload) => {
        if (socket.connected) socket.emit(event, payload);
      });
    }));

    socket.on('claude:detach', safe('claude:detach', (persistentId) => {
      if (typeof persistentId !== 'string') return;
      claudeAttached.delete(persistentId);
      claudeWatch.detach(persistentId);
    }));

    socket.on('claude:more', safe('claude:more', (persistentId, callback) => {
      if (!authenticated || typeof persistentId !== 'string' || typeof callback !== 'function') return;
      if (!claudeAttached.has(persistentId)) { callback({ events: [], hasMore: false }); return; }
      claudeWatch.loadMore(persistentId, callback);
    }));
  }

  // Desconexion: grace period en vez de kill inmediato
  socket.on('disconnect', safe('disconnect', () => {
    clearTimeout(authTimer);
    if (timeoutChecker) clearInterval(timeoutChecker);
    if (CLAUDE_VIEW) {
      for (const pid of claudeAttached) claudeWatch.detach(pid);
      claudeAttached.clear();
    }
    ptyStore.handleDisconnect(socket);
  }));
});

// Log periodico de recursos (journald se encarga de la rotacion).
// La linea [EVT] paralela da la misma serie temporal en JSON parseable.
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const rssMb = Math.round(process.memoryUsage.rss() / 1048576);
  const s = ptyStore.stats();
  const conns = io.engine ? io.engine.clientsCount : 0;
  log.info(`[HEALTH] RSS ${rssMb}MB | PTYs ${s.ptys} | conexiones ${conns}`);
  const m = metrics.snapshot();
  metrics.event('health', {
    rssMb, ptys: s.ptys, paused: s.paused, conns,
    bytesOut: m.bytesOut, reconnects: m.reconnects, takeovers: m.takeovers,
    authFail: m.authFail, uptime: Math.round(process.uptime()),
  });
}, HEALTH_LOG_INTERVAL_MS).unref();

// === Arrancar servidor ===
server.listen(PORT, () => {
  const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
  log.info(`Wibetunnel corriendo en ${proto}://localhost:${PORT}`);
  if (SESSION_TIMEOUT > 0) log.info(`[TIMEOUT] Inactividad: ${SESSION_TIMEOUT} min`);
  if (RATE_MAX) log.info(`[RATE] Max ${RATE_MAX} intentos fallidos, bloqueo ${RATE_WINDOW} min`);
  log.info(`[RECONNECT] Grace: ${RECONNECT_GRACE}s, Buffer: ${BUFFER_SIZE} bytes`);
});

// === Graceful shutdown: limpiar PTYs (incluyendo huerfanos) y cerrar servidor ===
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`\n[SHUTDOWN] Recibido ${signal}, limpiando...`);
  ptyStore.shutdownAll();
  for (const [, socket] of io.sockets.sockets) {
    socket.disconnect(true);
  }
  server.close(() => {
    log.info('[SHUTDOWN] Servidor cerrado limpiamente');
    process.exit(0);
  });
  setTimeout(() => {
    log.error('[SHUTDOWN] Forzando salida');
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
  metrics.err(kind);
  metrics.event('crash', { kind, message: err && err.message ? err.message : String(err) });
  log.error(`[ERROR] ${kind}:`, err);
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < CRASH_BURST_WINDOW_MS);
  crashTimes.push(now);
  if (crashTimes.length > CRASH_BURST_MAX) {
    log.error(`[ERROR] ${crashTimes.length} errores en ${CRASH_BURST_WINDOW_MS / 1000}s, apagando`);
    gracefulShutdown(kind);
  }
}
process.on('uncaughtException', (err) => recordCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => recordCrash('unhandledRejection', reason));
