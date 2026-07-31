// Unit tests de lib/claude-watch: deteccion del proceso `claude` dentro del
// arbol de un PTY + streaming en vivo de su transcript JSONL.
// Ejecutar: npm test (node --test)

// CLAUDE_HOME aislado en un tmpdir — DEBE fijarse antes del primer require de
// lib/config (patron identico al de tests/unit/pty-store.test.js): nunca tocar
// el ~/.claude real del usuario que ejecuta los tests.
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wibe-claude-test-'));
process.env.WIBE_CLAUDE_HOME = tmpHome;

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const claudeWatch = require('../../lib/claude-watch');

const ON_LINUX = process.platform === 'linux'; // /proc: los tests de deteccion real son Linux-only

after(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Lanza un proceso node cuyo comm sea "claude" (via process.title) en el cwd
// dado, y espera a que este listo (senal por stdout) antes de devolverlo.
function spawnFakeClaude(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      "process.title='claude';process.stdout.write('ready\\n');setInterval(()=>{},1000);"
    ], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

// === slugify ===

test('slugify: cualquier caracter no alfanumerico se convierte en guion', () => {
  assert.strictEqual(
    claudeWatch.slugify('/home/user/www/Mi Proyecto_2.0'),
    '-home-user-www-Mi-Proyecto-2-0'
  );
});

// === normalizeLine: normalizacion pura, sin I/O ===

test('normalizeLine: descarta bookkeeping puro sin contenido visible', () => {
  assert.deepStrictEqual(claudeWatch.normalizeLine({ type: 'queue-operation' }), []);
  assert.deepStrictEqual(claudeWatch.normalizeLine({ type: 'last-prompt' }), []);
  assert.deepStrictEqual(claudeWatch.normalizeLine(null), []);
});

test('normalizeLine: mensaje de usuario como string simple', () => {
  const out = claudeWatch.normalizeLine({ type: 'user', uuid: 'u1', timestamp: 't1', message: { content: 'hola' } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'user-text');
  assert.strictEqual(out[0].text, 'hola');
  assert.strictEqual(out[0].uuid, 'u1');
});

test('normalizeLine: turno de assistant con thinking + texto + tool_use en un solo mensaje', () => {
  const out = claudeWatch.normalizeLine({
    type: 'assistant', uuid: 'a1',
    message: { content: [
      { type: 'thinking', thinking: 'pensando...' },
      { type: 'text', text: 'voy a mirar' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'server.js' } },
    ] },
  });
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].kind, 'thinking');
  assert.strictEqual(out[1].kind, 'assistant-text');
  assert.strictEqual(out[2].kind, 'tool-use');
  assert.strictEqual(out[2].toolUseId, 'tu1');
  assert.strictEqual(out[2].name, 'Read');
});

test('normalizeLine: tool_result aplana bloques de texto a un solo string', () => {
  const out = claudeWatch.normalizeLine({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'linea1' }, { type: 'text', text: 'linea2' }] },
    ] },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'tool-result');
  assert.strictEqual(out[0].content, 'linea1\nlinea2');
  assert.strictEqual(out[0].isError, false);
});

test('normalizeLine: isSidechain se conserva (subagente), nunca se descarta', () => {
  const out = claudeWatch.normalizeLine({ type: 'user', isSidechain: true, message: { content: 'sub-agente' } });
  assert.strictEqual(out[0].sidechain, true);
});

test('normalizeLine: tipo desconocido se muestra como meta en vez de descartarse', () => {
  const out = claudeWatch.normalizeLine({ type: 'summary', foo: 'bar' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'meta');
  assert.strictEqual(out[0].eventType, 'summary');
});

// === Deteccion real via /proc (Linux) ===

test('resolveTranscript: localiza el .jsonl mas reciente y valida el cwd', { skip: !ON_LINUX && 'requiere /proc (Linux)' }, async () => {
  const projCwd = path.join(tmpHome, 'proj-resolve');
  const child = await spawnFakeClaude(projCwd);
  try {
    const projDir = path.join(tmpHome, 'projects', claudeWatch.slugify(projCwd));
    fs.mkdirSync(projDir, { recursive: true });
    const oldFile = path.join(projDir, 'old-session.jsonl');
    const newFile = path.join(projDir, 'new-session.jsonl');
    fs.writeFileSync(oldFile, JSON.stringify({ type: 'user', cwd: projCwd, message: { content: 'old' } }) + '\n');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(oldFile, past, past);
    fs.writeFileSync(newFile, JSON.stringify({ type: 'user', cwd: projCwd, message: { content: 'new' } }) + '\n');

    const found = claudeWatch.resolveTranscript(child.pid);
    assert.ok(found, 'deberia encontrar un transcript');
    assert.strictEqual(found.file, newFile);
    assert.strictEqual(found.sessionId, 'new-session');
  } finally {
    child.kill();
  }
});

test('findClaudePid: encuentra claude como DESCENDIENTE del pid raiz, no solo si es el propio raiz', { skip: !ON_LINUX && 'requiere /proc (Linux)' }, async () => {
  const projCwd = path.join(tmpHome, 'proj-descendant');
  fs.mkdirSync(projCwd, { recursive: true });
  const claudeScript = "process.title='claude';process.stdout.write('grandchild-ready\\n');setInterval(()=>{},1000);";
  const parentScript = `
    const cp = require('child_process');
    cp.spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(claudeScript)}], { stdio: ['ignore', 'inherit', 'ignore'] });
    setInterval(() => {}, 1000);
  `;
  // detached: proceso padre lider de su propio grupo, para poder matar
  // grupo+nieto de una vez al terminar (evita dejar procesos huerfanos)
  const parent = spawn(process.execPath, ['-e', parentScript], {
    cwd: projCwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
  });
  await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', resolve);
  });
  try {
    const found = claudeWatch.findClaudePid(parent.pid);
    assert.ok(found, 'deberia encontrar un pid');
    assert.notStrictEqual(found, parent.pid, 'debe ser un descendiente, no el propio root');
  } finally {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch (_) { try { parent.kill('SIGKILL'); } catch (_) {} }
  }
});

