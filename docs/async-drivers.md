# Driver boundary

Rowstitch provides `openDatabase` for synchronous SQLite operations and `await openAsyncDatabase` for operations executed in one background worker. Both use the same repository planning, validation, codecs, SQL compiler and decoders. The worker moves SQLite execution off the calling thread; planning, decoding and trace export still run there. No runtime npm dependency is added.

The worker loads compiled JavaScript from a file and does not explicitly forward the parent process's command-line arguments. Module eval and stdin entry points work without passing their `--input-type` flag to the file worker. Parent CLI loader, preload and debugger arguments are not forwarded through this API. Node's normal worker runtime and environment behaviour still applies; this is not an isolated process or sandbox.

Await schema operations, CRUD, relation reads, counts, aggregates, explain and close on the async API. `table()`, compile methods, `clearTrace()` and `exportTrace()` are synchronous. See [the async example](../examples/async.mjs). The internal transaction session, worker transport and inline conformance adapter are not SDK extension points or raw-SQL capabilities.

Input records, encoded JSON, row lists, selected fields, include trees and open options are captured before the first await. Table and relationship identities retain their genuine brands. Changing caller-owned inputs after a call cannot change its saved values or expose a hidden fetched field.

## Transaction ownership

The session serializes driver calls and pins a transaction to its connection. Unrelated work waits in a bounded FIFO. A root or ancestor handle used inside a transaction is rejected with guidance to use the callback's handle, preventing a deadlock. One nested savepoint may be active per parent; sibling calls and parent use while a child is active are refused before SQL is sent.

Await each write inside the callback, or use `insertMany`. Each write has its own atomic scope, so two writes started concurrently inside the same transaction would overlap savepoints and are refused. Concurrent reads are allowed; writes started outside the transaction queue separately. A handle or root context inherited from a finished callback is revoked, including for pure compilation.

When a callback settles with an operation or a child transaction still pending, the session invalidates its handle, drains issued work, rolls back and rejects the transaction with `TRANSACTION_PENDING`. It never commits after silently draining unfinished work. A forgotten operation that was still pending is reported through that rejection, so it does not also become an unhandled rejection. Promises that have already settled cannot be classified: an un-awaited operation that succeeded before the callback settled stays in the transaction, and one that already failed is reported by Node like any other unhandled rejection, which ends the process under its default policy. Operations started on a handle after its transaction has finished are also reported normally.

Callbacks can return ordinary values, promises or `PromiseLike` results. A lazy thenable is adopted inside its transaction context. The settled top-level value must be deliverable without running more code: a Proxy, an accessor or function named `then`, or an uninspectable or overlong prototype chain is refused with `VALIDATION` before COMMIT or RELEASE. Normal objects keep their identity and are not frozen or changed. A non-callable data field such as `{then: 'stored text'}` is allowed. Return a plain copy or wrap a reactive value in an ordinary record when needed.

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

## Evidence and remaining work

The conformance tests use real SQLite files checked after reopen, plus an adapter that can delay calls and hide acknowledgments. They exercise connection serialization, nested rollback, escaped contexts, cancellation, unfinished work, definite COMMIT failure and an applied-but-unconfirmed COMMIT. A deliberately naive session is required to fail the ownership probes. Independent adversarial tests cover cancellation during serialization and cleanup failures. The synchronous public SDK is compared with the installed 0.8.0 release by `benchmarks/executor.mjs`.

PostgreSQL/PGlite compilers and codecs, real server pools and network behavior, other database drivers, and a public driver extension API remain separate work. Direct engine preparation is not Rowstitch driver support. PGlite integration validation will be labelled explicitly; it cannot prove PostgreSQL pool, session or network behavior. The [compatibility matrix](compatibility.md) records the full scope still outstanding.

Node's contracts informed this design: [SQLite documentation](https://nodejs.org/api/sqlite.html), [AsyncLocalStorage documentation](https://nodejs.org/api/async_context.html), [worker threads documentation](https://nodejs.org/api/worker_threads.html).
