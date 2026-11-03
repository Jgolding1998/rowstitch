import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tableModel, queryModel } from '../dist/core/query-model.js';
import { compileSqlite } from '../dist/core/sqlite-compiler.js';
import { aggregateLayout } from '../dist/core/aggregate-layout.js';

const code = expected => error => error?.code === expected;
const table = tableModel({ name: 'measures', columns: ['id', 'category', 'value', 'wide', 'fraction', 'enabled', 'payload'], primaryKey: ['id'],
  kinds: { id: 'integer', category: 'text', value: 'integer', wide: 'bigint', fraction: 'real', enabled: 'boolean', payload: 'json' },
  nullable: { id: false, category: true, value: true, wide: true, fraction: true, enabled: true, payload: true } });
const selection = (operation, column, alias = 'result', extra = {}) => ({ alias, operation, ...(column === undefined ? {} : { column }), ...extra });
const aggregate = (select = [selection('count')], extra = {}) => queryModel.aggregate({ table, select, ...extra });
const group = (select = [selection('count')], extra = {}) => queryModel.group({ table, select, by: ['category'], orderBy: [], limit: 100, offset: 0, overflow: false, ...extra });
const compare = (column, operator, value) => ({ kind: 'compare', column, operator, values: [value] });
const execute = (db, model) => {
  const query = compileSqlite(model), statement = db.prepare(query.sql);
  statement.setReadBigInts(true);
  return statement.all(...query.parameters);
};
const sumValue = (row, index = 0) => row['__rs_sum_hi_' + index] === null ? null : row['__rs_sum_hi_' + index] * 4294967296n + row['__rs_sum_lo_' + index];
function fixture(body, definition = 'id INTEGER, category TEXT, value INTEGER, wide INTEGER, fraction, enabled INTEGER, payload TEXT') {
  const db = new DatabaseSync(':memory:');
  try { db.exec('CREATE TABLE measures (' + definition + ')'); body(db); } finally { db.close(); }
}

test('aggregate models require complete kinds and nullability while existing row models remain compatible', () => {
  const legacy = { name: 'legacy', columns: ['id'], primaryKey: ['id'] };
  assert.equal(compileSqlite(queryModel.select({ table: legacy, columns: ['id'], orderBy: [], limit: 1, offset: 0 })).sql,
    'SELECT "id" FROM "legacy" LIMIT ? OFFSET ?');
  assert.throws(() => aggregate(undefined, { table: legacy }), code('QUERY'));
  assert.throws(() => aggregate(undefined, { table: { ...table, nullable: undefined } }), code('SCHEMA'));
  assert.throws(() => tableModel({ ...table, nullable: { id: false } }), code('SCHEMA'));
  assert.throws(() => tableModel({ ...table, nullable: { ...table.nullable, value: 0 } }), code('SCHEMA'));
});

test('aggregate kind compatibility, required columns and explicit approximate bigint averages are revalidated', () => {
  for (const column of ['id', 'wide', 'fraction', 'category', 'enabled']) assert.equal(aggregate([selection('count', column)]).select[0].column, column);
  for (const operation of ['sum', 'avg', 'min', 'max']) assert.throws(() => aggregate([selection(operation)]), code('QUERY'));
  for (const operation of ['count', 'sum', 'avg', 'min', 'max']) assert.throws(() => aggregate([selection(operation, 'payload')]), code('QUERY'));
  for (const operation of ['sum', 'avg', 'min', 'max']) assert.throws(() => aggregate([selection(operation, 'enabled')]), code('QUERY'));
  for (const operation of ['sum', 'avg']) assert.throws(() => aggregate([selection(operation, 'category')]), code('QUERY'));
  assert.throws(() => aggregate([selection('avg', 'wide')]), code('QUERY'));
  assert.equal(aggregate([selection('avg', 'wide', 'result', { approximate: true })]).select[0].approximate, true);
  for (const operation of ['count', 'sum', 'min', 'max']) assert.throws(() => aggregate([selection(operation, 'value', 'result', { approximate: true })]), code('QUERY'));
  assert.throws(() => aggregate([selection('avg', 'value', 'result', { approximate: false })]), code('QUERY'));
});

