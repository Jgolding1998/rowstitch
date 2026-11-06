import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tableModel, queryModel } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate, compileSqliteOrder } from '../dist/core/sqlite-compiler.js';
import { aggregateLayout } from '../dist/core/aggregate-layout.js';
import { projectedLayout } from '../dist/core/projected-layout.js';

// These tests exercise the compiler against owned in-memory fixtures. Catalog and public-registry
// integration have separate tests; a successful compiler result alone does not establish SDK support.
const coded = code => error => error?.code === code;
const cmp = (column, value, operator = '=') => ({ kind: 'compare', column, operator, values: [value] });
const q = name => '"' + name.replaceAll('"', '""') + '"';
function model(name, table, columns, options = {}) {
  const names = Object.keys(columns);
  return tableModel({ name, columns: names, primaryKey: options.primaryKey ?? ['id'],
    kinds: Object.fromEntries(names.map(name => [name, options.kinds?.[name] ?? 'integer'])),
    nullable: Object.fromEntries(names.map(name => [name, options.nullable?.includes(name) ?? false])),
    ...(options.version ? { version: options.version } : {}),
    storage: { table, ...(options.schema ? { schema: options.schema } : {}), columns } });
}
function definitions(table, overrides = {}) {
  return table.columns.map(name => ({ name, kind: table.kinds[name], nullable: table.nullable[name],
    primary: table.primaryKey.includes(name), generated: false, unique: false, hasDefault: false,
    ...overrides[name] }));
}
function connection(dqs = false) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: dqs, allowExtension: false, defensive: true });
  db.enableDefensive(true); db.exec('PRAGMA trusted_schema = OFF');
  return db;
}
function run(db, plan) {
  const compiled = compileSqlite(plan);
  assert.doesNotMatch(compiled.sql, /\b(?:SELECT|RETURNING)\s+\*/i);
  const stmt = db.prepare(compiled.sql); stmt.setReadBigInts(true);
  return stmt.all(...compiled.parameters).map(row => Object.fromEntries(Object.entries(row)));
}
const create = (db, table, overrides) => run(db, queryModel.createTable({ table, definitions: definitions(table, overrides) }));
const insert = (db, table, values) => run(db, queryModel.insert({ table, columns: Object.keys(values), values: Object.values(values) }));
const select = (table, extra = {}) => queryModel.select({ table, columns: table.columns,
  orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100, offset: 0, ...extra });

test('mapped CRUD returns only logical fields, binds hostile values, and uses original basename RETURNING', () => {
  const db = connection();
  const table = model('items', 'select"; --.日', { id: 'from', title: 'display"name', score: '__rs_rank',
    family: '__rs_family_0', revision: 'Version', enabled: '__proto__', payload: 'json.日' },
  { kinds: { title: 'text', family: 'text', enabled: 'boolean', payload: 'json' }, version: 'revision' });
  try {
    create(db, table);
    db.exec('CREATE TABLE main."sentinel"("id" INTEGER); ALTER TABLE main.' + q(table.storage.table) + ' ADD COLUMN "customer secret" TEXT DEFAULT \'FICTIONAL_PRIVATE\'');
    const value = "fictional'; DROP TABLE sentinel; --\0tail";
    assert.deepEqual(insert(db, table, { id: 1, title: value, score: 900, family: 'safe', revision: 1, enabled: 1, payload: '{"fictional":true}' }),
      [{ id: 1n, title: value, score: 900n, family: 'safe', revision: 1n, enabled: 1n, payload: '{"fictional":true}' }]);
    assert.deepEqual(run(db, select(table, { columns: ['id', 'title', 'score'] })), [{ id: 1n, title: value, score: 900n }]);
    const update = queryModel.update({ table, assignments: [{ column: 'title', value: 'changed' }], where: cmp('id', 1) });
    const sql = compileSqlite(update).sql;
    assert.match(sql, /SET "display""name" = \?/);
    assert.ok(sql.includes('RETURNING ' + q(table.storage.table) + '."from" AS "id"'));
    assert.ok(!sql.includes('RETURNING "main".'));
    assert.equal(run(db, update)[0].revision, 2n);
    const gone = run(db, queryModel.delete({ table, where: cmp('id', 1) }));
    assert.equal(gone[0].title, 'changed');
    assert.ok(!Object.hasOwn(gone[0], 'customer secret'));
    assert.deepEqual(db.prepare('SELECT name FROM main.sqlite_schema WHERE name = ?').all('sentinel').map(row => row.name), ['sentinel']);
  } finally { db.close(); }
});

