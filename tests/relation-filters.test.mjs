import test from 'node:test';
import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, some, none, every,
  eq, gt, and, or, not, inArray, desc, endsWith, gtColumns } from '../dist/index.js';

const ids = rows => rows.map(row => row.id);
const code = expected => error => error?.code === expected;
function fixture(run) {
  const parents = defineTable('parents', { id: column.integer().primaryKey(), name: column.text() });
  const children = defineTable('children', {
    id: column.integer().primaryKey(), parentId: column.integer().nullable().references(parents, 'id'),
    flag: column.boolean().nullable(), active: column.boolean().default(true), title: column.text().default('example'),
    a: column.integer().default(2), b: column.integer().default(1),
  });
  const notes = defineTable('notes', { id: column.integer().primaryKey(), childId: column.integer().references(children, 'id'), approved: column.boolean() });
  const db = openDatabase(':memory:', { tables: [parents, children, notes] });
  try {
    db.ensureSchema();
    const relation = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') });
    return run({ db, parents, children, notes, relation, repo: db.table(parents), childRepo: db.table(children) });
  } finally { db.close(); }
}

test('relation quantifiers match an independent truth table over all 121 nullable-boolean sets up to four rows', () => fixture(({ db, children, relation, repo, childRepo }) => {
  const sets = [[]];
  let level = [[]];
  for (let size = 1; size <= 4; size++) {
    level = level.flatMap(values => [true, false, null].map(value => [...values, value]));
    sets.push(...level);
  }
  repo.insertMany(sets.map((_, i) => ({ id: i + 1, name: 'Group ' + (i + 1) })));
  let childId = 0;
  childRepo.insertMany(sets.flatMap((values, i) => values.map(flag => ({ id: ++childId, parentId: i + 1, flag }))));
  const predicate = eq(children.col('flag'), true);
  for (const [helper, oracle] of [
    [some, values => values.some(value => value === true)],
    [none, values => !values.some(value => value === true)],
    [every, values => values.every(value => value === true)],
  ]) {
    const expected = sets.flatMap((values, i) => oracle(values) ? [i + 1] : []);
    db.clearTrace();
    assert.deepEqual(ids(repo.findMany({ where: helper(relation, predicate), select: ['id'] })), expected);
    assert.equal(db.exportTrace().queries.filter(query => query.operation === 'select').length, 1);
    assert.equal(repo.count(helper(relation, predicate)), expected.length);
  }
  assert.deepEqual(ids(repo.findMany({ where: none(relation) })), [1]);
  assert.equal(repo.count(some(relation)), 120);
  assert.equal(repo.count(every(relation, and())), 121);
  assert.equal(repo.count(some(relation, or())), 0);
  assert.equal(repo.count(none(relation, inArray(children.col('id'), []))), 121);
}));

test('descriptor where defines the domain separately from every test, including an empty domain', () => fixture(({ parents, children, relation, repo, childRepo }) => {
  repo.insertMany([1, 2, 3].map(id => ({ id, name: 'Group ' + id })));
  childRepo.insertMany([
    { id: 1, parentId: 1, flag: true }, { id: 2, parentId: 1, flag: false, active: false },
    { id: 3, parentId: 2, flag: null }, { id: 4, parentId: 3, flag: false, active: false },
  ]);
  const active = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: eq(children.col('active'), true) });
  assert.deepEqual(ids(repo.findMany({ where: every(active, eq(children.col('flag'), true)) })), [1, 3]);
  assert.deepEqual(ids(repo.findMany({ where: every(relation, eq(children.col('flag'), true)) })), []);
  assert.deepEqual(ids(repo.findMany({ where: and(some(active), every(active, eq(children.col('flag'), true))) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: none(active) })), [3]);
}));

test('nested relation tests correlate to the same child and bind domain before the test', () => fixture(({ db, parents, children, notes, relation, repo, childRepo }) => {
  repo.insertMany([1, 2].map(id => ({ id, name: 'Group ' + id })));
  childRepo.insertMany([
    { id: 1, parentId: 1, flag: true }, { id: 2, parentId: 1, flag: false }, { id: 3, parentId: 2, flag: true },
  ]);
  db.table(notes).insertMany([{ id: 1, childId: 2, approved: true }, { id: 2, childId: 3, approved: true }]);
  const comments = hasMany(notes, { localKey: children.col('id'), foreignKey: notes.col('childId') });
  const active = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: eq(children.col('flag'), true) });
  const where = some(active, some(comments, eq(notes.col('approved'), true)));
  assert.deepEqual(ids(repo.findMany({ where })), [2]);
  assert.deepEqual(repo.compileSelect({ where }).parameters, [1, 1, 1000, 0]);
  assert.deepEqual(ids(repo.findMany({ where: some(relation, and(eq(children.col('flag'), true), some(comments))) })), [2]);
}));

