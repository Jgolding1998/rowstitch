import { randomUUID } from 'node:crypto';
// No optional peer is needed. Consumers are fresh temporary copies of dist. A fake PGlite exercises the real worker entry; scripted
// workers replace that entry to test what the host does with envelopes the real worker would not send. Real PGlite: tests/integration/public-driver.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SECRET = 'fictional-' + randomUUID();
const temporary = mkdtempSync(join(tmpdir(), 'rowstitch-pglite-adapter-'));
after(() => {
  const root = resolve(temporary);
  assert.ok(root.startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
});
/** Scripts engine messages from the SQL text. Only the shape the worker reads is modelled. */
const FAKE_PGLITE = String.raw`
const text = value => new TextEncoder().encode(value + '\n');
export const protocol = { serialize: {
  parse: ({ text: sql }) => text('P' + JSON.stringify(sql)), bind: ({ values }) => text('B' + JSON.stringify(values)),
  describe: () => text('D'), execute: () => text('X'), sync: () => text('S'),
} };
const PREFIX = [{ name: 'parseComplete' }, { name: 'bindComplete' }];
const ready = status => ({ name: 'readyForQuery', status });
const settings = () => ({ name: 'rowDescription', fields: [{ name: 'name', dataTypeID: 25, format: 0 }, { name: 'setting', dataTypeID: 25, format: 0 }] });
const row = (...fields) => ({ name: 'dataRow', fields });
const SETTINGS = [['client_encoding', 'UTF8'], ['server_encoding', 'UTF8'], ['extra_float_digits', '3'], ['server_version_num', '180006']];
export class PGlite {
  static async create(dataDir) { if (dataDir !== undefined) throw new Error('Expected in-memory'); console.log('${SECRET}'); return new PGlite(); }
  closed = false; state = 'I';
  async runExclusive(fn) { return fn(); }
  async close() { this.closed = true; }
  async execProtocol(bytes) {
    const lines = new TextDecoder().decode(bytes).trim().split('\n');
    if (lines.length === 1 && lines[0] === 'S') return { messages: [ready(this.state)] };
    const sql = JSON.parse(lines[0].slice(1)), values = JSON.parse(lines[1].slice(1));
    if (sql === 'SET extra_float_digits = 3') return { messages: [...PREFIX, { name: 'noData' }, { name: 'commandComplete', text: 'SET' }, ready('I')] };
    if (sql.includes('pg_settings')) return { messages: [...PREFIX, settings(), ...SETTINGS.map(pair => row(...pair)), { name: 'commandComplete', text: 'SELECT ' + SETTINGS.length }, ready('I')] };
    switch (sql) {
      case 'ECHO': return { messages: [...PREFIX, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: -2147483647, format: 0 }, { name: 'a', dataTypeID: 25, format: 0 }] }, row(values[0], null), { name: 'notice' }, { name: 'commandComplete', text: 'SELECT 1' }, ready('I')] };
      case 'BEGIN READ ONLY': this.state = 'T'; return { messages: [...PREFIX, { name: 'noData' }, { name: 'commandComplete', text: 'BEGIN' }, ready('T')] };
      case 'ROLLBACK': this.state = 'I'; return { messages: [...PREFIX, { name: 'noData' }, { name: 'commandComplete', text: 'ROLLBACK' }, ready('I')] };
      case 'REJECT': return { messages: [...PREFIX, { name: 'error', code: '23505', message: '${SECRET}', detail: '${SECRET}' }, ready('I')] };
      case 'REJECT_IN_T': this.state = 'E'; return { messages: [{ name: 'error', code: '22012', message: '${SECRET}' }, ready('E')] };
      case 'PARTIAL': return { messages: [...PREFIX, settings(), row('a', 'b'), { name: 'error', code: '22012' }, ready('I')] };
      case 'FATAL_NO_READY': return { messages: [{ name: 'error', code: '57P01', message: '${SECRET}' }] };
      case 'NO_CODE': return { messages: [{ name: 'error', message: '${SECRET}' }, ready('I')] };
      case 'CLOSED_THEN_ERROR': this.closed = true; return { messages: [{ name: 'error', code: '23505' }, ready('I')] };
      case 'ILLEGAL_ORDER': return { messages: [{ name: 'bindComplete' }, { name: 'parseComplete' }, ready('I')] };
      case 'TWO_READY': return { messages: [...PREFIX, { name: 'noData' }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I'), ready('I')] };
      case 'BINARY': return { messages: [...PREFIX, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 1 }] }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I')] };
      case 'THROW': throw new Error('${SECRET}');
      case 'BLOCK': for (;;);
      case 'EXIT': process.exit(0);
      default: return { messages: [...PREFIX, { name: 'noData' }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I')] };
    }
  }
}
`.replaceAll('${SECRET}', SECRET);
let count = 0;
function consumer(version = '0.5.15', source = FAKE_PGLITE) {
  const root = join(temporary, 'consumer-' + count++);
  mkdirSync(root);
  cpSync(DIST, join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}');
  if (version) {
    const directory = join(root, 'node_modules/@electric-sql/pglite');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@electric-sql/pglite', version, type: 'module', main: 'index.js' }));
    writeFileSync(join(directory, 'index.js'), source);
  }
  return root;
}
const load = (root, name) => import(pathToFileURL(join(root, 'dist', name)).href);
const real = consumer();
const { openPgliteExecutor } = await load(real, 'adapters/pglite.js');
const { isAcknowledgedRejection } = await load(real, 'core/executor.js');
const { isPostgresRawResult } = await load(real, 'core/postgres-result.js');
const { readExchange, extendedStatement } = await load(real, 'adapters/pglite-protocol.js');
const code = wanted => error => { assert.equal(error.code, wanted); return true; };
const leakFree = error => { assert.ok(!(inspect(error, { showHidden: true, depth: 8 }) + String(error?.stack)).includes(SECRET)); assert.equal(error.cause, undefined); };
const unconfirmed = error => { assert.ok(!isAcknowledgedRejection(error)); leakFree(error); return true; };

test('options: only deadlines are accepted, with no file path, and captured once without running accessors', async () => {
  let calls = 0;
  for (const options of [null, [], new (class X {})(), { dataDir: '/fictional/data' }, { dataDir: 'memory://' }, { debug: 5 }, { extensions: {} }, { openTimeoutMs: 0 }, { openTimeoutMs: 120_001 }, { requestTimeoutMs: 1.5 }, { requestTimeoutMs: '1' }, { closeTimeoutMs: 60_001 },
    { get requestTimeoutMs() { calls++; return 1; } }, new Proxy({}, { ownKeys() { throw new Error(SECRET); } })]) {
    await assert.rejects(openPgliteExecutor(options), error => { assert.equal(error.code, 'VALIDATION'); leakFree(error); return true; });
  }
  assert.equal(calls, 0);
});

test('peer resolution: a missing or different PGlite is refused; a broken one fails with a constant error', async () => {
  const missing = await load(consumer(null), 'adapters/pglite.js');
  await assert.rejects(missing.openPgliteExecutor(), error => { assert.equal(error.code, 'DRIVER_UNAVAILABLE'); assert.match(error.message, /0\.5\.15/); return true; });
  for (const version of ['0.5.14', '0.5.16', '0.6.0']) {
    const wrong = await load(consumer(version), 'adapters/pglite.js');
    await assert.rejects(wrong.openPgliteExecutor(), code('DRIVER_VERSION'));
  }
  const broken = await load(consumer('0.5.15', "throw new Error('" + SECRET + "');"), 'adapters/pglite.js');
  await assert.rejects(broken.openPgliteExecutor(), error => { assert.equal(error.code, 'OPEN'); leakFree(error); return true; });
  const shape = await load(consumer('0.5.15', 'export const PGlite = {};'), 'adapters/pglite.js');
  await assert.rejects(shape.openPgliteExecutor(), code('OPEN'));
});

test('an unsupported Node version is refused before a worker starts', async () => {
  const actual = Object.getOwnPropertyDescriptor(process, 'versions');
  Object.defineProperty(process, 'versions', { ...actual, value: { ...process.versions, node: '22.0.0' } });
  try { await assert.rejects(openPgliteExecutor(), code('UNSUPPORTED_RUNTIME')); } finally { Object.defineProperty(process, 'versions', actual); }
});

test('the exchange reader accepts only one legal extended exchange ending in one ReadyForQuery', () => {
  const ready = status => ({ name: 'readyForQuery', status });
  const [parse, bind, none, tag] = [{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'noData' }, { name: 'commandComplete', text: 'INSERT 0 1' }];
  const description = { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 0 }] };
  assert.deepEqual(readExchange([parse, bind, none, tag, ready('T')]).result, { fields: [], rows: [], commandTag: 'INSERT 0 1' });
  assert.deepEqual(readExchange([parse, bind, { name: 'notice' }, description, { name: 'dataRow', fields: ['1'] }, { name: 'commandComplete', text: 'SELECT 1' }, { name: 'parameterStatus' }, ready('I')]),
    { status: 'I', result: { fields: [{ name: 'a', typeOid: 20 }], rows: [['1']], commandTag: 'SELECT 1' } });
  const error = { name: 'error', code: '23505' };
  for (const [replies, afterCommandComplete] of [[[], false], [[parse], false], [[parse, bind], false], [[parse, bind, none], false], [[parse, bind, description, { name: 'dataRow', fields: ['1'] }], false], [[parse, bind, none, tag], true]]) {
    const outcome = readExchange([...replies, error, ready('I')]);
    assert.equal(outcome.error, error);
    assert.equal(outcome.afterCommandComplete, afterCommandComplete);
    assert.equal(outcome.result, undefined, 'Rows before an error are discarded');
  }
  for (const messages of [null, {}, [], [ready('X')], [ready('I'), ready('I')], [parse, bind, none, tag], [parse, bind, none, ready('I')], [bind, parse, none, tag, ready('I')], [tag, ready('I')], [parse, bind, none, tag, tag, ready('I')], [error, tag, ready('I')], [error, error, ready('I')],
    [parse, bind, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 1 }] }, tag, ready('I')], [parse, bind, description, { name: 'dataRow', fields: ['1', '2'] }, tag, ready('I')], [parse, bind, none, { name: 'commandComplete', text: 'lower' }, ready('I')], [parse, bind, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 0, format: 0 }] }, tag, ready('I')], [parse, bind, none, tag, { name: 'copyData' }, ready('I')]]) {
    assert.throws(() => readExchange(messages), Error);
  }
  const parts = [];
  const reused = new Uint8Array(1);
  const bytes = extendedStatement({ parse: o => (reused[0] = 1, parts.push(o), reused), bind: o => (reused[0] = 2, parts.push(o), reused), describe: o => (reused[0] = 3, parts.push(o), reused), execute: o => (reused[0] = 4, parts.push(o), reused), sync: () => (reused[0] = 5, reused) }, 'SELECT 1', ['x', null]);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5], 'Each part is copied even if the serializer reuses a buffer');
  assert.deepEqual(parts, [{ text: 'SELECT 1' }, { values: ['x', null] }, { type: 'P' }, {}]);
});

