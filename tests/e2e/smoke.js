// Smoke E2E de Fase 1: login, sesión bash, y verificación del fix de duplicación
// de scrollback tras reconexión (item 1.5). Corre contra localhost:4021.
const { chromium } = require('playwright');

const MARKER = 'DUPCHECK_XYZ';

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

(async () => {
  const browser = await chromium.launch();
  // UA móvil → isMobile=true → renderer DOM (texto legible en el DOM, sin WebGL)
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
    viewport: { width: 900, height: 700 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto((process.env.WIBE_TEST_URL || 'http://localhost:4021/'));
  await page.fill('#token', (process.env.WIBE_TEST_TOKEN || 'smoketest-token'));
  await page.click('#btn-connect');
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  console.log('OK: auth + terminal visible');

  await page.waitForTimeout(2000); // prompt del shell

  // Escribir un comando en el terminal (textarea oculto de xterm)
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type(`echo ${MARKER}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const before = countOccurrences(await page.innerText('body'), MARKER);
  console.log(`Ocurrencias del marcador antes de reconectar: ${before}`);
  if (before < 1) { console.log('FAIL: el comando no produjo output visible'); process.exit(1); }

  // Simular caída de red: cerrar el transporte engine.io por debajo del cliente
  // (los ESM son singletons, state.js devuelve la misma instancia que usa la app)
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    state.socket.io.engine.close();
  });
  await page.waitForSelector('#status', { state: 'visible', timeout: 10000 });
  console.log('OK: desconexión detectada (overlay visible)');
  await page.waitForSelector('#status', { state: 'hidden', timeout: 20000 });
  console.log('OK: reconectado (overlay oculto)');
  await page.waitForTimeout(3000); // replay + repaint

  const after = countOccurrences(await page.innerText('body'), MARKER);
  console.log(`Ocurrencias del marcador después de reconectar: ${after}`);

  if (after > before) {
    console.log(`FAIL: scrollback duplicado (${before} -> ${after})`);
    process.exit(1);
  }
  if (after < 1) {
    console.log('FAIL: el replay no restauró el contenido');
    process.exit(1);
  }
  console.log('PASS: sin duplicación tras reconexión, replay correcto');

  // Verificar que la sesión sigue viva tras la reconexión
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('echo ALIVE_AFTER_RECONNECT');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const alive = countOccurrences(await page.innerText('body'), 'ALIVE_AFTER_RECONNECT');
  if (alive < 1) { console.log('FAIL: la sesión no responde tras reconectar'); process.exit(1); }
  console.log('PASS: la sesión sigue viva tras reconectar');

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
