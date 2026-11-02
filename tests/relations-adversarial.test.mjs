import test from 'node:test';
import assert from 'node:assert/strict';
import * as orm from '../dist/index.js';

const { column, defineTable, openDatabase, eq, asc, desc, hasMany } = orm;
const coded = code => error => error instanceof orm.RowstitchError && error.code === code;
const safeError = error => error instanceof orm.RowstitchError;
const keys = (row, expected) => assert.deepEqual(Reflect.ownKeys(row).sort(), [...expected].sort());

function memory(t) {
  const authors = defineTable('authors', {
    id: column.integer().primaryKey(), name: column.text(), secret: column.text().default('DO_NOT_EXPOSE_AUTHOR'),
    active: column.boolean().default(true), groupKey: column.text().default('shared'), metadata: column.json().default({ color: 'teal' }),
  });
  const profiles = defineTable('profiles', {
    id: column.integer().primaryKey(), authorId: column.integer().nullable(), bio: column.text(), active: column.boolean().default(true),
    avatarId: column.integer().nullable(), groupKey: column.text().default('shared'), secret: column.text().default('DO_NOT_EXPOSE_PROFILE'),
  });
  // A legacy-style nullable scalar reference deliberately has no database FK, so missing references can be exercised.
  const posts = defineTable('posts', {
    id: column.integer().primaryKey(), authorId: column.integer().nullable(), title: column.text(),
    groupKey: column.text().default('shared'), secret: column.text().default('DO_NOT_EXPOSE_POST'),
  });
  const avatars = defineTable('avatars', {
    id: column.integer().primaryKey(), caption: column.text(), secret: column.text().default('DO_NOT_EXPOSE_AVATAR'),
  });
  const unrelated = defineTable('unrelated', { id: column.integer().primaryKey(), ownerId: column.integer(), label: column.text() });
  const db = openDatabase(':memory:', { tables: [authors, profiles, posts, avatars, unrelated], maxTraceEntries: 1000 });
  db.ensureSchema();
  t.after(() => db.close());
  return { db, authors, profiles, posts, avatars, unrelated };
}

function reads(db) { return db.exportTrace().queries.filter(query => query.operation === 'select'); }

test('the independent singular-relation API exists and plain projection omits every unrequested field', t => {
  assert.equal(typeof orm.hasOne, 'function', 'hasOne must be a real exported API');
  assert.equal(typeof orm.belongsTo, 'function', 'belongsTo must be a real exported API');
  const { db, authors } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  const row = db.table(authors).findFirst({ select: ['name'] });
  assert.deepEqual(row, { name: 'Avery' });
  keys(row, ['name']);
  const compiled = db.table(authors).compileSelect({ select: ['name'], where: eq(authors.col('id'), 1) });
  const projection = compiled.sql.split(/\bFROM\b/i)[0];
  assert.ok(projection.includes('name'));
  assert.ok(!projection.includes('*') && !projection.includes('secret') && !projection.includes('metadata'));
  assert.equal(compiled.parameters[0], 1);
  const plan = db.table(authors).explain({ select: ['name'], where: eq(authors.col('id'), 1) });
  assert.ok(plan.length && plan.every(step => typeof step.detail === 'string'));
});

test('bad or empty projection requests fail instead of silently returning the complete row', t => {
  const { db, authors, posts } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  for (const select of [[], null, 'name', ['missing'], ['*'], ['constructor'], ['__proto__'], ['name" FROM authors; --'], [posts.col('title')]]) {
    assert.throws(() => db.table(authors).findMany({ select }), safeError);
    assert.throws(() => db.table(authors).compileSelect({ select }), safeError);
  }
  assert.deepEqual(db.table(authors).findFirst({ select: ['name'] }), { name: 'Avery' });
});

