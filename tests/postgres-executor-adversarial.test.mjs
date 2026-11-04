import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresExecutor } from '../dist/core/postgres-executor.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { isAcknowledgedRejection } from '../dist/core/executor.js';
import { isPostgresRawResult } from '../dist/core/postgres-result.js';

// Private fake transport. Responses are simulated: nothing here claims a live PostgreSQL server produced them.
const code = expected => error => error?.code === expected;
const verdict = (sqlstate, afterCommandComplete = false) => ({ sqlstate, afterCommandComplete });
const controlTag = sql => /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.exec(sql)?.[0] ?? 'SELECT 0';
const answer = (commandTag, rows = [], fields = []) => ({ fields, rows, commandTag });
const NONE = Object.freeze({ fields: [], rows: [], command: 'SELECT', rowCount: 0n });
const A_FIELD = [{ name: 'a', typeOid: 25 }];
const unconfirmed = error => !isAcknowledgedRejection(error);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fake() {
  const d = {
    sent: [], closes: 0, forced: 0, state: 'I', errors: new WeakMap(), respond: undefined,
    /** Matching statements fail with this SQLSTATE and leave the state a confirmed ordinary response leaves. */
    rejectWith(match, state) {
      const error = new Error('SYNTHETIC_PRIVATE_VALUE');
      d.errors.set(error, verdict(state));
      d.respond = sql => {
        if (!match.test(sql)) return;
        if (d.state === 'T') d.state = sql === 'COMMIT' ? 'I' : 'E';
        throw error;
      };
    },
    transport: {
      async query(sql, parameters) {
        d.sent.push({ sql, parameters });
        const custom = d.respond?.(sql, parameters);
        if (custom !== undefined) return custom;
        if (sql.startsWith('BEGIN')) d.state = 'T';
        if (sql === 'COMMIT' || sql === 'ROLLBACK') d.state = 'I';
        return answer(controlTag(sql));
      },
      transactionStatus() { return d.state; },
      serverError(error) { return d.errors.get(error); },
      async close() { d.closes++; },
      forceClose() { d.forced++; },
    },
  };
  return d;
}

test('explicitly unresolved SQLSTATEs never acknowledge a statement, and end the connection', async () => {
  for (const state of ['40003', '08007', '08006', '08003', '08P01', '57P01', '57P02', '57P03', '58030', 'XX000', 'XX001', '25P03', '25P04']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.rejectWith(/^SELECT/, state);
    await assert.rejects(executor.all('SELECT 1', []), error => { assert.ok(unconfirmed(error), state); assert.ok(!String(error.message).includes('SYNTHETIC')); return true; });
    d.respond = undefined;
    const sent = d.sent.length;
    await assert.rejects(executor.all('SELECT 2', []), unconfirmed);
    await assert.rejects(executor.inTransaction(), unconfirmed);
    assert.equal(d.sent.length, sent, 'nothing more is sent on a connection in an unknown state');
    await executor.close();
  }
});

test('an unresolved COMMIT response is unconfirmed through the session: no rollback, no replay, closed once', async () => {
  for (const state of ['40003', '08007', '08P01', '57P01', 'XX000', '42501', '57014', '53100']) {
    const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
    let callbacks = 0;
    d.rejectWith(/^COMMIT$/, state);
    await assert.rejects(session.transaction(async tx => { callbacks++; await tx.all('INSERT fixture', []); }), code('COMMIT_UNCONFIRMED'));
    await assert.rejects(session.all('SELECT fixture'), code('CONNECTION_UNUSABLE'));
    assert.equal(callbacks, 1, state);
    assert.ok(!d.sent.some(item => item.sql === 'ROLLBACK'), state);
    await session.close();
    assert.equal(d.closes, 1, state);
  }
});

test('definite failures keep their stable codes and leave the connection usable', async () => {
  for (const [state, expected] of [['23505', 'CONSTRAINT'], ['23P01', 'CONSTRAINT'], ['25006', 'READ_ONLY'], ['40001', 'SERIALIZATION_FAILURE'], ['40P01', 'DEADLOCK'], ['55P03', 'BUSY'], ['42601', 'DATABASE_ERROR'], ['57014', 'DATABASE_ERROR'], ['25P02', 'DATABASE_ERROR']]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.rejectWith(/^SELECT/, state);
    await assert.rejects(executor.all('SELECT 1', []), error => { assert.equal(error.code, expected); assert.ok(isAcknowledgedRejection(error)); return true; });
    d.respond = undefined;
    assert.deepEqual(await executor.all('SELECT 2', []), NONE, state);
    await executor.close();
  }
  for (const [state, expected] of [['23503', 'CONSTRAINT'], ['40001', 'SERIALIZATION_FAILURE'], ['40P01', 'DEADLOCK']]) {
    const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
    d.rejectWith(/^COMMIT$/, state);
    await assert.rejects(session.transaction(tx => tx.all('INSERT fixture', [])), code(expected));
    d.respond = undefined;
    assert.deepEqual(await session.all('SELECT 1'), NONE, 'a definite COMMIT failure rolls back and the session stays usable');
    await session.close();
  }
});

