# Driver boundary

Rowstitch provides `openDatabase` for synchronous SQLite operations and `await openAsyncDatabase` for operations executed in one background worker. Both use the same repository planning, validation, codecs, SQL compiler and decoders. The worker moves SQLite execution off the calling thread; planning, decoding and trace export still run there. No runtime npm dependency is added.

Await schema operations, CRUD, relation reads, counts, aggregates, explain and close on the async API. `table()`, compile methods, `clearTrace()` and `exportTrace()` are synchronous. See [the async example](../examples/async.mjs). The internal transaction session, worker transport and inline conformance adapter are not SDK extension points or raw-SQL capabilities.

Input records, encoded JSON, row lists, selected fields, include trees and open options are captured before the first await. Table and relationship identities retain their genuine brands. Changing caller-owned inputs after a call cannot change its saved values or expose a hidden fetched field.

## Transaction ownership

The session serializes driver calls and pins a transaction to its connection. Unrelated work waits in a bounded FIFO. A root or ancestor handle used inside a transaction is rejected with guidance to use the callback's handle, preventing a deadlock. One nested savepoint may be active per parent; sibling calls and parent use while a child is active are refused before SQL is sent.

Await each write inside the callback, or use `insertMany`. Each write has its own atomic scope, so two writes started concurrently inside the same transaction would overlap savepoints and are refused. Concurrent reads are allowed; writes started outside the transaction queue separately. A handle or root context inherited from a finished callback is revoked, including for pure compilation.

When a callback settles with statements or a child transaction still pending, the session invalidates its handle, drains issued work and rolls back. It never commits after silently draining unfinished work. It can detect promises still pending at settlement; it cannot prove whether already-settled promises were awaited.

Pass `{signal}` to `transaction(callback, options)` to cancel a transaction. Repository methods do not currently take an operation signal. Internally, queued cancellation sends no SQL, and statements are checked again before send. Cancelling admitted transaction work stops admission, drains issued work and rolls back. An autocommit statement already sent to the driver is allowed to finish and its actual result stands. An acknowledged COMMIT wins over a late abort. No forced statement interruption is promised.

A request whose signal is already aborted is rejected before admission. This applies equally to a statement and to a new child transaction; the parent can catch that rejection and continue. Once admitted, a statement's signal controls its owning transaction, and a child's signal controls that child. Statement results inside a transaction remain provisional until the transaction promise resolves. An issued statement may return rows that are later rolled back. A cancelled statement waiting on serialization rejects when its turn arrives; earlier issued work may delay that rejection.

Defaults are 64 queued root operations, 256 pending statements, a 10-second queue timeout, a 30-second worker-request deadline and at most 32 nested transaction levels. `maxQueue` and `maxPending` accept 1–1024; `queueTimeoutMs` accepts 1–60,000 and `requestTimeoutMs` accepts 1–120,000. A worker deadline or exit after send leaves the outcome unconfirmed. These limits do not guarantee a query's cost; index related keys and inspect plans on realistic data.

## Errors and uncertain outcomes

A definite engine rejection is distinct from a lost acknowledgment. The inline adapter brands and sanitizes known engine errors. An acknowledgment means the engine returned a response; earlier statements in a batch may already have had effects. The transaction session generates individual control statements through the compiler. Arbitrary SQL and scripts are not accepted through Studio or a public async API.

If COMMIT was sent and its acknowledgment is lost, the session raises `COMMIT_UNCONFIRMED`, becomes unusable and requests close once. It does not infer rollback or replay the callback. A later `inTransaction() === false` would not distinguish commit from rollback. Other unconfirmed driver operations likewise make the connection unusable. Cleanup preserves the callback's original error when possible and reports unusability without claiming that a failed close succeeded.

Async exports remain trace format version 1. They use the schema last inspected at open, `inspectSchema()` or `ensureSchema()`; the notes state its capture time. Exporting performs no database I/O. A request error can be either a definite rejection or an unconfirmed outcome, and notes state the uncertainty. Studio marks a failed COMMIT without a subsequent recorded rollback as an unknown write effect. It does not establish the current database state. Schema names and SQL literals may still be sensitive even with redacted values.

## Evidence and remaining work

The conformance tests use real SQLite files checked after reopen, plus an adapter that can delay calls and hide acknowledgments. They exercise connection serialization, nested rollback, escaped contexts, cancellation, unfinished work, definite COMMIT failure and an applied-but-unconfirmed COMMIT. A deliberately naive session is required to fail the ownership probes. Independent adversarial tests cover cancellation during serialization and cleanup failures. The synchronous public SDK is compared with the installed 0.8.0 release by `benchmarks/executor.mjs`.

PostgreSQL/PGlite compilers and codecs, real server pools and network behavior, other database drivers, and a public driver extension API remain separate work. Direct engine preparation is not Rowstitch driver support. PGlite integration validation will be labelled explicitly; it cannot prove PostgreSQL pool, session or network behavior. The [compatibility matrix](compatibility.md) records the full scope still outstanding.

Node's contracts informed this design: [SQLite documentation](https://nodejs.org/api/sqlite.html), [AsyncLocalStorage documentation](https://nodejs.org/api/async_context.html), [worker threads documentation](https://nodejs.org/api/worker_threads.html).
