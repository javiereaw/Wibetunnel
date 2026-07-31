// Unit tests del ciclo de vida de sesiones (lib/pty-store) con PTY e io falsos.
// Ejecutar: npm test (node --test)

// Config de test: DEBE fijarse antes del primer require de lib/config
process.env.WIBE_TOKEN = 'test-token';
process.env.WIBE_BUFFER_SIZE = '100';
process.env.WIBE_MAX_PTYS = '3';
process.env.WIBE_MAX_SESSIONS = '10';
process.env.WIBE_RECONNECT_GRACE = '5';
process.env.WIBE_BP_HIGH = '50';
process.env.WIBE_BP_LOW = '10';
process.env.WIBE_LOG_LEVEL = 'error';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const store = require('../../lib/pty-store');

// === Fakes ===

const socketsMap = new Map();
const fakeIo = { sockets: { sockets: socketsMap } };
store.init(fakeIo);

function fakeSocket(id, connected = true) {
  const s = {
    id,
    connected,
    emitted: [],
    emit(ev, data) { this.emitted.push([ev, data]); },
    conn: { writeBuffer: [] },
  };
  socketsMap.set(id, s);
  store.registerSocket(id);
  return s;
}

let spawned = [];
function fakeSpawn() {
  const p = {
    pid: 1000 + spawned.length,
    killed: false,
    pauseCalls: 0,
    resumeCalls: 0,
    _dataCb: null,
    _exitCb: null,
    onData(cb) { this._dataCb = cb; },
    onExit(cb) { this._exitCb = cb; },
    killThrows: false,
    writeThrows: false,
    write() { if (this.writeThrows) throw new Error('EIO: i/o error'); },
    resize() {},
    kill() { if (this.killThrows) throw new Error('ESRCH: no such process'); this.killed = true; },
    pause() { this.pauseCalls++; },
    resume() { this.resumeCalls++; },
    emitData(d) { if (this._dataCb) this._dataCb(d); },
    emitExit() { if (this._exitCb) this._exitCb(); },
  };
  spawned.push(p);
  return p;
}
store.setSpawner(fakeSpawn);

beforeEach(() => {
  store.shutdownAll();
  socketsMap.clear();
  spawned = [];
});

// === Tests ===

test('create y kill: la sesion entra y sale del store', () => {
  const sock = fakeSocket('s1');
  const r = store.createSession(sock, 'ses-1');
  assert.ok(r.persistentId, 'devuelve persistentId');
  assert.strictEqual(store.stats().ptys, 1);

  assert.strictEqual(store.killSession(r.persistentId), true);
  assert.strictEqual(store.stats().ptys, 0);
  assert.strictEqual(spawned[0].killed, true, 'el pty real recibe kill');
});

test('cap global de PTYs: rechaza la creacion numero MAX_PTYS+1', () => {
  const sock = fakeSocket('s1');
  for (let i = 0; i < 3; i++) {
    const r = store.createSession(sock, 'ses-' + i);
    assert.ok(r.persistentId, `sesion ${i} creada`);
  }
  const rechazada = store.createSession(sock, 'ses-overflow');
  assert.match(rechazada.error, /Limite global/);
  assert.strictEqual(store.stats().ptys, 3);
});

test('clientSessionId duplicado del mismo socket no crea PTY huerfano', () => {
  const sock = fakeSocket('s1');
  store.createSession(sock, 'ses-1');
  const dup = store.createSession(sock, 'ses-1');
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(store.stats().ptys, 1);
});

test('reconnect/takeover: el propietario anterior siempre recibe session:taken', () => {
  const sockA = fakeSocket('sA');
  const { persistentId } = store.createSession(sockA, 'ses-1');

  const sockB = fakeSocket('sB');
  const restored = store.reconnectSessions(sockB, [persistentId]);

  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].persistentId, persistentId);
  const taken = sockA.emitted.filter(([ev]) => ev === 'session:taken');
  assert.strictEqual(taken.length, 1, 'A fue notificado');
  assert.strictEqual(taken[0][1], persistentId);

  // El output posterior va al nuevo propietario
  spawned[0].emitData('hola');
  const restored2 = store.reconnectSessions(sockB, [persistentId]);
  assert.strictEqual(restored2[0].buffer, 'hola');
});

