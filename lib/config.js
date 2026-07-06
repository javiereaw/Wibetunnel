// Configuracion desde .env: unica fuente de constantes de runtime
require('dotenv').config();

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

// HTTPS: rutas a cert y key (opcional)
const SSL_CERT = process.env.WIBE_SSL_CERT || '';
const SSL_KEY = process.env.WIBE_SSL_KEY || '';

// Origenes adicionales permitidos (ej. dominio de Cloudflare tunnel)
const ALLOWED_ORIGINS = new Set(
  (process.env.WIBE_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Solo confiar en headers de proxy si el servidor está detrás de un proxy conocido
const TRUST_PROXY = process.env.WIBE_TRUST_PROXY === 'true';

module.exports = {
  TOKEN, PORT, SHELL, CWD, SHORTCUTS,
  RATE_MAX, RATE_WINDOW, SESSION_TIMEOUT, RECONNECT_GRACE, BUFFER_SIZE,
  MAX_CONNECTIONS, MAX_SESSIONS, MAX_PTYS, BP_HIGH, BP_LOW,
  AUTH_TIMEOUT_MS, AUTH_CLEANUP_INTERVAL_MS, SHUTDOWN_GRACE_MS, OUTPUT_BATCH_MS,
  SSL_CERT, SSL_KEY, ALLOWED_ORIGINS, TRUST_PROXY,
};