test('an autocommit error after CommandComplete is held to the COMMIT list; before it, and in a transaction, the ordinary rule stands', async () => {
  const LISTED = [['23503', 'CONSTRAINT'], ['23505', 'CONSTRAINT'], ['40001', 'SERIALIZATION_FAILURE'], ['40002', 'DATABASE_ERROR'], ['40P01', 'DEADLOCK'], ['P0001', 'DATABASE_ERROR']];
  const OFF_LIST = [['53100', 'DATABASE_ERROR'], ['42501', 'DATABASE_ERROR'], ['57014', 'DATABASE_ERROR'], ['22012', 'DATABASE_ERROR'], ['25P02', 'DATABASE_ERROR'], ['55P03', 'BUSY'], ['25006', 'READ_ONLY']];
  const attempt = async (before, after, sqlstate, afterCommandComplete, run = executor => executor.all('INSERT fixture', [])) => {
    const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    d.state = before;
    d.errors.set(error, verdict(sqlstate, afterCommandComplete));
    d.respond = () => { d.state = after; throw error; };
    const failure = await run(executor).then(() => assert.fail('must not succeed'), value => value);
    assert.ok(!/SYNTHETIC/.test(failure.message));
    d.respond = undefined;
    const usable = await executor.inTransaction().then(() => true, () => false);
    const sent = d.sent.length;
    await executor.close();
    return { acknowledged: isAcknowledgedRejection(failure), code: failure.code, usable, sent };
  };
  for (const [state, expected] of LISTED) assert.deepEqual(await attempt('I', 'I', state, true), { acknowledged: true, code: expected, usable: true, sent: 1 }, state);
  for (const [state] of OFF_LIST) assert.deepEqual(await attempt('I', 'I', state, true), { acknowledged: false, code: 'DATABASE_ERROR', usable: false, sent: 1 }, state);
  for (const [state, expected] of [...LISTED, ...OFF_LIST]) {
    assert.deepEqual(await attempt('I', 'I', state, false), { acknowledged: true, code: expected, usable: true, sent: 1 }, state + ' before the tag');
    assert.deepEqual(await attempt('T', 'E', state, true), { acknowledged: true, code: expected, usable: true, sent: 1 }, state + ' in a transaction');
    assert.deepEqual(await attempt('T', 'E', state, false), { acknowledged: true, code: expected, usable: true, sent: 1 }, state + ' in a transaction, before the tag');
    assert.deepEqual(await attempt('E', 'E', state, true), { acknowledged: true, code: expected, usable: true, sent: 1 }, state + ' in a failed transaction');
  }
  // The list adds to the transition rules; it does not replace them.
  for (const after of ['T', 'E']) assert.equal((await attempt('I', after, '23503', true)).acknowledged, false, 'a listed code with an impossible state');
  // Unresolved codes stay unresolved everywhere.
  for (const state of ['40003', '08007', '57P01', '58030', 'XX000']) for (const [before, after, tagged] of [['I', 'I', true], ['I', 'I', false], ['T', 'E', true], ['T', 'E', false]])
    assert.equal((await attempt(before, after, state, tagged)).acknowledged, false, state);
  // Explicit COMMIT is unchanged whichever way the tag falls.
  const commit = executor => executor.exec('COMMIT');
  for (const tagged of [true, false]) {
    assert.deepEqual(await attempt('T', 'I', '23503', tagged, commit), { acknowledged: true, code: 'CONSTRAINT', usable: true, sent: 1 });
    assert.equal((await attempt('T', 'I', '53100', tagged, commit)).acknowledged, false);
  }
});

test('through a real session: an off-list code after the tag is unconfirmed, closes once and replays nothing', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult }), error = new Error('SYNTHETIC_PRIVATE_VALUE');
  d.errors.set(error, verdict('53100', true));
  d.respond = () => { throw error; };
  await assert.rejects(session.all('INSERT fixture'), failure => failure.code === 'EXECUTION_UNCONFIRMED' && !/SYNTHETIC/.test(failure.message));
  await assert.rejects(session.all('SELECT fixture'), code('CONNECTION_UNUSABLE'));
  assert.deepEqual(d.sent.map(item => item.sql), ['INSERT fixture']);
  await session.close();
  assert.equal(d.closes, 1);
});

test('the verdict is validated strictly, without invoking accessors, and reveals nothing', async () => {
  let accessed = 0;
  const getterState = { get sqlstate() { accessed++; return '23505'; }, afterCommandComplete: false };
  const getterTag = { sqlstate: '23505', get afterCommandComplete() { accessed++; return false; } };
  const hidden = { sqlstate: '23505' }; Object.defineProperty(hidden, 'afterCommandComplete', { enumerable: false, value: false });
  class Verdict { sqlstate = '23505'; afterCommandComplete = false; }
  const malformed = [undefined, null, '23505', 23505, true, [], ['23505', false], {}, { sqlstate: '23505' }, { afterCommandComplete: false }, { sqlstate: '23505', afterCommandComplete: false, extra: 1 },
    { sqlstate: '23505', afterCommandComplete: 0 }, { sqlstate: '23505', afterCommandComplete: 'false' }, { sqlstate: '23505', afterCommandComplete: null }, { sqlstate: '23505', afterCommandComplete: undefined },
    { sqlstate: 23505, afterCommandComplete: false }, { sqlstate: '', afterCommandComplete: false }, { sqlstate: '2350', afterCommandComplete: false }, { sqlstate: '235050', afterCommandComplete: false }, { sqlstate: '23a05', afterCommandComplete: false },
    getterState, getterTag, hidden, new Verdict(), new Proxy({}, { ownKeys() { throw new Error('SYNTHETIC_TRAP'); } }), Promise.resolve({ sqlstate: '23505', afterCommandComplete: false })];
  for (const value of malformed) {
    const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    d.errors.set(error, value);
    d.respond = () => { throw error; };
    await assert.rejects(executor.all('SELECT 1', []), failure => { assert.ok(unconfirmed(failure)); assert.notEqual(failure, error); assert.ok(!/SYNTHETIC/.test(failure.message)); return true; });
    await assert.rejects(executor.inTransaction(), unconfirmed, 'the connection ended');
    await executor.close();
  }
  assert.equal(accessed, 0);
  for (const value of [Object.freeze(verdict('23505')), Object.assign(Object.create(null), verdict('23505'))]) {
    const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    d.errors.set(error, value);
    d.respond = () => { throw error; };
    await assert.rejects(executor.all('SELECT 1', []), failure => failure.code === 'CONSTRAINT' && isAcknowledgedRejection(failure));
    await executor.close();
  }
});

