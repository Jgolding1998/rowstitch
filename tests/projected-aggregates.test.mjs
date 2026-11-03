import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { agg, column, defineTable, openDatabase, hasMany, hasOne, belongsTo, eq, gt, inArray, and, some, countRelated, RowstitchError } from '../dist/index.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const MAX = 2n ** 63n - 1n;

const customers = defineTable('pa_customers', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable() });
const orders = defineTable('pa_orders', { id: column.integer().primaryKey(), customerId: column.integer().nullable().references(customers, 'id'), status: column.text() });
const lines = defineTable('pa_lines', { id: column.integer().primaryKey(), orderId: column.integer().references(orders, 'id'), cents: column.bigint(), qty: column.integer().nullable(), weight: column.real().nullable(), label: column.text().nullable() });
const notes = defineTable('pa_notes', { id: column.integer().primaryKey(), lineId: column.integer().references(lines, 'id'), body: column.text() });
const tags = defineTable('pa_tags', { id: column.integer().primaryKey(), name: column.text() });
const lineTags = defineTable('pa_line_tags', { id: column.integer().primaryKey(), lineId: column.integer().references(lines, 'id'), tagId: column.integer().references(tags, 'id') });
const all = [customers, orders, lines, notes, tags, lineTags];

const customerOrders = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId') });
const openOrders = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), where: eq(orders.col('status'), 'open') });
const orderLines = hasMany(lines, { localKey: orders.col('id'), foreignKey: lines.col('orderId') });
const lineNotes = hasMany(notes, { localKey: lines.col('id'), foreignKey: notes.col('lineId') });
const lineTagLinks = hasMany(lineTags, { localKey: lines.col('id'), foreignKey: lineTags.col('lineId') });
const linkTag = belongsTo(tags, { localKey: lineTags.col('tagId'), foreignKey: tags.col('id') });

function seeded(options = {}) {
  const db = openDatabase(':memory:', { tables: all, traceValues: true, ...options });
  db.ensureSchema();
  db.table(customers).insertMany([{ id: 1, name: 'Ada', region: 'north' }, { id: 2, name: 'Bo', region: null }, { id: 3, name: 'Cy', region: 'south' }]);
  db.table(orders).insertMany([{ id: 10, customerId: 1, status: 'open' }, { id: 11, customerId: 1, status: 'paid' }, { id: 12, customerId: 2, status: 'open' }, { id: 13, customerId: null, status: 'open' }]);
  db.table(lines).insertMany([
    { id: 100, orderId: 10, cents: 1n, qty: 1, weight: 1.5, label: 'b' }, { id: 101, orderId: 10, cents: 2n, qty: 2, weight: null, label: 'A' },
    { id: 102, orderId: 10, cents: 3n, qty: 3, weight: 2.5, label: null }, { id: 103, orderId: 11, cents: 10n, qty: 10, weight: null, label: 'c' },
    { id: 104, orderId: 13, cents: 7n, qty: null, weight: null, label: 'orphan' }]);
  db.table(notes).insertMany([{ id: 1, lineId: 100, body: 'x' }, { id: 2, lineId: 100, body: 'y' }, { id: 3, lineId: 103, body: 'z' }]);
  db.table(tags).insertMany([{ id: 1, name: 'red' }, { id: 2, name: 'blue' }]);
  db.table(lineTags).insertMany([{ id: 1, lineId: 100, tagId: 1 }, { id: 2, lineId: 100, tagId: 1 }, { id: 3, lineId: 101, tagId: 2 }]);
  return db;
}

