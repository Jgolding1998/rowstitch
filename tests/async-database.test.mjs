import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as sdk from '../dist/index.js';
import { openAsyncDatabaseWithExecutor } from '../dist/core/async-database.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';
import { acknowledgedRejection, inlineAsyncExecutor } from '../dist/core/executor.js';

const { column, defineTable, openDatabase, openAsyncDatabase, AsyncDatabase, AsyncRepository, agg, hasMany, belongsTo, eq, gt, asc, desc, some, countRelated, inArray } = sdk;
const code = expected => error => error?.code === expected;
const MAX = 2n ** 63n - 1n;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? { bigint: String(v) } : v));
const outcome = async fn => { try { return { ok: plain(await fn()) }; } catch (error) { return { code: error?.code, message: error?.message, name: error?.name }; } };

const owners = defineTable('adb_owners', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable(), version: column.integer().default(0), settings: column.json().nullable(), active: column.boolean().default(true) }, { version: 'version' });
const items = defineTable('adb_items', { id: column.integer().primaryKey(), ownerId: column.integer().references(owners, 'id'), amount: column.bigint(), label: column.text(), qty: column.integer().nullable() });
const tables = [owners, items];
const ownerItems = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId') });

/** Temporary files; every registered handle closes before its file is removed (Windows keeps open files locked). */
function files(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-async-db-'));
  const handles = [], made = [];
  t.after(async () => {
    for (const handle of handles.reverse()) { try { await handle.close(); } catch { /* already reported by the test */ } }
    for (const file of made) for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    rmdirSync(directory);
  });
  return { file(name) { const f = join(directory, name + '.sqlite'); made.push(f); return f; }, own(handle) { handles.push(handle); return handle; } };
}

/** Deterministic executor over a real SQLite connection: holds pause chosen requests; faults replace outcomes. */
function controlled(file) {
  const sync = openSqliteExecutor(file);
  const log = [], holds = [], faults = [], state = { closes: 0 };
  async function step(text, run) {
    log.push(text);
    await Promise.resolve();
    const hold = holds.find(h => !h.used && h.match.test(text));
    if (hold) { hold.used = true; hold.reached.resolve(); await hold.gate.promise; }
    const fault = faults.find(f => !f.used && f.match.test(text));
    if (fault) { fault.used = true; if (fault.apply) run(); throw fault.mode === 'ack' ? acknowledgedRejection({ errcode: 5 }) : new Error('synthetic lost response'); }
    try { return run(); } catch (error) { throw acknowledgedRejection(error); }
  }
  return {
    log, state,
    executor: { all: (sql, p) => step(sql, () => sync.all(sql, p)), exec: sql => step(sql, () => sync.exec(sql)),
      inTransaction: () => step('state', () => sync.inTransaction()), close: () => step('close', () => { state.closes++; sync.close(); }) },
    hold(match) { const h = { match, used: false, reached: deferred(), gate: deferred() }; holds.push(h); return { reached: h.reached.promise, release: () => h.gate.resolve() }; },
    fault(match, mode, apply = false) { faults.push({ match, mode, apply, used: false }); },
  };
}

