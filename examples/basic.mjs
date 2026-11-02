import { column, defineTable, openDatabase, asc, desc, hasMany } from 'rowstitch';
import { writeFileSync } from 'node:fs';

const authors = defineTable('authors', {
  id: column.integer().primaryKey({ generated: true }),
  name: column.text(),
  version: column.integer().default(1),
}, { version: 'version' });
const posts = defineTable('posts', {
  id: column.integer().primaryKey({ generated: true }),
  authorId: column.integer().references(authors, 'id', { onDelete: 'cascade' }),
  title: column.text(),
});
const db = openDatabase(':memory:', { tables: [authors, posts] });
try {
  db.ensureSchema();
  db.transaction(tx => {
    const author = tx.table(authors).insert({ name: 'Avery' });
    tx.table(posts).insertMany([
      { authorId: author.id, title: 'First notebook' },
      { authorId: author.id, title: 'A useful little query' },
      { authorId: author.id, title: 'A draft for tomorrow' },
    ]);
    tx.table(authors).updateVersion({ id: author.id }, 1, { name: 'Avery Lee' });
  });
  const result = db.table(authors).findMany({
    orderBy: [asc(authors.col('id'))],
    include: { posts: hasMany(posts, {
      localKey: authors.col('id'), foreignKey: posts.col('authorId'),
      orderBy: [desc(posts.col('id'))], limit: 2,
    }) },
  });
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[2] === '--trace' && process.argv[3] && process.argv.length === 4) {
    // Never silently replace an existing trace or another file.
    writeFileSync(process.argv[3], JSON.stringify(db.exportTrace({ title: 'The basic example' }), null, 2), { flag: 'wx' });
    console.log('Trace saved. Open it in the local inspector; review it before sharing.');
  } else if (process.argv.length > 2) {
    throw new Error('Usage: node examples/basic.mjs [--trace new-file.trace.json]');
  }
} finally { db.close(); }
