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

// Cleanup: eliminar entries expirados cada hora
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (!entry.blockedUntil || now >= entry.blockedUntil) {
      authAttempts.delete(ip);
    }
  }
}, AUTH_CLEANUP_INTERVAL_MS).unref();

module.exports = { getClientIp, getHttpClientIp, tokenMatches, checkRateLimit, recordFailedAuth, clearAuthAttempts };