test('aliases, keys, selectors and unsupported aggregate options fail closed', () => {
  assert.throws(() => aggregate([selection('count', undefined, 'TOTAL'), selection('count', undefined, 'total')]), code('QUERY'));
  assert.throws(() => group([selection('count', undefined, 'CATEGORY')]), code('QUERY'));
  for (const alias of ['__rs_bad', 'a";DROP TABLE measures', 'constructor']) assert.throws(() => aggregate([selection('count', undefined, alias)]), code('SCHEMA'));
  assert.throws(() => aggregate([]), code('QUERY'));
  assert.throws(() => aggregate(Array.from({ length: 33 }, (_, i) => selection('count', undefined, 'a' + i))), code('QUERY'));
  assert.throws(() => group(undefined, { by: [] }), code('QUERY'));
  assert.throws(() => group(undefined, { by: ['category', 'category'] }), code('QUERY'));
  assert.throws(() => group(undefined, { by: ['payload'] }), code('QUERY'));
  for (const key of ['having', 'distinct', 'filter']) assert.throws(() => aggregate(undefined, { [key]: true }), code('QUERY'));
  assert.throws(() => aggregate([selection('count', undefined, 'result', { where: compare('id', '=', 1) })]), code('QUERY'));
});

test('snapshots reject getters, symbols, sparse arrays and unexpected prototypes without executing accessors', () => {
  let reads = 0;
  const getter = { alias: 'result', get operation() { reads++; return 'count'; } };
  assert.throws(() => aggregate([getter]), code('QUERY'));
  assert.equal(reads, 0);
  assert.throws(() => aggregate([{ alias: 'result', operation: 'count', [Symbol('x')]: true }]), code('QUERY'));
  assert.throws(() => aggregate(new Array(1)), code('QUERY'));
  assert.throws(() => aggregate([Object.assign(Object.create({ inherited: true }), selection('count'))]), code('QUERY'));
  const source = { table, select: [selection('sum', 'value')], where: compare('id', '>', 1) };
  const plan = queryModel.aggregate(source);
  source.select[0].column = 'wide'; source.where.values[0] = 999;
  assert.equal(plan.select[0].column, 'value');
  assert.deepEqual(compileSqlite(plan).parameters, [1]);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.select) && Object.isFrozen(plan.select[0]));
});

test('group pagination, ordering and output layout use bounded options and stable generated ordinals', () => {
  const model = group([selection('sum', 'wide', 'total'), selection('count', undefined, 'rows')], { orderBy: [{ field: 'total', direction: 'DESC' }] });
  assert.deepEqual(model.orderBy, [{ field: 'total', direction: 'DESC' }, { field: 'category', direction: 'ASC' }]);
  const layout = aggregateLayout(model);
  assert.deepEqual(layout.outputs.map(output => [output.name, output.ordinal]), [['__rs_key_0', 1], ['__rs_sum_hi_0', 2], ['__rs_sum_lo_0', 3], ['__rs_agg_1', 4], ['__rs_bad', 5]]);
  assert.deepEqual(layout.inputColumns, ['category', 'wide']);
  assert.ok(Object.isFrozen(layout) && Object.isFrozen(layout.outputs) && Object.isFrozen(layout.aggregates[0]));
  assert.match(compileSqlite(model).sql, /ORDER BY 2 DESC, 3 DESC, 1 ASC LIMIT \? OFFSET \?$/);
  for (const options of [{ limit: 10001 }, { limit: -1 }, { limit: Infinity }, { offset: -1 }, { offset: 1e9 + 1 }, { overflow: 1 }, { overflow: true, limit: 10000 }]) assert.throws(() => group(undefined, options), code('QUERY'));
  assert.equal(group(undefined, { overflow: true, limit: 10001 }).limit, 10001);
  assert.equal(group(undefined, { limit: 0 }).limit, 0);
  for (const orderBy of [[{ field: 'wrong', direction: 'ASC' }], [{ field: 'result', direction: 'asc' }], [{ field: 'result', direction: 'ASC' }, { field: 'result', direction: 'DESC' }]]) assert.throws(() => group(undefined, { orderBy }), code('QUERY'));
});

