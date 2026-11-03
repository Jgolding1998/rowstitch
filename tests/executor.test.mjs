import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '../dist/index.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';
import { inlineAsyncExecutor, acknowledgedRejection, isAcknowledgedRejection } from '../dist/core/executor.js';

const plain = rows => rows.map(row => ({ ...row }));
const code = value => error => error?.code === value;
function localFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-executor-'));
  const file = join(directory, 'sample.sqlite');
  t.after(() => { for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } } rmdirSync(directory); });
  return file;
}

test('private execution interfaces do not become raw-SQL capabilities in the public SDK', () => {
  for (const name of ['openSqliteExecutor', 'inlineAsyncExecutor', 'acknowledgedRejection', 'createAsyncSession']) assert.equal(name in sdk, false);
});

test('the extracted SQLite factory preserves required settings, bound data and exact integers', () => {
  const db = openSqliteExecutor();
  try {
    assert.ok(Object.isFrozen(db));
    assert.equal(db.all('PRAGMA foreign_keys', [])[0].foreign_keys, 1n);
    assert.equal(db.all('PRAGMA trusted_schema', [])[0].trusted_schema, 0n);
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), value TEXT);');
    assert.throws(() => db.all('INSERT INTO child VALUES(?, ?, ?) RETURNING *', [1, 77, 'unused']), error => (error.errcode & 255) === 19);
    assert.throws(() => db.all('SELECT load_extension(?)', ['SYNTHETIC_EXTENSION_NOT_LOADED']), error => (error.errcode & 255) === 1 && /not authorized/.test(error.message));
    assert.throws(() => db.all('SELECT "SYNTHETIC_UNQUOTED_COLUMN"', []), error => (error.errcode & 255) === 1 && /no such column/.test(error.message));
    assert.throws(() => db.exec('PRAGMA writable_schema=ON; DELETE FROM sqlite_schema;'), error => (error.errcode & 255) === 1 && /may not be modified/.test(error.message));
    assert.deepEqual(db.all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name", []).map(row => row.name), ['child', 'parent']);
    const big = 9223372036854775807n;
    const sentinel = "SYNTHETIC_' OR 1=1 --\0value";
    db.all('INSERT INTO parent VALUES (?) RETURNING id', [big]);
    assert.deepEqual(plain(db.all('INSERT INTO child VALUES(?, ?, ?) RETURNING *', [2, big, sentinel])), [{ id: 2n, parent_id: big, value: sentinel }]);
    assert.deepEqual(plain(db.all('SELECT value FROM child WHERE value = ?', [sentinel])), [{ value: sentinel }]);
  } finally { db.close(); }
});

test('transaction state and nested controls remain tied to the same actual connection', t => {
  const file = localFile(t), db = openSqliteExecutor(file);
  try {
    assert.equal(db.all('PRAGMA journal_mode', [])[0].journal_mode, 'delete');
    db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
    assert.equal(db.inTransaction(), true);
    db.all('INSERT INTO item VALUES(?) RETURNING *', [1]);
    db.exec('SAVEPOINT inner_scope');
    db.all('INSERT INTO item VALUES(?) RETURNING *', [2]);
    db.exec('ROLLBACK TO inner_scope; RELEASE inner_scope; COMMIT');
    assert.equal(db.inTransaction(), false);
  } finally { db.close(); }
  const reopened = openSqliteExecutor(file, { readOnly: true });
  try {
    assert.deepEqual(plain(reopened.all('SELECT id FROM item', [])), [{ id: 1n }]);
    assert.throws(() => reopened.exec('INSERT INTO item VALUES(3)'), error => (error.errcode & 255) === 8);
    assert.equal(reopened.inTransaction(), false);
  } finally { reopened.close(); }
});

test('connection setup failures keep local filenames and driver errors out of public errors', t => {
  const file = localFile(t);
  assert.throws(() => openSqliteExecutor(file, { readOnly: true }), error => {
    assert.equal(error.code, 'OPEN'); assert.ok(!error.message.includes(file)); assert.ok(!error.message.includes('ENOENT')); return true;
  });
  for (const path of ['', 'bad\0name', 12]) assert.throws(() => openSqliteExecutor(path), code('VALIDATION'));
  for (const timeout of [null, -1, 10001, Infinity, 1.5, '1']) assert.throws(() => openSqliteExecutor(':memory:', { busyTimeoutMs: timeout }), code('QUERY'));
  assert.throws(() => openSqliteExecutor(':memory:', { readOnly: 'false' }), code('VALIDATION'));
  assert.throws(() => openSqliteExecutor(':memory:', null), code('VALIDATION'));
  assert.throws(() => openSqliteExecutor(':memory:', { readonly: true }), code('QUERY'));
});

