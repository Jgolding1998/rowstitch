import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agg, column, defineTable, openDatabase, eq, gt, gte, hasMany, countRelated, some, and, RowstitchError } from '../dist/index.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const fileConnections = new Map();
function memory(t, tables) {
  const db = openDatabase(':memory:', { tables }); db.ensureSchema(); t.after(() => db.close()); return db;
}
function file(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rowstitch-aggregate-'));
  const filename = path.join(directory, 'fixture.sqlite'), connections = [];
  fileConnections.set(filename, connections);
  t.after(() => {
    for (const db of connections) db.close();
    fileConnections.delete(filename);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('rowstitch-aggregate-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return filename;
}
function fileDatabase(filename, options) {
  const db = openDatabase(filename, options);
  fileConnections.get(filename).push(db);
  return db;
}

test('root aggregate counts rows separately from values and preserves result types', t => {
  const items = defineTable('aggregate_items', { id: column.integer().primaryKey(), quantity: column.integer().nullable(),
    amount: column.real().nullable(), label: column.text().nullable(), active: column.boolean().nullable() });
  const db = memory(t, [items]), repo = db.table(items);
  repo.insertMany([
    { id: 1, quantity: 2, amount: 1.5, label: 'Maple', active: true },
    { id: 2, quantity: -1, amount: 2.5, label: 'Birch', active: false },
    { id: 3, quantity: null, amount: null, label: null, active: null },
  ]);
  db.clearTrace();
  const result = repo.aggregate({ select: { rows: agg.count(), quantities: agg.count(items.col('quantity')),
    flags: agg.count(items.col('active')), total: agg.sum(items.col('quantity')), amount: agg.sum(items.col('amount')),
    average: agg.avg(items.col('quantity')), lowest: agg.min(items.col('label')), highest: agg.max(items.col('label')) } });
  assert.deepEqual(result, { rows: 3, quantities: 2, flags: 2, total: 1n, amount: 4, average: 0.5, lowest: 'Birch', highest: 'Maple' });
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 1);
  assert.deepEqual(Object.keys(result), ['rows', 'quantities', 'flags', 'total', 'amount', 'average', 'lowest', 'highest']);
});

test('empty root input produces nullable aggregates even for required fields, while empty groups produce no rows', t => {
  const items = defineTable('empty_aggregate', { id: column.integer().primaryKey(), name: column.text(), value: column.bigint().nullable() });
  const db = memory(t, [items]), repo = db.table(items);
  const select = { rows: agg.count(), values: agg.count(items.col('value')), total: agg.sum(items.col('value')),
    average: agg.avg(items.col('value'), { approximate: true }), first: agg.min(items.col('name')), last: agg.max(items.col('id')) };
  assert.deepEqual(repo.aggregate({ select }), { rows: 0, values: 0, total: null, average: null, first: null, last: null });
  assert.deepEqual(repo.groupBy({ by: ['name'], select }), []);
  repo.insertMany([{ id: 1, name: 'Empty value', value: null }, { id: 2, name: 'Empty value', value: null }]);
  assert.deepEqual(repo.aggregate({ select }), { rows: 2, values: 0, total: null, average: null, first: 'Empty value', last: 2 });
  assert.deepEqual(repo.aggregate({ select, where: gt(items.col('id'), 10) }), { rows: 0, values: 0, total: null, average: null, first: null, last: null });
});

test('integer sums are exact beyond int64 and do not depend on insertion order', t => {
  const items = defineTable('exact_totals', { id: column.integer().primaryKey(), value: column.bigint().nullable() });
  const db = memory(t, [items]), repo = db.table(items), max = 2n ** 63n - 1n, min = -(2n ** 63n);
  const cases = [[max, 1n, -max], [max, max], [min, min], [min, max, 1n], [-1n, -1n], [4294967295n, 4294967295n], [null, null]];
  for (const values of cases) for (const input of [values, [...values].reverse()]) {
    repo.delete({ where: gt(items.col('id'), 0) });
    repo.insertMany(input.map((value, index) => ({ id: index + 1, value })));
    const actual = repo.aggregate({ select: { total: agg.sum(items.col('value')) } }).total;
    const present = input.filter(v => v !== null);
    assert.equal(actual, present.length ? present.reduce((a, b) => a + b, 0n) : null);
  }
  const safe = defineTable('safe_totals', { id: column.integer().primaryKey(), value: column.integer() });
  const other = memory(t, [safe]);
  other.table(safe).insertMany([{ id: 1, value: Number.MAX_SAFE_INTEGER }, { id: 2, value: Number.MAX_SAFE_INTEGER }]);
  assert.equal(other.table(safe).aggregate({ select: { total: agg.sum(safe.col('value')) } }).total, 18014398509481982n);
});

test('bigint average is explicitly approximate while extrema remain exact', t => {
  const items = defineTable('average_precision', { id: column.integer().primaryKey(), value: column.bigint() });
  const db = memory(t, [items]), repo = db.table(items);
  repo.insert({ id: 1, value: 9007199254740993n });
  assert.throws(() => agg.avg(items.col('value')), coded('QUERY'));
  assert.deepEqual(repo.aggregate({ select: { average: agg.avg(items.col('value'), { approximate: true }),
    lowest: agg.min(items.col('value')), highest: agg.max(items.col('value')) } }),
  { average: 9007199254740992, lowest: 9007199254740993n, highest: 9007199254740993n });
});

test('deterministic int64 fixture agrees with independent BigInt totals and complete group ordering', t => {
  const items = defineTable('generated_totals', { id: column.integer().primaryKey(), groupId: column.integer(), value: column.bigint().nullable() });
  const db = memory(t, [items]), repo = db.table(items), mask = (1n << 64n) - 1n;
  let state = 1777n, id = 0;
  const rows = [], expected = [];
  for (let groupId = 0; groupId < 129; groupId++) {
    let total = 0n, count = 0;
    for (let index = 0; index < 17; index++) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
      const value = groupId === 128 || index % 11 === 0 ? null : state - (1n << 63n);
      rows.push({ id: ++id, groupId, value });
      if (value !== null) { total += value; count++; }
    }
    expected.push({ groupId, total: count ? total : null, count });
  }
  for (let offset = 0; offset < rows.length; offset += 1000) repo.insertMany(rows.slice(offset, offset + 1000));
  assert.equal(repo.aggregate({ select: { total: agg.sum(items.col('value')) } }).total,
    rows.reduce((total, row) => total + (row.value ?? 0n), 0n));
  for (const direction of ['asc', 'desc']) {
    const order = [...expected].sort((a, b) => {
      const relation = a.total === b.total ? 0 : a.total === null ? -1 : b.total === null ? 1 : a.total < b.total ? -1 : 1;
      return (direction === 'asc' ? relation : -relation) || a.groupId - b.groupId;
    });
    const actual = repo.groupBy({ by: ['groupId'], select: { total: agg.sum(items.col('value')), count: agg.count(items.col('value')) },
      orderBy: [{ field: 'total', direction }] });
    assert.deepEqual(actual, order);
  }
});

test('group ordering handles split-sum carry, negative totals, large adjacent totals and alias scopes', t => {
  const items = defineTable('group_totals', { id: column.integer().primaryKey(), category: column.text(), value: column.bigint().nullable() });
  const db = memory(t, [items]), repo = db.table(items), max = 2n ** 63n - 1n;
  const groups = { carry: [4294967295n, 4294967295n], lower: [4294967296n, 1n], negative: [-1n, -1n],
    large: [max, max], adjacent: [max, max - 1n], empty: [null], zero: [0n], tie: [0n] };
  let id = 0;
  repo.insertMany(Object.entries(groups).flatMap(([category, values]) => values.map(value => ({ id: ++id, category, value }))));
  const select = { value: agg.sum(items.col('value')), rows: agg.count() };
  const ascending = repo.groupBy({ by: ['category'], select, orderBy: [{ field: 'value', direction: 'asc' }] });
  assert.deepEqual(ascending.map(row => row.category), ['empty', 'negative', 'tie', 'zero', 'lower', 'carry', 'adjacent', 'large']);
  assert.deepEqual(ascending.map(row => row.value), [null, -2n, 0n, 0n, 4294967297n, 8589934590n, max * 2n - 1n, max * 2n]);
  const options = { by: ['category'], select, where: gte(items.col('value'), 0n), orderBy: [{ field: 'value', direction: 'desc' }], limit: 3, offset: 1 };
  assert.deepEqual(repo.groupBy(options).map(row => row.category), ['adjacent', 'carry', 'lower']);
  assert.deepEqual(repo.compileGroupBy(options).parameters, [0n, 3, 1]);
  assert.ok(repo.explainGroupBy(options).length > 0);
});

test('multiple nullable group keys keep NULL groups and all-NULL aggregate groups', t => {
  const items = defineTable('nullable_groups', { id: column.integer().primaryKey(), category: column.text().nullable(), active: column.boolean().nullable(), value: column.integer().nullable() });
  const db = memory(t, [items]), repo = db.table(items);
  repo.insertMany([{ id: 1, category: null, active: null, value: 2 }, { id: 2, category: null, active: null, value: 3 },
    { id: 3, category: 'A', active: false, value: null }, { id: 4, category: 'A', active: true, value: 7 }]);
  assert.deepEqual(repo.groupBy({ by: ['category', 'active'], select: { total: agg.sum(items.col('value')), rows: agg.count() } }),
    [{ category: null, active: null, total: 5n, rows: 2 }, { category: 'A', active: false, total: null, rows: 1 }, { category: 'A', active: true, total: 7n, rows: 1 }]);
});

test('related count filters select aggregate input rows without multiplying them, with redacted traces', t => {
  const parents = defineTable('aggregate_projects', { id: column.integer().primaryKey(), name: column.text(), budget: column.integer() });
  const children = defineTable('aggregate_tasks', { id: column.integer().primaryKey(), projectId: column.integer().references(parents, 'id'), done: column.boolean() });
  const db = memory(t, [parents, children]), repo = db.table(parents), needle = "' OR 1=1 --";
  repo.insertMany([{ id: 1, name: needle, budget: 5 }, { id: 2, name: 'Garden', budget: 9 }, { id: 3, name: 'Picnic', budget: 3 }]);
  db.table(children).insertMany([{ id: 1, projectId: 1, done: false }, { id: 2, projectId: 1, done: false }, { id: 3, projectId: 2, done: true }]);
  const tasks = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('projectId') });
  const options = { select: { total: agg.sum(parents.col('budget')), projects: agg.count() },
    where: and(countRelated(tasks, '>=', 2, eq(children.col('done'), false)), eq(parents.col('name'), needle)) };
  const compiled = repo.compileAggregate(options);
  assert.deepEqual(compiled.parameters, [0, 2, needle]); assert.equal(compiled.sql.includes(needle), false);
  db.clearTrace(); assert.deepEqual(repo.aggregate(options), { total: 5n, projects: 1 });
  const trace = db.exportTrace(); assert.equal(trace.queries.length, 1); assert.equal(JSON.stringify(trace).includes(needle), false);
  assert.ok(repo.explainAggregate(options).some(row => /SEARCH .*USING .*INDEX rs_fk_/.test(row.detail)));
  assert.deepEqual(repo.aggregate({ select: options.select, where: some(tasks) }), { total: 14n, projects: 2 });
});

