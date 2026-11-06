import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { agg, column, defineTable, openDatabase, hasMany, belongsTo, eq, gt, inArray, and, RowstitchError } from '../dist/index.js';
import { aggregateToModel } from '../dist/core/aggregates.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const MAX = 2n ** 63n - 1n;

const regions = defineTable('gr_regions', { id: column.integer().primaryKey(), name: column.text() });
const shops = defineTable('gr_shops', { id: column.integer().primaryKey(), regionId: column.integer().nullable().references(regions, 'id'), area: column.text().nullable(), tier: column.integer() });
const sales = defineTable('gr_sales', { id: column.integer().primaryKey(), shopId: column.integer().nullable().references(shops, 'id'), cents: column.bigint(), qty: column.integer().nullable(), weight: column.real().nullable(), label: column.text().nullable(), paid: column.boolean() });
const refunds = defineTable('gr_refunds', { id: column.integer().primaryKey(), shopId: column.integer().references(shops, 'id'), cents: column.bigint() });
const tags = defineTable('gr_tags', { id: column.integer().primaryKey(), name: column.text() });
const saleTags = defineTable('gr_sale_tags', { id: column.integer().primaryKey(), saleId: column.integer().references(sales, 'id'), tagId: column.integer().references(tags, 'id') });
const all = [regions, shops, sales, refunds, tags, saleTags];
const shopSales = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId') });
const paidSales = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId'), where: eq(sales.col('paid'), true) });
const shopRefunds = hasMany(refunds, { localKey: shops.col('id'), foreignKey: refunds.col('shopId') });
const saleLinks = hasMany(saleTags, { localKey: sales.col('id'), foreignKey: saleTags.col('saleId') });
const linkTag = belongsTo(tags, { localKey: saleTags.col('tagId'), foreignKey: tags.col('id') });

function seeded() {
  const db = openDatabase(':memory:', { tables: all, traceValues: true });
  db.ensureSchema();
  db.table(regions).insertMany([{ id: 1, name: 'East' }, { id: 2, name: 'West' }]);
  db.table(shops).insertMany([
    { id: 1, regionId: 1, area: 'core', tier: 1 }, { id: 2, regionId: 1, area: 'edge', tier: 2 },
    { id: 3, regionId: 2, area: 'core', tier: 1 }, { id: 4, regionId: null, area: null, tier: 3 }, { id: 5, regionId: 2, area: 'edge', tier: 2 }]);
  db.table(sales).insertMany([
    { id: 1, shopId: 1, cents: 10n, qty: 1, weight: 1.5, label: 'b', paid: true }, { id: 2, shopId: 1, cents: 20n, qty: 2, weight: null, label: 'A', paid: false },
    { id: 3, shopId: 2, cents: 30n, qty: 3, weight: 2.5, label: 'c', paid: true }, { id: 4, shopId: 3, cents: 40n, qty: null, weight: null, label: null, paid: true },
    { id: 5, shopId: 4, cents: 50n, qty: 5, weight: 0.5, label: 'z', paid: false }, { id: 6, shopId: null, cents: 999n, qty: 9, weight: 9, label: 'orphan', paid: true }]);
  db.table(refunds).insertMany([{ id: 1, shopId: 1, cents: 3n }, { id: 2, shopId: 1, cents: 4n }, { id: 3, shopId: 3, cents: 5n }]);
  db.table(tags).insertMany([{ id: 1, name: 'red' }, { id: 2, name: 'blue' }]);
  db.table(saleTags).insertMany([{ id: 1, saleId: 1, tagId: 1 }, { id: 2, saleId: 1, tagId: 1 }, { id: 3, saleId: 3, tagId: 2 }]);
  return db;
}
function disk(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-grouped-related-')), file = join(dir, 'fictional.sqlite');
  const raw = new DatabaseSync(file); raw.exec(sql); raw.close();
  return { file, cleanup: () => { if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true }); } };
}

