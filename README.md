# Rowstitch

A small SQLite ORM for Node and TypeScript. Define your tables, load related rows in batches, and inspect the SQL your application actually ran.

Rowstitch has no runtime npm dependencies. It uses Node's built-in SQLite driver and includes a local, read-only query inspector. No account, AI subscription or API key is needed.

![Rowstitch Studio showing a real query trace from its fictional notebook demo](docs/images/studio.png)

## Try the inspector

Use **Node 24.22.2 or a newer Node 24 LTS release**. Run the prebuilt GitHub release:

```sh
npm exec --yes --package=https://github.com/Jgolding1998/rowstitch/releases/download/v0.1.0/rowstitch-0.1.0.tgz -- rowstitch demo
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
npm install --save-exact https://github.com/Jgolding1998/rowstitch/releases/download/v0.1.0/rowstitch-0.1.0.tgz
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

`select: ['name']` returns only the named columns, alongside any explicitly included relations. Internal join keys do not appear in the returned object. Select fields separately on each relation; omitting `select` returns every mapped column. This is a query feature, not an authorization system.

## Inspect an existing schema

```sh
node dist/cli.js schema path/to/database.sqlite
```

This command opens the named file read-only and prints schema metadata as JSON. It does not copy application rows or create a missing database. It is an inspection report, not a complete model-code generator.

`planSchema()` describes missing tables and declared indexes without applying them. `ensureSchema()` creates compatible missing objects atomically and rejects detected drift. Neither generates destructive migrations, rebuilds tables or silently drops data. Back up a real database before adopting any new database library.

## Trace your own code

```ts
import { writeFileSync } from 'node:fs';

// After performing operations with db:
writeFileSync('trace.json', JSON.stringify(db.exportTrace({ title: 'A local session' })));
```

Bound values are redacted at collection by default and result rows are not collected. Trace history defaults to 200 statements with a separate 1 MiB byte limit. Exports fit within 2 MiB by dropping old statements; an oversized schema raises a clear error. Omitted history is noted in the export. SQL, schema names and literal defaults can still reveal information. **Redaction is not anonymization.** Review a trace before sharing it. Compiled-query APIs deliberately return their parameters to your code; keep that output private too.

## Scope and checks

This first release supports SQLite and synchronous callbacks. It is an independent implementation, with a [feature comparison and development plan](docs/compatibility.md). It does not yet provide Orange's full feature set, other database drivers, a migration history runner, nested graph writes, a remote database API or an authorization system. Identifiers use simple names of at most 63 characters. Use the dedicated bigint column for integers beyond JavaScript's safe range.

```sh
npm test
npm run test:types
npx playwright install chromium
npm run test:browser
```

Tests use temporary or in-memory fictional databases. The [comparison harness](benchmarks/README.md) records correctness and relationship query counts against pinned public libraries. Different SQLite driver versions are disclosed; no blanket speed or security ranking is claimed. [Research notes](docs/research.md) explain which upstream discussions informed the tests. [SECURITY.md](SECURITY.md) defines the trust boundary and remaining limits.

Claude Code leads the inspector's UI and UX. Codex coordinates the core implementation, independent reviews, testing and packaging. The source and branding are original; the project is inspired by public work, not affiliated with those maintainers. See [third-party notices](THIRD_PARTY_NOTICES.md).

MIT licensed. Maintained by [Jgolding1998](https://github.com/Jgolding1998).
