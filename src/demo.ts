import { column, defineTable, openDatabase, eq, asc, desc, hasMany } from './index.js';

/** Each visit uses a new in-memory database. These are fictional examples. */
export function buildDemo() {
  const authors = defineTable('authors', {
    id: column.integer().primaryKey({ generated: true }),
    name: column.text(),
    active: column.boolean().default(true),
    preferences: column.json<{ theme: string }>().nullable(),
    version: column.integer().default(1),
  }, { version: 'version' });
  const posts = defineTable('posts', {
    id: column.integer().primaryKey({ generated: true }),
    authorId: column.integer().references(authors, 'id', { onDelete: 'cascade' }),
    title: column.text(),
    published: column.boolean().default(false),
  });
  // A mapped, subset table beside the two identity tables, so the demo shows how stored names read in Studio.
  const labels = defineTable('labels', {
    id: column.integer().primaryKey({ generated: true }).storedAs('label_id'),
    postId: column.integer().references(posts, 'id', { onDelete: 'cascade' }).storedAs('post_ref'),
    text: column.text().storedAs('label_text'),
  }, { storage: { table: 'notebook_labels' }, schemaPolicy: 'subset' });
  const db = openDatabase(':memory:', { tables: [authors, posts, labels], maxTraceEntries: 200 });
  try {
    db.ensureSchema();
    const people = db.transaction(tx => {
      const rows = tx.table(authors).insertMany([
        { name: 'Avery', preferences: { theme: 'paper' } },
        { name: 'Robin', preferences: null },
        { name: 'Morgan', preferences: { theme: 'ink' } },
      ]);
      for (const person of rows) {
        tx.table(posts).insertMany([
          { authorId: person.id, title: `${person.name}'s first notebook`, published: true },
          { authorId: person.id, title: 'Making a small change', published: true },
          { authorId: person.id, title: 'A draft for tomorrow' },
        ]);
      }
      return rows;
    });
    const first = people[0]!;
    db.table(authors).updateVersion({ id: first.id }, 1, { name: 'Avery Lee' });
    let conflictBlocked = false;
    try {
      db.table(authors).updateVersion({ id: first.id }, 1, { name: 'An older edit' });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'CONFLICT') throw error;
      conflictBlocked = true;
    }
    const firstPost = db.table(posts).findFirst({ where: eq(posts.col('authorId'), first.id), orderBy: [asc(posts.col('id'))] });
    if (firstPost) db.table(labels).insert({ postId: firstPost.id, text: 'Favorite' });
    const results = db.table(authors).findMany({
      where: eq(authors.col('active'), true), orderBy: [asc(authors.col('id'))],
      include: { posts: hasMany(posts, {
        localKey: authors.col('id'), foreignKey: posts.col('authorId'),
        orderBy: [desc(posts.col('id'))], limit: 2,
      }) },
    });
    db.table(authors).explain({ where: eq(authors.col('id'), first.id) });
    const trace = db.exportTrace({ title: 'The notebook demo' });
    return {
      ...trace, source: 'fictional-demo',
      results: [{
        title: 'Authors with their two latest posts',
        columns: ['Author', 'Latest posts', 'Version'],
        rows: results.map(author => [author.name, author.posts.map(post => post.title).join(' · '), author.version]),
      }],
      notes: [
        'Fictional sample data, created in memory for this visit. No database file is opened.',
        'The query list comes from the real ORM. Durations vary between computers and visits.',
        'Three authors and their latest posts are loaded in batches, not one query per author.',
        'The labels table is stored under different names, as notebook_labels. Its statements still list it as labels.',
        conflictBlocked ? 'An older version of Avery’s edit was rejected; the saved version remains 2.' : 'The concurrency example did not run.',
        'Bound values are redacted at collection. SQL and schema names can still be sensitive; redaction is not anonymization.',
      ],
    };
  } finally { db.close(); }
}
