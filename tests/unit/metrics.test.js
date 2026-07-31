// Unit tests del registro de metricas (lib/metrics)
// info: event() emite via log.info y este test captura console.log
process.env.WIBE_LOG_LEVEL = 'info';

const { test } = require('node:test');
const assert = require('node:assert');
const metrics = require('../../lib/metrics');

test('inc: incrementa contadores conocidos e ignora desconocidos', () => {
  const before = metrics.snapshot().ptySpawns;
  metrics.inc('ptySpawns');
  metrics.inc('ptySpawns', 2);
  metrics.inc('noExiste');
  metrics.inc('bytesOut', NaN); // no debe corromper el contador
  const after = metrics.snapshot();
  assert.strictEqual(after.ptySpawns, before + 3);
  assert.strictEqual(after.noExiste, undefined);
  assert.ok(Number.isFinite(after.bytesOut));
});

test('err: agrega por tag', () => {
  metrics.err('handlerX');
  metrics.err('handlerX');
  metrics.err('handlerY');
  const { errors } = metrics.snapshot();
  assert.strictEqual(errors.handlerX, 2);
  assert.strictEqual(errors.handlerY, 1);
});

test('snapshot: incluye startedAt ISO y es una copia (no mutable desde fuera)', () => {
  const snap = metrics.snapshot();
  assert.ok(!Number.isNaN(Date.parse(snap.startedAt)), 'startedAt parseable');
  snap.ptySpawns = 99999;
  snap.errors.inyectado = 1;
  const snap2 = metrics.snapshot();
  assert.notStrictEqual(snap2.ptySpawns, 99999);
  assert.strictEqual(snap2.errors.inyectado, undefined);
});

test('event: produce una linea [EVT] con JSON valido de una sola linea', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    metrics.event('health', { rssMb: 68, ptys: 2 });
  } finally {
    console.log = orig;
  }
  assert.strictEqual(lines.length, 1);
  const m = lines[0].match(/\[EVT\] (.*)$/);
  assert.ok(m, 'lleva el prefijo [EVT]');
  const parsed = JSON.parse(m[1]);
  assert.strictEqual(parsed.evt, 'health');
  assert.strictEqual(parsed.rssMb, 68);
  assert.ok(!m[1].includes('\n'), 'una sola linea (JSONL)');
});

test('event: un payload no serializable no lanza', () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => metrics.event('raro', circular));
});