test('buffer de replay: recorta desde la cabeza al superar BUFFER_SIZE', () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  const p = spawned[0];

  p.emitData('A'.repeat(80));
  p.emitData('B'.repeat(60)); // total 140 > 100

  const [r] = store.reconnectSessions(sock, [persistentId]);
  assert.strictEqual(r.buffer.length, 100, 'buffer limitado a BUFFER_SIZE');
  assert.ok(r.buffer.endsWith('B'.repeat(60)), 'conserva lo mas reciente');
  assert.strictEqual(r.buffer, 'A'.repeat(40) + 'B'.repeat(60));
});

test('backpressure: pausa con cola llena y reanuda al drenar', async () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  const p = spawned[0];

  // Cola de escritura del socket por encima de BP_HIGH (50)
  sock.conn.writeBuffer = [{ data: 'x'.repeat(60) }];
  p.emitData('output');
  await new Promise(r => setTimeout(r, 20)); // deja disparar el flush de 8ms

  assert.strictEqual(p.pauseCalls, 1, 'pty pausado');

  // Drenaje: cola por debajo de BP_LOW (10)
  sock.conn.writeBuffer = [];
  store.onSocketDrain(sock);
  assert.strictEqual(p.resumeCalls, 1, 'pty reanudado');
  void persistentId;
});

test('huerfano: la salida no arma timers de batch pero alimenta el replay', async () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  const p = spawned[0];

  sock.connected = false; // simular desconexion del transporte
  p.emitData('mientras-huerfano');
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(sock.emitted.filter(([ev]) => ev === 'output'), [], 'no se emitio output');

  sock.connected = true;
  const [r] = store.reconnectSessions(sock, [persistentId]);
  assert.strictEqual(r.buffer, 'mientras-huerfano', 'el replay conserva la salida');
});

test('disconnect con grace: reanuda PTYs pausados y el grace expira matando', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  const p = spawned[0];

  // Forzar estado pausado antes de desconectar
  sock.conn.writeBuffer = [{ data: 'x'.repeat(60) }];
  p.emitData('y');
  t.mock.timers.tick(10); // flush → pausa
  assert.strictEqual(p.pauseCalls, 1);

  store.handleDisconnect(sock);
  assert.strictEqual(p.resumeCalls, 1, 'huerfano reanudado (los builds siguen)');
  assert.strictEqual(store.stats().ptys, 1, 'sigue vivo durante la gracia');

  t.mock.timers.tick(5000); // RECONNECT_GRACE=5s
  assert.strictEqual(p.killed, true, 'gracia expirada → kill');
  assert.strictEqual(store.stats().ptys, 0);
  void persistentId;
});

test('exit del proceso: limpia el store y notifica session:exit', async () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  spawned[0].emitExit();

  assert.strictEqual(store.stats().ptys, 0);
  const exits = sock.emitted.filter(([ev]) => ev === 'session:exit');
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0][1], persistentId);
});

test('reconnect de pid inexistente devuelve lista vacia', () => {
  const sock = fakeSocket('s1');
  const restored = store.reconnectSessions(sock, ['pty-999-zzz']);
  assert.deepStrictEqual(restored, []);
});

// === Anti crash-burst: kill que lanza no debe escapar (uncaughtException) ===

test('killSession con pty.kill que lanza: limpia el store igualmente', () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  spawned[0].killThrows = true;

  assert.strictEqual(store.killSession(persistentId), true, 'no lanza y devuelve true');
  assert.strictEqual(store.stats().ptys, 0, 'la entry se elimina aunque kill falle');
});

test('grace expirado con kill que lanza: no escapa del timer y limpia', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSocket('s1');
  store.createSession(sock, 'ses-1');
  spawned[0].killThrows = true;

  store.handleDisconnect(sock);
  // Si el throw escapara del callback, node --test lo marcaria como uncaught
  t.mock.timers.tick(5000);
  assert.strictEqual(store.stats().ptys, 0, 'store limpio tras la gracia');
});