test('only a valid SQLSTATE from the transport can acknowledge; a throwing classifier reveals nothing', async () => {
  for (const state of [undefined, null, 23505, '', '2350', '235050', '23a05', {}, true]) {
    const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    d.errors.set(error, verdict(state));
    d.respond = () => { throw error; };
    await assert.rejects(executor.all('SELECT 1', []), failure => { assert.ok(unconfirmed(failure)); assert.notEqual(failure, error); return true; });
    await executor.close();
  }
  const d = fake(), error = new Error('SYNTHETIC_PRIVATE_VALUE');
  d.respond = () => { throw error; };
  d.transport.serverError = () => { throw new Error('SYNTHETIC_PRIVATE_CLASSIFIER'); };
  const executor = createPostgresExecutor(d.transport);
  await assert.rejects(executor.all('SELECT 1', []), failure => { assert.ok(unconfirmed(failure)); assert.ok(!/SYNTHETIC/.test(failure.message)); return true; });
  await executor.close();
});

test('an ordinary response on a connection that cannot then report valid state is unconfirmed', async () => {
  for (const broken of [() => { throw new Error('SYNTHETIC_LOST'); }, () => 'X', () => null]) {
    const d = fake(), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    let afterResponse = false;
    d.errors.set(error, verdict('23505'));
    d.respond = () => { afterResponse = true; throw error; };
    const executor = createPostgresExecutor({ ...d.transport, transactionStatus: () => afterResponse ? broken() : 'I' });
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed);
    await executor.close();
  }
});

test('transaction state: T and E are in a transaction, I is not; anything else is unconfirmed and ends the connection', async () => {
  for (const [state, expected] of [['I', false], ['T', true], ['E', true]]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = state;
    assert.equal(await executor.inTransaction(), expected, state);
    await executor.close();
  }
  for (const state of ['X', '', null, undefined, 1]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = state;
    await assert.rejects(executor.inTransaction(), unconfirmed);
    d.state = 'I';
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed);
    assert.deepEqual(d.sent, []);
    await executor.close();
  }
  const d = fake(), executor = createPostgresExecutor({ ...d.transport, transactionStatus() { throw new Error('SYNTHETIC_LOST'); } });
  await assert.rejects(executor.inTransaction(), error => unconfirmed(error) && !/SYNTHETIC/.test(error.message));
  await executor.close();
  const closed = fake(), closing = createPostgresExecutor(closed.transport);
  await closing.close();
  await assert.rejects(closing.inTransaction(), code('CLOSED'));
});

test('an aborted (E) transaction is rolled back by the session, not mistaken for idle', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult }), original = new Error('callback failure');
  await assert.rejects(session.transaction(async () => { d.state = 'E'; throw original; }), error => error === original);
  assert.ok(d.sent.some(item => item.sql === 'ROLLBACK'));
  assert.equal(d.state, 'I');
  await session.close();
});

test('every control command must return its own tag and reach its expected state', async () => {
  const cases = [
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'I', 'BEGIN', 'T'], ['BEGIN READ ONLY', 'I', 'BEGIN', 'T'], ['COMMIT', 'T', 'COMMIT', 'I'], ['ROLLBACK', 'T', 'ROLLBACK', 'I'],
    ['SAVEPOINT "a"', 'T', 'SAVEPOINT', 'T'], ['RELEASE SAVEPOINT "a"', 'T', 'RELEASE', 'T'], ['ROLLBACK TO SAVEPOINT "a"', 'E', 'ROLLBACK', 'T'],
  ];
  for (const [sql, before, tag, after] of cases) {
    const accepted = fake(), good = createPostgresExecutor(accepted.transport);
    accepted.state = before;
    accepted.respond = () => { accepted.state = after; return answer(tag); };
    await good.exec(sql);
    await good.close();
    const wrongTag = fake(), tagged = createPostgresExecutor(wrongTag.transport);
    wrongTag.state = before;
    wrongTag.respond = () => { wrongTag.state = after; return answer('SELECT 0'); };
    await assert.rejects(tagged.exec(sql), unconfirmed, sql + ' wrong tag');
    await tagged.close();
    const wrongState = fake(), stateful = createPostgresExecutor(wrongState.transport);
    wrongState.state = before;
    wrongState.respond = () => { wrongState.state = after === 'I' ? 'T' : 'I'; return answer(tag); };
    await assert.rejects(stateful.exec(sql), unconfirmed, sql + ' wrong state');
    await stateful.close();
  }
});

test('control commands in an impossible state send nothing: COMMIT with no transaction cannot report success', async () => {
  for (const [sql, state] of [['COMMIT', 'I'], ['SAVEPOINT "a"', 'I'], ['RELEASE SAVEPOINT "a"', 'I'], ['ROLLBACK TO SAVEPOINT "a"', 'I'], ['BEGIN READ ONLY', 'T'], ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'E']]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = state;
    await assert.rejects(executor.exec(sql), unconfirmed, sql);
    assert.deepEqual(d.sent, [], sql);
    await executor.close();
  }
  const aborted = fake(), executor = createPostgresExecutor(aborted.transport);
  aborted.state = 'E';
  aborted.respond = () => { aborted.state = 'E'; return answer('ROLLBACK'); };
  await assert.rejects(executor.exec('COMMIT'), unconfirmed, 'ROLLBACK tag that leaves a transaction open is not a confirmed rollback');
  await executor.close();
});