test('mapped DDL uses physical PK, boolean/JSON checks, generated values, FK targets and temp index syntax', () => {
  const db = connection();
  const parent = model('parents', 'constructor', { id: '__proto__' }, { schema: 'temp' });
  const child = model('children', 'child.with"quote', { id: 'primary key', parent: 'foreign"key', enabled: 'check', payload: 'json()' },
    { schema: 'temp', kinds: { enabled: 'boolean', payload: 'json' } });
  try {
    create(db, parent);
    create(db, child, { id: { generated: true }, parent: { foreignKey: { target: { schema: 'temp', table: 'constructor', column: '__proto__' }, onDelete: 'cascade' } } });
    insert(db, parent, { id: 7 });
    assert.deepEqual(insert(db, child, { parent: 7, enabled: 1, payload: '{}' }), [{ id: 1n, parent: 7n, enabled: 1n, payload: '{}' }]);
    assert.throws(() => insert(db, child, { parent: 99, enabled: 1, payload: '{}' }), /FOREIGN KEY/);
    assert.throws(() => insert(db, child, { parent: 7, enabled: 2, payload: '{}' }), /CHECK/);
    assert.throws(() => insert(db, child, { parent: 7, enabled: 1, payload: 'invalid' }), /CHECK/);
    const index = queryModel.createIndex({ table: child, name: 'child_parent', columns: ['parent'] });
    assert.equal(compileSqlite(index).sql, 'CREATE INDEX "temp"."child_parent" ON "child.with""quote" ("foreign""key")');
    run(db, index);
    assert.equal(db.prepare('SELECT count(*) AS n FROM temp.sqlite_schema WHERE type = ? AND name = ?').get('index', 'child_parent').n, 1);
    run(db, queryModel.delete({ table: parent, where: cmp('id', 7) }));
    assert.deepEqual(run(db, select(child)), []);
    const bad = definitions(child, { parent: { foreignKey: { target: { table: 'constructor', column: '__proto__' }, onDelete: 'cascade' } } });
    assert.throws(() => compileSqlite(queryModel.createTable({ table: child, definitions: bad })), coded('SCHEMA'));
  } finally { db.close(); }
});

