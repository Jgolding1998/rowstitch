import { randomUUID } from 'node:crypto';
// No optional peer is needed. Each consumer is a fresh temporary copy of dist with its own node_modules, so peer resolution is real.
// The fake pg below scripts protocol events; tests/integration/public-driver.mjs covers the real client and server.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SECRET = 'fictional-' + randomUUID(), SECRET_HOST = 'fictional-host-7Q.example.test';
const temporary = mkdtempSync(join(tmpdir(), 'rowstitch-adapter-'));
after(() => {
  const root = resolve(temporary);
  assert.ok(root.startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true });
});
const FAKE_PG = String.raw`
import { EventEmitter } from 'node:events';
const fake = new Proxy({}, { get: (_, key) => globalThis.__pgFake[key], set: (_, key, value) => { globalThis.__pgFake[key] = value; return true; } });
export class DatabaseError extends Error { constructor(code) { super(fake.secret); this.code = code; } }
class Socket extends EventEmitter {
  constructor() { super(); this.stream = { destroy: () => { fake.destroyed++; this.emit('end'); } }; }
}
export class Connection extends EventEmitter {
  constructor(config) { super(); this.config = config; fake.cancelConfigs.push(config); this.stream = { destroy: () => this.emit('end') }; }
  connect(...where) { fake.cancelTargets.push(where); queueMicrotask(() => this.emit('connect')); }
  requestSsl() { fake.sslRequests++; queueMicrotask(() => this.emit('sslconnect')); }
  cancel(pid, key) { fake.cancels.push([pid, key]); fake.onCancel?.(); queueMicrotask(() => this.emit('end')); }
}
export class Client extends EventEmitter {
  constructor(config) {
    super();
    // As pg 8.23.1 does, in both its connection parameters and its client. This throws on a frozen object.
    if (config.ssl && config.ssl.key) Object.defineProperty(config.ssl, 'key', { enumerable: false });
    fake.configs.push(config); this.connection = new Socket(); this.binary = false;
    this.connectionParameters = { host: config.host, database: config.database, user: config.user, options: config.options, replication: fake.replication };
    fake.clients.push(this);
  }
  async connect() {
    await fake.onConnect?.(this);
    this.connection.emit('backendKeyData', { processID: 4242, secretKey: 77 });
    this.connection.emit('readyForQuery', { status: 'I' });
  }
  query(config) { fake.queries.push(config); return fake.answer(this, config); }
  async end() { fake.ended++; this.connection.emit('end'); }
}
export default { Client, Connection, DatabaseError };
`;
function peer(root, version, source) {
  const directory = join(root, 'node_modules/pg');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pg', version, type: 'module', main: 'index.js' }));
  writeFileSync(join(directory, 'index.js'), source);
}
let count = 0;
function consumer(version = '8.23.1', source = FAKE_PG) {
  const root = join(temporary, 'consumer-' + count++);
  mkdirSync(root);
  cpSync(DIST, join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}');
  if (version) peer(root, version, source);
  return root;
}
const load = (root, name) => import(pathToFileURL(join(root, 'dist', name)).href);
const main = consumer();
const { openPgExecutor } = await load(main, 'adapters/pg.js');
const { isAcknowledgedRejection } = await load(main, 'core/executor.js');
const { isPostgresRawResult } = await load(main, 'core/postgres-result.js');