test('a failed transaction cannot be healed by a success: only a rollback leaves E', async () => {
  for (const [sql, tag, after] of [['COMMIT', 'COMMIT', 'I'], ['SAVEPOINT "a"', 'SAVEPOINT', 'T'], ['RELEASE SAVEPOINT "a"', 'RELEASE', 'T'], ['SAVEPOINT "a"', 'SAVEPOINT', 'E'], ['RELEASE SAVEPOINT "a"', 'RELEASE', 'E']]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = 'E';
    d.respond = () => { d.state = after; return answer(tag); };
    await assert.rejects(executor.exec(sql), unconfirmed, sql + ' from E to ' + after);
    assert.equal(d.sent.length, 1, sql);
    d.respond = undefined;
    await assert.rejects(executor.all('SELECT 2', []), unconfirmed, 'the connection ended');
    assert.equal(d.sent.length, 1, sql);
    await executor.close();
  }
  for (const after of ['E', 'T', 'I']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = 'E';
    d.respond = () => { d.state = after; return answer('SELECT 0'); };
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed, 'statement success from E to ' + after);
    await executor.close();
  }
});

test('valid transitions stay valid: every success the protocol allows, from each prior state', async () => {
  for (const [sql, before, tag, after] of [
    ['BEGIN READ ONLY', 'I', 'BEGIN', 'T'], ['COMMIT', 'T', 'COMMIT', 'I'], ['ROLLBACK', 'I', 'ROLLBACK', 'I'], ['ROLLBACK', 'T', 'ROLLBACK', 'I'], ['ROLLBACK', 'E', 'ROLLBACK', 'I'],
    ['SAVEPOINT "a"', 'T', 'SAVEPOINT', 'T'], ['RELEASE SAVEPOINT "a"', 'T', 'RELEASE', 'T'], ['ROLLBACK TO SAVEPOINT "a"', 'T', 'ROLLBACK', 'T'], ['ROLLBACK TO SAVEPOINT "a"', 'E', 'ROLLBACK', 'T'],
  ]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = before;
    d.respond = () => { d.state = after; return answer(tag); };
    await executor.exec(sql);
    d.respond = undefined;
    assert.equal(await executor.inTransaction(), after !== 'I', sql + ' from ' + before);
    await executor.close();
  }
  for (const state of ['I', 'T']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = state;
    d.respond = () => answer('SELECT 1', [['1']], A_FIELD);
    assert.deepEqual(await executor.all('SELECT 1', []), { fields: A_FIELD, rows: [['1']], command: 'SELECT', rowCount: 1n }, state);
    await executor.close();
  }
  const d = fake(), executor = createPostgresExecutor(d.transport);
  d.state = 'E';
  d.respond = () => { d.state = 'I'; return answer('ROLLBACK'); };
  await assert.rejects(executor.exec('COMMIT'), error => error.code === 'TRANSACTION_ABORTED' && isAcknowledgedRejection(error));
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
});

test('a ROLLBACK tag answering COMMIT is a definite rollback only from a failed transaction that ends idle', async () => {
  for (const [before, after] of [['T', 'I'], ['T', 'T'], ['T', 'E'], ['E', 'E'], ['E', 'T']]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = before;
    d.respond = () => { d.state = after; return answer('ROLLBACK'); };
    await assert.rejects(executor.exec('COMMIT'), unconfirmed, before + ' to ' + after);
    d.respond = undefined;
    await assert.rejects(executor.inTransaction(), unconfirmed, 'the connection ended');
    assert.equal(d.sent.length, 1);
    await executor.close();
  }
});

const STATES = ['I', 'T', 'E'];
async function rejectionOutcome(run, before, after, state) {
  const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
  d.state = before;
  d.errors.set(error, verdict(state));
  d.respond = () => { d.state = after; throw error; };
  const outcome = await run(executor).then(() => 'success', failure => {
    assert.ok(!/SYNTHETIC/.test(failure.message));
    return isAcknowledgedRejection(failure) ? 'acknowledged' : 'unconfirmed';
  });
  d.respond = undefined;
  const sent = d.sent.length;
  const usable = await executor.inTransaction().then(() => true, () => false);
  assert.equal(usable, outcome === 'acknowledged', 'only a definite rejection leaves the connection usable');
  assert.equal(d.sent.length, sent);
  await executor.close();
  return outcome;
}

test('an ordinary statement rejection must leave the state a rejection leaves: every prior and resulting state', async () => {
  const valid = new Set(['I>I', 'T>E', 'E>E']);
  for (const before of STATES) for (const after of STATES) {
    assert.equal(await rejectionOutcome(executor => executor.all('SELECT 1', []), before, after, '23505'), valid.has(before + '>' + after) ? 'acknowledged' : 'unconfirmed', before + ' to ' + after);
  }
});

test('a control rejection must leave the state that command leaves: every command, prior state and resulting state', async () => {
  const table = [
    ['BEGIN READ ONLY', ['I'], [], '42601'],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', ['I'], [], '42601'],
    ['COMMIT', ['T', 'E'], ['T>I'], '23503'],
    ['ROLLBACK', ['I', 'T', 'E'], [], '42601'],
    ['SAVEPOINT "a"', ['T', 'E'], ['E>E'], '25P02'],
    ['RELEASE SAVEPOINT "a"', ['T', 'E'], ['T>E', 'E>E'], '25P02'],
    ['ROLLBACK TO SAVEPOINT "a"', ['T', 'E'], ['T>E', 'E>E'], '3B001'],
  ];
  for (const [sql, send, valid, state] of table) for (const before of send) for (const after of STATES) {
    assert.equal(await rejectionOutcome(executor => executor.exec(sql), before, after, state), valid.includes(before + '>' + after) ? 'acknowledged' : 'unconfirmed', sql + ' ' + before + ' to ' + after);
  }
});

test('session: a rejection claiming to heal a failed transaction cannot lead to a commit', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  d.respond = sql => {
    if (sql === 'SELECT fail') { const error = new Error('SYNTHETIC_PRIVATE_VALUE'); d.errors.set(error, verdict('23505')); d.state = 'E'; throw error; }
    if (sql === 'SELECT heal') { const error = new Error('SYNTHETIC_PRIVATE_VALUE'); d.errors.set(error, verdict('25P02')); d.state = 'T'; throw error; }
    return undefined;
  };
  await assert.rejects(session.transaction(async tx => {
    await assert.rejects(tx.all('SELECT fail'), code('CONSTRAINT'));
    await assert.rejects(tx.all('SELECT heal'), code('EXECUTION_UNCONFIRMED'));
  }), code('EXECUTION_UNCONFIRMED'));
  assert.ok(!d.sent.some(entry => entry.sql === 'COMMIT'));
  await session.close();
});

