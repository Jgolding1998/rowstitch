import test from 'node:test';
import assert from 'node:assert/strict';
import * as rowstitch from '../dist/index.js';
const { column, defineTable, openDatabase, eq, desc, hasMany, hasOne, belongsTo } = rowstitch;
const code = expected => error => error?.code === expected;

function model(run) {
  const authors = defineTable('authors', {
    id: column.integer().primaryKey({ generated: true }), name: column.text(), secret: column.text(),
  });
  const profiles = defineTable('profiles', {
    id: column.integer().primaryKey({ generated: true }), authorId: column.integer().references(authors, 'id'), bio: column.text(),
  });
  const posts = defineTable('posts', {
    id: column.integer().primaryKey({ generated: true }), authorId: column.integer().nullable().references(authors, 'id'), title: column.text(),
  });
  const db = openDatabase(':memory:', { tables: [authors, profiles, posts] });
  try { db.ensureSchema(); return run(db, authors, profiles, posts); } finally { db.close(); }
}

test('select returns only requested fields, while filters and ordering may use other fields', () => model((db, a) => {
  db.table(a).insertMany([{ name: 'Avery', secret: 'PRIVATE_VALUE_A' }, { name: 'Morgan', secret: 'PRIVATE_VALUE_B' }]);
  const compiled = db.table(a).compileSelect({ select: ['name'], where: eq(a.col('id'), 1), orderBy: [desc(a.col('id'))] });
  assert.match(compiled.sql, /^SELECT "name" FROM/);
  assert.ok(!compiled.sql.includes('"secret"'));
  db.clearTrace();
  assert.deepEqual(db.table(a).findMany({ select: ['name'], where: eq(a.col('id'), 1) }), [{ name: 'Avery' }]);
  assert.deepEqual(db.table(a).findFirst({ select: ['name'] }), { name: 'Avery' });
  assert.ok(!JSON.stringify(db.exportTrace()).includes('PRIVATE_VALUE'));
}));

test('empty, duplicate or unknown selections and unknown options reject before SELECT', () => model((db, a) => {
  db.clearTrace();
  for (const options of [{ select: [] }, { select: ['missing'] }, { select: ['name', 'name'] }, { select: 'name' }, { selct: ['name'] }]) {
    assert.throws(() => db.table(a).findMany(options), code('QUERY'));
  }
  assert.equal(db.exportTrace().queries.length, 0);
}));

test('hasOne and belongsTo produce object or null without multiplying root rows', () => model((db, a, p, posts) => {
  db.table(a).insertMany([{ name: 'Avery', secret: 'A' }, { name: 'Morgan', secret: 'B' }]);
  db.table(p).insert({ authorId: 1, bio: 'A short bio' });
  db.table(posts).insertMany([{ authorId: 1, title: 'First' }, { title: 'Unassigned' }]);
  db.clearTrace();
  const authors = db.table(a).findMany({ include: { profile: hasOne(p, { localKey: a.col('id'), foreignKey: p.col('authorId') }) } });
  assert.equal(authors.length, 2);
  assert.equal(authors[0].profile.bio, 'A short bio');
  assert.equal(authors[1].profile, null);
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 2);
  const rows = db.table(posts).findMany({ include: { author: belongsTo(a, { localKey: posts.col('authorId'), foreignKey: a.col('id') }) } });
  assert.equal(rows[0].author.name, 'Avery');
  assert.equal(rows[1].author, null);
}));

test('singular cardinality violations reject instead of silently choosing the first row', () => model((db, a, p, posts) => {
  db.table(a).insert({ name: 'Avery', secret: 'A' });
  db.table(p).insertMany([{ authorId: 1, bio: 'First' }, { authorId: 1, bio: 'Second' }]);
  db.clearTrace();
  assert.throws(() => db.table(a).findMany({ include: { profile: hasOne(p, {
    localKey: a.col('id'), foreignKey: p.col('authorId'), orderBy: [desc(p.col('id'))],
    include: { posts: hasMany(posts, { localKey: p.col('authorId'), foreignKey: posts.col('authorId') }) },
  }) } }), code('RELATION_CARDINALITY'));
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 2, 'Ambiguity is rejected before querying descendants.');
  const rows = db.table(a).findMany({ include: { profile: hasOne(p, {
    localKey: a.col('id'), foreignKey: p.col('authorId'), where: eq(p.col('bio'), 'Second'),
  }) } });
  assert.equal(rows[0].profile.bio, 'Second');
}));

test('belongsTo also rejects duplicate nonunique target matches', () => model((db, a, p, posts) => {
  db.table(a).insertMany([{ name: 'Same', secret: 'A' }, { name: 'Same', secret: 'B' }]);
  db.table(posts).insert({ title: 'Same' });
  assert.throws(() => db.table(posts).findMany({ include: { author: belongsTo(a, {
    localKey: posts.col('title'), foreignKey: a.col('name'), select: ['name'],
  }) } }), code('RELATION_CARDINALITY'));
}));