test('guarded aggregates reject malformed stored inputs, including groups outside a returned page', t => {
  const filename = file(t), raw = new DatabaseSync(filename);
  raw.exec('CREATE TABLE damaged (id INTEGER PRIMARY KEY, category TEXT, value INTEGER)');
  raw.prepare('INSERT INTO damaged VALUES (?, ?, ?)').run(1, 'A', 2);
  raw.prepare('INSERT INTO damaged VALUES (?, ?, ?)').run(2, 'Z', 'invalid'); raw.close();
  const items = defineTable('damaged', { id: column.integer().primaryKey(), category: column.text(), value: column.integer() });
  const db = fileDatabase(filename, { tables: [items] }); const repo = db.table(items);
  for (const descriptor of [agg.sum(items.col('value')), agg.min(items.col('value')), agg.count(items.col('value'))]) {
    assert.throws(() => repo.aggregate({ select: { result: descriptor } }), coded('DATA'));
    assert.throws(() => repo.groupBy({ by: ['category'], select: { result: descriptor }, limit: 1 }), coded('DATA'));
  }
  assert.deepEqual(repo.aggregate({ select: { total: agg.sum(items.col('value')) }, where: eq(items.col('id'), 1) }), { total: 2n });
  assert.deepEqual(repo.aggregate({ select: { rows: agg.count() } }), { rows: 2 });
  assert.deepEqual(repo.groupBy({ by: ['category'], select: { total: agg.sum(items.col('value')) }, limit: 0 }), []);
});

