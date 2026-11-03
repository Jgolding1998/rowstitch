import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { NODE_REQUIREMENT, supportedNode } from '../runtime.js';
import { ConflictError, RowstitchError, databaseError, fail } from './errors.js';
import { decode, encode, identifier, isColumnRef, isTable, literal, plainRecord, sqlType,
  type AnyTable, type Columns, type InsertRow, type KeyRow, type Parameter, type Row, type UpdateRow } from './schema.js';
import { ManyRelation, SingularRelation, and, assertOptions, eq, isRelation, orderToModel, predicateToModel, selectionFields, validateRelation,
  type CompiledQuery, type FindOptions, type Includes, type Predicate, type Selection, type WithIncludes } from './predicates.js';
import { mappedCreateTableModel, mappedTableModel } from './model-mapping.js';
import { hasRelationFilter, predicateTruth, queryModel, relationKindsCompatible, type CreateIndexModel, type CreateTableModel, type PredicateModel, type SelectModel, type TransactionAction, type TransactionModel } from './query-model.js';
import { compileSqlite } from './sqlite-compiler.js';
import { aggregateToModel, groupToModel, type AggregateSelection, type AggregateOptions, type AggregateResult,
  type GroupKey, type GroupOptions, type GroupResult } from './aggregates.js';
import { decodeAggregateRow } from './aggregate-decode.js';
import type { AggregateModel, GroupModel } from './query-model.js';

export interface SchemaColumn { name: string; type: string; nullable: boolean; primaryKey: boolean; primaryKeyOrder: number; default: string | null; generated: boolean; hidden: boolean }
export interface SchemaForeignKey { column: string; table: string; target: string; onDelete: string; onUpdate: string }
export interface SchemaIndex { name: string; columns: (string | null)[]; unique: boolean; origin: string; partial: boolean }
export interface SchemaTable { name: string; columns: SchemaColumn[]; foreignKeys: SchemaForeignKey[]; indexes: SchemaIndex[] }
export interface SchemaPlan { table: string; action: 'create-table' | 'create-index'; sql: string }
export interface QueryPlan { id: number; parent: number; detail: string }
type Operation = 'select' | 'insert' | 'update' | 'delete' | 'schema' | 'transaction';
export interface TraceEntry {
  id: string; operation: Operation; table: string; sql: string; parameters: (string | number | null)[];
  durationMs: number; rowCount: number; transactionId: string | null; status: 'ok' | 'error'; plan?: QueryPlan[];
}
export interface TraceDocument {
  format: 'rowstitch-trace'; version: 1; title: string; generatedAt: string; source: 'local-trace';
  schema: { name: string; columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[]; foreignKeys: { column: string; table: string; target: string }[] }[];
  queries: TraceEntry[]; notes: string[];
}
export interface DatabaseOptions {
  tables?: readonly AnyTable[]; readOnly?: boolean; busyTimeoutMs?: number;
  maxTraceEntries?: number; traceValues?: boolean;
}
interface Lease { active: boolean }
interface State {
  handle: DatabaseSync; tables: Map<string, AnyTable>; closed: boolean; poisoned: boolean; readOnly: boolean;
  traceValues: boolean; capacity: number; traces: TraceEntry[]; sequence: number;
  transactionSequence: number; transactionId: string | null; depth: number; context: AsyncLocalStorage<Lease>;
  traceBytes: number; omittedEntries: number;
}
const MAX_TRACE_BYTES = 1_048_576;
const MAX_DOCUMENT_BYTES = 2_097_152;

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('QUERY', 'A numeric option is outside its documented integer range.');
  return n;
}
function small(value: string): string {
  const suffix = '... [truncated]';
  return value.length <= 4096 ? value : value.slice(0, 4096 - suffix.length) + suffix;
}
function foreignIndex(table: AnyTable, name: string): string {
  return 'rs_fk_' + createHash('sha256').update(table.name + '\0' + name).digest('hex').slice(0, 16);
}
function countValue(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('DATA', 'A database count exceeds the supported range.');
  return Number(value);
}