test('hasOne and belongsTo preserve parent rows for absent, null and filtered references', t => {
  const { db, authors, profiles, posts } = memory(t);
  db.table(authors).insertMany([{ id: 1, name: 'Avery' }, { id: 2, name: 'Briar', active: false }, { id: 3, name: 'Casey' }]);
  db.table(profiles).insertMany([{ id: 1, authorId: 1, bio: 'Shown' }, { id: 2, authorId: 2, bio: 'Excluded', active: false }]);
  const rows = db.table(authors).findMany({
    select: ['name'], orderBy: [asc(authors.col('id'))],
    include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), where: eq(profiles.col('active'), true), select: ['bio'] }) },
  });
  assert.deepEqual(rows, [{ name: 'Avery', profile: { bio: 'Shown' } }, { name: 'Briar', profile: null }, { name: 'Casey', profile: null }]);
  db.table(posts).insertMany([{ id: 1, authorId: 1, title: 'Exists' }, { id: 2, authorId: null, title: 'Null' }, { id: 3, authorId: 999, title: 'Missing' }, { id: 4, authorId: 2, title: 'Filtered' }]);
  const related = db.table(posts).findMany({
    select: ['title'], orderBy: [asc(posts.col('id'))],
    include: { author: orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), where: eq(authors.col('active'), true), select: ['name'] }) },
  });
  assert.deepEqual(related, [
    { title: 'Exists', author: { name: 'Avery' } }, { title: 'Null', author: null },
    { title: 'Missing', author: null }, { title: 'Filtered', author: null },
  ]);
});

test('singular ambiguity is checked after its filter and cannot be hidden by projection or ordering', t => {
  const { db, authors, profiles, posts } = memory(t);
  db.table(authors).insertMany([{ id: 1, name: 'Same author' }, { id: 2, name: 'Same author' }]);
  db.table(profiles).insertMany([{ id: 1, authorId: 1, bio: 'Same bio' }, { id: 2, authorId: 1, bio: 'Same bio', active: false }]);
  const options = { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select: ['bio'], orderBy: [desc(profiles.col('id'))] };
  assert.throws(() => db.table(authors).findMany({ select: ['name'], include: { profile: orm.hasOne(profiles, options) } }), coded('RELATION_CARDINALITY'));
  const filtered = db.table(authors).findFirst({ where: eq(authors.col('id'), 1), select: ['name'], include: { profile: orm.hasOne(profiles, { ...options, where: eq(profiles.col('active'), true) }) } });
  assert.deepEqual(filtered, { name: 'Same author', profile: { bio: 'Same bio' } });
  db.table(posts).insert({ id: 1, title: 'Ambiguous non-unique lookup' });
  assert.throws(() => db.table(posts).findMany({ select: ['title'], include: { author: orm.belongsTo(authors, { localKey: posts.col('groupKey'), foreignKey: authors.col('groupKey'), select: ['name'] }) } }), coded('RELATION_CARDINALITY'));
});

test('singular descriptors reject every limit or offset rather than truncate an ambiguous match', t => {
  const { db, authors, profiles } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  db.table(profiles).insertMany([{ id: 1, authorId: 1, bio: 'One' }, { id: 2, authorId: 1, bio: 'Two' }]);
  for (const extra of [{ limit: 0 }, { limit: 1 }, { limit: undefined }, { offset: 0 }, { offset: 1 }, { offset: undefined }]) {
    assert.throws(() => db.table(authors).findMany({ include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), ...extra }) } }), safeError);
    assert.throws(() => db.table(profiles).findMany({ include: { author: orm.belongsTo(authors, { localKey: profiles.col('authorId'), foreignKey: authors.col('id'), ...extra }) } }), safeError);
  }
});

test('ambiguity in the second 400-parent batch still fails instead of returning a partial graph', t => {
  const { db, authors, profiles } = memory(t);
  db.table(authors).insertMany(Array.from({ length: 405 }, (_, i) => ({ id: i + 1, name: 'Parent ' + i })));
  db.table(profiles).insertMany([...Array.from({ length: 405 }, (_, i) => ({ id: i + 1, authorId: i + 1, bio: 'Profile' })), { id: 406, authorId: 405, bio: 'Another profile' }]);
  db.clearTrace();
  assert.throws(() => db.table(authors).findMany({ limit: 405, select: ['name'], include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select: ['bio'] }) } }), coded('RELATION_CARDINALITY'));
  assert.equal(reads(db).length, 3);
  assert.equal(db.table(authors).count(), 405);
  assert.equal(db.table(profiles).count(), 406);
});

