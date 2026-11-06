/**
 * Public asynchronous ORM over one owned connection. Every database request goes through the
 * internal async session (serialization, FIFO admission, transaction leases, unknown-outcome poisoning). Planning,
 * validation, lowering, budgets and decoding are the shared repository core used by the synchronous API.
 *
 * openAsyncDatabase uses worker-owned SQLite. Optional native factories select PostgreSQL or worker-owned PGlite.
 * Capabilities depend on the selected dialect; unsupported operations refuse explicitly. No raw SQL API is exposed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { RowstitchError, fail } from './errors.js';
import type { AnyTable, InsertRow, KeyRow, Row, UpdateRow } from './schema.js';
import { isTable } from './schema.js';
import { assertOptions, type CompiledQuery, type FindOptions, type Includes, type Predicate, type Selection, type WithIncludes } from './predicates.js';
import type { RepositoryDialect } from './dialect.js';
import type { AggregateSelection, AggregateOptions, AggregateResult, GroupKey, GroupOptions, GroupResult, ProjectedRow, RelatedAggregates } from './aggregates.js';
import { RepositoryCore, ensureSchemaWork, inspectSchemaWork, inspectionScope, integer, openConfig, publicPlans, runAsync, schemaPlansWork,
  type CoreContext, type MappingBackend, type OpenConfig, type QueryPlan, type Rows, type SchemaInspectionOptions, type SchemaPlan, type SchemaTable, type Step, type Work, type WriteOptions } from './repository-core.js';
import { clearTraceState, recordTrace, traceDocument, type TraceDocumentV2, type TraceState } from './trace-log.js';
import { ASYNC_SESSION_LIMITS, createAsyncSession, trackTransactionPromise, type AsyncControlEvent, type AsyncResultGuard, type AsyncSession, type AsyncTransaction } from './async-session.js';
import { isAcknowledgedRejection, type AsyncExecutor } from './executor.js';
import { openWorkerSqliteExecutor } from './worker-executor.js';
import type { DatabaseOptions } from './database.js';

export interface AsyncDatabaseOptions extends DatabaseOptions {
  /** Root operations that may wait for the connection while a transaction is active (1-1024, default 64). */
  maxQueue?: number;
  /** Statements that may be pending on the connection at once (1-1024, default 256). */
  maxPending?: number;
  /** How long queued root work may wait before QUEUE_TIMEOUT, sending no SQL (1-60000 ms, default 10000). */
  queueTimeoutMs?: number;
  /** How long one worker request may take before its outcome is treated as unknown (1-120000 ms, default 30000). */
  requestTimeoutMs?: number;
}
export interface AsyncTransactionOptions { readonly signal?: AbortSignal }

/** Internal adapter contract. Public open functions supply it; it is not a user-provided SQL or decoder API. */
export interface AsyncDatabaseRuntime {
  readonly dialect: RepositoryDialect;
  readonly sessionDialect: 'sqlite' | 'postgresql';
  readonly isResult: AsyncResultGuard<unknown>;
  readonly inspectSchema: (scope?: 'all' | 'mapped') => Work<SchemaTable[]>;
  readonly planSchema?: () => Work<SchemaPlan[]>;
  readonly ensureSchema?: () => Work<{ plans: SchemaPlan[]; schema: SchemaTable[] }>;
}