test('attach: sin ningun proceso claude en el arbol, se queda en estado searching', { skip: !ON_LINUX && 'requiere /proc (Linux)' }, async () => {
  const states = [];
  claudeWatch.attach('t-searching', 999999999, (event, payload) => {
    if (event === 'claude:state') states.push(payload);
  });
  await delay(50);
  assert.ok(states.some((s) => s.status === 'searching'));
  claudeWatch.detach('t-searching'); // cancela el retry pendiente, no debe dejar timers colgados
});

test('attach + tail incremental: replay inicial y una linea partida a mitad no produce eventos hasta completarse', { skip: !ON_LINUX && 'requiere /proc (Linux)' }, async () => {
  const projCwd = path.join(tmpHome, 'proj-tail');
  const child = await spawnFakeClaude(projCwd);
  const projDir = path.join(tmpHome, 'projects', claudeWatch.slugify(projCwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, 'sess-tail.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'old1', message: { content: 'mensaje viejo' } }) + '\n');

  const events = [];
  const states = [];
  const emit = (event, payload) => {
    if (event === 'claude:events') events.push(...payload.events);
    else states.push(payload);
  };

  try {
    claudeWatch.attach('t-tail', child.pid, emit);
    await delay(200);
    assert.ok(states.some((s) => s.status === 'attached'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].text, 'mensaje viejo');

    const line2 = JSON.stringify({ type: 'user', uuid: 'new1', message: { content: 'segundo mensaje' } });
    fs.appendFileSync(file, line2.slice(0, 12)); // fragmento SIN salto de linea final
    await delay(700);
    assert.strictEqual(events.length, 1, 'una linea partida no debe producir eventos todavia');

    fs.appendFileSync(file, line2.slice(12) + '\n'); // completa la linea
    await delay(700);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].text, 'segundo mensaje');
    assert.ok(events[1].i > events[0].i, 'el orden debe ser cronologico');

    const more = await new Promise((resolve) => claudeWatch.loadMore('t-tail', resolve));
    assert.deepStrictEqual(more, { events: [], hasMore: false });
  } finally {
    claudeWatch.detach('t-tail');
    child.kill();
  }
});

test('attach: transcript mayor que la ventana de replay marca hasMore, y loadMore trae un tramo cronologicamente anterior', { skip: !ON_LINUX && 'requiere /proc (Linux)' }, async () => {
  const projCwd = path.join(tmpHome, 'proj-big');
  const child = await spawnFakeClaude(projCwd);
  const projDir = path.join(tmpHome, 'projects', claudeWatch.slugify(projCwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, 'sess-big.jsonl');

  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(500) } }) + '\n';
  const firstLine = JSON.stringify({ type: 'user', uuid: 'oldest', message: { content: 'el mas viejo de todos' } }) + '\n';
  const lastLine = JSON.stringify({ type: 'user', uuid: 'newest', message: { content: 'el mas reciente' } }) + '\n';
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, firstLine);
  const fillerCount = Math.ceil((1.6 * 1024 * 1024) / filler.length); // > REPLAY_MAX_BYTES (1.5MB)
  for (let i = 0; i < fillerCount; i++) fs.writeSync(fd, filler);
  fs.writeSync(fd, lastLine);
  fs.closeSync(fd);

  const events = [];
  const emit = (event, payload) => { if (event === 'claude:events') events.push(...payload.events); };
  try {
    claudeWatch.attach('t-big', child.pid, emit);
    await delay(300);
    assert.ok(events.length > 0);
    assert.ok(!events.some((e) => e.uuid === 'oldest'), 'el mas viejo debe quedar fuera de la ventana inicial');
    assert.ok(events.some((e) => e.uuid === 'newest'), 'el mas reciente debe estar dentro de la ventana inicial');

    const more = await new Promise((resolve) => claudeWatch.loadMore('t-big', resolve));
    assert.ok(more.events.length > 0, 'deberia traer el tramo anterior');
    // Orden cronologico preservado: todo lo cargado hacia atras debe tener un
    // "i" MENOR que el minimo ya presente (regresion del bug de indices invertidos)
    const minLoaded = Math.min(...events.map((e) => e.i));
    for (const ev of more.events) assert.ok(ev.i < minLoaded);
  } finally {
    claudeWatch.detach('t-big');
    child.kill();
  }
});
