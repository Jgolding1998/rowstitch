import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { column, defineTable, openDatabase, hasMany, belongsTo, some, none, every,
  eq, isNull, and, or, not, inArray, endsWith, gtColumns, RowstitchError } from '../dist/index.js';
import { predicateModel, predicateTruth, queryModel } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate } from '../dist/core/sqlite-compiler.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const modelError = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA'].includes(error.code);
const ids = rows => rows.map(row => row.id);
function memory(t, tables, options = {}) {
  const db = openDatabase(':memory:', { tables, ...options });
  t.after(() => db.close()); db.ensureSchema(); db.clearTrace(); return db;
}
function models() {
  const parent = defineTable('filter_parents', { id: column.integer().primaryKey(), label: column.text(), version: column.integer().default(1) }, { version: 'version' });
  const child = defineTable('filter_children', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), flag: column.boolean().nullable(), label: column.text() });
  return { parent, child, relation: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') }) };
}

test('quantifiers distinguish false, NULL, empty domains and explicit NULL acceptance', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insertMany(Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: 'Parent ' + (i + 1) })));
  db.table(child).insertMany([
    { id: 1, parentId: 2, flag: true, label: 'inside' }, { id: 2, parentId: 3, flag: false, label: 'inside' },
    { id: 3, parentId: 4, flag: null, label: 'inside' }, { id: 4, parentId: 5, flag: true, label: 'inside' },
    { id: 5, parentId: 5, flag: null, label: 'inside' }, { id: 6, parentId: 6, flag: true, label: 'outside' },
    { id: 7, parentId: null, flag: false, label: 'inside' },
  ]);
  const domain = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: eq(child.col('label'), 'inside') });
  const read = where => ids(db.table(parent).findMany({ where }));
  assert.deepEqual(read(some(domain, eq(child.col('flag'), true))), [2, 5]);
  assert.deepEqual(read(none(domain, eq(child.col('flag'), true))), [1, 3, 4, 6]);
  assert.deepEqual(read(every(domain, eq(child.col('flag'), true))), [1, 2, 6]);
  assert.deepEqual(read(not(every(domain, eq(child.col('flag'), true)))), [3, 4, 5]);
  assert.deepEqual(read(every(domain, isNull(child.col('flag')))), [1, 4, 6]);
  assert.deepEqual(read(every(domain, or(isNull(child.col('flag')), eq(child.col('flag'), true)))), [1, 2, 4, 5, 6]);
  assert.deepEqual(read(some(relation)), [2, 3, 4, 5, 6]);
  assert.deepEqual(read(none(relation)), [1]);
  assert.deepEqual(read(every(relation, and())), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(read(every(relation, or())), [1]);
});

test('nested and sibling self-relations correlate to their immediate scope', t => {
  const node = defineTable('filter_nodes', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), active: column.boolean() });
  const db = memory(t, [node]), repo = db.table(node);
  repo.insertMany([{ id: 1, parentId: null, active: true }, { id: 2, parentId: 1, active: true }, { id: 3, parentId: 1, active: false },
    { id: 4, parentId: 2, active: true }, { id: 5, parentId: 3, active: false }, { id: 6, parentId: null, active: false }, { id: 7, parentId: 7, active: true }]);
  const descendants = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId') });
  const ancestor = belongsTo(node, { localKey: node.col('parentId'), foreignKey: node.col('id') });
  assert.deepEqual(ids(repo.findMany({ where: some(descendants, some(descendants, eq(node.col('active'), true))) })), [1, 7]);
  assert.deepEqual(ids(repo.findMany({ where: every(descendants, some(descendants)) })), [1, 4, 5, 6, 7]);
  assert.deepEqual(ids(repo.findMany({ where: and(some(descendants, eq(node.col('active'), true)), some(descendants, eq(node.col('active'), false))) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: some(ancestor, some(ancestor, eq(node.col('id'), 1))) })), [4, 5]);
  assert.deepEqual(ids(repo.findMany({ where: some(descendants, gtColumns(node.col('id'), node.col('parentId'))) })), [1, 2, 3]);
  const compiled = repo.compileSelect({ where: and(some(descendants, some(descendants)), none(ancestor, eq(node.col('active'), false))) });
  assert.equal((compiled.sql.match(/ AS "__rs_filter_\d+"/g) ?? []).length, 3);
  assert.equal(new Set(compiled.sql.match(/ AS "__rs_filter_\d+"/g)).size, 3);
});

