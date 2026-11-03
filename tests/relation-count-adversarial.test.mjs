import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, countRelated, some, none, every,
  eq, isNull, and, or, not, inArray, RowstitchError } from '../dist/index.js';
import { predicateModel, predicateTruth, queryModel } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate } from '../dist/core/sqlite-compiler.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const invalid = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA', 'VALIDATION'].includes(error.code);
const ids = rows => rows.map(row => row.id);
const comparison = {
  '=': (left, right) => left === right, '<>': (left, right) => left !== right,
  '>': (left, right) => left > right, '>=': (left, right) => left >= right,
  '<': (left, right) => left < right, '<=': (left, right) => left <= right,
};
function memory(t, tables, options = {}) {
  const db = openDatabase(':memory:', { tables, ...options }); t.after(() => db.close());
  db.ensureSchema(); db.clearTrace(); return db;
}
function models() {
  const parent = defineTable('count_parents', { id: column.integer().primaryKey(), label: column.text(), version: column.integer().default(1) }, { version: 'version' });
  const child = defineTable('count_children', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), flag: column.boolean().nullable(), label: column.text() });
  return { parent, child, relation: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') }) };
}

test('all count operators agree with hand-counted physical rows, NULL tests and filtered domains', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insertMany(Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: 'Parent ' + (i + 1) })));
  db.table(child).insertMany([
    { id: 1, parentId: 2, flag: true, label: 'inside' }, { id: 2, parentId: 3, flag: false, label: 'inside' },
    { id: 3, parentId: 3, flag: null, label: 'inside' }, { id: 4, parentId: 4, flag: true, label: 'inside' },
    { id: 5, parentId: 4, flag: true, label: 'outside' }, { id: 6, parentId: 4, flag: null, label: 'inside' },
    { id: 7, parentId: 5, flag: null, label: 'outside' }, { id: 8, parentId: null, flag: true, label: 'inside' },
  ]);
  const domain = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: eq(child.col('label'), 'inside') });
  const cases = [[relation, undefined, [0, 1, 2, 3, 1, 0]], [domain, undefined, [0, 1, 2, 2, 0, 0]],
    [domain, eq(child.col('flag'), true), [0, 1, 0, 1, 0, 0]], [relation, isNull(child.col('flag')), [0, 0, 1, 1, 1, 0]]];
  for (const [related, predicate, expectedCounts] of cases) for (const [operator, compare] of Object.entries(comparison)) {
    for (const threshold of [0, 1, 2, 3, 4, Number.MAX_SAFE_INTEGER]) {
      const expected = expectedCounts.flatMap((count, index) => compare(count, threshold) ? [index + 1] : []);
      const where = countRelated(related, operator, threshold, predicate);
      assert.deepEqual(ids(db.table(parent).findMany({ where })), expected, operator + ' ' + threshold);
      assert.equal(db.table(parent).count(where), expected.length);
    }
  }
});

test('count thresholds reject coercion and unsafe numbers while zero remains a valid boundary', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insert({ id: 1, label: 'Empty' }); db.clearTrace();
  let conversions = 0;
  const numberLike = { valueOf() { conversions++; return 1; }, toString() { conversions++; return '1'; } };
  for (const threshold of [-1, -0.5, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, '1', null, undefined, true, new Number(1), numberLike]) {
    assert.throws(() => countRelated(relation, '=', threshold), coded('QUERY'));
  }
  for (const operator of ['!=', 'IN', '==', '', '= 0 OR 1=1 --', null, undefined, ['='], numberLike]) {
    assert.throws(() => countRelated(relation, operator, 1), coded('QUERY'));
  }
  assert.equal(conversions, 0); assert.equal(db.exportTrace().queries.length, 0);
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '>=', -0) })), [1]);
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '<', 0) })), []);
  const compiled = db.table(parent).compileSelect({ where: countRelated(relation, '<', Number.MAX_SAFE_INTEGER) });
  assert.equal(compiled.parameters[0], Number.MAX_SAFE_INTEGER);
});