test('root aggregate: related values over every filtered root row; empty filters give 0/NULL; orphans and NULL keys never match', () => {
  const db = seeded();
  try {
    const select = { shops: agg.count(), sales: agg.related(shopSales, agg.count()), qtyValues: agg.related(shopSales, agg.count(sales.col('qty'))),
      cents: agg.related(shopSales, agg.sum(sales.col('cents'))), meanQty: agg.related(shopSales, agg.avg(sales.col('qty'))),
      weight: agg.related(shopSales, agg.sum(sales.col('weight'))), firstLabel: agg.related(shopSales, agg.min(sales.col('label'))), maxCents: agg.related(shopSales, agg.max(sales.col('cents'))) };
    assert.deepEqual(db.table(shops).aggregate({ select }), { shops: 5, sales: 5, qtyValues: 4, cents: 150n, meanQty: 11 / 4, weight: 4.5, firstLabel: 'A', maxCents: 50n });
    assert.deepEqual(db.table(shops).aggregate({ where: gt(shops.col('tier'), 9), select }),
      { shops: 0, sales: 0, qtyValues: 0, cents: null, meanQty: null, weight: null, firstLabel: null, maxCents: null });
    assert.deepEqual(db.table(shops).aggregate({ where: eq(shops.col('id'), 5), select }),
      { shops: 1, sales: 0, qtyValues: 0, cents: null, meanQty: null, weight: null, firstLabel: null, maxCents: null }, 'a root row without children');
    assert.deepEqual(db.table(shops).aggregate({ where: eq(shops.col('tier'), 1), select: { cents: agg.related(paidSales, agg.sum(sales.col('cents'))) } }), { cents: 50n }, 'domain: paid only');
  } finally { db.close(); }
});

test('groupBy: per-group related values, NULL key group, root selectors unchanged, every matching path counted (no DISTINCT)', () => {
  const db = seeded();
  try {
    const rows = db.table(shops).groupBy({ by: ['regionId'], select: {
      shops: agg.count(), tiers: agg.sum(shops.col('tier')), sales: agg.related(shopSales, agg.count()), cents: agg.related(shopSales, agg.sum(sales.col('cents'))),
      tagLinks: agg.related(shopSales, agg.related(saleLinks, agg.count())), redTags: agg.related(shopSales, agg.related(saleLinks, agg.related(linkTag, agg.count()))) } });
    assert.deepEqual(rows, [
      { regionId: null, shops: 1, tiers: 3n, sales: 1, cents: 50n, tagLinks: 0, redTags: 0 },
      { regionId: 1, shops: 2, tiers: 3n, sales: 3, cents: 60n, tagLinks: 3, redTags: 3 },
      { regionId: 2, shops: 2, tiers: 3n, sales: 1, cents: 40n, tagLinks: 0, redTags: 0 },
    ]);
    assert.deepEqual(db.table(shops).groupBy({ by: ['regionId'], where: gt(shops.col('tier'), 9), select: { n: agg.related(shopSales, agg.count()) } }), []);
  } finally { db.close(); }
});

test('no fan-out: mixed root and independent related selectors equal separate calls and the oracle', () => {
  const db = seeded();
  try {
    const mixed = db.table(shops).groupBy({ by: ['area'], select: { shops: agg.count(), sales: agg.related(shopSales, agg.sum(sales.col('cents'))), refunds: agg.related(shopRefunds, agg.sum(refunds.col('cents'))) } });
    const one = sel => db.table(shops).groupBy({ by: ['area'], select: { v: sel } }).map(r => r.v);
    assert.deepEqual(mixed.map(r => r.shops), one(agg.count()));
    assert.deepEqual(mixed.map(r => r.sales), one(agg.related(shopSales, agg.sum(sales.col('cents')))));
    assert.deepEqual(mixed.map(r => r.refunds), one(agg.related(shopRefunds, agg.sum(refunds.col('cents')))));
    // Oracle: core = shops 1,3; edge = 2,5; NULL = 4. Shop 1 has 2 sales x 2 refunds, the classic fan-out shape.
    assert.deepEqual(mixed, [
      { area: null, shops: 1, sales: 50n, refunds: null }, { area: 'core', shops: 2, sales: 70n, refunds: 12n }, { area: 'edge', shops: 2, sales: 30n, refunds: null }]);
  } finally { db.close(); }
});