test('the real worker entry carries results, status and genuine rejections, without message text', async () => {
  const executor = await openPgliteExecutor();
  assert.ok(Object.isFrozen(executor));
  const result = await executor.all('ECHO', [9007199254740993n]);
  assert.ok(isPostgresRawResult(result));
  assert.deepEqual([result.command, result.rowCount, result.fields, result.rows], ['SELECT', 1n, [{ name: 'a', typeOid: 2147483649 }, { name: 'a', typeOid: 25 }], [['9007199254740993', null]]]);
  await assert.rejects(executor.all('REJECT', []), error => { assert.equal(error.code, 'CONSTRAINT'); assert.ok(isAcknowledgedRejection(error)); leakFree(error); return true; });
  await assert.rejects(executor.all('PARTIAL', []), error => { assert.ok(isAcknowledgedRejection(error)); return true; });
  await executor.exec('BEGIN READ ONLY');
  assert.equal(await executor.inTransaction(), true);
  await assert.rejects(executor.all('REJECT_IN_T', []), error => { assert.ok(isAcknowledgedRejection(error)); return true; });
  assert.equal(await executor.inTransaction(), true);
  await executor.exec('ROLLBACK');
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
  await executor.close();
  await assert.rejects(executor.all('ECHO', []), code('CLOSED'));
});

