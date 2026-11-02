import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, eq, ne, gt, and, or, not, inArray, isNull, desc, hasMany, ConflictError } from '../dist/index.js';

function model() {
  const authors = defineTable('authors', {
    id: column.integer().primaryKey({ generated: true }), name: column.text().unique(),
    active: column.boolean().default(true), preferences: column.json().nullable(), version: column.integer().default(1),
  }, { version: 'version' });
  const posts = defineTable('posts', {
    id: column.integer().primaryKey({ generated: true }), authorId: column.integer().references(authors, 'id', { onDelete: 'cascade' }),
    title: column.text(),
  });
  return { authors, posts };
}
function fixture(fn, options = {}) {
  const { authors, posts } = model();
  const db = openDatabase(':memory:', { tables: [authors, posts], ...options });
  try { db.ensureSchema(); return fn(db, authors, posts); } finally { db.close(); }
}
const code = expected => e => e?.code === expected;

test('CRUD infers and preserves defaults, nulls, booleans, JSON and exact parameter text', () => fixture((db, a, p) => {
  const repo = db.table(a);
  const payload = "O'Reilly'); DROP TABLE authors; --";
  const created = repo.insert({ name: payload, preferences: { theme: 'mint', nested: [1, null, true] } });
  assert.deepEqual(created, { id: 1, name: payload, active: true, preferences: { theme: 'mint', nested: [1, null, true] }, version: 1 });
  assert.equal(repo.insert({ name: 'Second' }).preferences, null);
  assert.equal(repo.findFirst({ where: eq(a.col('id'), 99) }), null);
  assert.equal(repo.count(gt(a.col('id'), 0)), 2);
  const updated = repo.update({ active: false }, { where: eq(a.col('id'), 1), maxRows: 1 });
  assert.equal(updated[0].version, 2);
  assert.equal(updated[0].active, false);
  db.table(p).insert({ authorId: 1, title: 'Child' });
  assert.equal(repo.delete({ where: eq(a.col('id'), 1), maxRows: 1 })[0].name, payload);
  assert.equal(db.table(p).count(), 0);
}));

test('schema creates only missing tables and relation indexes, then becomes an empty plan', () => fixture((db, a) => {
  assert.deepEqual(db.planSchema(), []);
  assert.deepEqual(db.ensureSchema(), []);
  const schema = db.inspectSchema();
  assert.equal(schema.length, 2);
  assert.equal(schema[0].columns.find(c => c.name === 'id').primaryKey, true);
  assert.ok(schema[1].indexes.some(i => i.columns[0] === 'authorId'));
  assert.deepEqual(db.table(a).explain({ where: eq(a.col('id'), 1) }).map(p => /SEARCH/.test(p.detail)), [true]);
}));

test('missing required, invalid values and unknown fields fail before a write', () => fixture((db, a) => {
  const r = db.table(a);
  for (const value of [{}, { name: null }, { name: 'A', active: 1 }, { name: 'A', active: undefined }, { name: 'A', extra: true }]) {
    assert.throws(() => r.insert(value), code('VALIDATION'));
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { x: NaN }, { x: undefined }, { x: 1n }, { get x() { throw Error('Must not execute'); } }]) {
    assert.throws(() => r.insert({ name: 'JSON', preferences: value }), code('VALIDATION'));
  }
  assert.equal(r.count(), 0);
}));

test('a bulk uniqueness error rolls back every row and preserves the safe error shape', () => fixture((db, a) => {
  const r = db.table(a);
  assert.throws(() => r.insertMany([{ name: 'SENSITIVE_FIXTURE' }, { name: 'SENSITIVE_FIXTURE' }]), error => {
    assert.equal(error.code, 'CONSTRAINT');
    assert.ok(!JSON.stringify(error).includes('SENSITIVE_FIXTURE'));
    assert.ok(!('cause' in error));
    return true;
  });
  assert.equal(r.count(), 0);
  assert.equal(r.insert({ name: 'Recovered' }).id, 1);
}));