/** One script, run unchanged against the synchronous and asynchronous APIs (await is a no-op on sync results). */
async function scenario(db) {
  const out = {};
  out.ensure = await outcome(() => db.ensureSchema());
  out.planAfter = await outcome(() => db.planSchema());
  out.insert = await outcome(() => db.table(owners).insert({ id: 1, name: 'Ada', region: 'north', settings: { theme: 'dark', n: [1, 2] } }));
  out.insertMany = await outcome(() => db.table(owners).insertMany([{ id: 2, name: 'Bo', region: 'north', active: false }, { id: 3, name: 'Cy', region: null }]));
  out.items = await outcome(() => db.table(items).insertMany([{ id: 1, ownerId: 1, amount: MAX, label: 'max', qty: 1 }, { id: 2, ownerId: 1, amount: MAX, label: 'max2', qty: null },
    { id: 3, ownerId: 2, amount: -7n, label: "SYNTHETIC_' OR 1=1 --", qty: 3 }]));
  out.duplicate = await outcome(() => db.table(owners).insert({ id: 1, name: 'dup' }));
  out.unknownColumn = await outcome(() => db.table(owners).insert({ id: 9, name: 'x', nope: 1 }));
  out.missingRequired = await outcome(() => db.table(owners).insert({ id: 9 }));
  out.tooMany = await outcome(() => db.table(owners).insertMany(new Array(1001).fill({ id: 1, name: 'x' })));
  out.find = await outcome(() => db.table(owners).findMany({ select: ['name', 'settings'], orderBy: [asc(owners.col('id'))],
    include: { items: hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId'), select: ['label', 'amount'], orderBy: [desc(items.col('id'))], limit: 1 }) },
    aggregates: { n: agg.related(ownerItems, agg.count()), total: agg.related(ownerItems, agg.sum(items.col('amount'))), avgQty: agg.related(ownerItems, agg.avg(items.col('qty'))) } }));
  out.singular = await outcome(() => db.table(items).findMany({ select: ['label'], include: { owner: belongsTo(owners, { localKey: items.col('ownerId'), foreignKey: owners.col('id'), select: ['name'] }) }, orderBy: [asc(items.col('id'))] }));
  out.first = await outcome(() => db.table(owners).findFirst({ where: eq(owners.col('name'), 'Bo') }));
  out.none = await outcome(() => db.table(owners).findFirst({ where: eq(owners.col('name'), 'nobody') }));
  out.count = await outcome(() => db.table(owners).count(countRelated(ownerItems, '>=', 2)));
  out.someCount = await outcome(() => db.table(owners).count(some(ownerItems, gt(items.col('amount'), 0n))));
  out.aggregate = await outcome(() => db.table(items).aggregate({ select: { n: agg.count(), total: agg.sum(items.col('amount')), low: agg.min(items.col('label')), qty: agg.avg(items.col('qty')) } }));
  out.groupBy = await outcome(() => db.table(owners).groupBy({ by: ['region'], select: { owners: agg.count(), items: agg.related(ownerItems, agg.count()), total: agg.related(ownerItems, agg.sum(items.col('amount'))) }, orderBy: [{ field: 'total', direction: 'desc' }] }));
  out.compileSelect = await outcome(() => db.table(owners).compileSelect({ where: inArray(owners.col('id'), [1, 2]), select: ['name'] }));
  out.compileAggregate = await outcome(() => db.table(items).compileAggregate({ select: { total: agg.sum(items.col('amount')) } }));
  out.compileGroupBy = await outcome(() => db.table(owners).compileGroupBy({ by: ['region'], select: { n: agg.count() } }));
  out.explain = await outcome(async () => (await db.table(owners).explain({ where: eq(owners.col('id'), 1) })).map(step => step.detail));
  out.explainAggregate = await outcome(async () => (await db.table(items).explainAggregate({ select: { n: agg.count() } })).length > 0);
  out.explainGroupBy = await outcome(async () => (await db.table(owners).explainGroupBy({ by: ['region'], select: { n: agg.count() } })).length > 0);
  out.unsafeWide = await outcome(() => db.table(owners).update({ name: 'wrong' }, { where: gt(owners.col('id'), 0), maxRows: 1 }));
  out.unsafeNoFilter = await outcome(() => db.table(owners).delete({}));
  out.unsafeRelation = await outcome(() => db.table(owners).delete({ where: some(ownerItems, gt(items.col('amount'), 0n)) }));
  out.update = await outcome(() => db.table(owners).update({ name: 'Ada 2' }, { where: eq(owners.col('id'), 1), maxRows: 1 }));
  out.versioned = await outcome(() => db.table(owners).updateVersion({ id: 1 }, 1, { region: 'south' }));
  out.stale = await outcome(() => db.table(owners).updateVersion({ id: 1 }, 1, { region: 'east' }));
  out.badVersion = await outcome(() => db.table(owners).updateVersion({ id: 1 }, -1, { region: 'east' }));
  out.delete = await outcome(() => db.table(items).delete({ where: eq(items.col('id'), 3) }));
  out.fkViolation = await outcome(() => db.table(owners).delete({ where: eq(owners.col('id'), 1) }));
  out.unregistered = await outcome(() => db.table(defineTable('adb_stray', { id: column.integer().primaryKey() })));
  out.inspect = await outcome(() => db.inspectSchema());
  out.trace = (await db.exportTrace({ title: 'parity' })).queries.map(({ durationMs, ...entry }) => entry);
  return out;
}

test('public exports add only the async database API; no executor, session, inline adapter or raw SQL', async () => {
  for (const name of ['openAsyncDatabase', 'AsyncDatabase', 'AsyncRepository']) assert.equal(typeof sdk[name], 'function');
  for (const name of ['openAsyncDatabaseWithExecutor', 'createAsyncSession', 'inlineAsyncExecutor', 'openWorkerSqliteExecutor', 'openSqliteExecutor', 'RepositoryCore', 'runAsync'])
    assert.equal(name in sdk, false);
  assert.throws(() => new AsyncDatabase(Symbol('forged')), code('VALIDATION'));
  assert.throws(() => new AsyncRepository(Symbol('forged'), {}, owners), code('VALIDATION'));
});

test('open validation matches openDatabase exactly and adds bounded async limits; all failures reject', async t => {
  const f = files(t);
  const cases = [[':memory:', { busyTimeoutMs: null }], [':memory:', { busyTimeoutMs: 10_001 }], [':memory:', { readOnly: 'true' }], [':memory:', { traceValues: 1 }],
    [':memory:', { unknown: true }], [':memory:', { maxTraceEntries: 0 }], [':memory:', { tables: [{}] }], [':memory:', { tables: [owners, owners] }], ['', {}], ['x\0y', {}], [12, {}]];
  for (const [filename, options] of cases) {
    const sync = await outcome(() => openDatabase(filename, options));
    let pending;
    assert.doesNotThrow(() => { pending = openAsyncDatabase(filename, options); });
    const asyncResult = await outcome(() => pending);
    assert.deepEqual(asyncResult, sync, JSON.stringify(options));
  }
  for (const options of [{ maxQueue: 0 }, { maxQueue: 1025 }, { maxPending: 0 }, { queueTimeoutMs: 60_001 }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 120_001 }, { requestTimeoutMs: 1.5 }])
    await assert.rejects(openAsyncDatabase(':memory:', options), code('QUERY'));
  await assert.rejects(openAsyncDatabase(join(f.file('missing'), 'nope.sqlite'), { readOnly: true }), error => error.code === 'OPEN' && !error.message.includes('nope'));
  const db = f.own(await openAsyncDatabase(':memory:', { maxQueue: 1, maxPending: 1, queueTimeoutMs: 1, requestTimeoutMs: 120_000 }));
  assert.deepEqual(await db.inspectSchema(), []);
});