test('relation counts are not capped by eager pagination or the default child limit', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insertMany([{ id: 1, label: 'Many children' }, { id: 2, label: 'Empty' }]);
  const rows = Array.from({ length: 1205 }, (_, index) => ({ id: index + 1, parentId: 1, flag: null, label: 'Repeated value' }));
  db.table(child).insertMany(rows.slice(0, 1000)); db.table(child).insertMany(rows.slice(1000)); db.clearTrace();
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '=', 1205) })), [1]);
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '>', 1000) })), [1]);
  const queries = db.exportTrace().queries;
  assert.equal(queries.length, 2); assert.ok(queries.every(query => /count\(\*\)/i.test(query.sql)));
  assert.ok(queries.every(query => query.rowCount === 1));
  for (const make of [hasOne, belongsTo]) {
    const singular = make(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') });
    assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(singular, '=', 1205) })), [1]);
    assert.throws(() => db.table(parent).findMany({ include: { singular } }), coded('RELATION_CARDINALITY'));
  }
});

test('nested counts and quantifiers use immediate self-relation scopes and distinct sibling aliases', t => {
  const node = defineTable('count_nodes', { id: column.integer().primaryKey(), parentId: column.integer().nullable() });
  const db = memory(t, [node]), repo = db.table(node);
  repo.insertMany([{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 1 },
    { id: 4, parentId: 2 }, { id: 5, parentId: 2 }, { id: 6, parentId: 3 }, { id: 7, parentId: 7 }]);
  const relation = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId') });
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 2) })), [1, 2]);
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 1, countRelated(relation, '=', 2)) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: some(relation, countRelated(relation, '>=', 2)) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 1, none(relation)) })), [3]);
  assert.deepEqual(ids(repo.findMany({ where: every(relation, countRelated(relation, '=', 0)) })), [2, 3, 4, 5, 6]);
  const compiled = repo.compileSelect({ where: and(countRelated(relation, '>=', 1, some(relation)), some(relation, countRelated(relation, '=', 0))) });
  const aliases = compiled.sql.match(/ AS "__rs_[^"]+"/g) ?? [];
  assert.equal(aliases.length, 4); assert.equal(new Set(aliases).size, 4);
  assert.deepEqual(compiled.parameters, [1, 0, 1000, 0]);
});

test('count domains, tests and thresholds remain bound in order with default trace redaction', t => {
  const { parent, child } = models(), db = memory(t, [parent, child]);
  const phrase = "Fictional count ' ? -- %_ value\0tail 🧵";
  db.table(parent).insert({ id: 1, label: 'Original' });
  db.table(child).insert({ id: 1, parentId: 1, flag: true, label: phrase });
  const options = { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: eq(child.col('label'), phrase) };
  const relation = hasMany(child, options), where = countRelated(relation, '=', 1, eq(child.col('flag'), true));
  options.where = or(); options.localKey = parent.col('version');
  const compiled = db.table(parent).compileSelect({ where, limit: 1, offset: 0 });
  assert.deepEqual(compiled.parameters, [phrase, 1, 1, 1, 0]);
  assert.ok(!compiled.sql.includes('Fictional')); assert.ok(!compiled.sql.includes('\0'));
  db.clearTrace(); assert.deepEqual(ids(db.table(parent).findMany({ where, limit: 1 })), [1]);
  const trace = db.exportTrace().queries;
  assert.equal(trace.length, 1); assert.deepEqual(trace[0].parameters, Array(5).fill('[redacted]'));
  assert.ok(!JSON.stringify(trace).includes('Fictional'));
});