test('callback failure and nested savepoint failure have distinct rollback scopes', () => fixture((db, a) => {
  const original = Error('Application failure');
  assert.throws(() => db.transaction(tx => { tx.table(a).insert({ name: 'Outer' }); throw original; }), e => e === original);
  assert.equal(db.table(a).count(), 0);
  db.transaction(tx => {
    tx.table(a).insert({ name: 'First' });
    assert.throws(() => tx.transaction(inner => { inner.table(a).insert({ name: 'Discarded' }); throw original; }), e => e === original);
    tx.table(a).insert({ name: 'Last' });
  });
  assert.deepEqual(db.table(a).findMany().map(r => r.name), ['First', 'Last']);
}));

test('missing or statically true predicates cannot mutate data; false sets remain safe', () => fixture((db, a) => {
  const r = db.table(a); r.insert({ name: 'A' });
  for (const where of [undefined, and(), not(or()), or(eq(a.col('id'), 1), and())]) {
    assert.throws(() => r.delete({ where }), code('UNSAFE_WRITE'));
  }
  assert.deepEqual(r.update({ name: 'Never' }, { where: or(), maxRows: 0 }), []);
  assert.deepEqual(r.delete({ where: inArray(a.col('id'), []) }), []);
  assert.equal(r.findFirst().name, 'A');
}));

test('maxRows is enforced atomically before a mutation and zero means zero', () => fixture((db, a) => {
  const r = db.table(a); r.insertMany([{ name: 'A' }, { name: 'B' }]);
  assert.throws(() => r.update({ active: false }, { where: gt(a.col('id'), 0), maxRows: 1 }), code('AFFECTED_ROWS'));
  assert.throws(() => r.delete({ where: eq(a.col('id'), 1), maxRows: 0 }), code('AFFECTED_ROWS'));
  assert.deepEqual(r.findMany().map(r => r.active), [true, true]);
  db.clearTrace();
  for (const options of [{ where: gt(a.col('id'), 0), maxRow: 1 }, { where: gt(a.col('id'), 0), extra: true }]) {
    assert.throws(() => r.update({ active: false }, options), code('QUERY'));
    assert.throws(() => r.delete(options), code('QUERY'));
  }
  assert.equal(db.exportTrace().queries.length, 0, 'Misspelled guards cannot fall back to defaults.');
}));