test('writeInput sobre pty muerto (EIO) no lanza', () => {
  const sock = fakeSocket('s1');
  const { persistentId } = store.createSession(sock, 'ses-1');
  spawned[0].writeThrows = true;
  assert.doesNotThrow(() => store.writeInput(persistentId, 'ls\r'));
});

// === Propiedad de sesiones (clientId) ===

test('reconnect de otro clientId no roba la sesion ni emite session:taken', () => {
  const sockA = fakeSocket('sA');
  store.setSocketClient('sA', 'client-A');
  const { persistentId } = store.createSession(sockA, 'ses-1');

  const sockB = fakeSocket('sB');
  store.setSocketClient('sB', 'client-B');
  const restored = store.reconnectSessions(sockB, [persistentId]);

  assert.deepStrictEqual(restored, [], 'B no restaura la sesion de A');
  const taken = sockA.emitted.filter(([ev]) => ev === 'session:taken');
  assert.strictEqual(taken.length, 0, 'A no fue desposeido');
});

test('reconnect del mismo clientId en socket nuevo restaura (reload del navegador)', () => {
  const sockA = fakeSocket('sA');
  store.setSocketClient('sA', 'client-A');
  const { persistentId } = store.createSession(sockA, 'ses-1');
  spawned[0].emitData('estado');

  const sockA2 = fakeSocket('sA2');
  store.setSocketClient('sA2', 'client-A');
  const restored = store.reconnectSessions(sockA2, [persistentId]);

  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].buffer, 'estado');
});

test('adoptSession cruza la propiedad y notifica al dueño anterior', () => {
  const sockA = fakeSocket('sA');
  store.setSocketClient('sA', 'client-A');
  const { persistentId } = store.createSession(sockA, 'ses-1');

  const sockB = fakeSocket('sB');
  store.setSocketClient('sB', 'client-B');
  const adopted = store.adoptSession(sockB, persistentId);

  assert.ok(adopted && adopted.persistentId === persistentId, 'B adopta la sesion');
  const taken = sockA.emitted.filter(([ev]) => ev === 'session:taken');
  assert.strictEqual(taken.length, 1, 'A recibe session:taken');

  // Tras la adopcion, A ya no puede recuperarla via reconnect normal
  const backA = store.reconnectSessions(sockA, [persistentId]);
  assert.deepStrictEqual(backA, [], 'la propiedad ahora es de B');
});

test('getActiveSessionsList filtra por clientId y marca mine en modo foreign', () => {
  const sockA = fakeSocket('sA');
  store.setSocketClient('sA', 'client-A');
  store.createSession(sockA, 'ses-1');
  const sockB = fakeSocket('sB');
  store.setSocketClient('sB', 'client-B');
  store.createSession(sockB, 'ses-2');

  const soloB = store.getActiveSessionsList('client-B');
  assert.strictEqual(soloB.length, 1, 'auth_success solo ve las propias');
  assert.strictEqual(soloB[0].mine, true);

  const todas = store.getActiveSessionsList('client-B', true);
  assert.strictEqual(todas.length, 2, 'session:list ve tambien las ajenas');
  assert.deepStrictEqual(todas.map(e => e.mine).sort(), [false, true]);
});

test('sesion legacy (sin clientId) sigue siendo reclamable por cualquiera', () => {
  const sockOld = fakeSocket('sOld'); // sin setSocketClient: frontend antiguo
  const { persistentId } = store.createSession(sockOld, 'ses-1');

  const sockNew = fakeSocket('sNew');
  store.setSocketClient('sNew', 'client-N');
  const restored = store.reconnectSessions(sockNew, [persistentId]);
  assert.strictEqual(restored.length, 1, 'continuidad tras el deploy');
});

// === Duplicate create idempotente ===

test('clientSessionId duplicado devuelve el persistentId existente', () => {
  const sock = fakeSocket('s1');
  const orig = store.createSession(sock, 'ses-1');
  const dup = store.createSession(sock, 'ses-1');
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(dup.persistentId, orig.persistentId, 'permite re-emitir session:created');
});