test('anything but a genuine ErrorResponse followed by ReadyForQuery ends the worker as unknown', async () => {
  for (const sql of ['FATAL_NO_READY', 'NO_CODE', 'CLOSED_THEN_ERROR', 'ILLEGAL_ORDER', 'TWO_READY', 'BINARY', 'THROW', 'EXIT']) {
    const executor = await openPgliteExecutor();
    await assert.rejects(executor.all(sql, []), unconfirmed, sql);
    await assert.rejects(executor.all('ECHO', []), unconfirmed, sql + ' stays poisoned');
    await executor.close();
  }
});

test('overlapping requests end the worker as unknown', async () => {
  const executor = await openPgliteExecutor({ requestTimeoutMs: 1000 });
  const first = executor.all('ECHO', ['1']).then(() => 'success', error => error);
  await assert.rejects(executor.all('ECHO', ['2']), unconfirmed);
  unconfirmed(await first);
  await executor.close();
});

test('a deadline fires while WASM-style work blocks the worker; the host loop runs and the worker is ended', async () => {
  const executor = await openPgliteExecutor({ requestTimeoutMs: 120 });
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  const started = Date.now();
  await assert.rejects(executor.all('BLOCK', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); return unconfirmed(error); });
  clearInterval(interval);
  assert.ok(Date.now() - started < 2000);
  assert.ok(ticks >= 3, 'The host event loop kept running');
  await executor.close();
  await assert.rejects(executor.all('ECHO', []), error => !isAcknowledgedRejection(error));
});