const BASE = { host: 'localhost', user: 'app_user', database: 'app_db' };
const code = wanted => error => { assert.equal(error.code, wanted); return true; };
const leakFree = error => {
  const text = inspect(error, { showHidden: true, depth: 8 }) + String(error?.message) + String(error?.stack) + JSON.stringify(error ?? null);
  for (const secret of [SECRET, SECRET_HOST]) assert.ok(!text.includes(secret), 'Must not expose a fictional secret');
  assert.equal(error.cause, undefined);
};
function settingsRows(overrides = {}) {
  return Object.entries({ client_encoding: 'UTF8', server_encoding: 'UTF8', extra_float_digits: '3', server_version_num: '180006', ...overrides })
    .filter(([, value]) => value !== undefined).map(([name, value]) => [name, value]);
}
/** Default scripted server: answers settings truthfully from what was asked, then runs a per-test script for later queries. */
function reset(script = {}) {
  const fake = { secret: SECRET, configs: [], clients: [], queries: [], cancels: [], cancelTargets: [], cancelConfigs: [], sslRequests: 0, destroyed: 0, ended: 0, ...script };
  fake.answer = (client, config) => {
    const socket = client.connection;
    if (config.text.includes('pg_settings')) {
      const wanted = config.values[0].slice(1, -1).split(',');
      // A real server returns only the names asked for, which `filtered` models. Unfiltered scripts test malformed answers.
      const rows = fake.settings ? (fake.filtered ? fake.settings.filter(row => wanted.includes(row[0])) : fake.settings) : settingsRows(Object.fromEntries(wanted.filter(name => !['client_encoding', 'server_encoding', 'extra_float_digits', 'server_version_num'].includes(name))
        .map(name => [name, (fake.configs[0].options.match(new RegExp(name + '=(\\d+)')) ?? [])[1]])));
      socket.emit('commandComplete', { text: 'SELECT ' + rows.length });
      socket.emit('readyForQuery', { status: fake.status ?? 'I' });
      return Promise.resolve({ fields: [{ name: 'name', dataTypeID: 25, format: 'text' }, { name: 'setting', dataTypeID: 25, format: 'text' }], rows });
    }
    return fake.next(socket, config, client);
  };
  globalThis.__pgFake = fake;
  return fake;
}
const respond = (socket, tag, status = 'I', rows = [], fields = []) => { socket.emit('commandComplete', { text: tag }); socket.emit('readyForQuery', { status }); return Promise.resolve({ fields, rows }); };
const reject = async (socket, sqlstate, { tag, status = 'I' } = {}) => {
  if (tag) socket.emit('commandComplete', { text: tag });
  socket.emit('errorMessage', {});
  const { DatabaseError } = await import(pathToFileURL(join(main, 'node_modules/pg/index.js')).href);
  queueMicrotask(() => socket.emit('readyForQuery', { status }));
  throw new DatabaseError(sqlstate);
};
const open = (extra = {}) => openPgExecutor({ ...BASE, ...extra });
// A connect deadline no other timer uses. Its callback is held and fired by the test, so nothing depends on how long loading takes.
const HELD_DEADLINE_MS = 119_999;
function openWithHeldDeadline(start) {
  const real = globalThis.setTimeout;
  let fire;
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms !== HELD_DEADLINE_MS) return real(callback, ms, ...rest);
    fire = callback;
    return {};
  };
  // The adapter arms its deadline before its first await, so the callback exists by the time this returns.
  try {
    const attempt = start({ connectTimeoutMs: HELD_DEADLINE_MS });
    assert.equal(typeof fire, 'function');
    return { attempt, fire };
  } finally { globalThis.setTimeout = real; }
}