test('domain and test values remain bound, snapshots stay stable and traces redact them', t => {
  const { parent, child } = models(), db = memory(t, [parent, child]);
  const phrase = "Fictional ' ? -- %_ value\0tail 🧵";
  db.table(parent).insert({ id: 1, label: 'Parent' });
  db.table(child).insert({ id: 1, parentId: 1, flag: true, label: phrase });
  const options = { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: eq(child.col('label'), phrase) };
  const relation = hasMany(child, options), filter = some(relation, endsWith(child.col('label'), 'tail 🧵'));
  options.where = eq(child.col('label'), 'Changed'); options.localKey = parent.col('version');
  db.clearTrace();
  const compiled = db.table(parent).compileSelect({ where: filter, limit: 1 });
  assert.deepEqual(compiled.parameters, [phrase, 'tail 🧵', 'tail 🧵', 'tail 🧵', 1, 0]);
  assert.ok(!compiled.sql.includes('Fictional')); assert.ok(!compiled.sql.includes('\0'));
  assert.deepEqual(ids(db.table(parent).findMany({ where: filter, limit: 1 })), [1]);
  const trace = db.exportTrace().queries;
  assert.equal(trace.length, 1); assert.equal(trace[0].operation, 'select');
  assert.deepEqual(trace[0].parameters, Array(6).fill('[redacted]'));
  assert.ok(!JSON.stringify(trace).includes('Fictional'));
});

test('all read entry points reject unregistered or same-name replacement relation targets before SQL', t => {
  const { parent, child } = models(), db = memory(t, [parent]);
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') });
  for (const where of [some(relation), every(relation, and()), and(or(), none(relation))]) {
    for (const read of [() => db.table(parent).findMany({ where, limit: 0 }), () => db.table(parent).findFirst({ where }),
      () => db.table(parent).compileSelect({ where }), () => db.table(parent).explain({ where }), () => db.table(parent).count(where)]) {
      assert.throws(read, coded('SCHEMA')); assert.equal(db.exportTrace().queries.length, 0);
    }
  }
  const all = memory(t, [parent, child]);
  const impostor = defineTable(child.name, { ...child.columns });
  assert.throws(() => all.table(parent).count(some(hasMany(impostor, { localKey: parent.col('id'), foreignKey: impostor.col('parentId') }))), coded('SCHEMA'));
  assert.equal(all.exportTrace().queries.length, 0);
  const leaf = defineTable('filter_unregistered_leaves', { id: column.integer().primaryKey(), childId: column.integer() });
  const nested = some(hasMany(leaf, { localKey: child.col('id'), foreignKey: leaf.col('childId') }));
  const include = { children: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: nested }) };
  assert.throws(() => all.table(parent).findMany({ include }), coded('SCHEMA'));
  assert.equal(all.exportTrace().queries.length, 0, 'empty roots cannot bypass nested registration checks');
});

test('relation filters reject wrong scopes and eager-only options instead of changing their meaning', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  for (const extra of [{ limit: 0 }, { limit: 1 }, { offset: 0 }, { orderBy: [] }, { include: {} }, { select: ['id'] }]) {
    assert.throws(() => some(hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), ...extra })), coded('QUERY'));
  }
  for (const make of [some, none, every]) {
    assert.throws(() => db.table(parent).findMany({ where: make(relation, eq(parent.col('id'), 1)) }), coded('QUERY'));
  }
  assert.throws(() => every(relation), coded('QUERY'));
  assert.throws(() => some({ ...relation }), coded('QUERY'));
  assert.throws(() => db.table(child).count(some(relation)), coded('QUERY'));
  assert.equal(db.table(parent).count(some(hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), limit: undefined, orderBy: undefined }))), 0);
});