test('per-row count/sum/avg/min/max: empty relations, NULL keys and result types', () => {
  const db = seeded();
  try {
    const rows = db.table(customers).findMany({ select: ['name'], aggregates: {
      orders: agg.related(customerOrders, agg.count()),
      lines: agg.related(customerOrders, agg.related(orderLines, agg.count())),
      qtyValues: agg.related(customerOrders, agg.related(orderLines, agg.count(lines.col('qty')))),
      cents: agg.related(customerOrders, agg.related(orderLines, agg.sum(lines.col('cents')))),
      qty: agg.related(customerOrders, agg.related(orderLines, agg.sum(lines.col('qty')))),
      weight: agg.related(customerOrders, agg.related(orderLines, agg.sum(lines.col('weight')))),
      meanQty: agg.related(customerOrders, agg.related(orderLines, agg.avg(lines.col('qty')))),
      lowLabel: agg.related(customerOrders, agg.related(orderLines, agg.min(lines.col('label')))),
      highCents: agg.related(customerOrders, agg.related(orderLines, agg.max(lines.col('cents')))),
    } });
    assert.deepEqual(rows, [
      { name: 'Ada', orders: 2, lines: 4, qtyValues: 4, cents: 16n, qty: 16n, weight: 4, meanQty: 4, lowLabel: 'A', highCents: 10n },
      { name: 'Bo', orders: 1, lines: 0, qtyValues: 0, cents: null, qty: null, weight: null, meanQty: null, lowLabel: null, highCents: null },
      { name: 'Cy', orders: 0, lines: 0, qtyValues: 0, cents: null, qty: null, weight: null, meanQty: null, lowLabel: null, highCents: null },
    ]);
    // NULL local key (order 13 has no customer) and belongsTo from the child side.
    const owner = belongsTo(customers, { localKey: orders.col('customerId'), foreignKey: customers.col('id') });
    assert.deepEqual(db.table(orders).findMany({ select: ['id'], aggregates: { owners: agg.related(owner, agg.count()) } }).map(r => r.owners), [1, 1, 1, 0]);
    // Singular descriptors aggregate every match without asserting cardinality (as filters do).
    const firstOrder = hasOne(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId') });
    assert.equal(db.table(customers).findFirst({ where: eq(customers.col('id'), 1), aggregates: { n: agg.related(firstOrder, agg.count()) } }).n, 2);
  } finally { db.close(); }
});

test('average is over leaf path rows, not an average of per-parent averages; independent selectors do not cross-join', () => {
  const db = seeded();
  try {
    const row = db.table(customers).findFirst({ where: eq(customers.col('id'), 1), aggregates: {
      avg: agg.related(customerOrders, agg.related(orderLines, agg.avg(lines.col('qty')))),
      orders: agg.related(customerOrders, agg.count()), notes: agg.related(customerOrders, agg.related(orderLines, agg.related(lineNotes, agg.count()))),
    } });
    // Lines of Ada: qty 1,2,3 (order 10) and 10 (order 11) -> 16/4 = 4, not (2 + 10) / 2 = 6. Orders stay 2 despite 3 notes.
    assert.deepEqual(row, { id: 1, name: 'Ada', region: 'north', avg: 4, orders: 2, notes: 3 });
  } finally { db.close(); }
});

test('every matching join path counts, with no implicit DISTINCT; four-level paths and domains at each step', () => {
  const db = seeded();
  try {
    const tagCount = agg.related(lineTagLinks, agg.related(linkTag, agg.count()));
    assert.deepEqual(db.table(lines).findMany({ where: inArray(lines.col('id'), [100, 101, 102]), select: ['id'], aggregates: { tags: tagCount } }),
      [{ id: 100, tags: 2 }, { id: 101, tags: 1 }, { id: 102, tags: 0 }], 'line 100 links tag 1 twice: two paths');
    const redLinks = hasMany(lineTags, { localKey: lines.col('id'), foreignKey: lineTags.col('lineId'), where: some(linkTag, eq(tags.col('name'), 'red')) });
    const fourLevels = agg.related(customerOrders, agg.related(orderLines, agg.related(lineTagLinks, agg.related(linkTag, agg.count()))));
    const domains = agg.related(openOrders, agg.related(orderLines, agg.related(redLinks, agg.count())));
    assert.deepEqual(db.table(customers).findMany({ select: ['id'], aggregates: { fourLevels, domains } }),
      [{ id: 1, fourLevels: 3, domains: 2 }, { id: 2, fourLevels: 0, domains: 0 }, { id: 3, fourLevels: 0, domains: 0 }]);
    assert.throws(() => agg.related(customerOrders, agg.related(orderLines, agg.related(lineTagLinks, agg.related(linkTag, agg.related(hasMany(lineTags, { localKey: tags.col('id'), foreignKey: lineTags.col('tagId') }), agg.count()))))), coded('QUERY'));
    // A domain with a nested relation filter at step 4 would exceed the shared four-relationship depth.
    const deepDomain = belongsTo(tags, { localKey: lineTags.col('tagId'), foreignKey: tags.col('id'), where: some(hasMany(lineTags, { localKey: tags.col('id'), foreignKey: lineTags.col('tagId') })) });
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.related(customerOrders, agg.related(orderLines, agg.related(lineTagLinks, agg.related(deepDomain, agg.count())))) } }), coded('QUERY'));
    assert.equal(db.table(orders).findFirst({ where: eq(orders.col('id'), 10), aggregates: { n: agg.related(orderLines, agg.related(lineTagLinks, agg.related(deepDomain, agg.count()))) } }).n, 3);
  } finally { db.close(); }
});

