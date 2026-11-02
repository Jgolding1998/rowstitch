import { column, defineTable, openDatabase, eq, contains, startsWith, endsWith, between, hasMany, hasOne, belongsTo, type InsertRow, type Row, type Column, type ColumnRef, type TextMatchOptions } from '../../src/index.js';
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

// M3a: factory/fluent codec tags retain old generic annotations while new
// predicates reject nontext JSON payloads and mismatched scalar bounds.
const literalNames = defineTable('literal_names', { name: column.text().primaryKey() });
const literalTable = defineTable('literal_types', {
  id: column.integer().primaryKey(), text: column.text(), maybe: column.text().nullable().default(null).unique(),
  textKey: column.text().primaryKey(), textRef: column.text().references(literalNames, 'name'),
  real: column.real().nullable(), exact: column.bigint(), jsonText: column.json<string>(), jsonNumber: column.json<number>(),
});
const oldColumnAnnotation: Column<string> = column.text();
const oldThreeGenerics: Column<number, true, true> = column.integer().primaryKey({ generated: true });
const oldRefAnnotation: ColumnRef<string> = literalTable.col('text');
eq(oldRefAnnotation, 'unchanged');
const searchOptions: TextMatchOptions = { case: 'ascii-insensitive' };
contains(literalTable.col('text'), 'hello');
contains(literalTable.col('maybe'), 'HELLO', searchOptions);
startsWith(literalTable.col('textKey'), 'key', { case: 'sensitive' });
endsWith(literalTable.col('textRef'), 'key');
between(literalTable.col('id'), 1, 2);
between(literalTable.col('real'), 1.25, 9.5);
between(literalTable.col('exact'), -9223372036854775808n, 9223372036854775807n);
between(literalTable.col('text'), 'A', 'Z');
// @ts-expect-error Numeric refs are not text even when their values could stringify.
contains(literalTable.col('id'), '1');
// @ts-expect-error Boolean refs are not text.
startsWith(authors.col('active'), 't');
// @ts-expect-error JSON<string> is not a text codec.
contains(literalTable.col('jsonText'), 'payload');
// @ts-expect-error JSON<number> is not an ordered numeric codec.
between(literalTable.col('jsonNumber'), 1, 2);
// @ts-expect-error JSON objects are not text.
endsWith(authors.col('metadata'), 'payload');
// @ts-expect-error A search literal is a primitive string.
contains(literalTable.col('text'), 1);
// @ts-expect-error NULL search literals have no implicit meaning.
contains(literalTable.col('maybe'), null);
// @ts-expect-error Undefined search literals are rejected.
contains(literalTable.col('text'), undefined);
// @ts-expect-error A literal helper does not accept another column as a needle.
contains(literalTable.col('text'), literalTable.col('textRef'));
// @ts-expect-error Unsupported case folding must not silently become ASCII folding.
contains(literalTable.col('text'), 'x', { case: 'unicode-insensitive' });
// @ts-expect-error Case is explicit, not an ambiguous boolean.
startsWith(literalTable.col('text'), 'x', { case: true });
// @ts-expect-error Misspelled option names are not accepted.
endsWith(literalTable.col('text'), 'x', { caseInsensitive: true });
// @ts-expect-error Numeric bounds cannot widen the mapped string type through inference.
between(literalTable.col('text'), 1, 2);
// @ts-expect-error String bounds cannot widen a mapped number type.
between(literalTable.col('id'), '1', 2);
// @ts-expect-error Range bounds are non-null even when the column is nullable.
between(literalTable.col('real'), null, 2);
// @ts-expect-error Bigint codecs require exact bigint bounds.
between(literalTable.col('exact'), 1, 2n);
// @ts-expect-error Boolean columns are not ordered range operands.
between(authors.col('active'), false, true);
// @ts-expect-error Column-valued range bounds are deferred.
between(literalTable.col('id'), literalTable.col('id'), 2);
void [oldColumnAnnotation, oldThreeGenerics, oldRefAnnotation];
