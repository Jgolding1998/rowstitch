import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { column, defineTable, openDatabase, RowstitchError } from '../dist/index.js';

const events = defineTable('events', { id: column.integer().primaryKey(), label: column.text() });
const coded = code => error => error instanceof RowstitchError && error.code === code;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-result-lease-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  const filename = join(directory, 'fictional.sqlite');
  const db = openDatabase(filename, { tables: [events] }); db.ensureSchema();
  t.after(() => { db.close(); unlinkSync(filename); rmdirSync(directory); });
  const capturedRoot = db.table(events);
  return {
    db, capturedRoot,
    persisted() {
      db.close();
      const native = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
      try { return native.prepare('SELECT id,label FROM events ORDER BY id').all().map(row => ({ ...row })); }
      finally { native.close(); }
    },
  };
}

function queueAttempts(db, capturedRoot, tx, extra = []) {
  const capturedTx = tx.table(events);
  const handles = [
    ['root', () => db.table(events)], ['captured root', () => capturedRoot],
    ['transaction', () => tx.table(events)], ['captured transaction', () => capturedTx], ...extra,
  ];
  const pending = []; let nextId = 2;
  for (const [name, repository] of handles) for (const mode of ['microtask', 'immediate']) {
    const id = nextId++;
    const attempt = () => {
      try { repository().insert({ id, label: name + ' ' + mode }); return { name, mode, accepted: true }; }
      catch (error) { return { name, mode, accepted: false, error }; }
    };
    pending.push(mode === 'microtask' ? Promise.resolve().then(attempt) : new Promise(resolve => setImmediate(() => resolve(attempt()))));
  }
  return pending;
}
async function assertRevoked(pending) {
  const results = await Promise.all(pending);
  assert.ok(results.length >= 8);
  for (const result of results) {
    assert.equal(result.accepted, false, result.name + '/' + result.mode);
    assert.ok(coded('TRANSACTION_CLOSED')(result.error), result.name + '/' + result.mode);
  }
}

test('result then-getter work inherits the rejected transaction lease across every handle and scheduler', async t => {
  const { db, capturedRoot, persisted } = fixture(t); let pending; let reads = 0;
  assert.throws(() => db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'rolled back prefix' });
    return Object.defineProperty({}, 'then', { get() { reads++; pending = queueAttempts(db, capturedRoot, tx); return () => {}; } });
  }), coded('ASYNC_CALLBACK'));
  assert.equal(reads, 1); await assertRevoked(pending);
  assert.equal(capturedRoot.count(), 0);
  capturedRoot.insert({ id: 20, label: 'explicit recovery' });
  assert.deepEqual(persisted(), [{ id: 20, label: 'explicit recovery' }]);
});

test('native Promise catch-getter work is also revoked after async-result rejection', async t => {
  const { db, capturedRoot, persisted } = fixture(t); let pending; let reads = 0;
  assert.throws(() => db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'rolled back prefix' });
    const result = Promise.resolve('ordinary value');
    Object.defineProperty(result, 'catch', { get() {
      reads++; pending = queueAttempts(db, capturedRoot, tx);
      return function (onRejected) { return Promise.prototype.catch.call(this, onRejected); };
    } });
    return result;
  }), coded('ASYNC_CALLBACK'));
  assert.equal(reads, 1); await assertRevoked(pending);
  assert.deepEqual(persisted(), []);
});

test('throwing result getters preserve their original error and rollback without escaped writes', async t => {
  for (const property of ['then', 'catch']) {
    const { db, capturedRoot, persisted } = fixture(t); let pending;
    const original = new Error('ordinary application getter failure');
    assert.throws(() => db.transaction(tx => {
      tx.table(events).insert({ id: 1, label: 'rolled back prefix' });
      const result = property === 'then' ? {} : Promise.resolve('ordinary value');
      Object.defineProperty(result, property, { get() { pending = queueAttempts(db, capturedRoot, tx); throw original; } });
      return result;
    }), error => error === original);
    await assertRevoked(pending);
    capturedRoot.insert({ id: 20, label: 'usable after getter failure' });
    assert.deepEqual(persisted(), [{ id: 20, label: 'usable after getter failure' }]);
  }
});

test('a non-function then getter keeps synchronous result identity while its queued work expires', async t => {
  const { db, capturedRoot, persisted } = fixture(t); let pending; let reads = 0;
  const result = {};
  const returned = db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'committed prefix' });
    Object.defineProperty(result, 'then', { get() { reads++; pending = queueAttempts(db, capturedRoot, tx); return 42; } });
    return result;
  });
  assert.equal(returned, result); assert.equal(reads, 1);
  await assertRevoked(pending);
  assert.deepEqual(persisted(), [{ id: 1, label: 'committed prefix' }]);
});

test('rejected native promises are handled and thenable functions are not invoked', async t => {
  const { db, capturedRoot, persisted } = fixture(t);
  const rejection = new Error('ordinary rejected work'); let calls = 0;
  assert.throws(() => db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'rolled back prefix' });
    return Promise.reject(rejection);
  }), coded('ASYNC_CALLBACK'));
  assert.throws(() => db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'rolled back prefix' });
    return { then() { calls++; } };
  }), coded('ASYNC_CALLBACK'));
  await nextTurn(); assert.equal(calls, 0);
  assert.equal(capturedRoot.count(), 0);
  assert.deepEqual(persisted(), []);
});

test('a caught nested result rejection rolls back its savepoint and the outer transaction can commit', async t => {
  const { db, capturedRoot, persisted } = fixture(t); let pending;
  db.transaction(outer => {
    const capturedOuter = outer.table(events);
    capturedOuter.insert({ id: 1, label: 'outer before' });
    assert.throws(() => outer.transaction(inner => {
      inner.table(events).insert({ id: 2, label: 'nested rollback' });
      return Object.defineProperty({}, 'then', { get() {
        pending = queueAttempts(db, capturedRoot, inner, [['captured outer', () => capturedOuter]]);
        return () => {};
      } });
    }), coded('ASYNC_CALLBACK'));
    capturedOuter.insert({ id: 20, label: 'outer after' });
  });
  await assertRevoked(pending);
  capturedRoot.insert({ id: 30, label: 'independent recovery' });
  assert.deepEqual(persisted(), [{ id: 1, label: 'outer before' }, { id: 20, label: 'outer after' }, { id: 30, label: 'independent recovery' }]);
});

test('ordinary synchronous return values preserve exact identity and commit their work', t => {
  const { db, persisted } = fixture(t);
  const values = ['ordinary value', 0, false, null, undefined, { then: 'ordinary field' }, () => 'ordinary function'];
  values.forEach((value, index) => {
    const result = db.transaction(tx => { tx.table(events).insert({ id: index + 1, label: 'Row ' + index }); return value; });
    assert.equal(result, value);
  });
  assert.equal(persisted().length, values.length);
});

test('callback-scheduled asynchronous work retains the original lease protection', async t => {
  const { db, capturedRoot, persisted } = fixture(t); let pending;
  const result = db.transaction(tx => {
    tx.table(events).insert({ id: 1, label: 'committed prefix' });
    pending = queueAttempts(db, capturedRoot, tx);
    return 'synchronous result';
  });
  assert.equal(result, 'synchronous result'); await assertRevoked(pending);
  assert.deepEqual(persisted(), [{ id: 1, label: 'committed prefix' }]);
});
