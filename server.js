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
const SESSION_TIMEOUT = parseInt(process.env.WIBE_TIMEOUT) || 30;
// HTTPS: rutas a cert y key (opcional)
const SSL_CERT = process.env.WIBE_SSL_CERT || '';
const SSL_KEY = process.env.WIBE_SSL_KEY || '';

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
const io = new Server(server);

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

// Servir archivos estáticos (public/)
app.use(express.static(path.join(__dirname, 'public')));

// Maximo de sesiones simultaneas
const MAX_SESSIONS = parseInt(process.env.WIBE_MAX_SESSIONS) || 5;

// === Manejar conexiones WebSocket ===
io.on('connection', (socket) => {
  let authenticated = false;
  const sessions = new Map(); // sessionId → ptyProcess
  let lastActivity = Date.now();
  let timeoutChecker = null;
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  // Autenticacion con rate limiting
  socket.on('auth', (clientToken) => {
    if (!checkRateLimit(ip)) {
      socket.emit('auth_ratelimited');
      socket.disconnect(true);
      return;
    }
    if (clientToken !== TOKEN) {
      recordFailedAuth(ip);
      socket.emit('auth_failed');
      socket.disconnect(true);
      return;
    }
    clearAuthAttempts(ip);
    authenticated = true;
    socket.emit('auth_success', { shortcuts: SHORTCUTS, maxSessions: MAX_SESSIONS });

    // Iniciar session timeout si esta configurado
    if (SESSION_TIMEOUT > 0) {
      timeoutChecker = setInterval(() => {
        const elapsed = (Date.now() - lastActivity) / 1000 / 60;
        if (elapsed >= SESSION_TIMEOUT) {
          console.log(`[TIMEOUT] Socket ${ip} desconectado por inactividad (${SESSION_TIMEOUT} min)`);
          socket.emit('session:timeout');
          socket.disconnect(true);
        }
      }, 60 * 1000); // check cada minuto
    }
  });

  // Crear nueva sesion PTY
  socket.on('session:create', (sessionId) => {
    if (!authenticated || sessions.size >= MAX_SESSIONS) return;

    const ptyProcess = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: CWD,
      env: process.env
    });

    sessions.set(sessionId, ptyProcess);

    // Reenviar output al navegador con el sessionId
    ptyProcess.onData((data) => {
      socket.emit('output', { id: sessionId, data });
    });

    // Terminal cerrado (usuario escribio exit, etc.)
    ptyProcess.onExit(() => {
      socket.emit('session:exit', sessionId);
      sessions.delete(sessionId);
    });

    socket.emit('session:created', sessionId);
    console.log(`[+] Sesion ${sessionId} (PID: ${ptyProcess.pid})`);
  });

  // Cerrar una sesion
  socket.on('session:kill', (sessionId) => {
    const proc = sessions.get(sessionId);
    if (proc) {
      console.log(`[-] Sesion ${sessionId} cerrada (PID: ${proc.pid})`);
      proc.kill();
      sessions.delete(sessionId);
    }
  });

  // Input del navegador → terminal (con sessionId)
  socket.on('input', ({ id, data }) => {
    if (authenticated) {
      lastActivity = Date.now();
      const proc = sessions.get(id);
      if (proc) proc.write(data);
    }
  });

  // Resize de una sesion especifica
  socket.on('resize', ({ id, cols, rows }) => {
    if (authenticated) {
      lastActivity = Date.now();
      const proc = sessions.get(id);
      if (proc) {
        try { proc.resize(cols, rows); } catch (e) {}
      }
    }
  });

  // File browser: listar directorio
  socket.on('fs:list', (dirPath, callback) => {
    if (!authenticated) return;
    // Resolver ruta absoluta, limitar a CWD como raiz
    const resolved = path.resolve(dirPath || CWD);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
      })).sort((a, b) => {
        // Carpetas primero, luego alfabetico
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      callback({ path: resolved, items, error: null });
    } catch (err) {
      callback({ path: resolved, items: [], error: err.message });
    }
  });

  // Desconexion: limpiar todas las sesiones PTY y timeout
  socket.on('disconnect', () => {
    if (timeoutChecker) clearInterval(timeoutChecker);
    for (const [sid, proc] of sessions) {
      console.log(`[-] Sesion ${sid} cerrada (PID: ${proc.pid})`);
      proc.kill();
    }
    sessions.clear();
  });
});

// === Arrancar servidor ===
server.listen(PORT, () => {
  const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
  console.log(`Wibetunnel corriendo en ${proto}://localhost:${PORT}`);
  if (SESSION_TIMEOUT > 0) console.log(`[TIMEOUT] Inactividad: ${SESSION_TIMEOUT} min`);
  if (RATE_MAX) console.log(`[RATE] Max ${RATE_MAX} intentos fallidos, bloqueo ${RATE_WINDOW} min`);
});
