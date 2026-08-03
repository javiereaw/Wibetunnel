// E2E del explorador de carpetas y el editor de /claude, contra el servidor y
// el disco reales: navegar, hacer cd, abrir un fichero, editarlo, guardarlo y
// comprobar que el contenido esta en disco. Incluye el conflicto 412 y la
// creacion de una sesion en una carpeta elegida.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CWD = process.env.WIBE_TEST_CWD;
const URL_BASE = process.env.WIBE_TEST_URL || 'http://localhost:4021/';
const TOKEN = process.env.WIBE_TEST_TOKEN || 'smoketest-token';

function fail(msg) { console.log('FAIL: ' + msg); process.exit(1); }

(async () => {
  if (!CWD) fail('falta WIBE_TEST_CWD');

  // Escenario en disco: una subcarpeta con un .js editable y un binario.
  const sub = path.join(CWD, 'edit-e2e');
  fs.mkdirSync(sub, { recursive: true });
  const target = path.join(sub, 'nota.js');
  fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\n');
  const binary = path.join(sub, 'blob.bin');
  fs.writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });

  await page.goto(URL_BASE + 'claude');
  await page.fill('#token', TOKEN);
  await page.click('#btn-connect');
  await page.waitForSelector('#c-app', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1500);
  console.log('OK: login');

  // --- Explorador: navegar ---
  await page.click('#c-btn-files');
  await page.waitForSelector('#c-files .cf-row', { timeout: 5000 });
  console.log('OK: explorador abierto');

  const dirRow = page.locator('.cf-row--dir', { hasText: 'edit-e2e' }).first();
  if (!(await dirRow.count())) fail('no aparece la carpeta edit-e2e');
  await dirRow.locator('.cf-name').click();
  await page.waitForSelector('.cf-row:not(.cf-row--dir)', { timeout: 5000 });
  if (!(await page.locator('.cf-row', { hasText: 'nota.js' }).count())) fail('no aparece nota.js');
  console.log('OK: navegacion a subcarpeta');

  // --- Editor: abrir, editar, guardar ---
  await page.locator('.cf-row', { hasText: 'nota.js' }).first().locator('.cf-name').click();
  await page.waitForSelector('#c-editor', { state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('ce-area').disabled, null, { timeout: 8000 });

  const loaded = await page.inputValue('#ce-area');
  if (loaded !== 'const a = 1;\nconst b = 2;\n') fail('contenido cargado incorrecto: ' + JSON.stringify(loaded));
  const gutter = await page.innerText('#ce-gutter');
  if (!gutter.startsWith('1\n2\n3')) fail('numeros de linea incorrectos: ' + JSON.stringify(gutter));
  console.log('OK: fichero cargado con numeros de linea');

  if (!(await page.locator('#ce-save').isDisabled())) fail('Guardar deberia estar deshabilitado sin cambios');

  await page.click('#ce-area');
  await page.keyboard.press('End');
  await page.keyboard.type('const c = 3;\n');
  if (await page.locator('#ce-save').isDisabled()) fail('Guardar deberia habilitarse al editar');
  if (!(await page.locator('#ce-dirty').isVisible())) fail('falta el indicador de cambios sin guardar');

  await page.click('#ce-save');
  await page.waitForFunction(() => document.getElementById('ce-save').disabled, null, { timeout: 8000 });
  await page.waitForTimeout(400);

  const onDisk = fs.readFileSync(target, 'utf8');
  if (!onDisk.includes('const c = 3;')) fail('el cambio no llego al disco: ' + JSON.stringify(onDisk));
  console.log('OK: guardado verificado en disco');

  // --- Conflicto 412: alguien cambia el fichero por debajo ---
  fs.writeFileSync(target, 'MODIFICADO POR FUERA\n');
  await page.click('#ce-area');
  await page.keyboard.type('// mio\n');
  await page.click('#ce-save');
  await page.waitForSelector('#ce-banner', { state: 'visible', timeout: 8000 });
  const banner = await page.innerText('#ce-banner');
  if (!/cambió en disco/i.test(banner)) fail('no se detecto el conflicto: ' + banner);
  if (fs.readFileSync(target, 'utf8') !== 'MODIFICADO POR FUERA\n') fail('el conflicto NO debe haber escrito');
  console.log('OK: conflicto detectado sin pisar el disco');

  // Recargar descarta lo mio y trae la version del disco.
  await page.locator('#ce-banner button', { hasText: 'Recargar' }).click();
  await page.waitForFunction(() => document.getElementById('ce-area').value === 'MODIFICADO POR FUERA\n', null, { timeout: 8000 });
  console.log('OK: Recargar trae la version de disco');

  // Cerrar el editor devuelve al listado donde estabas (el editor apila sobre
  // el explorador a proposito), asi que no hay que reabrirlo.
  await page.click('#ce-close');
  await page.waitForSelector('#c-editor', { state: 'hidden', timeout: 5000 });
  if (!(await page.locator('#c-files').isVisible())) fail('al cerrar el editor deberia verse el listado de nuevo');
  console.log('OK: el editor vuelve al listado al cerrarse');

  // --- Un binario no es editable ---
  const binRow = page.locator('.cf-row', { hasText: 'blob.bin' });
  if (!(await binRow.count())) fail('no aparece blob.bin en el listado');
  await binRow.first().locator('.cf-name').click();
  await page.waitForSelector('#ce-banner', { state: 'visible', timeout: 8000 });
  const msg = await page.innerText('#ce-banner');
  if (!/no es un archivo de texto/i.test(msg)) fail('un binario deberia rechazarse: ' + msg);
  if (!(await page.locator('#ce-area').isDisabled())) fail('un binario no debe ser editable');
  console.log('OK: binario rechazado con mensaje claro');
  await page.locator('#ce-banner button', { hasText: 'Cerrar' }).click();
  await page.waitForSelector('#c-editor', { state: 'hidden', timeout: 5000 });

  // --- Crear una sesion en una carpeta elegida ---
  await page.locator('#c-files .cf-close').click();
  await page.waitForSelector('#c-files', { state: 'hidden', timeout: 5000 });
  const tabsBefore = await page.locator('.c-tab').count();
  await page.click('#c-tab-new');
  await page.waitForSelector('#c-files.cf-mode-pick', { timeout: 5000 });
  if (!(await page.locator('#cf-use').isVisible())) fail('falta el boton de usar carpeta en modo pick');
  const pickRow = page.locator('.cf-row--dir', { hasText: 'edit-e2e' }).first();
  await pickRow.locator('.cf-pill').click();
  await page.waitForFunction((n) => document.querySelectorAll('.c-tab').length > n, tabsBefore, { timeout: 8000 });
  await page.waitForTimeout(2500);

  // Comprobar el cwd real del shell escribiendo pwd en el terminal.
  await page.click('#c-btn-mode');
  await page.waitForTimeout(800);
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const termText = await page.innerText('#c-term-view');
  if (!termText.includes('edit-e2e')) fail('la sesion no arranco en la carpeta elegida:\n' + termText.slice(-500));
  console.log('OK: sesion nueva arrancada en la carpeta elegida');

  if (errors.length) fail('errores de JS: ' + errors.join(' | '));
  await browser.close();
  console.log('PASS: explorador y editor de /claude');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