test('singular loading uses bounded batched reads rather than one query per parent', t => {
  const { db, authors, profiles, posts } = memory(t);
  db.table(authors).insertMany(Array.from({ length: 405 }, (_, i) => ({ id: i + 1, name: 'Author ' + i })));
  db.table(profiles).insertMany(Array.from({ length: 405 }, (_, i) => ({ id: i + 1, authorId: i + 1, bio: 'Bio ' + i })));
  db.table(posts).insertMany(Array.from({ length: 405 }, (_, i) => ({ id: i + 1, authorId: i + 1, title: 'Post ' + i })));
  db.clearTrace();
  const one = db.table(authors).findMany({ limit: 405, select: ['name'], include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select: ['bio'] }) } });
  assert.equal(one.length, 405);
  assert.deepEqual(one[404], { name: 'Author 404', profile: { bio: 'Bio 404' } });
  assert.equal(reads(db).length, 3);
  db.clearTrace();
  const belongs = db.table(posts).findMany({ limit: 405, select: ['title'], include: { author: orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name'] }) } });
  assert.deepEqual(belongs[0], { title: 'Post 0', author: { name: 'Author 0' } });
  assert.deepEqual(belongs[404], { title: 'Post 404', author: { name: 'Author 404' } });
  assert.equal(reads(db).length, 3);
});

test('hidden primary and join keys survive nested loading but never leak into projected output', t => {
  const { db, authors, profiles, posts, avatars } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  db.table(avatars).insert({ id: 9, caption: 'Fictional moon icon' });
  db.table(profiles).insert({ id: 5, authorId: 1, avatarId: 9, bio: 'Gardener' });
  db.table(posts).insertMany([{ id: 1, authorId: 1, title: 'One' }, { id: 2, authorId: 1, title: 'Two' }]);
  db.clearTrace();
  const rows = db.table(posts).findMany({ select: ['title'], include: {
    author: orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name'], include: {
      profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select: ['bio'], include: {
        avatar: orm.belongsTo(avatars, { localKey: profiles.col('avatarId'), foreignKey: avatars.col('id'), select: ['caption'] }),
      } }),
    } }),
  } });
  assert.deepEqual(rows, ['One', 'Two'].map(title => ({ title, author: { name: 'Avery', profile: { bio: 'Gardener', avatar: { caption: 'Fictional moon icon' } } } })));
  assert.equal(reads(db).length, 4);
  keys(rows[0], ['title', 'author']);
  keys(rows[0].author, ['name', 'profile']);
  keys(rows[0].author.profile, ['bio', 'avatar']);
  keys(rows[0].author.profile.avatar, ['caption']);
  assert.ok(!JSON.stringify(rows).includes('DO_NOT_EXPOSE'));
  rows[0].author.profile.avatar.caption = 'Changed in one returned graph';
  assert.equal(rows[1].author.profile.avatar.caption, 'Fictional moon icon');
});