test('text extrema and grouped keys preserve native collations in actual SQLite encodings', t => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
    const filename = file(t), raw = new DatabaseSync(filename);
    raw.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE collated (id INTEGER PRIMARY KEY, label TEXT COLLATE NOCASE, amount INTEGER)`);
    const insert = raw.prepare('INSERT INTO collated VALUES (?, ?, ?)');
    for (const row of [[1, 'a', 2], [2, 'A', 3], [3, 'B', 4], [4, 'c', 5]]) insert.run(...row);
    const expected = raw.prepare('SELECT min(label) AS lowest, max(label) AS highest FROM collated').get();
    const groups = raw.prepare('SELECT label, count(*) AS n FROM collated GROUP BY label ORDER BY label').all(); raw.close();
    const items = defineTable('collated', { id: column.integer().primaryKey(), label: column.text(), amount: column.integer() });
    const db = fileDatabase(filename, { tables: [items] }); const repo = db.table(items);
    assert.deepEqual(repo.aggregate({ select: { lowest: agg.min(items.col('label')), highest: agg.max(items.col('label')) } }), { ...expected });
    assert.deepEqual(repo.groupBy({ by: ['label'], select: { n: agg.count() } }), groups.map(row => ({ ...row })));
  }
});

test('group reads require explicit pagination instead of silently truncating a complete result', t => {
  const items = defineTable('many_groups', { id: column.integer().primaryKey() }); const db = memory(t, [items]), repo = db.table(items);
  for (let first = 1; first <= 10001; first += 1000) repo.insertMany(Array.from({ length: Math.min(1000, 10002 - first) }, (_, index) => ({ id: first + index })));
  const options = { by: ['id'], select: { rows: agg.count() } };
  assert.throws(() => repo.groupBy(options), coded('RESULT_LIMIT'));
  assert.deepEqual(repo.groupBy({ ...options, limit: 2, offset: 9999 }), [{ id: 10000, rows: 1 }, { id: 10001, rows: 1 }]);
  assert.deepEqual(repo.groupBy({ ...options, limit: 10, offset: 10001 }), []);
});

test('aggregate reads respect readonly connections and revoked transaction handles', t => {
  const filename = file(t), items = defineTable('aggregate_lifetime', { id: column.integer().primaryKey(), value: column.integer() });
  const seed = openDatabase(filename, { tables: [items] }); seed.ensureSchema(); seed.table(items).insert({ id: 1, value: 3 }); seed.close();
  const db = fileDatabase(filename, { tables: [items], readOnly: true });
  const options = { select: { total: agg.sum(items.col('value')) } };
  assert.deepEqual(db.table(items).aggregate(options), { total: 3n });
  let escaped;
  db.transaction(tx => { escaped = tx.table(items); assert.deepEqual(escaped.aggregate(options), { total: 3n }); });
  for (const call of [() => escaped.aggregate(options), () => escaped.compileAggregate(options), () => escaped.groupBy({ ...options, by: ['id'] }), () => escaped.explainAggregate(options)]) {
    assert.throws(call, coded('TRANSACTION_CLOSED'));
  }
});
