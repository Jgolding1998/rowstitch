import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '../dist/index.js';
import { createAsyncSession, ASYNC_SESSION_LIMITS } from '../dist/core/async-session.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';
import { inlineAsyncExecutor, acknowledgedRejection, isAcknowledgedRejection } from '../dist/core/executor.js';

// Internal session conformance. SQL text here is trusted test SQL; the session is not a public raw-SQL API.
const code = value => error => error?.code === value;
const MAX = 2n ** 63n - 1n;
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await turn(); }
  throw new Error('Timed out waiting for ' + label);
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
const owned = new WeakMap();
/** Sessions registered here close before the test's temporary database files are removed (Windows keeps them locked). */
function own(t, session) { owned.get(t)?.push(session); return session; }
function localFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-async-session-'));
  const file = join(directory, 'sample.sqlite');
  if (!owned.has(t)) owned.set(t, []);
  t.after(async () => {
    for (const session of owned.get(t).splice(0)) await session.close().catch(() => {});
    for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    rmdirSync(directory);
  });
  return file;
}
const SCHEMA = 'CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, amount INTEGER);';
function prepare(file, sql = SCHEMA) { const sync = openSqliteExecutor(file); sync.exec(sql); sync.close(); }
function readBack(file, sql = 'SELECT label FROM item ORDER BY id') {
  const sync = openSqliteExecutor(file);
  try { return sync.all(sql, []).map(row => ({ ...row })); } finally { sync.close(); }
}
const labels = file => readBack(file).map(row => row.label);

/**
 * Deterministic test executor over a real SQLite connection. Every call is async; holds pause chosen calls, faults replace
 * an outcome. 'lost' faults may first apply the real operation, then hide its acknowledgment (durable unknown outcome).
 */
function controlled(file, options) {
  const sync = openSqliteExecutor(file, options);
  const log = [], holds = [], faults = [];
  const state = { active: 0, maxActive: 0, closes: 0 };
  async function step(kind, text, run) {
    state.active++; state.maxActive = Math.max(state.maxActive, state.active);
    log.push(kind === 'all' || kind === 'exec' ? text : kind);
    try {
      await Promise.resolve();
      const hold = holds.find(h => !h.used && h.match(kind, text));
      if (hold) { hold.used = true; hold.reached.resolve(); await hold.gate.promise; }
      const index = faults.findIndex(f => f.match(kind, text));
      if (index >= 0) {
        const fault = faults.splice(index, 1)[0];
        if (fault.mode === 'ack') throw acknowledgedRejection({ errcode: fault.errcode ?? 5 });
        if (fault.apply) run();
        throw new Error('synthetic lost acknowledgment');
      }
      try { return run(); } catch (error) { throw acknowledgedRejection(error); }
    } finally { state.active--; }
  }
  const executor = Object.freeze({
    all: (sql, parameters) => step('all', sql, () => sync.all(sql, parameters)),
    exec: sql => step('exec', sql, () => sync.exec(sql)),
    inTransaction: () => step('state', 'state', () => sync.inTransaction()),
    close: () => step('close', 'close', () => { state.closes++; sync.close(); }),
  });
  return {
    executor, log, state,
    hold(match) { const h = { match, used: false, reached: deferred(), gate: deferred() }; holds.push(h); return { reached: h.reached.promise, release: () => h.gate.resolve() }; },
    fault(match, mode, extra = {}) { faults.push({ match, mode, ...extra }); },
  };
}
const isSql = pattern => (kind, text) => (kind === 'all' || kind === 'exec') && pattern.test(text);
const isClose = kind => kind === 'close';

test('internal only: the SDK exports no session or raw-SQL capability', () => {
  for (const name of ['createAsyncSession', 'ASYNC_SESSION_LIMITS', 'openSqliteExecutor', 'inlineAsyncExecutor']) assert.equal(name in sdk, false);
  assert.deepEqual([ASYNC_SESSION_LIMITS.maxDepth, ASYNC_SESSION_LIMITS.defaultQueue, ASYNC_SESSION_LIMITS.defaultPending, ASYNC_SESSION_LIMITS.defaultQueueTimeoutMs], [32, 64, 256, 10_000]);
});

