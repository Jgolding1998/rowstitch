import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePostgresControl } from '../dist/core/postgres-control.js';
import { queryModel } from '../dist/core/query-model.js';
import { createPostgresExecutor } from '../dist/core/postgres-executor.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { isAcknowledgedRejection } from '../dist/core/executor.js';
import { isPostgresRawResult } from '../dist/core/postgres-result.js';

const code = expected => error => error?.code === expected;
const verdict = (sqlstate, afterCommandComplete = false) => ({ sqlstate, afterCommandComplete });
const controlTag = sql => /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.exec(sql)?.[0] ?? 'SELECT 0';
function fake() {
  const sent = [], errors = new WeakMap();
  let state = 'I', closes = 0, response, responseState, fail;
  return {
    sent, errors,
    get closes() { return closes; },
    setState(value) { state = value; },
    response(value, after) { response = value; responseState = after; },
    fail(error) { fail = error; },
    transport: {
      async query(sql, parameters) {
        sent.push({ sql, parameters });
        if (fail) throw fail;
        if (response) { if (responseState) state = responseState; return response; }
        if (sql.startsWith('BEGIN')) state = 'T';
        if (sql === 'COMMIT' || sql === 'ROLLBACK') state = 'I';
        return { fields: [], rows: [], commandTag: controlTag(sql) };
      },
      transactionStatus() { return state; },
      serverError(error) { return errors.get(error); },
      async close() { closes++; },
    },
  };
}

test('PostgreSQL transaction controls validate structured names and refuse query models', () => {
  assert.equal(compilePostgresControl(queryModel.transaction({ action: 'begin-immediate' })), 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(compilePostgresControl(queryModel.transaction({ action: 'begin' })), 'BEGIN READ ONLY');
  assert.equal(compilePostgresControl(queryModel.transaction({ action: 'rollback-to', name: 'child_1' })), 'ROLLBACK TO SAVEPOINT "child_1"');
  for (const name of ['child"; COMMIT;--', '__proto__', 'x'.repeat(64)])
    assert.throws(() => compilePostgresControl({ kind: 'transaction', action: 'savepoint', name }));
  assert.throws(() => compilePostgresControl({ kind: 'transaction', action: 'commit', name: 'ignored' }));
});

test('parameter snapshots preserve int64 and text without accepting arbitrary objects', async () => {
  const d = fake(), executor = createPostgresExecutor(d.transport), input = [9223372036854775807n, "SYNTHETIC_' OR 1=1--", null];
  const result = executor.all('SELECT $1, $2, $3', input); input[0] = 1;
  await result;
  assert.deepEqual(d.sent[0].parameters, [9223372036854775807n, "SYNTHETIC_' OR 1=1--", null]);
  await assert.rejects(executor.all('SELECT $1', [{ toPostgres() { throw new Error('must not run'); } }]), code('VALIDATION'));
  assert.equal(d.sent.length, 1);
  await executor.close();
});

test('only engine-identified ErrorResponses are acknowledged and sanitized', async () => {
  for (const [state, expected] of [['23505', 'CONSTRAINT'], ['25006', 'READ_ONLY'], ['40001', 'SERIALIZATION_FAILURE'], ['40P01', 'DEADLOCK']]) {
    const d = fake(), executor = createPostgresExecutor(d.transport), error = new Error('SYNTHETIC_PRIVATE_VALUE');
    d.errors.set(error, verdict(state)); d.fail(error);
    await assert.rejects(executor.all('SELECT $1', ['SYNTHETIC_PRIVATE_VALUE']), result => {
      assert.equal(result.code, expected); assert.ok(isAcknowledgedRejection(result));
      for (const text of [result.message, String(result), JSON.stringify(result)])
        assert.ok(!text.includes('SYNTHETIC_PRIVATE_VALUE'));
      assert.equal(result.cause, undefined); return true;
    });
    await executor.close();
  }
  const d = fake(), executor = createPostgresExecutor(d.transport);
  d.fail(Object.assign(new Error('SYNTHETIC_PRIVATE_VALUE'), { code: '23505' }));
  await assert.rejects(executor.all('SELECT 1', []), error => error.code === 'DATABASE_ERROR' && !isAcknowledgedRejection(error));
  await executor.close();
});

test('COMMIT that returns ROLLBACK is a definite transaction failure, never success', async () => {
  const d = fake(), executor = createPostgresExecutor(d.transport);
  d.setState('E');
  d.response({ fields: [], rows: [], commandTag: 'ROLLBACK' }, 'I');
  await assert.rejects(executor.exec('COMMIT'), error => error.code === 'TRANSACTION_ABORTED' && isAcknowledgedRejection(error));
  d.setState('T');
  d.response({ fields: [], rows: [], commandTag: 'unexpected' }, 'I');
  await assert.rejects(executor.exec('COMMIT'), error => !isAcknowledgedRejection(error));
  await executor.close();
});

test('malformed results and transport errors cannot acquire an acknowledgment brand', async () => {
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable:true, get() { throw new Error('must not invoke an output getter'); } });
  const fields = [{ name: 'amount', typeOid: 20 }];
  for (const response of [{ fields, rows: false, commandTag: 'SELECT 0' }, { fields, rows: [], commandTag: null }, [],
    { fields, rows: [null], commandTag: 'SELECT 1' }, { fields, rows: [[9007199254740992]], commandTag: 'SELECT 1' }, { fields, rows: [accessor], commandTag: 'SELECT 1' }]) {
    const d = fake(), executor = createPostgresExecutor(d.transport); d.response(response);
    await assert.rejects(executor.all('SELECT 1', []), error => !isAcknowledgedRejection(error));
    await executor.close();
  }
});

test('control requests accept a single generated command and close the owned connection once', async () => {
  const d = fake(), executor = createPostgresExecutor(d.transport);
  for (const sql of ['COMMIT; SELECT 1', 'SELECT 1', 'SAVEPOINT "x"; COMMIT', 'BEGIN IMMEDIATE'])
    await assert.rejects(executor.exec(sql), code('VALIDATION'));
  assert.deepEqual(d.sent, []);
  const a = executor.close(), b = executor.close(); assert.equal(a, b); await a;
  assert.equal(d.closes, 1);
  await assert.rejects(executor.all('SELECT 1', []), code('CLOSED'));
});

test('the PostgreSQL session uses its dialect for root and nested rollback, keeping SQLite default unchanged', async () => {
  const d = fake(), session = createAsyncSession(createPostgresExecutor(d.transport), { dialect: 'postgresql', isResult: isPostgresRawResult });
  const original = new Error('synthetic nested failure');
  assert.equal(await session.transaction(async tx => {
    await assert.rejects(tx.transaction(() => { throw original; }), error => error === original);
    return 17;
  }), 17);
  assert.deepEqual(d.sent.map(item => item.sql), ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SAVEPOINT "rs_async_sp_1"',
    'ROLLBACK TO SAVEPOINT "rs_async_sp_1"', 'RELEASE SAVEPOINT "rs_async_sp_1"', 'COMMIT']);
  await session.close();
  for (const dialect of ['postgres', '', () => 'COMMIT'])
    assert.throws(() => createAsyncSession(createPostgresExecutor(fake().transport), { dialect, isResult: isPostgresRawResult }), code('VALIDATION'));
});