test('generated outputs avoid source-name alias ambiguity and explain only accepts supported reads', () => {
  const model = group([selection('sum', 'value', 'wide')], { where: compare('id', '>', 2), orderBy: [{ field: 'wide', direction: 'DESC' }] });
  const query = compileSqlite(model);
  assert.match(query.sql, /WHERE "measures"\."id" > \? GROUP BY "measures"\."category" ORDER BY 2 DESC, 3 DESC, 1 ASC/);
  assert.doesNotMatch(query.sql, /AS "wide"/);
  assert.deepEqual(query.parameters, [2, 100, 0]);
  assert.equal(compileSqlite(queryModel.explain({ query: aggregate() })).sql, 'EXPLAIN QUERY PLAN ' + compileSqlite(aggregate()).sql);
  assert.equal(compileSqlite(queryModel.explain({ query: model })).sql, 'EXPLAIN QUERY PLAN ' + query.sql);
  assert.throws(() => queryModel.explain({ query: queryModel.count({ table }) }), code('QUERY'));
});

test('global WHERE keeps nested relation count parameters in order before pagination', () => {
  const where = { kind: 'relation-count', operator: '>=', threshold: 2, table,
    localKey: 'id', foreignKey: 'value', where: compare('id', '>', 4), predicate: compare('enabled', '=', 1) };
  const compiled = compileSqlite(group(undefined, { where, limit: 7, offset: 3 }));
  assert.deepEqual(compiled.parameters, [4, 1, 2, 7, 3]);
  assert.match(compiled.sql, /"__rs_filter_0"\."value" = "measures"\."id"/);
});

test('empty and all-NULL inputs retain standard aggregate semantics and valid guards', () => fixture(db => {
  const model = aggregate([selection('count', undefined, 'rows'), selection('count', 'value', 'present'), selection('sum', 'value', 'total'), selection('avg', 'value', 'average'), selection('min', 'category', 'first')]);
  let row = execute(db, model)[0];
  assert.equal(row.__rs_agg_0, 0n); assert.equal(row.__rs_agg_1, 0n); assert.equal(sumValue(row, 2), null);
  assert.equal(row.__rs_agg_3, null); assert.equal(row.__rs_agg_4, null); assert.equal(row.__rs_bad, 0n);
  assert.deepEqual(execute(db, group()), []);
  db.exec('INSERT INTO measures(id) VALUES (1), (2)');
  row = execute(db, model)[0];
  assert.equal(row.__rs_agg_0, 2n); assert.equal(row.__rs_agg_1, 0n); assert.equal(sumValue(row, 2), null); assert.equal(row.__rs_bad, 0n);
}));

test('split integer sums preserve cancellation and results beyond native int64 without rounded partials', () => fixture(db => {
  const insert = db.prepare('INSERT INTO measures(id, wide) VALUES (?, ?)');
  const max = (1n << 63n) - 1n;
  for (const [i, value] of [max, max, -max, -max, -1n].entries()) insert.run(i, value);
  assert.throws(() => db.prepare('SELECT SUM(wide) FROM measures').get(), /overflow/i);
  const row = execute(db, aggregate([selection('sum', 'wide')]))[0];
  assert.equal(sumValue(row), -1n); assert.equal(row.__rs_sum_hi_0, -1n); assert.equal(row.__rs_sum_lo_0, 4294967295n);
  assert.equal(sumValue(execute(db, aggregate([selection('sum', 'wide')], { where: compare('id', '<', 2) }))[0]), 2n * max);
  db.exec('DELETE FROM measures');
  insert.run(1, -(1n << 63n)); insert.run(2, -(1n << 63n));
  assert.equal(sumValue(execute(db, aggregate([selection('sum', 'wide')]))[0]), -(1n << 64n));
}));

test('canonical high and low carry makes grouped integer ordering exact in both directions', () => fixture(db => {
  const groups = { a: [4294967295n, 1n], b: [4294967295n], c: [-1n], d: [-4294967296n], e: [0n], f: [null] };
  const insert = db.prepare('INSERT INTO measures(category, wide) VALUES (?, ?)');
  for (const [category, values] of Object.entries(groups)) for (const value of values) insert.run(category, value);
  const options = direction => group([selection('sum', 'wide', 'total')], { orderBy: [{ field: 'total', direction }] });
  const ascending = execute(db, options('ASC'));
  assert.deepEqual(ascending.map(row => row.__rs_key_0), ['f', 'd', 'c', 'e', 'b', 'a']);
  assert.deepEqual(ascending.map(row => sumValue(row)), [null, -4294967296n, -1n, 0n, 4294967295n, 4294967296n]);
  assert.deepEqual(execute(db, options('DESC')).map(row => row.__rs_key_0), ['a', 'b', 'e', 'c', 'd', 'f']);
}));

