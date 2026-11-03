import test from 'node:test';
import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, hasMany, countRelated, some, every, eq, isNull, and, not, desc } from '../dist/index.js';

const operators = {
  '=': (a, b) => a === b, '<>': (a, b) => a !== b, '>': (a, b) => a > b,
  '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
};
const ids = rows => rows.map(row => row.id);
function fixture(run) {
  const parent = defineTable('count_parents', { id: column.integer().primaryKey(), title: column.text() });
  const child = defineTable('count_children', {
    id: column.integer().primaryKey(), parentId: column.integer().nullable().references(parent, 'id'),
    done: column.boolean().nullable(), archived: column.boolean().default(false),
  });
  const leaf = defineTable('count_leaves', { id: column.integer().primaryKey(), childId: column.integer().references(child, 'id'), approved: column.boolean() });
  const db = openDatabase(':memory:', { tables: [parent, child, leaf] });
  try {
    db.ensureSchema();
    return run({ db, parent, child, leaf, relation: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') }), repo: db.table(parent) });
  } finally { db.close(); }
}

test('all count operators match independent array counts over 121 sets with nullable values', () => fixture(({ db, child, relation, repo }) => {
  let level = [[]];
  const sets = [...level];
  for (let size = 1; size <= 4; size++) {
    level = level.flatMap(values => [true, false, null].map(value => [...values, value])); sets.push(...level);
  }
  repo.insertMany(sets.map((_, index) => ({ id: index + 1, title: 'Project ' + index })));
  let id = 0;
  db.table(child).insertMany(sets.flatMap((values, index) => values.map(done => ({ id: ++id, parentId: index + 1, done }))));
  db.table(child).insert({ id: ++id, parentId: null, done: true });
  for (const [operator, compare] of Object.entries(operators)) {
    for (const threshold of [0, 1, 2, 4, Number.MAX_SAFE_INTEGER]) {
      for (const [predicate, relevant] of [[undefined, () => true], [eq(child.col('done'), true), value => value === true], [isNull(child.col('done')), value => value === null]]) {
        const expected = sets.flatMap((values, index) => compare(values.filter(relevant).length, threshold) ? [index + 1] : []);
        assert.deepEqual(ids(repo.findMany({ select: ['id'], where: countRelated(relation, operator, threshold, predicate) })), expected);
      }
    }
  }
}));

test('count domain and test compose separately, and unfiltered NULL rows still count', () => fixture(({ db, parent, child, relation, repo }) => {
  repo.insertMany([1, 2, 3].map(id => ({ id, title: 'Project ' + id })));
  db.table(child).insertMany([
    { id: 1, parentId: 1, done: true }, { id: 2, parentId: 1, done: true, archived: true },
    { id: 3, parentId: 1, done: null }, { id: 4, parentId: 2, done: true },
  ]);
  const active = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId'), where: eq(child.col('archived'), false) });
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 3) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: countRelated(active, '=', 2) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: countRelated(active, '=', 1, eq(child.col('done'), true)) })), [1, 2]);
  assert.deepEqual(repo.compileSelect({ where: countRelated(active, '>=', 2, eq(child.col('done'), true)), limit: 7, offset: 1 }).parameters, [0, 1, 2, 7, 1]);
}));

test('nested child counts do not multiply matching parents when a child has several descendants', () => fixture(({ db, child, leaf, relation, repo }) => {
  repo.insertMany([1, 2].map(id => ({ id, title: 'Project ' + id })));
  db.table(child).insertMany([{ id: 1, parentId: 1, done: true }, { id: 2, parentId: 1, done: true }, { id: 3, parentId: 2, done: true }]);
  db.table(leaf).insertMany([
    { id: 1, childId: 1, approved: true }, { id: 2, childId: 1, approved: true },
    { id: 3, childId: 2, approved: false }, { id: 4, childId: 3, approved: true },
  ]);
  const notes = hasMany(leaf, { localKey: child.col('id'), foreignKey: leaf.col('childId') });
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 1, some(notes, eq(leaf.col('approved'), true))) })), [1, 2]);
  assert.deepEqual(ids(repo.findMany({ where: some(relation, countRelated(notes, '>=', 2, eq(leaf.col('approved'), true))) })), [1]);
  assert.deepEqual(ids(repo.findMany({ where: countRelated(relation, '=', 1, countRelated(notes, '>=', 1, eq(leaf.col('approved'), true))) })), [1, 2]);
}));

test('self-related counts and independent sibling comparisons remain correlated', () => {
  const people = defineTable('count_people', { id: column.integer().primaryKey(), managerId: column.integer().nullable() });
  const db = openDatabase(':memory:', { tables: [people] });
  try {
    db.ensureSchema();
    const repo = db.table(people);
    repo.insertMany([{ id: 1, managerId: null }, { id: 2, managerId: 1 }, { id: 3, managerId: 1 }, { id: 4, managerId: 2 }, { id: 5, managerId: 2 }]);
    const reports = hasMany(people, { localKey: people.col('id'), foreignKey: people.col('managerId') });
    assert.deepEqual(ids(repo.findMany({ where: countRelated(reports, '=', 1, countRelated(reports, '=', 2)) })), [1]);
    assert.deepEqual(ids(repo.findMany({ where: and(countRelated(reports, '>=', 1), countRelated(reports, '<=', 2)) })), [1, 2]);
    assert.deepEqual(ids(repo.findMany({ where: not(countRelated(reports, '=', 0)) })), [1, 2]);
  } finally { db.close(); }
});

test('count filters work with root count, first, projections, pagination, includes and plans', () => fixture(({ db, parent, child, leaf, relation, repo }) => {
  repo.insertMany([1, 2, 3].map(id => ({ id, title: 'Project ' + id })));
  db.table(child).insertMany([{ id: 1, parentId: 1, done: true }, { id: 2, parentId: 1, done: true }, { id: 3, parentId: 2, done: true }]);
  db.table(leaf).insertMany([{ id: 1, childId: 1, approved: true }, { id: 2, childId: 3, approved: true }]);
  const where = countRelated(relation, '>=', 1);
  assert.equal(repo.count(where), 2);
  assert.deepEqual(repo.findFirst({ select: ['title'], where, orderBy: [desc(parent.col('id'))] }), { title: 'Project 2' });
  assert.deepEqual(repo.findMany({ select: ['title'], where, limit: 1, offset: 1 }), [{ title: 'Project 2' }]);
  assert.ok(repo.explain({ where }).some(row => /SEARCH.*INDEX/i.test(row.detail)));
  db.clearTrace();
  assert.deepEqual(ids(repo.findMany({ where })), [1, 2]);
  assert.equal(db.exportTrace().queries.filter(query => query.operation === 'select').length, 1);
  const notes = hasMany(leaf, { localKey: child.col('id'), foreignKey: leaf.col('childId') });
  assert.deepEqual(repo.findMany({ select: ['id'], include: { matching: hasMany(child, {
    localKey: parent.col('id'), foreignKey: child.col('parentId'), select: ['id'], where: countRelated(notes, '>', 0), limit: 1,
  }) } }), [{ id: 1, matching: [{ id: 1 }] }, { id: 2, matching: [{ id: 3 }] }, { id: 3, matching: [] }]);
  assert.deepEqual(ids(repo.findMany({ where: and(countRelated(relation, '>', 0), every(relation, eq(child.col('done'), true))) })), [1, 2]);
}));
