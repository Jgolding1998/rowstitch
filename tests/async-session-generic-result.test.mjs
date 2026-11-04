// Private lifecycle with a non-array raw result. Responses are simulated: this says nothing about any live engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSession, trackTransactionPromise } from '../dist/core/async-session.js';
import { acknowledgedRejection, isAcknowledgedRejection } from '../dist/core/executor.js';
import { RowstitchError } from '../dist/core/errors.js';

const code = wanted => error => error?.code === wanted;
const isRaw = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.fields) && Array.isArray(value.rows) && typeof value.command === 'string';
const raw = sql => Object.freeze({ fields: [{ name: 'a', typeOid: 25 }, { name: 'a', typeOid: 20 }], rows: [['duplicate names', '9007199254740993'], [null, null]], command: 'SELECT', sql });

function engine() {
  const calls = [], gates = new Map(), d = {
    calls, active: false, closes: 0, answer: raw, results: new Map(),
    hold(sql) { let release, reached; const gate = new Promise(ok => { release = ok; }), started = new Promise(ok => { reached = ok; }); gates.set(sql, { gate, reached }); return { release, started }; },
    executor: {
      async all(sql) {
        calls.push(sql);
        const held = gates.get(sql); if (held) { held.reached(); await held.gate; }
        const value = d.answer(sql);
        d.results.set(sql, value);
        return value;
      },
      async exec(sql) {
        calls.push(sql);
        const held = gates.get(sql); if (held) { held.reached(); await held.gate; }
        if (d.failExec?.(sql)) throw d.failExec(sql);
        if (sql.startsWith('BEGIN')) d.active = true;
        if (sql === 'COMMIT' || sql === 'ROLLBACK') d.active = false;
      },
      async inTransaction() { return d.active; },
      async close() { d.closes++; },
    },
  };
  return d;
}
const open = (d, options = {}) => createAsyncSession(d.executor, { dialect: 'postgresql', isResult: isRaw, ...options });

test('the exact raw object passes through root, transaction and child, with duplicate raw names untouched', async () => {
  const d = engine(), session = open(d);
  const root = await session.all('SELECT root');
  assert.equal(root, d.results.get('SELECT root'));
  assert.deepEqual(root.rows[0], ['duplicate names', '9007199254740993']);
  const out = await session.transaction(async tx => {
    const inTx = await tx.all('SELECT tx');
    assert.equal(inTx, d.results.get('SELECT tx'));
    const inChild = await tx.transaction(child => child.all('SELECT child'));
    assert.equal(inChild, d.results.get('SELECT child'));
    return inChild;
  });
  assert.equal(out, d.results.get('SELECT child'), 'a raw result can also be the transaction value');
  assert.match(d.calls[1], /^BEGIN/);
  assert.deepEqual([d.calls[0], ...d.calls.slice(2)], ['SELECT root', 'SELECT tx', 'SAVEPOINT "rs_async_sp_1"', 'SELECT child', 'RELEASE SAVEPOINT "rs_async_sp_1"', 'COMMIT']);
  await session.close();
  assert.equal(d.closes, 1);
});

test('a read-only root statement returns the raw object through its implicit transaction', async () => {
  const d = engine(), session = open(d, { readOnly: true });
  assert.equal(await session.all('SELECT ro'), d.results.get('SELECT ro'));
  assert.deepEqual(d.calls, ['BEGIN READ ONLY', 'SELECT ro', 'COMMIT']);
  await session.close();
});

test('observer handles are the transaction handles, and they resolve raw results while active', async () => {
  const d = engine(), events = [];
  const session = open(d, { observer: { control(event) { events.push(event); } } });
  let handle;
  await session.transaction(async tx => { handle = tx; await tx.all('SELECT 1'); });
  assert.deepEqual(events.map(event => event.action), ['begin-immediate', 'commit']);
  assert.ok(events.every(event => event.handle === handle));
  await assert.rejects(events[0].handle.all('SELECT late'), code('TRANSACTION_CLOSED'));
  await session.close();
});

