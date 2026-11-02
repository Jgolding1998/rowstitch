import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  column, defineTable, openDatabase, eq, gt, and, or, not, inArray, isNull, asc, hasMany,
} from '../dist/index.js';

function models() {
  const authors = defineTable('authors', {
    id: column.integer().primaryKey({ generated: true }),
    name: column.text(),
    nickname: column.text().nullable(),
    active: column.boolean().default(true),
    preferences: column.json().nullable(),
    exact: column.bigint().default(0n),
    version: column.integer().default(1),
  }, { version: 'version' });
  const posts = defineTable('posts', {
    id: column.integer().primaryKey({ generated: true }),
    authorId: column.integer().references(authors, 'id', { onDelete: 'cascade' }),
    title: column.text(),
  });
  return { authors, posts };
}

function memory(options = {}) {
  const schema = models();
  const db = openDatabase(':memory:', { tables: [schema.authors, schema.posts], ...options });
  db.ensureSchema();
  return { ...schema, db, repo: db.table(schema.authors) };
}

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-adversarial-'));
  t.after(() => {
    const actual = path.resolve(directory);
    assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(actual).startsWith('rowstitch-adversarial-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return path.join(directory, 'synthetic.db');
}

test('untrusted SQL-looking values remain data through insert, filter and update', () => {
  const { db, repo, authors } = memory();
  try {
    const value = "Sample'; DROP TABLE authors; --";
    const row = repo.insert({ name: value });
    assert.equal(repo.findFirst({ where: eq(authors.col('name'), value) }).id, row.id);
    assert.equal(repo.findMany({ where: eq(authors.col('name'), "' OR 1=1 --") }).length, 0);
    repo.update({ name: 'Still here' }, { where: eq(authors.col('id'), row.id), maxRows: 1 });
    assert.equal(repo.count(), 1);
    assert.equal(repo.findFirst().name, 'Still here');
  } finally { db.close(); }
});

test('missing, empty and forged write filters cannot become an unrestricted mutation', () => {
  const { db, repo } = memory();
  try {
    repo.insertMany([{ name: 'Sample A' }, { name: 'Sample B' }]);
    for (const where of [undefined, {}, Object.create({ kind: 'eq' }), { sql: '1=1', parameters: [] }]) {
      assert.throws(() => repo.update({ name: 'Changed' }, { where, maxRows: 10 }));
      assert.throws(() => repo.delete({ where, maxRows: 10 }));
    }
    for (const empty of [and, or]) {
      // An empty disjunction may legitimately mean false; it must never delete everything.
      try { repo.delete({ where: empty(), maxRows: 10 }); } catch { /* refusal is also safe */ }
      assert.equal(repo.count(), 2);
    }
    assert.deepEqual(repo.findMany().map(r => r.name).sort(), ['Sample A', 'Sample B']);
  } finally { db.close(); }
});

test('maxRows guards roll back the actual update and delete rather than truncate silently', () => {
  const { db, repo, authors } = memory();
  try {
    repo.insertMany([{ name: 'Sample A' }, { name: 'Sample B' }, { name: 'Sample C' }]);
    const before = repo.findMany({ orderBy: [asc(authors.col('id'))] });
    assert.throws(() => repo.update({ name: 'Changed' }, { where: gt(authors.col('id'), 0), maxRows: 1 }));
    assert.deepEqual(repo.findMany({ orderBy: [asc(authors.col('id'))] }), before);
    assert.throws(() => repo.delete({ where: gt(authors.col('id'), 0), maxRows: 1 }));
    assert.equal(repo.count(), 3);
  } finally { db.close(); }
});

test('bulk insert is atomic when a later row violates nullability or a foreign key', () => {
  const { db, repo, authors, posts } = memory();
  try {
    assert.throws(() => repo.insertMany([{ name: 'Must roll back' }, { name: null }]));
    assert.equal(repo.count(), 0);
    const author = repo.insert({ name: 'Sample' });
    const children = db.table(posts);
    assert.throws(() => children.insertMany([
      { authorId: author.id, title: 'Must also roll back' },
      { authorId: author.id + 1000, title: 'Missing parent' },
    ]));
    assert.equal(children.count(), 0);
    assert.equal(repo.count(eq(authors.col('id'), author.id)), 1);
  } finally { db.close(); }
});

test('nested rollback restores its savepoint while the outer transaction remains usable', () => {
  const { db, repo, authors } = memory();
  let escaped;
  try {
    const value = db.transaction(tx => {
      tx.table(authors).insert({ name: 'Outer A' });
      assert.throws(() => tx.transaction(inner => {
        escaped = inner;
        inner.table(authors).insert({ name: 'Nested must roll back' });
        throw new Error('Synthetic nested failure');
      }), /Synthetic nested failure/);
      tx.table(authors).insert({ name: 'Outer B' });
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(repo.findMany().map(r => r.name).sort(), ['Outer A', 'Outer B']);
    assert.throws(() => escaped.table(authors).insert({ name: 'Expired nested handle' }));
    assert.equal(repo.count(), 2);
  } finally { db.close(); }
});

test('a promise-returning transaction rolls back its prefix and revokes post-await writes', async () => {
  const { db, repo, authors } = memory();
  let pending, escapedError;
  try {
    assert.throws(() => db.transaction(tx => {
      pending = (async () => {
        tx.table(authors).insert({ name: 'Synchronous prefix must roll back' });
        await nextTurn();
        try { tx.table(authors).insert({ name: 'Deferred write must fail' }); }
        catch (error) { escapedError = error; }
      })();
      return pending;
    }));
    await pending;
    assert.ok(escapedError, 'The transaction handle must be revoked after rejection');
    assert.equal(repo.count(), 0);
    repo.insert({ name: 'Connection still usable' });
    assert.equal(repo.count(), 1);
  } finally { db.close(); }
});

test('a transaction handle cannot perform later writes after successful commit', () => {
  const { db, repo, authors } = memory();
  let escaped;
  try {
    db.transaction(tx => { escaped = tx; tx.table(authors).insert({ name: 'Committed sample' }); });
    assert.throws(() => escaped.table(authors).insert({ name: 'After commit' }));
    assert.equal(repo.count(), 1);
  } finally { db.close(); }
});

test('two independently opened connections cannot overwrite a newer version', t => {
  const file = temp(t);
  const { authors, posts } = models();
  const first = openDatabase(file, { tables: [authors, posts] });
  first.ensureSchema();
  const second = openDatabase(file, { tables: [authors, posts] });
  try {
    const a = first.table(authors).insert({ name: 'Original sample', preferences: { theme: 'light' } });
    const stale = second.table(authors).findFirst({ where: eq(authors.col('id'), a.id) });
    first.table(authors).updateVersion({ id: a.id }, a.version, { name: 'Winning sample' });
    assert.throws(() => second.table(authors).updateVersion({ id: stale.id }, stale.version, { name: 'Stale sample' }), error => error.code === 'CONFLICT');
    assert.equal(second.table(authors).findFirst({ where: eq(authors.col('id'), a.id) }).name, 'Winning sample');
  } finally { second.close(); first.close(); }
});

test('bigint int64 values round-trip exactly and unsafe numeric inputs are rejected', () => {
  const { db, repo } = memory();
  try {
    const high = 9223372036854775807n;
    const low = -9223372036854775808n;
    repo.insertMany([{ name: 'High sample', exact: high }, { name: 'Low sample', exact: low }]);
    assert.deepEqual(new Set(repo.findMany().map(r => r.exact)), new Set([high, low]));
    assert.throws(() => repo.insert({ id: Number.MAX_SAFE_INTEGER + 1, name: 'Unsafe numeric id' }));
    assert.throws(() => repo.insert({ name: 'Outside int64', exact: high + 1n }));
    assert.equal(repo.count(), 2);
  } finally { db.close(); }
});

test('NULL predicates and empty IN keep distinct read semantics', () => {
  const { db, repo, authors } = memory();
  try {
    repo.insertMany([{ name: 'Empty nickname', nickname: null }, { name: 'Named sample', nickname: 'Alias' }]);
    assert.equal(repo.findMany({ where: isNull(authors.col('nickname')) }).length, 1);
    assert.equal(repo.findMany({ where: inArray(authors.col('id'), []) }).length, 0);
    assert.equal(repo.findMany({ where: not(isNull(authors.col('nickname'))) }).length, 1);
  } finally { db.close(); }
});

test('per-parent child limits do not starve later parents, and empty relations stay arrays', () => {
  const { db, repo, authors, posts } = memory();
  try {
    for (let id = 1; id <= 4; id++) {
      repo.insert({ id, name: `Sample ${id}` });
      if (id === 4) continue;
      for (let child = 1; child <= 3; child++) db.table(posts).insert({ id: id * 100 + child, authorId: id, title: `Sample ${id}-${child}` });
    }
    const rows = repo.findMany({ orderBy: [asc(authors.col('id'))], include: { posts: hasMany(posts, {
      localKey: authors.col('id'), foreignKey: posts.col('authorId'), orderBy: [asc(posts.col('id'))], limit: 2,
    }) } });
    assert.deepEqual(rows.map(a => a.posts.map(p => p.id)), [[101, 102], [201, 202], [301, 302], []]);
  } finally { db.close(); }
});

test('mixed integer and bigint foreign keys join losslessly in both directions', () => {
  for (const parentBigint of [true, false]) {
    const parents = defineTable('parents', { id: (parentBigint ? column.bigint() : column.integer()).primaryKey() });
    const children = defineTable('children', {
      id: column.integer().primaryKey(),
      parentId: (parentBigint ? column.integer() : column.bigint()).references(parents, 'id'),
    });
    const db = openDatabase(':memory:', { tables: [parents, children] });
    try {
      db.ensureSchema();
      db.table(parents).insert({ id: parentBigint ? 1n : 1 });
      if (parentBigint) db.table(parents).insert({ id: 9223372036854775807n });
      db.table(children).insert({ id: 1, parentId: parentBigint ? 1 : 1n });
      const rows = db.table(parents).findMany({ orderBy: [asc(parents.col('id'))], include: {
        children: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') }),
      } });
      assert.deepEqual(rows[0].children.map(r => r.id), [1]);
      assert.equal(rows[0].children[0].parentId, parentBigint ? 1 : 1n);
      if (parentBigint) {
        assert.equal(rows[1].id, 9223372036854775807n);
        assert.deepEqual(rows[1].children, []);
      }
    } finally { db.close(); }
  }
});

test('default traces redact values at collection time and stay bounded', () => {
  const { db, repo, authors } = memory({ maxTraceEntries: 5 });
  try {
    const marker = 'SYNTHETIC_PRIVATE_VALUE_391';
    repo.insert({ name: marker });
    for (let i = 0; i < 15; i++) repo.findMany({ where: eq(authors.col('name'), marker) });
    const trace = db.exportTrace({ title: 'Synthetic trace' });
    assert.equal(trace.format, 'rowstitch-trace');
    assert.ok(trace.queries.length > 0 && trace.queries.length <= 5);
    assert.ok(!JSON.stringify(trace).includes(marker));
    assert.ok(!Object.hasOwn(trace, 'results'));
    assert.ok(trace.queries.some(q => q.parameters.includes('[redacted]')));
  } finally { db.close(); }
});

test('schema planning refuses incompatible stored shapes without rewriting or dropping data', t => {
  const file = temp(t);
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE authors(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO authors VALUES('kept','Synthetic preserved row')");
  raw.close();
  const { authors } = models();
  const db = openDatabase(file, { tables: [authors] });
  try {
    assert.throws(() => db.ensureSchema());
  } finally { db.close(); }
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT id,name FROM authors').get().name, 'Synthetic preserved row');
    assert.equal(check.prepare('PRAGMA table_info(authors)').all()[0].type, 'TEXT');
  } finally { check.close(); }
});

test('read-only inspection does not need a model mapping and cannot mutate through repositories', t => {
  const file = temp(t);
  const { authors } = models();
  const writer = openDatabase(file, { tables: [authors] });
  writer.ensureSchema(); writer.table(authors).insert({ name: 'Read-only sample' }); writer.close();
  const inspect = openDatabase(file, { readOnly: true });
  try {
    const serialized = JSON.stringify(inspect.inspectSchema());
    assert.ok(serialized.includes('authors'));
    assert.throws(() => inspect.table(authors).insert({ name: 'Must not be saved' }));
  } finally { inspect.close(); }
  const raw = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(raw.prepare('SELECT count(*) AS n FROM authors').get().n, 1); }
  finally { raw.close(); }
});

test('implicit SQLite foreign-key targets resolve to the actual parent key before schema planning', t => {
  const file = temp(t);
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parent,label TEXT NOT NULL);
    INSERT INTO parent VALUES(1,'Synthetic parent');
    INSERT INTO child VALUES(10,1,'Synthetic child');`);
  raw.close();
  const reader = openDatabase(file, { readOnly: true });
  try {
    const foreignKey = reader.inspectSchema().find(t => t.name === 'child').foreignKeys[0];
    assert.equal(foreignKey.table, 'parent');
    assert.equal(foreignKey.target, 'id', 'Implicit primary keys must not become a column named null');
  } finally { reader.close(); }
  const parent = defineTable('parent', { id: column.integer().primaryKey(), name: column.text() });
  const child = defineTable('child', {
    id: column.integer().primaryKey(), parent_id: column.integer().references(parent, 'id'), label: column.text(),
  });
  const mapped = openDatabase(file, { tables: [parent, child] });
  try {
    const plan = mapped.ensureSchema();
    assert.ok(plan.every(change => change.action === 'create-index'));
    assert.equal(mapped.table(child).findFirst().label, 'Synthetic child');
    assert.equal(mapped.table(parent).findFirst().name, 'Synthetic parent');
  } finally { mapped.close(); }
});
