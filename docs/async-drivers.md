# Driver boundary

Rowstitch provides `openDatabase` for synchronous SQLite operations and `await openAsyncDatabase` for operations executed in one background worker. Both use the same repository planning, validation, codecs, SQL compiler and decoders. The worker moves SQLite execution off the calling thread; planning, decoding and trace export still run there. No required runtime npm dependency is added. PostgreSQL and PGlite are optional entries, covered [below](#native-postgresql-and-pglite).

The worker loads compiled JavaScript from a file and does not explicitly forward the parent process's command-line arguments. Module eval and stdin entry points work without passing their `--input-type` flag to the file worker. Parent CLI loader, preload and debugger arguments are not forwarded through this API. Node's normal worker runtime and environment behaviour still applies; this is not an isolated process or sandbox.

Await schema operations, CRUD, relation reads, counts, aggregates, explain and close on the async API. `table()`, compile methods, `clearTrace()` and `exportTrace()` are synchronous. See [the async example](../examples/async.mjs). The internal transaction session, worker transport and inline conformance adapter are not SDK extension points or raw-SQL capabilities.

Input records, encoded JSON, row lists, selected fields, include trees and open options are captured before the first await. Table and relationship identities retain their genuine brands. Changing caller-owned inputs after a call cannot change its saved values or expose a hidden fetched field.

## Transaction ownership

The session serializes driver calls and pins a transaction to its connection. Unrelated work waits in a bounded FIFO. A root or ancestor handle used inside a transaction is rejected with guidance to use the callback's handle, preventing a deadlock. One nested savepoint may be active per parent; sibling calls and parent use while a child is active are refused before SQL is sent.

Await each write inside the callback, or use `insertMany`. Each write has its own atomic scope, so two writes started concurrently inside the same transaction would overlap savepoints and are refused. Concurrent reads are allowed; writes started outside the transaction queue separately. A handle or root context inherited from a finished callback is revoked, including for pure compilation.

When a callback settles with an operation or a child transaction still pending, the session invalidates its handle, drains issued work, rolls back and rejects the transaction with `TRANSACTION_PENDING`. It never commits after silently draining unfinished work. A forgotten operation that was still pending is reported through that rejection, so it does not also become an unhandled rejection. Promises that have already settled cannot be classified: an un-awaited operation that succeeded before the callback settled stays in the transaction, and one that already failed is reported by Node like any other unhandled rejection, which ends the process under its default policy. Operations started on a handle after its transaction has finished are also reported normally.

Callbacks can return ordinary values, promises or `PromiseLike` results. A lazy thenable is adopted inside its transaction context. The settled top-level value must be deliverable without running more code: a Proxy, an accessor or function named `then`, or an uninspectable or overlong prototype chain is refused with `VALIDATION` before COMMIT or RELEASE. Normal objects keep their identity and are not frozen or changed. A non-callable data field such as `{then: 'stored text'}` is allowed. Return a plain copy or wrap a reactive value in an ordinary record when needed.

A captured signal must be an ordinary same-realm platform `AbortSignal`: extensible, with data properties, from `new AbortController()` or the `AbortSignal` factories. Anything else, such as a Proxy, a frozen signal, one from another realm or a look-alike, is refused with `VALIDATION` before any work starts. Native `aborted` and listener methods are called directly, so instance overrides are ignored. This is a bound on the options this library accepts, not a defence against code that tampers with private state or global prototypes.

Keep the result's `then` lookup and prototype stable until the transaction promise settles. If a change is detected after acknowledgment, `TRANSACTION_RESULT_CHANGED` means that COMMIT or RELEASE was acknowledged but the result could not be delivered; do not replay the callback. A nested RELEASE remains provisional until its parent settles. Deliberately installing a callable `then` during later wrapper settlement is unsupported and can still cause that caller-supplied failure after a durable commit. This is a return-value contract, not a sandbox for hostile JavaScript.

### Public cancellation

Pass `{signal}` to `transaction(callback, options)`, on the database or on a transaction handle. It is the only public signal: repository methods do not take one.

- Aborted before the call: rejected with `ABORTED` and no SQL is sent. A parent can catch this for a nested call and continue.
- Aborted while queued: removed from the queue, and no SQL is sent.
- Aborted while running: the transaction stops admitting work, drains issued work, rolls back and rejects with `ABORTED`. A nested transaction's signal controls that child only.
- Aborted after COMMIT was sent: an acknowledged COMMIT wins over a late abort.

No forced statement interruption is promised. Results read inside a transaction remain provisional until the transaction promise resolves; an operation may return rows that are later rolled back.

### Internal session signals

These describe the private session and are not part of the public API. Session statements accept their own signal, checked at admission and again before send. A statement's signal that is already aborted is rejected before admission without affecting its parent; once admitted, it controls the owning transaction. An autocommit statement already sent to the driver is allowed to finish and its actual result stands. A cancelled statement waiting on serialization rejects when its turn arrives, so earlier issued work may delay that rejection.

Defaults are 64 queued root operations, 256 pending statements, a 10-second queue timeout, a 30-second worker-request deadline and at most 32 nested transaction levels. `maxQueue` and `maxPending` accept 1–1024; `queueTimeoutMs` accepts 1–60,000 and `requestTimeoutMs` accepts 1–120,000. A worker deadline or exit after send leaves the outcome unconfirmed. These limits do not guarantee a query's cost; index related keys and inspect plans on realistic data.

## Errors and uncertain outcomes

A definite engine rejection is distinct from a lost acknowledgment. The inline adapter brands and sanitizes known engine errors. An acknowledgment means the engine returned a response; earlier statements in a batch may already have had effects. The transaction session generates individual control statements through the compiler. Arbitrary SQL and scripts are not accepted through Studio or a public async API.

If COMMIT was sent and its acknowledgment is lost, the session raises `COMMIT_UNCONFIRMED`, becomes unusable and requests close once. It does not infer rollback or replay the callback. A later `inTransaction() === false` would not distinguish commit from rollback. Other unconfirmed driver operations likewise make the connection unusable. Cleanup preserves the callback's original error when possible and reports unusability without claiming that a failed close succeeded.

Async exports remain trace format version 1. They use the schema last inspected at open, `inspectSchema()` or `ensureSchema()`; the notes state its capture time. Exporting performs no database I/O. A request error can be either a definite rejection or an unconfirmed outcome, and notes state the uncertainty. Studio marks a failed COMMIT without a subsequent recorded rollback as an unknown write effect. It does not establish the current database state. Schema names and SQL literals may still be sensitive even with redacted values.

## Native PostgreSQL and PGlite

`openPostgresDatabase` from `rowstitch/postgres` and `openPgliteDatabase` from `rowstitch/pglite` return the same `AsyncDatabase`, so the transaction, signal and uncertain-outcome rules above apply. Importing either entry does not load its client; that happens when you open. The core package works with neither client installed.

Tested combination: PostgreSQL 18.6, PGlite 0.5.15 and pg 8.23.1, on Node 24.22.2 and 26.13.0. The peer versions are pinned exactly: another version raises `DRIVER_VERSION`, and a missing one raises `DRIVER_UNAVAILABLE`. Those two checks and the server version check below are guards, not certification of anything else.

### Options

Both factories accept `tables`, `readOnly`, `maxTraceEntries`, `traceValues`, `maxQueue`, `maxPending`, `queueTimeoutMs` and `schema`. Options, tables and connection details are captured before the first await. `schema` defaults to `public`, must already exist, and cannot be a system namespace. A fresh PGlite instance offers no way to create one through this API, so use `public` there.

| PostgreSQL option | Meaning |
| --- | --- |
| `connectionString` | `postgres://user:password@host:port/database`. The only accepted query is `sslmode=disable` or `sslmode=verify-full`. Do not combine it with `host`, `port`, `user` or `database`. It needs a network host |
| `host`, `port`, `user`, `database`, `password` | Use instead of `connectionString`. A leading `/` in `host` selects a Unix socket directory; that form has not been exercised on a real server |
| `ssl` | `true`, or `{ ca?, cert?, key? }` as PEM text. Default `false` |
| `applicationName` | Printable ASCII, up to 63 characters. Default `rowstitch` |
| `connectTimeoutMs` | Client deadline for connecting and confirming settings. 1-120,000, default 10,000 |
| `requestTimeoutMs` | Client deadline for one request. 1-120,000, default 30,000 |
| `closeTimeoutMs` | Client deadline for closing. 1-60,000, default 5,000 |
| `statementTimeoutMs`, `lockTimeoutMs`, `idleInTransactionTimeoutMs`, `transactionTimeoutMs` | Server session timeouts, 0-2,147,483,647, where 0 disables. Omitted values keep the server's configuration. `transactionTimeoutMs` needs a server with that setting (PostgreSQL 17+), or opening fails |

| PGlite option | Meaning |
| --- | --- |
| `openTimeoutMs` | Deadline for starting the worker and engine. 1-120,000, default 30,000. Confirming settings afterwards falls under `requestTimeoutMs` |
| `requestTimeoutMs` | Client deadline for one request. 1-120,000, default 30,000. Reaching it ends the worker, so the in-memory data is gone |
| `closeTimeoutMs` | Client deadline for closing. 1-60,000, default 5,000 |

Opening fails with a constant message and no connection details: `VALIDATION` for bad options, `OPEN` for a refused or unconfirmed connection, `DRIVER_TIMEOUT` for a missed deadline. Reaching a client deadline leaves the outcome unconfirmed and abandons the connection, after asking the server to cancel a running statement. Asking proves nothing; a statement can still complete.

### Connection security

Remote connections should use `ssl: true`, `ssl: { ca }` or `sslmode=verify-full`. Each verifies the certificate and host name. `ssl: { cert, key }` adds a client certificate. No option disables verification, and `sslmode=require`, other `sslmode` values and `rejectUnauthorized` are refused.

**The default is no TLS.** With neither `ssl` nor `sslmode`, the password and data cross the network in clear text. Use that, or `sslmode=disable`, only for a trusted local test. Channel binding is not enforced.

No environment value or password file is used for connection details or the password. If the environment or a changed `pg` default still alters an essential client setting, opening is refused. Client certificates were tested with short-lived self-signed certificates only: not intermediate chains, encrypted keys or revocation. Verified and client-certificate TLS were checked at the connection level; the larger CRUD and filter fixtures run without TLS.

### Settings

Settings travel in the startup message, so they override role and environment defaults, and the server is then asked what is in effect. Opening fails unless it confirms UTF8 client and server encoding, `extra_float_digits=3`, each requested timeout, and a server of PostgreSQL 12 or later. That lower bound exists because this boundary relies on PostgreSQL 12 behavior. **Only 18.6 has been tested.**

Confirmation happens once, at open. These settings are not checked again on each operation. A `client_encoding` change reported by a server ends a `pg` connection, but the PGlite adapter does not watch for it, and neither notices a later float-precision change. The library sends no such change itself and has no raw SQL API.

### Transactions and read-only mode

`db.transaction` and each single write run in `BEGIN ISOLATION LEVEL SERIALIZABLE`. A plain read outside a transaction runs alone. `SERIALIZATION_FAILURE` and `DEADLOCK` are reported and never retried, since your callback may have other effects. Nested transactions use savepoints.

A failed statement aborts a PostgreSQL transaction until it rolls back. A write has its own savepoint, so a caught failed write can continue. A read on a transaction handle has none, so a failed read ends the transaction, and its later COMMIT reports `TRANSACTION_ABORTED`.

`readOnly: true` refuses library writes and wraps work in `BEGIN READ ONLY`, at PostgreSQL's default isolation. It is a transaction mode, not a role or authorization policy.

### Schema planning

`planSchema()` reads catalogs and returns creation statements without running them. `ensureSchema()` creates what is missing in one transaction, then checks the result. Both are creation-only: there is no ALTER, migration, rebuild or drop. New tables use `int8` for integer and bigint, `float8`, `text`, `bool` and `jsonb`. A generated key uses `GENERATED BY DEFAULT AS IDENTITY`. A `.references(...)` column also gets an index. A cycle among new foreign-key tables is refused.

An existing mapped table must be an ordinary or partitioned table and match on primary key columns and order, a compatible native type for each mapped column, nullability, unique columns, single-column foreign keys and their delete action. Otherwise `SCHEMA_DRIFT` is raised and nothing changes.

Not compared: whether a default has the same **value** (only that one is present), CHECK constraints, triggers, row-level security, roles, operator classes and collations. Unmapped extra columns are allowed, so a required one can still make an insert fail. Compatible existing types are wider than what `ensureSchema` creates: for example `int4`, `varchar`, `float4` or `json` columns are accepted, and the engine still applies their limits.

### What the database can still do

Roles, row-level security, triggers, rules, defaults and CHECK constraints apply as usual, and the library reports what the server returns. A trigger can rewrite a returned value; one that suppresses a row raises `DATA` or `AFFECTED_ROWS`. A row-level security rejection raises `DATABASE_ERROR`. Update and delete guards count the rows PostgreSQL reports, so a row hidden by a policy matches zero rows. Database objects are trusted input, and the database is not a sandbox: a function or trigger runs with whatever rights it has.

### Feature limits

Native summary methods are available from version 0.11.0. Their numeric, transaction and result limits are described in the [native summary guide](native-aggregates.md).

Available: root CRUD, `insertMany`, `count`, value filters, `and`/`or`/`not`, literal text searches, ranges, `inArray`, same-table column comparisons, read-only relation filters, selection, ordering, pagination, version-guarded updates, transactions, schema planning, inspection and traces. Native summaries include `aggregate`, `groupBy`, related selectors and their pure compilation methods. Text searches are literal and independent of the database's collation; `ascii-insensitive` folds A-Z only. Ordering otherwise follows the database's collation. NULL ordering matches the SQLite path.

Refused with `QUERY`: eager loading through `include`, `explain`, `explainAggregate` and `explainGroupBy`. They are refused before a statement is built, and the connection stays usable. The methods exist on the shared `AsyncDatabase` type, so TypeScript does not catch these dialect limits yet. Only a runtime error does.

Relation filters in `update` and `delete` are refused with `UNSAFE_WRITE`, including inside `and`, `or` and `not`, by the same check SQLite uses.

Filters have checks on PostgreSQL 18.6 and PGlite 0.5.15 against fixed fictional fixtures, with expected rows worked out by hand:

- **Text searches:** `startsWith`, `endsWith` and `contains` treat `%`, `_` and backslash literally and are case-sensitive by default. `ascii-insensitive` leaves `É` and `é` different. A NULL field does not match, and an empty search is refused.
- **`between`:** includes both bounds, and NULL does not match.
- **`inArray`:** an empty list matches nothing, including NULL. An explicit `null` in the list matches NULL. `not` around an empty list matches every row, while `not` around a list of values leaves a NULL field out as unknown.
- **`some`, `none`, `every`:** a descriptor's `where` sets the domain first, and a NULL foreign key belongs to no parent. `every` passes when there are no related rows and fails when its test is NULL. So it differs from `none(relation, not(test))`, where a NULL test is ignored.
- **`countRelated`:** all six operators, on zero, one and two related rows. It counts rows, including rows with a NULL value unless a test excludes them, and a filtered empty domain counts as zero.

These fixtures do not prove every schema. Relation filters ran one relation deep over `hasMany` with integer keys. Deeper nesting, `hasOne` and `belongsTo` descriptors, text keys and locale-dependent ordering, including text `between`, have not been compared with SQLite. Unicode case folding is not offered. The refusals above were observed as an unchanged SQL trace and a working connection afterwards, backed by source and controlled-executor tests, not by a separate network monitor.

Traces carry `dialect: 'postgresql'` and remain format version 1. Studio reads PostgreSQL controls and `$n` slots from that field. A failed PostgreSQL COMMIT stays unknown even if a later ROLLBACK succeeds, because ROLLBACK succeeds with nothing open.

### PGlite limits

PGlite here is in memory, in a Node worker thread, and nothing persists after close. The public entry has no file option, and nothing is claimed about file storage, shared directories or durability. No browser support, independent-session or server behavior is implied. A pass on PGlite is not a pass on PostgreSQL.

### Not provided or not yet verified

Pools, replicas, managed services, direct TLS negotiation, CommonJS and browser use. PostgreSQL versions other than 18.6. The live engine checks have not run on every supported operating system. Long-running network failure behavior. No security certification or performance comparison is offered for these paths.

## Evidence and remaining work

The conformance tests use real SQLite files checked after reopen, plus an adapter that can delay calls and hide acknowledgments. They exercise connection serialization, nested rollback, escaped contexts, cancellation, unfinished work, definite COMMIT failure and an applied-but-unconfirmed COMMIT. A deliberately naive session is required to fail the ownership probes. Independent adversarial tests cover cancellation during serialization and cleanup failures. The synchronous public SDK is compared with the installed 0.8.0 release by `benchmarks/executor.mjs`.

The PostgreSQL transaction boundary under the native entries has optional [live engine checks](../tests/integration/README.md) against a dedicated PostgreSQL server and an embedded PGlite instance. It distinguishes ordinary engine rejections from uncertain outcomes using SQLSTATE, actual ReadyForQuery status and command tags. It does not use localized severity text to identify an ordinary rejection.

Raw results retain positional text/null cells, native field OIDs and exact bigint row counts from the received CommandComplete tag. Decoders check field identities and types even when no rows matched. Duplicate raw field names stay separate. A private generic result guard keeps this shape separate from the default SQLite named rows.

An error after an autocommit statement's CommandComplete may come from its implicit commit at Sync. It is held to the same positive SQLSTATE list as an explicit COMMIT failure, as well as the status-transition checks. Other codes leave the result unconfirmed and the connection unusable. Partial rows before a known engine error are discarded. None of these rules automatically retries a callback or promises that earlier effects never happened.

PostgreSQL documents the distinction between execution and synchronization in its [extended-query protocol](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY). Its [SQLSTATE catalog](https://www.postgresql.org/docs/18/errcodes-appendix.html) is independent of localized message text. The conservative rejection list above is Rowstitch's policy, backed by the listed tests; those sources do not certify every possible failure outcome.

The rest of this section describes a separate private prototype, the verified mapped-root context. **It is not what `openPostgresDatabase` uses.** The public factories do not take its table locks, fingerprint checks or per-operation settings checks, and they accept triggers, row-level security and partitions that it refuses.

The internal root-query prototype compiles inserts, primary-key lookups and counts from authenticated mappings and captured logical values. It qualifies names and native casts and binds values. Its execution helper decodes writes inside a transaction, including a child savepoint when already in a transaction. A decoder error triggers rollback before COMMIT; a deliberately lost COMMIT acknowledgment stays unknown. Inserts currently require all mapped values explicitly and refuse generated fields. System and temporary schemas are refused. These functions are not public SDK exports.

An internal read-only PostgreSQL session wraps each root request in its own `BEGIN READ ONLY` transaction. That protects regular application tables from writes; it is not an authorization policy, SQL sandbox or shared snapshot across separate requests. No arbitrary SQL is exposed through Studio.

These implicit requests use the transaction queue and its `maxQueue` limit. Await them before closing the session: `close()` refuses an active implicit transaction with `TRANSACTION_ACTIVE`, just as it refuses an explicit one.

The private mapped-root context checks a structural subset on PostgreSQL 18: an exact column set, six native types, nullability, immediate primary keys, required unique indexes and default presence. It refuses views, partitions, inheritance, RLS, user triggers and rewriting rules. Generated mappings can be inspected when backed by native identity or a default, but generated inserts remain unimplemented. Physical foreign keys, CHECK and default expressions, operator classes and role policies are not verified by this subset.

Root operations take table locks before their first catalog query, compare the current fingerprint with the opening snapshot, and check UTF8 encodings, float precision, replication role and the captured search path. They check settings again before decoding the result. Writes decode before COMMIT. A structural/settings mismatch latches the context; catching a child mismatch cannot let its parent commit. Ordinary rejected writes and decoder errors can still roll back a child savepoint and allow valid parent work. Nothing is checked after COMMIT and no uncertain write is replayed.

The read lock is ACCESS SHARE; the write lock is ROW EXCLUSIVE. A manual context transaction takes locks on its registered tables in a fixed order before its first snapshot. PostgreSQL's [locking documentation](https://www.postgresql.org/docs/18/explicit-locking.html) describes which operations these modes block. This is not a guarantee against every concurrent catalog change, hostile database functions or schema administrators. Child operations share their parent's snapshot. A setting changed and restored inside one statement can escape the before/after check. Verification queries also add round trips; no performance advantage is claimed.

A read on a context transaction handle has no savepoint: an engine error can abort its parent, and its operation signal controls that parent. A mapped write has its own child savepoint and signal. The full fingerprint includes indexes, so even adding an unrelated index invalidates the context. A dropped table can instead fail its LOCK with an ordinary database error; recreating it is then detected by the changed fingerprint. Only text primary-key collation is pinned by this subset; a mapped UNIQUE index can use other, including nondeterministic, text collations. A non-read-only manual context transaction needs ROW EXCLUSIVE privileges on every registered table even when its callback only reads.

Eager relation loading and plans on PostgreSQL, broader codecs, real server pools, broader network failure behavior and other drivers remain separate work. Native summaries have their own tests and limits linked above. Current mapped checks cover fixed fictional schemas. PGlite validation cannot prove PostgreSQL pool, session or network behavior. The public PGlite entry runs WASM in a worker thread, so a request deadline can fire while it blocks, and reaching it ends that worker. The [compatibility matrix](compatibility.md) records the full scope still outstanding.

Node's contracts informed this design: [SQLite documentation](https://nodejs.org/api/sqlite.html), [AsyncLocalStorage documentation](https://nodejs.org/api/async_context.html), [worker threads documentation](https://nodejs.org/api/worker_threads.html).
