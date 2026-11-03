import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, ColumnRef, eq, and, or, not, inArray, endsWith, hasMany,
  eqColumns, neColumns, gtColumns, gteColumns, ltColumns, lteColumns } from '../dist/index.js';
import { tableModel, queryModel } from '../dist/core/query-model.js';
import { compileSqlite } from '../dist/core/sqlite-compiler.js';

const code = expected => error => error?.code === expected;
const helpers = { eqColumns, neColumns, gtColumns, gteColumns, ltColumns, lteColumns };
function fixture(fn, options = {}) {
  const table = defineTable('column_pairs', {
    id: column.integer().primaryKey(), a: column.integer().nullable(), b: column.real().nullable(), exact: column.bigint().nullable(),
    first: column.text().nullable(), second: column.text().nullable(), flag: column.boolean().nullable(), otherFlag: column.boolean().nullable(),
    payload: column.json().nullable(), version: column.integer().default(0),
  }, { version: 'version' });
  const db = openDatabase(':memory:', { tables: [table], ...options });
  try { db.ensureSchema(); return fn(db, table, db.table(table)); } finally { db.close(); }
}
const input = (id, values = {}) => ({ id, a: 1, b: 2, exact: 1n, first: 'one', second: 'two', flag: true, otherFlag: false, payload: null, ...values });

test('six column APIs produce actual row filters and bind no operand values', () => fixture((db, table, repo) => {
  repo.insertMany([input(1), input(2, { a: 2, b: 2 }), input(3, { a: 3, b: 2 })]);
  const expected = { eqColumns: [2], neColumns: [1, 3], gtColumns: [3], gteColumns: [2, 3], ltColumns: [1], lteColumns: [1, 2] };
  for (const [name, helper] of Object.entries(helpers)) {
    const where = helper(table.col('a'), table.col('b'));
    assert.deepEqual(repo.findMany({ select: ['id'], where }).map(row => row.id), expected[name]);
    const compiled = repo.compileSelect({ select: ['id'], where });
    assert.deepEqual(compiled.parameters, [1000, 0]);
    assert.ok(!/CAST|COLLATE/.test(compiled.sql));
  }
  assert.throws(() => eq(table.col('a'), table.col('b')), code('VALIDATION'));
}));

test('mixed numeric columns preserve int64 versus REAL boundaries without JS rounding', () => fixture((db, table, repo) => {
  const max = 9223372036854775807n, min = -9223372036854775808n;
  repo.insertMany([
    input(1, { exact: max, b: 2 ** 63 }), input(2, { exact: min, b: -(2 ** 63) }),
    input(3, { exact: 9007199254740993n, b: 2 ** 53 }), input(4, { exact: -1n, b: -0.5 }),
  ]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: ltColumns(table.col('exact'), table.col('b')) }).map(row => row.id), [1, 4]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: eqColumns(table.col('exact'), table.col('b')) }).map(row => row.id), [2]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: gtColumns(table.col('exact'), table.col('b')) }).map(row => row.id), [3]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: ltColumns(table.col('b'), table.col('exact')) }).map(row => row.id), [3]);
}));

test('nullable operands retain SQL unknown under NOT and logical composition', () => fixture((db, table, repo) => {
  repo.insertMany([input(1), input(2, { a: null }), input(3, { b: null }), input(4, { a: null, b: null }), input(5, { a: 3 })]);
  const where = ltColumns(table.col('a'), table.col('b'));
  assert.deepEqual(repo.findMany({ select: ['id'], where }).map(row => row.id), [1]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: not(where) }).map(row => row.id), [5]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: or(where, eq(table.col('id'), 2)) }).map(row => row.id), [1, 2]);
  assert.equal(repo.count(and(where, not(eqColumns(table.col('a'), table.col('b'))))), 1);
}));

test('boolean equality is supported and incompatible codecs cannot be inferred from SQL storage', () => fixture((db, table, repo) => {
  repo.insertMany([input(1), input(2, { otherFlag: true }), input(3, { flag: null, otherFlag: null })]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: eqColumns(table.col('flag'), table.col('otherFlag')) }).map(row => row.id), [2]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: neColumns(table.col('flag'), table.col('otherFlag')) }).map(row => row.id), [1]);
  for (const helper of [gtColumns, gteColumns, ltColumns, lteColumns]) assert.throws(() => helper(table.col('flag'), table.col('otherFlag')), code('QUERY'));
  for (const helper of Object.values(helpers)) {
    assert.throws(() => helper(table.col('flag'), table.col('a')), code('QUERY'));
    assert.throws(() => helper(table.col('first'), table.col('a')), code('QUERY'));
    assert.throws(() => helper(table.col('payload'), table.col('first')), code('QUERY'));
  }
}));

