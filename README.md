# Rowstitch

A small SQLite ORM for Node and TypeScript. Define your tables, load related rows in batches, and inspect the SQL your application actually ran.

Rowstitch has no runtime npm dependencies. It uses Node's built-in SQLite driver and includes a local, read-only query inspector. No account, AI subscription or API key is needed.

Use the library inside a Node app, such as a small inventory tool or a backend that stores related records in SQLite. Your app reads and writes through Rowstitch; the browser inspector helps you understand the SQL it ran. Coding assistants can follow the included integration instructions. There is no MCP server in the current package.

![Rowstitch Studio showing a real query trace from its fictional notebook demo](docs/images/studio.png)

## Try the inspector

Use **Node 24.22.2+ or Node 26.13.0+ within those LTS release lines**. Run the prebuilt GitHub release:

```sh
npm exec --yes --package=https://github.com/Jgolding1998/rowstitch/releases/download/v0.3.1/rowstitch-0.3.1.tgz -- rowstitch demo
```

Or build from source:

```sh
git clone https://github.com/Jgolding1998/rowstitch.git
cd rowstitch
npm ci --ignore-scripts
npm run build
npm run demo
```

Open **http://127.0.0.1:4317**. The demo creates a fresh in-memory database with fictional authors and posts. Its SQL, results and version-conflict example come from the real ORM. Stop it with Ctrl+C. Use `node dist/cli.js demo --port 4318` if the port is occupied.

The inspector lets you search queries, follow transactions, examine parameterized SQL and query plans, and read the schema. You can open a Rowstitch trace JSON file in the browser; imported SQL is displayed, never executed. The file stays in browser memory and is not uploaded to the local server.

## Use it in an application

Install the versioned release in your project. It is distributed through GitHub releases, not the npm registry:

```sh
npm install --save-exact https://github.com/Jgolding1998/rowstitch/releases/download/v0.3.1/rowstitch-0.3.1.tgz
```

```ts
import { column, defineTable, openDatabase, eq } from 'rowstitch';

const authors = defineTable('authors', {
  id: column.integer().primaryKey({ generated: true }),
  name: column.text(),
  version: column.integer().default(1),
}, { version: 'version' });

const db = openDatabase('notes.sqlite', { tables: [authors] });
db.ensureSchema();

const author = db.table(authors).insert({ name: 'Avery' });
db.table(authors).updateVersion({ id: author.id }, 1, { name: 'Avery Lee' });
const saved = db.table(authors).findFirst({ where: eq(authors.col('id'), author.id) });
console.log(saved?.name); // Avery Lee
db.close();
```

`updateVersion` checks the version and increments it atomically. A stale save raises `ConflictError`; it does not overwrite the newer row. Ordinary updates and deletes require a meaningful filter and use an affected-row limit inside a transaction. Primary keys and version fields cannot be patched directly.

See [examples/basic.mjs](examples/basic.mjs) for transactions and trace export. [examples/relations.mjs](examples/relations.mjs) shows one-to-one, many-to-one and one-to-many reads with selected fields. [Agent instructions](docs/agent-instructions.md) describe a safe integration workflow for coding assistants.

## Read connected records

Use `hasMany` for a list, `hasOne` for a single owned record, and `belongsTo` to follow a reference. Relations load in batches. A missing singular relation returns `null`; more than one matching record raises `RELATION_CARDINALITY` instead of silently picking one.

`select: ['name']` returns only the named columns, alongside any explicitly included relations. SQL may also read keys needed to join the records; those internal keys do not appear in the returned object. Select fields separately on each relation; omitting `select` returns every mapped column. This is a query feature, not an authorization system.

Literal selection tuples infer exactly those fields. When the selection is a dynamic array or a tuple slot can name different fields, TypeScript marks uncertain fields optional. Check those fields before using them; a field listed in the array's type is not necessarily present in its value.

Text-key relationships retain SQLite's comparison rules, including existing `NOCASE` and `RTRIM` collations. Matching and per-parent pagination happen in SQL; hidden correlation keys are removed from returned records. One child can match multiple parent keys under a collation, and each returned match counts toward the related-row limits.

## Search text and ranges

Use `contains`, `startsWith` and `endsWith` for literal text. A percent sign means a percent sign; it does not become a wildcard. For a mapped `posts` table with a title and numeric ID:

```ts
import { and, startsWith, between } from 'rowstitch';

const drafts = db.table(posts).findMany({
  where: and(
    startsWith(posts.col('title'), 'draft:', { case: 'ascii-insensitive' }),
    between(posts.col('id'), 10, 20),
  ),
});
```

Matching is case-sensitive by default. The explicit ASCII option folds A-Z only, without Unicode normalization or locale rules. Needles must be nonempty, well-formed strings of at most 4,096 UTF-16 code units. Empty searches are rejected to avoid accidental broad filters. Embedded null characters are supported. A null field matches neither a search nor its negation; combine with `isNull` when null rows should be included.

`between` includes both endpoints and accepts text, integer, real and bigint columns with matching non-null bounds. Text ranges follow the database column's ordering, which can depend on its collation and encoding. Reversed bounds are not rearranged. Literal matching may scan rows; use `explain()` to inspect the actual plan. See [the runnable filter example](examples/literal-filters.mjs).

