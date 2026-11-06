import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { agg, column, defineTable, openDatabase, eq, inArray, and, hasMany, countRelated, RowstitchError } from '../dist/index.js';
import { decodeAggregateRow } from '../dist/core/aggregate-decode.js';
import { aggregateToModel } from '../dist/core/aggregates.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const queryError = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA', 'VALIDATION'].includes(error.code);
const fields = () => ({ id: column.integer().primaryKey(), bucket: column.text().nullable(), amount: column.integer(),
  wide: column.bigint().nullable(), ratio: column.real().nullable(), label: column.text().nullable(), flag: column.boolean().nullable() });
function memory(t) {
  const table = defineTable('aggregate_rows', fields()), db = openDatabase(':memory:', { tables: [table] });
  t.after(() => db.close()); db.ensureSchema(); db.clearTrace(); return { table, db, repo: db.table(table) };
}
function stored(t, rows, { encoding = 'UTF-8', collation = 'BINARY' } = {}) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-aggregate-adversarial-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  const filename = join(directory, 'fictional.sqlite'), raw = new DatabaseSync(filename); let db;
  t.after(() => { try { db?.close(); } finally { raw.close(); unlinkSync(filename); rmdirSync(directory); } });
  assert.ok(['UTF-8', 'UTF-16le', 'UTF-16be'].includes(encoding)); assert.ok(['BINARY', 'NOCASE', 'RTRIM'].includes(collation));
  raw.exec("PRAGMA encoding='" + encoding + "'; CREATE TABLE aggregate_rows(id INTEGER PRIMARY KEY, bucket TEXT COLLATE " + collation + ', amount, wide, ratio, label TEXT COLLATE ' + collation + ', flag)');
  const insert = raw.prepare('INSERT INTO aggregate_rows VALUES(?,?,?,?,?,?,?)');
  raw.exec('BEGIN');
  try {
    for (const row of rows) {
      const value = { id: 1, bucket: 'a', amount: 1n, wide: 1n, ratio: 1.5, label: 'alpha', flag: 1n, ...row };
      insert.run(...['id', 'bucket', 'amount', 'wide', 'ratio', 'label', 'flag'].map(key => value[key]));
    }
    raw.exec('COMMIT');
  } catch (error) { raw.exec('ROLLBACK'); throw error; }
  const table = defineTable('aggregate_rows', fields()); db = openDatabase(filename, { tables: [table], readOnly: true });
  return { table, db, repo: db.table(table), raw };
}

test('exact sums normalize negative carry and order by canonical high/low words', t => {
  const groups = new Map([
    ['nulls', [null]], ['negativeBeyond', [-(2n ** 63n), -1n]], ['negativeCarry', [-1n, -1n]],
    ['zeroCancellation', [2n ** 63n - 1n, 1n, -(2n ** 63n)]], ['one', [1n]],
    ['oneHighWord', [2n ** 32n]], ['twoLowWords', [2n ** 32n - 1n, 2n ** 32n - 1n]],
    ['beyondInt64', [2n ** 63n - 1n, 2n ** 63n - 1n]], ['tie', [1n]],
  ]);
  let id = 0;
  const rows = [...groups].flatMap(([bucket, values]) => values.map(wide => ({ id: ++id, bucket, wide })));
  const { table, repo } = stored(t, rows);
  const expected = [...groups].map(([bucket, values]) => ({ bucket, total: values.every(v => v === null) ? null : values.reduce((sum, value) => sum + (value ?? 0n), 0n) }));
  const order = (left, right) => left.total === right.total ? left.bucket.localeCompare(right.bucket, 'en')
    : left.total === null ? -1 : right.total === null ? 1 : left.total < right.total ? -1 : 1;
  expected.sort(order);
  assert.deepEqual(repo.groupBy({ by: ['bucket'], select: { total: agg.sum(table.col('wide')) }, orderBy: [{ field: 'total', direction: 'asc' }] }), expected);
  const descending = [...expected].sort((left, right) => left.total === right.total ? left.bucket.localeCompare(right.bucket, 'en') : -order(left, right));
  assert.deepEqual(repo.groupBy({ by: ['bucket'], select: { total: agg.sum(table.col('wide')) }, orderBy: [{ field: 'total', direction: 'desc' }] }), descending);
  assert.equal(repo.aggregate({ select: { total: agg.sum(table.col('wide')) } }).total, rows.reduce((sum, row) => sum + (row.wide ?? 0n), 0n));
});