test('construction validates exactly; every session method returns a rejected promise instead of throwing', async t => {
  const executor = inlineAsyncExecutor(openSqliteExecutor());
  for (const options of [null, { readOnly: 'yes' }, { readOnly: 1 }, { maxQueue: 0 }, { maxQueue: 1025 }, { maxQueue: 1.5 }, { maxPending: 0 }, { maxPending: 1025 },
    { queueTimeoutMs: 0 }, { queueTimeoutMs: 60_001 }, { extra: true }, [], Object.create({ readOnly: true })])
    assert.throws(() => createAsyncSession(executor, options), code('VALIDATION'));
  for (const bad of [null, {}, { all() {}, exec() {}, inTransaction() {} }]) assert.throws(() => createAsyncSession(bad), code('VALIDATION'));
  const session = createAsyncSession(executor, { readOnly: false, maxQueue: 1024, maxPending: 1, queueTimeoutMs: 60_000 });
  t.after(() => session.close());
  assert.ok(Object.isFrozen(session));
  const calls = [() => session.all(''), () => session.all(1), () => session.all('SELECT ?', [undefined]), () => session.all('SELECT ?', [{}]), () => session.all('SELECT ?', [NaN]),
    () => session.all('SELECT 1', 'x'), () => session.all('SELECT 1', [], { signal: {} }), () => session.all('SELECT 1', [], { other: 1 }),
    () => session.all('SELECT 1', new Array(10_001).fill(1)), () => session.transaction(null), () => session.transaction(async () => {}, { signal: 1 })];
  for (const call of calls) {
    let result;
    assert.doesNotThrow(() => { result = call(); });
    assert.ok(result instanceof Promise);
    await assert.rejects(result, code('VALIDATION'));
  }
  assert.deepEqual((await session.all('SELECT ? AS big, ? AS text', [MAX, 'x'])).map(row => ({ ...row })), [{ big: MAX, text: 'x' }]);
});

test('real SQLite: commit is durable after reopen, rollback restores, bigint is exact, read-only uses BEGIN', async t => {
  const file = localFile(t);
  prepare(file);
  const session = createAsyncSession(inlineAsyncExecutor(openSqliteExecutor(file)));
  const value = await session.transaction(async tx => {
    await tx.all('INSERT INTO item(label, amount) VALUES (?, ?)', ['kept', MAX]);
    return (await tx.all('SELECT amount FROM item WHERE label = ?', ['kept']))[0].amount;
  });
  assert.equal(value, MAX);
  await assert.rejects(session.transaction(async tx => { await tx.all("INSERT INTO item(label) VALUES ('discarded')"); throw new Error('callback failure'); }), /callback failure/);
  await assert.rejects(session.transaction(tx => { tx.all("INSERT INTO item(label) VALUES ('sync-throw')"); throw new TypeError('sync'); }), TypeError);
  assert.equal(await session.transaction(() => 'plain value'), 'plain value');
  await session.close();
  assert.deepEqual(readBack(file, 'SELECT label, amount FROM item'), [{ label: 'kept', amount: MAX }]);
  const ro = controlled(file, { readOnly: true });
  const reader = createAsyncSession(ro.executor, { readOnly: true });
  assert.equal((await reader.transaction(tx => tx.all('SELECT count(*) AS n FROM item')))[0].n, 1n);
  await assert.rejects(reader.all("INSERT INTO item(label) VALUES ('no')"), code('READ_ONLY'));
  await reader.close();
  assert.deepEqual(ro.log.filter(sql => /^(BEGIN|COMMIT)/.test(sql)), ['BEGIN', 'COMMIT']);
  const rw = controlled(file);
  const writer = createAsyncSession(rw.executor);
  await writer.transaction(() => 1);
  await writer.close();
  assert.ok(rw.log.includes('BEGIN IMMEDIATE'));
});

