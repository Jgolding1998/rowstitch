# Orange ORM coverage and independent roadmap

Rowstitch is being implemented independently toward broader Orange ORM functionality. **It is not currently a drop-in replacement for Orange ORM, and full compatibility has not been achieved.** The current candidate covers a tested part of SQLite data access. Other databases, Active Record graph persistence, asynchronous transactions and a remote ORM client remain substantial work.

This document keeps that larger goal explicit. A missing feature below is work to evaluate and implement, rather than a permanent exclusion from the project. The read-only Studio remains separate from any future opt-in database server.

## Reference and evidence

The reference is **Orange ORM 5.5.1**, whose npm `gitHead` is [52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1](https://github.com/alfateam/orange-orm/tree/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1). Its published source entry, type declarations, runtime selector and Node SQLite provider match the inspected checkout. The reviewed public surface includes its [README](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/README.md), [mapping declarations](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/map.d.ts), [client declarations](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/map2.d.ts), provider implementations and corresponding tests.

Orange's published CommonJS source and ESM bundle both select Node's SQLite backend on the verified Node 24.22.2 runtime. Direct SQL probes report SQLite **3.53.4** for Orange and Rowstitch; the pinned Kysely comparison uses better-sqlite3 12.6.2 with SQLite **3.51.2**. Installing a native driver does not establish that Orange used it. The [comparison runner](../benchmarks/README.md) records actual backend versions and query counts, not a speed ranking.

The upstream runtime/database matrix is advertised support, not proof that every listed combination was independently reproduced here. The shared local comparison covers SQLite only. Closed upstream bugs are used as regression ideas; they are not presented as current defects.

Status meanings:

- **Implemented** means an independently implemented capability with current tests, within Rowstitch's documented bounds. It does not mean the same Orange method names or exact semantics.
- **Partial** means useful overlapping behavior with significant differences or missing cases.
- **Missing** means no accepted implementation yet.
- **In progress** means code or tests are being developed; it must pass its acceptance checks before becoming Implemented.

## Databases, runtimes and API shape

| Capability in Orange 5.5.1 | Current Rowstitch status | Coverage required before a compatibility claim |
| --- | --- | --- |
| SQLite on current Node | Implemented | Real file and in-memory CRUD, constraints, rollback, precision and packaged-consumer tests. Current Node 24 LTS is required. |
| SQLite on older supported Node through a native driver | Missing | A versioned adapter and actual runtime tests; do not silently disable defensive features on an older Node release. |
| PostgreSQL | Missing | An independent dialect/driver adapter, live database tests and transaction/encoding tests. |
| PGlite, including browser use | Missing | Tests against the actual embedded engine and a browser build without Node-only imports. |
| MySQL | Missing | Live MySQL tests, parameter/identifier syntax, JSON, precision and conflict behavior. |
| MariaDB | Missing | Its own live integration cases; MySQL results do not prove MariaDB compatibility. |
| SQL Server through tedious and the native provider | Missing | Both intended adapters tested, including affected-row results, parameter limits and locking semantics. |
| Oracle | Missing | Live provider tests for binds, generated keys, JSON, dates, binary values and transactions. |
| SAP ASE | Missing | Actual server tests, including textual JSON concurrency and database-specific limits. |
| Cloudflare D1 | Missing | Worker integration and explicit capability tests. Orange documents that its general transaction callback is not supported for D1. |
| Bun and Deno | Missing | Real runtime suites and package-resolution tests; a Node pass is not a Bun/Deno pass. |
| CommonJS, ESM and browser package conditions | Partial | Rowstitch currently exposes an ESM Node SDK. CommonJS and a browser ORM client need separate installed-package tests. |
| Orange's `map(...).map(...)` schema DSL and legacy table API | Missing | An independently authored compatibility facade, explicit version scope and positive/negative TypeScript contract tests. |
| Promise-returning database/client operations | Missing | An asynchronous driver boundary and clear transaction ownership, without breaking the synchronous SQLite API. |

## Mapping, values and types

| Capability in Orange 5.5.1 | Current Rowstitch status | Difference or acceptance check |
| --- | --- | --- |
| Typed JavaScript/TypeScript table and column mappings without mandatory code generation | Implemented | Rowstitch uses `defineTable` and `column`; it is a different API. Test the installed declarations and runtime together. |
| Text, numeric, boolean and typed JSON values | Partial | Rowstitch has text, safe integer, real, boolean and JSON codecs. Orange's cross-dialect numeric behavior and complete JSON update API are broader. |
| Large integers | Implemented | Rowstitch's dedicated bigint column round-trips signed int64. Mixed integer/bigint relationship keys are tested without precision loss. Cross-driver representations still need validation. |
| UUID, date, timezone-aware date and binary column types | Missing | Dedicated codecs, exact stored/read representations, generated values and timezone/binary regressions. Treating every value as text is not parity. |
| Required, nullable, generated and defaulted insert fields | Implemented | Tests distinguish insert requirements from fetched values. Orange's `notNullExceptInsert` API is not exposed under that name. |
| Literal and callback defaults | Partial | Literal defaults are supported. Callback defaults and provider-specific default semantics need tests. |
| Property names mapped to different database column names | Missing | Preserve aliases in filtering, projection, writes, relationship keys and returned types. |
| Custom validation, validation metadata and AJV JSON schemas | Missing | Finite JSON validation and TypeScript generics do not validate an application's complete JSON shape. |
| Typed enums | Missing | Runtime rejection and literal-union inference for arrays, enum objects and all supported scalar kinds. |
| Custom database null sentinels | Missing | Test codecs and conflict comparisons for sentinel values instead of assuming SQL NULL semantics. |
| `serializable(false)` and table/column readonly policy | Partial | Rowstitch has a read-only connection and non-editable keys/version fields. Per-field serialization and layered write policies are not implemented. |
| Composite primary keys | Partial | Composite root keys and guarded version updates are supported. Multi-column foreign keys/relationship joins need implementation and tests. |
| Cyclic/self-referential mapping definitions | Missing | A deliberate deferred-definition contract and actual cyclic graph cases, not accidental mutable table definitions. |
| Column and formula discriminators | Missing | Apply discriminators consistently to roots, joins, reads and mutations, including explicit bypass behavior. |

## Reads, relationships and filters

| Capability in Orange 5.5.1 | Current Rowstitch status | Difference or acceptance check |
| --- | --- | --- |
| Many-row reads, a first row, filtering, ordering, root limit and offset | Implemented | Rowstitch's `findMany`/`findFirst` return plain rows synchronously. Orange's `getMany`/`getOne`/`getById` contracts differ, including missing-row results. |
| Direct primary-key and multiple-primary-key convenience methods | Partial | Keys can be expressed with typed predicates. Orange's exact method overloads and array-of-key strategies are not provided. |
| Batched hasMany reads and empty child arrays | Implemented | The fixed 41-parent/120-child graph uses two SELECTs in both Rowstitch and Orange. This is batching parity on that fixture. |
| Per-parent child ordering, limit and offset | Implemented | The SQLite loader uses bounded batched window queries and deterministic ordering. More complex provider-specific behavior remains unverified. |
| Typed hasOne and references/belongsTo eager reads | Implemented | SQLite batch reads return object or null, enforce singular cardinality and support nested includes. The common 120-post reference fixture passes; Rowstitch uses two SELECTs while Orange uses one joined SELECT. This does not establish complete strategy or driver parity. |
| Selected columns on roots and relations | Implemented | SQLite runtime and type checks return selected fields while keeping join keys internal. Orange deliberately retains primary keys for its Active Record results; that is a behavioral difference, not an upstream bug. Orange's full selection/alias/exclusion DSL is not reproduced. |
| Nested graph fetch strategies | Partial | Bounded hasMany, hasOne and belongsTo reads are tested. Compound relationship keys, lexical ad-hoc scopes and the complete Orange strategy contract are still missing. |
| Ad-hoc `many`/`one` descriptors with lexical current/root references | Missing | Typed correlated scopes, nested descriptors, pagination, aliases and readonly result semantics. |
| Equality, inequality, comparison, IN, NULL, AND/OR/NOT | Implemented | Use explicit NULL/empty-IN truth tables and bound inputs. Orange's callback/filter object API differs. |
| Between, string contains/prefix/suffix and case-insensitive variants | Missing | Bound escaping and case/collation behavior tested on each dialect. |
| Column-to-column comparisons and relationship-path filters | Missing | Typed reference expressions and correct aliases across nested queries. |
| `exists`, relation `any`/`all`/`none` and filtered relation counts | Missing | Test empty relations, NULL values and correlated predicates, including vacuous truth for `all`. |
| Per-row and root aggregates: sum, average, min, max and count | Partial | A root filtered count is implemented. The aggregate selector DSL and related-row aggregates are missing. |
| Distinct/grouped aggregate results and aggregate ordering | Missing | Grouping, result types, NULL/empty groups, selected aliases and deterministic ordering. |
| Raw SQL queries and raw filters through a trusted SDK | Missing | A reviewed explicit SDK capability is planned. It must not make imported traces executable or expose raw SQL through Studio. |
| SQLite user-defined functions | Missing | Define connection lifetime, codec rules and synchronous/asynchronous support per runtime. |

## Mutations, state and transactions

| Capability in Orange 5.5.1 | Current Rowstitch status | Difference or acceptance check |
| --- | --- | --- |
| Single/bulk inserts and updates/deletes selected by a filter | Implemented | Rowstitch imposes meaningful-filter and direct-row limits. Missing or provably unrestricted write filters are refused; harmless false filters may match zero rows. |
| Nested graph insert/update/delete and ownership cascades | Missing | A unit of work must order foreign-key operations, preserve unrelated rows, roll back the entire graph and handle generated keys. SQLite foreign-key cascade alone is not Orange graph-write parity. |
| Active Record rows/arrays with `saveChanges`, refresh, accept/clear changes | Missing | Original snapshots, dirty tracking, graph changes and commit/rollback state transitions must be independently implemented. Plain row objects plus repository updates are not equivalent. |
| JSON replace, `updateChanges`, JSON Patch and proxify | Missing | Define omission versus null, structural equality, JSON path mutation and atomic conflict checks. Force a real write in regressions. |
| Insert-and-forget and upsert/conflict strategies | Missing | No-return inserts, overwrite and skip-on-conflict behavior must be tested rather than approximated with ordinary insert/update calls. |
| Default property-level optimistic concurrency | Partial | Rowstitch has explicit atomic version-token updates. A whole-row version token is different from Orange's old-value checks on edited properties and requires a mapped version column. |
| Overwrite/skipOnConflict settings at database, table and column levels | Missing | Test mixed policies without accidentally overwriting a conflicting field or committing only part of an intended atomic graph. |
| Batch delete by keys and graph-aware deleteCascade | Partial | Root filter deletes and configured SQLite FK cascades work. Orange's complete batch-key and owned-graph deletion APIs are missing. |
| Commit/rollback and returned transaction values | Partial | Synchronous SQLite callbacks, nested savepoints and revoked escaped handles are tested. Orange permits asynchronous callbacks; Rowstitch currently rejects them. |
| Readonly operation modes and isolation/locking capabilities | Partial | SQLite readonly connections and immediate write transactions are available. Dialect-specific isolation and row locking require adapters and tests. |
| `forUpdate` / `skipLocked` where supported | Missing | SQLite does not provide those row-lock statements. Unsupported dialects must reject clearly, not simulate a guarantee they cannot supply. |
| Connection pools, provider options and closing resources | Partial | Rowstitch currently owns one synchronous SQLite connection. Async pool acquisition, release, cancellation and shutdown need a separate tested lifecycle. |

## Browser, server and developer tooling

| Capability in Orange 5.5.1 | Current Rowstitch status | Difference or acceptance check |
| --- | --- | --- |
| Browser ORM client and HTTP query/mutation protocol | Missing | A future explicitly enabled client/server package needs bounded protocol validation and versioned contracts. The current Studio cannot execute queries or mutations. |
| Express and Hono server adapters | Missing | Test actual framework requests, allowed operations, exposed tables, errors, body limits and transaction boundaries. |
| Request/response interceptors | Missing | Preserve asynchronous completion and error behavior, without leaking credentials or retrying uncertain writes automatically. |
| Per-request base filters, lifecycle hooks and RLS integration | Missing | Authenticate first, apply mandatory filters to nested reads/writes, scope database roles to the transaction and distinguish after-commit failure from rollback. These do not appear automatically by adding an ORM endpoint. |
| Generated remote metadata/type declarations | Missing | Correct names, readonly/serialization policy and installed TypeScript clients; no private credentials in browser bundles. |
| Query events/logging | Partial | Rowstitch provides per-connection bounded traces with values redacted by default. Orange has its own SQL/parameter event API. |
| Visual query/plan inspector and trace-file viewer | Implemented | An independent Rowstitch tool. It is read-only, local and separate from a future remote ORM transport. Imported SQL is never executed. |
| Readonly database introspection and additive schema planning | Implemented | A Rowstitch capability with explicit bounds. It is not a complete database-to-model generator or a migration history runner. Orange's reverse-engineering request remains an upstream open item. |
| Destructive migration generation/history | Missing | This is not an Orange 5.5.1 parity requirement: its README explicitly excludes migrations. Any future migration tool needs its own reviewed design. |
| Agent integration instructions | Partial | Rowstitch ships instructions. Orange also links a Context7 documentation resource; that is not the same as shipping an operational MCP database server. |

## Independent implementation sequence and acceptance gates

1. **SQLite read milestone accepted within its stated scope.** Typed singular eager relations and selected columns now pass runtime/type checks, including missing children, duplicate matches, nested includes and hidden-key projection. The shared reference/projection cases also pass against the pinned Orange package, with the measured contract/query-count differences recorded above. This completes the current read milestone, not the full compatibility goal.
2. **SQLite compiler milestone accepted within its stated scope.** Structured plans and pure SQL compilation are separated from execution. The existing synchronous API, SQL/parameter contracts, guards and traces are preserved. A 147-scenario comparison against v0.1.0 found 145 exact matches and two deliberate earlier rejections of a NUL character in a schema default; ordinary bound NUL values still work. New compiler tests cover generated predicates and malformed inputs. Values in these plans are still SQLite-encoded, so another database requires its own codecs and tested compiler. This is preparation for more dialects, not multi-database support.
3. **Expand read-side expressions on that boundary.** Add string/column/relation predicates, aggregates and grouping. Differential fixtures must cover NULL, empty sets, aliases, collation and deterministic pagination. A SQL string that looks correct is not sufficient evidence.
4. **Validate a separate asynchronous driver interface on SQLite.** Prove transaction pinning, awaited completion, nested savepoints, cancellation, connection cleanup and shared conformance before introducing network behavior. Keep the existing synchronous API usable. Optional driver packages can depend on established clients without making those clients dependencies of the SQLite core.
5. **Test a PostgreSQL dialect in two distinct environments.** PGlite can validate real parser/planner and codec behavior in process; label those results PGlite-validated. Then use a real PostgreSQL server to verify independent sessions, pools, isolation, roles, errors and network failure. PGlite success is not PostgreSQL server parity. A lost network COMMIT response may have an unknown outcome: future async errors/traces need an explicit not-confirmed state and must not automatically replay the callback.
6. **Build graph persistence after a second real engine validates the design.** Add original snapshots, change tracking, generated-key propagation, compound relationships, graph diff/patch and configured concurrency policies. The pure planner can be prototyped earlier, but acceptance must cover SQLite and the real second engine. Test persisted rows after reopen, failures halfway through a graph, and rollback without accepting an uncommitted snapshot.
7. **Add the remaining actual engines, then broaden runtimes.** Validate MySQL and MariaDB separately, followed by SQL Server and the remaining database families. Verify Bun, Deno, workers, browser/PGlite and CommonJS with actual installed packages and appropriate engines. Declare unsupported capabilities explicitly, including D1 transaction differences. Merely adding a dialect name or rendering SQL does not count as support.
8. **Add an opt-in remote ORM surface separately.** Preserve the current Studio's read-only boundary. Design authentication integration, mandatory filters, serialization/write policy, bounded request graphs, safe errors, transaction hooks and uncertain-commit handling before exposing any mutation route.
9. **Measure compatibility as a versioned contract throughout.** Maintain a feature-by-feature acceptance suite and positive/negative TypeScript consumers against Orange 5.5.1. Keep deliberate safer defaults documented rather than describing them as identical behavior. Broader speed or security claims require their own controlled evidence.

The larger goal is independent functional coverage with useful improvements. The current evidence supports the implemented SQLite subset and inspector; it does not support saying that Rowstitch already does everything Orange can do and more.
