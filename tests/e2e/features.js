// E2E de features Fase 5: subida/descarga con jail, /health con detalle,
// perfiles de shell y grabación de sesión.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.WIBE_TEST_URL || 'http://localhost:4021/';
const TOKEN = process.env.WIBE_TEST_TOKEN || 'smoketest-token';

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();

  await page.goto(URL);
  await page.fill('#token', TOKEN);
  await page.click('#btn-connect');
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(2000);
  console.log('OK: sesión creada');

  const fetchJson = (js) => page.evaluate(js);

  // --- Upload + download roundtrip ---
  const up = await fetchJson(`
    fetch('/fs/upload?dir=&name=e2e-upload.txt', {
      method: 'POST',
      headers: { Authorization: 'Bearer ${TOKEN}', 'Content-Type': 'application/octet-stream' },
      body: 'contenido-e2e-12345'
    }).then(r => r.json())
  `);
  if (!up.ok) { console.log('FAIL upload:', JSON.stringify(up)); process.exit(1); }
  console.log('PASS: upload ok', JSON.stringify(up));

  const down = await fetchJson(`
    fetch('/fs/download?path=' + encodeURIComponent('e2e-upload.txt'), {
      headers: { Authorization: 'Bearer ${TOKEN}' }
    }).then(r => r.text())
  `);
  if (down !== 'contenido-e2e-12345') { console.log('FAIL download:', down.slice(0, 100)); process.exit(1); }
  console.log('PASS: download roundtrip correcto');

  // --- Jail: descargar fuera del CWD debe fallar ---
  const jail = await fetchJson(`
    fetch('/fs/download?path=' + encodeURIComponent('/etc/passwd'), {
      headers: { Authorization: 'Bearer ${TOKEN}' }
    }).then(r => r.status)
  `);
  if (jail !== 403 && jail !== 404) { console.log('FAIL jail: status', jail); process.exit(1); }
  console.log(`PASS: descarga fuera del jail denegada (${jail})`);

  // --- Sin token → 401 ---
  const noauth = await fetchJson(`fetch('/fs/download?path=e2e-upload.txt').then(r => r.status)`);
  if (noauth !== 401) { console.log('FAIL auth: status', noauth); process.exit(1); }
  console.log('PASS: descarga sin token rechazada (401)');

  // --- /health con detalle de sesiones ---
  const health = await fetchJson(`
    fetch('/health', { headers: { Authorization: 'Bearer ${TOKEN}' } }).then(r => r.json())
  `);
  if (!Array.isArray(health.sessions) || health.sessions.length < 1) {
    console.log('FAIL health:', JSON.stringify(health)); process.exit(1);
  }
  console.log(`PASS: /health con ${health.sessions.length} sesión(es), RSS ${Math.round(health.rssBytes / 1048576)}MB`);

  // --- Perfiles: el servidor anuncia los labels ---
  const profiles = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.profiles;
  });
  if (!profiles.includes('Sh')) { console.log('FAIL profiles:', JSON.stringify(profiles)); process.exit(1); }
  console.log('PASS: perfiles anunciados:', JSON.stringify(profiles));

  // Crear sesión con perfil Sh y verificar que responde
  const created = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 5000);
      state.socket.once('session:created', (d) => { clearTimeout(t); resolve(d); });
      state.socket.emit('session:create', { id: 'ses-e2e-profile', profile: 'Sh' });
    });
  });
  if (!created || !created.persistentId) { console.log('FAIL: sesión con perfil no creada'); process.exit(1); }
  console.log('PASS: sesión creada con perfil Sh:', created.persistentId);

  // Perfil desconocido → session:error
  const badProfile = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      state.socket.once('session:error', (d) => { clearTimeout(t); resolve(d); });
      state.socket.emit('session:create', { id: 'ses-e2e-bad', profile: 'NoExiste' });
    });
  });
  if (!badProfile || !/Perfil/.test(badProfile.error)) { console.log('FAIL: perfil inválido no rechazado'); process.exit(1); }
  console.log('PASS: perfil desconocido rechazado');

  // --- Grabación: start → output → stop → verificar fichero ---
  const recStart = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const s = state.sessions.get(state.activeId);
    return new Promise((resolve) => {
      state.socket.emit('session:record', s.persistentId, resolve);
    });
  });
  if (!recStart.recording) { console.log('FAIL rec start:', JSON.stringify(recStart)); process.exit(1); }
  console.log('PASS: grabación iniciada:', recStart.file);

  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('echo MARCA_GRABACION_XYZ');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const recStop = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const s = state.sessions.get(state.activeId);
    return new Promise((resolve) => {
      state.socket.emit('session:record', s.persistentId, resolve);
    });
  });
  if (recStop.recording !== false) { console.log('FAIL rec stop:', JSON.stringify(recStop)); process.exit(1); }

  await new Promise(r => setTimeout(r, 500)); // flush del stream
  const recContent = fs.readFileSync(recStop.file, 'utf8');
  if (!recContent.includes('MARCA_GRABACION_XYZ')) {
    console.log('FAIL: la grabación no contiene la marca'); process.exit(1);
  }
  console.log(`PASS: grabación guardada y contiene la salida (${recContent.length} bytes en ${path.basename(recStop.file)})`);

  // --- PWA: manifest y service worker servidos ---
  const pwa = await fetchJson(`
    Promise.all([
      fetch('/manifest.json').then(r => r.status),
      fetch('/sw.js').then(r => r.status),
      fetch('/icons/icon-192.png').then(r => r.status),
    ])
  `);
  if (pwa.some(s => s !== 200)) { console.log('FAIL pwa assets:', JSON.stringify(pwa)); process.exit(1); }
  console.log('PASS: manifest, sw.js e iconos servidos');

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