test('parameters are captured before queueing; every executor call is serialized on the connection', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  own(t, session);
  const gate = deferred();
  const tx = session.transaction(async inner => { await gate.promise; await inner.all('SELECT 1'); });
  await until(() => c.log.includes('BEGIN IMMEDIATE'), 'BEGIN');
  const parameters = ['captured'];
  const queued = session.all('INSERT INTO item(label) VALUES (?) RETURNING label', parameters);
  parameters[0] = 'mutated';
  const many = [session.all('SELECT 1 AS n'), session.all('SELECT 2 AS n')];
  gate.resolve();
  await tx;
  assert.equal((await queued)[0].label, 'captured');
  await Promise.all(many);
  assert.equal(c.state.maxActive, 1, 'no two executor operations overlapped');
  assert.ok(c.log.indexOf('COMMIT') < c.log.indexOf('INSERT INTO item(label) VALUES (?) RETURNING label'), 'queued root work ran after COMMIT');
});

test('bounded FIFO: unrelated root work waits in order; full, timed-out and aborted entries send no SQL', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor, { maxQueue: 3, queueTimeoutMs: 40 });
  own(t, session);
  const gate = deferred();
  const tx = session.transaction(async inner => { await inner.all("INSERT INTO item(label) VALUES ('tx')"); await gate.promise; });
  await until(() => c.log.length >= 2, 'transaction work');
  const order = [];
  const first = session.all("INSERT INTO item(label) VALUES ('q1')").then(() => order.push('q1'));
  const controller = new AbortController();
  const aborted = session.all("INSERT INTO item(label) VALUES ('aborted')", [], { signal: controller.signal });
  const second = session.transaction(async inner => { await inner.all("INSERT INTO item(label) VALUES ('q2')"); order.push('q2'); });
  await assert.rejects(session.all("INSERT INTO item(label) VALUES ('overflow')"), code('QUEUE_FULL'));
  controller.abort();
  await assert.rejects(aborted, code('ABORTED'));
  await assert.rejects(session.all('SELECT 1', [], { signal: AbortSignal.abort() }), code('ABORTED'));
  // With the gate still closed, both queued entries time out without SQL.
  await assert.rejects(first, code('QUEUE_TIMEOUT'));
  await assert.rejects(second, code('QUEUE_TIMEOUT'));
  const third = session.all("INSERT INTO item(label) VALUES ('q3')").then(() => order.push('q3'));
  const fourth = session.all("INSERT INTO item(label) VALUES ('q4')").then(() => order.push('q4'));
  gate.resolve();
  await tx; await third; await fourth;
  assert.deepEqual(order, ['q3', 'q4']);
  assert.ok(!c.log.some(sql => /aborted|overflow|q1|q2/.test(sql)), 'rejected queue entries never reached the executor');
  assert.deepEqual(labels(file), ['tx', 'q3', 'q4']);
});

test('root and ancestor misuse from an active transaction context is rejected immediately, never deadlocks', async t => {
  const file = localFile(t); prepare(file);
  const session = createAsyncSession(inlineAsyncExecutor(openSqliteExecutor(file)));
  own(t, session);
  await withTimeout(session.transaction(async tx => {
    await assert.rejects(session.all('SELECT 1'), code('TRANSACTION_ACTIVE'));
    await assert.rejects(session.transaction(() => 1), code('TRANSACTION_ACTIVE'));
    await assert.rejects(session.close(), code('TRANSACTION_ACTIVE'));
    await tx.transaction(async child => {
      await assert.rejects(tx.all('SELECT 1'), code('TRANSACTION_NESTED_ACTIVE'));
      await assert.rejects(session.all('SELECT 1'), code('TRANSACTION_ACTIVE'));
      await child.all("INSERT INTO item(label) VALUES ('child')");
    });
    await tx.all("INSERT INTO item(label) VALUES ('parent')");
  }), 2000, 'misuse');
  assert.deepEqual(labels(file), ['child', 'parent']);
});