// A process exits by itself only when nothing holds its event loop, so this observes real release of the worker thread.
function runChild(body, timeout = 20_000) {
  const file = join(real, 'child-' + count++ + '.mjs');
  writeFileSync(file, "import { openPgliteExecutor } from './dist/adapters/pglite.js';\n" + body);
  return spawnSync(process.execPath, [file], { encoding: 'utf8', timeout, cwd: real });
}
test('the worker thread is really released: after close, and after a deadline with no close call', () => {
  const closed = runChild("const db = await openPgliteExecutor(); await db.all('ECHO', ['1']); await db.close(); console.log('closed');");
  assert.deepEqual([closed.status, closed.signal, closed.stdout.trim()], [0, null, 'closed']);
  const deadline = runChild("const db = await openPgliteExecutor({ requestTimeoutMs: 80 }); await db.all('BLOCK', []).catch(error => console.log(error.code));");
  assert.deepEqual([deadline.status, deadline.signal, deadline.stdout.trim()], [0, null, 'DRIVER_TIMEOUT']);
  assert.ok(!deadline.stdout.includes(SECRET) && !deadline.stderr.includes(SECRET), 'Engine output stays in the worker');
  // The control: a worker left open does hold the process, so the two exits above are meaningful.
  const open = runChild("await openPgliteExecutor(); console.log('open');", 2_500);
  assert.equal(open.stdout.trim(), 'open');
  assert.notEqual(open.signal, null, 'An unclosed worker keeps the process alive until killed');
});