test('self-relations and sibling filters use independent aliases without leaking scope', () => {
  const nodes = defineTable('nodes', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), approved: column.boolean() });
  const db = openDatabase(':memory:', { tables: [nodes] });
  try {
    db.ensureSchema();
    const repo = db.table(nodes);
    repo.insertMany([
      { id: 1, parentId: null, approved: false }, { id: 2, parentId: 1, approved: false },
      { id: 3, parentId: 1, approved: false }, { id: 4, parentId: 2, approved: true },
      { id: 5, parentId: 3, approved: false },
    ]);
    const children = hasMany(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('parentId') });
    assert.deepEqual(ids(repo.findMany({ where: some(children, some(children, eq(nodes.col('approved'), true))) })), [1]);
    assert.deepEqual(ids(repo.findMany({ where: and(some(children), none(children, eq(nodes.col('approved'), true))) })), [1, 3]);
    const compiled = repo.compileSelect({ where: and(some(children), none(children)) });
    assert.match(compiled.sql, /AS "__rs_filter_0"/);
    assert.match(compiled.sql, /AS "__rs_filter_1"/);
    assert.deepEqual(repo.findMany({ where: and(some(children), none(children)) }), []);
  } finally { db.close(); }
});

test('relation filters work inside batched include windows with selection and pagination', () => fixture(({ db, parents, children, notes, repo, childRepo }) => {
  repo.insertMany([1, 2].map(id => ({ id, name: 'Group ' + id })));
  childRepo.insertMany([1, 2, 3, 4].map(id => ({ id, parentId: id <= 2 ? 1 : 2, flag: true })));
  db.table(notes).insertMany([{ id: 1, childId: 1, approved: true }, { id: 2, childId: 3, approved: true }, { id: 3, childId: 4, approved: true }]);
  const comments = hasMany(notes, { localKey: children.col('id'), foreignKey: notes.col('childId') });
  db.clearTrace();
  const rows = repo.findMany({ select: ['name'], include: { matches: hasMany(children, {
    localKey: parents.col('id'), foreignKey: children.col('parentId'), where: some(comments), orderBy: [desc(children.col('id'))], limit: 1, select: ['id'],
  }) } });
  assert.deepEqual(rows, [{ name: 'Group 1', matches: [{ id: 1 }] }, { name: 'Group 2', matches: [{ id: 4 }] }]);
  assert.equal(db.exportTrace().queries.filter(query => query.operation === 'select').length, 2);
}));

test('singular filters check existence while eager singular reads retain the cardinality check', () => fixture(({ parents, children, repo, childRepo }) => {
  repo.insertMany([1, 2].map(id => ({ id, name: 'Group ' + id })));
  childRepo.insertMany([{ id: 1, parentId: 1, flag: true }, { id: 2, parentId: 1, flag: false }, { id: 3, parentId: null, flag: true }]);
  const child = hasOne(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') });
  assert.deepEqual(ids(repo.findMany({ where: some(child) })), [1]);
  assert.throws(() => repo.findMany({ include: { child } }), code('RELATION_CARDINALITY'));
  const parent = belongsTo(parents, { localKey: children.col('parentId'), foreignKey: parents.col('id') });
  assert.deepEqual(ids(childRepo.findMany({ where: none(parent) })), [3]);
  assert.deepEqual(ids(childRepo.findMany({ where: every(parent, eq(parents.col('id'), 1)) })), [1, 2, 3]);
}));

test('text, column and logical predicates keep bound values, scoped columns and redacted traces', () => fixture(({ db, children, relation, repo, childRepo }) => {
  const payload = "quote' OR 1=1 -- %_";
  repo.insertMany([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }]);
  childRepo.insertMany([{ id: 1, parentId: 1, flag: true, title: payload }, { id: 2, parentId: 2, flag: true, title: 'other' }]);
  const where = some(relation, and(endsWith(children.col('title'), payload), gtColumns(children.col('a'), children.col('b')), not(eq(children.col('flag'), false))));
  const compiled = repo.compileSelect({ where, limit: 2, offset: 0 });
  assert.ok(!compiled.sql.includes(payload));
  assert.deepEqual(compiled.parameters, [payload, payload, payload, 0, 2, 0]);
  db.clearTrace();
  assert.deepEqual(ids(repo.findMany({ where })), [1]);
  assert.ok(!JSON.stringify(db.exportTrace()).includes(payload));
  assert.equal(repo.findFirst({ where })?.id, 1);
  assert.ok(repo.explain({ where }).some(row => /SEARCH.*INDEX/i.test(row.detail)));
}));

test('int64 keys are compared in SQLite without conversion to JavaScript numbers', () => {
  const parents = defineTable('large_parents', { id: column.bigint().primaryKey() });
  const children = defineTable('large_children', { id: column.integer().primaryKey(), parentId: column.bigint().nullable() });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  try {
    db.ensureSchema();
    const keys = [-(2n ** 63n), 9007199254740992n, 9007199254740993n, 2n ** 63n - 1n];
    db.table(parents).insertMany(keys.map(id => ({ id })));
    db.table(children).insertMany([{ id: 1, parentId: keys[0] }, { id: 2, parentId: keys[2] }, { id: 3, parentId: keys[3] }]);
    const rel = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') });
    assert.deepEqual(ids(db.table(parents).findMany({ where: some(rel) })), [keys[0], keys[2], keys[3]]);
    assert.deepEqual(ids(db.table(parents).findMany({ where: none(rel) })), [keys[1]]);
  } finally { db.close(); }
});