test('escaped contexts and retained handles are refused, including timers created inside a finished callback', async t => {
  const file = localFile(t); prepare(file);
  const session = createAsyncSession(inlineAsyncExecutor(openSqliteExecutor(file)));
  own(t, session);
  let retained, lateRoot, lateTx;
  await session.transaction(async tx => {
    retained = tx;
    lateRoot = new Promise(resolve => setTimeout(() => resolve(session.all("INSERT INTO item(label) VALUES ('late-root')")), 20));
    lateTx = new Promise(resolve => setTimeout(() => resolve(tx.all("INSERT INTO item(label) VALUES ('late-tx')")), 20));
  });
  await assert.rejects(lateRoot, code('TRANSACTION_CLOSED'));
  await assert.rejects(lateTx, code('TRANSACTION_CLOSED'));
  await assert.rejects(retained.all("INSERT INTO item(label) VALUES ('escaped')"), code('TRANSACTION_CLOSED'));
  await assert.rejects(retained.transaction(() => 1), code('TRANSACTION_CLOSED'));
  // A handle carried out of its context while the transaction is still active.
  const gate = deferred();
  let live;
  const tx = session.transaction(async inner => { live = inner; await gate.promise; });
  await until(() => live, 'live handle');
  await assert.rejects(live.all("INSERT INTO item(label) VALUES ('outside')"), code('TRANSACTION_CONTEXT'));
  gate.resolve(); await tx;
  assert.deepEqual(labels(file), []);
});

test('nested transactions: one child at a time, refused before SQL; child rollback keeps parent work; depth is capped at 32', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  own(t, session);
  await session.transaction(async tx => {
    await tx.all("INSERT INTO item(label) VALUES ('p1')");
    await assert.rejects(tx.transaction(async child => { await child.all("INSERT INTO item(label) VALUES ('c-bad')"); throw new Error('child'); }), /child/);
    const gate = deferred();
    const child = tx.transaction(async inner => { await gate.promise; await inner.all("INSERT INTO item(label) VALUES ('c-ok')"); });
    await until(() => c.log.filter(sql => sql.startsWith('SAVEPOINT')).length === 2, 'second SAVEPOINT');
    const savepoints = c.log.filter(sql => sql.startsWith('SAVEPOINT')).length;
    await assert.rejects(tx.transaction(() => 1), code('TRANSACTION_NESTED_ACTIVE'));
    await assert.rejects(tx.all('SELECT 1'), code('TRANSACTION_NESTED_ACTIVE'));
    assert.equal(c.log.filter(sql => sql.startsWith('SAVEPOINT')).length, savepoints, 'refused siblings sent no SAVEPOINT');
    gate.resolve(); await child;
    const pending = tx.all('SELECT 1');
    await assert.rejects(tx.transaction(() => 1), code('TRANSACTION_NESTED_ACTIVE'), 'child admission while parent statements are pending');
    await pending;
  });
  assert.deepEqual(labels(file), ['p1', 'c-ok']);
  const nest = async (tx, depth) => depth === 32 ? assert.rejects(tx.transaction(() => 1), code('TRANSACTION_DEPTH')) : tx.transaction(inner => nest(inner, depth + 1));
  await session.transaction(tx => nest(tx, 1));
});