test('projections keep hidden join fields internally and strip them after nested includes', () => model((db, a, p, posts) => {
  db.table(a).insert({ name: 'Avery', secret: 'Not selected' });
  db.table(p).insert({ authorId: 1, bio: 'Bio' });
  db.table(posts).insert({ authorId: 1, title: 'Post' });
  const rows = db.table(a).findMany({ select: ['name'], include: {
    profile: hasOne(p, { localKey: a.col('id'), foreignKey: p.col('authorId'), select: ['bio'] }),
    posts: hasMany(posts, {
      localKey: a.col('id'), foreignKey: posts.col('authorId'), select: ['title'],
      include: { author: belongsTo(a, { localKey: posts.col('authorId'), foreignKey: a.col('id'), select: ['name'] }) },
    }),
  } });
  assert.deepEqual(rows, [{ name: 'Avery', profile: { bio: 'Bio' }, posts: [{ title: 'Post', author: { name: 'Avery' } }] }]);
  const compiled = db.table(a).compileSelect({ select: ['name'], include: {
    profile: hasOne(p, { localKey: a.col('id'), foreignKey: p.col('authorId'), select: ['bio'] }),
  } });
  assert.ok(compiled.sql.includes('"id"'), 'The relation key is fetched internally.');
  assert.ok(!compiled.sql.includes('"secret"'));
}));

test('singular options cannot disguise duplicate matches with limit/offset or misspelled fields', () => model((db, a, p) => {
  db.clearTrace();
  for (const extra of [{ limit: 1 }, { offset: 1 }, { selct: ['bio'] }, { select: [] }, { select: ['missing'] }]) {
    assert.throws(() => hasOne(p, { localKey: a.col('id'), foreignKey: p.col('authorId'), ...extra }), code('QUERY'));
  }
  assert.throws(() => hasMany(p, { localKey: a.col('id'), foreignKey: p.col('authorId'), limt: 1 }), code('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
}));

test('projection/include collisions and foreign source keys are rejected before fetching', () => model((db, a, p) => {
  db.clearTrace();
  assert.throws(() => db.table(a).findMany({ select: ['name'], include: {
    name: hasOne(p, { localKey: a.col('id'), foreignKey: p.col('authorId') }),
  } }), code('QUERY'));
  assert.throws(() => db.table(a).findMany({ include: {
    profile: hasOne(p, { localKey: p.col('id'), foreignKey: p.col('authorId') }),
  } }), code('QUERY'));
  assert.equal(db.exportTrace().queries.length, 0);
}));

test('singular batched loading crosses chunk boundaries with one target query per chunk', () => model((db, a, p) => {
  const authors = db.table(a).insertMany(Array.from({ length: 405 }, (_, i) => ({ name: 'Author ' + i, secret: 'Not selected' })));
  db.table(p).insertMany(authors.map(author => ({ authorId: author.id, bio: 'Bio ' + author.id })));
  db.clearTrace();
  const rows = db.table(a).findMany({ select: ['name'], include: { profile: hasOne(p, {
    localKey: a.col('id'), foreignKey: p.col('authorId'), select: ['bio'],
  }) } });
  assert.equal(rows.length, 405);
  assert.deepEqual(rows[404], { name: 'Author 404', profile: { bio: 'Bio 405' } });
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 3);
}));

test('an empty root result does not run a singular target query', () => model((db, a, p) => {
  db.clearTrace();
  assert.deepEqual(db.table(a).findMany({ select: ['name'], include: { profile: hasOne(p, {
    localKey: a.col('id'), foreignKey: p.col('authorId'), select: ['bio'],
  }) } }), []);
  assert.equal(db.exportTrace().queries.filter(q => q.operation === 'select').length, 1);
}));

test('detached relation JSON preserves own special keys without changing object prototypes', () => {
  const authors = defineTable('authors', { id: column.integer().primaryKey(), data: column.json() });
  const posts = defineTable('posts', { id: column.integer().primaryKey(), authorId: column.integer().references(authors, 'id') });
  const db = openDatabase(':memory:', { tables: [authors, posts] });
  try {
    db.ensureSchema();
    const data = JSON.parse('{"__proto__":{"flag":"ordinary data"},"constructor":{"tag":"ordinary data"}}');
    db.table(authors).insert({ id: 1, data });
    db.table(posts).insertMany([{ id: 1, authorId: 1 }, { id: 2, authorId: 1 }]);
    const rows = db.table(posts).findMany({ include: { author: belongsTo(authors, {
      localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['data'],
    }) } });
    assert.deepEqual(rows[0].author.data, data);
    assert.equal(Object.getPrototypeOf(rows[0].author.data), Object.prototype);
    assert.equal(Object.hasOwn(rows[0].author.data, '__proto__'), true);
    rows[0].author.data.__proto__.flag = 'Changed first copy';
    assert.equal(rows[1].author.data.__proto__.flag, 'ordinary data');
    assert.equal({}.flag, undefined);
  } finally { db.close(); }
});