test('in a failed transaction, ordinary rejections are still sent for and acknowledged, and leave recovery possible', async () => {
  for (const sql of ['SAVEPOINT "a"', 'RELEASE SAVEPOINT "a"', 'ROLLBACK TO SAVEPOINT "a"']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = 'E';
    d.rejectWith(/./, '25P02');
    await assert.rejects(executor.exec(sql), error => error.code === 'DATABASE_ERROR' && isAcknowledgedRejection(error), sql);
    assert.deepEqual(d.sent.map(entry => entry.sql), [sql]);
    d.respond = () => { d.state = 'T'; return answer('ROLLBACK'); };
    await executor.exec('ROLLBACK TO SAVEPOINT "b"');
    assert.equal(await executor.inTransaction(), true, 'recovered, and the connection did not end');
    await executor.close();
  }
  const d = fake(), executor = createPostgresExecutor(d.transport);
  d.state = 'E';
  d.rejectWith(/^SELECT/, '25P02');
  await assert.rejects(executor.all('SELECT 1', []), error => error.code === 'DATABASE_ERROR' && isAcknowledgedRejection(error));
  d.respond = () => { d.state = 'I'; return answer('ROLLBACK'); };
  await executor.exec('ROLLBACK');
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
});

test('session: a child in a failed parent is refused by the engine, the parent is not poisoned, and nothing commits as success', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  let failing = true;
  d.respond = sql => {
    if (sql === 'SELECT fail' && failing) { d.state = 'E'; const error = new Error('SYNTHETIC_PRIVATE_VALUE'); d.errors.set(error, verdict('23505')); throw error; }
    if (/^(?:SAVEPOINT|RELEASE)/.test(sql) && d.state === 'E') { const error = new Error('SYNTHETIC_PRIVATE_VALUE'); d.errors.set(error, verdict('25P02')); throw error; }
    if (sql === 'COMMIT' && d.state === 'E') { d.state = 'I'; return answer('ROLLBACK'); }
    return undefined;
  };
  await assert.rejects(session.transaction(async tx => {
    await assert.rejects(tx.all('SELECT fail'), code('CONSTRAINT'));
    await assert.rejects(tx.transaction(async () => 'never'), isAcknowledgedRejection);
  }), code('TRANSACTION_ABORTED'));
  assert.equal(d.sent.at(-1).sql, 'COMMIT');
  failing = false;
  assert.deepEqual(await session.all('SELECT after'), NONE, 'the session continues');
  await session.close();
});

test('prior status is captured once, before sending, and validates the response', async () => {
  const d = fake();
  let reads = 0, readsWhenSent = -1;
  const executor = createPostgresExecutor({
    ...d.transport,
    transactionStatus() { reads++; return d.state; },
    async query(sql, parameters) { readsWhenSent = reads; return d.transport.query(sql, parameters); },
  });
  d.state = 'T';
  await executor.exec('SAVEPOINT "a"');
  assert.equal(readsWhenSent, 1, 'exec');
  reads = 0;
  await executor.all('SELECT 1', []);
  assert.equal(readsWhenSent, 1, 'all');
  assert.equal(reads, 2, 'once before and once after');
  await executor.close();
});

