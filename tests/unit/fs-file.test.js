// Unit tests de lib/fs-file: lectura y escritura de texto dentro del jail.
//
// WIBE_CWD se fija ANTES del primer require de lib/config (mismo patron que
// tests/unit/pty-store.test.js): el jail se resuelve al cargar el modulo.
const os = require('os');
const path = require('path');
const fs = require('fs');

const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'wibe-fsfile-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wibe-outside-'));
process.env.WIBE_CWD = jail;
process.env.WIBE_EDIT_MAX = '4096';

const { test, after } = require('node:test');
const assert = require('node:assert');
const ff = require('../../lib/fs-file');

after(() => {
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

let n = 0;
function make(content, opts = {}) {
  const name = `f${++n}.txt`;
  const full = path.join(jail, name);
  fs.writeFileSync(full, content);
  if (opts.mode) fs.chmodSync(full, opts.mode);
  return { name, full };
}

async function read(p) { return ff.readTextFile(p); }
async function write(p, opts) { return ff.writeTextFile(p, opts); }

// === Jail ===

test('jail: una ruta relativa con .. no escapa', async () => {
  const r = await read('../../etc/passwd');
  assert.strictEqual(r.ok, false);
  assert.ok(r.code === 'denied' || r.code === 'not-found', 'code=' + r.code);
});

test('jail: un symlink plantado DENTRO del jail que apunta fuera se rechaza', async () => {
  const victim = path.join(outside, 'secreto.txt');
  fs.writeFileSync(victim, 'no me deberias leer');
  const link = path.join(jail, 'escape.txt');
  fs.symlinkSync(victim, link);
  const r = await read('escape.txt');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'denied');
  fs.unlinkSync(link);
});

test('jail: un directorio no es editable como archivo', async () => {
  fs.mkdirSync(path.join(jail, 'unadir'), { recursive: true });
  const r = await read('unadir');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'not-file');
});

// === Deteccion de binarios ===

test('binarios: un byte NUL marca el archivo como no editable', async () => {
  const { name } = make(Buffer.from([0x68, 0x69, 0x00, 0x21]));
  const r = await read(name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'binary');
  assert.strictEqual(r.meta.reason, 'nul');
});

test('binarios: UTF-8 invalido tambien se rechaza', async () => {
  const { name } = make(Buffer.from([0xC3, 0x28, 0xA0, 0xA1]));
  const r = await read(name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'binary');
  assert.strictEqual(r.meta.reason, 'utf8');
});

test('binarios: texto con acentos y emoji SI es editable (no hay falso positivo)', async () => {
  const { name } = make('acción — ñ — 🚀 — fin\n');
  const r = await read(name);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.data.content.includes('🚀'));
});

// === Tamano ===

test('tamano: por encima de EDIT_MAX se devuelve error, NUNCA contenido recortado', async () => {
  const { name } = make('x'.repeat(5000));
  const r = await read(name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too-large');
  assert.strictEqual(r.meta.max, 4096);
  assert.strictEqual(r.data, undefined);
});

// === Round-trip de EOL y BOM ===

test('round-trip CRLF: guardar sin cambios deja los bytes identicos', async () => {
  const original = 'uno\r\ndos\r\ntres\r\n';
  const { name, full } = make(original);
  const r = await read(name);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.eol, 'crlf');
  assert.strictEqual(r.data.content, 'uno\ndos\ntres\n', 'el cliente siempre recibe LF');

  const w = await write(name, { content: r.data.content, eol: r.data.eol, bom: r.data.bom, ifMatch: r.data.etag });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  assert.strictEqual(fs.readFileSync(full, 'utf8'), original, 'CRLF preservado byte a byte');
});

test('round-trip BOM: se oculta al cliente y se reinyecta al guardar', async () => {
  const original = '﻿con bom\n';
  const { name, full } = make(original);
  const r = await read(name);
  assert.strictEqual(r.data.bom, true);
  assert.strictEqual(r.data.content, 'con bom\n', 'el BOM no llega al editor');

  const w = await write(name, { content: r.data.content, eol: r.data.eol, bom: r.data.bom, ifMatch: r.data.etag });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(fs.readFileSync(full, 'utf8'), original);
});

// === Concurrencia ===

test('conflicto: un etag obsoleto no sobrescribe, y devuelve el etag actual', async () => {
  const { name, full } = make('version A\n');
  const r = await read(name);
  fs.writeFileSync(full, 'version B (otro editor)\n'); // cambio externo

  const w = await write(name, { content: 'version C\n', eol: 'lf', bom: false, ifMatch: r.data.etag });
  assert.strictEqual(w.ok, false);
  assert.strictEqual(w.code, 'conflict');
  assert.strictEqual(fs.readFileSync(full, 'utf8'), 'version B (otro editor)\n', 'el disco no se toco');

  // Y con el etag fresco que devuelve el conflicto, el guardado pasa.
  const retry = await write(name, { content: 'version C\n', eol: 'lf', bom: false, ifMatch: w.meta.etag });
  assert.strictEqual(retry.ok, true, JSON.stringify(retry));
  assert.strictEqual(fs.readFileSync(full, 'utf8'), 'version C\n');
});