test('leaf-weighted AVG, exact sums beyond int64 with negative carries, related ordering, real overflow', () => {
  const db = seeded();
  try {
    // Shops 1 (qty 1,2) and 2 (qty 3) share region 1: leaf-weighted (1+2+3)/3 = 2, not the per-shop mean of means 2.25.
    assert.equal(db.table(shops).groupBy({ by: ['regionId'], where: eq(shops.col('regionId'), 1), select: { m: agg.related(shopSales, agg.avg(sales.col('qty'))) } })[0].m, 2);
    db.table(sales).insertMany([{ id: 7, shopId: 2, cents: MAX, qty: null, weight: 1e308, label: null, paid: true }, { id: 8, shopId: 1, cents: MAX, qty: null, weight: 1e308, label: null, paid: true },
      { id: 9, shopId: 3, cents: -MAX - 1n, qty: null, weight: null, label: null, paid: true }]);
    const totals = db.table(shops).groupBy({ by: ['regionId'], select: { c: agg.related(shopSales, agg.sum(sales.col('cents'))) }, orderBy: [{ field: 'c', direction: 'desc' }] });
    assert.deepEqual(totals.map(r => [r.regionId, r.c]), [[1, 2n * MAX + 60n], [null, 50n], [2, -MAX - 1n + 40n]]);
    assert.deepEqual(db.table(shops).groupBy({ by: ['regionId'], select: { c: agg.related(shopSales, agg.sum(sales.col('cents'))) }, orderBy: [{ field: 'c', direction: 'asc' }] }).map(r => r.regionId), [2, null, 1]);
    assert.equal(db.table(shops).aggregate({ select: { c: agg.related(shopSales, agg.sum(sales.col('cents'))) } }).c, MAX + 149n, '150 + MAX + MAX + (-MAX - 1)');
    assert.throws(() => db.table(shops).aggregate({ select: { w: agg.related(shopSales, agg.sum(sales.col('weight'))) } }), coded('AGGREGATE_RANGE'));
    assert.throws(() => agg.related(shopSales, agg.avg(sales.col('cents'))), coded('QUERY'));
    assert.equal(typeof db.table(shops).aggregate({ select: { m: agg.related(shopSales, agg.avg(sales.col('cents'), { approximate: true })) } }).m, 'number');
  } finally { db.close(); }
});

test('collation: one flattened MIN/MAX keeps the leaf collation; IS correlation keeps key collation, NULL group and multiple keys', () => {
  const fixture = disk(`CREATE TABLE gr_owners(id INTEGER NOT NULL PRIMARY KEY, code TEXT COLLATE NOCASE, band INTEGER);
    CREATE TABLE gr_items(id INTEGER NOT NULL PRIMARY KEY, ownerId INTEGER NOT NULL, label TEXT NOT NULL COLLATE NOCASE, plain TEXT NOT NULL);
    INSERT INTO gr_owners VALUES (1,'a',1),(2,'A',1),(3,NULL,2),(4,'b',2),(5,'b',NULL);
    INSERT INTO gr_items VALUES (1,1,'b','b'),(2,2,'C','C'),(3,3,'z','z'),(4,4,'Y','Y'),(5,4,'x','x'),(6,5,'q','q');`);
  try {
    const owners = defineTable('gr_owners', { id: column.integer().primaryKey(), code: column.text().nullable(), band: column.integer().nullable() });
    const items = defineTable('gr_items', { id: column.integer().primaryKey(), ownerId: column.integer(), label: column.text(), plain: column.text() });
    const db = openDatabase(fixture.file, { tables: [owners, items], readOnly: true });
    try {
      const rel = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId') });
      const root = db.table(owners).aggregate({ where: inArray(owners.col('id'), [1, 2]), select: { nocase: agg.related(rel, agg.min(items.col('label'))), binary: agg.related(rel, agg.min(items.col('plain'))) } });
      assert.deepEqual(root, { nocase: 'b', binary: 'C' }, 'per-row composition would return C for the NOCASE column');
      const groups = db.table(owners).groupBy({ by: ['code'], select: { owners: agg.count(), items: agg.related(rel, agg.count()), low: agg.related(rel, agg.min(items.col('label'))), high: agg.related(rel, agg.max(items.col('label'))) } });
      assert.deepEqual(groups.map(g => [g.code === null ? null : g.code.toLowerCase(), g.owners, g.items, g.low, g.high]), [[null, 1, 1, 'z', 'z'], ['a', 2, 2, 'b', 'C'], ['b', 2, 3, 'q', 'Y']]);
      const multi = db.table(owners).groupBy({ by: ['code', 'band'], select: { items: agg.related(rel, agg.count()) } });
      assert.deepEqual(multi.map(g => [g.code === null ? null : g.code.toLowerCase(), g.band, g.items]), [[null, 2, 1], ['a', 1, 2], ['b', null, 1], ['b', 2, 2]]);
    } finally { db.close(); }
  } finally { fixture.cleanup(); }
});

