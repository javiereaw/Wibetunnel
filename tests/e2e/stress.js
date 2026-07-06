// Stress test Fase 2: backpressure (pause/resume del PTY con cliente congelado por PID)
// y replay de salida generada durante el periodo huérfano. Contra localhost:4021.
// Lee el buffer de xterm via el singleton ESM (independiente del renderer WebGL/DOM).
const { chromium } = require('playwright');
const { execSync } = require('child_process');

function count(text, needle) { return text.split(needle).length - 1; }

// Todos los procesos del navegador de test (patrón bracket: no se auto-coincide)
function browserPids() {
  try {
    return execSync("pgrep -f 'chromium_headless_she[l]l' || true")
      .toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (_) { return []; }
}

async function readTermBuffer(page) {
  return page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const s = state.sessions.get(state.activeId);
    if (!s) return '';
    const buf = s.term.buffer.active;
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) out += line.translateToString(true) + '\n';
    }
    return out;
  });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();

  await page.goto((process.env.WIBE_TEST_URL || 'http://localhost:4021/'));
  await page.fill('#token', (process.env.WIBE_TEST_TOKEN || 'smoketest-token'));
  await page.click('#btn-connect');
  await page.waitForSelector('#terminal-container', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(2000);
  console.log('OK: sesión creada');

  const termInput = page.locator('.xterm-helper-textarea').first();

  // --- Test A: backpressure con cliente congelado ---
  await termInput.focus();
  await page.keyboard.type('timeout 12 yes BACKPRESSURE_FILLER_0123456789ABCDEF');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const tree = browserPids();
  for (const p of tree) { try { process.kill(p, 'SIGSTOP'); } catch (_) {} }
  console.log(`OK: navegador congelado (${tree.length} procesos), esperando pause del PTY...`);
  await new Promise(r => setTimeout(r, 6000));
  for (const p of tree) { try { process.kill(p, 'SIGCONT'); } catch (_) {} }
  console.log('OK: navegador reanudado');
  await page.waitForTimeout(10000); // que el yes termine y el cliente drene

  await termInput.focus();
  await page.keyboard.type('echo STILL_ALIVE_AFTER_BP');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const bufA = await readTermBuffer(page);
  if (count(bufA, 'STILL_ALIVE_AFTER_BP') < 1) { console.log('FAIL: sesión no responde tras backpressure'); process.exit(1); }
  console.log('PASS: sesión viva tras ciclo de backpressure');

  // --- Test B: salida generada mientras huérfana se replaya al reconectar ---
  await termInput.focus();
  await page.keyboard.type('clear && (sleep 3; echo ORPHAN_MARKER_ABC) &');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  await ctx.setOffline(true); // bloquea la re-conexión
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    state.socket.io.engine.close();
  });
  await page.waitForSelector('#status', { state: 'visible', timeout: 10000 });
  console.log('OK: desconectado, esperando output huérfano...');
  await page.waitForTimeout(5000); // marker se imprime en modo huérfano
  await ctx.setOffline(false);
  await page.waitForSelector('#status', { state: 'hidden', timeout: 20000 });
  await page.waitForTimeout(3000);

  const bufB = await readTermBuffer(page);
  const orphanCount = count(bufB, 'ORPHAN_MARKER_ABC');
  console.log(`Ocurrencias del marker huérfano tras replay: ${orphanCount}`);
  if (orphanCount < 1) { console.log('FAIL: la salida huérfana no se replayó'); process.exit(1); }
  console.log('PASS: salida huérfana replayada correctamente');

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