test('transaction control through a statement cannot lead to a false commit', async () => {
  for (const tag of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'COMMIT PREPARED', 'ROLLBACK', 'ROLLBACK PREPARED', 'SAVEPOINT', 'RELEASE', 'PREPARE TRANSACTION', 'SET', 'RESET', 'DISCARD ALL', 'LISTEN', 'UNLISTEN']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer(tag);
    await assert.rejects(executor.all('SELECT fixture', []), unconfirmed, tag);
    await executor.close();
  }
  // A procedure can change state without a telltale tag.
  const d = fake(), executor = createPostgresExecutor(d.transport);
  d.state = 'T';
  d.respond = () => { d.state = 'I'; return answer('CALL'); };
  await assert.rejects(executor.all('CALL fixture()', []), unconfirmed);
  await executor.close();
  const s = fake(), session = createAsyncSession(createPostgresExecutor(s.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  s.respond = sql => { if (sql === 'ROLLBACK fixture') { s.state = 'I'; return answer('ROLLBACK'); } return undefined; };
  await assert.rejects(session.transaction(async tx => { await tx.all('ROLLBACK fixture', []); return 'callback finished'; }), code('EXECUTION_UNCONFIRMED'));
  assert.ok(!s.sent.some(item => item.sql === 'COMMIT'));
  await session.close();
});

test('results become detached, frozen, branded snapshots; malformed responses are never acknowledged', async () => {
  let accessed = 0;
  const accessorCell = []; Object.defineProperty(accessorCell, 0, { enumerable: true, get() { accessed++; throw new Error('must not invoke an output getter'); } });
  const hiddenCell = []; Object.defineProperty(hiddenCell, 0, { enumerable: false, value: 'x' });
  const symbolRow = ['x']; symbolRow[Symbol('k')] = 'x';
  const extraRow = ['x']; extraRow.extra = 'x';
  class Row extends Array {}
  const hostile = { get fields() { accessed++; throw new Error('SYNTHETIC_GETTER'); }, rows: [], commandTag: 'SELECT 0' };
  const getterTag = { fields: [], rows: [], get commandTag() { accessed++; return 'SELECT 0'; } };
  const hiddenKey = { fields: [], rows: [] }; Object.defineProperty(hiddenKey, 'commandTag', { enumerable: false, value: 'SELECT 0' });
  const malformed = [
    answer('SELECT 2', new Array(2), A_FIELD), answer('SELECT 3', [['1'], , ['2']], A_FIELD), answer('SELECT 0', false, A_FIELD), [],
    answer(null), answer(7), { rows: [], commandTag: 'SELECT 0' }, { fields: [], commandTag: 'SELECT 0' }, { fields: [], rows: [] }, { fields: [], rows: [], commandTag: 'SELECT 0', extra: 1 },
    { fields: [], rows: [], command: 'SELECT', rowCount: 0n }, null, undefined, 'SELECT 0', new (class Envelope { fields = []; rows = []; commandTag = 'SELECT 0'; })(),
    answer('SELECT 1', [null], A_FIELD), answer('SELECT 1', [[]], A_FIELD), answer('SELECT 1', ['text'], A_FIELD), answer('SELECT 1', [Row.from(['x'])], A_FIELD), answer('SELECT 1', [['x', 'y']], A_FIELD),
    answer('SELECT 1', [[9007199254740992]], A_FIELD), answer('SELECT 1', [[1n]], A_FIELD), answer('SELECT 1', [[undefined]], A_FIELD), answer('SELECT 1', [[new Uint8Array(1)]], A_FIELD),
    answer('SELECT 1', [accessorCell], A_FIELD), answer('SELECT 1', [hiddenCell], A_FIELD), answer('SELECT 1', [symbolRow], A_FIELD), answer('SELECT 1', [extraRow], A_FIELD),
    answer('SELECT 1', [new Proxy([], { ownKeys() { throw new Error('SYNTHETIC_TRAP'); } })], A_FIELD), new Proxy({}, { ownKeys() { throw new Error('SYNTHETIC_TRAP'); } }), hostile, getterTag, hiddenKey,
    answer('SELECT 0', [], [{ name: 'a' }]), answer('SELECT 0', [], [{ name: 'a', typeOid: 0 }]), answer('SELECT 0', [], [{ name: 'a', typeOid: 1.5 }]), answer('SELECT 0', [], [{ name: 'a', typeOid: 2 ** 32 }]),
    answer('SELECT 0', [], [{ name: 'a\0b', typeOid: 25 }]), answer('SELECT 0', [], [{ name: '\ud800', typeOid: 25 }]), answer('SELECT 0', [], [{ name: 'a', typeOid: 25, extra: 1 }]),
  ];
  for (const response of malformed) {
    // Direct, because the fake's respond hook reads undefined as "use the default answer".
    const d = fake(), executor = createPostgresExecutor({ ...d.transport, async query(sql) { d.sent.push({ sql }); return response; } });
    await assert.rejects(executor.all('SELECT 1', []), error => unconfirmed(error) && !/SYNTHETIC/.test(error.message));
    await assert.rejects(executor.all('SELECT 2', []), unconfirmed, 'a malformed success ends the connection');
    assert.equal(d.sent.length, 1);
    await executor.close();
  }
  assert.equal(accessed, 0, 'accessors are never invoked');
  const once = fake(), executor = createPostgresExecutor(once.transport);
  const original = [['1', null]], fields = [{ name: 'a', typeOid: 25 }, { name: 'a', typeOid: 20 }];
  once.respond = () => answer('SELECT 1', original, fields);
  const copied = await executor.all('SELECT 1', []);
  assert.deepEqual(copied, { fields, rows: [['1', null]], command: 'SELECT', rowCount: 1n }, 'duplicate raw names stay separate');
  assert.ok(isPostgresRawResult(copied));
  assert.notEqual(copied.rows, original); assert.notEqual(copied.rows[0], original[0]); assert.notEqual(copied.fields, fields);
  original[0][0] = 'changed later'; fields[0].typeOid = 1;
  assert.equal(copied.rows[0][0], '1'); assert.equal(copied.fields[0].typeOid, 25);
  for (const frozen of [copied, copied.rows, copied.rows[0], copied.fields, copied.fields[0]]) assert.ok(Object.isFrozen(frozen));
  await executor.close();
});

test('the command tag is parsed exactly: verb and count come only from its own text', async () => {
  const accepted = [
    ['SELECT 0', 'SELECT', 0n], ['UPDATE 12', 'UPDATE', 12n], ['DELETE 1', 'DELETE', 1n], ['MERGE 3', 'MERGE', 3n], ['COPY 4', 'COPY', 4n], ['MOVE 5', 'MOVE', 5n], ['FETCH 0', 'FETCH', 0n],
    ['INSERT 0 7', 'INSERT', 7n], ['CREATE TABLE', 'CREATE', null], ['CREATE MATERIALIZED VIEW', 'CREATE', null], ['ALTER TABLE', 'ALTER', null], ['DO', 'DO', null], ['CALL', 'CALL', null], ['SHOW', 'SHOW', null], ['EXPLAIN', 'EXPLAIN', null],
    // Beyond a Number's exact range: exact, not rounded.
    ['UPDATE 9007199254740993', 'UPDATE', 9007199254740993n], ['UPDATE 18446744073709551615', 'UPDATE', 18446744073709551615n], ['INSERT 0 18446744073709551615', 'INSERT', 18446744073709551615n],
  ];
  for (const [tag, command, rowCount] of accepted) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer(tag);
    assert.deepEqual(await executor.all('SELECT 1', []), { fields: [], rows: [], command, rowCount }, tag);
    await executor.close();
  }
  const refused = ['', ' ', 'SELECT', 'INSERT', 'INSERT 1', 'INSERT 5 1', 'INSERT 0', 'INSERT 0 1 1', 'UPDATE', 'UPDATE 01', 'UPDATE -1', 'UPDATE 1.5', 'UPDATE 1e3', 'UPDATE +1', 'UPDATE  1', ' UPDATE 1', 'UPDATE 1 ', 'UPDATE 1\n', 'update 1', 'Update 1',
    'SELECT 18446744073709551616', 'UPDATE 99999999999999999999', 'UPDATE 100000000000000000000', 'CREATE TABLE 5', 'CREATE 5', 'DO 1', 'select', 'unexpected', '123', 'A'.repeat(65), 'SELECT 1 extra', 'SELECT\t1'];
  // Non-strings whose text form would otherwise look valid.
  refused.push({ toString() { return 'SELECT 0'; } }, ['SELECT 0'], new String('SELECT 0'));
  for (const tag of refused) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer(tag);
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed, String(tag));
    await assert.rejects(executor.inTransaction(), unconfirmed, 'a malformed tag ends the connection');
    await executor.close();
  }
});

