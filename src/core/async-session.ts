/**
 * Internal asynchronous transaction session over an AsyncExecutor. Not exported from the SDK, not a raw-SQL API and not
 * a claim of nonblocking I/O: with inlineAsyncExecutor the SQLite work still runs on the calling thread.
 *
 * SQL passed here must be trusted, internally compiled text. Values are always bound.
 *
 * Contract summary (see tests/async-session.test.mjs):
 * - Every executor call (statements, transaction control, state checks, close) is serialized on one connection.
 * - Root work from outside an active transaction waits in a bounded FIFO (maxQueue, queueTimeoutMs, AbortSignal).
 * - Root or ancestor handles used from inside an active transaction context are rejected immediately.
 * - One nested child at a time; sibling, parent and pending-parent misuse are rejected before any SQL.
 * - When a callback settles with issued work still pending (or an active child), its lease is invalidated, the work is
 *   drained and the transaction is rolled back. It is never committed after draining. Promises that already settled
 *   un-awaited cannot be detected.
 * - A rejection that is not a branded acknowledged engine rejection leaves the outcome unknown: the session is poisoned
 *   and its connection closed once. COMMIT_UNCONFIRMED never implies rollback and the callback is never replayed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { RowstitchError } from './errors.js';
import { isAcknowledgedRejection, type AsyncExecutor, type ExecutorRows } from './executor.js';
import { MAX_BOUND_PARAMETERS, queryModel, type TransactionAction } from './query-model.js';
import { compileSqlite } from './sqlite-compiler.js';
import { compilePostgresControl } from './postgres-control.js';
import type { Parameter } from './schema.js';

/**
 * Internal trace hook. Called once per transaction-control statement after its outcome is known, before the lifecycle
 * continues. `handle` identifies the frame. 'rejected' is an acknowledged engine rejection; 'unconfirmed' means the
 * statement's effect is unknown (never evidence of rollback). Observer exceptions are ignored.
 */
export interface AsyncControlEvent {
  readonly handle: AsyncTransaction; readonly action: TransactionAction; readonly sql: string;
  readonly outcome: 'ok' | 'rejected' | 'unconfirmed'; readonly startedAt: number;
}
export interface AsyncSessionObserver { control(event: AsyncControlEvent): void }
export interface AsyncSessionOptions {
  /** Trusted internal engine selection; not a public database option or raw-SQL hook. */
  readonly dialect?: 'sqlite' | 'postgresql';
  readonly observer?: AsyncSessionObserver;
  readonly readOnly?: boolean;
  readonly maxQueue?: number;
  readonly maxPending?: number;
  readonly queueTimeoutMs?: number;
}
export interface AsyncOperationOptions { readonly signal?: AbortSignal }
export interface AsyncTransaction {
  all(sql: string, parameters?: readonly Parameter[], options?: AsyncOperationOptions): Promise<ExecutorRows>;
  transaction<R>(callback: (tx: AsyncTransaction) => R | PromiseLike<R>, options?: AsyncOperationOptions): Promise<Awaited<R>>;
}
export interface AsyncSession extends AsyncTransaction {
  close(): Promise<void>;
}

export const ASYNC_SESSION_LIMITS = Object.freeze({
  maxDepth: 32, defaultQueue: 64, defaultPending: 256, defaultQueueTimeoutMs: 10_000,
  queue: [1, 1024] as const, pending: [1, 1024] as const, queueTimeoutMs: [1, 60_000] as const,
});

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  VALIDATION: 'The async session received an invalid argument.',
  ABORTED: 'The operation was aborted. Work that had not started sent no SQL.',
  QUEUE_FULL: 'Too many operations are waiting for this connection.',
  QUEUE_TIMEOUT: 'The operation waited too long for this connection and sent no SQL.',
  PENDING_LIMIT: 'Too many statements are already pending on this session.',
  CLOSED: 'This async session is closed.',
  CONNECTION_UNUSABLE: 'This session is unusable after an unconfirmed operation or failed cleanup. Open a new connection.',
  EXECUTION_UNCONFIRMED: 'The database did not confirm whether this operation ran. The session was closed; inspect the data before retrying.',
  COMMIT_UNCONFIRMED: 'The database did not confirm whether COMMIT succeeded. The session was closed; nothing was rolled back or replayed automatically.',
  CLOSE_FAILED: 'The database connection could not be closed cleanly.',
  TRANSACTION_ACTIVE: 'A transaction is active in this context. Use the transaction handle passed to the callback.',
  TRANSACTION_CLOSED: 'This transaction has finished; its handle and context cannot be reused.',
  TRANSACTION_CONTEXT: 'This transaction handle belongs to another callback context.',
  TRANSACTION_PENDING: 'The transaction callback finished while its work was still pending. That work was drained and rolled back.',
  TRANSACTION_DEPTH: 'Transactions can be nested at most 32 levels deep.',
  NESTED_SIBLING: 'Only one nested transaction can be active at a time. Await it before starting another.',
  NESTED_PARENT: 'A nested transaction is active. Use its handle until it finishes.',
  NESTED_PENDING: 'Await this transaction\'s pending statements before starting a nested transaction.',
  SESSION_ACTIVE: 'Close the session after its transactions and queued work finish.',
});