test('tracked public promises keep the raw value and still count as unfinished work', async () => {
  const d = engine(), session = open(d);
  await session.transaction(async tx => {
    const value = await trackTransactionPromise(tx, tx.all('SELECT tracked'));
    assert.equal(value, d.results.get('SELECT tracked'));
  });
  let never;
  await assert.rejects(session.transaction(tx => { never = trackTransactionPromise(tx, new Promise(() => {})); }), code('TRANSACTION_PENDING'));
  assert.equal(d.calls.at(-1), 'ROLLBACK');
  void never;
  await session.close();
});

test('pending raw work at settlement is drained and rolled back, never committed', async () => {
  const d = engine(), held = d.hold('SELECT forgotten'), session = open(d);
  let forgotten;
  const run = session.transaction(tx => { forgotten = tx.all('SELECT forgotten'); });
  await held.started;
  held.release();
  await assert.rejects(run, code('TRANSACTION_PENDING'));
  assert.equal(await forgotten, d.results.get('SELECT forgotten'), 'the drained statement still answers its caller');
  assert.ok(!d.calls.includes('COMMIT'));
  assert.equal(d.calls.at(-1), 'ROLLBACK');
  assert.deepEqual(await session.all('SELECT after').then(value => value.command), 'SELECT');
  await session.close();
});