test('the same script gives identical results, errors and full traces through the sync and async APIs', async t => {
  const f = files(t);
  const sync = f.own(openDatabase(f.file('sync'), { tables, traceValues: true }));
  const asyncDb = f.own(await openAsyncDatabase(f.file('async'), { tables, traceValues: true }));
  const expected = await scenario(sync);
  const actual = await scenario(asyncDb);
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], key);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  // Spot checks that the script exercised what it claims.
  assert.equal(expected.duplicate.code, 'CONSTRAINT');
  assert.equal(expected.unsafeWide.code, 'AFFECTED_ROWS');
  // The maxRows guard refuses before writing: that transaction sends a count and a rollback, never an UPDATE.
  assert.equal(expected.unsafeWide.message, 'The filter matches more records than maxRows allows. No records were changed.');
  const wideTx = expected.trace.find(q => q.operation === 'select' && q.sql.startsWith('SELECT count(*)') && q.parameters[0] === 0)?.transactionId;
  assert.ok(wideTx && !expected.trace.some(q => q.transactionId === wideTx && q.operation === 'update'));
  assert.equal(expected.unsafeRelation.code, 'UNSAFE_WRITE');
  assert.equal(expected.stale.code, 'CONFLICT');
  assert.equal(expected.fkViolation.code, 'CONSTRAINT');
  assert.deepEqual(expected.find.ok[0].total, { bigint: String(2n * MAX) });
  assert.ok(expected.trace.length > 30 && expected.trace.some(q => q.status === 'error'));
  assert.deepEqual([...new Set(expected.trace.map(q => q.transactionId))].slice(0, 3), ['tx1', 'tx2', 'tx3']);
});

test('async writes are durable after reopen and readable by the synchronous API; bigint, JSON, boolean and NULL decode exactly', async t => {
  const f = files(t), file = f.file('durable');
  const db = await openAsyncDatabase(file, { tables });
  await db.ensureSchema();
  await db.table(owners).insert({ id: 1, name: 'Ada', settings: { nested: { list: [1, 'two', null] } } });
  await db.table(items).insert({ id: 1, ownerId: 1, amount: MAX, label: 'max', qty: null });
  await db.close();
  await db.close();
  const reader = openDatabase(file, { tables, readOnly: true });
  try {
    assert.deepEqual(reader.table(owners).findFirst(), { id: 1, name: 'Ada', region: null, version: 0, settings: { nested: { list: [1, 'two', null] } }, active: true });
    assert.deepEqual(reader.table(items).findFirst(), { id: 1, ownerId: 1, amount: MAX, label: 'max', qty: null });
  } finally { reader.close(); }
  const ro = f.own(await openAsyncDatabase(file, { tables, readOnly: true }));
  assert.equal((await ro.table(items).findFirst()).amount, MAX);
  await assert.rejects(ro.table(owners).insert({ id: 2, name: 'no' }), code('READ_ONLY'));
  await assert.rejects(ro.ensureSchema(), code('READ_ONLY'));
  assert.equal(await ro.transaction(tx => tx.table(owners).count()), 1);
  assert.deepEqual(ro.exportTrace().queries.filter(q => q.operation === 'transaction').map(q => q.sql), ['BEGIN', 'COMMIT']);
});

test('async and sync callbacks commit, failures roll back with the original error, nested savepoints keep parent work', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('tx'), { tables }));
  await db.ensureSchema();
  assert.equal(await db.transaction(async tx => (await tx.table(owners).insert({ id: 1, name: 'Ada' })).name), 'Ada');
  assert.equal(await db.transaction(() => 'sync value'), 'sync value');
  const original = new TypeError('synthetic');
  await assert.rejects(db.transaction(async tx => { await tx.table(owners).insert({ id: 2, name: 'Bo' }); throw original; }), error => error === original);
  await db.transaction(async tx => {
    await tx.table(owners).insert({ id: 3, name: 'Cy' });
    await assert.rejects(tx.transaction(async inner => { await inner.table(owners).insert({ id: 4, name: 'Di' }); throw new Error('inner'); }), /inner/);
    await tx.transaction(inner => inner.table(owners).insert({ id: 5, name: 'Ed' }));
  });
  assert.deepEqual((await db.table(owners).findMany({ select: ['id'] })).map(r => r.id), [1, 3, 5]);
  const trace = db.exportTrace().queries;
  const nested = trace.filter(q => /SAVEPOINT/.test(q.sql));
  assert.ok(nested.length >= 4 && nested.every(q => /^tx\d+$/.test(q.transactionId)));
  assert.ok(trace.some(q => q.sql.startsWith('ROLLBACK TO SAVEPOINT') && q.status === 'ok'));
});