test('distinct genuine refs from one exact query scope are mandatory before any reference getters', () => fixture((db, table, repo) => {
  const foreign = defineTable('column_pairs', { id: column.integer().primaryKey(), a: column.integer(), b: column.real() });
  let reads = 0;
  const forged = Object.create(ColumnRef.prototype, { table: { get() { reads++; return table; } }, name: { get() { reads++; return 'a'; } } });
  const wrapped = new Proxy(table.col('a'), { get(target, key) { reads++; return Reflect.get(target, key); } });
  db.clearTrace();
  for (const helper of Object.values(helpers)) {
    assert.throws(() => helper(table.col('a'), new ColumnRef(table, 'a')), code('QUERY'));
    assert.throws(() => helper(table.col('a'), foreign.col('b')), code('QUERY'));
    assert.throws(() => helper(forged, table.col('b')), code('QUERY'));
    assert.throws(() => helper(table.col('a'), wrapped), code('QUERY'));
    assert.throws(() => repo.compileSelect({ where: helper(foreign.col('a'), foreign.col('b')) }), code('QUERY'));
  }
  assert.equal(reads, 0);
  assert.deepEqual(db.exportTrace().queries, []);
}));

test('a captured column predicate uses current row data while selected output stays projected', () => fixture((db, table, repo) => {
  repo.insertMany([input(1), input(2, { a: 5, b: 3, exact: 8n })]);
  const where = ltColumns(table.col('a'), table.col('b'));
  assert.deepEqual(repo.findMany({ select: ['id'], where }), [{ id: 1 }]);
  assert.deepEqual(repo.findMany({ select: ['id'], where: ltColumns(table.col('a'), table.col('exact')) }), [{ id: 2 }]);
  repo.update({ b: 6 }, { where: eq(table.col('id'), 2), maxRows: 1 });
  assert.deepEqual(repo.findMany({ select: ['id'], where }), [{ id: 1 }, { id: 2 }]);
  assert.ok(repo.explain({ select: ['id'], where }).length > 0);
}));

test('kind maps are immutable, complete and required only by the new pure-model node', () => {
  const old = { name: 'pure_pairs', columns: ['id', 'a', 'b'], primaryKey: ['id'] };
  const kinds = { id: 'integer', a: 'integer', b: 'real' };
  const table = tableModel({ ...old, kinds }); kinds.a = 'json';
  const where = { kind: 'column-compare', left: 'a', right: 'b', operator: '<' };
  assert.deepEqual(compileSqlite(queryModel.count({ table, where })), { sql: 'SELECT count(*) AS n FROM "pure_pairs" WHERE "a" < "b"', parameters: [] });
  assert.equal(table.kinds.a, 'integer'); assert.ok(Object.isFrozen(table.kinds));
  assert.deepEqual(compileSqlite(queryModel.count({ table: old })), { sql: 'SELECT count(*) AS n FROM "pure_pairs"', parameters: [] });
  assert.throws(() => queryModel.count({ table: old, where }), code('QUERY'));
  assert.throws(() => tableModel({ ...old, kinds: { id: 'integer', a: 'integer' } }), code('SCHEMA'));
  assert.throws(() => queryModel.count({ table, where: { ...where, leftKind: 'text' } }), code('QUERY'));
  assert.throws(() => queryModel.count({ table, where: { ...where, right: 'a' } }), code('QUERY'));
});

test('column filters preserve actual guarded-write targets, version ownership and rollback', () => fixture((db, table, repo) => {
  repo.insertMany([input(1), input(2), input(3, { a: 5 })]);
  const where = ltColumns(table.col('a'), table.col('b'));
  assert.throws(() => repo.update({ first: 'wrong' }, { where, maxRows: 1 }), code('AFFECTED_ROWS'));
  assert.deepEqual(repo.findMany({ select: ['id', 'version', 'first'] }), [1, 2, 3].map(id => ({ id, version: 0, first: 'one' })));
  const changed = repo.update({ first: 'changed' }, { where, maxRows: 2 });
  assert.deepEqual(changed.map(row => [row.id, row.version]), [[1, 1], [2, 1]]);
  assert.throws(() => db.transaction(tx => { tx.table(table).delete({ where, maxRows: 2 }); throw new Error('fictional rollback'); }));
  assert.equal(repo.count(where), 2);
  assert.deepEqual(repo.delete({ where, maxRows: 2 }).map(row => row.id), [1, 2]);
  assert.deepEqual(repo.findMany({ select: ['id'] }), [{ id: 3 }]);
}));

