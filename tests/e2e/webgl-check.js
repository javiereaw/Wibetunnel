// Check del invariante Fase 2: como mucho 1 WebglAddon, y solo en la pestaña activa.
const { chromium } = require('playwright');

async function webglState(page) {
  return page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const out = [];
    state.sessions.forEach((s, id) => out.push({ id, webgl: !!s.webglAddon, active: state.activeId === id }));
    return out;
  });
}

function assertInvariant(list, label) {
  const withGl = list.filter(s => s.webgl);
  if (withGl.length > 1) { console.log(`FAIL ${label}: ${withGl.length} contextos WebGL`); process.exit(1); }
  if (withGl.length === 1 && !withGl[0].active) { console.log(`FAIL ${label}: WebGL en tab inactiva`); process.exit(1); }
  console.log(`PASS ${label}: ${withGl.length} contexto(s) WebGL, en tab activa=${withGl.length ? withGl[0].active : 'n/a'} — ${JSON.stringify(list)}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await page.goto((process.env.WIBE_TEST_URL || 'http://localhost:4021/'));
  await page.fill('#token', (process.env.WIBE_TEST_TOKEN || 'smoketest-token'));
  await page.click('#btn-connect');
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1500);

  assertInvariant(await webglState(page), 'con 1 tab');

  await page.click('#tab-new');
  await page.waitForTimeout(1500);
  assertInvariant(await webglState(page), 'con 2 tabs (activa la 2ª)');

  // Volver a la primera tab
  await page.click('.tab[data-id="ses-1"]');
  await page.waitForTimeout(1000);
  const list = await webglState(page);
  assertInvariant(list, 'tras volver a la 1ª');
  const first = list.find(s => s.id === 'ses-1');
  if (!first.active) { console.log('FAIL: ses-1 no está activa tras click'); process.exit(1); }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