test('forged relation prototype and table getter cannot change a checked target before lowering', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  const unregistered = defineTable('filter_unregistered_target', { ...child.columns });
  let calls = 0;
  const forged = Object.create(Object.getPrototypeOf(relation));
  Object.defineProperties(forged, {
    options: { value: relation.options },
    table: { get() { calls++; return calls === 8 ? unregistered : child; } },
  });
  assert.throws(() => db.table(parent).count(some(forged)), coded('QUERY'));
  assert.equal(calls, 0, 'a forged descriptor must be rejected before reading its table getter');
  assert.equal(db.exportTrace().queries.length, 0);
  assert.throws(() => some(new Proxy(relation, {})), coded('QUERY'));
});

test('genuine direct descriptors are revalidated and captured without proxy option gets', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  const Constructor = relation.constructor;
  const options = { localKey: parent.col('id'), foreignKey: child.col('parentId') };
  const direct = new Constructor(child, options);
  assert.equal(db.table(parent).count(some(direct)), 0);
  const filter = some(direct);
  options.foreignKey = parent.col('id');
  assert.throws(() => db.table(parent).count(filter), coded('QUERY'));
  let calls = 0;
  const proxy = new Proxy({ localKey: parent.col('id'), foreignKey: child.col('parentId') }, {
    get(target, key, receiver) { calls++; return key === 'foreignKey' ? parent.col('id') : Reflect.get(target, key, receiver); },
  });
  assert.equal(db.table(parent).count(some(new Constructor(child, proxy))), 0);
  assert.equal(calls, 0);
  const getter = { localKey: parent.col('id'), foreignKey: child.col('parentId') };
  Object.defineProperty(getter, 'where', { get() { calls++; return or(); }, enumerable: true });
  assert.throws(() => some(new Constructor(child, getter)), error => error instanceof RowstitchError && ['QUERY', 'VALIDATION'].includes(error.code));
  assert.equal(calls, 0);
});

test('nested filters work inside text-correlated eager windows with separate aliases and budgets', t => {
  const parent = defineTable('filter_window_parents', { id: column.text().primaryKey() });
  const child = defineTable('filter_window_children', { id: column.integer().primaryKey(), parentId: column.text(), label: column.text() });
  const leaf = defineTable('filter_window_leaves', { id: column.integer().primaryKey(), childId: column.integer(), label: column.text() });
  const db = memory(t, [parent, child, leaf]);
  db.table(parent).insertMany([{ id: 'a' }, { id: 'b' }]);
  db.table(child).insertMany([{ id: 1, parentId: 'a', label: 'Skip' }, { id: 2, parentId: 'a', label: 'First' },
    { id: 3, parentId: 'a', label: 'Second' }, { id: 4, parentId: 'b', label: 'Third' }]);
  db.table(leaf).insertMany([{ id: 1, childId: 2, label: 'Selected' }, { id: 2, childId: 3, label: 'Selected' }, { id: 3, childId: 4, label: 'Selected' }]);
  const where = some(hasMany(leaf, { localKey: child.col('id'), foreignKey: leaf.col('childId') }), eq(leaf.col('label'), 'Selected'));
  db.clearTrace();
  const actual = db.table(parent).findMany({ include: { page: hasMany(child, {
    localKey: parent.col('id'), foreignKey: child.col('parentId'), where, select: ['label'], limit: 1, offset: 1,
  }) } });
  assert.deepEqual(actual, [{ id: 'a', page: [{ label: 'Second' }] }, { id: 'b', page: [] }]);
  const queries = db.exportTrace().queries;
  assert.equal(queries.length, 2); assert.ok(queries[1].sql.startsWith('WITH '));
  assert.ok(queries[1].sql.includes('"__rs_filter_0"."childId" = "filter_window_children"."id"'));
});

test('unsupported relationship key domains reject for filters and empty eager reads', t => {
  const parent = defineTable('filter_key_parents', { id: column.integer().primaryKey(), textKey: column.text(), realKey: column.real() });
  const child = defineTable('filter_key_children', { id: column.integer().primaryKey(), flag: column.boolean(), data: column.json(), realKey: column.real(), textKey: column.text() });
  const db = memory(t, [parent, child]);
  for (const [left, right] of [['id', 'flag'], ['textKey', 'data'], ['id', 'realKey'], ['realKey', 'realKey'], ['id', 'textKey']]) {
    const relation = hasMany(child, { localKey: parent.col(left), foreignKey: child.col(right) });
    assert.throws(() => some(relation), coded('QUERY'));
    assert.throws(() => db.table(parent).findMany({ include: { children: relation } }), coded('QUERY'));
    assert.equal(db.exportTrace().queries.length, 0);
  }
});