test('each owner in nested filters, counts and column/text predicates uses its own main or temp mapping', () => {
  const db = connection();
  const owner = model('owners', 'same.name', { id: 'Owner ID', lhs: 'left', rhs: 'right', label: 'label"' }, { kinds: { label: 'text' } });
  const related = model('related', 'same.name', { id: 'Child ID', owner: 'Owner Ref', label: 'value', amount: '__rs_bad' },
    { schema: 'temp', kinds: { label: 'text' } });
  const leaf = model('leaves', 'leaf', { id: 'leaf id', related: 'child ref', flag: 'yes?' });
  try {
    for (const table of [owner, related, leaf]) create(db, table);
    insert(db, owner, { id: 1, lhs: 5, rhs: 3, label: 'North' });
    insert(db, owner, { id: 2, lhs: 1, rhs: 3, label: 'south' });
    insert(db, related, { id: 10, owner: 1, label: 'Paid', amount: 2 });
    insert(db, related, { id: 11, owner: 1, label: 'draft', amount: 3 });
    insert(db, leaf, { id: 100, related: 10, flag: 1 });
    const nested = { kind: 'relation-filter', quantifier: 'some', table: leaf, localKey: 'id', foreignKey: 'related', predicate: cmp('flag', 1) };
    const relation = { kind: 'relation-filter', quantifier: 'some', table: related, localKey: 'id', foreignKey: 'owner',
      where: { kind: 'text-match', column: 'label', mode: 'ends-with', case: 'ascii-insensitive', literal: 'AID' }, predicate: nested };
    const where = { kind: 'logic', operator: 'AND', children: [relation,
      { kind: 'column-compare', left: 'lhs', right: 'rhs', operator: '>' },
      { kind: 'text-match', column: 'label', mode: 'starts-with', case: 'ascii-insensitive', literal: 'no' }] };
    assert.deepEqual(run(db, select(owner, { columns: ['id'], where })), [{ id: 1n }]);
    const counted = { kind: 'relation-count', table: related, localKey: 'id', foreignKey: 'owner', operator: '>=', threshold: 2 };
    assert.deepEqual(run(db, queryModel.count({ table: owner, where: counted })), [{ n: 1n }]);
    assert.deepEqual(compileSqlitePredicate(owner, cmp('lhs', 4)).parameters, [4]);
    assert.equal(compileSqliteOrder(owner, [{ column: 'label', direction: 'DESC' }]), ' ORDER BY "label""" DESC');
    assert.throws(() => compileSqlitePredicate(owner, cmp('Owner ID', 1)), coded('SCHEMA'));
  } finally { db.close(); }
});

test('window outputs isolate physical helpers and schema-qualified sources from __rs_keys CTE shadowing', () => {
  const db = connection();
  const table = model('children', '__rs_keys', { id: '__rs_parent', owner: '__rs_key', rank: '__rs_rank', family: '__rs_family_0' },
    { kinds: { owner: 'text', family: 'text' } });
  try {
    create(db, table);
    insert(db, table, { id: 1, owner: 'A', rank: 900, family: 'first' });
    insert(db, table, { id: 2, owner: 'A', rank: 800, family: 'second' });
    insert(db, table, { id: 3, owner: 'B', rank: 700, family: 'third' });
    const window = correlateKeys => queryModel.relation({ table, columns: table.columns, partitionBy: 'owner', keys: ['A', 'B'], correlateKeys,
      where: cmp('rank', 600, '>'), orderBy: [{ column: 'id', direction: 'ASC' }], offset: 0, limit: 1, readLimit: 10 });
    assert.deepEqual(run(db, window(false)), [
      { id: 1n, owner: 'A', rank: 900n, family: 'first', __rs_rank: 1n },
      { id: 3n, owner: 'B', rank: 700n, family: 'third', __rs_rank: 1n },
    ]);
    assert.deepEqual(run(db, window(true)), [
      { id: 1n, owner: 'A', rank: 900n, family: 'first', __rs_parent: 0n, __rs_rank: 1n },
      { id: 3n, owner: 'B', rank: 700n, family: 'third', __rs_parent: 1n, __rs_rank: 1n },
    ]);
    assert.deepEqual(compileSqlite(window(true)).parameters, ['A', 'B', 600, 0, 1, 10]);
    const { kind, ...windowInput } = window(true);
    const page = queryModel.relation({ ...windowInput, offset: 1, limit: 1 });
    assert.deepEqual(run(db, page), [{ id: 2n, owner: 'A', rank: 800n, family: 'second', __rs_parent: 0n, __rs_rank: 2n }]);
  } finally { db.close(); }
});