test('pagination: values for returned groups only, but the related guard covers off-page matched leaves; RESULT_LIMIT unchanged', () => {
  const fixture = disk(`CREATE TABLE gr_owners(id INTEGER NOT NULL PRIMARY KEY, grp TEXT NOT NULL, rootKey INTEGER NOT NULL);
    CREATE TABLE gr_items(id INTEGER NOT NULL PRIMARY KEY, ownerKey INTEGER NOT NULL, qty INTEGER NOT NULL, ok INTEGER NOT NULL);
    INSERT INTO gr_owners VALUES (1,'a',1),(2,'b',2),(3,'c',9007199254740993);
    INSERT INTO gr_items VALUES (1,1,5,1),(2,2,'oops',1),(3,9007199254740993,7,1),(4,2,8,0);`);
  try {
    const owners = defineTable('gr_owners', { id: column.integer().primaryKey(), grp: column.text(), rootKey: column.integer() });
    const items = defineTable('gr_items', { id: column.integer().primaryKey(), ownerKey: column.bigint(), qty: column.integer(), ok: column.boolean() });
    const db = openDatabase(fixture.file, { tables: [owners, items], readOnly: true });
    try {
      const rel = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerKey') });
      const sum = { s: agg.related(rel, agg.sum(items.col('qty'))) };
      assert.throws(() => db.table(owners).groupBy({ by: ['grp'], select: sum, orderBy: [{ field: 'grp', direction: 'asc' }], limit: 1 }), coded('DATA'), 'bad leaf in off-page group b');
      assert.deepEqual(db.table(owners).groupBy({ by: ['grp'], where: eq(owners.col('grp'), 'a'), select: sum }), [{ grp: 'a', s: 5n }], 'filtered-out bad rows pass');
      const okOnly = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerKey'), where: eq(items.col('ok'), false) });
      assert.deepEqual(db.table(owners).groupBy({ by: ['grp'], where: eq(owners.col('grp'), 'b'), select: { s: agg.related(okOnly, agg.sum(items.col('qty'))) } }), [{ grp: 'b', s: 8n }], 'rows outside the domain pass');
      assert.deepEqual(db.table(owners).groupBy({ by: ['grp'], where: eq(owners.col('grp'), 'b'), select: { n: agg.related(rel, agg.count()) } }), [{ grp: 'b', n: 2 }], 'COUNT(*) does not certify the leaf column');
      const viaKey = hasMany(items, { localKey: owners.col('rootKey'), foreignKey: items.col('ownerKey') });
      assert.throws(() => db.table(owners).aggregate({ where: eq(owners.col('grp'), 'c'), select: { n: agg.related(viaKey, agg.count()) } }), coded('DATA'), 'unsafe root correlation key');
      assert.throws(() => db.table(owners).groupBy({ by: ['grp'], where: eq(owners.col('grp'), 'c'), select: { n: agg.related(viaKey, agg.count()) } }), coded('DATA'));
    } finally { db.close(); }
  } finally { fixture.cleanup(); }
  const big = disk("CREATE TABLE gr_owners(id INTEGER NOT NULL PRIMARY KEY, grp TEXT NOT NULL, rootKey INTEGER NOT NULL); CREATE TABLE gr_items(id INTEGER NOT NULL PRIMARY KEY, ownerKey INTEGER NOT NULL, qty INTEGER NOT NULL, ok INTEGER NOT NULL); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001) INSERT INTO gr_owners SELECT i, 'g' || i, i FROM n;");
  try {
    const owners = defineTable('gr_owners', { id: column.integer().primaryKey(), grp: column.text(), rootKey: column.integer() });
    const items = defineTable('gr_items', { id: column.integer().primaryKey(), ownerKey: column.bigint(), qty: column.integer(), ok: column.boolean() });
    const db = openDatabase(big.file, { tables: [owners, items], readOnly: true });
    try {
      const rel = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerKey') });
      assert.throws(() => db.table(owners).groupBy({ by: ['grp'], select: { n: agg.related(rel, agg.count()) } }), coded('RESULT_LIMIT'));
      assert.equal(db.table(owners).groupBy({ by: ['grp'], select: { n: agg.related(rel, agg.count()) }, limit: 3, offset: 10 }).length, 3);
    } finally { db.close(); }
  } finally { big.cleanup(); }
});