test('integer and bigint correlations preserve int64 boundaries without conversion through Number', t => {
  const parent = defineTable('filter_big_parents', { id: column.bigint().primaryKey() });
  const child = defineTable('filter_big_children', { id: column.integer().primaryKey(), parentId: column.bigint().nullable() });
  const small = defineTable('filter_small_parents', { id: column.integer().primaryKey() });
  const db = memory(t, [parent, child, small]);
  const keys = [-(2n ** 63n), -1n, 1n, 9007199254740992n, 9007199254740993n, 2n ** 63n - 1n];
  db.table(parent).insertMany(keys.map(id => ({ id })));
  db.table(child).insertMany([{ id: 1, parentId: keys[0] }, { id: 2, parentId: 1n }, { id: 3, parentId: 9007199254740993n }, { id: 4, parentId: keys.at(-1) }, { id: 5, parentId: null }]);
  db.table(small).insertMany([{ id: -1 }, { id: 1 }]);
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') });
  assert.deepEqual(ids(db.table(parent).findMany({ where: some(relation) })), [keys[0], 1n, 9007199254740993n, keys.at(-1)]);
  assert.deepEqual(ids(db.table(parent).findMany({ where: none(relation) })), [-1n, 9007199254740992n]);
  const mixed = hasMany(child, { localKey: small.col('id'), foreignKey: child.col('parentId') });
  assert.deepEqual(ids(db.table(small).findMany({ where: some(mixed) })), [1]);
});

test('foreign-column collation governs relation filters in UTF-8 and UTF-16 databases', t => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) for (const [parentCollation, childCollation, key, foreignKey, matches] of [
    ['BINARY', 'NOCASE', 'Alpha', 'alpha', true], ['NOCASE', 'BINARY', 'Alpha', 'alpha', false],
    ['BINARY', 'RTRIM', 'key', 'key ', true], ['RTRIM', 'BINARY', 'key', 'key ', false],
    ['BINARY', 'NOCASE', 'A\0X', 'a\0Y', true], ['BINARY', 'BINARY', '01', '1', false],
  ]) {
    const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-filter-collation-'));
    assert.ok(resolve(directory).startsWith(root + sep));
    const filename = join(directory, 'fictional.sqlite');
    const raw = new DatabaseSync(filename, { allowExtension: false, defensive: true }); let db;
    t.after(() => { try { db?.close(); } finally { raw.close(); unlinkSync(filename); rmdirSync(directory); } });
    raw.exec("PRAGMA encoding='" + encoding + "'; CREATE TABLE collation_roots(id INTEGER PRIMARY KEY, code TEXT COLLATE " + parentCollation + ');'
      + 'CREATE TABLE collation_children(id INTEGER PRIMARY KEY, parentCode TEXT COLLATE ' + childCollation + ', flag INTEGER);');
    raw.prepare('INSERT INTO collation_roots VALUES(?,?)').run(1, key);
    raw.prepare('INSERT INTO collation_children VALUES(?,?,?)').run(1, foreignKey, 1);
    raw.prepare('INSERT INTO collation_roots VALUES(?,?)').run(2, null);
    raw.prepare('INSERT INTO collation_children VALUES(?,?,?)').run(2, null, 1);
    const parent = defineTable('collation_roots', { id: column.integer().primaryKey(), code: column.text().nullable() });
    const child = defineTable('collation_children', { id: column.integer().primaryKey(), parentCode: column.text().nullable(), flag: column.boolean().nullable() });
    db = openDatabase(filename, { tables: [parent, child], readOnly: true });
    const relation = hasMany(child, { localKey: parent.col('code'), foreignKey: child.col('parentCode') });
    assert.equal(raw.prepare('SELECT EXISTS(SELECT 1 FROM collation_children WHERE parentCode = ?) AS found').get(key).found, Number(matches));
    assert.deepEqual(ids(db.table(parent).findMany({ where: some(relation) })), matches ? [1] : []);
    assert.deepEqual(ids(db.table(parent).findMany({ where: none(relation) })), matches ? [2] : [1, 2]);
    assert.deepEqual(ids(db.table(parent).findMany({ where: every(relation, eq(child.col('flag'), false)) })), matches ? [2] : [1, 2]);
  }
});

