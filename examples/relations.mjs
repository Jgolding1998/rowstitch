import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, asc } from 'rowstitch';

const authors = defineTable('authors', {
  id: column.integer().primaryKey({ generated: true }),
  name: column.text(),
  privateLabel: column.text(),
});
const profiles = defineTable('profiles', {
  id: column.integer().primaryKey({ generated: true }),
  authorId: column.integer().unique().references(authors, 'id'),
  bio: column.text(),
});
const posts = defineTable('posts', {
  id: column.integer().primaryKey({ generated: true }),
  authorId: column.integer().references(authors, 'id'),
  title: column.text(),
});

const db = openDatabase(':memory:', { tables: [authors, profiles, posts] });
try {
  db.ensureSchema();
  db.transaction(tx => {
    const avery = tx.table(authors).insert({ name: 'Avery', privateLabel: 'fictional internal label' });
    tx.table(authors).insert({ name: 'Robin', privateLabel: 'another fictional internal label' });
    tx.table(profiles).insert({ authorId: avery.id, bio: 'Writes about small gardens.' });
    tx.table(posts).insertMany([
      { authorId: avery.id, title: 'A windowsill garden' },
      { authorId: avery.id, title: 'The first seedlings' },
    ]);
  });

  db.clearTrace();
  const rows = db.table(authors).findMany({
    select: ['name'],
    orderBy: [asc(authors.col('id'))],
    include: {
      profile: hasOne(profiles, {
        localKey: authors.col('id'), foreignKey: profiles.col('authorId'), select: ['bio'],
      }),
      posts: hasMany(posts, {
        localKey: authors.col('id'), foreignKey: posts.col('authorId'),
        select: ['title'], orderBy: [asc(posts.col('id'))],
        include: {
          author: belongsTo(authors, {
            localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name'],
          }),
        },
      }),
    },
  });

  assert.deepEqual(rows, [
    { name: 'Avery', profile: { bio: 'Writes about small gardens.' }, posts: [
      { title: 'A windowsill garden', author: { name: 'Avery' } },
      { title: 'The first seedlings', author: { name: 'Avery' } },
    ] },
    { name: 'Robin', profile: null, posts: [] },
  ]);
  const selects = db.exportTrace().queries.filter(query => query.operation === 'select');
  assert.equal(selects.length, 4); // One batch for each relation, not one request per author/post.
  console.log(JSON.stringify(rows, null, 2));
  console.log(`${selects.length} SELECTs. Only the requested fields are returned.`);
} finally {
  db.close();
}
