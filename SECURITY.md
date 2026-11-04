# Security and trust boundary

Rowstitch is new software. Report a reproducible issue with the affected version and a fictional fixture. Do not post private databases, credentials or customer traces in a public issue.

## Library

SQL values are bound parameters. Model identifiers are validated and quoted; arbitrary raw SQL is not part of the public API. Missing or provably unrestricted write predicates are rejected. Affected-row checks and version checks run within the mutation transaction. Row limits refer to directly matched rows, not every change a trusted database trigger or foreign-key cascade can perform.

Relation filters, including count comparisons, are read-only. Updates and deletes reject them, including inside logical expressions. Every target table must be registered on the connection, and related predicates share the expression limits (100 nodes, 16 levels and 10,000 bound values) with at most four nested relationships. Each count threshold is validated and bound. These bounds do not guarantee a fast query: index foreign keys and inspect plans against realistic data. Genuine column/table definitions, relationship descriptors and validated option snapshots prevent the tested forged-object and target-switch cases; they do not turn application JavaScript into an untrusted-code sandbox.

Column constructors validate and copy configuration data without retaining or freezing the caller's record. Accessor descriptors are refused without invoking their getters. A configuration Proxy can run its own descriptor traps; the library validates and freezes the captured values. Proxy wrappers around actual Column instances are not accepted as genuine columns. Prefer the typed column factories: a caller-supplied generic on a direct constructor does not prove that arbitrary runtime data has that type.

Aggregate selectors are branded and immutable; query options are captured as data snapshots. Aggregate arguments must belong to the exact mapped repository table. SQL uses generated result names and ordering positions rather than resolving user aliases. Queries allow at most 32 selectors, 16 grouping keys and 128 generated outputs; the shared WHERE retains the existing predicate bounds. Group output is capped at 10,000 rows, with explicit pagination required to return a partial page instead of raising the implicit cap error.

Aggregate queries check compatible storage types for referenced scalar columns in the same SQL statement. A grouped query carries a flag across all filtered groups before pagination, so invalid off-page input is rejected when a page is returned. Empty pages cannot carry that flag. These are mapping checks, not a general database integrity scan: COUNT(*) does not inspect unrelated fields, and filtered-out rows are outside the check. Real totals/averages are approximate; nonfinite results are refused. Split integer totals preserve precision while retaining SQLite's limits on each partial sum. Input and output bounds do not guarantee a cheap query on a large database.

Related aggregates are separately branded from plain root selectors. Every relation on a path must be registered, start from the previous table and use compatible keys; loading options are refused. One logical predicate budget (100 nodes, 10,000 values, four relationship levels) covers the root `where` and all related domains. Generated predicate bindings are also limited to 10,000 values after counting repeated SQL copies, plus the two pagination values.

In `findMany`/`findFirst`, stored-type checks cover matched related keys and aggregated columns for returned parents. Root correlation keys are fetched internally and strictly decoded. Unreturned parents and unmatched rows, including rows whose corrupted key prevents a match, are outside that check.

In root `aggregate` and `groupBy`, each related selector reads its own matching paths from the filtered root set or group. The same statement checks related storage across the whole filtered domain and checks each path's root key, including groups outside a returned page. Empty pages have no guard-bearing row. Repeated root filters and domains count toward the physical binding limit; indexes and the workload determine query cost. These checks are not a general database integrity scan.

Foreign keys and SQLite defensive mode are enabled; extension loading is disabled. WAL is not enabled automatically. Keep the supported Node runtime updated: npm audits do not assess every vulnerability in its embedded SQLite engine. Release checks record the Node and SQLite versions separately.

The async API owns one SQLite worker and captures inputs before asynchronous admission, including encoded JSON, row lists, projections, include trees and open options. It enforces connection ownership, queue/pending bounds and worker deadlines. Worker errors carry safe codes rather than driver messages, values, paths or stacks. A lost response after send can have an unknown durable outcome: the session becomes unusable, requests close once and never replays a callback or invents a rollback. Reconcile saved data before retrying `COMMIT_UNCONFIRMED` or `EXECUTION_UNCONFIRMED` work. Cancelling a transaction drains admitted work; it is not a guarantee that an already running SQLite statement was interrupted.

Async trace exports use the last inspected schema snapshot. Error status alone is not proof of rollback; explicit notes and the recorded control statements explain uncertainty. Root and transaction contexts inherited from a finished callback are revoked. These are library contracts for trusted application code, not a sandbox for arbitrary JavaScript or a remotely exposed database service.

Model definitions, application code, the chosen database path and existing schema are trusted inputs. This library is not a sandbox for hostile JavaScript, a substitute for application authorization or a promise that every existing database file is safe. A read-only schema report can still reveal names, constraints and default values.