test('root handles inside a transaction are refused without deadlock; outside root work waits and never joins it', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('ctx'), { tables }));
  await db.ensureSchema();
  await db.table(owners).insert({ id: 1, name: 'Ada' });
  const entered = deferred(), release = deferred();
  const tx = db.transaction(async inner => {
    await assert.rejects(db.table(owners).count(), code('TRANSACTION_ACTIVE'));
    await assert.rejects(db.transaction(() => 1), code('TRANSACTION_ACTIVE'));
    await inner.table(owners).update({ name: 'inside' }, { where: eq(owners.col('id'), 1) });
    entered.resolve(); await release.promise;
    throw new Error('rollback');
  });
  await entered.promise;
  const outside = db.table(owners).insert({ id: 2, name: 'outside' });
  const read = db.table(owners).findMany({ select: ['name'] });
  await turn();
  release.resolve();
  await assert.rejects(tx, /rollback/);
  await outside;
  assert.deepEqual((await read).map(r => r.name), ['Ada', 'outside']);
  const trace = db.exportTrace().queries;
  const insert = trace.find(q => q.operation === 'insert' && q.transactionId !== null && trace.indexOf(q) > trace.findIndex(x => x.sql === 'ROLLBACK'));
  assert.ok(insert, 'the outside insert ran in its own transaction after the rollback');
  assert.ok(trace.filter(q => q.operation === 'select' && q.transactionId === null).length >= 1);
});

test('escaped transaction handles and repositories are refused for I/O and planning', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('escape'), { tables }));
  await db.ensureSchema();
  let escapedDb, escapedRepo, lateWrite;
  await db.transaction(async tx => {
    escapedDb = tx; escapedRepo = tx.table(owners);
    lateWrite = new Promise(resolve => setTimeout(() => resolve(escapedRepo.insert({ id: 9, name: 'late' })), 20));
  });
  await assert.rejects(lateWrite, code('TRANSACTION_CLOSED'));
  await assert.rejects(escapedRepo.findMany(), code('TRANSACTION_CLOSED'));
  await assert.rejects(escapedRepo.insert({ id: 8, name: 'x' }), code('TRANSACTION_CLOSED'));
  assert.throws(() => escapedRepo.compileSelect(), code('TRANSACTION_CLOSED'));
  assert.throws(() => escapedDb.table(owners), code('TRANSACTION_CLOSED'));
  await assert.rejects(escapedDb.transaction(() => 1), code('TRANSACTION_CLOSED'));
  await assert.rejects(escapedDb.close(), code('TRANSACTION_ACTIVE'));
  assert.equal(await db.table(owners).count(), 0);
});

test('concurrent writes inside one transaction are refused (one nested write at a time); concurrent reads are fine', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('concurrent'), { tables }));
  await db.ensureSchema();
  await db.transaction(async tx => {
    const [a, b] = await Promise.allSettled([tx.table(owners).insert({ id: 1, name: 'a' }), tx.table(owners).insert({ id: 2, name: 'b' })]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.reason?.code, 'TRANSACTION_NESTED_ACTIVE');
    const [x, y] = await Promise.all([tx.table(owners).count(), tx.table(owners).findMany({ select: ['name'] })]);
    assert.equal(x, 1); assert.deepEqual(y, [{ name: 'a' }]);
  });
  // Root writes from outside contexts are queued FIFO, each in its own transaction.
  await Promise.all([db.table(owners).insert({ id: 3, name: 'c' }), db.table(owners).insert({ id: 4, name: 'd' }), db.table(owners).insertMany([{ id: 5, name: 'e' }])]);
  assert.deepEqual((await db.table(owners).findMany({ select: ['id'] })).map(r => r.id), [1, 3, 4, 5]);
});

test('pending work at callback settlement is drained and rolled back (deterministic controlled executor)', async t => {
  const f = files(t), file = f.file('pending');
  { const setup = openDatabase(file, { tables }); setup.ensureSchema(); setup.close(); }
  const c = controlled(file);
  const db = f.own(await openAsyncDatabaseWithExecutor(c.executor, { tables }));
  const hold = c.hold(/^INSERT/);
  // The callback starts a write, waits until it has been sent, then returns without awaiting it.
  const result = db.transaction(async tx => { tx.table(owners).insert({ id: 1, name: 'unawaited' }).catch(() => {}); await hold.reached; });
  const settled = assert.rejects(result, code('TRANSACTION_PENDING'));
  await hold.reached; await turn(); await turn();
  assert.equal(c.log.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length, 0, 'nothing is decided while the write is in flight');
  hold.release();
  await settled;
  assert.equal(await db.table(owners).count(), 0);
  assert.equal(c.log.filter(sql => sql === 'COMMIT').length, 0, 'never committed after draining');
  assert.ok(c.log.includes('ROLLBACK'));
});

test('cancellation: an aborted transaction rolls back; a pre-aborted signal sends no SQL', async t => {
  const f = files(t), file = f.file('abort');
  { const setup = openDatabase(file, { tables }); setup.ensureSchema(); setup.close(); }
  const c = controlled(file);
  const db = f.own(await openAsyncDatabaseWithExecutor(c.executor, { tables }));
  const before = c.log.length;
  await assert.rejects(db.transaction(() => 1, { signal: AbortSignal.abort() }), code('ABORTED'));
  assert.equal(c.log.length, before);
  const controller = new AbortController(), hold = c.hold(/^INSERT/);
  const tx = db.transaction(async inner => { await inner.table(owners).insert({ id: 1, name: 'aborted' }); await new Promise(() => {}); }, { signal: controller.signal });
  await hold.reached; controller.abort(); hold.release();
  await assert.rejects(tx, code('ABORTED'));
  assert.equal(await db.table(owners).count(), 0);
});