test('cancellation: pre-abort and queued abort send nothing; abort of an issued statement drains, then rolls back', async () => {
  const d = engine(), session = open(d, { maxQueue: 1 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(session.all('SELECT never', [], { signal: aborted.signal }), code('ABORTED'));
  assert.deepEqual(d.calls, []);

  const held = d.hold('SELECT held'), first = new AbortController();
  const running = session.transaction(tx => tx.all('SELECT held', [], { signal: first.signal }));
  await held.started;
  const queued = new AbortController();
  const waiting = session.all('SELECT queued', [], { signal: queued.signal });
  const waitingResult = waiting.then(() => null, error => error.code);
  await assert.rejects(session.all('SELECT overflow'), code('QUEUE_FULL'));
  queued.abort();
  assert.equal(await waitingResult, 'ABORTED');
  first.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!d.calls.includes('ROLLBACK'), 'the issued statement is drained first');
  held.release();
  await assert.rejects(running, code('ABORTED'));
  assert.equal(d.calls.at(-1), 'ROLLBACK');
  assert.ok(!d.calls.includes('SELECT queued') && !d.calls.includes('SELECT overflow'));
  await session.close();
});

test('unknown outcomes: an unbranded failure or malformed answer poisons once, nothing is replayed', async () => {
  const malformed = [
    ['thrown by the driver', () => { throw new Error('SYNTHETIC_PRIVATE_VALUE'); }],
    ['a row array instead of a raw result', () => [{ a: '1' }]],
    ['missing shape', () => ({ fields: [] })],
    ['null', () => null],
    ['undefined', () => undefined],
  ];
  for (const [name, answer] of malformed) {
    const d = engine(), session = open(d);
    d.answer = answer;
    await assert.rejects(session.all('SELECT 1'), error => { assert.equal(error.code, 'EXECUTION_UNCONFIRMED', name); assert.ok(!isAcknowledgedRejection(error)); assert.ok(!/SYNTHETIC/.test(error.message)); return true; });
    d.answer = raw;
    await assert.rejects(session.all('SELECT 2'), code('CONNECTION_UNUSABLE'), name);
    assert.deepEqual(d.calls, ['SELECT 1'], name);
    await session.close();
    assert.equal(d.closes, 1, name);
  }
});

test('unknown outcomes in a transaction: statement and COMMIT are never rolled back or replayed by inference', async () => {
  const d = engine(), session = open(d);
  let callbacks = 0;
  d.answer = () => { throw new Error('SYNTHETIC_PRIVATE_VALUE'); };
  await assert.rejects(session.transaction(async tx => { callbacks++; await tx.all('SELECT 1'); }), code('EXECUTION_UNCONFIRMED'));
  assert.equal(callbacks, 1);
  assert.ok(!d.calls.includes('ROLLBACK') && !d.calls.includes('COMMIT'));
  await session.close();

  const e = engine(), other = open(e);
  callbacks = 0;
  e.failExec = sql => sql === 'COMMIT' ? new Error('SYNTHETIC_PRIVATE_VALUE') : undefined;
  await assert.rejects(other.transaction(async tx => { callbacks++; await tx.all('SELECT 1'); }), code('COMMIT_UNCONFIRMED'));
  await assert.rejects(other.all('SELECT 2'), code('CONNECTION_UNUSABLE'));
  assert.equal(callbacks, 1);
  assert.ok(!e.calls.includes('ROLLBACK'));
  assert.equal(e.calls.filter(sql => sql === 'COMMIT').length, 1);
  await other.close();
  assert.equal(e.closes, 1);
});

test('a definite engine rejection is unchanged: branded, recoverable, and the session stays usable', async () => {
  const d = engine(), session = open(d);
  d.answer = sql => { if (sql === 'SELECT bad') throw acknowledgedRejection(new RowstitchError('CONSTRAINT', 'SYNTHETIC')); return raw(sql); };
  await assert.rejects(session.all('SELECT bad'), error => error.code === 'CONSTRAINT' && isAcknowledgedRejection(error));
  const out = await session.transaction(async tx => {
    await assert.rejects(tx.transaction(child => child.all('SELECT bad')), code('CONSTRAINT'));
    return tx.all('SELECT good');
  });
  assert.equal(out, d.results.get('SELECT good'));
  assert.equal(d.calls.at(-1), 'COMMIT');
  await session.close();
});

test('the guard runs once per result and its failure is an unknown outcome that reveals nothing', async () => {
  let seen = 0;
  const d = engine(), session = open(d, { isResult: value => { seen++; return isRaw(value); } });
  await session.all('SELECT 1');
  assert.equal(seen, 1);
  await session.transaction(tx => tx.all('SELECT 2'));
  assert.equal(seen, 2, 'control statements do not produce results');
  await session.close();

  const e = engine(), throwing = open(e, { isResult() { throw new Error('SYNTHETIC_PRIVATE_VALUE'); } });
  await assert.rejects(throwing.all('SELECT 1'), error => error.code === 'EXECUTION_UNCONFIRMED' && !/SYNTHETIC/.test(error.message));
  await assert.rejects(throwing.all('SELECT 2'), code('CONNECTION_UNUSABLE'));
  assert.deepEqual(e.calls, ['SELECT 1']);
  await throwing.close();
});

test('the default stays the row array: without a guard a raw object is malformed, and rows pass unchanged', async () => {
  const d = engine(), session = createAsyncSession(d.executor, { dialect: 'postgresql' });
  await assert.rejects(session.all('SELECT 1'), code('EXECUTION_UNCONFIRMED'), 'no silent acceptance of a non-array result');
  await session.close();

  const e = engine(), rows = [{ a: 1 }];
  e.answer = () => rows;
  for (const options of [undefined, {}, { isResult: undefined }]) {
    const fresh = createAsyncSession(e.executor, options);
    assert.equal(await fresh.all('SELECT 1'), rows);
    await fresh.close();
  }
});

test('an invalid guard is refused at construction', () => {
  const d = engine();
  for (const isResult of [null, true, 'yes', {}, 0]) assert.throws(() => createAsyncSession(d.executor, { isResult }), code('VALIDATION'));
  assert.throws(() => createAsyncSession(d.executor, { isResult: isRaw, retries: 3 }), code('VALIDATION'));
});