test('trivial count truths never bypass registered targets, malformed scopes or eager option rejection', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent]);
  for (const where of [countRelated(relation, '>=', 0), countRelated(relation, '<', 0), countRelated(relation, '=', 0, or())]) {
    for (const read of [() => db.table(parent).findMany({ where, limit: 0 }), () => db.table(parent).findFirst({ where }),
      () => db.table(parent).compileSelect({ where }), () => db.table(parent).explain({ where }), () => db.table(parent).count(where)]) {
      assert.throws(read, coded('SCHEMA')); assert.equal(db.exportTrace().queries.length, 0);
    }
  }
  const all = memory(t, [parent, child]);
  assert.throws(() => all.table(parent).count(countRelated(relation, '>=', 0, eq(parent.col('id'), 1))), coded('QUERY'));
  assert.throws(() => all.table(child).count(countRelated(relation, '>=', 0)), coded('QUERY'));
  const impostor = defineTable(child.name, { ...child.columns });
  assert.throws(() => all.table(parent).count(countRelated(hasMany(impostor, { localKey: parent.col('id'), foreignKey: impostor.col('parentId') }), '>=', 0)), coded('SCHEMA'));
  for (const extra of [{ limit: 0 }, { offset: 0 }, { orderBy: [] }, { include: {} }, { select: ['id'] }]) {
    assert.throws(() => countRelated(hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), ...extra }), '>=', 0), coded('QUERY'));
  }
  let calls = 0;
  const forged = Object.create(Object.getPrototypeOf(relation));
  Object.defineProperties(forged, { options: { value: relation.options }, table: { get() { calls++; return child; } } });
  assert.throws(() => countRelated(forged, '>=', 0), coded('QUERY'));
  assert.throws(() => countRelated(new Proxy(relation, {}), '>=', 0), coded('QUERY'));
  assert.equal(calls, 0); assert.equal(all.exportTrace().queries.length, 0);
});

test('count filters inside eager windows retain pagination and prevalidate nested target registration', t => {
  const parent = defineTable('count_window_parents', { id: column.text().primaryKey() });
  const child = defineTable('count_window_children', { id: column.integer().primaryKey(), parentId: column.text() });
  const leaf = defineTable('count_window_leaves', { id: column.integer().primaryKey(), childId: column.integer() });
  const relation = hasMany(leaf, { localKey: child.col('id'), foreignKey: leaf.col('childId') });
  const include = { selected: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: countRelated(relation, '>=', 2), offset: 1, limit: 1 }) };
  const missing = memory(t, [parent, child]);
  assert.throws(() => missing.table(parent).findMany({ include }), coded('SCHEMA'));
  assert.equal(missing.exportTrace().queries.length, 0);
  const db = memory(t, [parent, child, leaf]);
  db.table(parent).insertMany([{ id: 'a' }, { id: 'b' }]);
  db.table(child).insertMany([{ id: 1, parentId: 'a' }, { id: 2, parentId: 'a' }, { id: 3, parentId: 'a' }, { id: 4, parentId: 'b' }]);
  db.table(leaf).insertMany([{ id: 1, childId: 1 }, { id: 2, childId: 2 }, { id: 3, childId: 2 }, { id: 4, childId: 3 }, { id: 5, childId: 3 }, { id: 6, childId: 4 }, { id: 7, childId: 4 }]);
  db.clearTrace();
  assert.deepEqual(db.table(parent).findMany({ include }), [{ id: 'a', selected: [{ id: 3, parentId: 'a' }] }, { id: 'b', selected: [] }]);
  assert.equal(db.exportTrace().queries.length, 2);
});

test('count key correlation retains exact bigint and mixed integer domains', t => {
  const parent = defineTable('count_big_parents', { id: column.bigint().primaryKey() });
  const small = defineTable('count_small_parents', { id: column.integer().primaryKey() });
  const child = defineTable('count_big_children', { id: column.integer().primaryKey(), parentId: column.bigint().nullable() });
  const db = memory(t, [parent, small, child]);
  const keys = [-(2n ** 63n), 1n, 9007199254740992n, 9007199254740993n, 2n ** 63n - 1n];
  db.table(parent).insertMany(keys.map(id => ({ id }))); db.table(small).insertMany([{ id: 1 }, { id: 2 }]);
  db.table(child).insertMany([{ id: 1, parentId: keys[0] }, { id: 2, parentId: 1n }, { id: 3, parentId: keys[3] }, { id: 4, parentId: keys[3] }, { id: 5, parentId: keys[4] }, { id: 6, parentId: null }]);
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') });
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '=', 2) })), [keys[3]]);
  assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '=', 0) })), [keys[2]]);
  const mixed = hasMany(child, { localKey: small.col('id'), foreignKey: child.col('parentId') });
  assert.deepEqual(ids(db.table(small).findMany({ where: countRelated(mixed, '=', 1) })), [1]);
});