test('root, grouped, projected and multi-hop related aggregates use mapped ownership and preserve binding order', () => {
  const db = connection();
  const owners = model('owners', '__rs_family_0', { id: 'Owner.ID', category: '__rs_key_0', weight: '__rs_bad' }, { kinds: { category: 'text', weight: 'real' } });
  const children = model('children', '__rs_keys', { id: 'Child.ID', owner: 'Owner.ID', amount: '__rs_sum_hi_0', label: '__rs_agg_0' },
    { schema: 'temp', kinds: { amount: 'bigint', label: 'text' } });
  const leaves = model('leaves', '__rs_filter_0', { id: 'Leaf.ID', child: 'Child.ID', value: '__rs_ragg_bad' });
  try {
    for (const table of [owners, children, leaves]) create(db, table);
    for (const values of [{ id: 1, category: 'north', weight: 1.5 }, { id: 2, category: 'north', weight: 2.5 }, { id: 3, category: 'south', weight: 4 }]) insert(db, owners, values);
    for (const values of [{ id: 10, owner: 1, amount: 2n, label: 'A' }, { id: 11, owner: 1, amount: 3n, label: 'b' }, { id: 12, owner: 2, amount: 5n, label: 'C' }]) insert(db, children, values);
    for (const values of [{ id: 100, child: 10, value: 7 }, { id: 101, child: 11, value: 11 }, { id: 102, child: 12, value: 13 }]) insert(db, leaves, values);
    const path = [{ table: children, localKey: 'id', foreignKey: 'owner', where: cmp('amount', 1n, '>') },
      { table: leaves, localKey: 'id', foreignKey: 'child', where: cmp('value', 8, '>') }];
    const values = [{ alias: 'total', operation: 'sum', column: 'value', path },
      { alias: 'n', operation: 'count', path }, { alias: 'mean', operation: 'avg', column: 'weight' }];
    const aggregate = queryModel.aggregate({ table: owners, select: values, where: cmp('id', 0, '>') });
    const layout = aggregateLayout(aggregate), rows = run(db, aggregate);
    const total = layout.aggregates[0];
    assert.equal(total.kind, 'integer-sum');
    assert.equal(rows[0][total.high.name], 0n); assert.equal(rows[0][total.low.name], 24n);
    assert.equal(rows[0][layout.aggregates[1].output.name], 2n);
    assert.equal(rows[0][layout.aggregates[2].output.name], 8 / 3);
    assert.equal(rows[0][layout.guard.name], 0n);
    const grouped = queryModel.group({ table: owners, select: values.slice(0, 2), by: ['category'], where: cmp('id', 0, '>'),
      orderBy: [{ field: 'category', direction: 'ASC' }], limit: 10, offset: 0, overflow: false });
    const groupLayout = aggregateLayout(grouped), groups = run(db, grouped);
    assert.deepEqual(groups.map(row => row[groupLayout.keys[0].output.name]), ['north', 'south']);
    assert.equal(groups[0][groupLayout.aggregates[0].low.name], 24n);
    assert.equal(groups[1][groupLayout.aggregates[1].output.name], 0n);
    const projected = select(owners, { columns: ['id'], where: cmp('id', 2, '<='), aggregates: [values[0], values[1]] });
    const projectedNames = projectedLayout(projected.aggregates), result = run(db, projected);
    assert.deepEqual(result.map(row => [row.id, row[projectedNames.outputs[0].low], row[projectedNames.outputs[1].name], row[projectedNames.guard]]),
      [[1n, 11n, 1n, 0n], [2n, 13n, 1n, 0n]]);
    // Actual positional binding order: aggregate values, guards, root WHERE, then pagination.
    assert.deepEqual(compileSqlite(projected).parameters, [1n, 8, 1n, 8, 1n, 8, 1n, 8, 1n, 8, 2, 100, 0]);
    assert.ok(run(db, queryModel.explain({ query: projected })).length > 0);
  } finally { db.close(); }
});