test('shared singular targets and relation aliases are detached including mutable JSON values', t => {
  const { db, authors, posts } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery', metadata: { colors: ['teal'], nested: { visits: 1 } } });
  db.table(posts).insertMany([{ id: 1, authorId: 1, title: 'One' }, { id: 2, authorId: 1, title: 'Two' }]);
  const author = orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name', 'metadata'] });
  const rows = db.table(posts).findMany({ select: ['title'], include: { firstAuthor: author, secondAuthor: author } });
  assert.notEqual(rows[0].firstAuthor, rows[1].firstAuthor);
  assert.notEqual(rows[0].firstAuthor, rows[0].secondAuthor);
  rows[0].firstAuthor.metadata.colors.push('orange');
  rows[0].firstAuthor.metadata.nested.visits = 99;
  rows[0].firstAuthor.name = 'Only this returned value';
  assert.deepEqual(rows[1].firstAuthor, { name: 'Avery', metadata: { colors: ['teal'], nested: { visits: 1 } } });
  assert.deepEqual(rows[0].secondAuthor, rows[1].firstAuthor);
  assert.deepEqual(db.table(authors).findFirst({ select: ['metadata'] }).metadata, { colors: ['teal'], nested: { visits: 1 } });
});

test('hasMany projection preserves old per-parent pagination and hides its internal rank and keys', t => {
  const { db, authors, posts } = memory(t);
  db.table(authors).insertMany([{ id: 1, name: 'Avery' }, { id: 2, name: 'Briar' }]);
  db.table(posts).insertMany([1, 2].flatMap(authorId => [0, 1, 2].map(i => ({ id: authorId * 10 + i, authorId, title: 'Post ' + i }))));
  db.clearTrace();
  const rows = db.table(authors).findMany({ select: ['name'], include: { posts: hasMany(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), orderBy: [desc(posts.col('id'))], limit: 1, offset: 1, select: ['title'] }) } });
  assert.deepEqual(rows, [{ name: 'Avery', posts: [{ title: 'Post 1' }] }, { name: 'Briar', posts: [{ title: 'Post 1' }] }]);
  assert.equal(reads(db).length, 2);
  keys(rows[0].posts[0], ['title']);
  assert.ok(!JSON.stringify(rows).includes('__rs_rank'));
});

test('shared hasMany children and arrays are detached across parents and aliases', t => {
  const { db, authors, profiles } = memory(t);
  db.table(authors).insertMany([{ id: 1, name: 'Avery' }, { id: 2, name: 'Briar' }]);
  db.table(profiles).insert({ id: 1, authorId: null, bio: 'Shared lookup' });
  const relation = hasMany(profiles, { localKey: authors.col('groupKey'), foreignKey: profiles.col('groupKey'), select: ['bio'] });
  const rows = db.table(authors).findMany({ select: ['name'], include: { left: relation, right: relation } });
  rows[0].left[0].bio = 'Only this copy';
  rows[0].left.push({ bio: 'Only this array' });
  assert.deepEqual(rows[1].left, [{ bio: 'Shared lookup' }]);
  assert.deepEqual(rows[0].right, [{ bio: 'Shared lookup' }]);
  assert.deepEqual(rows[1].right, [{ bio: 'Shared lookup' }]);
});

test('related projected selections reject unknown fields without leaking a fallback full child', t => {
  const { db, authors, profiles } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  db.table(profiles).insert({ id: 1, authorId: 1, bio: 'Gardener' });
  for (const select of [[], null, ['secret_that_does_not_exist'], ['*'], ['__proto__']]) {
    assert.throws(() => db.table(authors).findMany({ select: ['name'], include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select }) } }), safeError);
    assert.throws(() => db.table(authors).findMany({ select: ['name'], include: { profiles: hasMany(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select }) } }), safeError);
  }
});

