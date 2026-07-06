// E2E: remember-me — login con "recordar token", reload y autoconexión.
const { chromium } = require('playwright');

const URL = process.env.WIBE_TEST_URL || 'http://localhost:4021/';
const TOKEN = process.env.WIBE_TEST_TOKEN || 'smoketest-token';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();

  await page.goto(URL);
  await page.fill('#token', TOKEN);
  await page.check('#remember-token');
  await page.click('#btn-connect');
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  console.log('OK: login con remember-me');

  // Reload: debe autoconectar sin tocar el formulario
  await page.reload();
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  console.log('PASS: autoconexión tras reload con token recordado');

  // Olvidar token via localStorage (misma vía que usa la paleta) y reload → login visible
  await page.evaluate(() => localStorage.removeItem('wibe-token'));
  await page.reload();
  await page.waitForSelector('#login', { state: 'visible', timeout: 10000 });
  const containerVisible = await page.isVisible('#terminal-container');
  if (containerVisible) { console.log('FAIL: conectó sin token guardado'); process.exit(1); }
  console.log('PASS: sin token guardado vuelve al login');

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
