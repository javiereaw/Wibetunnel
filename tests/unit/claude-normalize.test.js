// Unit tests de lib/claude-normalize: la capa pura que convierte una linea del
// JSONL de Claude Code en eventos ligeros para el cliente.
//
// Las formas que se afirman aqui estan tomadas de transcripts reales
// (~/.claude/projects). Los casos negativos son los importantes: lo que NO debe
// salir por el socket (base64, ficheros enteros duplicados, bookkeeping).
// Ejecutar: npm test (node --test)

const { test } = require('node:test');
const assert = require('node:assert');
const nz = require('../../lib/claude-normalize');

function firstOfKind(events, kind) { return events.find((e) => e.kind === kind); }
function json(v) { return JSON.stringify(v); }

// === Descartes de ruido ===

test('normalizeLine: el bookkeeping sin contenido visible se descarta entero', () => {
  for (const type of ['queue-operation', 'last-prompt', 'mode', 'permission-mode',
    'file-history-snapshot', 'file-history-delta', 'bridge-session']) {
    assert.deepStrictEqual(nz.normalizeLine({ type }), [], `${type} deberia descartarse`);
  }
  assert.deepStrictEqual(nz.normalizeLine(null), []);
});

test('normalizeLine: un task_reminder vacio se descarta, uno con items no', () => {
  assert.deepStrictEqual(
    nz.normalizeLine({ type: 'attachment', attachment: { type: 'task_reminder', content: [], itemCount: 0 } }),
    []
  );
  const out = nz.normalizeLine({ type: 'attachment', attachment: { type: 'task_reminder', content: ['x'], itemCount: 1 } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].attachment.at, 'task_reminder');
});

// === Imagenes: el peor caso de payload ===

test('blockToEvents: un bloque image nunca deja escapar el base64', () => {
  const data = 'A'.repeat(200000);
  const out = nz.normalizeLine({
    type: 'user',
    message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'image');
  assert.strictEqual(out[0].mediaType, 'image/png');
  assert.ok(out[0].bytes > 100000, 'deberia reportar el tamano');
  assert.ok(!json(out).includes('AAAAAAAAAA'), 'el base64 no debe aparecer en el evento');
});

test('flattenResultContent: los bloques no textuales dejan de ser "[object Object]"', () => {
  const out = nz.normalizeLine({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'hola' },
      { type: 'tool_reference', tool_name: 'WebFetch' },
      { type: 'image', source: { type: 'base64', data: 'ZZZZ' } },
    ] }] },
  });
  assert.strictEqual(out[0].content, 'hola\n[herramienta: WebFetch]\n[imagen]');
  assert.ok(!out[0].content.includes('[object Object]'));
});

// === summarizeToolResult: despacho por forma ===

test('summarizeToolResult: Bash separa stdout y stderr y conserva los flags', () => {
  const r = nz.summarizeToolResult({
    stdout: 'salida', stderr: 'aviso', interrupted: false, isImage: false,
    noOutputExpected: false, backgroundTaskId: 'bg1', gitOperation: 'commit',
  });
  assert.strictEqual(r.kind, 'bash');
  assert.strictEqual(r.stdout, 'salida');
  assert.strictEqual(r.stderr, 'aviso');
  assert.strictEqual(r.backgroundTaskId, 'bg1');
  assert.strictEqual(r.gitOperation, 'commit');
});

test('normalizeLine: con resultado de Bash se descarta el content textual (lo duplica al 92%)', () => {
  const out = nz.normalizeLine({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'salida\naviso' }] },
    toolUseResult: { stdout: 'salida', stderr: 'aviso', interrupted: false },
  });
  const ev = firstOfKind(out, 'tool-result');
  assert.strictEqual(ev.content, null, 'el textual sobra cuando hay stdout/stderr estructurados');
  assert.strictEqual(ev.result.kind, 'bash');
});

test('summarizeToolResult: Edit conserva el patch y tira el fichero original entero', () => {
  const r = nz.summarizeToolResult({
    filePath: '/tmp/a.js',
    oldString: 'const x = 1',
    newString: 'const x = 2',
    originalFile: 'X'.repeat(50000),
    replaceAll: false, userModified: false,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const x = 1', '+const x = 2'] }],
  });
  assert.strictEqual(r.kind, 'edit');
  assert.strictEqual(r.filePath, '/tmp/a.js');
  assert.strictEqual(r.patch.length, 1);
  assert.strictEqual(r.originalFile, undefined);
  assert.strictEqual(r.oldString, undefined);
  assert.ok(!json(r).includes('XXXXXXXXXX'), 'originalFile no debe viajar');
});

