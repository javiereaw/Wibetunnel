// Autenticacion y rate limiting en memoria
const log = require('./log');
const crypto = require('crypto');
const { TOKEN, RATE_MAX, RATE_WINDOW, TRUST_PROXY, AUTH_CLEANUP_INTERVAL_MS } = require('./config');

// IP real del cliente. Tras Cloudflare Tunnel, cf-connecting-ip es la fuente
// fiable (Cloudflare la impone); x-forwarded-for como fallback para otros proxies.
function getClientIp(socket) {
  if (TRUST_PROXY) {
    const cf = socket.handshake.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return socket.handshake.address;
}

// Variante HTTP de getClientIp (Express req en vez de handshake de socket.io)
function getHttpClientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

// Comparacion timing-safe contra el token configurado
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const authAttempts = new Map(); // ip → { count, firstAttempt, blockedUntil }

function checkRateLimit(ip) {
  const entry = authAttempts.get(ip);
  if (!entry || !entry.blockedUntil) return true;
  if (Date.now() < entry.blockedUntil) return false;
  authAttempts.delete(ip); // bloqueo expirado
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
    log.info(`[RATE] IP ${ip} bloqueada por ${RATE_WINDOW} min (${entry.count} intentos fallidos)`);
  }
  authAttempts.set(ip, entry);
}

function clearAuthAttempts(ip) {
  authAttempts.delete(ip);
}

// Auth HTTP compartida: Authorization: Bearer <token>, con el mismo rate
// limiter que el auth de socket (antes los endpoints HTTP permitian brute-force).
// No es middleware de Express a proposito: cada ruta decide cuando aplicarlo
// (/healthz es publica deliberadamente).
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

// Rate limit de OPERACION, distinto del de auth: el de arriba solo frena
// intentos fallidos, asi que una peticion autenticada en bucle (un autoguardado
// defectuoso) podria martillear el disco sin tope.
const opCounters = new Map(); // "ip|op" → { count, windowStart }

function checkOpRate(ip, op, max, windowMs) {
  const key = ip + '|' + op;
  const now = Date.now();
  const entry = opCounters.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    opCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

// Cleanup: eliminar entries expirados cada hora
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, entry] of opCounters) {
    if (entry.windowStart < cutoff) opCounters.delete(key);
  }
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (!entry.blockedUntil || now >= entry.blockedUntil) {
      authAttempts.delete(ip);
    }
  }
}, AUTH_CLEANUP_INTERVAL_MS).unref();

module.exports = {
  getClientIp, getHttpClientIp, tokenMatches,
  checkRateLimit, recordFailedAuth, clearAuthAttempts,
  httpAuthed, checkOpRate,
};