test('every invalid option is one constant VALIDATION error, before any peer loads, and exposes nothing', async () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error(SECRET); }, getOwnPropertyDescriptor() { throw new Error(SECRET); } });
  let accessorCalls = 0;
  const accessor = { ...BASE, get password() { accessorCalls++; return SECRET; } };
  const uri = suffix => 'postgres://app_user:' + SECRET + '@' + SECRET_HOST + ':5432/app_db' + suffix;
  const cases = {
    missing: undefined, nullOptions: null, array: [], classInstance: new (class Options { host = 'localhost'; })(), hostile, accessor, symbol: { ...BASE, [Symbol('x')]: 1 },
    unknown: { ...BASE, connectionTimeoutMillis: 1 }, driverOptions: { ...BASE, options: '-c extra_float_digits=0' }, driverQueryTimeout: { ...BASE, query_timeout: 1 },
    noHost: { user: 'a', database: 'b' }, noUser: { host: 'h', database: 'b' }, noDatabase: { host: 'h', user: 'a' }, emptyHost: { ...BASE, host: '' }, nulInUser: { ...BASE, user: 'a\0b' },
    surrogate: { ...BASE, database: '\ud800' }, commaHost: { ...BASE, host: 'a,b' }, spaceHost: { ...BASE, host: 'a b' }, numericHost: { ...BASE, host: 1 },
    port0: { ...BASE, port: 0 }, portHigh: { ...BASE, port: 65536 }, portText: { ...BASE, port: '5432' }, emptyPassword: { ...BASE, password: '' }, numberPassword: { ...BASE, password: 1 }, functionPassword: { ...BASE, password: () => SECRET },
    sslString: { ...BASE, ssl: 'require' }, sslDisabledVerify: { ...BASE, ssl: { rejectUnauthorized: false } }, sslCertAlone: { ...BASE, ssl: { cert: 'c' } }, sslKeyAlone: { ...BASE, ssl: { key: SECRET } }, sslAccessor: { ...BASE, ssl: { get ca() { return 'x'; } } },
    appNonAscii: { ...BASE, applicationName: 'é' }, appLong: { ...BASE, applicationName: 'x'.repeat(64) },
    connectZero: { ...BASE, connectTimeoutMs: 0 }, connectHigh: { ...BASE, connectTimeoutMs: 120_001 }, requestFloat: { ...BASE, requestTimeoutMs: 1.5 }, requestNaN: { ...BASE, requestTimeoutMs: NaN }, closeHigh: { ...BASE, closeTimeoutMs: 60_001 },
    statementNegative: { ...BASE, statementTimeoutMs: -1 }, lockHigh: { ...BASE, lockTimeoutMs: 2_147_483_648 }, transactionText: { ...BASE, transactionTimeoutMs: '1' }, idleFloat: { ...BASE, idleInTransactionTimeoutMs: 0.5 },
    uriNotString: { connectionString: 1 }, uriEmpty: { connectionString: '' }, uriGarbage: { connectionString: SECRET }, uriBadEscape: { connectionString: 'postgres://%E0%A4%A:' + SECRET + '@h/d' },
    uriScheme: { connectionString: 'mysql://a:' + SECRET + '@h/d' }, uriNoUser: { connectionString: 'postgres://h/d' }, uriNoDatabase: { connectionString: 'postgres://a@h' }, uriNestedPath: { connectionString: 'postgres://a@h/d/e' }, uriFragment: { connectionString: uri('#x') },
    uriMultiHost: { connectionString: 'postgres://a@h1,h2/d' }, uriOptions: { connectionString: uri('?options=-c%20extra_float_digits%3D0') }, uriFloat: { connectionString: uri('?extra_float_digits=0') }, uriEncoding: { connectionString: uri('?client_encoding=LATIN1') },
    uriStatement: { connectionString: uri('?statement_timeout=1') }, uriHost: { connectionString: uri('?host=/tmp') }, uriPort: { connectionString: uri('?port=1') }, uriCertFile: { connectionString: uri('?sslcert=/fictional/client.crt') }, uriKeyFile: { connectionString: uri('?sslkey=/fictional/client.key') },
    uriRootFile: { connectionString: uri('?sslrootcert=/fictional/ca.crt') }, uriSsl: { connectionString: uri('?ssl=true') }, uriReplication: { connectionString: uri('?replication=database') }, uriSslRequire: { connectionString: uri('?sslmode=require') }, uriNoVerify: { connectionString: uri('?sslmode=no-verify') },
    uriTwoModes: { connectionString: uri('?sslmode=disable&sslmode=verify-full') }, uriPlusHost: { connectionString: uri(''), host: 'h' }, uriPlusUser: { connectionString: uri(''), user: 'u' }, uriPlusPort: { connectionString: uri(''), port: 5432 }, uriPlusDatabase: { connectionString: uri(''), database: 'd' },
    uriTwoPasswords: { connectionString: uri(''), password: 'other' }, uriModePlusSsl: { connectionString: uri('?sslmode=verify-full'), ssl: true },
  };
  globalThis.__pgFake = undefined; // Loading the fake without its state would throw at first use; nothing may reach it.
  const messages = new Set();
  for (const [name, options] of Object.entries(cases)) {
    await assert.rejects(openPgExecutor(options), error => { assert.equal(error.code, 'VALIDATION', name); leakFree(error); messages.add(error.message); return true; }, name);
  }
  assert.equal(messages.size, 1);
  assert.equal(accessorCalls, 0, 'Accessors are not invoked');
});

test('opening passes explicit fields only, so a URI query, environment or password file cannot override library settings', async () => {
  const fake = reset();
  const executor = await openPgExecutor({ connectionString: 'postgresql://app%20user:' + SECRET + '%21@[::1]:6543/app%2Fdb?sslmode=disable', statementTimeoutMs: 0, lockTimeoutMs: 1500, transactionTimeoutMs: 2000, idleInTransactionTimeoutMs: 3000, connectTimeoutMs: 2500 });
  const [config] = fake.configs;
  assert.equal(config.connectionString, undefined);
  assert.deepEqual({ host: config.host, port: config.port, user: config.user, database: config.database, ssl: config.ssl }, { host: '::1', port: 6543, user: 'app user', database: 'app/db', ssl: false });
  assert.equal(config.options, '-c extra_float_digits=3 -c client_encoding=UTF8 -c statement_timeout=0 -c lock_timeout=1500 -c transaction_timeout=2000 -c idle_in_transaction_session_timeout=3000');
  assert.equal(config.client_encoding, 'UTF8');
  assert.equal(config.sslnegotiation, 'postgres');
  assert.equal(config.application_name, 'rowstitch');
  assert.equal(config.connectionTimeoutMillis, undefined, 'One deadline owns opening, so no second timer can change the error');
  assert.equal(typeof config.password, 'function');
  assert.equal(config.password(), SECRET + '!');
  for (const key of ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'query_timeout', 'binary', 'replication', 'types', 'stream']) assert.equal(key in config, false, key);
  assert.ok(!inspect(fake.configs[0]).includes(SECRET), 'The password travels in a closure');
  await executor.close();
  const second = reset();
  const noPassword = await open({ ssl: { ca: 'CA TEXT' }, applicationName: 'fictional app', port: 1234 });
  assert.equal(second.configs[0].password(), undefined, 'No password stays no password, instead of reaching PGPASSWORD or a password file');
  assert.deepEqual(second.configs[0].ssl, { ca: 'CA TEXT' });
  assert.equal(second.configs[0].application_name, 'fictional app');
  await noPassword.close();
  const third = reset();
  const verified = await openPgExecutor({ connectionString: 'postgres://a@h/d?sslmode=verify-full' });
  assert.equal(third.configs[0].ssl, true);
  await verified.close();
});

