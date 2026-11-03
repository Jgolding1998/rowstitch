# Driver boundary

The synchronous SQLite ORM now executes through a private connection interface. Opening, schema metadata, bound queries, transaction control, transaction-state checks and close all use the same owned connection. The public SDK and Studio continue to use the synchronous API.

The source also contains an internal asynchronous transaction session. It is preparation for Promise-returning repositories and additional drivers. It is not exported from `rowstitch`; applications should keep using the documented SDK. The inline SQLite adapter used in its tests executes on the calling thread. It does not make SQLite work nonblocking.

## Transaction ownership

The session serializes driver calls and pins a transaction to its connection. Unrelated work waits in a bounded FIFO. A root or ancestor handle used inside a transaction is rejected with guidance to use the callback's handle, preventing a deadlock. One nested savepoint may be active per parent; sibling calls and parent use while a child is active are refused before SQL is sent.

When a callback settles with statements or a child transaction still pending, the session invalidates its handle, drains issued work and rolls back. It never commits after silently draining unfinished work. It can detect promises still pending at settlement; it cannot prove whether already-settled promises were awaited.

Queued cancellation sends no SQL. A statement waiting on connection serialization is checked again immediately before the driver is called. Cancelling an issued transaction statement stops admission, drains issued work and rolls back. An autocommit statement already sent to the driver is allowed to finish and its actual result stands. An acknowledged COMMIT wins over a late abort. No forced statement interruption is promised.

A request whose signal is already aborted is rejected before admission. This applies equally to a statement and to a new child transaction; the parent can catch that rejection and continue. Once admitted, a statement's signal controls its owning transaction, and a child's signal controls that child. Statement results inside a transaction remain provisional until the transaction promise resolves. An issued statement may return rows that are later rolled back. A cancelled statement waiting on serialization rejects when its turn arrives; earlier issued work may delay that rejection.

Defaults are 64 queued root operations, 256 pending statements, a 10-second queue timeout and at most 32 nested transaction levels. The configured limits and each transaction's lifetime are checked independently of SQL compilation.

## Errors and uncertain outcomes

A definite engine rejection is distinct from a lost acknowledgment. The inline adapter brands and sanitizes known engine errors. An acknowledgment means the engine returned a response; earlier statements in a batch may already have had effects. The transaction session generates individual control statements through the compiler. Arbitrary SQL and scripts are not accepted through Studio or a public async API.

If COMMIT was sent and its acknowledgment is lost, the session raises `COMMIT_UNCONFIRMED`, becomes unusable and requests close once. It does not infer rollback or replay the callback. A later `inTransaction() === false` would not distinguish commit from rollback. Other unconfirmed driver operations likewise make the connection unusable. Cleanup preserves the callback's original error when possible and reports unusability without claiming that a failed close succeeded.

The current trace format and Studio have no new async outcome format. Integration of uncertain outcomes into traces, validation and the interface must be tested before a public async API is released.

## Evidence and remaining work

The conformance tests use real SQLite files checked after reopen, plus an adapter that can delay calls and hide acknowledgments. They exercise connection serialization, nested rollback, escaped contexts, cancellation, unfinished work, definite COMMIT failure and an applied-but-unconfirmed COMMIT. A deliberately naive session is required to fail the ownership probes. Independent adversarial tests cover cancellation during serialization and cleanup failures. The synchronous public SDK is compared with the installed 0.8.0 release by `benchmarks/executor.mjs`.

The public awaitable repository API, worker transport, PostgreSQL/PGlite compilers and codecs, real server behavior and other database drivers remain separate work. PGlite validation will be labelled explicitly; it cannot prove PostgreSQL pool, session or network behavior. The [compatibility matrix](compatibility.md) records the full scope still outstanding.

Node's synchronous SQLite connection and asynchronous context tracking contracts informed this design: [SQLite documentation](https://nodejs.org/api/sqlite.html), [AsyncLocalStorage documentation](https://nodejs.org/api/async_context.html).