test('unconfirmed COMMIT: no rollback inferred, connection closed once, conservative v2 trace with explicit notes, durable effect visible', async t => {
  const f = files(t), file = f.file('unknown');
  { const setup = openDatabase(file, { tables }); setup.ensureSchema(); setup.close(); }
  const c = controlled(file);
  const db = f.own(await openAsyncDatabaseWithExecutor(c.executor, { tables, traceValues: true }));
  c.fault(/^COMMIT$/, 'lost', true);
  let calls = 0;
  await assert.rejects(db.table(owners).insert({ id: 1, name: 'maybe' }).finally(() => { calls++; }), code('COMMIT_UNCONFIRMED'));
  assert.equal(calls, 1);
  assert.ok(!c.log.includes('ROLLBACK'));
  await assert.rejects(db.table(owners).count(), code('CONNECTION_UNUSABLE'));
  const trace = db.exportTrace();
  const tail = trace.queries.slice(-3).map(q => [q.operation, q.sql.split(' ')[0], q.status, q.transactionId]);
  assert.deepEqual(tail, [['transaction', 'BEGIN', 'ok', 'tx1'], ['insert', 'INSERT', 'ok', 'tx1'], ['transaction', 'COMMIT', 'error', 'tx1']]);
  assert.ok(trace.notes.some(note => /unknown outcome/.test(note)) && trace.notes.some(note => /1 request\(s\).*unconfirmed/.test(note)));
  assert.equal(trace.version, 2);
  for (const q of trace.queries) assert.ok(q.status === 'ok' || q.status === 'error');
  await db.close();
  assert.equal(c.state.closes, 1);
  const reader = openDatabase(file, { tables, readOnly: true });
  try { assert.equal(reader.table(owners).count(), 1, 'the COMMIT happened; nothing claimed a rollback'); } finally { reader.close(); }
});

test('trace snapshots are synchronous, bounded and redacted; compile never executes; close semantics', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('trace'), { tables, maxTraceEntries: 5 }));
  await db.ensureSchema();
  const snapshot = db.exportTrace();
  assert.deepEqual(snapshot.schema.map(s => s.name), ['adb_items', 'adb_owners']);
  db.clearTrace();
  const sentinel = "SYNTHETIC_SECRET_' OR 1=1 --";
  const compiled = db.table(owners).compileSelect({ where: eq(owners.col('name'), sentinel) });
  assert.ok(!compiled.sql.includes(sentinel) && compiled.parameters.includes(sentinel));
  assert.equal(db.exportTrace().queries.length, 0);
  for (let i = 0; i < 4; i++) await db.table(owners).insert({ id: i + 1, name: sentinel });
  const trace = db.exportTrace();
  assert.equal(trace.queries.length, 5);
  assert.ok(!JSON.stringify(trace).includes(sentinel));
  assert.ok(trace.notes.some(n => /7 entries have been omitted/.test(n)));
  const gate = deferred();
  const tx = db.transaction(async () => { await gate.promise; });
  await assert.rejects(db.close(), code('TRANSACTION_ACTIVE'));
  assert.equal(db.exportTrace().format, 'rowstitch-trace', 'export performs no I/O while a transaction holds the connection');
  gate.resolve(); await tx;
  const closing = db.close();
  await closing; await db.close();
  assert.throws(() => db.exportTrace(), code('CLOSED'));
  assert.throws(() => db.table(owners), code('CLOSED'));
  await assert.rejects(db.transaction(() => 1), code('CLOSED'));
});