test('count correlation follows foreign-key collation including NULL and NUL in all SQLite encodings', t => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) for (const [parentCollation, childCollation, key, foreignKey, count] of [
    ['BINARY', 'NOCASE', 'Alpha', 'alpha', 2], ['NOCASE', 'BINARY', 'Alpha', 'alpha', 0],
    ['BINARY', 'RTRIM', 'key', 'key ', 2], ['RTRIM', 'BINARY', 'key', 'key ', 0],
    ['BINARY', 'NOCASE', 'A\0X', 'a\0Y', 2], ['BINARY', 'BINARY', '01', '1', 0],
  ]) {
    const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-count-collation-'));
    assert.ok(resolve(directory).startsWith(root + sep));
    const filename = join(directory, 'fictional.sqlite'), raw = new DatabaseSync(filename, { allowExtension: false, defensive: true }); let db;
    t.after(() => { try { db?.close(); } finally { raw.close(); unlinkSync(filename); rmdirSync(directory); } });
    raw.exec("PRAGMA encoding='" + encoding + "'; CREATE TABLE count_collation_roots(id INTEGER PRIMARY KEY, code TEXT COLLATE " + parentCollation + ');'
      + 'CREATE TABLE count_collation_children(id INTEGER PRIMARY KEY, parentCode TEXT COLLATE ' + childCollation + ');');
    raw.prepare('INSERT INTO count_collation_roots VALUES(?,?)').run(1, key);
    raw.prepare('INSERT INTO count_collation_roots VALUES(?,?)').run(2, null);
    const insert = raw.prepare('INSERT INTO count_collation_children VALUES(?,?)');
    insert.run(1, foreignKey); insert.run(2, foreignKey); insert.run(3, null);
    const parent = defineTable('count_collation_roots', { id: column.integer().primaryKey(), code: column.text().nullable() });
    const child = defineTable('count_collation_children', { id: column.integer().primaryKey(), parentCode: column.text().nullable() });
    db = openDatabase(filename, { tables: [parent, child], readOnly: true });
    const relation = hasMany(child, { localKey: parent.col('code'), foreignKey: child.col('parentCode') });
    assert.equal(raw.prepare('SELECT count(*) AS n FROM count_collation_children WHERE parentCode = ?').get(key).n, count);
    assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '=', 2) })), count === 2 ? [1] : []);
    assert.deepEqual(ids(db.table(parent).findMany({ where: countRelated(relation, '=', 0) })), count === 2 ? [2] : [1, 2]);
  }
});

test('count predicates reject writes even when truth is constant or hidden under logical operators', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insert({ id: 1, label: 'Original' });
  const before = db.table(parent).findMany(); db.clearTrace();
  const filter = countRelated(relation, '>=', 1);
  for (const where of [filter, countRelated(relation, '>=', 0), countRelated(relation, '<', 0), countRelated(relation, '=', 0, or()),
    not(filter), and(or(), filter), or(and(), filter), some(relation, countRelated(hasMany(parent, { localKey: child.col('parentId'), foreignKey: parent.col('id') }), '>=', 0))]) {
    assert.throws(() => db.table(parent).update({ label: 'Changed' }, { where }), coded('UNSAFE_WRITE'));
    assert.throws(() => db.table(parent).delete({ where }), coded('UNSAFE_WRITE'));
    assert.equal(db.exportTrace().queries.length, 0);
  }
  assert.deepEqual(db.table(parent).findMany(), before);
});