test('text keys follow the related column collation (same as filters); MIN/MAX keep the leaf column collation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-projected-')), file = join(dir, 'fictional.sqlite');
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE pa_groups(code TEXT NOT NULL COLLATE BINARY, PRIMARY KEY(code));
      CREATE TABLE pa_members(id INTEGER NOT NULL, groupCode TEXT COLLATE NOCASE, nick TEXT NOT NULL COLLATE NOCASE, plain TEXT NOT NULL, PRIMARY KEY(id));
      INSERT INTO pa_groups VALUES ('A'), ('b');
      INSERT INTO pa_members VALUES (1, 'a', 'a', 'a'), (2, 'A', 'B', 'B'), (3, 'B', 'c', 'c'), (4, NULL, 'z', 'z');`);
    raw.close();
    const groups = defineTable('pa_groups', { code: column.text().primaryKey() });
    const members = defineTable('pa_members', { id: column.integer().primaryKey(), groupCode: column.text().nullable(), nick: column.text(), plain: column.text() });
    const db = openDatabase(file, { tables: [groups, members], readOnly: true });
    try {
      const rel = hasMany(members, { localKey: groups.col('code'), foreignKey: members.col('groupCode') });
      const rows = db.table(groups).findMany({ aggregates: { n: agg.related(rel, agg.count()), nick: agg.related(rel, agg.min(members.col('nick'))), plain: agg.related(rel, agg.min(members.col('plain'))) } });
      assert.deepEqual(rows, [{ code: 'A', n: 2, nick: 'a', plain: 'B' }, { code: 'b', n: 1, nick: 'c', plain: 'c' }]);
      for (const row of rows) assert.equal(db.table(groups).count(and(eq(groups.col('code'), row.code), countRelated(rel, '=', row.n))), 1, 'agrees with countRelated');
    } finally { db.close(); }
  } finally { if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true }); }
});

test('exact integer sums beyond int64 and 2^53; finite reals; nonfinite real is AGGREGATE_RANGE; bigint average needs opt-in', () => {
  const db = seeded();
  try {
    db.table(lines).insertMany([{ id: 200, orderId: 12, cents: MAX, qty: Number.MAX_SAFE_INTEGER, weight: 1e308, label: 'x' }, { id: 201, orderId: 12, cents: MAX, qty: Number.MAX_SAFE_INTEGER, weight: 1e308, label: 'y' }]);
    const via = selector => agg.related(customerOrders, agg.related(orderLines, selector));
    const bo = db.table(customers).findFirst({ where: eq(customers.col('id'), 2), select: ['id'], aggregates: { cents: via(agg.sum(lines.col('cents'))), qty: via(agg.sum(lines.col('qty'))), meanCents: via(agg.avg(lines.col('cents'), { approximate: true })) } });
    assert.deepEqual(bo, { id: 2, cents: 2n * MAX, qty: 2n * BigInt(Number.MAX_SAFE_INTEGER), meanCents: Number(MAX) });
    assert.throws(() => db.table(customers).findFirst({ where: eq(customers.col('id'), 2), aggregates: { w: via(agg.sum(lines.col('weight'))) } }), coded('AGGREGATE_RANGE'));
    assert.throws(() => via(agg.avg(lines.col('cents'))), coded('QUERY'));
  } finally { db.close(); }
});

test('the storage guard covers matched rows of returned parents only, and fails before includes load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-projected-')), file = join(dir, 'fictional.sqlite');
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE pa_parents(id INTEGER NOT NULL, PRIMARY KEY(id));
      CREATE TABLE pa_kids(id INTEGER NOT NULL, parentId INTEGER NOT NULL, qty INTEGER NOT NULL, ok INTEGER NOT NULL, PRIMARY KEY(id));
      INSERT INTO pa_parents VALUES (1), (2), (3);
      INSERT INTO pa_kids VALUES (1, 1, 5, 1), (2, 2, 'oops', 1), (3, 3, 7, 0), (4, 3, 8.5, 0);`);
    raw.close();
    const parents = defineTable('pa_parents', { id: column.integer().primaryKey() });
    const kids = defineTable('pa_kids', { id: column.integer().primaryKey(), parentId: column.integer(), qty: column.integer(), ok: column.boolean() });
    const db = openDatabase(file, { tables: [parents, kids], readOnly: true, traceValues: true });
    try {
      const rel = hasMany(kids, { localKey: parents.col('id'), foreignKey: kids.col('parentId') });
      const okKids = hasMany(kids, { localKey: parents.col('id'), foreignKey: kids.col('parentId'), where: eq(kids.col('ok'), true) });
      const sum = { s: agg.related(rel, agg.sum(kids.col('qty'))) };
      db.clearTrace();
      assert.throws(() => db.table(parents).findMany({ aggregates: sum, include: { kids: rel } }), coded('DATA'));
      assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 1, 'includes are not loaded after a guard failure');
      assert.deepEqual(db.table(parents).findMany({ where: eq(parents.col('id'), 1), aggregates: sum }), [{ id: 1, s: 5n }], 'bad rows of unreturned parents are not inspected');
      assert.deepEqual(db.table(parents).findMany({ limit: 1, aggregates: sum }), [{ id: 1, s: 5n }]);
      assert.deepEqual(db.table(parents).findMany({ where: eq(parents.col('id'), 3), aggregates: { s: agg.related(okKids, agg.sum(kids.col('qty'))) } }), [{ id: 3, s: null }], 'rows outside the domain are not inspected');
      assert.deepEqual(db.table(parents).findMany({ where: eq(parents.col('id'), 2), aggregates: { n: agg.related(rel, agg.count()) } }), [{ id: 2, n: 1 }], 'COUNT(*) does not certify unreferenced columns');
      assert.throws(() => db.table(parents).findMany({ where: eq(parents.col('id'), 3), aggregates: sum }), coded('DATA'), 'REAL 8.5 in an integer column');
    } finally { db.close(); }
  } finally { if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true }); }
});