test('call-time capture: nested include records, update data, JSON values, option tables and concurrent plans', async t => {
  const f = files(t), file = f.file('capture');
  const tableList = [owners, items];
  const opening = openAsyncDatabase(file, { tables: tableList });
  tableList.pop();
  const db = f.own(await opening);
  await db.ensureSchema();
  assert.equal((await db.inspectSchema()).length, 2, 'the table list was captured before the worker opened');
  await db.table(owners).insertMany([{ id: 1, name: 'Ada', settings: { v: 1 } }, { id: 2, name: 'Bo' }]);
  await db.table(items).insertMany([{ id: 1, ownerId: 1, amount: 5n, label: 'a', qty: 1 }, { id: 2, ownerId: 2, amount: 6n, label: 'b', qty: 2 }]);
  // A descriptor's nested include record is a live object; mutating it after the call must not change the result.
  const nestedInclude = {};
  const deep = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId'), select: ['label'], include: nestedInclude });
  const pending = db.table(owners).findMany({ select: ['name'], include: { items: deep }, orderBy: [asc(owners.col('id'))] });
  nestedInclude.owner = belongsTo(owners, { localKey: items.col('ownerId'), foreignKey: owners.col('id') });
  assert.deepEqual(await pending, [{ name: 'Ada', items: [{ label: 'a' }] }, { name: 'Bo', items: [{ label: 'b' }] }]);
  // Two concurrent plans on one repository keep separate snapshots.
  const repo = db.table(owners);
  const withItems = repo.findMany({ select: ['name'], include: { items: hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId'), select: ['qty'] }) }, orderBy: [asc(owners.col('id'))] });
  const plainNames = repo.findMany({ select: ['name'], orderBy: [asc(owners.col('id'))] });
  assert.deepEqual(await withItems, [{ name: 'Ada', items: [{ qty: 1 }] }, { name: 'Bo', items: [{ qty: 2 }] }]);
  assert.deepEqual(await plainNames, [{ name: 'Ada' }, { name: 'Bo' }]);
  // Update values and JSON are encoded at call time.
  const patch = { name: 'Ada 2', settings: { v: 2, list: [1] } };
  const updating = repo.update(patch, { where: eq(owners.col('id'), 1) });
  patch.name = 'changed'; patch.settings.v = 99; patch.settings.list.push(2);
  assert.deepEqual((await updating).map(r => [r.name, r.settings]), [['Ada 2', { v: 2, list: [1] }]]);
  const key = { id: 2 };
  const versioned = repo.updateVersion(key, 0, { name: 'Bo 2' });
  key.id = 1;
  assert.equal((await versioned).id, 2);
});

test('an invalid row in insertMany fails at its position with the same trace as the sync API, despite capture', async t => {
  const f = files(t);
  const sync = f.own(openDatabase(f.file('sync-many'), { tables }));
  const asyncDb = f.own(await openAsyncDatabase(f.file('async-many'), { tables }));
  const run = async db => {
    await db.ensureSchema(); db.clearTrace();
    const result = await outcome(() => db.table(owners).insertMany([{ id: 1, name: 'ok' }, { id: 2, nope: true }, { id: 3, name: 'never' }]));
    return { result, trace: db.exportTrace().queries.map(({ durationMs, ...q }) => q), count: await db.table(owners).count() };
  };
  const expected = await run(sync), actual = await run(asyncDb);
  assert.deepEqual(actual, expected);
  assert.equal(expected.result.code, 'VALIDATION');
  assert.deepEqual(expected.trace.map(q => q.sql.split(' ')[0]), ['BEGIN', 'INSERT', 'ROLLBACK']);
});

test('expired transaction contexts refuse even pure planning on the root handle, as in the sync API', async t => {
  const f = files(t);
  const sync = f.own(openDatabase(f.file('sync-ctx'), { tables }));
  const asyncDb = f.own(await openAsyncDatabase(f.file('async-ctx'), { tables }));
  const late = db => new Promise(resolve => setTimeout(() => resolve(outcome(() => db.table(owners).compileSelect())), 15));
  let syncLate, asyncLate, activeAsync;
  sync.transaction(() => { syncLate = late(sync); });
  await asyncDb.transaction(async () => { asyncLate = late(asyncDb); activeAsync = await outcome(() => asyncDb.table(owners).compileSelect()); });
  assert.equal((await syncLate).code, 'TRANSACTION_CLOSED');
  assert.deepEqual(await asyncLate, await syncLate);
  assert.ok(activeAsync.ok, 'pure planning on the root handle is allowed while the callback is active');
  assert.ok(asyncDb.table(owners).compileSelect().sql.startsWith('SELECT'), 'outside any expired context the root handle still plans');
});

// ---------------------------------------------------------------------------------------------------------------------
// Forgotten awaits under Node's DEFAULT unhandled-rejection policy. Each scenario is its own child process, with no
// .catch on the forgotten call and no process.on('unhandledRejection'). Not --input-type: workers would inherit it.
const CHILD = body => `(async () => {
  const sdk = await import(process.env.RS_INDEX);
  const { column, defineTable, hasMany, eq } = sdk;
  const owners = defineTable('adb_owners', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable(), version: column.integer().default(0), settings: column.json().nullable(), active: column.boolean().default(true) }, { version: 'version' });
  const items = defineTable('adb_items', { id: column.integer().primaryKey(), ownerId: column.integer().references(owners, 'id'), amount: column.bigint(), label: column.text(), qty: column.integer().nullable() });
  const rel = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId') });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const db = await sdk.openAsyncDatabase(process.env.RS_FILE, { tables: [owners, items] });
  const report = {};
  ${body}
  await pause(40); // Any late rejection has every chance to surface before the report.
  report.listeners = process.listenerCount('unhandledRejection');
  report.owners = await db.table(owners).count();
  await db.close();
  console.log(JSON.stringify(report));
})();`;
function childScenario(t, f, name, body) {
  const file = f.file(name);
  const setup = openDatabase(file, { tables });
  setup.ensureSchema();
  setup.table(owners).insertMany([{ id: 1, name: 'Ada' }, { id: 2, name: 'Bo' }]);
  setup.table(items).insertMany([{ id: 1, ownerId: 1, amount: 5n, label: 'a', qty: 1 }]);
  setup.close();
  const script = CHILD(body);
  assert.ok(!script.includes('.catch(') && !script.includes('process.on('), 'the child must not handle the forgotten rejection');
  const env = { ...process.env, RS_INDEX: new URL('../dist/index.js', import.meta.url).href, RS_FILE: file };
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60_000 });
  const reader = openDatabase(file, { tables, readOnly: true });
  try {
    return { status: run.status, stderr: run.stderr, report: run.status === 0 ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : null,
      names: reader.table(owners).findMany({ select: ['name'], orderBy: [asc(owners.col('id'))] }).map(row => row.name) };
  } finally { reader.close(); }
}
const OUTER = callback => `try { await db.transaction(${callback}); report.outer = 'resolved'; } catch (error) { report.outer = error.code ?? error.message; }`;
const FORGOTTEN = {
  'insert, sync callback': `tx => { tx.table(owners).insert({ id: 10, name: 'forgotten' }); }`,
  'insert, async callback': `async tx => { tx.table(owners).insert({ id: 10, name: 'forgotten' }); }`,
  'insertMany': `tx => { tx.table(owners).insertMany([{ id: 10, name: 'forgotten' }, { id: 11, name: 'forgotten' }]); }`,
  'update': `tx => { tx.table(owners).update({ name: 'forgotten' }, { where: eq(owners.col('id'), 1) }); }`,
  'delete': `tx => { tx.table(items).delete({ where: eq(items.col('id'), 1) }); }`,
  'updateVersion': `tx => { tx.table(owners).updateVersion({ id: 1 }, 0, { name: 'forgotten' }); }`,
  'nested transaction': `tx => { tx.transaction(async inner => { await inner.table(owners).insert({ id: 10, name: 'forgotten' }); }); }`,
  'a write forgotten inside a forgotten nested transaction': `tx => { tx.transaction(inner => { inner.table(owners).insert({ id: 10, name: 'forgotten' }); return pause(1000); }); }`,
  'multi-step read with an include': `tx => { tx.table(owners).findMany({ include: { items: rel } }); }`,
  'findFirst with an include': `tx => { tx.table(owners).findFirst({ include: { items: rel } }); }`,
  'ensureSchema': `tx => { tx.ensureSchema(); }`,
};
for (const [name, callback] of Object.entries(FORGOTTEN)) {
  test('default policy: forgotten ' + name + ' gives a catchable TRANSACTION_PENDING and no commit', async t => {
    const f = files(t), result = childScenario(t, f, 'forgotten', OUTER(callback));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report, { outer: 'TRANSACTION_PENDING', listeners: 0, owners: 2 });
    assert.deepEqual(result.names, ['Ada', 'Bo'], 'nothing from the forgotten work is durable');
  });
}