test('settlement with pending work: lease invalidated, work drained, rolled back, TRANSACTION_PENDING; never committed', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  own(t, session);
  const hold = c.hold(isSql(/'unawaited'/));
  let handle;
  const result = session.transaction(tx => { handle = tx; tx.all("INSERT INTO item(label) VALUES ('unawaited')"); });
  await hold.reached;
  await turn(); await turn();
  await assert.rejects(handle.all('SELECT 1'), code('TRANSACTION_CLOSED'), 'lease invalidated at settlement');
  assert.ok(!c.log.includes('ROLLBACK') && !c.log.includes('COMMIT'), 'nothing is decided before issued work drains');
  hold.release();
  await assert.rejects(result, code('TRANSACTION_PENDING'));
  assert.ok(c.log.includes('ROLLBACK') && !c.log.includes('COMMIT'));
  assert.deepEqual(labels(file), []);
  // An un-awaited child cannot outlive its parent: the parent rolls back, the child is closed and its handle refused.
  const childGate = deferred(), childStarted = deferred();
  let childHandle, childPromise;
  const parent = session.transaction(async tx => {
    await tx.all("INSERT INTO item(label) VALUES ('parent')");
    childPromise = tx.transaction(async child => { childHandle = child; childStarted.resolve(); await child.all("INSERT INTO item(label) VALUES ('child')"); await childGate.promise; });
    await childStarted.promise; // the child is running; the parent returns without awaiting it
  });
  await assert.rejects(parent, code('TRANSACTION_PENDING'));
  await assert.rejects(childPromise, code('TRANSACTION_CLOSED'));
  await assert.rejects(childHandle.all('SELECT 1'), code('TRANSACTION_CLOSED'));
  childGate.resolve();
  await turn();
  assert.deepEqual(labels(file), []);
  assert.equal((await session.all('SELECT 1 AS n'))[0].n, 1n, 'session remains usable');
});

test('a child already rolling back when its parent ends sends no further savepoint SQL; the parent rollback covers it', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = own(t, createAsyncSession(c.executor));
  const rollbackTo = c.hold(isSql(/^ROLLBACK TO SAVEPOINT/));
  let child;
  const parent = session.transaction(async tx => {
    await tx.all("INSERT INTO item(label) VALUES ('parent')");
    child = tx.transaction(async inner => { await inner.all("INSERT INTO item(label) VALUES ('child')"); throw new Error('child fails'); });
    child.catch(() => {});
    await rollbackTo.reached; // the child's own ROLLBACK TO is now in flight; return without awaiting the child
  });
  await rollbackTo.reached;
  await turn(); await turn();
  rollbackTo.release();
  await assert.rejects(parent, code('TRANSACTION_PENDING'));
  await assert.rejects(child, /child fails/);
  const after = c.log.slice(c.log.findIndex(sql => sql.startsWith('ROLLBACK TO SAVEPOINT')) + 1);
  assert.ok(!after.some(sql => sql.startsWith('RELEASE SAVEPOINT')), 'the doomed child sent no RELEASE: ' + JSON.stringify(after));
  assert.ok(after.includes('ROLLBACK'));
  assert.deepEqual(labels(file), []);
  assert.equal((await session.all('SELECT 1 AS n'))[0].n, 1n, 'session remains usable');
});