test('options are captured before the first await', async () => {
  const fake = reset();
  const options = { ...BASE, statementTimeoutMs: 100 };
  const pending = openPgExecutor(options);
  options.host = 'changed'; options.statementTimeoutMs = 999; options.user = 'changed';
  const executor = await pending;
  assert.equal(fake.configs[0].host, 'localhost');
  assert.equal(fake.configs[0].user, 'app_user');
  assert.match(fake.configs[0].options, /statement_timeout=100$/);
  await executor.close();
});

test('the server must confirm settings; a refused setting closes the connection with one constant error', async () => {
  for (const [name, settings] of Object.entries({
    floatDigits: settingsRows({ extra_float_digits: '1' }), clientEncoding: settingsRows({ client_encoding: 'LATIN1' }), serverEncoding: settingsRows({ server_encoding: 'SQL_ASCII' }),
    oldServer: settingsRows({ server_version_num: '110022' }), malformedVersion: settingsRows({ server_version_num: 'x' }), noVersion: settingsRows({ server_version_num: undefined }),
    missing: settingsRows().slice(1), duplicate: [...settingsRows().slice(1), settingsRows()[1]], extra: [...settingsRows(), ['other', 'x']],
  })) {
    const fake = reset({ settings });
    await assert.rejects(open(), error => { assert.equal(error.code, 'OPEN', name); leakFree(error); return true; }, name);
    assert.equal(fake.destroyed, 1, name);
  }
  // Each requested timeout must come back with exactly the requested value, and a server without the setting is refused.
  for (const [option, setting] of [['statementTimeoutMs', 'statement_timeout'], ['lockTimeoutMs', 'lock_timeout'], ['transactionTimeoutMs', 'transaction_timeout'], ['idleInTransactionTimeoutMs', 'idle_in_transaction_session_timeout']]) {
    const wrong = reset({ filtered: true, settings: settingsRows({ [setting]: '5' }) });
    await assert.rejects(open({ [option]: 6 }), code('OPEN'), setting);
    assert.equal(wrong.destroyed, 1, setting);
    const absent = reset({ filtered: true, settings: settingsRows() });
    await assert.rejects(open({ [option]: 6 }), code('OPEN'), setting);
    assert.equal(absent.destroyed, 1, setting);
    const right = reset({ filtered: true, settings: settingsRows({ [setting]: '6' }) });
    await (await open({ [option]: 6 })).close();
    assert.equal(right.destroyed, 0, setting);
    // An unrequested server value is not this adapter's to judge.
    await (await (reset({ filtered: true, settings: settingsRows({ [setting]: '5' }) }), open())).close();
  }
  // A role cannot quietly weaken a requested timeout, and an open transaction at startup is not a clean session.
  reset({ status: 'T' });
  await assert.rejects(open(), code('OPEN'));
});

test('connection failures and ambient overrides become constant errors', async () => {
  reset({ onConnect() { throw Object.assign(new Error('auth failed for ' + SECRET + ' at ' + SECRET_HOST), { code: '28P01', password: SECRET }); } });
  await assert.rejects(open(), error => { assert.equal(error.code, 'OPEN'); leakFree(error); return true; });
  reset({ replication: 'database' });
  await assert.rejects(open(), code('OPEN'));
});

test('a connect deadline closes a transport that already exists', async () => {
  let entered;
  const connecting = new Promise(resolve => { entered = resolve; });
  const hung = reset({ onConnect: () => { entered(); return new Promise(() => {}); } });
  const { attempt, fire } = openWithHeldDeadline(open);
  // Either the transport is really connecting, or the attempt failed for another reason and rejects below.
  await Promise.race([connecting, attempt]);
  assert.equal(hung.clients.length, 1);
  assert.equal(hung.destroyed, 0, 'Nothing closes it before its deadline');
  fire();
  await assert.rejects(attempt, error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); leakFree(error); return true; });
  assert.equal(hung.destroyed, 1);
});

