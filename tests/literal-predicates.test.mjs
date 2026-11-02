import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, contains, startsWith, endsWith, between, and, or, not, eq, ne, gt, gte, lt, lte, isNull, inArray, asc, desc, hasMany, ColumnRef } from '../dist/index.js';

const code = expected => error => error?.code === expected;
const searches = { contains, startsWith, endsWith };
const foldASCII = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
function fixture(fn, options = {}) {
  const rows = defineTable('literal_rows', { id: column.integer().primaryKey(), value: column.text().nullable(), version: column.integer().default(0) }, { version: 'version' });
  const db = openDatabase(':memory:', { tables: [rows], ...options });
  try { db.ensureSchema(); return fn(db, rows, db.table(rows)); } finally { db.close(); }
}

test('literal search matches an independent character oracle with SQL NULL and NOT semantics', () => fixture((db, table, repo) => {
  const values = [null, '', 'Alpha', 'alpha', 'Éé', 'æÆ', 'e\u0301', 'é', 'Iİıi', 'a🦊B', '100%_done\\', 'a\0BCd', '\0tail', 'head\0', "x' OR 1=1 --"];
  const needles = ['A', 'a', 'É', 'é', 'æ', 'Æ', '🦊', '🦊B', '%_', '\\', '\0', 'bcd', 'tail', 'head\0', "' OR", 'longer-than-the-haystack'];
  repo.insertMany(values.map((value, i) => ({ id: i + 1, value })));
  for (const [name, helper] of Object.entries(searches)) for (const mode of ['sensitive', 'ascii-insensitive']) for (const needle of needles) {
    const check = value => value === null ? null : (mode === 'sensitive' ? value : foldASCII(value))[name === 'contains' ? 'includes' : name](mode === 'sensitive' ? needle : foldASCII(needle));
    const where = helper(table.col('value'), needle, { case: mode });
    for (const inverse of [false, true]) {
      const actual = repo.findMany({ select: ['id'], where: inverse ? not(where) : where }).map(row => row.id);
      const expected = values.flatMap((value, i) => check(value) === (inverse ? false : true) ? [i + 1] : []);
      assert.deepEqual(actual, expected, JSON.stringify({ name, mode, needle, inverse }));
    }
  }
}));

test('invalid needles, option shapes and runtime codec kinds fail before any SELECT', () => fixture((db, table, repo) => {
  repo.insert({ id: 1, value: 'safe' }); db.clearTrace();
  const invalid = ['', null, undefined, 1, true, new String('boxed'), '\ud800', '\udc00', 'a\ud800b', 'x'.repeat(4097)];
  for (const helper of Object.values(searches)) for (const needle of invalid) assert.throws(() => repo.findMany({ where: helper(table.col('value'), needle) }), code('QUERY'));
  let called = 0;
  const accessor = Object.defineProperty({}, 'case', { get() { called++; return 'sensitive'; } });
  const conversion = { toString() { called++; return 'ascii-insensitive'; } };
  for (const options of [null, [], { case: true }, { case: 'unicode' }, { case: conversion }, { caseInsensitive: true }, accessor]) {
    assert.throws(() => contains(table.col('value'), 'safe', options), code('QUERY'));
  }
  assert.equal(called, 0);
  assert.throws(() => contains(table.col('id'), '1'), code('QUERY'));
  const json = defineTable('json_text', { id: column.integer().primaryKey(), value: column.json() });
  assert.throws(() => contains(json.col('value'), 'payload'), code('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
}));

test('search bounds count UTF-16 code units and preserve existing text storage and equality', () => fixture((db, table, repo) => {
  const needle = '🧵'.repeat(2048);
  repo.insert({ id: 1, value: 'start' + needle });
  assert.deepEqual(repo.findMany({ select: ['id'], where: endsWith(table.col('value'), needle) }), [{ id: 1 }]);
  assert.throws(() => contains(table.col('value'), needle + 'a'), code('QUERY'));
  const stored = 'x'.repeat(4097);
  repo.insert({ id: 2, value: stored });
  assert.equal(repo.findFirst({ where: eq(table.col('value'), stored) }).id, 2);
}));

test('text predicates bind literal data, preserve guarded write targets and roll back maxRows overruns', () => fixture((db, table, repo) => {
  const marker = "literal%_'?\\tail";
  repo.insertMany([{ id: 1, value: 'A' + marker }, { id: 2, value: 'B' + marker }, { id: 3, value: null }, { id: 4, value: '' }]);
  const where = and(endsWith(table.col('value'), marker), between(table.col('id'), 1, 2));
  assert.equal(repo.count(where), 2);
  const compiled = repo.compileSelect({ where });
  assert.ok(!compiled.sql.includes(marker));
  assert.deepEqual(compiled.parameters, [marker, marker, marker, 1, 2, 1000, 0]);
  assert.throws(() => repo.update({ value: 'wrong' }, { where, maxRows: 1 }), code('AFFECTED_ROWS'));
  assert.deepEqual(repo.findMany({ select: ['id', 'version'] }), [{ id: 1, version: 0 }, { id: 2, version: 0 }, { id: 3, version: 0 }, { id: 4, version: 0 }]);
  const updated = repo.update({ value: 'changed' }, { where: and(where, eq(table.col('id'), 2)), maxRows: 1 });
  assert.equal(updated[0].id, 2); assert.equal(updated[0].version, 1);
  assert.equal(repo.delete({ where: contains(table.col('value'), marker), maxRows: 1 })[0].id, 1);
  assert.ok(repo.explain({ where: contains(table.col('value'), 'changed') }).length > 0);
  assert.ok(db.exportTrace().queries.every(q => q.parameters.every(value => value === '[redacted]' || value === '[additional parameters omitted]')));
}));

test('literal filters work inside batched relation windows without leaking internal projection keys', () => {
  const parents = defineTable('literal_parents', { id: column.integer().primaryKey() });
  const children = defineTable('literal_children', { id: column.integer().primaryKey(), parentId: column.integer().references(parents, 'id'), value: column.text().nullable() });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  try {
    db.ensureSchema(); db.table(parents).insertMany([{ id: 1 }, { id: 2 }, { id: 3 }]);
    db.table(children).insertMany([{ id: 11, parentId: 1, value: 'One\0END' }, { id: 12, parentId: 1, value: 'skip' }, { id: 21, parentId: 2, value: 'Two\0end' }, { id: 22, parentId: 2, value: null }]);
    const result = db.table(parents).findMany({ include: { matches: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), select: ['value'], where: endsWith(children.col('value'), '\0end', { case: 'ascii-insensitive' }) }) } });
    assert.deepEqual(result, [{ id: 1, matches: [{ value: 'One\0END' }] }, { id: 2, matches: [{ value: 'Two\0end' }] }, { id: 3, matches: [] }]);
  } finally { db.close(); }
});

