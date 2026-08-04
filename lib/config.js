// Configuracion desde .env: unica fuente de constantes de runtime
require('dotenv').config();
const path = require('path');
const os = require('os');

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
const RATE_MAX = parseInt(process.env.WIBE_RATE_MAX) || 5;        // intentos max
const RATE_WINDOW = parseInt(process.env.WIBE_RATE_WINDOW) || 15; // minutos de bloqueo
// Session timeout (minutos, 0 = desactivado)
const SESSION_TIMEOUT = parseInt(process.env.WIBE_TIMEOUT) || 0;
// Reconexion persistente
const RECONNECT_GRACE = parseInt(process.env.WIBE_RECONNECT_GRACE) || 1800; // segundos
const BUFFER_SIZE = parseInt(process.env.WIBE_BUFFER_SIZE) || 51200;        // bytes
const MAX_CONNECTIONS = parseInt(process.env.WIBE_MAX_CONN, 10) || 10;
// Maximo de sesiones simultaneas por socket
const MAX_SESSIONS = parseInt(process.env.WIBE_MAX_SESSIONS) || 5;
// Techo global de PTYs vivos (incluye huerfanos en grace period)
const MAX_PTYS = parseInt(process.env.WIBE_MAX_PTYS, 10) || 15;
// Backpressure: pausar el PTY si la cola de escritura del socket supera HIGH, reanudar bajo LOW
const BP_HIGH = parseInt(process.env.WIBE_BP_HIGH, 10) || 262144; // 256 KB
const BP_LOW = parseInt(process.env.WIBE_BP_LOW, 10) || 65536;    // 64 KB

const AUTH_TIMEOUT_MS = 30000;
const AUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;
const OUTPUT_BATCH_MS = 8; // ms entre flushes de output (≈120fps)

// Direccion de bind. Default permisivo para no romper instalaciones existentes;
// en produccion se pone 127.0.0.1 porque los proxies (cloudflared, tailscale
// serve) llegan por loopback y asi no queda el puerto abierto sin ellos delante.
const HOST = process.env.WIBE_HOST || '0.0.0.0';

// HTTPS: rutas a cert y key (opcional)
const SSL_CERT = process.env.WIBE_SSL_CERT || '';
const SSL_KEY = process.env.WIBE_SSL_KEY || '';

// Origenes adicionales permitidos (ej. dominio de Cloudflare tunnel)
const ALLOWED_ORIGINS = new Set(
  (process.env.WIBE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Solo confiar en headers de proxy si el servidor está detrás de un proxy conocido
const TRUST_PROXY = process.env.WIBE_TRUST_PROXY === 'true';

// Perfiles de shell: "Label=shell|cwd_opcional,Label2=shell2"
// Ej: WIBE_PROFILES=Bash=/bin/bash,Zsh=/usr/bin/zsh|/home/user/proyectos
const PROFILES = (process.env.WIBE_PROFILES || '').split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const eq = s.indexOf('=');
    if (eq <= 0) return null;
    const label = s.slice(0, eq);
    const [shell, cwd] = s.slice(eq + 1).split('|');
    return shell ? { label, shell: shell.trim(), cwd: (cwd || '').trim() || null } : null;
  })
  .filter(Boolean);

// Subida de archivos: tamaño maximo en bytes (default 100 MB)
const UPLOAD_MAX = parseInt(process.env.WIBE_UPLOAD_MAX, 10) || 104857600;

// Edicion de archivos de texto: tope de lectura Y de escritura (default 1 MiB).
// Muy por debajo de UPLOAD_MAX a proposito: un textarea con 1 MB ya va justo en
// movil, y acota el coste del hash y el pico de memoria por peticion.
const EDIT_MAX = parseInt(process.env.WIBE_EDIT_MAX, 10) || 1048576;

// Grabaciones de sesion
const REC_DIR = process.env.WIBE_REC_DIR || path.join(os.homedir(), '.wibetunnel', 'recordings');

// Vista "/claude" (experimental, no promocionada a la UI principal): lee en
// vivo el transcript JSONL de Claude Code para renderizarlo como chat.
// Se puede apagar sin tocar codigo si se considera riesgo de exposicion.
const CLAUDE_VIEW = process.env.WIBE_CLAUDE_VIEW !== 'false';
const CLAUDE_HOME = process.env.WIBE_CLAUDE_HOME || path.join(os.homedir(), '.claude');

module.exports = {
  TOKEN, PORT, HOST, SHELL, CWD, SHORTCUTS,
  RATE_MAX, RATE_WINDOW, SESSION_TIMEOUT, RECONNECT_GRACE, BUFFER_SIZE,
  MAX_CONNECTIONS, MAX_SESSIONS, MAX_PTYS, BP_HIGH, BP_LOW,
  AUTH_TIMEOUT_MS, AUTH_CLEANUP_INTERVAL_MS, SHUTDOWN_GRACE_MS, OUTPUT_BATCH_MS,
  SSL_CERT, SSL_KEY, ALLOWED_ORIGINS, TRUST_PROXY,
  PROFILES, UPLOAD_MAX, EDIT_MAX, REC_DIR,
  CLAUDE_VIEW, CLAUDE_HOME,
};