const tableModel = (name = 'count_model_roots') => ({ name, columns: ['id', 'parentId', 'label'], primaryKey: ['id'], kinds: { id: 'integer', parentId: 'integer', label: 'text' } });
const scalar = (values, column = 'id') => ({ kind: 'compare', column, operator: 'IN', values });
const countModel = extra => ({ kind: 'relation-count', table: tableModel('count_model_children'), localKey: 'id', foreignKey: 'parentId', operator: '>=', threshold: 1, ...extra });
const filterModel = (predicate, quantifier = 'some') => ({ kind: 'relation-filter', table: tableModel('count_model_children'), localKey: 'id', foreignKey: 'parentId', quantifier, predicate });

test('count model validation rejects extra SQL, malformed thresholds and metadata without coercion', () => {
  const root = tableModel();
  for (const change of [{ operator: 'IN' }, { operator: '= 0 OR 1=1 --' }, { threshold: -1 }, { threshold: 0.5 }, { threshold: 1n }, { threshold: '1' }, { threshold: Number.MAX_SAFE_INTEGER + 1 },
    { threshold: undefined }, { alias: 'count_model_roots' }, { quantifier: 'some' }, { sql: 'SELECT 1' }, { localKey: 'missing' }, { foreignKey: 'missing' },
    { table: { ...tableModel('count_model_children'), kinds: { id: 'integer', parentId: 'boolean', label: 'text' } } }, { predicate: scalar([1], 'missing') }]) {
    assert.throws(() => compileSqlitePredicate(root, countModel(change)), invalid);
  }
  let calls = 0;
  const getter = countModel(); Object.defineProperty(getter, 'threshold', { get() { calls++; return 1; } });
  assert.throws(() => predicateModel(root, getter), coded('QUERY')); assert.equal(calls, 0);
  const numberLike = { valueOf() { calls++; return 1; }, toString() { calls++; return '='; } };
  assert.throws(() => predicateModel(root, countModel({ threshold: numberLike })), coded('QUERY'));
  assert.throws(() => predicateModel(root, countModel({ operator: numberLike })), coded('QUERY')); assert.equal(calls, 0);
  const proxy = new Proxy(countModel(), { get(target, key, receiver) { calls++; return key === 'threshold' ? -1 : Reflect.get(target, key, receiver); } });
  assert.equal(compileSqlitePredicate(root, proxy).parameters.at(-1), 1); assert.equal(calls, 0);
  const normalized = predicateModel(root, countModel({ where: scalar(['Original'], 'label') }));
  assert.ok(Object.isFrozen(normalized)); assert.ok(Object.isFrozen(normalized.where.values));
  for (const where of [normalized, { kind: 'not', child: normalized }, { kind: 'logic', operator: 'OR', children: [normalized] }]) {
    assert.throws(() => queryModel.delete({ table: root, where }), coded('UNSAFE_WRITE'));
    assert.throws(() => queryModel.update({ table: root, assignments: [{ column: 'label', value: 'Changed' }], where }), coded('UNSAFE_WRITE'));
  }
});

