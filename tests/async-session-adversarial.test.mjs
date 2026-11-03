import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSession } from '../dist/core/async-session.js';
import { acknowledgedRejection } from '../dist/core/executor.js';

const code = expected => error => error?.code === expected;
function deferred() { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

// A driver with explicit gates gives these tests control of the actual send point.
// Its purpose is protocol/concurrency evidence, not a claim of network coverage.
function driver() {
  const calls = [], holds = [];
  let active = false, closed = 0;
  const d = {
    calls, get closes() { return closed; },
    hold(sql) { const reached = deferred(), gate = deferred(); holds.push({ sql, reached, gate }); return { reached: reached.promise, release: gate.resolve }; },
    executor: {
      async all(sql, parameters) {
        calls.push({ sql, parameters });
        const h = holds.find(h => h.sql === sql);
        if (h) { h.reached.resolve(); await h.gate.promise; }
        return [{ value: sql }];
      },
      async exec(sql) { calls.push({ sql }); if (sql.startsWith('BEGIN')) active = true; if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false; },
      async inTransaction() { return active; },
      async close() { closed++; active = false; },
    },
  };
  return d;
}

test('aborting an autocommit statement waiting on serialization sends no SQL', async () => {
  const d = driver(), held = d.hold('SELECT first'), s = createAsyncSession(d.executor);
  const first = s.all('SELECT first'); await held.reached;
  const abort = new AbortController();
  const second = s.all('SELECT second', [], { signal: abort.signal });
  const outcome = second.then(() => 'ran', error => error.code);
  abort.abort(); held.release();
  await first;
  assert.equal(await outcome, 'ABORTED');
  assert.ok(!d.calls.some(c => c.sql === 'SELECT second'));
  assert.deepEqual(await s.all('SELECT after'), [{ value: 'SELECT after' }]);
  await s.close(); assert.equal(d.closes, 1);
});

test('aborting a transaction statement before send rolls back its transaction', async () => {
  const d = driver(), held = d.hold('SELECT first'), s = createAsyncSession(d.executor);
  const abort = new AbortController();
  const run = s.transaction(async tx => {
    const first = tx.all('SELECT first'); await held.reached;
    const second = tx.all('SELECT cancelled', [], { signal: abort.signal });
    // Observe the rejection immediately so a drain never creates an unhandled rejection.
    const outcome = second.then(() => 'ran', error => error.code);
    abort.abort(); held.release(); await first;
    assert.equal(await outcome, 'ABORTED');
  });
  await assert.rejects(run, code('ABORTED'));
  assert.ok(!d.calls.some(c => c.sql === 'SELECT cancelled'));
  assert.ok(d.calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(!d.calls.some(c => c.sql === 'COMMIT'));
  await s.close();
});

test('aborting an issued transaction statement drains it before rollback', async () => {
  const d = driver(), held = d.hold('SELECT active'), s = createAsyncSession(d.executor);
  const abort = new AbortController();
  const run = s.transaction(tx => tx.all('SELECT active', [], { signal: abort.signal }));
  await held.reached; abort.abort(); await turn();
  assert.ok(!d.calls.some(c => c.sql === 'ROLLBACK'));
  held.release();
  await assert.rejects(run, code('ABORTED'));
  assert.ok(d.calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(!d.calls.some(c => c.sql === 'COMMIT'));
  await s.close();
});

test('callback errors survive cleanup even when the error has hostile reflection traps', async () => {
  const d = driver(), s = createAsyncSession({ ...d.executor, async exec(sql) {
    if (sql === 'ROLLBACK') throw acknowledgedRejection({ errcode: 5 });
    return d.executor.exec(sql);
  } });
  const original = new Proxy(new Error('synthetic callback'), { isExtensible() { throw new Error('synthetic trap'); } });
  await assert.rejects(s.transaction(() => { throw original; }), error => error === original);
  await assert.rejects(s.all('SELECT after'), code('CONNECTION_UNUSABLE'));
  await s.close(); assert.equal(d.closes, 1);
});

test('a synchronous callback cannot win a promise race against its own abort', async () => {
  const d = driver(), s = createAsyncSession(d.executor), abort = new AbortController();
  await assert.rejects(s.transaction(() => { abort.abort(); return 17; }, { signal: abort.signal }), code('ABORTED'));
  assert.ok(d.calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(!d.calls.some(c => c.sql === 'COMMIT'));
  await s.close();
});

test('a failed driver close never claims that cleanup closed the connection', async () => {
  const d = driver(), s = createAsyncSession({ ...d.executor, async exec(sql) {
    if (sql === 'ROLLBACK') throw acknowledgedRejection({ errcode: 5 });
    return d.executor.exec(sql);
  }, async close() { throw new Error('synthetic close failure'); } });
  const original = new Error('synthetic callback');
  await assert.rejects(s.transaction(() => { throw original; }), error => error === original);
  await s.close();
  assert.notEqual(original.rowstitchCleanup?.connectionClosed, true);
  assert.equal(original.rowstitchCleanup?.connectionUnusable, true);
  assert.equal(original.rowstitchCleanup?.closeRequested, true);
});

test('pre-aborted statement and child requests never join or abort a parent transaction', async () => {
  const d = driver(), s = createAsyncSession(d.executor);
  for (const kind of ['statement', 'child']) await s.transaction(async tx => {
    await tx.all('SELECT before');
    const options = { signal: AbortSignal.abort() };
    const cancelled = kind === 'statement' ? tx.all('SELECT never', [], options) : tx.transaction(() => { throw new Error('child ran'); }, options);
    await assert.rejects(cancelled, code('ABORTED'));
    await tx.all('SELECT after');
  });
  assert.equal(d.calls.filter(c => c.sql === 'COMMIT').length, 2);
  assert.ok(!d.calls.some(c => c.sql === 'SELECT never' || c.sql.startsWith('SAVEPOINT') || c.sql === 'ROLLBACK'));
  await s.close();
});