test('read-only filter contract rejects guarded mutations under every logical wrapper', t => {
  const { parent, child, relation } = models(), db = memory(t, [parent, child]);
  db.table(parent).insertMany([{ id: 1, label: 'Original one' }, { id: 2, label: 'Original two' }]);
  db.table(child).insert({ id: 1, parentId: 1, flag: true, label: 'Child' });
  const before = db.table(parent).findMany(); db.clearTrace();
  for (const filter of [some(relation), none(relation), every(relation, and()), and(eq(parent.col('id'), 1), some(relation)),
    or(eq(parent.col('id'), 1), none(relation)), not(some(relation)), and(or(), some(relation)), or(and(), some(relation))]) {
    assert.throws(() => db.table(parent).update({ label: 'Changed' }, { where: filter }), coded('UNSAFE_WRITE'));
    assert.throws(() => db.table(parent).delete({ where: filter }), coded('UNSAFE_WRITE'));
    assert.equal(db.exportTrace().queries.length, 0, 'rejected writes must not begin a transaction or query');
  }
  assert.deepEqual(db.table(parent).findMany(), before);
});

const tableModel = (name = 'model_roots') => ({ name, columns: ['id', 'parentId', 'label'], primaryKey: ['id'], kinds: { id: 'integer', parentId: 'integer', label: 'text' } });
const compare = (column, values, operator = 'IN') => ({ kind: 'compare', column, operator, values });
const relationModel = extra => ({ kind: 'relation-filter', quantifier: 'some', table: tableModel('model_children'), localKey: 'id', foreignKey: 'parentId', ...extra });

test('pure relation models validate scopes, metadata, quantifiers and forbidden alias/SQL fields', () => {
  const root = tableModel();
  for (const change of [{ quantifier: 'any' }, { quantifier: 'every' }, { quantifier: {} }, { localKey: 'missing' }, { foreignKey: 'missing' },
    { alias: 'model_roots' }, { sql: '1=1' }, { table: { ...tableModel('model_children'), name: 'children;DROP TABLE roots' } },
    { table: { ...tableModel('model_children'), kinds: { id: 'integer', parentId: 'boolean', label: 'text' } } },
    { predicate: compare('missing', [1]) }, { where: { kind: 'raw', sql: '1=1' } }]) {
    assert.throws(() => compileSqlitePredicate(root, relationModel(change)), modelError);
  }
  assert.throws(() => compileSqlitePredicate({ ...root, kinds: undefined }, relationModel()), modelError);
  const child = tableModel('model_children'); delete child.kinds;
  assert.throws(() => compileSqlitePredicate(root, relationModel({ table: child })), modelError);
  let calls = 0;
  const getter = relationModel(); Object.defineProperty(getter, 'quantifier', { get() { calls++; return 'some'; } });
  assert.throws(() => predicateModel(root, getter), coded('QUERY')); assert.equal(calls, 0);
  const proxy = new Proxy(relationModel(), { get(target, key, receiver) { calls++; return key === 'quantifier' ? 'none' : Reflect.get(target, key, receiver); } });
  assert.ok(compileSqlitePredicate(root, proxy).sql.startsWith('EXISTS')); assert.equal(calls, 0);
  const normalized = predicateModel(root, relationModel({ predicate: compare('label', ['Original']) }));
  assert.ok(Object.isFrozen(normalized.table.kinds)); assert.ok(Object.isFrozen(normalized.predicate.values));
  for (const where of [normalized, { kind: 'not', child: normalized }, { kind: 'logic', operator: 'AND', children: [{ kind: 'logic', operator: 'OR', children: [] }, normalized] }]) {
    assert.throws(() => queryModel.delete({ table: root, where }), coded('UNSAFE_WRITE'));
    assert.throws(() => queryModel.update({ table: root, assignments: [{ column: 'label', value: 'Changed' }], where }), coded('UNSAFE_WRITE'));
  }
});