test('mapped real SUM accepts safe INTEGER storage without native integer overflow', () => fixture(db => {
  const insert = db.prepare('INSERT INTO measures(id, fraction) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 1025; i++) insert.run(i, BigInt(Number.MAX_SAFE_INTEGER));
  db.exec('COMMIT');
  assert.throws(() => db.prepare('SELECT SUM(fraction) FROM measures').get(), /overflow/i);
  const row = execute(db, aggregate([selection('sum', 'fraction')]))[0];
  assert.ok(Number.isFinite(row.__rs_agg_0));
  assert.ok(Math.abs(row.__rs_agg_0 - Number.MAX_SAFE_INTEGER * 1025) / row.__rs_agg_0 < 1e-12);
  assert.equal(row.__rs_bad, 0n);
}));

test('input guards validate selected inputs and keys while count(*) ignores unrelated invalid columns', () => fixture(db => {
  db.exec("INSERT INTO measures(id, category, value, enabled) VALUES (1, 'ok', 'bad', 2)");
  assert.equal(execute(db, aggregate())[0].__rs_bad, 0n);
  for (const column of ['value', 'enabled']) assert.equal(execute(db, aggregate([selection('count', column)]))[0].__rs_bad, 1n);
  db.exec('UPDATE measures SET value=NULL, id=NULL');
  assert.equal(execute(db, aggregate([selection('count', 'value')]))[0].__rs_bad, 0n);
  assert.equal(execute(db, aggregate([selection('count', 'id')]))[0].__rs_bad, 1n);
  db.exec("UPDATE measures SET id=1, category=x'FF'");
  assert.equal(execute(db, group())[0].__rs_bad, 1n);
}));

test('guard matches real/integer/bigint storage rules before output conversion', () => fixture(db => {
  const insert = db.prepare('INSERT INTO measures(id, value, wide, fraction) VALUES (1, ?, ?, ?)');
  for (const [value, wide, fraction, bad] of [[1n, 1n, 1n, 0n], [9007199254740992n, 1n, 1n, 1n], [1n, 1.5, 1n, 1n], [1n, 1n, 9007199254740992n, 1n], [1n, 1n, Infinity, 1n]]) {
    db.exec('DELETE FROM measures'); insert.run(value, wide, fraction);
    const row = execute(db, aggregate(['value', 'wide', 'fraction'].map((column, i) => selection('count', column, 'a' + i))))[0];
    assert.equal(row.__rs_bad, bad);
  }
}));

test('group global guard catches invalid data outside the requested page and excludes rows outside WHERE', () => fixture(db => {
  db.exec("INSERT INTO measures(id,category,value) VALUES (1,'a',1),(2,'z','bad')");
  const model = group([selection('count', 'value')], { limit: 1 });
  assert.equal(execute(db, model)[0].__rs_key_0, 'a');
  assert.equal(execute(db, model)[0].__rs_bad, 1n);
  assert.equal(execute(db, group([selection('count', 'value')], { limit: 1, where: compare('id', '=', 1) }))[0].__rs_bad, 0n);
  assert.deepEqual(execute(db, group([selection('count', 'value')], { limit: 0 })), []);
  assert.deepEqual(execute(db, group([selection('count', 'value')], { offset: 100 })), []);
}));

test('text MIN/MAX and grouped keys retain declared SQLite collation', () => {
  for (const [collation, values, expectedMin, expectedGroups] of [['NOCASE', ['Z', 'a', 'A'], 'a', 2], ['RTRIM', ['z', 'a ', 'a'], 'a ', 2]]) fixture(db => {
    const insert = db.prepare('INSERT INTO measures(id, category) VALUES (?, ?)');
    values.forEach((value, index) => insert.run(index, value));
    const row = execute(db, aggregate([selection('min', 'category', 'first'), selection('max', 'category', 'last')]))[0];
    assert.equal(row.__rs_agg_0, expectedMin);
    assert.equal(row.__rs_agg_1, values[0]);
    assert.equal(execute(db, group()).length, expectedGroups);
    assert.equal(execute(db, group())[0].__rs_agg_0, 2n);
  }, 'id INTEGER, category TEXT COLLATE ' + collation + ', value INTEGER, wide INTEGER, fraction, enabled INTEGER, payload TEXT');
});