test('cancellation: queued sends no SQL; running stops new work, drains and rolls back; acknowledged COMMIT wins', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  own(t, session);
  // Abort while BEGIN is in flight: the callback never runs.
  const beginHold = c.hold(isSql(/^BEGIN/));
  const early = new AbortController();
  let ran = false;
  const first = session.transaction(() => { ran = true; }, { signal: early.signal });
  await beginHold.reached; early.abort(); beginHold.release();
  await assert.rejects(first, code('ABORTED'));
  assert.equal(ran, false);
  // Abort while running: new work is refused, issued work drains, then rollback.
  const running = new AbortController();
  const insertHold = c.hold(isSql(/'in-flight'/));
  let tx2;
  const second = session.transaction(async tx => { tx2 = tx; await tx.all("INSERT INTO item(label) VALUES ('in-flight')"); await new Promise(() => {}); }, { signal: running.signal });
  await insertHold.reached;
  running.abort();
  await turn();
  await assert.rejects(tx2.all('SELECT 1'), code('ABORTED'));
  assert.ok(!c.log.slice(-1)[0].startsWith('ROLLBACK'), 'rollback waits for the issued statement');
  insertHold.release();
  await assert.rejects(second, code('ABORTED'));
  assert.deepEqual(labels(file), []);
  // Abort while COMMIT is in flight, and after it is acknowledged: success stands.
  const late = new AbortController();
  const commitHold = c.hold(isSql(/^COMMIT/));
  const third = session.transaction(tx => tx.all("INSERT INTO item(label) VALUES ('committed')"), { signal: late.signal });
  await commitHold.reached; late.abort(); commitHold.release();
  await third;
  late.abort();
  assert.deepEqual(labels(file), ['committed']);
  // A root statement already issued is not interrupted by abort.
  const statementHold = c.hold(isSql(/'issued'/));
  const issued = new AbortController();
  const statement = session.all("INSERT INTO item(label) VALUES ('issued') RETURNING label", [], { signal: issued.signal });
  await statementHold.reached; issued.abort(); statementHold.release();
  assert.equal((await statement)[0].label, 'issued');
});

test('acknowledged statement errors can be caught; a known COMMIT failure rolls back with the safe original error', async t => {
  const file = localFile(t);
  prepare(file, SCHEMA + 'CREATE TABLE owner(id INTEGER PRIMARY KEY); CREATE TABLE pet(id INTEGER PRIMARY KEY, ownerId INTEGER REFERENCES owner(id) DEFERRABLE INITIALLY DEFERRED);');
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  own(t, session);
  await session.transaction(async tx => {
    await tx.all("INSERT INTO item(label) VALUES ('one')");
    const error = await tx.all("INSERT INTO item(label) VALUES ('one')").catch(caught => caught);
    assert.ok(isAcknowledgedRejection(error) && error.code === 'CONSTRAINT' && !/one/.test(error.message));
    await tx.all("INSERT INTO item(label) VALUES ('two')");
  });
  assert.deepEqual(labels(file), ['one', 'two']);
  // Real SQLite: a deferred foreign key fails at COMMIT and leaves the transaction open; the session rolls it back.
  const failed = await session.transaction(tx => tx.all('INSERT INTO pet(id, ownerId) VALUES (1, 99)')).catch(error => error);
  assert.equal(failed.code, 'CONSTRAINT');
  assert.ok(isAcknowledgedRejection(failed));
  assert.ok(c.log.lastIndexOf('ROLLBACK') > c.log.lastIndexOf('COMMIT'));
  assert.deepEqual(readBack(file, 'SELECT count(*) AS n FROM pet'), [{ n: 0n }]);
  assert.equal((await session.all('SELECT 1 AS n'))[0].n, 1n, 'session usable after a known COMMIT failure');
  // Acknowledged BEGIN failure: no callback, session still usable.
  c.fault(isSql(/^BEGIN/), 'ack', { errcode: 5 });
  let ran = false;
  await assert.rejects(session.transaction(() => { ran = true; }), code('BUSY'));
  assert.equal(ran, false);
  await session.transaction(tx => tx.all("INSERT INTO item(label) VALUES ('after-busy')"));
  assert.deepEqual(labels(file), ['one', 'two', 'after-busy']);
});