test('a tag counting other rows is refused, while a write with no returned rows keeps its own count', async () => {
  for (const [tag, rows] of [['SELECT 2', [['1']]], ['SELECT 0', [['1']]], ['SELECT 1', []], ['INSERT 0 2', [['1']]], ['UPDATE 0', [['1']]], ['DELETE 3', []]]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer(tag, rows, A_FIELD);
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed, tag);
    await executor.close();
  }
  const zeroColumns = fake(), executor = createPostgresExecutor(zeroColumns.transport);
  zeroColumns.respond = () => answer('SELECT 2', [[], []]);
  assert.equal((await executor.all('SELECT FROM t', [])).rowCount, 2n);
  zeroColumns.respond = () => answer('SELECT 3', [[], []]);
  await assert.rejects(executor.all('SELECT FROM t', []), unconfirmed, 'zero-column rows are still counted');
  await executor.close();
  const written = fake(), other = createPostgresExecutor(written.transport);
  written.respond = () => answer('UPDATE 5');
  assert.equal((await other.all('UPDATE t SET a=1', [])).rowCount, 5n, 'the count is the tag, not the returned row length');
  written.respond = () => answer('SHOW', [['1'], ['2']], A_FIELD);
  assert.equal((await other.all('SHOW x', [])).rowCount, null, 'an uncounted tag gets no inferred count');
  await other.close();
});

test('a control command must answer with exactly its tag: no fields, no rows, no count and no extra words', async () => {
  for (const [sql, before, tag, after] of [['BEGIN READ ONLY', 'I', 'BEGIN', 'T'], ['COMMIT', 'T', 'COMMIT', 'I'], ['ROLLBACK', 'T', 'ROLLBACK', 'I'], ['SAVEPOINT "a"', 'T', 'SAVEPOINT', 'T'], ['RELEASE SAVEPOINT "a"', 'T', 'RELEASE', 'T'], ['ROLLBACK TO SAVEPOINT "a"', 'E', 'ROLLBACK', 'T']]) {
    for (const response of [answer(tag, [], A_FIELD), answer(tag, [[]]), answer(tag + ' 1'), answer(tag + ' EXTRA'), answer('SELECT 0')]) {
      const d = fake(), executor = createPostgresExecutor(d.transport);
      d.state = before;
      d.respond = () => { d.state = after; return response; };
      await assert.rejects(executor.exec(sql), unconfirmed, sql + ' ' + JSON.stringify(response));
      await assert.rejects(executor.inTransaction(), unconfirmed, 'the connection ended');
      await executor.close();
    }
  }
  for (const response of [answer('ROLLBACK', [], A_FIELD), answer('ROLLBACK', [[]]), answer('ROLLBACK PREPARED'), answer('COMMIT PREPARED')]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.state = 'E';
    d.respond = () => { d.state = 'I'; return response; };
    await assert.rejects(executor.exec('COMMIT'), unconfirmed, JSON.stringify(response));
    await executor.close();
  }
});

test('the executor result works through a real generic session, and the default session refuses it', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  d.respond = sql => sql.startsWith('SELECT') ? answer('SELECT 1', [['1']], A_FIELD) : undefined;
  const expected = { fields: A_FIELD, rows: [['1']], command: 'SELECT', rowCount: 1n };
  const out = await session.all('SELECT root');
  assert.deepEqual(out, expected);
  assert.ok(isPostgresRawResult(out));
  assert.deepEqual(await session.transaction(tx => tx.transaction(child => child.all('SELECT child'))), expected);
  await session.close();
  const e = fake(), byDefault = createAsyncSession(createPostgresExecutor(e.transport), { dialect: 'postgresql' });
  await assert.rejects(byDefault.all('SELECT 1'), code('EXECUTION_UNCONFIRMED'), 'a default session treats a raw result as malformed');
  await byDefault.close();
});

test('a malformed success ends the connection: nothing more is sent, and an inherited row is not a row', async () => {
  const inherited = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: ['inherited'] }));
  assert.equal(Array.isArray(inherited), true);
  for (const rows of [inherited, [[1]]]) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer('SELECT 1', rows, A_FIELD);
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed);
    d.respond = undefined;
    await assert.rejects(executor.all('SELECT 2', []), unconfirmed);
    assert.equal(d.sent.length, 1);
    await executor.close();
  }
});

test('transaction control tags are recognised in any case', async () => {
  for (const command of ['commit', 'Rollback', 'set', 'COMMIT PREPARED']) {
    const d = fake(), executor = createPostgresExecutor(d.transport);
    d.respond = () => answer(command);
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed);
    await executor.close();
  }
});

test('a completed request cancels its own deadline', async () => {
  const d = fake(), executor = createPostgresExecutor(d.transport, { requestTimeoutMs: 15 });
  assert.deepEqual(await executor.all('SELECT 1', []), NONE);
  await pause(40);
  assert.deepEqual(await executor.all('SELECT 2', []), NONE, 'an earlier deadline does not end the connection later');
  d.rejectWith(/^SELECT/, '23505');
  await assert.rejects(executor.all('SELECT 3', []), code('CONSTRAINT'));
  await pause(40);
  d.respond = undefined;
  assert.deepEqual(await executor.all('SELECT 4', []), NONE);
  await executor.close();
});