test('physical collation stays the left operand in relation filters, windows and aggregate paths', () => {
  const db = connection();
  const owner = model('owners', 'Owners', { id: 'ID', key: 'logical key' }, { kinds: { key: 'text' } });
  const child = model('children', 'Children', { id: 'ID', key: 'foreign key', label: 'label' }, { kinds: { key: 'text', label: 'text' } });
  try {
    create(db, owner);
    db.exec('CREATE TABLE main."Children"("ID" INTEGER PRIMARY KEY,"foreign key" TEXT COLLATE NOCASE NOT NULL,"label" TEXT COLLATE NOCASE NOT NULL)');
    insert(db, owner, { id: 1, key: 'a' }); insert(db, child, { id: 10, key: 'A', label: 'Z' }); insert(db, child, { id: 11, key: 'a', label: 'b' });
    const filter = { kind: 'relation-filter', quantifier: 'some', table: child, localKey: 'key', foreignKey: 'key' };
    assert.deepEqual(run(db, select(owner, { columns: ['id'], where: filter })), [{ id: 1n }]);
    const projected = select(owner, { columns: ['id'], aggregates: [{ alias: 'min', operation: 'min', column: 'label', path: [{ table: child, localKey: 'key', foreignKey: 'key' }] }] });
    assert.equal(run(db, projected)[0].__rs_ragg_0, 'b');
    const window = queryModel.relation({ table: child, columns: child.columns, partitionBy: 'key', keys: ['a'], correlateKeys: true,
      orderBy: [{ column: 'id', direction: 'ASC' }], offset: 0, limit: 10, readLimit: 10 });
    assert.deepEqual(run(db, window).map(row => row.id), [10n, 11n]);
  } finally { db.close(); }
});

test('missing physical names error even under enabled DQS, unsupported schemas fail before SQL, and legacy plans remain usable', () => {
  const db = connection(true);
  try {
    db.exec('CREATE TABLE main."actual"("id" INTEGER PRIMARY KEY,"value" TEXT); INSERT INTO main."actual" VALUES(1,\'fictional\')');
    const wrong = model('items', 'actual', { id: 'id', value: 'misspelled' }, { kinds: { value: 'text' } });
    assert.throws(() => run(db, select(wrong)), /no such column/);
    assert.throws(() => run(db, queryModel.update({ table: wrong, assignments: [{ column: 'value', value: 'changed' }], where: cmp('id', 1) })), /no such column/);
    for (const schema of ['other', 'main.temp', 'main"; --']) {
      const unsupported = model('items', 'actual', { id: 'id' }, { schema });
      assert.throws(() => compileSqlite(select(unsupported)), coded('SCHEMA'));
    }
    const legacy = { name: 'actual', columns: ['id', 'value'], primaryKey: ['id'] };
    assert.deepEqual(run(db, select(legacy)), [{ id: 1n, value: 'fictional' }]);
    assert.deepEqual(run(db, queryModel.insert({ table: legacy, columns: ['id', 'value'], values: [2, 'legacy'] })), [{ id: 2n, value: 'legacy' }]);
  } finally { db.close(); }
});

test('backend identity validation covers unused columns and independently nested mapped targets before SQL', () => {
  const owner = model('owners', 'owners', { id: 'id' });
  const duplicated = () => model('duplicates', 'duplicates', { id: 'Case', value: 'case' });
  assert.throws(() => compileSqlite(queryModel.count({ table: duplicated() })), coded('SCHEMA'));
  assert.throws(() => compileSqlite(select(owner, { where: { kind: 'relation-filter', quantifier: 'some',
    table: duplicated(), localKey: 'id', foreignKey: 'id' } })), coded('SCHEMA'));
  assert.throws(() => compileSqlite(select(owner, { aggregates: [{ alias: 'n', operation: 'count',
    path: [{ table: duplicated(), localKey: 'id', foreignKey: 'id' }] }] })), coded('SCHEMA'));
  assert.throws(() => compileSqlite(queryModel.aggregate({ table: owner, select: [{ alias: 'n', operation: 'count',
    path: [{ table: duplicated(), localKey: 'id', foreignKey: 'id' }] }] })), coded('SCHEMA'));
});