test('summarizeToolResult: Write cuenta lineas pero no reenvia el contenido nuevo', () => {
  const r = nz.summarizeToolResult({
    filePath: '/tmp/n.js', type: 'create', content: 'a\nb\nc', userModified: false,
    originalFile: '', structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }],
  });
  assert.strictEqual(r.kind, 'write');
  assert.strictEqual(r.lines, 3);
  assert.strictEqual(r.content, undefined);
});

test('summarizeToolResult: Read manda metadatos, nunca file.content (lo duplica el textual)', () => {
  const r = nz.summarizeToolResult({
    type: 'text',
    file: { filePath: '/tmp/big.js', content: 'Y'.repeat(80000), numLines: 369, startLine: 1, totalLines: 765 },
  });
  assert.strictEqual(r.kind, 'read');
  assert.strictEqual(r.totalLines, 765);
  assert.strictEqual(r.numLines, 369);
  assert.ok(!json(r).includes('YYYYYYYYYY'), 'file.content no debe viajar');
});

test('summarizeToolResult: TaskCreate y TaskUpdate se distinguen sin conocer el nombre de la tool', () => {
  const create = nz.summarizeToolResult({ task: { id: '1', subject: 'Login' } });
  assert.strictEqual(create.kind, 'task');
  assert.strictEqual(create.task.subject, 'Login');

  const update = nz.summarizeToolResult({
    success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' },
  });
  assert.strictEqual(update.kind, 'task-update');
  assert.strictEqual(update.statusChange.to, 'completed');
});

test('summarizeToolResult: un subagente trae sus estadisticas pero no su prompt', () => {
  const r = nz.summarizeToolResult({
    agentId: 'a1', agentType: 'Explore', status: 'completed', resolvedModel: 'claude-opus-5',
    prompt: 'P'.repeat(20000), content: 'informe', toolStats: { Read: 12 },
    totalTokens: 4210, totalDurationMs: 93000, totalToolUseCount: 17, usage: {},
  });
  assert.strictEqual(r.kind, 'agent');
  assert.strictEqual(r.totalTokens, 4210);
  assert.deepStrictEqual(r.toolStats, { Read: 12 });
  assert.strictEqual(r.prompt, undefined);
  assert.ok(!json(r).includes('PPPPPPPPPP'));
});

test('summarizeToolResult: WebFetch, WebSearch y ToolSearch no se confunden entre si', () => {
  assert.strictEqual(nz.summarizeToolResult({ url: 'https://x.dev', code: 200, bytes: 12, durationMs: 4, result: 'ok' }).kind, 'webfetch');
  assert.strictEqual(nz.summarizeToolResult({ query: 'q', results: [], searchCount: 1, durationSeconds: 2 }).kind, 'websearch');
  assert.strictEqual(nz.summarizeToolResult({ query: 'q', matches: ['A'], total_deferred_tools: 30 }).kind, 'toolsearch');
});

test('summarizeToolResult: un resultado string se deja al content textual', () => {
  assert.strictEqual(nz.summarizeToolResult('texto plano'), null);
  assert.strictEqual(nz.summarizeToolResult(undefined), null);
});

test('summarizeToolResult: una forma desconocida cae en json capado, y una gigante en too-big', () => {
  const unknown = nz.summarizeToolResult({ cosaRara: 1, otra: 'dos' });
  assert.strictEqual(unknown.kind, 'json');
  assert.deepStrictEqual(unknown.value, { cosaRara: 1, otra: 'dos' });

  const huge = nz.summarizeToolResult({ stdout: 'S'.repeat(300000), stderr: 'E'.repeat(300000) });
  assert.strictEqual(huge.kind, 'too-big');
  assert.ok(huge.bytes > 64 * 1024);
});

// === Metadatos del turno ===

test('pickUsage: 5 numeros, nunca iterations[] (que crece sin limite)', () => {
  const u = nz.pickUsage({
    input_tokens: 2, output_tokens: 3316, cache_read_input_tokens: 36868,
    cache_creation_input_tokens: 80030, service_tier: 'standard',
    iterations: [{ input_tokens: 2 }, { input_tokens: 2 }],
  });
  assert.deepStrictEqual(u, { in: 2, out: 3316, cacheRead: 36868, cacheCreate: 80030, tier: 'standard' });
});