interface AsyncState extends TraceState {
  session: AsyncSession<unknown>; tables: Map<string, AnyTable>; closed: boolean; readOnly: boolean; context: AsyncLocalStorage<Lease>;
  runtime: AsyncDatabaseRuntime | undefined;
  transactionSequence: number; ids: WeakMap<AsyncTransaction<unknown>, string>;
  schemaSnapshot: SchemaSnapshot; unconfirmed: number;
}
interface SchemaSnapshot { schema: SchemaTable[]; at: string; scope: 'all' | 'mapped' }
interface Lease { active: boolean; parent: Lease | undefined; snapshot?: SchemaSnapshot }
interface AsyncInternal extends CoreContext {
  run<R>(work: Work<R>): Promise<R>;
  atomic<R>(callback: (tx: AsyncDatabase) => R | PromiseLike<R>): Promise<Awaited<R>>;
  /** Every public async operation starts here, synchronously, so its promise is owned by this handle's session frame. */
  scoped<T>(work: () => Promise<T>): Promise<T>;
}
const internal = new WeakMap<object, AsyncInternal>();
function ops(db: AsyncDatabase): AsyncInternal {
  const value = internal.get(db);
  if (!value) fail('CLOSED', 'This database handle is not available.');
  return value;
}
const CONSTRUCT = Symbol('rowstitch.async-database');
const SESSION_LOCAL = new Set(['ABORTED', 'QUEUE_FULL', 'QUEUE_TIMEOUT', 'PENDING_LIMIT', 'CLOSED', 'CONNECTION_UNUSABLE', 'VALIDATION',
  'TRANSACTION_ACTIVE', 'TRANSACTION_CLOSED', 'TRANSACTION_CONTEXT', 'TRANSACTION_PENDING', 'TRANSACTION_DEPTH', 'TRANSACTION_NESTED_ACTIVE']);
/** Errors crossing the public boundary are RowstitchErrors with safe constant messages. */
function safe(error: unknown): unknown {
  if (error instanceof RowstitchError) return error;
  return new RowstitchError('DATABASE_ERROR', 'The database could not complete this operation.');
}