test('global parameter budgets include every count threshold and preserve nested binding order', t => {
  const root = tableModel(), values = Array.from({ length: 5000 }, (_, index) => index);
  const accepted = countModel({ where: scalar(values), predicate: scalar(values.slice(0, 4999)) });
  assert.equal(compileSqlitePredicate(root, accepted).parameters.length, 10000);
  assert.throws(() => predicateModel(root, countModel({ where: scalar(values), predicate: scalar(values) })), coded('QUERY'));
  const nested = countModel({ predicate: countModel({ predicate: scalar(Array(9998).fill(1)) }) });
  assert.equal(compileSqlitePredicate(root, nested).parameters.length, 10000);
  assert.throws(() => predicateModel(root, countModel({ predicate: countModel({ predicate: scalar(Array(9999).fill(1)) }) })), coded('QUERY'));
  const order = compileSqlite(queryModel.select({ table: root, columns: ['id'], orderBy: [], limit: 3, offset: 4,
    where: countModel({ where: scalar(['outer domain'], 'label'), threshold: 7, predicate: countModel({ where: scalar(['inner domain'], 'label'), predicate: scalar(['inner test'], 'label'), threshold: 5 }) }) }));
  assert.deepEqual(order.parameters, ['outer domain', 'inner domain', 'inner test', 5, 7, 3, 4]);
  const { parent, child } = models(), db = memory(t, [parent, child]);
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: inArray(child.col('id'), values) });
  assert.equal(db.table(parent).compileSelect({ where: countRelated(relation, '>=', 1, inArray(child.col('id'), values.slice(0, 4999))) }).parameters.length, 10002);
  assert.throws(() => db.table(parent).compileSelect({ where: countRelated(relation, '>=', 1, inArray(child.col('id'), values)) }), coded('QUERY'));
});

test('mixed count and quantifier trees share one four-relation depth and 100-node budget', t => {
  const root = tableModel();
  const four = countModel({ predicate: filterModel(countModel({ predicate: filterModel(scalar([1]), 'every') })) });
  assert.equal((compileSqlitePredicate(root, four).sql.match(/SELECT /g) ?? []).length, 4);
  assert.throws(() => predicateModel(root, countModel({ predicate: four })), coded('QUERY'));
  assert.throws(() => predicateModel(root, filterModel(four)), coded('QUERY'));
  const broad = countModel({ where: { kind: 'logic', operator: 'AND', children: Array.from({ length: 48 }, () => scalar([1])) },
    predicate: { kind: 'logic', operator: 'OR', children: Array.from({ length: 49 }, () => scalar([1])) } });
  predicateModel(root, broad);
  assert.throws(() => predicateModel(root, { ...broad, predicate: { kind: 'logic', operator: 'OR', children: [...broad.predicate.children, scalar([1])] } }), coded('QUERY'));
  const cycle = countModel(); cycle.predicate = cycle;
  assert.throws(() => predicateModel(root, cycle), coded('QUERY'));
  const node = defineTable('count_depth_nodes', { id: column.integer().primaryKey(), parentId: column.integer() });
  const db = memory(t, [node]); db.table(node).insert({ id: 1, parentId: 1 });
  const relation = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId') });
  const where = countRelated(relation, '>=', 1, some(relation, countRelated(relation, '>=', 1, every(relation, eq(node.col('id'), 1)))));
  assert.deepEqual(ids(db.table(node).findMany({ where })), [1]);
  assert.throws(() => db.table(node).count(countRelated(relation, '>=', 0, where)), coded('QUERY'));
  assert.throws(() => db.table(node).count(some(relation, where)), coded('QUERY'));
  const domain = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId'), where });
  assert.throws(() => db.table(node).count(countRelated(domain, '=', 0)), coded('QUERY'));
});

test('count truth reasoning handles zero domains without inventing a maximum row count', () => {
  const root = tableModel(), empty = { kind: 'logic', operator: 'OR', children: [] };
  for (const [operator, compare] of Object.entries(comparison)) for (const threshold of [0, 1, Number.MAX_SAFE_INTEGER]) {
    for (const change of [{ where: empty }, { predicate: empty }]) {
      assert.equal(predicateTruth(predicateModel(root, countModel({ operator, threshold, ...change }))), compare(0, threshold));
    }
  }
  assert.equal(predicateTruth(predicateModel(root, countModel({ operator: '>=', threshold: 0 }))), true);
  assert.equal(predicateTruth(predicateModel(root, countModel({ operator: '<', threshold: 0 }))), false);
  for (const operator of ['=', '<>', '>', '<=']) assert.equal(predicateTruth(predicateModel(root, countModel({ operator, threshold: 0 }))), null);
  for (const operator of ['>', '<=']) assert.equal(predicateTruth(predicateModel(root, countModel({ operator, threshold: Number.MAX_SAFE_INTEGER }))), null);
});