test('real sums approximate valid INTEGER storage without intermediate int64 overflow', t => {
  const rows = Array.from({ length: 1025 }, (_, index) => ({ id: index + 1, ratio: BigInt(Number.MAX_SAFE_INTEGER) }));
  const { table, repo } = stored(t, rows);
  const result = repo.aggregate({ select: { total: agg.sum(table.col('ratio')) } });
  assert.equal(typeof result.total, 'number'); assert.ok(Number.isFinite(result.total));
  const expected = Number.MAX_SAFE_INTEGER * 1025;
  assert.ok(Math.abs(result.total - expected) <= Math.abs(expected) * 1e-12);
});

test('guards reject invalid aggregate inputs even when SQL would skip or coerce them', t => {
  const cases = [['amount', 0.5], ['amount', 'invalid'], ['amount', Buffer.from([1, 2])], ['amount', 9007199254740993n], ['amount', null],
    ['wide', 0.5], ['wide', 'invalid'], ['ratio', Infinity], ['ratio', -Infinity], ['ratio', 9007199254740993n], ['ratio', Buffer.from([1])],
    ['flag', 2n], ['flag', 0.5], ['flag', 'invalid']];
  for (const [name, bad] of cases) {
    const { table, repo } = stored(t, [{ id: 1 }, { id: 2, bucket: 'z', [name]: bad }]);
    assert.throws(() => repo.aggregate({ select: { rows: agg.count(table.col(name)) } }), coded('DATA'), name);
    assert.deepEqual(repo.aggregate({ select: { rows: agg.count() } }), { rows: 2 }, 'COUNT(*) does not assert unrelated columns');
    assert.deepEqual(repo.aggregate({ select: { rows: agg.count(table.col(name)) }, where: eq(table.col('id'), 1) }), { rows: 1 });
  }
});

test('global grouped guard survives pagination and includes damaged group keys', t => {
  const { table, repo } = stored(t, [{ id: 1, flag: 0n }, { id: 2, bucket: 'z', amount: 'invalid', flag: 2n }]);
  const options = { by: ['bucket'], select: { total: agg.sum(table.col('amount')) }, orderBy: [{ field: 'bucket', direction: 'asc' }], limit: 1 };
  assert.throws(() => repo.groupBy(options), coded('DATA'));
  assert.throws(() => repo.groupBy({ by: ['flag'], select: { rows: agg.count() }, limit: 1 }), coded('DATA'));
  assert.deepEqual(repo.groupBy({ ...options, where: eq(table.col('id'), 1) }), [{ bucket: 'a', total: 1n }]);
  assert.deepEqual(repo.groupBy({ ...options, limit: 0 }), []);
  assert.deepEqual(repo.groupBy({ ...options, offset: 99 }), [], 'empty pages deliberately make no storage assertion');
});

test('SQLite rejects a real range result only when its group is returned, unlike native engine aggregation errors', t => {
  const { table, repo } = stored(t, [{ id: 1, bucket: 'a', ratio: 1 },
    { id: 2, bucket: 'b', ratio: Number.MAX_VALUE }, { id: 3, bucket: 'b', ratio: Number.MAX_VALUE }]);
  const options = { by: ['bucket'], select: { total: agg.sum(table.col('ratio')) }, orderBy: [{ field: 'bucket', direction: 'asc' }] };
  assert.deepEqual(repo.groupBy({ ...options, limit: 1 }), [{ bucket: 'a', total: 1 }]);
  assert.throws(() => repo.groupBy(options), coded('AGGREGATE_RANGE'));
});

test('empty root aggregates keep nullable outputs for non-null source columns', t => {
  const { table, repo } = memory(t);
  assert.deepEqual(repo.aggregate({ select: { rows: agg.count(), present: agg.count(table.col('amount')), total: agg.sum(table.col('amount')),
    average: agg.avg(table.col('amount')), low: agg.min(table.col('amount')), high: agg.max(table.col('amount')) } }),
  { rows: 0, present: 0, total: null, average: null, low: null, high: null });
  assert.deepEqual(repo.groupBy({ by: ['bucket'], select: { total: agg.sum(table.col('amount')) } }), []);
});

test('grouping and text extremes preserve native collations and encoding without canonicalizing spelling', t => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) for (const collation of ['NOCASE', 'RTRIM']) {
    const rows = collation === 'NOCASE' ? [{ id: 1, bucket: 'a', label: 'z' }, { id: 2, bucket: 'A', label: 'B' }, { id: 3, bucket: 'C', label: 'c' }]
      : [{ id: 1, bucket: 'a', label: 'z ' }, { id: 2, bucket: 'a ', label: 'z' }, { id: 3, bucket: 'b', label: 'b' }];
    const { table, repo, raw } = stored(t, rows, { encoding, collation });
    const expected = raw.prepare('SELECT bucket,count(*) AS rows,min(label) AS low,max(label) AS high FROM aggregate_rows GROUP BY aggregate_rows.bucket ORDER BY 1').all().map(row => ({ ...row }));
    assert.deepEqual(repo.groupBy({ by: ['bucket'], select: { rows: agg.count(), low: agg.min(table.col('label')), high: agg.max(table.col('label')) } }), expected);
    assert.deepEqual(repo.aggregate({ select: { low: agg.min(table.col('label')), high: agg.max(table.col('label')) } }), { ...raw.prepare('SELECT min(label) AS low,max(label) AS high FROM aggregate_rows').get() });
  }
});