test('a connect deadline before the client loads never creates a transport', async () => {
  // A fresh consumer has its own copy of the peer, so its module evaluates during this attempt and reports when it has.
  let evaluated;
  const loaded = new Promise(resolve => { evaluated = resolve; });
  const early = reset({ peerEvaluated: () => evaluated() });
  const fresh = await load(consumer('8.23.1', FAKE_PG + '\nglobalThis.__pgFake.peerEvaluated?.();\n'), 'adapters/pg.js');
  const { attempt, fire } = openWithHeldDeadline(extra => fresh.openPgExecutor({ ...BASE, ...extra }));
  fire();
  await assert.rejects(attempt, error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); leakFree(error); return true; });
  await loaded;
  // The adapter checks the deadline right after the import settles, which is before later event-loop turns.
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(early.clients.length, 0, 'An expired open must not start connecting');
  assert.equal(early.destroyed, 0);
});

test('client certificates reach the driver from a private snapshot, and the caller object is left alone', async () => {
  const frozen = Object.freeze({ ca: 'CA TEXT', cert: 'CERT TEXT', key: SECRET });
  const fake = reset(); fake.next = () => new Promise(() => {});
  const executor = await open({ ssl: frozen, requestTimeoutMs: 20 });
  const driven = fake.configs[0].ssl;
  assert.notEqual(driven, frozen);
  assert.deepEqual([driven.ca, driven.cert, driven.key], ['CA TEXT', 'CERT TEXT', SECRET]);
  assert.equal(Object.getOwnPropertyDescriptor(frozen, 'key').enumerable, true, 'The driver marks only its own copy');
  // Cancellation still negotiates TLS with the same captured material, on its own copy, and after pg changed the first one.
  await assert.rejects(executor.all('SELECT fictional', []), code('DRIVER_TIMEOUT'));
  await executor.close();
  assert.equal(fake.sslRequests, 1);
  assert.deepEqual(fake.cancels, [[4242, 77]]);
  const cancelling = fake.cancelConfigs[0].ssl;
  assert.notEqual(cancelling, driven);
  assert.notEqual(cancelling, frozen);
  assert.equal(Object.isFrozen(cancelling), false, 'A fresh copy of the snapshot, not the snapshot itself');
  assert.deepEqual({ ...cancelling }, { ca: 'CA TEXT', cert: 'CERT TEXT', key: SECRET });

  // Options are captured before the first await, so later caller changes reach nothing.
  const caller = { cert: 'CERT TEXT', key: SECRET };
  const later = reset();
  const attempt = open({ ssl: caller });
  caller.cert = 'changed'; caller.key = 'changed'; caller.ca = 'changed';
  await (await attempt).close();
  assert.deepEqual([later.configs[0].ssl.cert, later.configs[0].ssl.key, later.configs[0].ssl.ca], ['CERT TEXT', SECRET, undefined]);
  assert.deepEqual(Object.keys(caller).sort(), ['ca', 'cert', 'key']);

  // Boolean and absent TLS are passed through as they are.
  const plainTls = reset();
  await (await open({ ssl: true })).close();
  assert.equal(plainTls.configs[0].ssl, true);
  const noTls = reset();
  await (await open()).close();
  assert.equal(noTls.configs[0].ssl, false);
});

test('peer resolution: a missing, wrong, broken or unexpected client is refused with a constant error', async () => {
  reset();
  const missing = await load(consumer(null), 'adapters/pg.js');
  await assert.rejects(missing.openPgExecutor(BASE), error => { assert.equal(error.code, 'DRIVER_UNAVAILABLE'); assert.match(error.message, /pg 8\.23\.1/); return true; });
  for (const version of ['8.23.0', '8.23.2', '9.0.0', '8.23.1-beta.1', '']) {
    const wrong = await load(consumer(version), 'adapters/pg.js');
    await assert.rejects(wrong.openPgExecutor(BASE), error => { assert.equal(error.code, version ? 'DRIVER_VERSION' : 'DRIVER_UNAVAILABLE', version); return true; });
  }
  const broken = await load(consumer('8.23.1', "throw new Error('" + SECRET + "');"), 'adapters/pg.js');
  await assert.rejects(broken.openPgExecutor(BASE), error => { assert.equal(error.code, 'DRIVER_UNAVAILABLE'); leakFree(error); return true; });
  const shape = await load(consumer('8.23.1', 'export default { Client: 1 };'), 'adapters/pg.js');
  await assert.rejects(shape.openPgExecutor(BASE), code('DRIVER_UNAVAILABLE'));
});