test('batched relation windows accept same-child-table comparisons without projection leaks', () => {
  const parents = defineTable('column_parents', { id: column.integer().primaryKey() });
  const children = defineTable('column_children', { id: column.integer().primaryKey(), parentId: column.integer().references(parents, 'id'), a: column.integer(), b: column.integer() });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  try {
    db.ensureSchema(); db.table(parents).insertMany([{ id: 1 }, { id: 2 }, { id: 3 }]);
    db.table(children).insertMany([{ id: 11, parentId: 1, a: 1, b: 2 }, { id: 12, parentId: 1, a: 2, b: 3 }, { id: 21, parentId: 2, a: 3, b: 2 }]);
    db.clearTrace();
    const result = db.table(parents).findMany({ include: { matches: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), select: ['id'], limit: 1, where: ltColumns(children.col('a'), children.col('b')) }) } });
    assert.deepEqual(result, [{ id: 1, matches: [{ id: 11 }] }, { id: 2, matches: [] }, { id: 3, matches: [] }]);
    assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 2);
  } finally { db.close(); }
});

test('native SQLite left-column collation precedence remains visible in existing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-column-collation-')), filename = join(directory, 'fixture.sqlite');
  let raw, db;
  try {
    raw = new DatabaseSync(filename);
    raw.exec('CREATE TABLE collated_columns(id INTEGER PRIMARY KEY, folded TEXT NOT NULL COLLATE NOCASE, exact TEXT NOT NULL COLLATE BINARY, trimmed TEXT NOT NULL COLLATE RTRIM)');
    const insert = raw.prepare('INSERT INTO collated_columns VALUES(?,?,?,?)');
    insert.run(1, 'Alpha', 'alpha', 'Alpha'); insert.run(2, 'a\0X', 'a\0Y', 'a\0X'); insert.run(3, 'same', 'same ', 'same ');
    raw.close(); raw = undefined;
    const table = defineTable('collated_columns', { id: column.integer().primaryKey(), folded: column.text(), exact: column.text(), trimmed: column.text() });
    db = openDatabase(filename, { tables: [table], readOnly: true }); const repo = db.table(table);
    assert.deepEqual(repo.findMany({ select: ['id'], where: eqColumns(table.col('folded'), table.col('exact')) }).map(row => row.id), [1, 2]);
    assert.equal(repo.count(eqColumns(table.col('exact'), table.col('folded'))), 0);
    assert.deepEqual(repo.findMany({ select: ['id'], where: eqColumns(table.col('trimmed'), table.col('folded')) }).map(row => row.id), [1, 2, 3]);
    assert.throws(() => repo.update({ exact: 'wrong' }, { where: eqColumns(table.col('folded'), table.col('exact')), maxRow: 1 }), code('READ_ONLY'));
  } finally { db?.close(); raw?.close(); unlinkSync(filename); rmdirSync(directory); }
});

test('new zero-bind leaves preserve predicate node, depth and existing emitted-binding budgets', () => fixture((db, table, repo) => {
  const leaf = ltColumns(table.col('a'), table.col('b'));
  assert.ok(repo.compileSelect({ where: and(...Array(99).fill(leaf)) }).sql.length > 0);
  assert.throws(() => repo.compileSelect({ where: and(...Array(100).fill(leaf)) }), code('QUERY'));
  let nested = leaf; for (let i = 0; i < 16; i++) nested = not(nested);
  assert.ok(repo.compileSelect({ where: nested }).sql.length > 0);
  assert.throws(() => repo.compileSelect({ where: not(nested) }), code('QUERY'));
  const many = inArray(table.col('id'), Array.from({ length: 10000 }, (_, i) => i));
  assert.equal(repo.compileSelect({ where: and(many, leaf) }).parameters.length, 10002);
  assert.throws(() => repo.compileSelect({ where: and(many, leaf, endsWith(table.col('first'), 'x')) }), code('QUERY'));
}));
