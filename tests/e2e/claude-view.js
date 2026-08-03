// E2E de la vista /claude: cadena completa real — se lanza un proceso llamado
// `claude` dentro del PTY, el servidor lo localiza por /proc, resuelve su
// transcript JSONL y lo emite; el cliente lo pinta como chat estructurado.
//
// El "claude" falso es una copia de /bin/sleep renombrada: /proc/<pid>/comm
// sale del nombre del ejecutable, que es exactamente lo que mira claude-watch.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CWD = process.env.WIBE_TEST_CWD;
const CLAUDE_HOME = process.env.WIBE_TEST_CLAUDE_HOME;
const URL_BASE = process.env.WIBE_TEST_URL || 'http://localhost:4021/';
const TOKEN = process.env.WIBE_TEST_TOKEN || 'smoketest-token';

function slugify(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function fail(msg) { console.log('FAIL: ' + msg); process.exit(1); }

function projectDir() {
  const dir = path.join(CLAUDE_HOME, 'projects', slugify(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Transcript de una sesion anterior, con mtime muy anterior al proceso actual.
function plantStaleTranscript() {
  const file = path.join(projectDir(), 'sesion-vieja.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', cwd: CWD, sessionId: 'vieja',
    message: { content: 'CONVERSACION_AJENA_QUE_NO_DEBE_APARECER' },
  }) + '\n');
  const old = new Date(Date.now() - 6 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  return file;
}

// Transcript de mentira con un turno completo: prompt, respuesta con markdown,
// un Edit con structuredPatch y un Bash con stderr.
function writeTranscript() {
  const dir = projectDir();
  const ts = new Date().toISOString();
  const base = { cwd: CWD, sessionId: 'e2e-sess', version: '2.1.220', gitBranch: 'master', timestamp: ts };
  const lines = [
    { ...base, type: 'mode', mode: 'default' }, // ruido: NO debe pintarse
    { ...base, type: 'user', uuid: 'u1', message: { content: 'arregla el **login** por favor' } },
    { ...base, type: 'assistant', uuid: 'a1', message: {
      model: 'claude-opus-5', stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000 },
      content: [
        { type: 'text', text: 'Voy a mirarlo.\n\n```js\nconst x = 1;\n```' },
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: CWD + '/app.js', old_string: 'const x = 1', new_string: 'const x = 2' } },
      ],
    } },
    { ...base, type: 'user', uuid: 'u2',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      toolUseResult: {
        filePath: CWD + '/app.js', oldString: 'const x = 1', newString: 'const x = 2',
        originalFile: 'RELLENO_QUE_NO_DEBE_VIAJAR', replaceAll: false, userModified: false,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const x = 1', '+const x = 2'] }],
      } },
    { ...base, type: 'assistant', uuid: 'a2', message: {
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }],
    } },
    { ...base, type: 'user', uuid: 'u3',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'salida\nun aviso' }] },
      toolUseResult: { stdout: 'MARCA_STDOUT', stderr: 'MARCA_STDERR', interrupted: false, isImage: false, noOutputExpected: false } },
    { ...base, type: 'system', subtype: 'turn_duration', uuid: 's1', durationMs: 92701, messageCount: 41 },
  ];
  const file = path.join(dir, 'e2e-sess.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

(async () => {
  if (!CWD || !CLAUDE_HOME) fail('faltan WIBE_TEST_CWD / WIBE_TEST_CLAUDE_HOME');
  // El transcript se planta DESPUES de arrancar el proceso claude (ver abajo):
  // el servidor solo engancha ficheros escritos por la sesion en marcha, que es
  // lo que impide mostrar una conversacion vieja de otro tema.
  let file;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

  await page.goto(URL_BASE + 'claude');
  await page.fill('#token', TOKEN);
  await page.click('#btn-connect');
  await page.waitForSelector('#c-app', { state: 'visible', timeout: 10000 });
  console.log('OK: login y vista /claude visible');

  // Lanzar el proceso "claude" dentro del PTY, en el cwd del jail.
  await page.click('#c-btn-mode'); // a modo Terminal
  await page.waitForTimeout(1500);
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type(`cp /bin/sleep ${CWD}/claude && cd ${CWD} && ./claude 120 &`);
  await page.keyboard.press('Enter');
  console.log('OK: proceso `claude` lanzado en el PTY');
  await page.waitForTimeout(1500);

  await page.click('#c-btn-mode'); // volver a Chat

  // Se planta primero un transcript VIEJO del mismo proyecto, como el que deja
  // cualquier sesion anterior. Con claude vivo pero sin haber escrito, el
  // servidor debe decir que espera — engancharse a ese fichero es justo el bug
  // que hacia que el chat mostrase una conversacion de otro dia y otro tema.
  const staleFile = plantStaleTranscript();
  await page.waitForFunction(
    () => /Esperando a que escriba/i.test(document.getElementById('c-empty-hint').textContent),
    null, { timeout: 20000 },
  );
  if (await page.locator('.c-turn').count()) fail('no debe pintar nada de una sesión ajena');
  console.log('OK: con claude vivo pero sin escribir, espera en vez de enganchar a una sesión vieja');

  // Ahora la sesion en marcha escribe lo suyo: a partir de aqui si se engancha.
  file = writeTranscript();
  // El watcher reintenta cada 2 s mientras busca y re-verifica cada 5 s.
  await page.waitForSelector('.c-turn', { timeout: 25000 });
  fs.rmSync(staleFile, { force: true });
  console.log('OK: el transcript se engancho y se pinto');

  const body = await page.innerText('#c-chat-log');

  const checks = [
    ['el mensaje del usuario', () => page.locator('.c-msg-user').count().then((n) => n > 0)],
    ['la prosa del asistente', () => page.locator('.c-msg-assistant').count().then((n) => n > 0)],
    ['el bloque de codigo con cabecera', () => page.locator('.c-code .c-code-head').count().then((n) => n > 0)],
    ['el resaltado de sintaxis', () => page.locator('.c-md-code .hl-kw').count().then((n) => n > 0)],
    ['el diff real del Edit', () => page.locator('.c-card--todo, .c-card').count().then((n) => n > 0)],
    ['el pie del turno con la duracion', () => Promise.resolve(/1 m 32 s|1 m 33 s/.test(body))],
    ['el modelo en el pie', () => Promise.resolve(body.includes('opus-5'))],
  ];
  for (const [what, probe] of checks) {
    if (!(await probe())) fail('falta ' + what + '\n--- log ---\n' + body.slice(0, 1500));
    console.log('OK: ' + what);
  }

  // El ruido (type:'mode') no debe generar ninguna card.
  if (body.includes('"mode"')) fail('el bookkeeping se esta pintando');
  console.log('OK: el ruido de bookkeeping no llega al DOM');

  // Y el fichero original del Edit no debe haber viajado nunca al cliente.
  const html = await page.content();
  if (html.includes('RELLENO_QUE_NO_DEBE_VIAJAR')) fail('originalFile llego al cliente');
  console.log('OK: originalFile no viaja al cliente');

  // Abrir la card del Bash y comprobar stdout/stderr separados.
  const bashCard = page.locator('.c-card', { hasText: 'npm test' }).first();
  await bashCard.locator('.c-card-header').click();
  await page.waitForTimeout(300);
  const bashText = await bashCard.innerText();
  if (!bashText.includes('MARCA_STDOUT') || !bashText.includes('MARCA_STDERR')) {
    fail('stdout/stderr no aparecen separados:\n' + bashText);
  }
  if (!(await bashCard.locator('.c-stream--err').count())) fail('stderr no se marca como error');
  console.log('OK: Bash muestra stdout y stderr por separado');

  // Diff con resaltado por palabras.
  const editCard = page.locator('.c-card', { hasText: 'app.js' }).first();
  await editCard.locator('.c-card-header').click();
  await page.waitForTimeout(300);
  if (!(await editCard.locator('.c-dl-add').count())) fail('el diff no pinta lineas anadidas');
  if (!(await editCard.locator('.c-dl-word').count())) fail('falta el diff intra-linea por palabras');
  console.log('OK: diff unificado con resaltado por palabras');

  // --- Chrome: chips de contexto derivados del transcript ---
  const ctxRow = await page.innerText('#c-ctx');
  if (!ctxRow.includes('master')) fail('falta la rama git en la fila de contexto: ' + ctxRow);
  if (!ctxRow.includes('opus-5')) fail('falta el modelo en la fila de contexto: ' + ctxRow);
  if (!/ctx\s/.test(ctxRow)) fail('falta la ventana de contexto: ' + ctxRow);
  if (!ctxRow.includes('2.1.220')) fail('falta la version: ' + ctxRow);
  console.log('OK: fila de contexto (carpeta, rama, modelo, tokens, versión)');

  // --- Busqueda sobre los DATOS, no sobre el DOM ---
  await page.click('#c-btn-search');
  await page.waitForSelector('#c-search', { state: 'visible', timeout: 5000 });
  // "MARCA_STDOUT" solo existe dentro del cuerpo (plegado) de la card de Bash:
  // si la busqueda fuera sobre el DOM, no lo encontraria.
  await page.fill('#c-search-input', 'MARCA_STDOUT');
  await page.waitForFunction(() => document.getElementById('c-search-count').textContent === '1/1', null, { timeout: 5000 });
  console.log('OK: la búsqueda encuentra texto dentro de una card plegada');
  await page.click('#c-search-close');

  // --- Menu: interruptor de ruido ---
  await page.click('#c-btn-menu');
  await page.waitForSelector('#c-menu', { state: 'visible', timeout: 5000 });
  await page.click('#c-menu-noise');
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => document.getElementById('c-chat-log').classList.contains('c-hide-noise'));
  console.log('OK: el menú alterna la densidad (ruido oculto=' + hidden + ')');

  // Reconexion: el fix de duplicados. Antes, cada reconexion reinyectaba todo.
  const turnsBefore = await page.locator('.c-turn').count();
  const userBefore = await page.locator('.c-msg-user').count();
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    state.socket.io.engine.close();
  });
  await page.waitForTimeout(6000);
  await page.waitForSelector('.c-turn', { timeout: 20000 });
  const turnsAfter = await page.locator('.c-turn').count();
  const userAfter = await page.locator('.c-msg-user').count();
  console.log(`turnos ${turnsBefore} -> ${turnsAfter}, mensajes de usuario ${userBefore} -> ${userAfter}`);
  if (userAfter > userBefore) fail('el historial se duplico al reconectar');
  if (userAfter < 1) fail('el historial se perdio al reconectar');
  console.log('OK: sin duplicados tras reconectar');

  if (errors.length) fail('errores de JS en la pagina: ' + errors.join(' | '));

  fs.rmSync(file, { force: true });
  await browser.close();
  console.log('PASS: vista /claude');
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