/** Codes are public-safe constants; the message never includes SQL, values, stacks or paths. */
function failure(code: string, detail?: string): RowstitchError {
  const key = detail ?? code;
  return new RowstitchError(code, MESSAGES[key] ?? MESSAGES[code] ?? 'The async session could not complete this operation.');
}
const noop = (): void => {};

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

type Phase = 'starting' | 'running' | 'settling' | 'done';
interface Frame {
  readonly parent: Frame | null;
  readonly depth: number;
  readonly savepoint: string | null;
  active: boolean;
  closedCode: string;
  phase: Phase;
  child: Frame | null;
  doomed: boolean;
  abortRequested: boolean;
  /** Settle-only markers for every executor operation issued on behalf of this frame. */
  readonly issued: Set<Promise<void>>;
  /** User-visible statement promises still pending, so a TRANSACTION_PENDING drain does not add unhandled rejections. */
  readonly userPending: Set<Promise<unknown>>;
  readonly interrupt: Deferred<'abort' | 'doom'>;
  handle: AsyncTransaction;
}

interface QueueEntry { start(): void; fail(error: unknown): void }

const OPTION_KEYS = new Set(['readOnly', 'maxQueue', 'maxPending', 'queueTimeoutMs', 'observer', 'dialect']);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function integerOption(options: Record<string, unknown>, key: string, fallback: number, [min, max]: readonly [number, number]): number {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw failure('VALIDATION');
  return value;
}
function operationSignal(options: unknown): AbortSignal | undefined {
  if (options === undefined) return undefined;
  if (!plainObject(options) || Object.keys(options).some(key => key !== 'signal')) throw failure('VALIDATION');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('VALIDATION');
  return signal;
}
function captureSql(sql: unknown): string {
  if (typeof sql !== 'string' || !sql.length) throw failure('VALIDATION');
  return sql;
}
/** Copies parameters synchronously, before any queueing, so later caller mutation cannot change bound values. */
function captureParameters(parameters: unknown): readonly Parameter[] {
  if (parameters === undefined) return Object.freeze([]);
  let copy: unknown[];
  try {
    if (!Array.isArray(parameters) || parameters.length > MAX_BOUND_PARAMETERS) throw failure('VALIDATION');
    copy = Array.from(parameters);
  } catch { throw failure('VALIDATION'); }
  for (const value of copy) {
    if (!(value === null || typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value))) throw failure('VALIDATION');
  }
  return Object.freeze(copy as Parameter[]);
}
function controlSql(dialect: 'sqlite' | 'postgresql', action: TransactionAction, name?: string): string {
  const model = queryModel.transaction({ action, ...(name === undefined ? {} : { name }) });
  return dialect === 'postgresql' ? compilePostgresControl(model) : compileSqlite(model).sql;
}
/** Adds safe cleanup metadata to an extensible original error; frozen or primitive errors are returned unchanged. */
function withCleanup(error: unknown, code: string): unknown {
  try {
    if (error !== null && typeof error === 'object' && Object.isExtensible(error))
      Object.defineProperty(error, 'rowstitchCleanup', { value: Object.freeze({ code, connectionUnusable: true, closeRequested: true }), enumerable: false });
  } catch { /* Reflection on a callback's thrown value must not replace that original error. */ }
  return error;
}