test('the executor refuses boolean or object bindings instead of invoking native named-parameter binding', () => {
  const db = openSqliteExecutor();
  try {
    for (const values of [[true], [{}], [{ a: 'SYNTHETIC_NAMED_MAP' }], [undefined], [NaN], new Array(1), null])
      assert.throws(() => db.all('SELECT :a', values), code('VALIDATION'));
    assert.equal(db.all('SELECT ? AS a', [null])[0].a, null);
  } finally { db.close(); }
});

test('acknowledged batch failures can have earlier effects; transaction control sends single statements', async () => {
  const sync = openSqliteExecutor(), db = inlineAsyncExecutor(sync);
  try {
    await db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT UNIQUE)');
    await assert.rejects(db.exec("INSERT INTO item VALUES(1,'same'); INSERT INTO item VALUES(2,'same')"), error => isAcknowledgedRejection(error) && error.code === 'CONSTRAINT');
    assert.deepEqual(plain(await db.all('SELECT id FROM item', [])), [{ id: 1n }]);
  } finally { await db.close(); }
});

test('state and close failures are sanitized and retain unknown acknowledgment', async () => {
  const secret = 'SYNTHETIC_DRIVER_DETAILS';
  const db = inlineAsyncExecutor({ all() { return []; }, exec() {}, inTransaction() { throw new Error(secret); }, close() { throw new Error(secret); } });
  for (const operation of [() => db.inTransaction(), () => db.close()]) await assert.rejects(operation(), error => {
    assert.equal(error.code, 'DATABASE_ERROR'); assert.equal(isAcknowledgedRejection(error), false); assert.ok(!error.message.includes(secret)); return true;
  });
});

test('a real competing connection produces a sanitized acknowledged BUSY response', async t => {
  const file = localFile(t), owner = openSqliteExecutor(file), db = inlineAsyncExecutor(openSqliteExecutor(file, { busyTimeoutMs: 0 }));
  try {
    owner.exec('CREATE TABLE item(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
    await assert.rejects(db.all('INSERT INTO item VALUES(?)', [1]), error => isAcknowledgedRejection(error) && error.code === 'BUSY');
    owner.exec('ROLLBACK');
    await db.all('INSERT INTO item VALUES(?)', [1]);
    assert.deepEqual(plain(await db.all('SELECT id FROM item', [])), [{ id: 1n }]);
  } finally { await db.close(); owner.close(); }
});

test('known negative acknowledgments are branded, immutable and use safe canonical errors', () => {
  const secret = 'SYNTHETIC_DRIVER_PRIVATE_VALUE';
  for (const [errcode, expected] of [[5, 'BUSY'], [6, 'BUSY'], [19, 'CONSTRAINT'], [8, 'READ_ONLY'], [1, 'DATABASE_ERROR']]) {
    const error = acknowledgedRejection({ errcode, message: secret });
    assert.equal(error.code, expected); assert.ok(isAcknowledgedRejection(error)); assert.ok(Object.isFrozen(error));
    assert.ok(!error.message.includes(secret)); assert.equal('cause' in error, false);
    assert.equal(isAcknowledgedRejection({ ...error }), false);
    assert.equal(isAcknowledgedRejection(Object.create(error)), false);
  }
  const dangerous = Object.defineProperty({}, 'errcode', { get() { throw new Error(secret); } });
  const safe = acknowledgedRejection(dangerous);
  assert.equal(safe.code, 'DATABASE_ERROR'); assert.ok(!safe.message.includes(secret));
  const forged = new sdk.RowstitchError('CONSTRAINT', secret);
  assert.equal(isAcknowledgedRejection(forged), false);
  assert.ok(!acknowledgedRejection(forged).message.includes(secret));
  assert.equal(acknowledgedRejection(new sdk.RowstitchError('constructor', secret)).code, 'DATABASE_ERROR');
});

test('the inline async conformance adapter preserves rows and reports definite SQLite rejections', async () => {
  const native = openSqliteExecutor(), db = inlineAsyncExecutor(native);
  try {
    await db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY)');
    assert.equal(await db.inTransaction(), false);
    await db.exec('BEGIN IMMEDIATE');
    assert.deepEqual(plain(await db.all('INSERT INTO item VALUES (?) RETURNING *', [9007199254740993n])), [{ id: 9007199254740993n }]);
    await assert.rejects(db.all('INSERT INTO item VALUES (?) RETURNING *', [9007199254740993n]), error => isAcknowledgedRejection(error) && error.code === 'CONSTRAINT');
    assert.equal(await db.inTransaction(), true);
    await db.exec('ROLLBACK');
    assert.deepEqual(await db.all('SELECT * FROM item', []), []);
  } finally { await db.close(); }
});