test('default policy: a child that forgets a write rejects alone; its parent stays usable and commits its own work', async t => {
  const f = files(t), result = childScenario(t, f, 'child-forgot', `
    await db.transaction(async tx => {
      await tx.table(owners).insert({ id: 20, name: 'parent before' });
      try { await tx.transaction(inner => { inner.table(owners).insert({ id: 21, name: 'forgotten' }); }); report.child = 'resolved'; } catch (error) { report.child = error.code; }
      await tx.table(owners).insert({ id: 22, name: 'parent after' });
    });`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report, { child: 'TRANSACTION_PENDING', listeners: 0, owners: 4 });
  assert.deepEqual(result.names, ['Ada', 'Bo', 'parent before', 'parent after']);
});

test('default policy: abort and callback failure with a forgotten write keep their own outcome and survive', async t => {
  const f = files(t);
  const aborted = childScenario(t, f, 'abort', `
    const controller = new AbortController();
    try { await db.transaction(tx => { tx.table(owners).insert({ id: 10, name: 'forgotten' }); controller.abort(); return pause(1000); }, { signal: controller.signal }); report.outer = 'resolved'; }
    catch (error) { report.outer = error.code; }`);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.deepEqual(aborted.report, { outer: 'ABORTED', listeners: 0, owners: 2 });
  const failed = childScenario(t, f, 'callback-error', OUTER(`tx => { tx.table(owners).insert({ id: 10, name: 'forgotten' }); throw new Error('callback failed'); }`));
  assert.equal(failed.status, 0, failed.stderr);
  assert.deepEqual(failed.report, { outer: 'callback failed', listeners: 0, owners: 2 });
  assert.deepEqual([aborted.names, failed.names], [['Ada', 'Bo'], ['Ada', 'Bo']]);
});

test('default policy: awaited and returned operations are unaffected', async t => {
  const f = files(t), result = childScenario(t, f, 'awaited', `
    report.value = (await db.transaction(tx => tx.table(owners).insert({ id: 10, name: 'returned' }))).name;
    report.reads = await db.transaction(tx => Promise.all([tx.table(owners).count(), tx.table(items).count()]));
    report.nested = await db.transaction(async tx => { await tx.table(owners).insert({ id: 11, name: 'awaited' }); return tx.transaction(inner => inner.table(owners).count()); });
    try { await db.transaction(async tx => { await tx.table(owners).insert({ id: 1, name: 'duplicate' }); }); } catch (error) { report.awaitedFailure = error.code; }`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report, { value: 'returned', reads: [3, 1], nested: 4, awaitedFailure: 'CONSTRAINT', listeners: 0, owners: 4 });
  assert.deepEqual(result.names, ['Ada', 'Bo', 'returned', 'awaited']);
});

test('default policy: a forgotten failure that already settled is still reported by Node, not swallowed', async t => {
  const f = files(t);
  // The write fails while the callback is still running, so nothing was invalidated when it rejected.
  const insideTransaction = childScenario(t, f, 'settled-constraint', `
    await db.transaction(async tx => { tx.table(owners).insert({ id: 1, name: 'duplicate' }); await pause(200); });
    report.survived = true;`);
  assert.notEqual(insideTransaction.status, 0);
  assert.match(insideTransaction.stderr, /CONSTRAINT/);
  assert.deepEqual(insideTransaction.names, ['Ada', 'Bo']);
  // A forgotten validation failure rejects before the synchronous callback settles.
  const validation = childScenario(t, f, 'settled-validation', `
    await db.transaction(tx => { tx.table(owners).update({}, { where: eq(owners.col('id'), 1) }); });
    await pause(50);
    report.survived = true;`);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr, /VALIDATION/);
  // Root-handle promises are never wrapped or observed.
  const root = childScenario(t, f, 'settled-root', `
    db.table(owners).insert({ id: 1, name: 'duplicate' });
    await pause(200);
    report.survived = true;`);
  assert.notEqual(root.status, 0);
  assert.match(root.stderr, /CONSTRAINT/);
  // An escaped handle used after its transaction finished is ordinary misuse, reported normally.
  const escaped = childScenario(t, f, 'settled-escaped', `
    let kept;
    await db.transaction(tx => { kept = tx.table(owners); });
    kept.findMany();
    await pause(50);
    report.survived = true;`);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /TRANSACTION_CLOSED/);
});