Stored JSON is checked for text size before parsing and for finite values, bounded depth and node count before materialization. Rejected stored values produce generic `DATA` errors. A valid SQLite JSON value can still exceed JavaScript's finite numeric range; it is refused rather than silently becoming `Infinity` or changing to `null` when serialized.

Transaction callbacks must be synchronous. Nested transactions use savepoints. Failed work is rolled back, callbacks are not automatically replayed, and an unrecoverable connection must not accept more writes. A successful database commit does not guarantee an HTTP client received its response; application code still needs a retry/idempotency policy.

Schema creation does not authorize a destructive migration. Unsupported schema changes are refused. Existing triggers, cascades, collations and application invariants need independent review before adopting a model. The schema report is not a complete recreation script.

## PostgreSQL and PGlite

These optional entries load their exact pinned peer only when opened, and refuse other versions. The core package has no required runtime dependency. Keep those peers updated within what Rowstitch supports, and watch their own advisories, since this package does not ship them.

The PostgreSQL entry never reads connection environment values or password files, and refuses a connection if the environment or changed client defaults alter an essential setting. Open failures use constant messages without the host, password or connection string. Traces contain no connection details.

**TLS is off by default.** Use `ssl: true`, `ssl: { ca }` or `sslmode=verify-full` for anything remote. These verify the server's certificate and host name, and no option disables that. Without them, passwords and data cross the network in clear text. Channel binding is not enforced. Client certificates were tested only with short-lived self-signed certificates.

Session settings are confirmed by the server once, at open, and are not rechecked per operation. Values stay bound and identifiers stay validated and quoted, including in PostgreSQL's created defaults, which render validated literals because that syntax cannot be bound.

Compiled native statements limit combined UTF-8 parameter payloads to 16 MiB, including writes, filters, relation keys and generated bounds. A larger statement is refused locally with constant `QUERY`; it is not sent. This is a stricter request limit introduced in 0.12, not a measurement of protocol framing or driver memory.

Native eager reads use multiple statements and do not create an implicit graph snapshot. Use an explicit writable transaction for SERIALIZABLE isolation; read-only mode alone does not provide it. Separate fetched-row and returned-copy budgets, response wire limits and per-operation accounting bound admitted graph work. Accounting units are not heap bytes and cannot prevent allocations a driver or parser makes first. The [native relation guide](docs/native-eager.md) gives exact limits, error codes and concurrency rules.

The database is a trusted input, not a sandbox. Roles, row-level security, triggers, rules, default expressions and CHECK constraints are honored but not verified by the library. A trigger can change returned values; a SECURITY DEFINER function runs with its owner's rights. `readOnly: true` is a transaction mode, not an authorization policy; use a restricted database role for that. Schema planning checks that a default exists, not its value, and it never alters an existing table. Compatible server versions from 12 are not refused, but only 18.6 is tested.

Reaching a client deadline abandons the connection and asks the server to cancel. The statement may still finish. Nothing is replayed.

PGlite here is in memory in a worker thread. It has no file option, and nothing persists after close, so no durability or file-sharing behavior is claimed. It is not isolation from your application's code and not a security boundary.

Captured `AbortSignal` options must be same-realm, extensible platform signals, and native methods are used directly. That bounds which objects are accepted. It is not a promise against code that tampers with private state or global prototypes.

## Inspector

The studio binds only to `127.0.0.1`, serves a fixed asset allowlist and a fictional demo, and has no SQL, database-path, upload or mutation endpoint. It checks Host/Origin and request framing, applies response policies and bounds connections, headers and output. Do not expose it with a public tunnel or reverse proxy.

Trace imports are parsed and displayed in browser memory. Imported SQL is never executed. No browser storage, remote scripts, external fonts, analytics or AI provider is used. Initial installation still downloads development packages; a hosted static copy can have hosting access logs.

Traces are bounded and hide bound values by default. They do not retain result rows or raw database errors. SQL text, identifiers, titles and literal defaults may still contain sensitive information. Redaction is not anonymization. A trace may name its database dialect; a trace that does not is read as legacy SQLite. Explicit exports preserve the trace you loaded; review them before sharing. Clear removes the current view and file reference, not operating-system or browser memory caches.

Opting into `traceValues: true` can expose internally fetched relationship keys, even if those keys were excluded from selected output. Field selection is not an authorization or trace-redaction policy.

Transaction-effect labels are bounded interpretations of the imported statement order. They are not authenticated evidence of a commit, the current database state or an application's success. A modified trace can misrepresent those outcomes without executing any SQL.

These protections address tested cases. They are not a universal security certification or a guarantee of forensic erasure.