class Session {
  readonly #executor: Readonly<{ all: AsyncExecutor['all']; exec: AsyncExecutor['exec']; inTransaction: AsyncExecutor['inTransaction']; close: AsyncExecutor['close'] }>;
  readonly #readOnly: boolean;
  readonly #dialect: 'sqlite' | 'postgresql';
  readonly #maxQueue: number;
  readonly #maxPending: number;
  readonly #queueTimeoutMs: number;
  readonly #observer: ((event: AsyncControlEvent) => void) | undefined;
  readonly #context = new AsyncLocalStorage<Frame>();
  readonly #queue: QueueEntry[] = [];
  #tail: Promise<void> = Promise.resolve();
  #current: Frame | null = null;
  #inflight = 0;
  #savepoints = 0;
  #poison: string | null = null;
  #closing = false;
  #connectionClosed: Promise<void> | null = null;
  #closeResult: Promise<void> | null = null;

  constructor(executor: AsyncExecutor, options: AsyncSessionOptions | undefined) {
    if (executor === null || typeof executor !== 'object') throw failure('VALIDATION');
    const all = executor.all, exec = executor.exec, inTransaction = executor.inTransaction, close = executor.close;
    if (typeof all !== 'function' || typeof exec !== 'function' || typeof inTransaction !== 'function' || typeof close !== 'function') throw failure('VALIDATION');
    this.#executor = Object.freeze({ all: all.bind(executor), exec: exec.bind(executor), inTransaction: inTransaction.bind(executor), close: close.bind(executor) });
    const raw: unknown = options === undefined ? {} : options;
    if (!plainObject(raw) || Object.keys(raw).some(key => !OPTION_KEYS.has(key))) throw failure('VALIDATION');
    if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') throw failure('VALIDATION');
    if (raw.dialect !== undefined && raw.dialect !== 'sqlite' && raw.dialect !== 'postgresql') throw failure('VALIDATION');
    this.#dialect = raw.dialect === 'postgresql' ? 'postgresql' : 'sqlite';
    this.#readOnly = raw.readOnly === true;
    this.#maxQueue = integerOption(raw, 'maxQueue', ASYNC_SESSION_LIMITS.defaultQueue, ASYNC_SESSION_LIMITS.queue);
    this.#maxPending = integerOption(raw, 'maxPending', ASYNC_SESSION_LIMITS.defaultPending, ASYNC_SESSION_LIMITS.pending);
    this.#queueTimeoutMs = integerOption(raw, 'queueTimeoutMs', ASYNC_SESSION_LIMITS.defaultQueueTimeoutMs, ASYNC_SESSION_LIMITS.queueTimeoutMs);
    const observer = raw.observer;
    if (observer !== undefined && (observer === null || typeof observer !== 'object' || typeof (observer as { control?: unknown }).control !== 'function')) throw failure('VALIDATION');
    const notify = observer === undefined ? undefined : (observer as AsyncSessionObserver).control.bind(observer);
    this.#observer = notify === undefined ? undefined : event => { try { notify(event); } catch { /* A trace hook can never change a transaction outcome. */ } };
  }

  facade(): AsyncSession {
    return Object.freeze({
      all: (sql: string, parameters?: readonly Parameter[], options?: AsyncOperationOptions) => this.#rootAll(sql, parameters, options),
      transaction: <R>(callback: (tx: AsyncTransaction) => R | PromiseLike<R>, options?: AsyncOperationOptions) => this.#rootTransaction<R>(callback, options),
      close: () => this.#close(),
    });
  }