test('public operations return plain promises and the root handle keeps its unwrapped promise chain', async t => {
  const f = files(t), db = f.own(await openAsyncDatabase(f.file('shape'), { tables }));
  await db.ensureSchema();
  for (const call of [() => db.table(owners).count(), () => db.table(owners).findMany(), () => db.inspectSchema(), () => db.planSchema(), () => db.transaction(() => 1)]) {
    const pending = call();
    assert.ok(pending instanceof Promise);
    await pending;
  }
  await db.transaction(async tx => { for (const p of [tx.table(owners).count(), tx.inspectSchema()]) { assert.ok(p instanceof Promise); await p; } });
  await assert.rejects(db.table(owners).insert({ id: 1 }), code('VALIDATION'));
  assert.deepEqual(db.exportTrace().queries.slice(-2).map(q => q.sql), ['BEGIN IMMEDIATE', 'ROLLBACK'], 'a captured validation error still replays inside its transaction');
});

test('a transaction never commits while a forgotten multi-step read sits between its database steps (timing sweep)', async t => {
  const f = files(t), file = f.file('between-steps');
  { const setup = openDatabase(file, { tables }); setup.ensureSchema(); setup.table(owners).insert({ id: 1, name: 'Ada' }); setup.close(); }
  const inner = inlineAsyncExecutor(openSqliteExecutor(file));
  let arm = null;
  const executor = { ...inner, async all(sql, parameters) {
    const rows = await inner.all(sql, parameters);
    if (arm && sql.startsWith('SELECT') && sql.includes('adb_owners')) { const fire = arm; arm = null; fire(); }
    return rows;
  } };
  const db = f.own(await openAsyncDatabaseWithExecutor(executor, { tables }));
  const seen = new Set();
  // Settle the callback at every microtask offset around the end of the read's first step.
  for (let ticks = 0; ticks <= 40; ticks++) {
    const gate = deferred();
    let read = 'pending';
    const outcomeOf = await outcome(() => db.transaction(async tx => {
      tx.table(owners).findMany({ include: { items: ownerItems } }).then(() => { read = 'fulfilled'; }, error => { read = error.code; });
      arm = () => { void (async () => { for (let i = 0; i < ticks; i++) await null; gate.resolve(); })(); };
      await gate.promise;
    }));
    await turn();
    const result = outcomeOf.code ?? 'committed';
    seen.add(result);
    // Committing is only acceptable when the read really finished first; an unfinished read must mean TRANSACTION_PENDING.
    assert.ok(result === 'TRANSACTION_PENDING' || result === 'committed' && read === 'fulfilled', JSON.stringify({ ticks, result, read }));
  }
  assert.ok(seen.has('TRANSACTION_PENDING'));
});

test('default policy: forgotten work caught by an unknown outcome is reported by the transaction, in parent and child frames', async t => {
  const f = files(t), file = f.file('poison');
  { const setup = openDatabase(file, { tables }); setup.ensureSchema(); setup.close(); }
  const script = `(async () => {
    const base = process.env.RS_BASE;
    const sdk = await import(base + 'index.js');
    const { openAsyncDatabaseWithExecutor } = await import(base + 'core/async-database.js');
    const { inlineAsyncExecutor } = await import(base + 'core/executor.js');
    const { openSqliteExecutor } = await import(base + 'core/sqlite-executor.js');
    const owners = sdk.defineTable('adb_owners', { id: sdk.column.integer().primaryKey(), name: sdk.column.text(), region: sdk.column.text().nullable(), version: sdk.column.integer().default(0), settings: sdk.column.json().nullable(), active: sdk.column.boolean().default(true) }, { version: 'version' });
    const report = {};
    for (const nested of [false, true]) {
      const inner = inlineAsyncExecutor(openSqliteExecutor(process.env.RS_FILE));
      let lose = false;
      const db = await openAsyncDatabaseWithExecutor({ ...inner, async all(sql, parameters) { if (lose) { lose = false; throw new Error('synthetic lost response'); } return inner.all(sql, parameters); } }, { tables: [owners] });
      const work = async tx => { lose = true; const lost = tx.table(owners).count(); tx.table(owners).findMany(); try { await lost; } catch { /* the caller saw the unknown outcome */ } };
      try { await db.transaction(nested ? tx => tx.transaction(work) : work); report[nested] = 'resolved'; } catch (error) { report[nested] = error.code; }
      await new Promise(resolve => setTimeout(resolve, 30));
      await db.close();
    }
    report.listeners = process.listenerCount('unhandledRejection');
    console.log(JSON.stringify(report));
  })();`;
  const env = { ...process.env, RS_BASE: new URL('../dist/', import.meta.url).href, RS_FILE: file };
  delete env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)), { false: 'EXECUTION_UNCONFIRMED', true: 'EXECUTION_UNCONFIRMED', listeners: 0 });
});