test('conflicto: sin If-Match no se escribe nada', async () => {
  const { name, full } = make('intacto\n');
  const w = await write(name, { content: 'pisado\n', eol: 'lf', bom: false });
  assert.strictEqual(w.ok, false);
  assert.strictEqual(w.code, 'no-precondition');
  assert.strictEqual(fs.readFileSync(full, 'utf8'), 'intacto\n');
});

test('concurrencia: dos escrituras a la vez con el mismo etag, exactamente una gana', async () => {
  const { name, full } = make('base\n');
  const r = await read(name);
  const [a, b] = await Promise.all([
    write(name, { content: 'de A\n', eol: 'lf', bom: false, ifMatch: r.data.etag }),
    write(name, { content: 'de B\n', eol: 'lf', bom: false, ifMatch: r.data.etag }),
  ]);
  const wins = [a, b].filter((x) => x.ok).length;
  assert.strictEqual(wins, 1, `deberia ganar exactamente una: a=${a.ok} b=${b.ok}`);
  const conflict = [a, b].find((x) => !x.ok);
  assert.strictEqual(conflict.code, 'conflict');
  assert.ok(['de A\n', 'de B\n'].includes(fs.readFileSync(full, 'utf8')), 'no queda contenido mezclado');
});

// === Escritura atomica ===

test('escritura: rename NO sigue el symlink del destino (no se toca el objetivo)', async () => {
  const victimPath = path.join(outside, 'victima.txt');
  fs.writeFileSync(victimPath, 'contenido original de la victima');
  const linkName = 'enlace.txt';
  const linkFull = path.join(jail, linkName);
  fs.symlinkSync(victimPath, linkFull);

  const w = await write(linkName, { content: 'ATACADO', eol: 'lf', bom: false, ifMatch: 'sha256:loquesea' });
  assert.strictEqual(w.ok, false, 'un symlink no debe ser editable');
  assert.strictEqual(fs.readFileSync(victimPath, 'utf8'), 'contenido original de la victima');
  fs.unlinkSync(linkFull);
});

test('escritura: se preservan los permisos del archivo original', async () => {
  const { name, full } = make('permisos\n', { mode: 0o640 });
  const r = await read(name);
  const w = await write(name, { content: 'permisos v2\n', eol: 'lf', bom: false, ifMatch: r.data.etag });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(fs.statSync(full).mode & 0o777, 0o640);
});

test('escritura: no quedan temporales .wibe-*.tmp tras un guardado correcto', async () => {
  const { name } = make('limpio\n');
  const r = await read(name);
  await write(name, { content: 'limpio v2\n', eol: 'lf', bom: false, ifMatch: r.data.etag });
  const leftovers = fs.readdirSync(jail).filter((f) => f.startsWith('.wibe-'));
  assert.deepStrictEqual(leftovers, []);
});

test('escritura: un contenido por encima de EDIT_MAX no toca el destino', async () => {
  const { name, full } = make('pequeno\n');
  const r = await read(name);
  const w = await write(name, { content: 'y'.repeat(5000), eol: 'lf', bom: false, ifMatch: r.data.etag });
  assert.strictEqual(w.ok, false);
  assert.strictEqual(w.code, 'too-large');
  assert.strictEqual(fs.readFileSync(full, 'utf8'), 'pequeno\n');
});

// === Primitivas ===

test('etag: es el hash del contenido, no del mtime', async () => {
  const a = ff.computeEtag(Buffer.from('mismo'));
  const b = ff.computeEtag(Buffer.from('mismo'));
  const c = ff.computeEtag(Buffer.from('distinto'));
  assert.strictEqual(a, b, 'mismos bytes -> mismo etag, aunque cambie el mtime');
  assert.notStrictEqual(a, c);
  assert.match(a, /^sha256:[0-9a-f]{32}$/);
});

test('detectEol: mayoria de CRLF gana; sin saltos, LF por defecto', () => {
  assert.strictEqual(ff.detectEol('a\r\nb\r\n'), 'crlf');
  assert.strictEqual(ff.detectEol('a\nb\n'), 'lf');
  assert.strictEqual(ff.detectEol('a\r\nb\nc\nd\n'), 'lf', 'CRLF minoritario no cuenta');
  assert.strictEqual(ff.detectEol('sin saltos'), 'lf');
});