test('normalizeLine: modelo, stop_reason y usage van pegados al ULTIMO evento del turno', () => {
  const out = nz.normalizeLine({
    type: 'assistant',
    message: {
      model: 'claude-opus-5', stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [
        { type: 'text', text: 'voy a mirar' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.js' } },
      ],
    },
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].model, undefined, 'solo el ultimo lleva los metadatos');
  assert.strictEqual(out[1].model, 'claude-opus-5');
  assert.strictEqual(out[1].stopReason, 'tool_use');
  assert.strictEqual(out[1].usage.out, 2);
});

test('normalizeLine: system/turn_duration sigue siendo meta pero ya expone sus campos', () => {
  const out = nz.normalizeLine({ type: 'system', subtype: 'turn_duration', durationMs: 92701, messageCount: 41 });
  assert.strictEqual(out[0].kind, 'meta');
  assert.strictEqual(out[0].eventType, 'system');
  assert.strictEqual(out[0].subtype, 'turn_duration');
  assert.strictEqual(out[0].durationMs, 92701);
  assert.strictEqual(out[0].messageCount, 41);
});

test('normalizeLine: compact_boundary trae los tokens de antes y despues', () => {
  const out = nz.normalizeLine({
    type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 811969, postTokens: 8901, durationMs: 158108 },
  });
  assert.strictEqual(out[0].compact.preTokens, 811969);
  assert.strictEqual(out[0].compact.postTokens, 8901);
});

test('normalizeLine: un bloque fallback dice a que modelo se cambio, sin volcar el bloque', () => {
  const out = nz.normalizeLine({
    type: 'assistant',
    message: { content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } }] },
  });
  assert.strictEqual(out[0].eventType, 'fallback');
  assert.deepStrictEqual(out[0].raw, { from: 'claude-fable-5', to: 'claude-opus-4-8' });
});

test('normalizeLine: ai-title se convierte en contexto de cabecera, no en una card', () => {
  const out = nz.normalizeLine({ type: 'ai-title', aiTitle: 'Arreglar el login' });
  assert.strictEqual(out[0].kind, 'session-info');
  assert.strictEqual(out[0].title, 'Arreglar el login');
});

// === parseLines: diferencial de contexto ===

test('parseLines: cwd/gitBranch/version se emiten una vez y solo al cambiar', () => {
  const ctx = nz.createParseContext();
  const line = (msg, extra) => JSON.stringify({
    type: 'user', message: { content: msg }, cwd: '/w', gitBranch: 'master', version: '2.1.220', ...extra,
  });
  const events = nz.parseLines([line('uno'), line('dos'), line('tres', { gitBranch: 'fix/x' })], ctx);

  const infos = events.filter((e) => e.kind === 'session-info');
  assert.strictEqual(infos.length, 2, 'una al principio y otra al cambiar de rama');
  assert.strictEqual(infos[0].cwd, '/w');
  assert.strictEqual(infos[1].gitBranch, 'fix/x');
  assert.strictEqual(infos[1].cwd, '/w', 'el contexto se acumula, no se pierde');

  const texts = events.filter((e) => e.kind === 'user-text');
  assert.strictEqual(texts.length, 3);
  assert.strictEqual(texts[0].cwd, undefined, 'los eventos normales no cargan el contexto');
});

test('parseLines: una linea descartada no consume el diferencial de contexto', () => {
  const ctx = nz.createParseContext();
  const events = nz.parseLines([
    JSON.stringify({ type: 'mode', cwd: '/otro' }),
    JSON.stringify({ type: 'user', message: { content: 'hola' }, cwd: '/w' }),
  ], ctx);
  const infos = events.filter((e) => e.kind === 'session-info');
  assert.strictEqual(infos.length, 1);
  assert.strictEqual(infos[0].cwd, '/w');
});

test('parseLines: una linea corrupta se ignora sin romper las demas', () => {
  const events = nz.parseLines([
    '{roto',
    JSON.stringify({ type: 'user', message: { content: 'sigo aqui' } }),
  ], nz.createParseContext());
  assert.strictEqual(events.filter((e) => e.kind === 'user-text').length, 1);
});