test('opening rejects unknown options and nonboolean safety flags before creating a file', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-options-'));
  const file = join(folder, 'must-not-exist.sqlite');
  try {
    for (const options of [{ readonly: true }, { readOnly: 'true' }, { readOnly: 1 }, { traceValues: 'false' }, { traceValues: 0 }]) {
      assert.throws(() => openDatabase(file, options), error => ['QUERY', 'VALIDATION'].includes(error.code));
    }
    const check = openDatabase(folder + '/known.sqlite'); check.close();
    assert.throws(() => new DatabaseSync(file, { readOnly: true }));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('optimistic updates reject stale versions and protected key/version patches', () => fixture((db, a) => {
  const r = db.table(a); const row = r.insert({ name: 'A' });
  assert.equal(r.updateVersion({ id: row.id }, 1, { name: 'B' }).version, 2);
  assert.throws(() => r.updateVersion({ id: row.id }, 1, { name: 'C' }), e => e instanceof ConflictError && e.code === 'CONFLICT');
  assert.throws(() => r.update({ version: 0 }, { where: eq(a.col('id'), row.id) }), code('VALIDATION'));
  assert.throws(() => r.update({ id: 99 }, { where: eq(a.col('id'), row.id) }), code('VALIDATION'));
  assert.equal(r.findFirst().name, 'B');
}));

test('nullable equality, inequality and mixed NULL IN have explicit semantics', () => fixture((db, a) => {
  const r = db.table(a); r.insertMany([{ name: 'A' }, { name: 'B', preferences: { x: 1 } }]);
  assert.equal(r.count(isNull(a.col('preferences'))), 1);
  assert.equal(r.count(eq(a.col('preferences'), null)), 1);
  assert.equal(r.count(ne(a.col('preferences'), null)), 1);
  assert.equal(r.count(inArray(a.col('preferences'), [null, { x: 1 }])), 2);
}));

test('relations batch in bounded chunks and apply deterministic per-parent limits/offsets', () => fixture((db, a, p) => {
  const parents = db.table(a).insertMany(Array.from({ length: 405 }, (_, i) => ({ name: 'Author ' + i })));
  db.table(p).insertMany(parents.flatMap(row => [1, 2].map(n => ({ authorId: row.id, title: 'Post ' + n }))));
  db.clearTrace();
  const rows = db.table(a).findMany({ limit: 405, include: { posts: hasMany(p, { localKey: a.col('id'), foreignKey: p.col('authorId'), orderBy: [desc(p.col('id'))], limit: 1, offset: 1 }) } });
  assert.equal(rows.length, 405);
  assert.ok(rows.every(row => row.posts.length === 1 && row.posts[0].title === 'Post 1' && row.posts[0].authorId === row.id));
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 3);
}));

test('trace is bounded, snapshots are detached, and values are redacted at collection', () => fixture((db, a) => {
  db.table(a).insert({ name: 'SECRET_FIXTURE_VALUE' });
  db.clearTrace();
  for (let i = 0; i < 8; i++) db.table(a).findMany({ where: eq(a.col('name'), 'SECRET_FIXTURE_VALUE') });
  const trace = db.exportTrace();
  assert.equal(trace.queries.length, 3);
  assert.ok(!JSON.stringify(trace).includes('SECRET_FIXTURE_VALUE'));
  assert.deepEqual(trace.queries[0].parameters, ['[redacted]', '[redacted]', '[redacted]']);
  trace.queries[0].parameters.push('Mutation');
  assert.ok(!JSON.stringify(db.exportTrace()).includes('Mutation'));
}, { maxTraceEntries: 3 }));

test('file persistence, read-only schema inspection and drift refusal use actual SQLite state', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-core-'));
  const path = join(folder, 'fixture.sqlite');
  const t = defineTable('records', { id: column.integer().primaryKey(), name: column.text() });
  try {
    const db = openDatabase(path, { tables: [t] });
    db.ensureSchema(); db.table(t).insert({ id: 1, name: 'Persistent' }); db.close();
    const read = openDatabase(path, { readOnly: true });
    assert.equal(read.inspectSchema()[0].name, 'records');
    assert.throws(() => read.ensureSchema(), code('READ_ONLY')); read.close();
    const changed = defineTable('records', { id: column.integer().primaryKey(), renamed: column.text() });
    const refused = openDatabase(path, { tables: [changed] });
    assert.throws(() => refused.ensureSchema(), code('SCHEMA_DRIFT')); refused.close();
    const native = new DatabaseSync(path); assert.equal(native.prepare('SELECT name FROM records').get().name, 'Persistent'); native.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('no public raw-SQL execution or connection handle is exposed', () => fixture(db => {
  assert.equal(db._all, undefined); assert.equal(db.state, undefined); assert.equal(db.handle, undefined);
  assert.equal(db.exec, undefined); assert.equal(db.prepare, undefined);
  assert.equal('control' in db, false); assert.equal('metadata' in db, false);
}));

test('a real external write lock makes BEGIN fail without invoking or poisoning the callback', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-begin-'));
  const file = join(folder, 'fixture.sqlite');
  const t = defineTable('records', { id: column.integer().primaryKey(), name: column.text() });
  const db = openDatabase(file, { tables: [t], busyTimeoutMs: 1 });
  let blocker;
  try {
    db.ensureSchema();
    blocker = new DatabaseSync(file); blocker.exec('BEGIN IMMEDIATE');
    let called = 0;
    assert.throws(() => db.transaction(tx => { called++; tx.table(t).insert({ id: 1, name: 'Never' }); }), code('BUSY'));
    assert.equal(called, 0);
    blocker.exec('ROLLBACK'); blocker.close(); blocker = undefined;
    db.table(t).insert({ id: 2, name: 'Recovered' });
    assert.equal(db.table(t).count(), 1);
  } finally { blocker?.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('a real failed COMMIT rolls back and subsequent acknowledged writes survive reopening', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-commit-'));
  const file = join(folder, 'fixture.sqlite');
  const t = defineTable('records', { id: column.integer().primaryKey(), name: column.text() });
  const db = openDatabase(file, { tables: [t], busyTimeoutMs: 1 });
  let reader;
  try {
    db.ensureSchema(); db.table(t).insert({ id: 1, name: 'Before' });
    reader = new DatabaseSync(file); reader.exec('BEGIN'); reader.prepare('SELECT * FROM records').all();
    assert.throws(() => db.transaction(tx => tx.table(t).insert({ id: 2, name: 'Rolled back' })), code('BUSY'));
    reader.exec('ROLLBACK'); reader.close(); reader = undefined;
    db.transaction(tx => tx.table(t).insert({ id: 3, name: 'After' }));
    db.table(t).insert({ id: 4, name: 'Plain write after recovery' });
    db.close();
    const fresh = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(fresh.prepare('SELECT id FROM records ORDER BY id').all().map(r => r.id), [1, 3, 4]);
    fresh.close();
  } finally { reader?.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('failed rollback retires the connection, preserves the original error, and allows final cleanup', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-cleanup-'));
  const file = join(folder, 'fixture.sqlite');
  const t = defineTable('records', { id: column.integer().primaryKey() });
  const db = openDatabase(file, { tables: [t] }); db.ensureSchema();
  const originalExec = DatabaseSync.prototype.exec;
  const failure = Error('Application failure before cleanup');
  try {
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'ROLLBACK') throw Error('Synthetic cleanup failure');
      return Reflect.apply(originalExec, this, [sql]);
    };
    assert.throws(() => db.transaction(tx => { tx.table(t).insert({ id: 1 }); throw failure; }), e => e === failure);
    assert.throws(() => db.table(t).count(), code('CONNECTION_UNUSABLE'));
  } finally { DatabaseSync.prototype.exec = originalExec; db.close(); }
  try {
    const fresh = new DatabaseSync(file, { readOnly: true });
    assert.equal(fresh.prepare('SELECT count(*) AS n FROM records').get().n, 0); fresh.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('schema inspection reports SQLite nullable primary keys truthfully and refuses unsafe mappings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-primary-'));
  const file = join(folder, 'fixture.sqlite');
  const native = new DatabaseSync(file);
  native.exec(`CREATE TABLE ordinary(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO ordinary VALUES(NULL, 'Retained');
    CREATE TABLE composite(a TEXT, b TEXT, PRIMARY KEY(a,b));
    CREATE TABLE strict_table(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE without_rowid(a TEXT, b TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID;
    CREATE TABLE descending(id INTEGER PRIMARY KEY DESC);`);
  native.close();
  const t = defineTable('ordinary', { id: column.text().primaryKey(), value: column.text() });
  const db = openDatabase(file, { tables: [t] });
  try {
    const schema = db.inspectSchema();
    assert.equal(schema.find(t => t.name === 'ordinary').columns[0].nullable, true);
    assert.ok(schema.find(t => t.name === 'composite').columns.every(c => c.nullable));
    assert.equal(schema.find(t => t.name === 'strict_table').columns[0].nullable, false);
    assert.ok(schema.find(t => t.name === 'without_rowid').columns.every(c => !c.nullable));
    assert.equal(schema.find(t => t.name === 'descending').columns[0].nullable, true);
    assert.throws(() => db.ensureSchema(), code('SCHEMA_DRIFT'));
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('expression indexes never pretend to index a column named null, and generated columns are inspected', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-index-'));
  const file = join(folder, 'fixture.sqlite');
  const native = new DatabaseSync(file);
  native.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY, "null" TEXT NOT NULL);
    CREATE UNIQUE INDEX expression_unique ON records(lower("null"));
    CREATE TABLE generated(id INTEGER PRIMARY KEY, value INTEGER NOT NULL, doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED);`);
  native.close();
  const t = defineTable('records', { id: column.integer().primaryKey(), null: column.text().unique() });
  const db = openDatabase(file, { tables: [t] });
  try {
    const schema = db.inspectSchema();
    assert.deepEqual(schema.find(t => t.name === 'records').indexes[0].columns, [null]);
    assert.equal(schema.find(t => t.name === 'generated').columns.find(c => c.name === 'doubled').generated, true);
    assert.throws(() => db.ensureSchema(), code('SCHEMA_DRIFT'));
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('SDK rejects unsupported runtime versions before opening any database', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    for (const version of ['24.13.0', '24.22.1', '22.22.0', '25.0.0']) {
      Object.defineProperty(process.versions, 'node', { ...descriptor, value: version });
      assert.throws(() => openDatabase(':memory:'), code('UNSUPPORTED_RUNTIME'));
    }
  } finally { Object.defineProperty(process.versions, 'node', descriptor); }
});

test('trace collection has a UTF-8 byte cap independent of its entry count', () => fixture((db, a) => {
  db.clearTrace();
  const values = Array.from({ length: 100 }, (_, i) => '界'.repeat(3000) + i);
  for (let i = 0; i < 5; i++) db.table(a).findMany({ where: inArray(a.col('name'), values) });
  const document = db.exportTrace();
  assert.equal(document.queries.length, 1, 'Two large retained entries would exceed the one-MiB history bound.');
  assert.ok(Buffer.byteLength(JSON.stringify(document.queries[0]), 'utf8') <= 1_048_576);
  assert.ok(Buffer.byteLength(JSON.stringify(document), 'utf8') <= 2_097_152);
  assert.ok(document.notes.some(n => n.includes('4 entries have been omitted')));
  db.clearTrace();
  assert.equal(db.exportTrace().queries.length, 0);
  const oversized = Array.from({ length: 100 }, (_, i) => '界'.repeat(4096) + i);
  db.table(a).findMany({ where: inArray(a.col('name'), oversized) });
  assert.equal(db.exportTrace().queries.length, 0, 'An individually oversized event is omitted, not retained.');
  assert.ok(db.exportTrace().notes.some(n => n.includes('1 entries have been omitted')));
  db.clearTrace();
  db.table(a).findMany();
  assert.equal(db.exportTrace().queries.length, 1, 'Clear resets byte accounting.');
  db.clearTrace();
  const exact = 'x'.repeat(4096);
  db.table(a).findMany({ where: eq(a.col('name'), exact) });
  assert.equal(db.exportTrace().queries[0].parameters[0], exact, 'Values at the string limit are unchanged.');
  db.clearTrace();
  db.table(a).findMany({ where: eq(a.col('name'), exact + 'x') });
  const shortened = db.exportTrace().queries[0].parameters[0];
  assert.equal(shortened.length, 4096);
  assert.ok(shortened.endsWith('... [truncated]'));
  assert.ok(/^[\x20-\x7e]+$/.test(shortened), 'The truncation marker remains plain ASCII.');
}, { traceValues: true, maxTraceEntries: 1000 }));

test('trace exports trim old events to fit two MiB and reject schemas that cannot fit alone', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-trace-size-'));
  const file = join(folder, 'fixture.sqlite');
  const native = new DatabaseSync(file);
  const makeTables = (start, end) => {
    native.exec('BEGIN');
    try {
      for (let i = start; i < end; i++) {
        const columns = Array.from({ length: 80 }, (_, j) => '"c_' + j + '_' + 'x'.repeat(1540) + '" TEXT').join(', ');
        native.exec('CREATE TABLE large_' + i + ' (' + columns + ')');
      }
      native.exec('COMMIT');
    } catch (error) { native.exec('ROLLBACK'); throw error; }
  };
  let db;
  try {
    native.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    makeTables(0, 10);
    const records = defineTable('records', { id: column.integer().primaryKey(), name: column.text() });
    db = openDatabase(file, { tables: [records], traceValues: true });
    db.table(records).findMany({ where: inArray(records.col('name'), Array.from({ length: 100 }, (_, i) => '界'.repeat(3000) + i)) });
    const document = db.exportTrace();
    assert.equal(document.queries.length, 0, 'The large schema leaves no room for this large trace event.');
    assert.ok(Buffer.byteLength(JSON.stringify(document), 'utf8') <= 2_097_152);
    makeTables(10, 20);
    assert.throws(() => db.exportTrace(), code('TRACE_LIMIT'));
  } finally { db?.close(); native.close(); rmSync(folder, { recursive: true, force: true }); }
});
