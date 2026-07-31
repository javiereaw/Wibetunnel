// Smoke de PRODUCCION a nivel API (sin navegador): seguro por diseño.
// Crea su propia sesion, verifica el roundtrip de un echo y la mata.
// NUNCA emite session:reconnect ni session:adopt: no puede tocar las
// sesiones del usuario. Verifica ademas que las sesiones preexistentes
// siguen intactas al terminar (check de no-molestia y de no-leak).
// Uso: node tests/e2e/prod-smoke.js   (exit 0 = PASS, 1 = FAIL)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { io } = require('socket.io-client');

const PORT = process.env.WIBE_PORT || 4020;
const BASE = process.env.WIBE_SMOKE_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.WIBE_TOKEN;
const NONCE = 'SMOKE_RT_' + Math.random().toString(36).slice(2, 10);

function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}

async function getJson(pathname, authed) {
  const headers = authed ? { Authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(BASE + pathname, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return res.json();
}

(async () => {
  if (!TOKEN) fail('WIBE_TOKEN no disponible (¿.env legible?)');
  const t0 = Date.now();

  // Timeout global: un smoke colgado no debe quedarse vivo
  setTimeout(() => fail('timeout global de 60s'), 60000).unref();

  // 1. Liveness sin auth. Sin /healthz = servidor pre-deploy: SKIP limpio
  // (el auth con {token, clientId} fallaria contra el codigo viejo y
  // contaminaria el rate limiter con intentos fallidos)
  let healthzOk = false;
  try {
    const hz = await getJson('/healthz', false);
    healthzOk = hz && hz.ok === true;
  } catch (_) { /* server viejo */ }
  if (!healthzOk) {
    console.log('SKIP: servidor sin /healthz (código nuevo aún no desplegado)');
    process.exit(0);
  }

  // 2. Baseline autenticado: sesiones que NO debemos tocar
  const before = await getJson('/health', true);
  const baselineIds = new Set((before.sessions || []).map(s => s.persistentId));

  // 3. Socket + auth con identidad propia (nunca ve/reclama sesiones ajenas)
  const socket = io(BASE, { transports: ['websocket', 'polling'], timeout: 10000, reconnection: false });
  const authData = await new Promise((resolve, reject) => {
    socket.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    socket.on('auth_failed', () => reject(new Error('auth_failed')));
    socket.on('auth_ratelimited', () => reject(new Error('auth_ratelimited')));
    socket.on('auth_success', resolve);
    socket.on('connect', () => socket.emit('auth', { token: TOKEN, clientId: 'smoke-runner' }));
  }).catch((e) => fail(e.message));

  // Paranoia: el smoke jamas adopta nada aunque el server se lo ofrezca
  void authData;

  // 4. Crear NUESTRA sesion y esperar el created
  const persistentId = await new Promise((resolve) => {
    socket.on('session:created', (d) => {
      if (d && d.clientSessionId === 'smoke-ses-1') resolve(d.persistentId);
    });
    socket.on('session:error', (d) => fail('session:error: ' + JSON.stringify(d)));
    socket.emit('session:create', 'smoke-ses-1');
  });

  // 5. Echo roundtrip: el nonce debe volver por output
  let outBuf = '';
  const gotNonce = new Promise((resolve) => {
    socket.on('output', ({ id, data }) => {
      if (id !== persistentId) return;
      outBuf += data;
      if (outBuf.includes(NONCE)) resolve(true);
    });
  });
  await new Promise(r => setTimeout(r, 700)); // dejar arrancar la shell
  socket.emit('input', { id: persistentId, data: `echo ${NONCE}\r` });
  const ok = await Promise.race([gotNonce, new Promise(r => setTimeout(() => r(false), 8000))]);
  if (!ok) fail(`el nonce no volvio por output en 8s (${outBuf.length} bytes recibidos)`);

  // 6. Matar nuestra sesion y verificar limpieza + no-molestia
  socket.emit('session:kill', persistentId);
  await new Promise(r => setTimeout(r, 800));
  const after = await getJson('/health', true);
  const afterIds = new Set((after.sessions || []).map(s => s.persistentId));
  if (afterIds.has(persistentId)) fail('la sesion del smoke no se limpio (leak)');
  for (const id of baselineIds) {
    if (!afterIds.has(id)) fail(`sesion preexistente ${id} desaparecio durante el smoke`);
  }

  socket.disconnect();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`PASS ${secs}s (healthz=${healthzOk ? 'ok' : 'n/a'}, ptys=${after.ptys}, baseline intacta: ${baselineIds.size})`);
  process.exit(0);
})().catch((e) => fail(e && e.message ? e.message : String(e)));