test('self-relations are aliased; brands, registration, scope and alias rules hold for root aggregate/groupBy', () => {
  const nodes = defineTable('gr_nodes', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), kind: column.text() });
  const db = openDatabase(':memory:', { tables: [nodes, ...all] });
  try {
    db.ensureSchema();
    db.table(nodes).insertMany([{ id: 1, parentId: null, kind: 'root' }, { id: 2, parentId: 1, kind: 'leaf' }, { id: 3, parentId: 1, kind: 'leaf' }, { id: 4, parentId: 2, kind: 'leaf' }]);
    const children = hasMany(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('parentId') });
    assert.deepEqual(db.table(nodes).groupBy({ by: ['kind'], select: { nodes: agg.count(), children: agg.related(children, agg.count()), grandchildren: agg.related(children, agg.related(children, agg.count())) } }),
      [{ kind: 'leaf', nodes: 3, children: 1, grandchildren: 0 }, { kind: 'root', nodes: 1, children: 2, grandchildren: 1 }]);
    const n = agg.related(children, agg.count());
    assert.throws(() => db.table(nodes).findMany({ aggregates: { n: agg.count() } }), coded('QUERY'), 'findMany still refuses plain selectors');
    for (const [options, label] of [
      [{ select: { n: Object.freeze({ relation: children, selector: agg.count() }) } }, 'forged related value'],
      [{ select: { n: agg.related(shopSales, agg.count()) } }, 'relation must start from the queried table'],
      [{ select: { n: agg.related(children, agg.sum(sales.col('cents'))) } }, 'leaf column from another table'],
    ]) assert.throws(() => db.table(nodes).aggregate(options), coded('QUERY'), label);
    assert.throws(() => db.table(nodes).groupBy({ by: ['kind'], select: { KIND: n } }), coded('QUERY'), 'alias repeats a group key ignoring case');
    assert.throws(() => db.table(nodes).aggregate({ select: { __rs_bad: n } }), coded('QUERY'));
    assert.throws(() => agg.related(hasMany(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('parentId'), limit: 1 }), agg.count()), coded('QUERY'));
    const stray = defineTable('gr_unregistered', { id: column.integer().primaryKey(), nodeId: column.integer() });
    assert.throws(() => db.table(nodes).aggregate({ select: { n: agg.related(hasMany(stray, { localKey: nodes.col('id'), foreignKey: stray.col('nodeId') }), agg.count()) } }), coded('SCHEMA'));
    assert.throws(() => aggregateToModel(nodes, { select: { n } }, () => undefined), coded('QUERY'), 'a predicate-only lowering cannot check registration');
    assert.ok(aggregateToModel(nodes, { select: { n: agg.count() } }, () => undefined).select.length === 1, 'legacy lowering keeps root selections');
  } finally { db.close(); }
});

test('one shared logical budget and a physical budget that counts every repeated root-filter copy', () => {
  const db = seeded();
  try {
    const ids = count => Array.from({ length: count }, (_, i) => i + 1);
    const n = agg.related(shopSales, agg.count());
    // Root where of 2,000 values with two related counts: 2,000 x (1 + 2 x 2 copies) = 10,000 bound values exactly.
    assert.equal(db.table(shops).aggregate({ where: inArray(shops.col('id'), ids(2000)), select: { a: n, b: n } }).a, 5);
    assert.throws(() => db.table(shops).aggregate({ where: inArray(shops.col('id'), ids(2001)), select: { a: n, b: n } }), coded('QUERY'));
    assert.equal(db.table(shops).aggregate({ where: inArray(shops.col('id'), ids(9000)), select: { a: agg.count() } }).a, 5, 'root selectors alone keep the M6 bound');
    const sumCopies = db.table(shops).compileAggregate({ where: inArray(shops.col('id'), ids(10)), select: { s: agg.related(shopSales, agg.sum(sales.col('cents'))) } });
    assert.equal(sumCopies.parameters.length, 10 * (1 + 3), 'split sum: two value copies plus guard plus the main where');
    const domain = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId'), where: and(...Array.from({ length: 40 }, (_, i) => gt(sales.col('id'), -i))) });
    const rootWhere = and(...Array.from({ length: 70 }, (_, i) => gt(shops.col('id'), -i)));
    assert.equal(db.table(shops).aggregate({ where: rootWhere, select: { a: agg.count() } }).a, 5);
    assert.equal(db.table(shops).aggregate({ select: { a: agg.related(domain, agg.count()) } }).a, 5);
    assert.throws(() => db.table(shops).aggregate({ where: rootWhere, select: { a: agg.related(domain, agg.count()) } }), coded('QUERY'), 'shared 100-node budget');
  } finally { db.close(); }
});

