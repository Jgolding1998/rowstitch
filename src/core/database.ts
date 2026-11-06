import { AsyncLocalStorage } from 'node:async_hooks';
import type { SyncExecutor } from './executor.js';
import { openSqliteExecutor } from './sqlite-executor.js';
import { databaseError, fail } from './errors.js';
import { isTable, type AnyTable, type InsertRow, type KeyRow, type Parameter, type Row, type UpdateRow } from './schema.js';
import { assertOptions, type CompiledQuery, type FindOptions, type Includes, type Predicate, type Selection, type WithIncludes } from './predicates.js';
import { queryModel, type TransactionAction, type TransactionModel } from './query-model.js';
import { compileSqlite } from './sqlite-compiler.js';
import type { AggregateSelection, AggregateOptions, AggregateResult, GroupKey, GroupOptions, GroupResult, ProjectedRow, RelatedAggregates } from './aggregates.js';
import { RepositoryCore, ensureSchemaWork, inspectSchemaWork, inspectionScope, openConfig, publicPlans, runSync, schemaPlansWork,
  type CoreContext, type Operation, type QueryPlan, type Rows, type SchemaInspectionOptions, type SchemaPlan, type SchemaTable, type Step, type Work, type WriteOptions } from './repository-core.js';
import { recordTrace, traceDocument, clearTraceState, type TraceDocumentV2, type TraceState } from './trace-log.js';

export type { SchemaColumn, SchemaForeignKey, SchemaIndex, SchemaTable, SchemaInspectionOptions, SchemaPlan, QueryPlan, WriteOptions } from './repository-core.js';
export type { TraceEntry, TraceDocument, TraceDocumentV1, TraceDocumentV2 } from './trace-log.js';
export interface DatabaseOptions {
  tables?: readonly AnyTable[]; readOnly?: boolean; busyTimeoutMs?: number;
  maxTraceEntries?: number; traceValues?: boolean;
}
interface Lease { active: boolean }
interface State extends TraceState {
  handle: SyncExecutor; tables: Map<string, AnyTable>; closed: boolean; poisoned: boolean; readOnly: boolean;
  transactionSequence: number; transactionId: string | null; depth: number; context: AsyncLocalStorage<Lease>;
}

interface Internal extends CoreContext {
  run<R>(work: Work<R>): R;
  atomic<R>(callback: (tx: Database) => R): R;
}
const internal = new WeakMap<Database, Internal>();
function ops(db: Database): Internal {
  const value = internal.get(db);
  if (!value) fail('CLOSED', 'This database handle is not available.');
  return value;
}