test('wrong-table keys, predicates, alias collisions and forged descriptors are refused', t => {
  const { db, authors, profiles, posts } = memory(t);
  db.table(authors).insert({ id: 1, name: 'Avery' });
  db.table(profiles).insert({ id: 1, authorId: 1, bio: 'Gardener' });
  assert.throws(() => db.table(authors).findMany({ include: { profile: orm.hasOne(profiles, { localKey: posts.col('id'), foreignKey: profiles.col('authorId') }) } }), safeError);
  assert.throws(() => db.table(authors).findMany({ include: { profile: orm.hasOne(profiles, { localKey: authors.col('name'), foreignKey: profiles.col('authorId') }) } }), safeError);
  assert.throws(() => orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: profiles.col('id') }), safeError);
  assert.throws(() => db.table(authors).findMany({ include: { profile: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId'), where: eq(posts.col('id'), 1) }) } }), safeError);
  assert.throws(() => db.table(authors).findMany({ select: ['id'], include: { name: orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId') }) } }), safeError);
  assert.throws(() => db.table(authors).findMany({ include: { profile: { table: profiles, options: { localKey: authors.col('id'), foreignKey: profiles.col('authorId') } } } }), safeError);
  for (const alias of ['__proto__', 'constructor']) {
    const include = Object.fromEntries([[alias, orm.hasOne(profiles, { localKey: authors.col('id'), foreignKey: profiles.col('authorId') })]]);
    assert.throws(() => db.table(authors).findMany({ include }), safeError);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('int64 join keys remain distinct even when JavaScript numbers could not represent them', t => {
  const authors = defineTable('exact_authors', { id: column.bigint().primaryKey(), name: column.text(), secret: column.text().default('HIDDEN') });
  const posts = defineTable('exact_posts', { id: column.integer().primaryKey(), authorId: column.bigint().nullable(), title: column.text() });
  const db = openDatabase(':memory:', { tables: [authors, posts] });
  db.ensureSchema(); t.after(() => db.close());
  const first = 9223372036854775806n, second = 9223372036854775807n;
  db.table(authors).insertMany([{ id: first, name: 'First' }, { id: second, name: 'Second' }]);
  db.table(posts).insertMany([{ id: 1, authorId: first, title: 'One' }, { id: 2, authorId: second, title: 'Two' }, { id: 3, authorId: null, title: 'Null' }, { id: 4, authorId: -9223372036854775808n, title: 'Missing' }]);
  const rows = db.table(posts).findMany({ select: ['title'], include: { author: orm.belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name'] }) } });
  assert.deepEqual(rows, [{ title: 'One', author: { name: 'First' } }, { title: 'Two', author: { name: 'Second' } }, { title: 'Null', author: null }, { title: 'Missing', author: null }]);
  const graph = db.table(authors).findMany({ select: ['name'], include: { posts: hasMany(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), select: ['title'] }) } });
  assert.deepEqual(graph, [{ name: 'First', posts: [{ title: 'One' }] }, { name: 'Second', posts: [{ title: 'Two' }] }]);
});

test('shared-key graph expansion respects the returned-copy budget rather than only fetched rows', t => {
  const { db, authors, profiles } = memory(t);
  db.table(authors).insertMany(Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: 'Parent ' + i })));
  db.table(profiles).insertMany(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, authorId: null, bio: 'Shared child ' + i })));
  assert.throws(() => db.table(authors).findMany({ limit: 120, select: ['name'], include: { shared: hasMany(profiles, { localKey: authors.col('groupKey'), foreignKey: profiles.col('groupKey'), limit: 100, select: ['bio'] }) } }), coded('RESULT_LIMIT'));
  assert.equal(db.table(authors).count(), 120);
  assert.equal(db.table(profiles).count(), 100);
});

test('an empty include at the fourth relationship level behaves like an omitted leaf', t => {
  const nodes = defineTable('nodes', { id: column.integer().primaryKey(), name: column.text() });
  const db = openDatabase(':memory:', { tables: [nodes] });
  db.ensureSchema(); t.after(() => db.close());
  db.table(nodes).insert({ id: 1, name: 'Synthetic' });
  const chain = (levels, emptyLeaf) => {
    let include = emptyLeaf ? {} : undefined;
    for (let i = 0; i < levels; i++) include = {
      next: orm.hasOne(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('id'), select: ['name'], ...(include === undefined ? {} : { include }) }),
    };
    return { select: ['name'], include };
  };
  const expected = db.table(nodes).findMany(chain(4, false));
  assert.deepEqual(db.table(nodes).findMany(chain(4, true)), expected);
  assert.throws(() => db.table(nodes).findMany(chain(5, true)), coded('QUERY'));
});