// Scripted worker: replaces the entry file, so the host sees exactly these envelopes.
const scripted = consumer();
const hosted = await load(scripted, 'adapters/pglite.js');
const scriptedChecks = await load(scripted, 'core/executor.js');
const ENTRY = join(scripted, 'dist/adapters/pglite-worker.js');
copyFileSync(ENTRY, ENTRY + '.real');
const worker = body => writeFileSync(ENTRY, `import { parentPort } from 'node:worker_threads';
const send = message => parentPort.postMessage(message);
const SETTINGS = [['client_encoding', 'UTF8'], ['server_encoding', 'UTF8'], ['extra_float_digits', '3'], ['server_version_num', '180006']];
const settings = id => send({ protocol: 1, kind: 'result', id, status: 'I', result: { fields: [{ name: 'name', typeOid: 25 }, { name: 'setting', typeOid: 25 }], rows: SETTINGS, commandTag: 'SELECT 4' } });
const ok = (id, status = 'I') => send({ protocol: 1, kind: 'result', id, status, result: { fields: [], rows: [], commandTag: 'SELECT 0' } });
${body}`);
const AFTER_OPEN = `send({ protocol: 1, kind: 'ready', status: 'I' });
parentPort.on('message', packet => {
  if (packet.op === 'close') { closing(packet.id); return; }
  if (packet.sql.includes('pg_settings')) { settings(packet.id); return; }
  run(packet);
});`;
const hostUnconfirmed = error => { assert.ok(!scriptedChecks.isAcknowledgedRejection(error)); leakFree(error); return true; };

test('the host refuses malformed or unsolicited startup messages', async () => {
  for (const [name, body] of Object.entries({
    silentExit: 'process.exit(0);', throwing: "throw new Error('" + SECRET + "');", nonObject: "send('ready');", array: 'send([]);', wrongProtocol: "send({ protocol: 2, kind: 'ready', status: 'I' });", extraKey: "send({ protocol: 1, kind: 'ready', status: 'I', extra: 1 });",
    notIdle: "send({ protocol: 1, kind: 'ready', status: 'T' });", earlyResult: 'ok(1);', openError: "send({ protocol: 1, kind: 'open-error' });",
    wrongSettings: `send({ protocol: 1, kind: 'ready', status: 'I' }); parentPort.on('message', packet => send({ protocol: 1, kind: 'result', id: packet.id, status: 'I', result: { fields: [{ name: 'name', typeOid: 25 }, { name: 'setting', typeOid: 25 }], rows: [['client_encoding', 'LATIN1'], ['server_encoding', 'UTF8'], ['extra_float_digits', '3'], ['server_version_num', '180006']], commandTag: 'SELECT 4' } }));`,
    uncoded: `send({ protocol: 1, kind: 'ready', status: 'I' }); parentPort.on('message', () => process.exit(1));`,
  })) {
    worker(body);
    await assert.rejects(hosted.openPgliteExecutor(), error => { assert.equal(error.code, 'OPEN', name); leakFree(error); return true; }, name);
  }
  worker('setInterval(() => {}, 1000);');
  await assert.rejects(hosted.openPgliteExecutor({ openTimeoutMs: 40 }), code('DRIVER_TIMEOUT'));
  worker('for (;;);');
  await assert.rejects(hosted.openPgliteExecutor({ openTimeoutMs: 40 }), code('DRIVER_TIMEOUT'));
});