test('lost COMMIT acknowledgment: COMMIT_UNCONFIRMED, no rollback inferred, poisoned, closed once, durable effect visible', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  c.fault(isSql(/^COMMIT/), 'lost', { apply: true });
  const gate = deferred();
  let calls = 0;
  const tx = session.transaction(async inner => { calls++; await inner.all("INSERT INTO item(label) VALUES ('maybe')"); await gate.promise; });
  await until(() => c.log.some(sql => /'maybe'/.test(sql)), 'insert');
  const queued = session.all('SELECT 1');
  gate.resolve();
  await assert.rejects(tx, code('COMMIT_UNCONFIRMED'));
  await assert.rejects(queued, code('CONNECTION_UNUSABLE'));
  assert.equal(calls, 1, 'callback never replayed');
  assert.ok(!c.log.includes('ROLLBACK'), 'no rollback after an unconfirmed COMMIT');
  await assert.rejects(session.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
  await assert.rejects(session.transaction(() => 1), code('CONNECTION_UNUSABLE'));
  await session.close(); await session.close();
  assert.equal(c.state.closes, 1);
  assert.deepEqual(labels(file), ['maybe'], 'the commit actually happened; the session did not claim a rollback');
});

test('unknown statement outcome poisons even if the callback catches it; failed rollback keeps the original error', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor);
  c.fault(isSql(/'lost'/), 'lost', { apply: true });
  const result = session.transaction(async tx => {
    await assert.rejects(tx.all("INSERT INTO item(label) VALUES ('lost')"), code('EXECUTION_UNCONFIRMED'));
    await assert.rejects(tx.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
    return 'callback claims success';
  });
  await assert.rejects(result, code('EXECUTION_UNCONFIRMED'));
  assert.ok(!c.log.includes('COMMIT') && !c.log.includes('ROLLBACK'));
  await session.close();
  assert.equal(c.state.closes, 1);
  // Autocommit root statement with a lost acknowledgment.
  const c2 = controlled(file);
  const root = createAsyncSession(c2.executor);
  c2.fault(isSql(/'root-lost'/), 'lost', { apply: true });
  await assert.rejects(root.all("INSERT INTO item(label) VALUES ('root-lost')"), code('EXECUTION_UNCONFIRMED'));
  await assert.rejects(root.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
  await root.close();
  assert.equal(c2.state.closes, 1);
  // Failed ROLLBACK: the callback's own error is kept, with safe cleanup metadata, and the connection is closed.
  const c3 = controlled(file);
  const third = createAsyncSession(c3.executor);
  c3.fault(isSql(/^ROLLBACK$/), 'ack', { errcode: 1 });
  const original = new Error('callback failed');
  const caught = await third.transaction(async tx => { await tx.all("INSERT INTO item(label) VALUES ('rolled')"); throw original; }).catch(error => error);
  assert.equal(caught, original);
  assert.deepEqual({ ...caught.rowstitchCleanup }, { code: 'CONNECTION_UNUSABLE', connectionUnusable: true, closeRequested: true });
  assert.equal(Object.keys(caught).includes('rowstitchCleanup'), false);
  await assert.rejects(third.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
  await third.close();
  assert.equal(c3.state.closes, 1);
  // The applied-but-unacknowledged insert was inside a transaction that was never committed; SQLite discards it when the
  // poisoned connection closes. The session itself issued neither COMMIT nor ROLLBACK for it.
  assert.deepEqual(labels(file), ['root-lost']);
});

test('close refuses active or queued work, waits for issued statements, closes exactly once; pending cap is enforced', async t => {
  const file = localFile(t); prepare(file);
  const c = controlled(file);
  const session = createAsyncSession(c.executor, { maxPending: 2 });
  const gate = deferred();
  const tx = session.transaction(async () => { await gate.promise; });
  await until(() => c.log.includes('BEGIN IMMEDIATE'), 'BEGIN');
  await assert.rejects(session.close(), code('TRANSACTION_ACTIVE'));
  gate.resolve(); await tx;
  const hold = c.hold(isSql(/'slow'/));
  const slow = session.all("INSERT INTO item(label) VALUES ('slow') RETURNING label");
  const other = session.all('SELECT 1');
  await assert.rejects(session.all('SELECT 2'), code('PENDING_LIMIT'));
  await hold.reached;
  const closing = session.close();
  assert.equal(session.close(), closing, 'idempotent');
  await assert.rejects(session.all('SELECT 1'), code('CLOSED'));
  assert.equal(c.state.closes, 0, 'not closed underneath the active statement');
  hold.release();
  assert.equal((await slow)[0].label, 'slow');
  await other; await closing;
  assert.equal(c.state.closes, 1);
  assert.equal(c.log.at(-1), 'close');
  await assert.rejects(session.transaction(() => 1), code('CLOSED'));
});

// ------------------------------------------------------------------ conformance probes against a deliberately naive session
// The naive session commits once its callback promise resolves, lets root calls run on the open transaction, and never
// revokes handles. Its failures below are expected controls and are not counted as product passing scenarios.
function naiveSession(executor) {
  const tx = { all: (sql, parameters = []) => executor.all(sql, parameters), transaction: async callback => callback(tx) };
  return Object.freeze({
    all: (sql, parameters = []) => executor.all(sql, parameters),
    async transaction(callback) {
      await executor.exec('BEGIN IMMEDIATE');
      try { const value = await callback(tx); await executor.exec('COMMIT'); return value; }
      catch (error) { await executor.exec('ROLLBACK').catch(() => {}); throw error; }
    },
    close: () => executor.close(),
  });
}
const PROBES = {
  async 'un-awaited insert is never committed'(file, make) {
    const c = controlled(file); const session = make(c.executor);
    try {
      const hold = c.hold(isSql(/'unawaited'/));
      const result = session.transaction(tx => { tx.all("INSERT INTO item(label) VALUES ('unawaited')"); });
      await hold.reached; await turn(); hold.release();
      await result.then(() => assert.fail('resolved'), error => assert.equal(error.code, 'TRANSACTION_PENDING'));
      await turn();
      assert.deepEqual(labels(file), []);
    } finally { await session.close().catch(() => {}); }
  },
  async 'outside root work never joins an open transaction'(file, make) {
    const c = controlled(file); const session = make(c.executor);
    try {
      const gate = deferred();
      const tx = session.transaction(async inner => { await inner.all("INSERT INTO item(label) VALUES ('tx')"); await gate.promise; throw new Error('rollback'); });
      await until(() => c.log.some(sql => /'tx'/.test(sql)), 'tx insert');
      const outside = session.all("INSERT INTO item(label) VALUES ('outside')");
      await turn(); gate.resolve();
      await assert.rejects(tx, /rollback/);
      await outside;
      assert.deepEqual(labels(file), ['outside']);
    } finally { await session.close().catch(() => {}); }
  },
  async 'root handle inside its transaction is refused'(file, make) {
    const c = controlled(file); const session = make(c.executor);
    try {
      await withTimeout(session.transaction(async () => { await assert.rejects(session.all('SELECT 1'), code('TRANSACTION_ACTIVE')); }), 1000, 'root inside');
    } finally { await session.close().catch(() => {}); }
  },
  async 'escaped transaction handle cannot write'(file, make) {
    const c = controlled(file); const session = make(c.executor);
    try {
      let escaped;
      await session.transaction(tx => { escaped = tx; });
      await escaped.all("INSERT INTO item(label) VALUES ('escaped')").then(() => {}, () => {});
      assert.deepEqual(labels(file), []);
    } finally { await session.close().catch(() => {}); }
  },
};
for (const [name, probe] of Object.entries(PROBES)) {
  test('conformance: ' + name, async t => { const file = localFile(t); prepare(file); await probe(file, executor => createAsyncSession(executor)); });
}
test('control (not a product scenario): the naive session fails every conformance probe', async t => {
  const outcomes = {};
  for (const [name, probe] of Object.entries(PROBES)) {
    const file = localFile(t); prepare(file);
    outcomes[name] = await withTimeout(probe(file, naiveSession), 3000, name).then(() => 'passed', () => 'failed');
  }
  assert.deepEqual(Object.values(outcomes), Object.keys(PROBES).map(() => 'failed'), JSON.stringify(outcomes));
});