  // ---------------------------------------------------------------- connection serialization and outcome classification

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => {
      if (this.#poison !== null) throw failure('CONNECTION_UNUSABLE');
      return operation();
    });
    this.#tail = run.then(noop, noop);
    return run;
  }

  /**
   * kind 'statement'/'control': acknowledged rejections pass through; anything else poisons with EXECUTION_UNCONFIRMED.
   * kind 'commit': acknowledged passes through; anything else poisons with COMMIT_UNCONFIRMED.
   * kind 'state': any failure or non-boolean answer poisons with EXECUTION_UNCONFIRMED.
   */
  #execute<T>(frame: Frame | null, kind: 'statement' | 'control' | 'commit' | 'state', operation: () => Promise<T>, beforeSend?: () => void): Promise<T> {
    const run = this.#serial(async () => {
      // A local rejection before the driver is invoked establishes that nothing was sent.
      beforeSend?.();
      try { return await operation(); }
      catch (error) {
        if (kind !== 'state' && isAcknowledgedRejection(error)) throw error;
        throw this.#poisonWith(kind === 'commit' ? 'COMMIT_UNCONFIRMED' : 'EXECUTION_UNCONFIRMED');
      }
    });
    if (frame) {
      // Registered before the caller can await `run`, so the marker is gone before the caller's continuation runs.
      let marker: Promise<void> | undefined = undefined;
      const forget = (): void => { if (marker) frame.issued.delete(marker); };
      marker = run.then(forget, forget);
      frame.issued.add(marker);
    }
    return run;
  }

  #statement(frame: Frame | null, sql: string, parameters: readonly Parameter[], signal?: AbortSignal): Promise<ExecutorRows> {
    this.#inflight++;
    const onAbort = (): void => { if (frame) this.#abortFrame(frame); };
    if (frame) signal?.addEventListener('abort', onAbort, { once: true });
    const run = this.#execute(frame, 'statement', async () => {
      const rows: unknown = await this.#executor.all(sql, parameters);
      if (!Array.isArray(rows)) throw new Error('malformed executor result');
      return rows as ExecutorRows;
    }, () => { if (signal?.aborted) { onAbort(); throw failure('ABORTED'); } });
    const release = (): void => { this.#inflight--; if (frame) signal?.removeEventListener('abort', onAbort); };
    run.then(release, release);
    if (frame) {
      frame.userPending.add(run);
      const forget = (): void => { frame.userPending.delete(run); };
      run.then(forget, forget);
    }
    return run;
  }

  #control(frame: Frame, action: TransactionAction, name?: string): Promise<void> {
    const sql = controlSql(this.#dialect, action, name);
    const startedAt = performance.now();
    const run = this.#execute(frame, action === 'commit' ? 'commit' : 'control', () => this.#executor.exec(sql));
    const observer = this.#observer;
    if (observer) {
      // Registered before the lifecycle awaits `run`, so the event is delivered before any later statement completes.
      run.then(() => observer({ handle: frame.handle, action, sql, outcome: 'ok', startedAt }),
        error => observer({ handle: frame.handle, action, sql, outcome: isAcknowledgedRejection(error) ? 'rejected' : 'unconfirmed', startedAt }));
    }
    return run;
  }

  #inTransaction(frame: Frame): Promise<boolean> {
    return this.#execute(frame, 'state', async () => {
      const value: unknown = await this.#executor.inTransaction();
      if (typeof value !== 'boolean') throw new Error('malformed transaction state');
      return value;
    });
  }

  /** Marks the session unusable, rejects queued work and closes the connection exactly once, after issued work settles. */
  #poisonWith(code: string): RowstitchError {
    if (this.#poison === null) {
      this.#poison = code;
      for (const entry of this.#queue.splice(0)) entry.fail(failure('CONNECTION_UNUSABLE'));
      this.#closeConnection(true);
    }
    return failure(code);
  }

  #closeConnection(tolerateFailure: boolean): Promise<void> {
    if (!this.#connectionClosed) {
      // Chained after every issued operation, so the connection is never closed underneath an active statement.
      this.#connectionClosed = this.#tail.then(() => this.#executor.close());
      this.#tail = this.#connectionClosed.then(noop, noop);
    }
    return tolerateFailure ? this.#connectionClosed.then(noop, noop) : this.#connectionClosed;
  }

  // ---------------------------------------------------------------- context guards

  #rootGuard(): void {
    const store = this.#context.getStore();
    if (store) {
      for (let frame: Frame | null = store; frame; frame = frame.parent) if (frame.active) throw failure('TRANSACTION_ACTIVE');
      throw failure('TRANSACTION_CLOSED');
    }
    if (this.#poison !== null) throw failure('CONNECTION_UNUSABLE');
    if (this.#closing) throw failure('CLOSED');
  }

  #frameGuard(frame: Frame): void {
    if (this.#poison !== null) throw failure('CONNECTION_UNUSABLE');
    if (!frame.active) throw failure(frame.closedCode);
    const store = this.#context.getStore();
    if (store !== frame) {
      for (let ancestor = store?.parent ?? null; ancestor; ancestor = ancestor.parent) {
        if (ancestor === frame) throw failure('TRANSACTION_NESTED_ACTIVE', 'NESTED_PARENT');
      }
      throw failure('TRANSACTION_CONTEXT');
    }
    if (frame.child) throw failure('TRANSACTION_NESTED_ACTIVE', 'NESTED_PARENT');
  }

  // ---------------------------------------------------------------- root FIFO

  #admit(signal: AbortSignal | undefined, start: () => void, reject: (error: unknown) => void): void {
    if (this.#current === null && this.#queue.length === 0) { start(); return; }
    if (this.#queue.length >= this.#maxQueue) { reject(failure('QUEUE_FULL')); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => { remove(); reject(failure('ABORTED')); };
    const entry: QueueEntry = {
      start: () => { cleanup(); start(); },
      fail: error => { cleanup(); reject(error); },
    };
    const cleanup = (): void => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const remove = (): void => {
      cleanup();
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
    };
    timer = setTimeout(() => { remove(); reject(failure('QUEUE_TIMEOUT')); }, this.#queueTimeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#queue.push(entry);
  }

  #pump(): void {
    while (this.#current === null && this.#queue.length) {
      const entry = this.#queue.shift()!;
      this.#context.exit(() => entry.start());
    }
  }

  // ---------------------------------------------------------------- public operations (all return promises, never throw)

  async #rootAll(sql: unknown, parameters: unknown, options: unknown): Promise<ExecutorRows> {
    const text = captureSql(sql), values = captureParameters(parameters), signal = operationSignal(options);
    this.#rootGuard();
    if (signal?.aborted) throw failure('ABORTED');
    return new Promise<ExecutorRows>((resolve, reject) => {
      this.#admit(signal, () => {
        if (signal?.aborted) { reject(failure('ABORTED')); return; }
        if (this.#poison !== null) { reject(failure('CONNECTION_UNUSABLE')); return; }
        if (this.#inflight >= this.#maxPending) { reject(failure('PENDING_LIMIT')); return; }
        this.#statement(null, text, values, signal).then(resolve, reject);
      }, reject);
    });
  }

  async #rootTransaction<R>(callback: unknown, options: unknown): Promise<Awaited<R>> {
    if (typeof callback !== 'function') throw failure('VALIDATION');
    const signal = operationSignal(options);
    this.#rootGuard();
    if (signal?.aborted) throw failure('ABORTED');
    return new Promise<Awaited<R>>((resolve, reject) => {
      this.#admit(signal, () => {
        if (signal?.aborted) { reject(failure('ABORTED')); return; }
        if (this.#poison !== null) { reject(failure('CONNECTION_UNUSABLE')); return; }
        const frame = this.#frame(null);
        this.#current = frame;
        this.#runFrame(frame, callback as (tx: AsyncTransaction) => R | PromiseLike<R>, signal).then(resolve, reject);
      }, reject);
    });
  }

  /** Not async: the returned promise is the tracked statement promise itself. Validation failures are rejections. */
  #txAll(frame: Frame, sql: unknown, parameters: unknown, options: unknown): Promise<ExecutorRows> {
    let text: string, values: readonly Parameter[];
    let signal: AbortSignal | undefined;
    try {
      text = captureSql(sql); values = captureParameters(parameters);
      signal = operationSignal(options);
      this.#frameGuard(frame);
      // A pre-aborted request never joins this transaction, matching child-transaction admission.
      if (signal?.aborted) throw failure('ABORTED');
      if (this.#inflight >= this.#maxPending) throw failure('PENDING_LIMIT');
    } catch (error) { return Promise.reject(error); }
    return this.#statement(frame, text, values, signal);
  }

  /** Every admission check is synchronous and happens before SAVEPOINT is issued. */
  #txTransaction<R>(parent: Frame, callback: unknown, options: unknown): Promise<Awaited<R>> {
    let signal: AbortSignal | undefined;
    try {
      if (typeof callback !== 'function') throw failure('VALIDATION');
      signal = operationSignal(options);
      this.#frameGuard(parent);
      if (parent.issued.size) throw failure('TRANSACTION_NESTED_ACTIVE', 'NESTED_PENDING');
      if (parent.depth >= ASYNC_SESSION_LIMITS.maxDepth) throw failure('TRANSACTION_DEPTH');
      if (signal?.aborted) throw failure('ABORTED');
    } catch (error) { return Promise.reject(error); }
    const child = this.#frame(parent);
    parent.child = child;
    return this.#runFrame(child, callback as (tx: AsyncTransaction) => R | PromiseLike<R>, signal);
  }

  #frame(parent: Frame | null): Frame {
    const frame: Frame = {
      parent, depth: parent ? parent.depth + 1 : 1, savepoint: parent ? 'rs_async_sp_' + ++this.#savepoints : null,
      active: true, closedCode: 'TRANSACTION_CLOSED', phase: 'starting', child: null, doomed: false, abortRequested: false,
      issued: new Set(), userPending: new Set(), interrupt: deferred(), handle: undefined as unknown as AsyncTransaction,
    };
    frame.handle = Object.freeze({
      all: (sql: string, parameters?: readonly Parameter[], options?: AsyncOperationOptions) => this.#txAll(frame, sql, parameters, options),
      transaction: <R>(callback: (tx: AsyncTransaction) => R | PromiseLike<R>, options?: AsyncOperationOptions) => this.#txTransaction<R>(frame, callback, options),
    });
    return frame;
  }

  // ---------------------------------------------------------------- transaction lifecycle

  #abortFrame(frame: Frame): void {
    if (frame.phase === 'starting' || frame.phase === 'running') {
      frame.abortRequested = true;
      if (frame.phase === 'running') frame.interrupt.resolve('abort');
    }
  }

  /** Invalidates every active descendant; each one stops accepting work and sends no further SQL of its own. */
  #doomDescendants(frame: Frame): void {
    for (let child = frame.child; child; child = child.child) {
      child.active = false; child.doomed = true; child.closedCode = 'TRANSACTION_CLOSED';
      child.interrupt.resolve('doom');
    }
  }

  /** Waits for every executor operation already issued by the frame or its descendants. */
  async #drain(frame: Frame): Promise<void> {
    for (;;) {
      const pending: Promise<void>[] = [];
      for (let current: Frame | null = frame; current; current = current.child) pending.push(...current.issued);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  /** Returns null after a verified rollback, otherwise the poison code (the connection is then closed). */
  async #rollback(frame: Frame): Promise<string | null> {
    if (this.#poison !== null) return this.#poison;
    try {
      if (frame.parent === null) {
        if (await this.#inTransaction(frame)) await this.#control(frame, 'rollback');
        if (await this.#inTransaction(frame)) throw new Error('incomplete cleanup');
      } else {
        // A doomed child sends no SQL: its ancestor's rollback covers it, and its savepoint may already be gone.
        if (frame.doomed) return null;
        await this.#control(frame, 'rollback-to', frame.savepoint!);
        if (frame.doomed) return null;
        await this.#control(frame, 'release', frame.savepoint!);
      }
      return null;
    } catch {
      if (this.#poison === null) this.#poisonWith('CONNECTION_UNUSABLE');
      return this.#poison;
    }
  }

  /** Not async: callers receive result.promise itself, so doomed outcomes can be marked handled on that exact promise. */
  #runFrame<R>(frame: Frame, callback: (tx: AsyncTransaction) => R | PromiseLike<R>, signal: AbortSignal | undefined): Promise<Awaited<R>> {
    const result = deferred<Awaited<R>>();
    let finished = false;
    const onAbort = (): void => this.#abortFrame(frame);
    const finish = (ok: boolean, value: unknown, handled = false): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      frame.active = false; frame.phase = 'done';
      if (frame.parent) { if (frame.parent.child === frame) frame.parent.child = null; }
      else if (this.#current === frame) { this.#current = null; this.#pump(); }
      if (ok) result.resolve(value as Awaited<R>);
      else { if (handled) result.promise.catch(noop); result.reject(value); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#lifecycle(frame, callback, signal, finish).catch(() => {
      // Defensive: an internal fault must not leave a transaction open or report success.
      if (this.#poison === null) this.#poisonWith('CONNECTION_UNUSABLE');
      finish(false, failure('CONNECTION_UNUSABLE'));
    });
    return result.promise;
  }

  async #lifecycle<R>(frame: Frame, callback: (tx: AsyncTransaction) => R | PromiseLike<R>, signal: AbortSignal | undefined,
    finish: (ok: boolean, value: unknown, handled?: boolean) => void): Promise<void> {

    // 1. BEGIN / SAVEPOINT.
    try {
      if (frame.parent === null) await this.#control(frame, this.#readOnly ? 'begin' : 'begin-immediate');
      else await this.#control(frame, 'savepoint', frame.savepoint!);
    } catch (error) {
      finish(false, error);
      return;
    }
    if (frame.doomed) { finish(false, failure('TRANSACTION_CLOSED'), true); return; }
    if (frame.abortRequested || signal?.aborted) {
      frame.active = false; frame.closedCode = 'ABORTED';
      const cleanup = await this.#rollback(frame);
      finish(false, cleanup === null ? failure('ABORTED') : withCleanup(failure('ABORTED'), cleanup));
      return;
    }

    // 2. Run the callback inside this frame's context.
    frame.phase = 'running';
    let outcome: Promise<R>;
    try { outcome = Promise.resolve(this.#context.run(frame, () => callback(frame.handle))); }
    catch (error) { outcome = Promise.reject(error); }
    type Settled = { kind: 'settled'; ok: boolean; value: unknown } | { kind: 'interrupt'; reason: 'abort' | 'doom' };
    const settled = await Promise.race<Settled>([
      outcome.then(value => ({ kind: 'settled', ok: true, value }), error => ({ kind: 'settled', ok: false, value: error })),
      frame.interrupt.promise.then(reason => ({ kind: 'interrupt', reason })),
    ]);
    frame.active = false;
    frame.phase = 'settling';

    // 3a. Interrupted by an ancestor's end or by this frame's own abort: stop new work, drain, then roll back.
    if (settled.kind === 'interrupt' || frame.abortRequested) {
      const reason = settled.kind === 'interrupt' ? settled.reason : 'abort';
      frame.closedCode = reason === 'abort' ? 'ABORTED' : 'TRANSACTION_CLOSED';
      this.#doomDescendants(frame);
      for (const pending of frame.userPending) pending.catch(noop);
      await this.#drain(frame);
      if (reason === 'doom' || frame.doomed) { finish(false, failure('TRANSACTION_CLOSED'), true); return; }
      const cleanup = await this.#rollback(frame);
      finish(false, cleanup === null ? failure('ABORTED') : withCleanup(failure('ABORTED'), cleanup));
      return;
    }

    // 3b. Callback settled. A poisoned session never reports success or an inferred rollback.
    if (this.#poison !== null) { finish(false, failure(this.#poison)); return; }
    const pending = frame.issued.size > 0 || frame.child !== null;
    if (pending || !settled.ok) {
      this.#doomDescendants(frame);
      for (const statement of frame.userPending) statement.catch(noop);
      await this.#drain(frame);
      if (frame.doomed) { finish(false, failure('TRANSACTION_CLOSED'), true); return; }
      const cleanup = await this.#rollback(frame);
      const original = pending && settled.ok ? failure('TRANSACTION_PENDING') : settled.value;
      finish(false, cleanup === null ? original : withCleanup(original, cleanup));
      return;
    }
    if (frame.doomed) { finish(false, failure('TRANSACTION_CLOSED'), true); return; }

    // 4. COMMIT / RELEASE. An acknowledged COMMIT wins over a late abort.
    try {
      if (frame.parent === null) await this.#control(frame, 'commit');
      else await this.#control(frame, 'release', frame.savepoint!);
    } catch (error) {
      if (!isAcknowledgedRejection(error)) { finish(false, error); return; } // unconfirmed: poisoned, no rollback inferred
      const cleanup = await this.#rollback(frame);
      finish(false, cleanup === null ? error : withCleanup(error, cleanup));
      return;
    }
    if (frame.doomed) { finish(false, failure('TRANSACTION_CLOSED'), true); return; }
    finish(true, settled.value);
  }

  // ---------------------------------------------------------------- close

  /** Not async: repeated calls after the first accepted close return the very same promise. */
  #close(): Promise<void> {
    const store = this.#context.getStore();
    if (store) {
      for (let frame: Frame | null = store; frame; frame = frame.parent) if (frame.active) return Promise.reject(failure('TRANSACTION_ACTIVE'));
      return Promise.reject(failure('TRANSACTION_CLOSED'));
    }
    if (this.#closeResult) return this.#closeResult;
    if (this.#poison !== null) {
      this.#closing = true;
      this.#closeResult = this.#closeConnection(true);
      return this.#closeResult;
    }
    // Precise choice: refuse while a transaction is active or root work is queued; otherwise stop admission, let issued
    // autocommit statements finish, then close exactly once.
    if (this.#current !== null || this.#queue.length) return Promise.reject(failure('TRANSACTION_ACTIVE', 'SESSION_ACTIVE'));
    this.#closing = true;
    this.#closeResult = this.#closeConnection(false).then(noop, () => { throw failure('CLOSE_FAILED'); });
    return this.#closeResult;
  }
}

/** Internal factory. Throws VALIDATION synchronously only for invalid construction arguments. */
export function createAsyncSession(executor: AsyncExecutor, options?: AsyncSessionOptions): AsyncSession {
  return new Session(executor, options).facade();
}