test('aliases: unique ignoring case, not reserved, and not repeating selected columns or include names', () => {
  const db = seeded();
  try {
    const n = agg.related(customerOrders, agg.count());
    for (const [options, label] of [
      [{ aggregates: { name: n } }, 'all columns selected by default'], [{ select: ['name'], aggregates: { NAME: n } }, 'selected column ignoring case'],
      [{ select: ['name'], include: { orders: customerOrders }, aggregates: { Orders: n } }, 'include name'],
      [{ aggregates: { a: n, A: n } }, 'duplicate alias'], [{ aggregates: { __rs_ragg_bad: n } }, 'reserved prefix'],
      [{ aggregates: { constructor: n } }, 'prototype name'], [{ aggregates: { 'bad-name': n } }, 'invalid name'], [{ aggregates: {} }, 'empty'],
      [{ aggregates: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['a' + i, n])) }, 'too many'],
    ]) assert.throws(() => db.table(customers).findMany(options), coded('QUERY'), label);
    assert.deepEqual(db.table(customers).findFirst({ select: ['name'], aggregates: { id: n } }), { name: 'Ada', id: 2 }, 'an unselected column name may be an alias');
    const getter = { get n() { throw new Error('getter ran'); } };
    assert.throws(() => db.table(customers).findMany({ aggregates: Object.defineProperty({}, 'n', { enumerable: true, get() { throw new Error('getter ran'); } }) }), coded('QUERY'));
    void getter;
  } finally { db.close(); }
});

test('branding: plain selectors are refused per row, agg.related is refused by root aggregate/groupBy, forgeries and scope errors', () => {
  const db = seeded();
  try {
    const n = agg.related(customerOrders, agg.count());
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.count() } }), coded('QUERY'));
    assert.throws(() => db.table(customers).aggregate({ select: { n } }), e => coded('QUERY')(e) && /findMany\/findFirst/.test(e.message));
    assert.throws(() => db.table(customers).groupBy({ by: ['region'], select: { n } }), e => coded('QUERY')(e) && /findMany\/findFirst/.test(e.message));
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: Object.freeze({ relation: customerOrders, selector: agg.count() }) } }), coded('QUERY'));
    for (const call of [() => agg.related(customerOrders), () => agg.related(customerOrders, agg.count(), {}), () => agg.related(customerOrders, { operation: 'count' }),
      () => agg.related({ ...customerOrders }, agg.count()), () => agg.related(hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), limit: 1 }), agg.count()),
      () => agg.related(hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), orderBy: [] }), agg.count())]) assert.throws(call, coded('QUERY'));
    assert.throws(() => db.table(orders).findMany({ aggregates: { n } }), coded('QUERY'), 'relation must start from the queried table');
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.related(customerOrders, agg.sum(lines.col('cents'))) } }), coded('QUERY'), 'leaf column must belong to the last table');
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.related(customerOrders, agg.related(lineNotes, agg.count())) } }), coded('QUERY'), 'broken path');
    const stray = defineTable('pa_unregistered', { id: column.integer().primaryKey(), customerId: column.integer() });
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.related(hasMany(stray, { localKey: customers.col('id'), foreignKey: stray.col('customerId') }), agg.count()) } }), coded('SCHEMA'));
    assert.throws(() => db.table(customers).update({ name: 'x' }, { where: eq(customers.col('id'), 1), aggregates: { n } }), coded('QUERY'));
  } finally { db.close(); }
});