test('non-key column aliases cannot change WHERE scope or aggregate order', t => {
  const { table, repo } = stored(t, [{ id: 1, bucket: 'a', amount: 9n }, { id: 2, bucket: 'a', amount: 9n }, { id: 3, bucket: 'b', amount: 9n }, { id: 4, bucket: 'c', amount: 1n }]);
  const options = { by: ['bucket'], select: { amount: agg.count() }, where: eq(table.col('amount'), 9), orderBy: [{ field: 'amount', direction: 'asc' }] };
  assert.deepEqual(repo.groupBy(options), [{ bucket: 'b', amount: 1 }, { bucket: 'a', amount: 2 }]);
  const compiled = repo.compileGroupBy(options);
  assert.ok(compiled.sql.includes('"__rs_root"."amount"'));
  assert.ok(!/AS "amount"/i.test(compiled.sql)); assert.match(compiled.sql, /ORDER BY \d+ ASC/);
});

test('deferred selector filters, extra arguments and unknown query options are rejected', t => {
  const { table, repo, db } = memory(t), ref = table.col('amount');
  for (const make of [agg.sum, agg.min, agg.max]) for (const extra of [{ where: eq(ref, 1) }, { distinct: true }, undefined]) {
    assert.throws(() => make(ref, extra), coded('QUERY'));
  }
  assert.throws(() => agg.avg(ref, {}, { where: eq(ref, 1) }), coded('QUERY'));
  for (const make of [() => agg.count(ref, {}), () => agg.avg(ref, { where: eq(ref, 1) }), () => agg.avg(table.col('wide')),
    () => agg.sum(table.col('label')), () => agg.min(table.col('flag')), () => agg.count(null)]) assert.throws(make, coded('QUERY'));
  for (const key of ['having', 'distinct', 'filter', 'include', 'limit', 'orderBy']) assert.throws(() => repo.aggregate({ select: { rows: agg.count() }, [key]: {} }), coded('QUERY'));
  for (const key of ['having', 'distinct', 'filter', 'include', 'overflow']) assert.throws(() => repo.groupBy({ by: ['bucket'], select: { rows: agg.count() }, [key]: {} }), coded('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
});

test('selector authenticity and exact table identity reject forgeries before getters or SQL', t => {
  const { table, repo, db } = memory(t), selector = agg.sum(table.col('amount'));
  const impostor = defineTable(table.name, fields());
  const forged = Object.create(Object.getPrototypeOf(selector)); let calls = 0;
  Object.defineProperty(forged, 'operation', { get() { calls++; return 'sum'; } });
  for (const value of [forged, { ...selector }, new Proxy(selector, {}), agg.sum(impostor.col('amount'))]) {
    assert.throws(() => repo.aggregate({ select: { total: value } }), coded('QUERY'));
  }
  const proxiedRef = new Proxy(table.col('amount'), { get() { calls++; return 'amount'; } });
  assert.throws(() => agg.sum(proxiedRef), coded('QUERY'));
  assert.equal(calls, 0); assert.equal(db.exportTrace().queries.length, 0);
});

test('captured records and arrays reject accessors and resist changing Proxy gets', t => {
  const { table, repo } = memory(t); let calls = 0;
  const selector = agg.count(), select = { rows: selector };
  Object.defineProperty(select, 'other', { get() { calls++; return selector; }, enumerable: true });
  assert.throws(() => repo.compileAggregate({ select }), queryError);
  const options = { select: { rows: selector } }; Object.defineProperty(options, 'where', { get() { calls++; return and(); }, enumerable: true });
  assert.throws(() => repo.compileAggregate(options), queryError);
  const by = ['bucket']; Object.defineProperty(by, '0', { get() { calls++; return 'bucket'; } });
  assert.throws(() => repo.compileGroupBy({ by, select: { rows: selector } }), queryError);
  assert.equal(calls, 0);
  const proxySelect = new Proxy({ rows: selector }, { get() { calls++; return {}; } });
  const proxyBy = new Proxy(['bucket'], { get() { calls++; return 'amount'; } });
  assert.deepEqual(repo.groupBy({ by: proxyBy, select: proxySelect }), []); assert.equal(calls, 0);
  const keys = ['bucket'];
  const mutatingSelect = new Proxy({ rows: selector }, { ownKeys(target) { keys[0] = 'amount'; return Reflect.ownKeys(target); } });
  const compiled = repo.compileGroupBy({ by: keys, select: mutatingSelect });
  assert.ok(compiled.sql.includes('GROUP BY "__rs_root"."bucket"'));
});

test('invalid aliases, duplicate keys, order fields and page limits fail before SQL', t => {
  const { repo, db } = memory(t), selector = agg.count();
  for (const alias of ['__rs_bad', '__proto__', 'constructor', 'prototype', 'a.b', 'total DESC', 'x'.repeat(64)]) {
    assert.throws(() => repo.aggregate({ select: Object.fromEntries([[alias, selector]]) }), queryError);
  }
  assert.throws(() => repo.aggregate({ select: { Total: selector, total: selector } }), coded('QUERY'));
  for (const by of [[], ['bucket', 'bucket'], ['missing'], Array(2)]) assert.throws(() => repo.groupBy({ by, select: { total: selector } }), queryError);
  assert.throws(() => repo.groupBy({ by: ['bucket'], select: { BUCKET: selector } }), coded('QUERY'));
  for (const orderBy of [[{ field: 'missing', direction: 'asc' }], [{ field: 'total', direction: 'ASC' }], [{ field: 'total', direction: 'asc' }, { field: 'total', direction: 'desc' }]]) {
    assert.throws(() => repo.groupBy({ by: ['bucket'], select: { total: selector }, orderBy }), coded('QUERY'));
  }
  for (const limit of [-1, 1.5, 10001, Infinity, '1']) assert.throws(() => repo.groupBy({ by: ['bucket'], select: { total: selector }, limit }), coded('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
});

test('global predicate budgets are shared across selectors and correlated relation counts', t => {
  const { table, repo, db } = memory(t), values = Array.from({ length: 10000 }, (_, i) => i);
  const select = Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['rows' + i, agg.count()]));
  assert.equal(repo.compileAggregate({ select, where: inArray(table.col('id'), values) }).parameters.length, 10000);
  assert.equal(repo.compileGroupBy({ by: ['bucket'], select, where: inArray(table.col('id'), values), limit: 1 }).parameters.length, 10002);
  const self = hasMany(table, { localKey: table.col('id'), foreignKey: table.col('amount') });
  const where = countRelated(self, '>=', 0, inArray(table.col('id'), values));
  assert.throws(() => repo.compileAggregate({ select, where }), coded('QUERY'));
  assert.throws(() => repo.compileGroupBy({ by: ['bucket'], select, where, limit: 0 }), coded('QUERY'));
  const unregistered = defineTable('aggregate_unregistered', fields());
  assert.throws(() => repo.aggregate({ select: { rows: agg.count() }, where: countRelated(hasMany(unregistered, { localKey: table.col('id'), foreignKey: unregistered.col('amount') }), '>=', 0) }), coded('SCHEMA'));
  assert.equal(db.exportTrace().queries.length, 0);
});

test('all aggregate entry points honor escaped transaction handles', t => {
  const { table, db, repo } = memory(t), aggregate = { select: { rows: agg.count() } }, group = { by: ['bucket'], select: { rows: agg.count() } };
  let escaped;
  db.transaction(tx => { escaped = tx.table(table); assert.deepEqual(escaped.aggregate(aggregate), { rows: 0 }); });
  for (const action of [() => escaped.aggregate(aggregate), () => escaped.groupBy(group), () => escaped.compileAggregate(aggregate), () => escaped.compileGroupBy(group),
    () => escaped.explainAggregate(aggregate), () => escaped.explainGroupBy(group)]) assert.throws(action, coded('TRANSACTION_CLOSED'));
  assert.deepEqual(repo.aggregate(aggregate), { rows: 0 });
});

test('decoder refuses a dropped guard and malformed exact-sum partials', t => {
  const { table } = memory(t);
  const model = aggregateToModel(table, { select: { total: agg.sum(table.col('wide')) } }, () => undefined);
  const valid = { __rs_bad: 0n, __rs_sum_hi_0: -1n, __rs_sum_lo_0: 4294967295n };
  assert.deepEqual(decodeAggregateRow(table, model, valid), { total: -1n });
  for (const change of [{ __rs_bad: undefined }, { __rs_bad: 1n }, { __rs_bad: null }, { __rs_sum_hi_0: 1 }, { __rs_sum_lo_0: -1n }, { __rs_sum_lo_0: 4294967296n }, { __rs_sum_hi_0: null }]) {
    assert.throws(() => decodeAggregateRow(table, model, { ...valid, ...change }), coded('DATA'));
  }
  const missing = { ...valid }; delete missing.__rs_bad;
  assert.throws(() => decodeAggregateRow(table, model, missing), coded('DATA'));
});