test('nested model budgets count domains and tests together without recursion resets', () => {
  const root = tableModel();
  let four = compare('id', [1]);
  for (let index = 0; index < 4; index++) four = relationModel({ predicate: four });
  assert.equal((compileSqlitePredicate(root, four).sql.match(/EXISTS/g) ?? []).length, 4);
  assert.throws(() => predicateModel(root, relationModel({ predicate: four })), coded('QUERY'));
  let deep = compare('id', [1]);
  for (let index = 0; index < 17; index++) deep = relationModel({ predicate: deep });
  assert.throws(() => predicateModel(root, deep), coded('QUERY'));
  const broad = relationModel({ where: { kind: 'logic', operator: 'AND', children: Array.from({ length: 49 }, () => compare('id', [1])) },
    predicate: { kind: 'logic', operator: 'OR', children: Array.from({ length: 49 }, () => compare('id', [2])) } });
  assert.throws(() => predicateModel(root, broad), coded('QUERY'));
  const values = Array.from({ length: 5001 }, (_, i) => i);
  assert.throws(() => predicateModel(root, relationModel({ where: compare('id', values), predicate: compare('id', values) })), coded('QUERY'));
  const atBoundary = predicateModel(root, relationModel({ where: compare('id', values.slice(0, 5000)), predicate: compare('id', values.slice(0, 5000)) }));
  assert.equal(compileSqlitePredicate(root, atBoundary).parameters.length, 10000);
  const cycle = relationModel(); cycle.predicate = cycle;
  assert.throws(() => predicateModel(root, cycle), coded('QUERY'));
});

test('public helper budgets and compiler truth agree across relation boundaries', t => {
  const { parent, child } = models(), db = memory(t, [parent, child]);
  const values = Array.from({ length: 5001 }, (_, i) => i);
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: inArray(child.col('id'), values) });
  assert.throws(() => db.table(parent).compileSelect({ where: some(relation, inArray(child.col('id'), values)) }), coded('QUERY'));
  const root = tableModel(), falseNode = { kind: 'logic', operator: 'OR', children: [] }, trueNode = { kind: 'logic', operator: 'AND', children: [] };
  for (const [change, expected] of [[{ predicate: falseNode }, false], [{ quantifier: 'none', predicate: falseNode }, true],
    [{ quantifier: 'every', predicate: trueNode }, true], [{ quantifier: 'every', where: falseNode, predicate: falseNode }, true],
    [{ quantifier: 'every', predicate: falseNode }, null]]) {
    assert.equal(predicateTruth(predicateModel(root, relationModel(change))), expected);
  }
  const compiled = compileSqlite(queryModel.select({ table: root, columns: ['id'], where: relationModel({ where: compare('label', ['domain']), predicate: relationModel({ predicate: compare('label', ['test']) }) }), orderBy: [], limit: 3, offset: 1 }));
  assert.deepEqual(compiled.parameters, ['domain', 'test', 3, 1]);
  assert.equal((compiled.sql.match(/\?/g) ?? []).length, compiled.parameters.length);
});

test('public filters accept four relation levels and reject a fifth across domain and test trees', t => {
  const node = defineTable('filter_depth_nodes', { id: column.integer().primaryKey(), parentId: column.integer() });
  const db = memory(t, [node]), relation = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId') });
  db.table(node).insert({ id: 1, parentId: 1 });
  let filter = eq(node.col('id'), 1);
  for (let index = 0; index < 4; index++) filter = some(relation, filter);
  assert.deepEqual(ids(db.table(node).findMany({ where: filter })), [1]);
  assert.throws(() => db.table(node).count(some(relation, filter)), coded('QUERY'));
  const domain = hasMany(node, { localKey: node.col('id'), foreignKey: node.col('parentId'), where: filter });
  assert.throws(() => db.table(node).count(some(domain)), coded('QUERY'));
});