export class Database {
  #state: State;
  #lease: Lease | undefined;
  constructor(state: State, lease?: Lease) {
    this.#state = state; this.#lease = lease;
    internal.set(this, {
      check: () => this.#check(), mapped: table => this.#mapped(table),
      writeCheck: () => this.#writeCheck(), tables: state.tables,
      run: work => runSync(work, step => this.#perform(step)),
      atomic: callback => this.#atomic(callback),
    });
  }

  /** Internal lifetime check also blocks a root handle used by an escaped async callback. */
  #check(): void {
    if (this.#state.closed) fail('CLOSED', 'This database is closed.');
    if (this.#state.poisoned) fail('CONNECTION_UNUSABLE', 'Transaction cleanup failed. Open a new database connection.');
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
  table<T extends AnyTable>(table: T): Repository<T> {
    this.#mapped(table);
    return new Repository(this, table);
  }

  #record(operation: Operation, table: string, sql: string, parameters: readonly Parameter[], start: number, rowCount: number, status: 'ok' | 'error', plan?: QueryPlan[]): void {
    recordTrace(this.#state, { operation, table, sql, parameters, start, rowCount, transactionId: this.#state.transactionId, status, ...(plan ? { plan } : {}) });
  }
  /** One shared-core Step: metadata stays untraced, DDL uses exec like #control, everything else is a traced read/write. */
  #perform(step: Step): Rows {
    if (step.metadata) return this.#metadata(step.sql, step.parameters);
    if (step.control) { this.#exec(step.sql, step.operation, step.table); return []; }
    return this.#all(step.sql, step.parameters, step.operation, step.table, step.explain === true);
  }
  #all(sql: string, parameters: readonly Parameter[], operation: Operation, table: string, explain = false): Record<string, unknown>[] {
    this.#check();
    const start = performance.now();
    try {
      const rows = this.#state.handle.all(sql, parameters);
      const plan = explain ? rows.map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) })) : undefined;
      this.#record(operation, table, sql, parameters, start, rows.length, 'ok', plan);
      return rows;
    } catch (error) {
      this.#record(operation, table, sql, parameters, start, 0, 'error');
      throw databaseError(error);
    }
  }
  #control(query: TransactionModel): void {
    this.#exec(compileSqlite(query).sql, 'transaction', '');
  }
  #exec(sql: string, operation: Operation, table: string): void {
    const start = performance.now();
    try {
      this.#state.handle.exec(sql);
      this.#record(operation, table, sql, [], start, 0, 'ok');
    } catch (error) {
      this.#record(operation, table, sql, [], start, 0, 'error');
      throw databaseError(error);
    }
  }

  transaction<R>(callback: (tx: Database) => R extends PromiseLike<unknown> ? never : R): R {
    return this.#atomic(callback);
  }
  #atomic<R>(callback: (tx: Database) => R): R {
    this.#check();
    if (typeof callback !== 'function') fail('ASYNC_CALLBACK', 'A transaction requires a synchronous callback.');
    if (Object.getPrototypeOf(callback)?.constructor?.name === 'AsyncFunction') fail('ASYNC_CALLBACK', 'Async transaction callbacks are not supported.');
    const parent = this.#state.transactionId;
    const nested = this.#state.depth > 0;
    const id = 'tx' + ++this.#state.transactionSequence;
    const savepoint = 'rs_sp_' + this.#state.transactionSequence;
    const control = (action: TransactionAction, name?: string): void => this.#control(queryModel.transaction({ action, ...(name === undefined ? {} : { name }) }));
    this.#state.transactionId = id;
    try { control(nested ? 'savepoint' : this.#state.readOnly ? 'begin' : 'begin-immediate', nested ? savepoint : undefined); }
    catch (error) { this.#state.transactionId = parent; throw error; }
    const lease: Lease = { active: true };
    const tx = new Database(this.#state, lease);
    this.#state.depth++;
    try {
      const result = this.#state.context.run(lease, () => {
        const value = callback(tx);
        // Result getters and Promise hooks must inherit the callback's lease too.
        if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
          if (value instanceof Promise) value.catch(() => {});
          fail('ASYNC_CALLBACK', 'Transaction callbacks must finish synchronously; all work was rolled back.');
        }
        return value;
      });
      control(nested ? 'release' : 'commit', nested ? savepoint : undefined);
      return result as R;
    } catch (error) {
      try {
        if (nested) {
          control('rollback-to', savepoint);
          control('release', savepoint);
        } else if (this.#state.handle.inTransaction()) control('rollback');
        if (!nested && this.#state.handle.inTransaction()) throw new Error('Incomplete cleanup');
      } catch {
        this.#state.poisoned = true;
        try { this.#state.handle.close(); } catch { /* Explicitly unusable even if close also fails. */ }
      }
      throw error;
    } finally {
      lease.active = false;
      this.#state.depth--;
      this.#state.transactionId = parent;
    }
  }

  #metadata(sql: string, parameters: readonly Parameter[] = []): Record<string, unknown>[] {
    this.#check();
    try {
      return this.#state.handle.all(sql, parameters);
    } catch (error) { throw databaseError(error); }
  }
  inspectSchema(options: SchemaInspectionOptions = {}): SchemaTable[] {
    this.#check();
    return ops(this).run(inspectSchemaWork(this.#state.tables, inspectionScope(options)));
  }
  planSchema(): SchemaPlan[] {
    return publicPlans(ops(this).run(schemaPlansWork(ops(this))));
  }
  ensureSchema(): SchemaPlan[] {
    this.#writeCheck();
    return this.transaction(tx => ops(tx).run(ensureSchemaWork(ops(tx))));
  }

  clearTrace(): void {
    this.#check(); clearTraceState(this.#state);
  }
  exportTrace(options: { title?: string } = {}): TraceDocumentV2 {
    this.#check();
    const title = options.title ?? 'Local query trace';
    if (typeof title !== 'string' || title.length > 4096) fail('VALIDATION', 'Trace titles must be bounded text.');
    const registrations = this.#state.tables;
    const scope = registrations.size ? 'mapped' : 'all';
    return traceDocument(this.#state, title, { schema: this.inspectSchema({ scope }), scope, registrations, defaultSchema: 'main' }, []);
  }
  close(): void {
    if (this.#state.closed) return;
    if (this.#state.context.getStore()?.active === false) fail('TRANSACTION_CLOSED', 'This transaction callback has finished; its handle cannot be reused.');
    if (this.#lease || this.#state.depth > 0) fail('TRANSACTION_ACTIVE', 'Close the root database after its transaction callback has finished.');
    try { this.#state.handle.close(); }
    catch (error) { if (!this.#state.poisoned) throw databaseError(error); }
    finally { this.#state.closed = true; clearTraceState(this.#state); }
  }
}

export function openDatabase(filename = ':memory:', options: DatabaseOptions = {}): Database {
  const { readOnly, traceValues, busyTimeoutMs, capacity, tables } = openConfig(filename, options);
  const handle = openSqliteExecutor(filename, { readOnly, busyTimeoutMs });
  return new Database({ handle, tables, closed: false, poisoned: false, readOnly,
    traceValues, capacity, traces: [], sequence: 0, depth: 0,
    transactionSequence: 0, transactionId: null, context: new AsyncLocalStorage(), traceBytes: 0, omittedEntries: 0 });
}

export class Repository<T extends AnyTable> {
  #db: Database;
  #core: RepositoryCore<T>;
  constructor(db: Database, public readonly definition: T) { this.#db = db; this.#core = new RepositoryCore(ops(db), definition); }
  insert(data: InsertRow<T>): Row<T> {
    this.#core.prepareInsert();
    return ops(this.#db).atomic(tx => ops(tx).run(new RepositoryCore(ops(tx), this.definition).insertOne(data)));
  }
  insertMany(rows: readonly InsertRow<T>[]): Row<T>[] {
    this.#core.prepareInsertMany(rows);
    return ops(this.#db).atomic(tx => rows.map(row => ops(tx).run(new RepositoryCore(ops(tx), this.definition).insertOne(row))));
  }
  compileSelect(options: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates> = {}): CompiledQuery {
    return compileSqlite(this.#core.selectPlan(options).model);
  }
  explain(options: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates> = {}): QueryPlan[] {
    return ops(this.#db).run(this.#core.explainWork(this.#core.selectPlan(options).model));
  }
  findMany<I extends Includes = {}, const S extends Selection<T> | undefined = undefined, const A extends RelatedAggregates = {}>(options: FindOptions<I, S, A> = {}): ProjectedRow<WithIncludes<T, I, NoInfer<S>>, A>[] {
    return ops(this.#db).run(this.#core.findMany(options)) as ProjectedRow<WithIncludes<T, I, S>, A>[];
  }
  findFirst<I extends Includes = {}, const S extends Selection<T> | undefined = undefined, const A extends RelatedAggregates = {}>(options: FindOptions<I, S, A> = {}): ProjectedRow<WithIncludes<T, I, NoInfer<S>>, A> | null {
    assertOptions(options, ['where', 'orderBy', 'limit', 'offset', 'include', 'select', 'aggregates']);
    return this.findMany<I, S, A>({ ...options, limit: 1 })[0] ?? null;
  }
  count(where?: Predicate): number {
    return ops(this.#db).run(this.#core.countWork(this.#core.countPrepare(where)));
  }
  compileAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): CompiledQuery {
    return compileSqlite(this.#core.aggregatePlan(options).model);
  }
  compileGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): CompiledQuery {
    return compileSqlite(this.#core.groupPlan(options).model);
  }
  explainAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): QueryPlan[] {
    return ops(this.#db).run(this.#core.explainWork(this.#core.aggregatePlan(options).model));
  }
  explainGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): QueryPlan[] {
    return ops(this.#db).run(this.#core.explainWork(this.#core.groupPlan(options).model));
  }
  aggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): AggregateResult<S> {
    return ops(this.#db).run(this.#core.aggregateWork(this.#core.aggregatePlan(options))) as AggregateResult<S>;
  }
  groupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): GroupResult<T, B, S>[] {
    return ops(this.#db).run(this.#core.groupWork(this.#core.groupPlan(options))) as GroupResult<T, B, S>[];
  }
  #write(data: UpdateRow<T> | null, options: WriteOptions, conflict = false): Row<T>[] {
    const prepared = this.#core.prepareWrite(data, options, conflict);
    return ops(this.#db).atomic(tx => ops(tx).run(new RepositoryCore(ops(tx), this.definition).writeWork(prepared)));
  }
  update(data: UpdateRow<T>, options: WriteOptions): Row<T>[] { return this.#write(data, options); }
  delete(options: WriteOptions): Row<T>[] { return this.#write(null, options); }
  updateVersion(key: KeyRow<T>, expectedVersion: number, data: UpdateRow<T>): Row<T> {
    return this.#write(data, { where: this.#core.versionFilter(key, expectedVersion), maxRows: 1 }, true)[0];
  }
}