Keep column and reference types inferred from their factories. An explicit reference annotation needs its codec, for example `ColumnRef<string | null, 'text'>`; a broad `ColumnRef<string>` or `Column<string>` annotation loses the information these new helpers require. Ordinary value predicates keep their existing typing.

Even a nonempty search can match many rows. Updates and deletes still use the atomic `maxRows` limit, and application authorization remains the caller's responsibility.

## Compare two columns

Use `eqColumns`, `neColumns`, `gtColumns`, `gteColumns`, `ltColumns` and `lteColumns` when both operands are mapped columns in the same table. For example, a supplies table can find shortages directly in SQL:

```ts
import { ltColumns } from 'rowstitch';

const shortage = ltColumns(supplies.col('available'), supplies.col('needed'));
const rows = db.table(supplies).findMany({ where: shortage });
db.table(supplies).update({ reorder: true }, { where: shortage, maxRows: 20 });
```

Integer, bigint and real columns can be compared with each other without converting bigint values to JavaScript numbers. Stored real values remain approximate. Text compares with text; booleans support equality and inequality only. JSON, comparisons between tables and self-comparisons are rejected. A NULL operand remains unknown, including under NOT; use explicit NULL predicates when needed.

Existing text columns keep SQLite's collation rules. When two columns declare different collations, the left column's collation takes precedence, so reversing operands can change the result. Text ordering can also depend on the database encoding. See [the runnable inventory example](examples/column-comparisons.mjs).

Each helper reads left to right: `gtColumns(a, b)` means `a > b`. Different columns can still compare true for every row, so retain a deliberate write limit. These queries may scan rows; check `explain()` before assuming an index helps.

## Inspect an existing schema

```sh
node dist/cli.js schema path/to/database.sqlite
```

This command opens the named file read-only and prints schema metadata as JSON. It does not copy application rows or create a missing database. It is an inspection report, not a complete model-code generator.

`planSchema()` describes missing tables and declared indexes without applying them. `ensureSchema()` creates compatible missing objects atomically and rejects detected drift. Neither generates destructive migrations, rebuilds tables or silently drops data. Back up a real database before adopting any new database library.

The schema report and drift checks do not currently identify column collations. Existing `NOCASE` or `RTRIM` columns can change equality, ordering and uniqueness behavior. Literal text searches keep their explicitly chosen case behavior, so they can differ from equality on those columns. Review the existing schema's declarations when those distinctions matter.

## Trace your own code

```ts
import { writeFileSync } from 'node:fs';

// After performing operations with db:
writeFileSync('trace.json', JSON.stringify(db.exportTrace({ title: 'A local session' })));
```

Bound values are redacted at collection by default and result rows are not collected. Trace history defaults to 200 statements with a separate 1 MiB byte limit. Exports fit within 2 MiB by dropping old statements; an oversized schema raises a clear error. Omitted history is noted in the export. SQL, schema names and literal defaults can still reveal information. **Redaction is not anonymization.** Review a trace before sharing it. Compiled-query APIs deliberately return their parameters to your code; keep that output private too.

Trace statuses describe individual SQL statements. An ORM call can still reject a stale edit or ambiguous relationship after its SQL succeeds. Those application-level failures do not yet appear as separate trace events, so zero failed statements does not mean every API call succeeded.

Studio separately shows a write's effect in the recorded transaction: committed, undone, unfinished or unknown. Released savepoints remain subject to an outer rollback. These labels are inferred from recognized transaction statements in the file; missing or inconsistent boundaries stay unknown. They do not certify the current database state or whether an application call succeeded. Edited traces can give misleading results.

## Scope and checks

This release supports SQLite and synchronous callbacks. It is an independent implementation, with a [feature comparison and development plan](docs/compatibility.md). It does not yet provide Orange's full feature set, other database drivers, a migration history runner, nested graph writes, a remote database API or an authorization system. Identifiers use simple names of at most 63 characters. Use the dedicated bigint column for integers beyond JavaScript's safe range.

JSON reads and writes accept finite JSON data within the same depth and node limits. Stored JSON text is limited to 1,048,576 characters before parsing; oversized, invalid or out-of-domain stored values raise a `DATA` error. This also applies to existing databases populated by another tool.

JSON numbers use JavaScript number semantics: a large integer can lose precision even when it is finite. Store exact large values as JSON strings or in a mapped `bigint` column. The structure limit counts the root at depth zero and rejects any value beyond depth 64 or 100,000 total nodes.

```sh
npm test
npm run test:types
npx playwright install chromium
npm run test:browser
```

Tests use temporary or in-memory fictional databases. The [comparison harness](benchmarks/README.md) records correctness and relationship query counts against pinned public libraries. Different SQLite driver versions are disclosed; no blanket speed or security ranking is claimed. [Research notes](docs/research.md) explain which upstream discussions informed the tests. [SECURITY.md](SECURITY.md) defines the trust boundary and remaining limits.

Claude Code leads the inspector's UI and UX. Codex coordinates the core implementation, independent reviews, testing and packaging. The source and branding are original; the project is inspired by public work, not affiliated with those maintainers. See [third-party notices](THIRD_PARTY_NOTICES.md).

MIT licensed. Maintained by [Jgolding1998](https://github.com/Jgolding1998).