export class AsyncDatabase {
  #state: AsyncState;
  #handle: AsyncTransaction<unknown>;
  #lease: Lease | undefined;
  /** Internal: use openAsyncDatabase() or one of the optional native database factories. */
  constructor(token: symbol, state: AsyncState, handle: AsyncTransaction<unknown>, lease?: Lease) {
    if (token !== CONSTRUCT) fail('VALIDATION', 'Use openAsyncDatabase() to open an asynchronous database.');
    this.#state = state; this.#handle = handle; this.#lease = lease;
    internal.set(this, {
      check: () => this.#check(), writeCheck: () => this.#writeCheck(), mapped: table => this.#mapped(table), tables: state.tables,
      ...(state.runtime ? { dialect: state.runtime.dialect } : {}),
      run: work => runAsync(work, step => this.#perform(step)),
      atomic: callback => this.#transaction(callback),
      scoped: work => trackTransactionPromise(this.#handle, work()),
    });
  }

  #check(): void {
    if (this.#state.closed) fail('CLOSED', 'This database is closed.');
    // Like the synchronous API: a handle used after its callback finished, or any handle used from an async context
    // that a finished transaction callback created (timers, late continuations), is refused even for pure planning.
    if (this.#lease && !this.#lease.active || this.#state.context.getStore()?.active === false) fail('TRANSACTION_CLOSED', 'This transaction callback has finished; its handle cannot be reused.');
  }
  #writeCheck(): void {
    this.#check();
    if (this.#state.readOnly) fail('READ_ONLY', 'This database is read-only.');
  }
  #mapped(table: AnyTable): void {
    this.#check();
    if (!isTable(table) || this.#state.tables.get(table.name) !== table) fail('SCHEMA', 'Register this exact table definition when opening the database.');
  }
  #transactionId(): string | null {
    return this.#lease ? this.#state.ids.get(this.#handle) ?? null : null;
  }
  /**
   * Executes one shared-core Step through this handle's session scope. Metadata stays untraced. Statements refused
   * locally by the session (never sent) are not traced; engine rejections and unconfirmed outcomes are traced as
   * 'error', and unconfirmed outcomes are counted for the export notes because 'error' does not prove "no effect".
   */
  async #perform(step: Step): Promise<Rows> {
    this.#check();
    if (this.#state.runtime && typeof step.decode !== 'function') fail('QUERY', 'A native database statement requires its compiler result contract.');
    const decode = (result: unknown): Rows => step.decode ? step.decode(result) : result as Rows;
    if (step.metadata) {
      try { return decode(await this.#handle.all(step.sql, step.parameters)); } catch (error) { throw safe(error); }
    }
    const start = performance.now();
    try {
      const rows = decode(await this.#handle.all(step.sql, step.parameters));
      const plan = step.explain ? rows.map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) })) : undefined;
      recordTrace(this.#state, { operation: step.operation, table: step.table, sql: step.sql, parameters: step.parameters, start, rowCount: rows.length,
        transactionId: this.#transactionId(), status: 'ok', ...(plan ? { plan } : {}) });
      return rows;
    } catch (error) {
      const unconfirmed = error instanceof RowstitchError && (error.code === 'EXECUTION_UNCONFIRMED' || error.code === 'COMMIT_UNCONFIRMED');
      if (unconfirmed) this.#state.unconfirmed++;
      if (unconfirmed || isAcknowledgedRejection(error) || !(error instanceof RowstitchError && SESSION_LOCAL.has(error.code))) {
        recordTrace(this.#state, { operation: step.operation, table: step.table, sql: step.sql, parameters: step.parameters, start, rowCount: 0,
          transactionId: this.#transactionId(), status: 'error' });
      }
      throw safe(step.mapError ? step.mapError(error) : error);
    }
  }

  table<T extends AnyTable>(table: T): AsyncRepository<T> {
    this.#mapped(table);
    return new AsyncRepository(CONSTRUCT, this, table);
  }

  /**
   * Runs the callback in one transaction (a savepoint when called on a transaction handle). The callback may be
   * synchronous or async; every statement it starts must finish before it settles, or the work is rolled back with
   * TRANSACTION_PENDING. Statement results inside a transaction are provisional until this promise resolves.
   */
  transaction<R>(callback: (tx: AsyncDatabase) => R | PromiseLike<R>, options?: AsyncTransactionOptions): Promise<Awaited<R>> {
    return trackTransactionPromise(this.#handle, this.#transaction<R>(callback, options));
  }
  async #transaction<R>(callback: (tx: AsyncDatabase) => R | PromiseLike<R>, options?: AsyncTransactionOptions): Promise<Awaited<R>> {
    this.#check();
    if (typeof callback !== 'function') fail('VALIDATION', 'A transaction requires a callback.');
    const lease: Lease = { active: true, parent: this.#lease };
    // The callback's own errors pass through unchanged; session errors are already safe RowstitchErrors.
    try {
      const value = await this.#handle.transaction<R>(sessionTx => this.#state.context.run(lease, () => {
        try {
          const result = Promise.resolve(callback(new AsyncDatabase(CONSTRUCT, this.#state, sessionTx, lease)));
          // Revoke the callback context before waiting for COMMIT or RELEASE acknowledgment.
          // Observe the same promise without draining unfinished work.
          result.then(() => { lease.active = false; }, () => { lease.active = false; });
          return result;
        } catch (error) { lease.active = false; throw error; }
      }), options);
      if (lease.snapshot) this.#keepSnapshot(lease.snapshot);
      return value;
    }
    finally {
      lease.active = false;
      delete lease.snapshot;
    }
  }

  inspectSchema(options: SchemaInspectionOptions = {}): Promise<SchemaTable[]> {
    return ops(this).scoped(() => this.#inspect(options));
  }
  async #inspect(options: SchemaInspectionOptions = {}): Promise<SchemaTable[]> {
    this.#check();
    try {
      const scope = inspectionScope(options);
      const schema = await ops(this).run(this.#state.runtime ? this.#state.runtime.inspectSchema(scope) : inspectSchemaWork(this.#state.tables, scope));
      this.#snapshot(schema, scope);
      return schema;
    } catch (error) { throw safe(error); }
  }
  planSchema(): Promise<SchemaPlan[]> {
    return ops(this).scoped(async () => {
      this.#check();
      try {
        if (this.#state.runtime?.planSchema) return await ops(this).run(this.#state.runtime.planSchema());
        return publicPlans(await ops(this).run(schemaPlansWork(ops(this))));
      } catch (error) { throw safe(error); }
    });
  }
  ensureSchema(): Promise<SchemaPlan[]> {
    return ops(this).scoped(async () => {
      this.#writeCheck();
      const ensure = this.#state.runtime?.ensureSchema;
      if (ensure) {
        try {
          return await this.#transaction(async tx => {
            try {
              const result = await ops(tx).run(ensure());
              // All inspection, validation and allocation finish before COMMIT. Afterwards only these owned values are assigned.
              tx.#snapshot(result.schema, 'mapped');
              return result.plans;
            } catch (error) {
              // Sanitize internal computation errors before rollback, so its acknowledgment/cleanup metadata remains attached.
              throw safe(error);
            }
          });
        } catch (error) { throw safe(error); }
      }
      if (this.#state.runtime?.dialect.name === 'postgresql') fail('QUERY', 'Schema creation is not implemented for this database dialect.');
      return this.#transaction(async tx => {
        const plans = await ops(tx).run(ensureSchemaWork(ops(tx)));
        await tx.#inspect({ scope: 'mapped' });
        return plans;
      });
    });
  }
  #snapshot(schema: SchemaTable[], scope: 'all' | 'mapped'): void {
    this.#keepSnapshot({ schema: structuredClone(schema), at: new Date().toISOString(), scope });
  }
  #keepSnapshot(snapshot: SchemaSnapshot): void {
    if (!this.#lease) this.#state.schemaSnapshot = snapshot;
    else if (this.#lease.active) this.#lease.snapshot = snapshot;
  }

  clearTrace(): void {
    this.#check(); clearTraceState(this.#state);
  }
  /**
   * Synchronous trace snapshot with the shared redaction and size policy. The schema is the
   * last one inspected by this database (at open, inspectSchema or ensureSchema), because exporting must not perform I/O.
   */
  exportTrace(options: { title?: string } = {}): TraceDocumentV2 {
    this.#check();
    const title = options.title ?? 'Local query trace';
    if (typeof title !== 'string' || title.length > 4096) fail('VALIDATION', 'Trace titles must be bounded text.');
    const outcomeNote = this.#state.runtime?.dialect.name === 'postgresql'
      ? 'An "error" status records a failed or unconfirmed request; it is not proof that nothing changed. In this trace, a failed PostgreSQL COMMIT has an unknown outcome even if a later ROLLBACK succeeds, because that ROLLBACK might have had no transaction to undo.'
      : 'An "error" status records a failed or unconfirmed request; it is not proof that nothing changed. A failed COMMIT that is not followed by a recorded ROLLBACK has an unknown outcome.';
    let owner = this.#lease;
    while (owner && !owner.snapshot) owner = owner.parent;
    const { schema, scope, at } = owner?.snapshot ?? this.#state.schemaSnapshot;
    const notes = ['Asynchronous connection: the schema shown was inspected at ' + at + ' and may not include later changes made by other connections.', outcomeNote];
    if (owner) notes.push('This schema snapshot is provisional until its outer transaction commits.');
    if (this.#state.unconfirmed) notes.push(this.#state.unconfirmed + ' request(s) on this connection had unconfirmed outcomes. Inspect the stored data before retrying any of that work.');
    const { tables: registrations, runtime } = this.#state;
    const defaultSchema = runtime?.dialect.defaultSchema ?? (this.#state.dialect === 'postgresql' ? 'public' : 'main');
    return traceDocument(this.#state, title, { schema, scope, registrations, defaultSchema }, notes);
  }

  /** Closes the connection after issued work finishes. Refused while a transaction is active. */
  async close(): Promise<void> {
    if (this.#state.closed) return;
    if (this.#lease) fail('TRANSACTION_ACTIVE', 'Close the root database after its transaction callback has finished.');
    try { await this.#state.session.close(); }
    catch (error) {
      if (error instanceof RowstitchError && (error.code === 'TRANSACTION_ACTIVE' || error.code === 'TRANSACTION_CLOSED')) throw error;
      this.#state.closed = true; clearTraceState(this.#state);
      throw safe(error);
    }
    this.#state.closed = true; clearTraceState(this.#state);
  }
}

export class AsyncRepository<T extends AnyTable> {
  #db: AsyncDatabase;
  #core: RepositoryCore<T>;
  readonly definition: T;
  /** Internal: use AsyncDatabase.table(). */
  constructor(token: symbol, db: AsyncDatabase, definition: T) {
    if (token !== CONSTRUCT) fail('VALIDATION', 'Use AsyncDatabase.table() to create a repository.');
    this.#db = db; this.definition = definition; this.#core = new RepositoryCore(ops(db), definition);
  }
  #in(tx: AsyncDatabase): RepositoryCore<T> { return new RepositoryCore(ops(tx), this.definition); }

  /** Validates and encodes the record at call time; later caller mutation cannot change what is written. */
  insert(data: InsertRow<T>): Promise<Row<T>> {
    return ops(this.#db).scoped(async () => {
      this.#core.prepareInsert();
      const captured = this.#core.captureInsert(data);
      return ops(this.#db).atomic(tx => ops(tx).run(this.#in(tx).insertCaptured(captured)));
    });
  }
  /** The row list and every row are captured at call time; the first invalid row fails at its position, as in sync. */
  insertMany(rows: readonly InsertRow<T>[]): Promise<Row<T>[]> {
    return ops(this.#db).scoped(async () => {
      this.#core.prepareInsertMany(rows);
      const captured = Array.from(rows, row => this.#core.captureInsert(row));
      return ops(this.#db).atomic(async tx => {
        const result: Row<T>[] = [];
        for (const row of captured) result.push(await ops(tx).run(this.#in(tx).insertCaptured(row)));
        return result;
      });
    });
  }
  /** Pure and synchronous: never executes or traces. */
  compileSelect(options: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates> = {}): CompiledQuery {
    const { sql, parameters } = this.#core.compile(this.#core.selectPlan(options).model);
    return { sql, parameters: [...parameters] };
  }
  compileAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): CompiledQuery {
    const { sql, parameters } = this.#core.compile(this.#core.aggregatePlan(options).model);
    return { sql, parameters: [...parameters] };
  }
  compileGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): CompiledQuery {
    const { sql, parameters } = this.#core.compile(this.#core.groupPlan(options).model);
    return { sql, parameters: [...parameters] };
  }
  explain(options: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates> = {}): Promise<QueryPlan[]> {
    return ops(this.#db).scoped(async () => ops(this.#db).run(this.#core.explainWork(this.#core.selectPlan(options).model)));
  }
  explainAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): Promise<QueryPlan[]> {
    return ops(this.#db).scoped(async () => ops(this.#db).run(this.#core.explainWork(this.#core.aggregatePlan(options).model)));
  }
  explainGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): Promise<QueryPlan[]> {
    return ops(this.#db).scoped(async () => ops(this.#db).run(this.#core.explainWork(this.#core.groupPlan(options).model)));
  }
  findMany<I extends Includes = {}, const S extends Selection<T> | undefined = undefined, const A extends RelatedAggregates = {}>(options: FindOptions<I, S, A> = {}): Promise<ProjectedRow<WithIncludes<T, I, NoInfer<S>>, A>[]> {
    return ops(this.#db).scoped(async () => await ops(this.#db).run(this.#core.findMany(options)) as ProjectedRow<WithIncludes<T, I, S>, A>[]);
  }
  findFirst<I extends Includes = {}, const S extends Selection<T> | undefined = undefined, const A extends RelatedAggregates = {}>(options: FindOptions<I, S, A> = {}): Promise<ProjectedRow<WithIncludes<T, I, NoInfer<S>>, A> | null> {
    return ops(this.#db).scoped(async () => {
      assertOptions(options, ['where', 'orderBy', 'limit', 'offset', 'include', 'select', 'aggregates']);
      return (await this.findMany<I, S, A>({ ...options, limit: 1 }))[0] ?? null;
    });
  }
  count(where?: Predicate): Promise<number> {
    return ops(this.#db).scoped(async () => ops(this.#db).run(this.#core.countWork(this.#core.countPrepare(where))));
  }
  aggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): Promise<AggregateResult<S>> {
    return ops(this.#db).scoped(async () => await ops(this.#db).run(this.#core.aggregateWork(this.#core.aggregatePlan(options))) as AggregateResult<S>);
  }
  groupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): Promise<GroupResult<T, B, S>[]> {
    return ops(this.#db).scoped(async () => await ops(this.#db).run(this.#core.groupWork(this.#core.groupPlan(options))) as GroupResult<T, B, S>[]);
  }
  async #write(data: UpdateRow<T> | null, options: WriteOptions, conflict = false): Promise<Row<T>[]> {
    const prepared = this.#core.prepareWrite(data, options, conflict);
    return ops(this.#db).atomic(tx => ops(tx).run(this.#in(tx).writeWork(prepared)));
  }
  update(data: UpdateRow<T>, options: WriteOptions): Promise<Row<T>[]> { return ops(this.#db).scoped(() => this.#write(data, options)); }
  delete(options: WriteOptions): Promise<Row<T>[]> { return ops(this.#db).scoped(() => this.#write(null, options)); }
  updateVersion(key: KeyRow<T>, expectedVersion: number, data: UpdateRow<T>): Promise<Row<T>> {
    return ops(this.#db).scoped(async () => (await this.#write(data, { where: this.#core.versionFilter(key, expectedVersion), maxRows: 1 }, true))[0]);
  }
}

const ASYNC_KEYS = ['maxQueue', 'maxPending', 'queueTimeoutMs', 'requestTimeoutMs'] as const;

/** Internal immutable call-time options, captured before a native adapter starts opening its connection. */
export interface CapturedAsyncDatabaseOptions {
  readonly config: OpenConfig;
  readonly limits: ReturnType<typeof asyncLimits>;
}
export function captureAsyncDatabaseOptions(options: AsyncDatabaseOptions, backend?: MappingBackend): CapturedAsyncDatabaseOptions {
  return Object.freeze({ config: openConfig(':memory:', options, ASYNC_KEYS, backend), limits: Object.freeze(asyncLimits(options)) });
}
export async function openPreparedAsyncDatabase<R>(executor: AsyncExecutor<R>, captured: CapturedAsyncDatabaseOptions, runtime: AsyncDatabaseRuntime): Promise<AsyncDatabase> {
  return openCaptured(executor, captured.config, captured.limits, runtime);
}

/** Internal: opens the public API over any AsyncExecutor (controlled executors in tests). Not exported from the SDK. */
export async function openAsyncDatabaseWithExecutor(executor: AsyncExecutor, options: AsyncDatabaseOptions = {}): Promise<AsyncDatabase> {
  return openCaptured(executor, openConfig(':memory:', options, ASYNC_KEYS), asyncLimits(options));
}
/** Internal native adapter entry. Connection options and this runtime are captured by a dedicated public factory. */
export async function openAsyncDatabaseWithDialect<R>(executor: AsyncExecutor<R>, options: AsyncDatabaseOptions, runtime: AsyncDatabaseRuntime): Promise<AsyncDatabase> {
  return openCaptured(executor, openConfig(':memory:', options, ASYNC_KEYS,
    { dialect: runtime.sessionDialect, schema: runtime.dialect.defaultSchema ?? (runtime.sessionDialect === 'sqlite' ? 'main' : 'public') }), asyncLimits(options), runtime);
}
async function openCaptured(executor: AsyncExecutor<unknown>, config: OpenConfig, sessionLimits: ReturnType<typeof asyncLimits>, runtime?: AsyncDatabaseRuntime): Promise<AsyncDatabase> {
  const state: AsyncState = {
    session: undefined as unknown as AsyncSession<unknown>, tables: config.tables, closed: false, readOnly: config.readOnly, context: new AsyncLocalStorage(), runtime,
    ...(runtime?.dialect.name === 'postgresql' ? { dialect: 'postgresql' as const } : {}),
    traceValues: config.traceValues, capacity: config.capacity, traces: [], sequence: 0, traceBytes: 0, omittedEntries: 0,
    transactionSequence: 0, ids: new WeakMap(), schemaSnapshot: { schema: [], at: new Date(0).toISOString(), scope: 'mapped' }, unconfirmed: 0,
  };
  const observer = {
    control(event: AsyncControlEvent<unknown>): void {
      let id = state.ids.get(event.handle);
      if (id === undefined) { id = 'tx' + ++state.transactionSequence; state.ids.set(event.handle, id); }
      if (event.outcome === 'unconfirmed') state.unconfirmed++;
      recordTrace(state, { operation: 'transaction', table: '', sql: event.sql, parameters: [], start: event.startedAt, rowCount: 0,
        transactionId: id, status: event.outcome === 'ok' ? 'ok' : 'error' });
    },
  };
  state.session = runtime
    ? createAsyncSession(executor, { readOnly: config.readOnly, observer, ...sessionLimits, dialect: runtime.sessionDialect, isResult: runtime.isResult })
    : createAsyncSession(executor as AsyncExecutor, { readOnly: config.readOnly, observer, ...sessionLimits });
  const db = new AsyncDatabase(CONSTRUCT, state, state.session);
  try { await db.inspectSchema({ scope: 'mapped' }); }
  catch (error) { await state.session.close().catch(() => {}); state.closed = true; throw safe(error); }
  return db;
}
function asyncLimits(options: AsyncDatabaseOptions): { maxQueue: number; maxPending: number; queueTimeoutMs: number } {
  const [qMin, qMax] = ASYNC_SESSION_LIMITS.queue, [pMin, pMax] = ASYNC_SESSION_LIMITS.pending, [tMin, tMax] = ASYNC_SESSION_LIMITS.queueTimeoutMs;
  return {
    maxQueue: integer(options.maxQueue, ASYNC_SESSION_LIMITS.defaultQueue, qMin, qMax),
    maxPending: integer(options.maxPending, ASYNC_SESSION_LIMITS.defaultPending, pMin, pMax),
    queueTimeoutMs: integer(options.queueTimeoutMs, ASYNC_SESSION_LIMITS.defaultQueueTimeoutMs, tMin, tMax),
  };
}

/**
 * Opens a local SQLite database whose statements run in one worker thread. Every option of openDatabase applies, plus
 * the session and worker limits. All values remain bound; integers decode exactly as in the synchronous API.
 */
export async function openAsyncDatabase(filename = ':memory:', options: AsyncDatabaseOptions = {}): Promise<AsyncDatabase> {
  // Every option is validated and captured before the first await.
  const config = openConfig(filename, options, ASYNC_KEYS);
  const limits = asyncLimits(options);
  const requestTimeoutMs = integer(options.requestTimeoutMs, 30_000, 1, 120_000);
  const executor = await openWorkerSqliteExecutor(filename, { readOnly: config.readOnly, busyTimeoutMs: config.busyTimeoutMs, requestTimeoutMs });
  return openCaptured(executor, config, limits);
}
