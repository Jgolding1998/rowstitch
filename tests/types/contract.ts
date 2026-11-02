import { column, defineTable, openDatabase, eq, hasMany, hasOne, belongsTo, type InsertRow, type Row } from '../../src/index.js';
const authors = defineTable('authors', {
  id: column.integer().primaryKey({ generated: true }), name: column.text(),
  active: column.boolean().default(true), metadata: column.json<{ tag: string }>().nullable(),
});
const posts = defineTable('posts', { id: column.integer().primaryKey(), authorId: column.integer().references(authors, 'id'), title: column.text() });
const db = openDatabase(':memory:', { tables: [authors, posts] });
const input: InsertRow<typeof authors> = { name: 'Avery' };
const row: Row<typeof authors> = db.table(authors).insert(input);
const id: number = row.id;
const active: boolean = row.active;
const metadata: { tag: string } | null = row.metadata;
const nested = db.table(authors).findMany({ include: { posts: hasMany(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId') }) } });
const title: string = nested[0].posts[0].title;
const comments = defineTable('comments', { id: column.integer().primaryKey(), postId: column.integer().references(posts, 'id'), body: column.text() });
const deep = db.table(authors).findMany({ include: { posts: hasMany(posts, {
  localKey: authors.col('id'), foreignKey: posts.col('authorId'),
  include: { comments: hasMany(comments, { localKey: posts.col('id'), foreignKey: comments.col('postId') }) },
}) } });
const body: string = deep[0].posts[0].comments[0].body;
// @ts-expect-error Nested eager result types preserve their actual column types.
const wrongBody: number = deep[0].posts[0].comments[0].body;
const selected = db.table(authors).findMany({ select: ['name'], include: {
  latest: hasOne(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), select: ['title'] }),
  posts: hasMany(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), select: ['title'], include: {
    author: belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['name'] }),
  } }),
} });
const selectedName: string = selected[0].name;
const maybeTitle: string | undefined = selected[0].latest?.title;
const maybeAuthor: string | undefined = selected[0].posts[0].author?.name;
const firstSelected = db.table(authors).findFirst({ select: ['name'] });
const firstName: string | undefined = firstSelected?.name;
// @ts-expect-error Root projections omit unselected columns even when needed as internal keys.
const hiddenRootId = selected[0].id;
// @ts-expect-error Child projections omit hidden join keys.
const hiddenChildId = selected[0].posts[0].id;
// @ts-expect-error Singular projected children also omit internal keys.
const hiddenSingularId = selected[0].latest?.id;
// @ts-expect-error Singular relationships can be absent and must be checked.
const uncheckedTitle = selected[0].latest.title;
// @ts-expect-error A singular relationship is an object, never an array.
selected[0].latest?.map(() => 1);
// @ts-expect-error Unknown projection names are not accepted.
db.table(authors).findMany({ select: ['missing'] });
// @ts-expect-error Unknown selected fields also fail in compiled reads.
db.table(authors).compileSelect({ select: ['missing'] });
// @ts-expect-error Target projection names come from the target table.
hasMany(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), select: ['missing'] });
// @ts-expect-error A belongsTo target projection is typed too.
belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), select: ['missing'] });
// @ts-expect-error Singular relations cannot truncate ambiguity with limit.
hasOne(posts, { localKey: authors.col('id'), foreignKey: posts.col('authorId'), limit: 1 });
// @ts-expect-error Singular relations do not accept offset.
belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id'), offset: 1 });
// @ts-expect-error Misspelled query options are not accepted.
db.table(authors).findMany({ selct: ['name'] });
const versioned = defineTable('versioned', { id: column.integer().primaryKey(), name: column.text(), version: column.integer().default(1) }, { version: 'version' });
// @ts-expect-error The ORM owns optimistic version increments.
db.table(versioned).update({ version: 2 }, { where: eq(versioned.col('id'), 1) });
// @ts-expect-error A required non-default field cannot be omitted.
db.table(authors).insert({});
// @ts-expect-error Insert values must match column types.
db.table(authors).insert({ name: 42 });
// @ts-expect-error A generated id remains numeric on read.
const wrong: string = row.id;
// @ts-expect-error Non-null columns reject null.
db.table(authors).insert({ name: null });
// @ts-expect-error Unknown columns do not exist.
authors.col('missing');
// @ts-expect-error Filter values match their mapped column reference.
eq(authors.col('id'), 'wrong');
// @ts-expect-error Unknown insert fields are not accepted.
db.table(authors).insert({ name: 'Avery', extra: true });
// @ts-expect-error Primary keys cannot be patched.
db.table(authors).update({ id: 9 }, { where: eq(authors.col('id'), 1) });
// @ts-expect-error Required explicit primary keys cannot be omitted.
db.table(posts).insert({ authorId: 1, title: 'Post' });
// @ts-expect-error Asynchronous transaction callbacks are not supported.
db.transaction(async tx => tx.table(authors).insert({ name: 'Async' }));
// @ts-expect-error Unknown relation output fields do not exist.
const absent = nested[0].posts[0].missing;
db.close();
void [id, active, metadata, title, body, wrongBody, wrong, absent, selectedName, maybeTitle, maybeAuthor, firstName,
  hiddenRootId, hiddenChildId, hiddenSingularId, uncheckedTitle];
