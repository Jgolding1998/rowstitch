# Connected records on PostgreSQL and PGlite

Version 0.12 adds native eager reads: `findMany` and `findFirst` can return related records through `include`. Version 0.11 refuses nonempty native `include` with `QUERY`.

Use the same `hasMany`, `hasOne` and `belongsTo` helpers as SQLite. Each alias loads a bounded batch of children, rather than making one request for every parent. This returns plain objects; it does not add Active Record change tracking or graph saves.

## Try it

Build the project, install the exact optional `@electric-sql/pglite@0.5.15` peer, then run:

```sh
node examples/native-eager.mjs
```

The [example](../examples/native-eager.mjs) creates fictional authors, profiles and posts in a fresh in-memory PGlite database. It checks selected fields, a singular profile, a paged post list, a nested author and an unpaged related count. Closing the database discards it. For an existing PostgreSQL server, use `openPostgresDatabase` and the same mapped tables/query options; see [connection setup](async-drivers.md#native-postgresql-and-pglite). Use a disposable schema for the example, since it creates tables and inserts its fixture.

With the example's table definitions, a query looks like this:

```js
const rows = await db.table(authors).findMany({
  select: ['name'],
  orderBy: [asc(authors.col('id'))],
  include: {
    profile: hasOne(profiles, {
      localKey: authors.col('id'), foreignKey: profiles.col('authorId'),
      select: ['bio'],
    }),
    latest: hasMany(posts, {
      localKey: authors.col('id'), foreignKey: posts.col('authorId'),
      where: eq(posts.col('published'), true),
      orderBy: [desc(posts.col('id'))], limit: 1,
      select: ['title'],
      include: {
        author: belongsTo(authors, {
          localKey: posts.col('authorId'), foreignKey: authors.col('id'),
          select: ['name'],
        }),
      },
    }),
  },
});
```

`latest` contains at most one post **for each author**. Its filter is applied before that author's page. The root's `limit` and `offset` page authors separately. A filtered or missing profile is `null`; a missing post collection is `[]`. A NULL local key likewise has no related match.

Only explicitly selected columns are returned. Omit `select` to return every mapped column at that level. Keys needed for matching are fetched internally and removed unless selected. Selection is a projection, not an authorization policy. Literal selections preserve precise inferred fields; dynamic selections make uncertain fields optional.

Trace values are redacted by default. If you opt into `traceValues: true`, child query parameters can contain those internally fetched correlation keys, even when they were not selected for output. Review traces before sharing them.

## Relations and ordering

Register every table used in an include with the database factory. Each alias must be a valid identifier, distinct from the parent table's mapped columns. Relations use one local and one foreign column: integer/bigint pairs or text/text pairs. Composite joins, real, boolean and JSON keys are not supported.

`hasMany` accepts `where`, `orderBy`, `select`, `include`, `limit` and `offset`. `hasOne` and `belongsTo` accept the same options except `limit` and `offset`: they read enough matches to detect ambiguity. More than one matching singular target raises `RELATION_CARDINALITY`, even if selected values are identical. Add the intended uniqueness constraint or narrow the relation's filter; ordering does not resolve ambiguity.

Primary-key columns missing from an explicit order are appended ascending to break ties. With no order, primary-key order is used. Native ascending order puts NULL first; descending puts NULL last. Text comparisons follow the related column's native collation. Matching and per-parent pages stay in SQL; JavaScript does not substitute case folding or Unicode normalization. Distinct parent strings that compare equal under a database collation can each receive the same matching child. Index foreign keys and measure against the actual schema; batching is not a guarantee about query cost.

`aggregates` can add related counts or summaries to the root while `include` loads a page of children. A summary covers its relation domain, not the included page. Give each aggregate a distinct alias. These are separate SQL evaluations; do not infer that they describe the same instant during a plain concurrent graph read.

## Bounds and failures

| Bound | Value |
| --- | --- |
| Root `findMany` page | Default 1,000; limit 0–10,000 |
| `hasMany` page per parent | Default 100; limit 0–1,000 |
| Root or `hasMany` offset | Default 0; 0–1,000,000,000 |
| Include nesting | Four relation edges |
| Aliases | Eight in each include record, including each nested record |
| Mapped columns per table | 1–100, including keys fetched internally |
| Source keys in one child request | At most 400 |
| Related rows fetched across the graph | 10,000 |
| Related row copies returned across the graph | A separate 10,000 |
| Native child response wire text | 16 MiB per response; 32 MiB cumulative per graph operation |
| Native source keys | 16 MiB of UTF-8 key text per child request |
| All compiled native parameters | 16 MiB of UTF-8 payload per statement, including keys, filters and generated page bounds |
| Native graph accounting | 268,435,456 units per graph operation |

The fetched-row and copy budgets are separate. Repeated aliases, parents sharing a key, nested rows and collation fan-out can consume copies of the same source row. Root rows are not related-row copies. The loader asks for one extra row when needed to detect overflow and validates that sentinel before deciding which error to report. It does not quietly truncate an overflowing graph or return a partial graph.

Native accounting charges root/child source data, JSON structure, projected values and returned records, arrays, aliases and repeated copies. These are conservative accounting units, **not measured JavaScript heap bytes**. The wire limits count received field-name/cell text, not TCP packet sizes. None of these limits prevents a database, driver or parser from allocating data before the library checks it. Smaller selected fields and pages reduce work; application query deadlines and database limits remain useful.

Known descriptor, selection, ordering, filter and native compilation constraints are checked throughout the include tree before the root request, including an empty root or a zero-length page. Actual parent key values are not known yet. A later key-budget refusal, physical schema drift, malformed stored result or database error can still happen after the root query ran.

The total parameter limit is separate from the key limit. Generated page bounds and filters also need room, so a key batch at its own 16 MiB boundary still exceeds the total statement limit. An oversized compiled parameter set raises constant `QUERY` before that statement is sent; known oversized child filters are refused during preflight. This is a payload limit, not a measurement of full protocol messages or process memory.

Keys alone over their limit raise `RESULT_LIMIT`. Keys that fit that limit but overflow the total when combined with filters and bounds raise `QUERY`. Both can depend on the actual stored parent keys and happen after the root read. Handle either by narrowing the root page or reducing filter data; neither local refusal poisons a healthy connection.

`RESULT_LIMIT`, `DATA` and cardinality checks can refuse a completed response locally while the connection remains healthy. A confirmed PostgreSQL statement error can abort an active transaction until rollback. A lost response is an unconfirmed outcome and can make the connection unusable. See [error and cancellation rules](async-drivers.md#errors-and-uncertain-outcomes); no path automatically replays the graph.

## Read a consistent graph

A graph uses a root statement followed by child statements. Plain writable reads have no encompassing transaction. At PostgreSQL's READ COMMITTED default, a child query can see a commit that the root query could not see. `readOnly: true` does not force SERIALIZABLE: outside an explicit callback it wraps each statement separately, and an explicit read-only callback keeps the server's default isolation.

Use an explicit **writable** transaction when the graph needs the library's SERIALIZABLE mode:

```js
const rows = await db.transaction(async tx => {
  return await tx.table(authors).findMany({
    select: ['name'],
    include: { posts: authorPosts },
  });
});
```

`authorPosts` is a `hasMany` descriptor built from these authors/posts tables. Use `tx` for all work inside the callback and await the whole transaction. Results read inside it are provisional until it resolves. A serialization failure is reported, not retried, because callbacks can have other effects. Transaction cancellation drains issued work before rollback; it does not promise to interrupt an already running SQL statement immediately.

## Evidence and differences

The [public eager corpus](../tests/integration/public-eager.mjs) exercises actual PostgreSQL and fresh-worker PGlite factories. Separate [resource checks](../tests/integration/eager-resources.mjs) exercise the default cumulative limits. [Native controls](../tests/integration/eager-native-controls.mjs) cover PostgreSQL ICU collation, hostile name resolution, statement visibility, transaction modes, cancellation and backend loss. Those PostgreSQL controls do not establish PGlite cross-session or ICU behavior. The visibility fixture also does not separately demonstrate the same-child projected-count versus included-page anomaly.

The [pinned comparison](../tests/integration/public-eager-compare.mjs) runs Orange ORM 5.5.1, Kysely 0.29.8 and Rowstitch on the same disposable PostgreSQL server. The [recorded results](../benchmarks/native-eager-results.json) preserve application values and native representations. Four differences remain explicit: Orange's retained identity fields, native NULL placement, mixed numeric/string key attachment and singular ambiguity. Kysely uses an explicit application batching/guard recipe. This compares the declared fixtures and recipes, not speed, all provider strategies, production reliability or universal superiority. [The compatibility matrix](compatibility.md) tracks the larger independent implementation goal.