test('one shared logical and physical parameter budget across the root where and every related domain', () => {
  const db = seeded();
  try {
    const ids = count => Array.from({ length: count }, (_, i) => i + 1);
    const domain = count => hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), where: inArray(orders.col('id'), ids(count)) });
    assert.equal(db.table(customers).findMany({ where: inArray(customers.col('id'), ids(5000)), aggregates: { n: agg.related(domain(2400), agg.count()) } }).length, 3, '5000 + 2 x 2400 physical');
    assert.throws(() => db.table(customers).findMany({ where: inArray(customers.col('id'), ids(6000)), aggregates: { n: agg.related(domain(4500), agg.count()) } }), coded('QUERY'), 'logical 10,500');
    assert.throws(() => db.table(customers).findMany({ aggregates: { n: agg.related(domain(5001), agg.count()) } }), coded('QUERY'), 'physical 2 x 5001');
    const sumDomain = hasMany(lines, { localKey: customers.col('id'), foreignKey: lines.col('orderId'), where: inArray(lines.col('id'), ids(3400)) });
    assert.throws(() => db.table(customers).findMany({ aggregates: { s: agg.related(sumDomain, agg.sum(lines.col('cents'))) } }), coded('QUERY'), 'split sum: 3 copies x 3400');
    assert.equal(db.table(customers).findMany({ aggregates: { s: agg.related(sumDomain, agg.count()) } }).length, 3, 'count: 2 copies x 3400');
    // 70 + 1 nodes in the root where and 40 + 1 in the domain: each fits alone, together they exceed 100.
    const nodeDomain = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), where: and(...Array.from({ length: 40 }, (_, i) => gt(orders.col('id'), -i))) });
    const rootWhere = and(...Array.from({ length: 70 }, (_, i) => gt(customers.col('id'), -i)));
    assert.equal(db.table(customers).findMany({ where: rootWhere }).length, 3);
    assert.equal(db.table(customers).findMany({ aggregates: { n: agg.related(nodeDomain, agg.count()) } }).length, 3);
    assert.throws(() => db.table(customers).findMany({ where: rootWhere, aggregates: { n: agg.related(nodeDomain, agg.count()) } }), coded('QUERY'), 'shared 100-node budget');
  } finally { db.close(); }
});

test('integration: projection, includes and hidden keys, bound order, explain, readonly and escaped leases', () => {
  const db = seeded();
  try {
    const sentinel = "SENTINEL_' OR 1=1 --";
    const marked = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), where: eq(orders.col('status'), sentinel) });
    const compiled = db.table(customers).compileSelect({ where: eq(customers.col('name'), 'root-value'), aggregates: { a: agg.related(marked, agg.sum(orders.col('id'))) } });
    assert.ok(!compiled.sql.includes('SENTINEL') && !compiled.sql.includes('"a"'));
    assert.deepEqual(compiled.parameters, [sentinel, sentinel, sentinel, 'root-value', 1000, 0], 'hi, lo, guard copies, then where, then page');
    const row = db.table(customers).findFirst({ select: ['name'], include: { orders: hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), select: ['status'] }) },
      aggregates: { lineCount: agg.related(customerOrders, agg.related(orderLines, agg.count())) } });
    assert.deepEqual(row, { name: 'Ada', orders: [{ status: 'open' }, { status: 'paid' }], lineCount: 4 });
    assert.ok(db.table(customers).explain({ aggregates: { n: agg.related(customerOrders, agg.count()) } }).some(step => /CORRELATED|SUBQUERY/.test(step.detail)));
    let escaped;
    db.transaction(tx => { escaped = tx.table(customers); assert.equal(escaped.findMany({ aggregates: { n: agg.related(customerOrders, agg.count()) } }).length, 3); });
    assert.throws(() => escaped.findMany({ aggregates: { n: agg.related(customerOrders, agg.count()) } }), coded('TRANSACTION_CLOSED'));
  } finally { db.close(); }
});