test('qualified root-only SQL retains its slots; related SQL is bound, explainable and read-only safe', () => {
  const db = seeded();
  try {
    const plain = db.table(shops).compileGroupBy({ by: ['area'], where: gt(shops.col('tier'), 1), select: { n: agg.count(), t: agg.sum(shops.col('tier')) }, orderBy: [{ field: 't', direction: 'desc' }], limit: 5 });
    assert.equal(plain.sql, 'SELECT "__rs_root"."area" AS "__rs_key_0", COUNT(*) AS "__rs_agg_0", (SUM(("__rs_root"."tier" >> 32)) + (SUM(("__rs_root"."tier" & 4294967295)) >> 32)) AS "__rs_sum_hi_1", (SUM(("__rs_root"."tier" & 4294967295)) & 4294967295) AS "__rs_sum_lo_1", COALESCE(MAX(MAX((CASE WHEN (CASE WHEN "__rs_root"."area" IS NULL THEN 0 WHEN typeof("__rs_root"."area") = \'text\' THEN 0 ELSE 1 END) OR (CASE WHEN "__rs_root"."tier" IS NULL THEN 1 WHEN typeof("__rs_root"."tier") = \'integer\' AND "__rs_root"."tier" BETWEEN -9007199254740991 AND 9007199254740991 THEN 0 ELSE 1 END) THEN 1 ELSE 0 END))) OVER (), 0) AS "__rs_bad" FROM "main"."gr_shops" AS "__rs_root" WHERE "__rs_root"."tier" > ? GROUP BY "__rs_root"."area" ORDER BY 3 DESC, 4 DESC, 1 ASC LIMIT ? OFFSET ?');
    assert.deepEqual(plain.parameters, [1, 5, 0]);
    const sentinel = "SENTINEL_' OR 1=1 --";
    const marked = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId'), where: eq(sales.col('label'), sentinel) });
    db.clearTrace();
    const compiled = db.table(shops).compileGroupBy({ by: ['area'], where: eq(shops.col('area'), 'core'), select: { s: agg.related(marked, agg.count()) } });
    assert.ok(!compiled.sql.includes('SENTINEL') && !compiled.sql.includes('"s"'));
    const outerFrom = compiled.sql.lastIndexOf(' FROM "main"."gr_shops" AS "__rs_root" WHERE ');
    assert.ok(outerFrom > 0, 'The outer query reads the qualified root');
    assert.doesNotMatch(compiled.sql.slice(outerFrom), /\bJOIN\b/, 'Related aggregation does not multiply outer root rows');
    assert.deepEqual(compiled.parameters, ['core', sentinel, 'core', sentinel, 'core', 10001, 0], 'value copy, guard copy, then main where and page');
    assert.equal(db.exportTrace().queries.length, 0, 'compile does not execute');
    assert.ok(db.table(shops).explainGroupBy({ by: ['area'], select: { s: agg.related(shopSales, agg.count()) } }).some(step => /CORRELATED|SUBQUERY/.test(step.detail)));
    let escaped;
    db.transaction(tx => { escaped = tx.table(shops); assert.equal(escaped.aggregate({ select: { s: agg.related(shopSales, agg.count()) } }).s, 5); });
    assert.throws(() => escaped.aggregate({ select: { s: agg.related(shopSales, agg.count()) } }), coded('TRANSACTION_CLOSED'));
  } finally { db.close(); }
});

test('several related selectors with different domains, including split sums, bind in SQL order', () => {
  const db = seeded();
  try {
    const byPaid = paid => hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId'), where: eq(sales.col('paid'), paid) });
    const select = { paid: agg.related(byPaid(true), agg.sum(sales.col('cents'))), unpaid: agg.related(byPaid(false), agg.sum(sales.col('cents'))), unpaidCount: agg.related(byPaid(false), agg.count()) };
    assert.deepEqual(db.table(shops).groupBy({ by: ['regionId'], where: gt(shops.col('tier'), 0), select }), [
      { regionId: null, paid: null, unpaid: 50n, unpaidCount: 1 }, { regionId: 1, paid: 40n, unpaid: 20n, unpaidCount: 1 }, { regionId: 2, paid: 40n, unpaid: null, unpaidCount: 0 }]);
    assert.deepEqual(db.table(shops).aggregate({ where: gt(shops.col('tier'), 0), select }), { paid: 80n, unpaid: 70n, unpaidCount: 2 });
    const compiled = db.table(shops).compileAggregate({ where: gt(shops.col('tier'), 0), select });
    // tier and paid values per copy: paid hi, paid lo, unpaid hi, unpaid lo, unpaidCount value, then three guards, then the main where.
    assert.deepEqual(compiled.parameters, [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  } finally { db.close(); }
});