test('input validation: parameter limit, values and SQL', async () => {
  const d = fake(), executor = createPostgresExecutor(d.transport);
  await executor.all('SELECT 1', new Array(10_000).fill(1));
  assert.equal(d.sent.length, 1);
  for (const [sql, parameters] of [['SELECT 1', new Array(10_001).fill(1)], ['SELECT 1\0', []], ['', []], [1, []], ['SELECT 1', 'x'], ['SELECT $1', [NaN]], ['SELECT $1', [Infinity]], ['SELECT $1', [undefined]], ['SELECT $1', [true]], ['SELECT $1', [{}]]])
    await assert.rejects(executor.all(sql, parameters), code('VALIDATION'));
  assert.equal(d.sent.length, 1);
  await executor.close();
  for (const options of [{ requestTimeoutMs: 0 }, { requestTimeoutMs: 120_001 }, { requestTimeoutMs: 1.5 }, { requestTimeoutMs: '5' }, { closeTimeoutMs: 0 }, { closeTimeoutMs: 60_001 }, { other: 1 }, null])
    assert.throws(() => createPostgresExecutor(fake().transport, options), code('VALIDATION'));
  assert.throws(() => createPostgresExecutor({ ...fake().transport, close: undefined }), code('VALIDATION'));
});

test('a request past its deadline is unconfirmed; late results are ignored; nothing more is sent', async t => {
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  for (const late of ['result', 'rejection']) {
    const d = fake();
    let finish;
    const held = new Promise((resolve, reject) => { finish = () => late === 'result' ? resolve(answer('SELECT 1', [['late']], A_FIELD)) : reject(new Error('SYNTHETIC_LATE')); });
    d.transport.query = async sql => { d.sent.push({ sql }); return held; };
    const started = Date.now();
    const outcome = createPostgresExecutor(d.transport, { requestTimeoutMs: 15 });
    await assert.rejects(outcome.all('SELECT pg_sleep(30)', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); assert.ok(unconfirmed(error)); return true; });
    assert.ok(Date.now() - started < 5_000);
    const sent = d.sent.length;
    await assert.rejects(outcome.all('SELECT 1', []), unconfirmed);
    await assert.rejects(outcome.inTransaction(), unconfirmed);
    assert.equal(d.sent.length, sent);
    finish();
    await pause(10);
    await assert.rejects(outcome.all('SELECT 1', []), unconfirmed, 'a late result does not restore the connection');
    await outcome.close();
  }
  assert.deepEqual(unhandled, []);
});

test('session: a hung statement or COMMIT cannot hold the connection forever, and nothing is replayed', async () => {
  for (const [hang, expected] of [[/^INSERT/, 'EXECUTION_UNCONFIRMED'], [/^COMMIT$/, 'COMMIT_UNCONFIRMED']]) {
    const d = fake();
    const base = d.transport.query.bind(d.transport);
    d.transport.query = (sql, parameters) => hang.test(sql) ? new Promise(() => {}) : base(sql, parameters);
    const session = createAsyncSession(createPostgresExecutor(d.transport, { requestTimeoutMs: 15 }), { dialect: 'postgresql', isResult: isPostgresRawResult });
    let callbacks = 0;
    const running = session.transaction(async tx => { callbacks++; await tx.all('INSERT fixture', []); });
    const queued = session.all('SELECT 1');
    await assert.rejects(running, code(expected));
    await assert.rejects(queued, code('CONNECTION_UNUSABLE'));
    assert.equal(callbacks, 1);
    assert.ok(!d.sent.some(item => item.sql === 'ROLLBACK'));
    await session.close();
    assert.equal(d.closes, 1, 'the owned connection was requested closed once');
  }
});

test('close is requested once, bounded and honest: failure or timeout never claims closure and reveals nothing', async () => {
  const hanging = fake();
  hanging.transport.close = async () => { hanging.closes++; await new Promise(() => {}); };
  const a = createPostgresExecutor(hanging.transport, { closeTimeoutMs: 15 });
  const first = a.close(), second = a.close();
  assert.equal(first, second);
  await assert.rejects(first, error => { assert.equal(error.code, 'CLOSE_UNCONFIRMED'); assert.ok(unconfirmed(error)); return true; });
  assert.equal(hanging.closes, 1); assert.equal(hanging.forced, 1);
  await assert.rejects(a.all('SELECT 1', []), code('CLOSED'));

  const failing = fake();
  failing.transport.close = async () => { failing.closes++; throw new Error('SYNTHETIC_PRIVATE_HOST credentials'); };
  const b = createPostgresExecutor(failing.transport);
  await assert.rejects(b.close(), error => { assert.equal(error.code, 'CLOSE_UNCONFIRMED'); assert.ok(!/SYNTHETIC/.test(error.message + String(error.stack))); return true; });
  assert.equal(failing.forced, 1);

  const thrower = fake();
  thrower.transport.close = () => { throw new Error('SYNTHETIC_SYNC'); };
  thrower.transport.forceClose = () => { throw new Error('SYNTHETIC_FORCE'); };
  await assert.rejects(createPostgresExecutor(thrower.transport).close(), error => error.code === 'CLOSE_UNCONFIRMED' && !/SYNTHETIC/.test(error.message));

  const noForce = fake();
  noForce.transport.close = async () => { throw new Error('x'); };
  delete noForce.transport.forceClose;
  await assert.rejects(createPostgresExecutor(noForce.transport).close(), code('CLOSE_UNCONFIRMED'));

  const clean = fake(), c = createPostgresExecutor(clean.transport);
  await c.close();
  assert.equal(clean.closes, 1); assert.equal(clean.forced, 0);

  const failingSession = fake();
  failingSession.transport.close = async () => { throw new Error('SYNTHETIC_PRIVATE_HOST'); };
  const session = createAsyncSession(createPostgresExecutor(failingSession.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  await assert.rejects(session.close(), error => error.code === 'CLOSE_FAILED' && !/SYNTHETIC/.test(error.message));
});