test('the host poisons on any reply that is malformed, stale, repeated or unsolicited', async () => {
  const replies = {
    unknownKind: "send({ protocol: 1, kind: 'other', id: packet.id, status: 'I' });",
    wrongProtocol: "send({ protocol: 2, kind: 'result', id: packet.id, status: 'I', result: {} });",
    staleId: "send({ protocol: 1, kind: 'result', id: packet.id - 1, status: 'I', result: {} });",
    futureId: "send({ protocol: 1, kind: 'result', id: packet.id + 1, status: 'I', result: {} });",
    badStatus: "send({ protocol: 1, kind: 'result', id: packet.id, status: 'X', result: { fields: [], rows: [], commandTag: 'SELECT 0' } });",
    missingStatus: "send({ protocol: 1, kind: 'result', id: packet.id, result: { fields: [], rows: [], commandTag: 'SELECT 0' } });",
    extraResultKey: "send({ protocol: 1, kind: 'result', id: packet.id, status: 'I', result: { fields: [], rows: [], commandTag: 'SELECT 0' }, message: '" + SECRET + "' });",
    malformedResult: "send({ protocol: 1, kind: 'result', id: packet.id, status: 'I', result: { rows: [] } });",
    badTag: "send({ protocol: 1, kind: 'result', id: packet.id, status: 'I', result: { fields: [], rows: [], commandTag: '" + SECRET + "' } });",
    badSqlstate: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: 'bad', afterCommandComplete: false });",
    missingFlag: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '23505' });",
    textFlag: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '23505', afterCommandComplete: 'false' });",
    messageText: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '23505', afterCommandComplete: false, message: '" + SECRET + "' });",
    wrongRejectionStatus: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'T', sqlstate: '23505', afterCommandComplete: false });",
    unresolvedState: "send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '57P01', afterCommandComplete: false });",
    closedForQuery: "send({ protocol: 1, kind: 'closed', id: packet.id });",
    exit: 'process.exit(0);',
    throws: "throw new Error('" + SECRET + "');",
    nonObject: 'send(null);',
    unclonable: 'send(() => 1);',
  };
  for (const [name, reply] of Object.entries(replies)) {
    worker(AFTER_OPEN + `\nconst closing = id => send({ protocol: 1, kind: 'closed', id });\nconst run = packet => { ${reply} };`);
    const executor = await hosted.openPgliteExecutor({ requestTimeoutMs: 400 });
    await assert.rejects(executor.all('SELECT fictional', []), hostUnconfirmed, name);
    await assert.rejects(executor.all('SELECT fictional', []), hostUnconfirmed, name + ' stays poisoned');
    await executor.close().catch(() => {});
  }
  // A repeated reply, or one nobody asked for, poisons the idle connection for what comes next.
  for (const [name, reply] of Object.entries({
    repeated: 'ok(packet.id); ok(packet.id);',
    lateRejection: "ok(packet.id); send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '23505', afterCommandComplete: false });",
    unsolicitedLater: "ok(packet.id); setTimeout(() => ok(99), 5);",
  })) {
    worker(AFTER_OPEN + `\nconst closing = id => send({ protocol: 1, kind: 'closed', id });\nconst run = packet => { ${reply} };`);
    const executor = await hosted.openPgliteExecutor();
    await executor.all('SELECT fictional', []);
    await new Promise(ok => setTimeout(ok, 40));
    await assert.rejects(executor.all('SELECT fictional', []), hostUnconfirmed, name);
    await executor.close().catch(() => {});
  }
  // The control: the same channel with a truthful rejection is acknowledged.
  worker(AFTER_OPEN + `\nconst closing = id => send({ protocol: 1, kind: 'closed', id });\nconst run = packet => send({ protocol: 1, kind: 'rejected', id: packet.id, status: 'I', sqlstate: '23505', afterCommandComplete: false });`);
  const executor = await hosted.openPgliteExecutor();
  await assert.rejects(executor.all('SELECT fictional', []), error => { assert.equal(error.code, 'CONSTRAINT'); assert.ok(scriptedChecks.isAcknowledgedRejection(error)); return true; });
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
});

test('close is bounded: a silent or failing worker is ended and the close stays unconfirmed; an in-flight request does not wait', async () => {
  for (const closing of ['id => {}', 'id => process.exit(1)', "id => send({ protocol: 1, kind: 'closed', id, extra: 1 })", "id => send({ protocol: 1, kind: 'closed', id: id + 1 })"]) {
    worker(AFTER_OPEN + `\nconst closing = ${closing};\nconst run = packet => ok(packet.id);`);
    const executor = await hosted.openPgliteExecutor({ closeTimeoutMs: 40 });
    await assert.rejects(executor.close(), error => { assert.equal(error.code, 'CLOSE_UNCONFIRMED'); leakFree(error); return true; }, closing);
  }
  worker(AFTER_OPEN + `\nconst closing = id => {};\nconst run = () => { for (;;); };`);
  const executor = await hosted.openPgliteExecutor();
  const pending = executor.all('SELECT fictional', []);
  const outcome = pending.then(() => 'success', error => error);
  const started = Date.now();
  await executor.close();
  assert.ok(Date.now() - started < 2000);
  hostUnconfirmed(await outcome);
  copyFileSync(ENTRY + '.real', ENTRY);
});