interface Internal {
  check(): void;
  writeCheck(): void;
  mapped(table: AnyTable): void;
  all(sql: string, parameters: readonly Parameter[], operation: Operation, table: string, explain?: boolean): Record<string, unknown>[];
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
      writeCheck: () => this.#writeCheck(),
      all: (...args) => this.#all(...args),
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
    const values = parameters.slice(0, 100).map(v => !this.#state.traceValues ? '[redacted]'
      : typeof v === 'bigint' ? String(v) : typeof v === 'string' ? small(v) : v);
    if (parameters.length > 100) values.push('[additional parameters omitted]');
    const entry: TraceEntry = { id: 'q' + ++this.#state.sequence, operation, table: small(table), sql: small(sql), parameters: values,
      durationMs: Math.round(Math.max(0, performance.now() - start) * 1000) / 1000,
      rowCount, transactionId: this.#state.transactionId, status };
    if (plan) entry.plan = plan.map(p => ({ ...p, detail: small(p.detail) }));
    const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (bytes > MAX_TRACE_BYTES) { this.#state.omittedEntries++; return; }
    this.#state.traces.push(entry);
    this.#state.traceBytes += bytes;
    while (this.#state.traces.length > this.#state.capacity || this.#state.traceBytes > MAX_TRACE_BYTES) {
      this.#state.traceBytes -= Buffer.byteLength(JSON.stringify(this.#state.traces.shift()!), 'utf8');
      this.#state.omittedEntries++;
    }
  }
  #all(sql: string, parameters: readonly Parameter[], operation: Operation, table: string, explain = false): Record<string, unknown>[] {
    this.#check();
    const start = performance.now();
    try {
      const stmt = this.#state.handle.prepare(sql);
      stmt.setReadBigInts(true);
      const rows = stmt.all(...parameters);
      const plan = explain ? rows.map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) })) : undefined;
      this.#record(operation, table, sql, parameters, start, rows.length, 'ok', plan);
      return rows;
    } catch (error) {
      this.#record(operation, table, sql, parameters, start, 0, 'error');
      throw databaseError(error);
    }
  }
  #control(query: TransactionModel | CreateTableModel | CreateIndexModel, table = ''): void {
    const { sql } = compileSqlite(query);
    const operation = query.kind === 'transaction' ? 'transaction' : 'schema';
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
        } else if (this.#state.handle.isTransaction) control('rollback');
        if (!nested && this.#state.handle.isTransaction) throw new Error('Incomplete cleanup');
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
      const stmt = this.#state.handle.prepare(sql);
      stmt.setReadBigInts(true);
      return stmt.all(...parameters);
    } catch (error) { throw databaseError(error); }
  }
  inspectSchema(): SchemaTable[] {
    const tables = this.#metadata("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name LIMIT 101");
    if (tables.length > 100) fail('RESULT_LIMIT', 'Schema inspection supports at most 100 tables.');
    return tables.map(t => {
      const name = String(t.name);
      const columns = this.#metadata('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid LIMIT 101', [name]);
      if (columns.length > 100) fail('SCHEMA', 'Schema inspection supports at most 100 columns per table.');
      const foreignKeys = this.#metadata('SELECT "from", "to", "table", seq, on_delete, on_update FROM pragma_foreign_key_list(?) LIMIT 101', [name]);
      const indices = this.#metadata('SELECT name, "unique", origin, partial FROM pragma_index_list(?) LIMIT 101', [name]);
      if (foreignKeys.length > 100 || indices.length > 100) fail('RESULT_LIMIT', 'Schema inspection exceeded its key or index limit.');
      const primary = columns.filter(c => c.pk !== 0n);
      const rowidKey = primary.length === 1 && String(primary[0].type).toUpperCase() === 'INTEGER'
        && !indices.some(i => i.origin === 'pk');
      const parentKeys = new Map<string, string[]>();
      const target = (f: Record<string, unknown>): string => {
        if (f.to !== null) return String(f.to);
        const parent = String(f.table);
        if (!parentKeys.has(parent)) parentKeys.set(parent, this.#metadata('SELECT name FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk LIMIT 101', [parent]).map(c => String(c.name)));
        return parentKeys.get(parent)?.[Number(f.seq)] ?? '(unresolved implicit primary key)';
      };
      return {
        name,
        columns: columns.map(c => ({ name: String(c.name), type: String(c.type).toLowerCase(), nullable: c.notnull === 0n && !(rowidKey && c.pk !== 0n),
          primaryKey: c.pk !== 0n, primaryKeyOrder: Number(c.pk), default: c.dflt_value === null ? null : String(c.dflt_value), generated: c.hidden === 2n || c.hidden === 3n, hidden: c.hidden === 1n })),
        foreignKeys: foreignKeys.map(f => ({ column: String(f.from), table: String(f.table), target: target(f), onDelete: String(f.on_delete).toLowerCase(), onUpdate: String(f.on_update).toLowerCase() })),
        indexes: indices.map(i => ({ name: String(i.name), unique: i.unique === 1n, origin: String(i.origin), partial: i.partial === 1n,
          columns: this.#metadata('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 101', [String(i.name)]).map(c => c.name === null ? null : String(c.name)) })),
      };
    });
  }

  #schemaPlans(): (SchemaPlan & { model: CreateTableModel | CreateIndexModel })[] {
    this.#check();
    const actual = this.inspectSchema();
    const plans: (SchemaPlan & { model: CreateTableModel | CreateIndexModel })[] = [];
    const add = (table: string, action: SchemaPlan['action'], model: CreateTableModel | CreateIndexModel): void => { plans.push({ table, action, model, sql: compileSqlite(model).sql }); };
    for (const table of this.#state.tables.values()) {
      const found = actual.find(t => t.name.toLowerCase() === table.name.toLowerCase());
      const columns = Object.entries(table.columns as Columns);
      for (const [, c] of columns) {
        const fk = c.config.foreignKey;
        if (fk && this.#state.tables.get(fk.table.name) !== fk.table) fail('SCHEMA', 'Foreign-key targets must be registered on the same database.');
      }
      if (!found) add(table.name, 'create-table', mappedCreateTableModel(table));
      else {
        const expectedPrimary = columns.filter(([, c]) => c.config.primary).map(([n]) => n);
        const actualPrimary = found.columns.filter(c => c.primaryKey).sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder).map(c => c.name);
        let drift = found.name !== table.name || found.columns.length !== columns.length || JSON.stringify(expectedPrimary) !== JSON.stringify(actualPrimary)
          || found.columns.some(c => c.generated || c.hidden);
        for (const [name, c] of columns) {
          const a = found.columns.find(v => v.name === name);
          if (!a || a.type !== sqlType(c.config).toLowerCase() || a.nullable !== c.config.nullable
              || a.default !== (c.config.hasDefault ? literal(c.config.defaultValue!) : null)) drift = true;
          const expectedUnique = c.config.unique;
          const actualUnique = found.indexes.some(i => i.unique && i.origin !== 'pk' && i.columns.length === 1 && i.columns[0] === name && !i.partial);
          if (expectedUnique !== actualUnique) drift = true;
        }
        for (const index of found.indexes) {
          if (index.unique && index.origin !== 'pk' && (index.partial || index.columns.length !== 1 || index.columns[0] === null
              || !Object.hasOwn(table.columns, index.columns[0]) || !table.columns[index.columns[0]].config.unique)) drift = true;
        }
        const expectedFk = columns.filter(([, c]) => c.config.foreignKey).map(([name, c]) => {
          const f = c.config.foreignKey!;
          return [name, f.table.name, f.column, f.onDelete, 'no action'].join('\0');
        }).sort();
        const actualFk = found.foreignKeys.map(f => [f.column, f.table, f.target, f.onDelete, f.onUpdate].join('\0')).sort();
        if (JSON.stringify(expectedFk) !== JSON.stringify(actualFk)) drift = true;
        if (drift) fail('SCHEMA_DRIFT', 'An existing table is incompatible with its mapping. No destructive schema changes were made.');
      }
      for (const [name, c] of columns) {
        if (!c.config.foreignKey) continue;
        const indexName = foreignIndex(table, name);
        const index = found?.indexes.find(i => i.name === indexName);
        if (index && (index.unique || index.partial || index.columns.length !== 1 || index.columns[0] !== name)) fail('SCHEMA_DRIFT', 'An existing relation index is incompatible with its mapping.');
        if (!index) add(table.name, 'create-index', queryModel.createIndex({ table: mappedTableModel(table), name: indexName, columns: [name] }));
      }
    }
    return plans;
  }
  planSchema(): SchemaPlan[] {
    return this.#schemaPlans().map(({ table, action, sql }) => ({ table, action, sql }));
  }
  ensureSchema(): SchemaPlan[] {
    this.#writeCheck();
    return this.transaction(tx => {
      const plans = tx.#schemaPlans();
      for (const plan of plans) tx.#control(plan.model, plan.table);
      return plans.map(({ table, action, sql }) => ({ table, action, sql }));
    });
  }

  clearTrace(): void {
    this.#check(); this.#state.traces.length = 0; this.#state.traceBytes = 0; this.#state.omittedEntries = 0;
  }
  exportTrace(options: { title?: string } = {}): TraceDocument {
    this.#check();
    const title = options.title ?? 'Local query trace';
    if (typeof title !== 'string' || title.length > 4096) fail('VALIDATION', 'Trace titles must be bounded text.');
    const document: TraceDocument = {
      format: 'rowstitch-trace', version: 1, title, generatedAt: new Date().toISOString(), source: 'local-trace',
      schema: this.inspectSchema().map(t => ({ name: small(t.name), columns: t.columns.map(c => ({ name: small(c.name), type: c.type, nullable: c.nullable, primaryKey: c.primaryKey })),
        foreignKeys: t.foreignKeys.map(f => ({ column: small(f.column), table: small(f.table), target: small(f.target) })) })),
      queries: [],
      notes: [this.#state.traceValues ? 'Bound values were explicitly included. Review before sharing.' : 'Bound values are redacted at collection time.',
        'Schema names, identifiers, SQL literals and titles may still be sensitive. Redaction is not anonymization.',
        'History is limited to ' + this.#state.capacity + ' entries and one MiB of serialized entries. Oversized entries and oldest entries may be omitted; ' + this.#state.omittedEntries + ' entries have been omitted since Clear.',
        'Exports may omit more oldest entries to fit two MiB. Internal schema introspection is excluded.'],
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    if (baseBytes > MAX_DOCUMENT_BYTES) fail('TRACE_LIMIT', 'This schema and title exceed the two-MiB trace export limit. Inspect the schema locally instead.');
    const entries = this.#state.traces;
    const sizes = entries.map(e => Buffer.byteLength(JSON.stringify(e), 'utf8'));
    let total = sizes.reduce((sum, size) => sum + size, 0);
    let first = 0;
    while (baseBytes + total + Math.max(0, entries.length - first - 1) > MAX_DOCUMENT_BYTES) total -= sizes[first++];
    document.queries = entries.slice(first).map(e => ({ ...e, parameters: [...e.parameters], ...(e.plan ? { plan: e.plan.map(p => ({ ...p })) } : {}) }));
    return document;
  }
  close(): void {
    if (this.#state.closed) return;
    if (this.#state.context.getStore()?.active === false) fail('TRANSACTION_CLOSED', 'This transaction callback has finished; its handle cannot be reused.');
    if (this.#lease || this.#state.depth > 0) fail('TRANSACTION_ACTIVE', 'Close the root database after its transaction callback has finished.');
    try { this.#state.handle.close(); }
    catch (error) { if (!this.#state.poisoned) throw databaseError(error); }
    finally { this.#state.closed = true; this.#state.traces.length = 0; this.#state.traceBytes = 0; this.#state.omittedEntries = 0; }
  }
}

export function openDatabase(filename = ':memory:', options: DatabaseOptions = {}): Database {
  if (!supportedNode(process.versions.node)) fail('UNSUPPORTED_RUNTIME', 'Rowstitch requires ' + NODE_REQUIREMENT + '.');
  if (typeof filename !== 'string' || !filename.length || filename.includes('\0')) fail('VALIDATION', 'Choose a local SQLite filename or :memory:.');
  assertOptions(options, ['tables', 'readOnly', 'busyTimeoutMs', 'maxTraceEntries', 'traceValues']);
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean'
      || options.traceValues !== undefined && typeof options.traceValues !== 'boolean') fail('VALIDATION', 'readOnly and traceValues must be booleans when supplied.');
  const timeout = integer(options.busyTimeoutMs, 1000, 0, 10_000);
  const capacity = integer(options.maxTraceEntries, 200, 1, 1000);
  const tables = new Map<string, AnyTable>();
  const names = new Set<string>();
  if (!Array.isArray(options.tables ?? []) || (options.tables?.length ?? 0) > 100) fail('SCHEMA', 'Register at most 100 mapped tables.');
  for (const table of options.tables ?? []) {
    if (!isTable(table) || names.has(table.name.toLowerCase())) fail('SCHEMA', 'Register genuine mapped tables with unique names.');
    identifier(table.name);
    names.add(table.name.toLowerCase()); tables.set(table.name, table);
  }
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(filename, { readOnly: options.readOnly === true, timeout,
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
    handle.enableDefensive(true);
    handle.exec('PRAGMA trusted_schema = OFF');
    if (handle.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Foreign keys unavailable');
  } catch {
    try { handle?.close(); } catch { /* Do not leak an incompletely initialized handle. */ }
    return fail('OPEN', 'The local SQLite database could not be opened with the required safety settings.');
  }
  return new Database({ handle, tables, closed: false, poisoned: false, readOnly: options.readOnly === true,
    traceValues: options.traceValues === true, capacity, traces: [], sequence: 0, depth: 0,
    transactionSequence: 0, transactionId: null, context: new AsyncLocalStorage(), traceBytes: 0, omittedEntries: 0 });
}

export interface WriteOptions { where: Predicate; maxRows?: number }

export class Repository<T extends AnyTable> {
  #db: Database;
  constructor(db: Database, public readonly definition: T) { this.#db = db; }
  #predicate(where?: Predicate): PredicateModel | undefined {
    return predicateToModel(this.definition, where, table => ops(this.#db).mapped(table));
  }
  #columns(): [string, Columns[string]][] { return Object.entries(this.definition.columns as Columns); }
  #decodeRow(row: Record<string, unknown>, fields = this.#columns().map(([name]) => name)): Row<T> {
    const result: Record<string, unknown> = {};
    for (const name of fields) result[name] = decode(this.definition.columns[name].config, row[name]);
    return result as Row<T>;
  }
  #fetchFields(select: readonly string[] | undefined, includes: Includes | undefined, extra: readonly string[] = [], depth = 0): string[] {
    const fields = new Set([...selectionFields(this.definition, select), ...extra]);
    if (includes === undefined) return [...fields];
    plainRecord(includes);
    const entries = Object.entries(includes);
    if (entries.length > 8 || entries.length && depth >= 4) fail('QUERY', 'Eager relationships support at most four levels and eight includes per level.');
    for (const [name, relation] of entries) {
      identifier(name);
      if (Object.hasOwn(this.definition.columns, name) || !isRelation(relation)) fail('QUERY', 'An include needs a distinct alias and a Rowstitch relationship descriptor.');
      ops(this.#db).mapped(relation.table);
      validateRelation(relation.table, relation.options, relation instanceof SingularRelation);
      new Repository(this.#db, relation.table).#predicate(relation.options.where);
      const { localKey, foreignKey } = relation.options;
      if (!isColumnRef(localKey) || !isColumnRef(foreignKey) || localKey.table !== this.definition || foreignKey.table !== relation.table) fail('QUERY', 'Relationship keys must reference their respective mapped tables.');
      const source = this.definition.columns[localKey.name].config;
      const target = relation.table.columns[foreignKey.name].config;
      if (!relationKindsCompatible(source.kind, target.kind)) fail('QUERY', 'Relationship keys must be compatible scalar columns.');
      fields.add(localKey.name);
      new Repository(this.#db, relation.table).#fetchFields(relation.options.select, relation.options.include, [foreignKey.name], depth + 1);
    }
    if (entries.length) for (const [name, c] of this.#columns()) if (c.config.primary) fields.add(name);
    return [...fields];
  }
  #materialize(row: Row<T>, includes: Includes | undefined, select: readonly string[] | undefined, budget: { remaining: number }): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of selectionFields(this.definition, select)) {
      const value = row[field];
      result[field] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
    }
    for (const [name, relation] of Object.entries(includes ?? {})) {
      const repository = new Repository(this.#db, relation.table);
      const child = (value: Row<AnyTable>): Record<string, unknown> => {
        if (--budget.remaining < 0) fail('RESULT_LIMIT', 'Eager results exceeded 10,000 related row copies. Narrow the root query or per-parent limits.');
        return repository.#materialize(value, relation.options.include, relation.options.select, budget);
      };
      const value = (row as Record<string, unknown>)[name];
      result[name] = relation instanceof ManyRelation ? (value as Row<AnyTable>[]).map(child)
        : value === null ? null : child(value as Row<AnyTable>);
    }
    return result;
  }
  #data(data: unknown, insert: boolean): [string[], Parameter[]] {
    plainRecord(data);
    const record = data as Record<string, unknown>;
    const names = Object.keys(record);
    for (const name of names) {
      const c = this.definition.columns[name];
      if (!Object.hasOwn(this.definition.columns, name) || !c || !insert && (c.config.primary || name === this.definition.version)) fail('VALIDATION', 'The record contains an unknown or non-editable column.');
    }
    const fields: string[] = [], values: Parameter[] = [];
    for (const [name, c] of this.#columns()) {
      if (Object.hasOwn(record, name)) {
        if (record[name] === undefined) fail('VALIDATION', 'Omit optional fields instead of assigning undefined.');
        fields.push(name); values.push(encode(c.config, record[name]));
      } else if (insert && !c.config.nullable && !c.config.hasDefault && !c.config.generated) fail('VALIDATION', 'A required insert column is missing.');
    }
    if (!insert && !fields.length) fail('VALIDATION', 'An update must provide at least one editable value.');
    return [fields, values];
  }
  #insertOne(data: InsertRow<T>): Row<T> {
    const [fields, values] = this.#data(data, true);
    const query = compileSqlite(queryModel.insert({ table: mappedTableModel(this.definition), columns: fields, values }));
    const rows = ops(this.#db).all(query.sql, query.parameters, 'insert', this.definition.name);
    if (rows.length !== 1) fail('DATA', 'An insert did not return one record.');
    return this.#decodeRow(rows[0]);
  }
  insert(data: InsertRow<T>): Row<T> {
    ops(this.#db).mapped(this.definition); ops(this.#db).writeCheck();
    return ops(this.#db).atomic(tx => new Repository(tx, this.definition).#insertOne(data));
  }
  insertMany(rows: readonly InsertRow<T>[]): Row<T>[] {
    ops(this.#db).mapped(this.definition); ops(this.#db).writeCheck();
    if (!Array.isArray(rows) || rows.length > 1000) fail('VALIDATION', 'Insert at most 1,000 records in one batch.');
    return ops(this.#db).atomic(tx => rows.map(row => new Repository(tx, this.definition).#insertOne(row)));
  }
  #selectModel(options: FindOptions<Includes, Selection<T> | undefined>): SelectModel {
    ops(this.#db).mapped(this.definition);
    assertOptions(options, ['where', 'orderBy', 'limit', 'offset', 'include', 'select']);
    const fields = this.#fetchFields(options.select, options.include);
    const limit = integer(options.limit, 1000, 0, 10_000);
    const offset = integer(options.offset, 0, 0, 1_000_000_000);
    const where = this.#predicate(options.where);
    return queryModel.select({ table: mappedTableModel(this.definition), columns: fields, ...(where === undefined ? {} : { where }),
      orderBy: orderToModel(this.definition, options.orderBy, true), limit, offset });
  }
  compileSelect(options: FindOptions<Includes, Selection<T> | undefined> = {}): CompiledQuery {
    return compileSqlite(this.#selectModel(options));
  }
  explain(options: FindOptions<Includes, Selection<T> | undefined> = {}): QueryPlan[] {
    const query = compileSqlite(queryModel.explain({ query: this.#selectModel(options) }));
    return ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name, true)
      .map(r => ({ id: Number(r.id), parent: Number(r.parent), detail: String(r.detail) }));
  }
  findMany<I extends Includes = {}, const S extends Selection<T> | undefined = undefined>(options: FindOptions<I, S> = {}): WithIncludes<T, I, NoInfer<S>>[] {
    const query = this.compileSelect(options);
    const fields = this.#fetchFields(options.select, options.include);
    const rows = ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name).map(row => this.#decodeRow(row, fields));
    this.#loadIncludes(rows, options.include, { remaining: 10_000 }, 0);
    const budget = { remaining: 10_000 };
    return rows.map(row => this.#materialize(row, options.include, options.select, budget)) as WithIncludes<T, I, S>[];
  }
  findFirst<I extends Includes = {}, const S extends Selection<T> | undefined = undefined>(options: FindOptions<I, S> = {}): WithIncludes<T, I, NoInfer<S>> | null {
    assertOptions(options, ['where', 'orderBy', 'limit', 'offset', 'include', 'select']);
    return this.findMany<I, S>({ ...options, limit: 1 })[0] ?? null;
  }
  count(where?: Predicate): number {
    ops(this.#db).mapped(this.definition);
    return this.#countModel(this.#predicate(where));
  }
  #countModel(where: PredicateModel | undefined): number {
    const query = compileSqlite(queryModel.count({ table: mappedTableModel(this.definition), ...(where === undefined ? {} : { where }) }));
    const rows = ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name);
    return countValue(rows[0].n);
  }

  #aggregateModel(options: unknown): AggregateModel {
    ops(this.#db).mapped(this.definition);
    return aggregateToModel(this.definition, options, where => this.#predicate(where));
  }
  #groupModel(options: unknown): GroupModel {
    ops(this.#db).mapped(this.definition);
    return groupToModel(this.definition, options, where => this.#predicate(where));
  }
  compileAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): CompiledQuery {
    return compileSqlite(this.#aggregateModel(options));
  }
  compileGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): CompiledQuery {
    return compileSqlite(this.#groupModel(options));
  }
  #explainAggregate(model: AggregateModel | GroupModel): QueryPlan[] {
    const query = compileSqlite(queryModel.explain({ query: model }));
    return ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name, true)
      .map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) }));
  }
  explainAggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): QueryPlan[] {
    return this.#explainAggregate(this.#aggregateModel(options));
  }
  explainGroupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): QueryPlan[] {
    return this.#explainAggregate(this.#groupModel(options));
  }
  aggregate<const S extends AggregateSelection>(options: AggregateOptions<S>): AggregateResult<S> {
    const model = this.#aggregateModel(options), query = compileSqlite(model);
    const rows = ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name);
    if (rows.length !== 1) fail('DATA', 'An aggregate query must return one result.');
    return decodeAggregateRow(this.definition, model, rows[0]) as AggregateResult<S>;
  }
  groupBy<const B extends readonly GroupKey<T>[], const S extends AggregateSelection>(options: GroupOptions<T, B, S>): GroupResult<T, B, S>[] {
    const model = this.#groupModel(options), query = compileSqlite(model);
    const rows = ops(this.#db).all(query.sql, query.parameters, 'select', this.definition.name);
    if (model.overflow && rows.length > 10_000) fail('RESULT_LIMIT', 'Grouped results exceed 10,000 rows. Add an explicit limit and offset to page the groups.');
    return rows.map(row => decodeAggregateRow(this.definition, model, row)) as GroupResult<T, B, S>[];
  }

  #loadIncludes(rows: Row<T>[], includes: Includes | undefined, budget: { remaining: number }, depth: number): void {
    if (includes === undefined) return;
    plainRecord(includes);
    const entries = Object.entries(includes);
    if (entries.length && depth >= 4 || entries.length > 8) fail('QUERY', 'Eager relationships support at most four levels and eight includes per level.');
    for (const [name, relation] of entries) {
      identifier(name);
      if (Object.hasOwn(this.definition.columns, name) || !isRelation(relation)) fail('QUERY', 'An include must have a unique name and be built with a Rowstitch relationship helper.');
      ops(this.#db).mapped(relation.table);
      const { localKey, foreignKey } = relation.options;
      if (!isColumnRef(localKey) || !isColumnRef(foreignKey) || localKey.table !== this.definition || foreignKey.table !== relation.table) fail('QUERY', 'Relationship keys must reference their respective mapped tables.');
      const localKind = this.definition.columns[localKey.name].config.kind;
      if (!relationKindsCompatible(localKind, relation.table.columns[foreignKey.name].config.kind)) fail('QUERY', 'Relationship keys must be compatible scalar columns.');
      const key = (value: unknown): string => localKind === 'text' ? 's:' + String(value) : 'i:' + String(value);
      const correlateKeys = localKind === 'text' && relation.table.columns[foreignKey.name].config.kind === 'text';
      const values = [...new Map(rows.filter(row => row[localKey.name] !== null).map(row => [key(row[localKey.name]), row[localKey.name]])).values()];
      const many = relation instanceof ManyRelation;
      const limit = many ? integer(relation.options.limit, 100, 0, 1000) : 2;
      const offset = many ? integer(relation.options.offset, 0, 0, 1_000_000_000) : 0;
      const repository = new Repository(this.#db, relation.table);
      const fields = repository.#fetchFields(relation.options.select, relation.options.include, [foreignKey.name], depth + 1);
      const children: Row<AnyTable>[] = [];
      const sourceKeys = new WeakMap<object, string>();
      const where = repository.#predicate(relation.options.where);
      const ordering = orderToModel(relation.table, relation.options.orderBy, true);
      for (let index = 0; index < values.length && limit > 0; index += 400) {
        const chunk = values.slice(index, index + 400);
        // Both integer codecs use SQLite INTEGER; bind the validated source value
        // losslessly instead of forcing number IDs through the bigint JS codec.
        const encoded = chunk.map(value => encode(this.definition.columns[localKey.name].config, value));
        const query = compileSqlite(queryModel.relation({ table: mappedTableModel(relation.table), columns: fields, partitionBy: foreignKey.name, keys: encoded,
          ...(correlateKeys ? { correlateKeys: true } : {}), ...(where === undefined ? {} : { where }), orderBy: ordering, offset, limit, readLimit: budget.remaining + 1 }));
        const result = ops(this.#db).all(query.sql, query.parameters, 'select', relation.table.name).map(row => {
          const decoded = repository.#decodeRow(row, fields);
          if (correlateKeys) {
            const ordinal = row.__rs_parent;
            if (typeof ordinal !== 'bigint' || ordinal < 0n || ordinal >= BigInt(chunk.length)) fail('DATA', 'A relationship returned an invalid source-key ordinal.');
            sourceKeys.set(decoded, key(chunk[Number(ordinal)]));
          }
          return decoded;
        });
        if (result.length > budget.remaining) fail('RESULT_LIMIT', 'Eager relationships exceeded 10,000 related rows. Narrow the root query or per-parent limits.');
        budget.remaining -= result.length;
        children.push(...result);
      }
      const groups = new Map<string, Row<AnyTable>[]>();
      for (const child of children) {
        const k = correlateKeys ? sourceKeys.get(child)! : key(child[foreignKey.name]);
        const list = groups.get(k) ?? []; list.push(child); groups.set(k, list);
      }
      if (!many && [...groups.values()].some(group => group.length > 1)) fail('RELATION_CARDINALITY', 'A singular relationship matched more than one target row. Add a unique constraint or narrow its filter.');
      repository.#loadIncludes(children, relation.options.include, budget, depth + 1);
      for (const row of rows) {
        const group = row[localKey.name] === null ? [] : groups.get(key(row[localKey.name])) ?? [];
        (row as Record<string, unknown>)[name] = many ? group : group[0] ?? null;
      }
    }
  }

  #write(data: UpdateRow<T> | null, options: WriteOptions, conflict = false): Row<T>[] {
    ops(this.#db).mapped(this.definition); ops(this.#db).writeCheck();
    assertOptions(options, ['where', 'maxRows']);
    const predicate = this.#predicate(options.where);
    if (hasRelationFilter(predicate)) fail('UNSAFE_WRITE', 'Relation filters currently support reads only. Use explicit key filters for guarded writes.');
    if (predicate === undefined || predicateTruth(predicate) === true) fail('UNSAFE_WRITE', 'Updates and deletes require a meaningful filter. Whole-table writes have no implicit opt-in.');
    const max = integer(options.maxRows, 100, 0, 10_000);
    const [fields, values] = data === null ? [[], []] : this.#data(data, false);
    return ops(this.#db).atomic(tx => {
      const repository = new Repository(tx, this.definition);
      const matched = repository.#countModel(predicate);
      if (matched > max) fail('AFFECTED_ROWS', 'The filter matches more records than maxRows allows. No records were changed.');
      if (!matched && conflict) throw new ConflictError();
      if (!matched) return [];
      const table = mappedTableModel(this.definition);
      const model = data === null ? queryModel.delete({ table, where: predicate })
        : queryModel.update({ table, where: predicate, assignments: fields.map((column, i) => ({ column, value: values[i] })) });
      const query = compileSqlite(model);
      const result = ops(tx).all(query.sql, query.parameters, data === null ? 'delete' : 'update', this.definition.name).map(row => repository.#decodeRow(row));
      if (result.length !== matched || result.length > max) fail('AFFECTED_ROWS', 'Affected records did not match the guarded count. The transaction was rolled back.');
      return result;
    });
  }
  update(data: UpdateRow<T>, options: WriteOptions): Row<T>[] { return this.#write(data, options); }
  delete(options: WriteOptions): Row<T>[] { return this.#write(null, options); }
  updateVersion(key: KeyRow<T>, expectedVersion: number, data: UpdateRow<T>): Row<T> {
    ops(this.#db).mapped(this.definition);
    if (!this.definition.version || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) fail('VALIDATION', 'A versioned update needs a mapped version column and an incrementable expected version.');
    plainRecord(key);
    const primary = this.#columns().filter(([, c]) => c.config.primary).map(([name]) => name);
    if (Object.keys(key).length !== primary.length || !primary.every(name => Object.hasOwn(key, name))) fail('VALIDATION', 'Provide every primary-key column, and no other key fields.');
    const filters = primary.map(name => eq(this.definition.col(name), (key as Record<string, unknown>)[name]));
    filters.push(eq(this.definition.col(this.definition.version), expectedVersion));
    return this.#write(data, { where: and(...filters), maxRows: 1 }, true)[0];
  }
}