test('inclusive scalar ranges preserve exact int64 values, reversed bounds and NULL under NOT', () => {
  const table = defineTable('literal_ranges', { id: column.integer().primaryKey(), n: column.real().nullable(), big: column.bigint(), text: column.text() });
  const db = openDatabase(':memory:', { tables: [table] });
  try {
    db.ensureSchema(); const repo = db.table(table), maximum = 9223372036854775807n;
    repo.insertMany([{ id: 1, n: 1.25, big: maximum - 1n, text: 'a' }, { id: 2, n: 2.5, big: maximum, text: 'b' }, { id: 3, n: null, big: -9223372036854775808n, text: 'c' }]);
    assert.deepEqual(repo.findMany({ select: ['id'], where: between(table.col('n'), 1.25, 2.5) }), [{ id: 1 }, { id: 2 }]);
    assert.equal(repo.count(between(table.col('big'), maximum, maximum)), 1);
    assert.equal(repo.count(between(table.col('big'), -9223372036854775808n, -9223372036854775808n)), 1);
    assert.equal(repo.count(between(table.col('n'), 2.5, 1.25)), 0);
    assert.deepEqual(repo.findMany({ select: ['id'], where: not(between(table.col('n'), 2.5, 1.25)) }), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(repo.findMany({ select: ['id'], where: between(table.col('text'), 'a', 'b') }), [{ id: 1 }, { id: 2 }]);
    assert.throws(() => between(table.col('n'), null, 2), code('QUERY'));
    assert.throws(() => between(table.col('big'), Number.MAX_SAFE_INTEGER + 1, maximum), code('VALIDATION'));
    assert.throws(() => between(table.col('n'), NaN, 2), code('VALIDATION'));
    assert.throws(() => between(table.col('text'), 1, 2), code('VALIDATION'));
  } finally { db.close(); }
});

test('emitted suffix duplicates count toward the existing predicate binding limit', () => fixture((db, table, repo) => {
  const ids = Array.from({ length: 9997 }, (_, i) => i);
  const valid = and(inArray(table.col('id'), ids), endsWith(table.col('value'), 'x'));
  const compiled = repo.compileSelect({ where: valid });
  assert.equal(compiled.parameters.length, 10002);
  assert.deepEqual(compiled.parameters.slice(-5), ['x', 'x', 'x', 1000, 0]);
  assert.throws(() => repo.compileSelect({ where: and(inArray(table.col('id'), [...ids, 9998]), endsWith(table.col('value'), 'x')) }), code('QUERY'));
  assert.equal(repo.count(valid), 0);
}));

test('new expressions keep exact table identity and explicit logical composition', () => fixture((db, table, repo) => {
  repo.insertMany([{ id: 1, value: 'alpha' }, { id: 2, value: 'beta' }, { id: 3, value: null }]);
  const foreign = defineTable('literal_rows', { id: column.integer().primaryKey(), value: column.text() });
  db.clearTrace();
  assert.throws(() => repo.findMany({ where: contains(foreign.col('value'), 'a') }), code('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
  assert.deepEqual(repo.findMany({ select: ['id'], where: or(startsWith(table.col('value'), 'al'), endsWith(table.col('value'), 'ta')) }), [{ id: 1 }, { id: 2 }]);
}));


test('prototype-forged and Proxy-wrapped refs reject before any reference getters run', () => fixture((db, table, repo) => {
  repo.insert({ id: 1, value: 'safe' }); db.clearTrace();
  let reads = 0;
  const forged = Object.create(ColumnRef.prototype, {
    table: { get() { reads++; return table; } },
    name: { get() { reads++; return reads % 2 ? 'value' : 'id'; } },
  });
  const wrapped = new Proxy(table.col('value'), { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  const malformedName = { [Symbol.toPrimitive]() { reads++; return 'value'; }, toString() { reads++; return 'value'; } };
  assert.throws(() => new ColumnRef(table, malformedName), code('QUERY'));
  assert.throws(() => table.col(malformedName), code('SCHEMA'));
  assert.throws(() => new ColumnRef(table, 'missing'), code('QUERY'));
  assert.throws(() => new ColumnRef({ columns: {} }, 'value'), code('QUERY'));
  const helpers = [ref => eq(ref, 'safe'), ref => ne(ref, 'safe'), ref => gt(ref, 'safe'), ref => gte(ref, 'safe'), ref => lt(ref, 'safe'), ref => lte(ref, 'safe'),
    ref => inArray(ref, ['safe']), ref => isNull(ref), ref => contains(ref, 'safe'), ref => startsWith(ref, 'safe'), ref => endsWith(ref, 'safe'), ref => between(ref, 'a', 'z')];
  for (const ref of [forged, wrapped]) {
    for (const helper of helpers) assert.throws(() => helper(ref), code('QUERY'));
    for (const order of [asc(ref), desc(ref)]) assert.throws(() => repo.compileSelect({ orderBy: [order] }), code('QUERY'));
    assert.throws(() => hasMany(table, { localKey: ref, foreignKey: table.col('id') }), code('QUERY'));
    assert.throws(() => hasMany(table, { localKey: table.col('id'), foreignKey: ref }), code('QUERY'));
  }
  assert.equal(reads, 0);
  assert.equal(db.exportTrace().queries.length, 0);
}));

test('volatile forged BETWEEN refs cannot redirect a guarded write or alter persisted rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-ref-regression-')), filename = join(directory, 'fixture.sqlite');
  const table = defineTable('ref_persistence', { id: column.integer().primaryKey(), low: column.integer(), high: column.integer(), title: column.text() });
  let db, raw;
  try {
    db = openDatabase(filename, { tables: [table] }); db.ensureSchema();
    db.table(table).insertMany([{ id: 1, low: 1, high: 100, title: 'one' }, { id: 2, low: 100, high: 1, title: 'two' }]);
    let reads = 0;
    for (const threshold of [1, 2, 3, 4, 5, 6, 8]) {
      const forged = Object.create(ColumnRef.prototype, { table: { value: table }, name: { get() { return ++reads <= threshold ? 'low' : 'high'; } } });
      assert.throws(() => db.table(table).update({ title: 'incorrect' }, { where: between(forged, 0, 10), maxRows: 2 }), code('QUERY'));
    }
    assert.equal(reads, 0); db.close(); db = undefined;
    raw = new DatabaseSync(filename, { readOnly: true, defensive: true, allowExtension: false });
    assert.deepEqual(raw.prepare('SELECT * FROM ref_persistence ORDER BY id').all().map(row => ({ ...row })), [
      { id: 1, low: 1, high: 100, title: 'one' }, { id: 2, low: 100, high: 1, title: 'two' },
    ]);
  } finally { raw?.close(); db?.close(); unlinkSync(filename); rmdirSync(directory); }
});

test('genuine factory and direct constructor refs retain scalar, range, ordering and relation behavior', () => {
  const parents = defineTable('genuine_parents', { id: column.integer().primaryKey(), label: column.text() });
  const children = defineTable('genuine_children', { id: column.integer().primaryKey(), parentId: column.integer().references(parents, 'id') });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  try {
    db.ensureSchema(); db.table(parents).insertMany([{ id: 1, label: 'alpha' }, { id: 2, label: 'beta' }]);
    db.table(children).insert({ id: 11, parentId: 1 });
    const directId = new ColumnRef(parents, 'id'), directLabel = new ColumnRef(parents, 'label');
    assert.ok(Object.isFrozen(directId));
    assert.equal(db.table(parents).count(eq(directId, 1)), 1);
    assert.equal(db.table(parents).count(between(directId, 1, 2)), 2);
    assert.equal(db.table(parents).count(contains(directLabel, 'pha')), 1);
    const results = db.table(parents).findMany({ orderBy: [desc(directId)], include: { kids: hasMany(children, { localKey: directId, foreignKey: new ColumnRef(children, 'parentId') }) } });
    assert.deepEqual(results.map(row => [row.id, row.kids.length]), [[2, 0], [1, 1]]);
  } finally { db.close(); }
});