test('the SQLite entry works with no peer, and declarations reference no optional client', async () => {
  const root = consumer(null);
  const { openDatabase, column, defineTable } = await load(root, 'index.js');
  const notes = defineTable('notes', { id: column.integer().primaryKey({ generated: true }), body: column.text() });
  const db = openDatabase(':memory:', { tables: [notes] }); db.ensureSchema();
  assert.equal(db.table(notes).insert({ body: 'fictional' }).body, 'fictional');
  db.close();
  const adapters = join(root, 'dist/adapters');
  for (const name of readdirSync(adapters)) {
    if (name.endsWith('.d.ts')) assert.doesNotMatch(readFileSync(join(adapters, name), 'utf8'), /from ['"](?:pg|@electric-sql\/pglite)['"]|import\(['"](?:pg|@electric-sql)/, name);
    if (name.endsWith('.js')) assert.doesNotMatch(readFileSync(join(adapters, name), 'utf8'), /^\s*import\s[^(]*from ['"](?:pg|@electric-sql)/m, name);
  }
  assert.doesNotMatch(readFileSync(join(root, 'dist/index.js'), 'utf8'), /adapters\/|from ['"]pg['"]/);
});

test('one exact exchange returns a branded raw result: exact tag, wide count, duplicate names, no driver parsing', async () => {
  const fake = reset();
  let answers = [];
  fake.next = (socket, config) => answers.shift()(socket, config);
  const executor = await open();
  answers = [socket => respond(socket, 'SELECT 1', 'I', [['9223372036854775807', null]], [{ name: 'a', dataTypeID: 20, format: 'text' }, { name: 'a', dataTypeID: 0xfffffff0, format: 'text' }])];
  const result = await executor.all('SELECT fictional', [1n, null, -0, 1.5, 'x']);
  assert.ok(isPostgresRawResult(result));
  assert.deepEqual([result.command, result.rowCount, result.fields, result.rows], ['SELECT', 1n, [{ name: 'a', typeOid: 20 }, { name: 'a', typeOid: 0xfffffff0 }], [['9223372036854775807', null]]]);
  const query = fake.queries.at(-1);
  assert.deepEqual(query.values, ['1', null, '-0', '1.5', 'x']);
  assert.equal(query.queryMode, 'extended');
  assert.equal(query.rowMode, 'array');
  assert.equal(query.types.getTypeParser(20, 'text')('9007199254740993'), '9007199254740993');
  answers = [socket => respond(socket, 'UPDATE 9007199254740993')];
  assert.equal((await executor.all('UPDATE fictional', [])).rowCount, 9007199254740993n);
  answers = [socket => respond(socket, 'BEGIN', 'T')];
  await executor.exec('BEGIN READ ONLY');
  assert.equal(await executor.inTransaction(), true);
  answers = [socket => reject(socket, '22012', { status: 'E' })];
  await assert.rejects(executor.all('SELECT 1/0', []), error => { assert.ok(isAcknowledgedRejection(error)); leakFree(error); return true; });
  answers = [socket => respond(socket, 'ROLLBACK')];
  await executor.exec('ROLLBACK');
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
  assert.equal(fake.ended, 1);
});

test('only an ErrorResponse followed by ReadyForQuery is a rejection, and an implicit commit failure stays held to its list', async () => {
  const fake = reset();
  let answer;
  fake.next = socket => answer(socket);
  const executor = await open();
  answer = socket => reject(socket, '23505');
  await assert.rejects(executor.all('INSERT fictional', []), error => { assert.equal(error.code, 'CONSTRAINT'); assert.ok(isAcknowledgedRejection(error)); return true; });
  answer = socket => reject(socket, '23505', { tag: 'INSERT 0 1' });
  await assert.rejects(executor.all('INSERT fictional', []), error => { assert.equal(error.code, 'CONSTRAINT'); assert.ok(isAcknowledgedRejection(error)); return true; });
  answer = socket => reject(socket, '53100', { tag: 'INSERT 0 1' });
  await assert.rejects(executor.all('INSERT fictional', []), error => { assert.ok(!isAcknowledgedRejection(error)); leakFree(error); return true; });
  await assert.rejects(executor.all('SELECT 1', []), error => !isAcknowledgedRejection(error));
  await executor.close();
});

test('an abnormal exchange is never a result or a rejection, and the connection stays poisoned', async () => {
  const { DatabaseError } = await import(pathToFileURL(join(main, 'node_modules/pg/index.js')).href);
  const scenarios = {
    noTag: socket => { socket.emit('readyForQuery', { status: 'I' }); return Promise.resolve({ fields: [], rows: [] }); },
    twoTags: socket => { socket.emit('commandComplete', { text: 'SELECT 0' }); return respond(socket, 'SELECT 0'); },
    noReady: () => Promise.resolve({ fields: [], rows: [] }),
    twoReady: socket => { socket.emit('commandComplete', { text: 'SELECT 0' }); socket.emit('readyForQuery', { status: 'I' }); socket.emit('readyForQuery', { status: 'I' }); return Promise.resolve({ fields: [], rows: [] }); },
    invalidStatus: socket => { socket.emit('commandComplete', { text: 'SELECT 0' }); socket.emit('readyForQuery', { status: 'X' }); return Promise.resolve({ fields: [], rows: [] }); },
    multipleResults: socket => { socket.emit('commandComplete', { text: 'SELECT 0' }); socket.emit('readyForQuery', { status: 'I' }); return Promise.resolve([{ fields: [], rows: [] }]); },
    malformedTag: socket => respond(socket, 'select 1'),
    tagMismatch: socket => respond(socket, 'SELECT 2', 'I', [['1']], [{ name: 'a', dataTypeID: 25 }]),
    zeroOid: socket => respond(socket, 'SELECT 0', 'I', [], [{ name: 'a', dataTypeID: 0 }]),
    binaryFormat: (socket, config) => { config.types.getTypeParser(20, 'binary'); return respond(socket, 'SELECT 0'); },
    socketError: () => Promise.reject(new Error(SECRET)),
    errorThenEnd: socket => { socket.emit('errorMessage', {}); queueMicrotask(() => socket.emit('end')); return Promise.reject(new DatabaseError('57P01')); },
    errorTwice: socket => { socket.emit('errorMessage', {}); socket.emit('errorMessage', {}); queueMicrotask(() => socket.emit('readyForQuery', { status: 'I' })); return Promise.reject(new DatabaseError('42601')); },
    tagAfterError: socket => { socket.emit('errorMessage', {}); socket.emit('commandComplete', { text: 'SELECT 0' }); queueMicrotask(() => socket.emit('readyForQuery', { status: 'I' })); return Promise.reject(new DatabaseError('42601')); },
    errorWithoutCode: socket => { socket.emit('errorMessage', {}); queueMicrotask(() => socket.emit('readyForQuery', { status: 'I' })); return Promise.reject(Object.assign(new DatabaseError('42601'), { code: undefined })); },
    errorThenTwoReady: socket => { socket.emit('errorMessage', {}); socket.emit('readyForQuery', { status: 'I' }); socket.emit('readyForQuery', { status: 'I' }); return Promise.reject(new DatabaseError('42601')); },
    unresolvedState: socket => reject(socket, '40003'),
    wrongStatusAfterRejection: socket => reject(socket, '42601', { status: 'T' }),
    encodingChanged: socket => { socket.emit('parameterStatus', { parameterName: 'client_encoding', parameterValue: 'LATIN1' }); return respond(socket, 'SELECT 0'); },
  };
  for (const [name, script] of Object.entries(scenarios)) {
    const fake = reset(); fake.next = script;
    const executor = await open({ requestTimeoutMs: 200 });
    await assert.rejects(executor.all('SELECT fictional', []), error => { assert.ok(!isAcknowledgedRejection(error), name); leakFree(error); return true; }, name);
    fake.next = socket => respond(socket, 'SELECT 0');
    await assert.rejects(executor.all('SELECT 1', []), error => !isAcknowledgedRejection(error), name + ' stays poisoned');
    await executor.close();
  }
  // Between requests nothing is expected, so anything that arrives ends the connection.
  for (const [name, emit] of Object.entries({
    tag: socket => socket.emit('commandComplete', { text: 'SELECT 0' }), ready: socket => socket.emit('readyForQuery', { status: 'I' }),
    encoding: socket => socket.emit('parameterStatus', { parameterName: 'client_encoding', parameterValue: 'SQL_ASCII' }), end: socket => socket.emit('end'),
  })) {
    const fake = reset(); fake.next = socket => respond(socket, 'SELECT 0');
    const executor = await open();
    emit(fake.clients[0].connection);
    await assert.rejects(executor.all('SELECT 1', []), error => !isAcknowledgedRejection(error), name);
    await executor.close();
  }
  // Ordinary session noise does not.
  const fake = reset(); fake.next = socket => respond(socket, 'SELECT 0');
  const executor = await open();
  fake.clients[0].connection.emit('parameterStatus', { parameterName: 'TimeZone', parameterValue: 'UTC' });
  await executor.all('SELECT 1', []);
  await executor.close();
});

test('a client deadline poisons and closes, asks for a cancel, and claims nothing about the server', async () => {
  const fake = reset(); fake.next = () => new Promise(() => {});
  const executor = await open({ requestTimeoutMs: 40, closeTimeoutMs: 3000 });
  const started = Date.now();
  await assert.rejects(executor.all('SELECT fictional', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); assert.ok(!isAcknowledgedRejection(error)); assert.doesNotMatch(error.message, /stopped|cancel/i); return true; });
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(executor.all('SELECT 1', []), error => !isAcknowledgedRejection(error));
  await executor.close();
  assert.deepEqual(fake.cancels, [[4242, 77]]);
  assert.deepEqual(fake.cancelTargets, [[5432, 'localhost']]);
  assert.equal(fake.ended, 1, 'One close for the deadline and the later caller');
  // Cancel over TLS negotiates first, so the key does not cross the wire in clear text.
  const secure = reset(); secure.next = () => new Promise(() => {});
  const tls = await open({ ssl: true, requestTimeoutMs: 20 });
  await assert.rejects(tls.all('SELECT fictional', []), code('DRIVER_TIMEOUT'));
  await tls.close();
  assert.equal(secure.sslRequests, 1);
  assert.deepEqual(secure.cancels, [[4242, 77]]);
  // No active request: an orderly close, no cancel.
  const idle = reset();
  await (await open()).close();
  assert.deepEqual(idle.cancels, []);
  // A hung close is bounded and abandoned, and reported as unconfirmed.
  const hung = reset();
  const stuck = await open({ closeTimeoutMs: 20 });
  hung.clients[0].end = () => new Promise(() => {});
  await assert.rejects(stuck.close(), error => { assert.equal(error.code, 'CLOSE_UNCONFIRMED'); leakFree(error); return true; });
  assert.equal(hung.destroyed, 1);
});

test('overlapping requests on one connection are refused as unknown, never queued inside the driver', async () => {
  const fake = reset(); let release;
  fake.next = socket => new Promise(ok => { release = () => ok(respond(socket, 'SELECT 0')); });
  const executor = await open({ requestTimeoutMs: 1000 });
  const first = executor.all('SELECT first', []);
  await new Promise(ok => setTimeout(ok, 5));
  const sent = fake.queries.length;
  await assert.rejects(executor.all('SELECT second', []), error => !isAcknowledgedRejection(error));
  assert.equal(fake.queries.length, sent, 'The second statement was not sent');
  release();
  await assert.rejects(first, error => !isAcknowledgedRejection(error));
  await executor.close();
});

test('a deadline releases the connection by itself, without the caller closing', async () => {
  const fake = reset(); fake.next = () => new Promise(() => {});
  const executor = await open({ requestTimeoutMs: 30 });
  await assert.rejects(executor.all('SELECT fictional', []), code('DRIVER_TIMEOUT'));
  for (let i = 0; i < 200 && !fake.ended; i++) await new Promise(ok => setTimeout(ok, 15));
  assert.equal(fake.ended, 1, 'The connection was ended with no close call');
  assert.deepEqual(fake.cancels, [[4242, 77]]);
  // A rejection that is not a deadline does not close on its own: the session decides what comes next.
  const other = reset(); other.next = socket => reject(socket, '23505');
  const open2 = await open();
  await assert.rejects(open2.all('INSERT fictional', []), code('CONSTRAINT'));
  await new Promise(ok => setTimeout(ok, 30));
  assert.equal(other.ended, 0);
  await open2.close();
  assert.equal(other.ended, 1);
});

test('an unsupported Node version is refused before options or peers are used', async () => {
  const actual = Object.getOwnPropertyDescriptor(process, 'versions');
  const fake = reset();
  Object.defineProperty(process, 'versions', { ...actual, value: { ...process.versions, node: '22.0.0' } });
  try {
    await assert.rejects(open(), code('UNSUPPORTED_RUNTIME'));
    await assert.rejects(openPgExecutor(null), code('UNSUPPORTED_RUNTIME'));
  } finally { Object.defineProperty(process, 'versions', actual); }
  assert.deepEqual(fake.configs, []);
});

test('the executor surface stays narrow and refuses non-control exec or malformed calls', async () => {
  const fake = reset(); fake.next = socket => respond(socket, 'SELECT 0');
  const executor = await open();
  assert.ok(Object.isFrozen(executor));
  assert.deepEqual(Object.keys(executor).sort(), ['all', 'close', 'exec', 'inTransaction']);
  await assert.rejects(executor.exec('DROP TABLE fictional'), code('VALIDATION'));
  await assert.rejects(executor.all('SELECT 1', [{}]), code('VALIDATION'));
  await assert.rejects(executor.all('', []), code('VALIDATION'));
  await executor.close();
  await executor.close();
  await assert.rejects(executor.all('SELECT 1', []), code('CLOSED'));
});
