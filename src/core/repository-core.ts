/**
 * Shared repository and schema logic for the synchronous and asynchronous public APIs.
 *
 * Every database read or write is expressed as a yielded Step. The synchronous Database runs a Work generator to
 * completion inline; AsyncDatabase awaits each Step through its session. Planning, validation, lowering, budgets and
 * decoding therefore exist once and behave identically in both APIs. Nothing here touches a connection directly.
 */
import { createHash } from 'node:crypto';
import { NODE_REQUIREMENT, supportedNode } from '../runtime.js';
import { ConflictError, fail } from './errors.js';
import { decode, encode, identifier, isColumnRef, isTable, literal, plainRecord, sqlType,
  type AnyTable, type Columns, type InsertRow, type KeyRow, type Parameter, type Row, type UpdateRow } from './schema.js';
import { ManyRelation, SingularRelation, and, assertOptions, eq, isRelation, orderToModel, predicateToModel, selectionFields, validateRelation,
  type FindOptions, type Includes, type LoweringBudget, type Predicate, type Selection } from './predicates.js';
import { mappedCreateTableModel, mappedTableModel } from './model-mapping.js';
import { hasRelationFilter, predicateTruth, queryModel, relationKindsCompatible, MAX_RELATION_KEYS,
  type AggregateModel, type CreateIndexModel, type CreateTableModel, type GroupModel, type PredicateModel, type QueryModel, type SelectModel } from './query-model.js';
import { compileSqlite } from './sqlite-compiler.js';
import type { DialectQuery, RepositoryDialect } from './dialect.js';
import { aggregateToPlan, groupToPlan, type AggregateLowering, type AggregatePlan, type RelatedAggregates } from './aggregates.js';
import { decodeAggregateRow } from './aggregate-decode.js';
import { assertProjectedGuard, decodeProjectedRow, projectedAggregatesToModel, type ProjectedPlan } from './projected-aggregates.js';

export type Operation = 'select' | 'insert' | 'update' | 'delete' | 'schema' | 'transaction';
export type Rows = Record<string, unknown>[];
/**
 * One database request. `metadata` steps are schema introspection and are never traced. `control` steps are DDL run as
 * a single statement and traced like the synchronous #control path. `explain` steps carry a query plan into the trace.
 */
export interface Step {
  readonly sql: string; readonly parameters: readonly Parameter[]; readonly operation: Operation; readonly table: string;
  readonly explain?: boolean; readonly metadata?: boolean; readonly control?: boolean;
  /** Trusted compiler result contract, evaluated before any logical row is exposed. */
  readonly decode?: (result: unknown) => Rows;
  /** Internal dialect classification, evaluated after session acknowledgment and trace bookkeeping. */
  readonly mapError?: (error: unknown) => unknown;
}
export type Work<R> = Generator<Step, R, Rows>;
export function* request(step: Step): Work<Rows> { return yield step; }

export interface SchemaColumn { name: string; type: string; nullable: boolean; primaryKey: boolean; primaryKeyOrder: number; default: string | null; generated: boolean; hidden: boolean }
export interface SchemaForeignKey { column: string; table: string; target: string; onDelete: string; onUpdate: string }
export interface SchemaIndex { name: string; columns: (string | null)[]; unique: boolean; origin: string; partial: boolean }
export interface SchemaTable { name: string; columns: SchemaColumn[]; foreignKeys: SchemaForeignKey[]; indexes: SchemaIndex[] }
export interface SchemaPlan { table: string; action: 'create-table' | 'create-index'; sql: string }
export interface QueryPlan { id: number; parent: number; detail: string }
export interface WriteOptions { where: Predicate; maxRows?: number }
export type PlannedSchema = SchemaPlan & { model: CreateTableModel | CreateIndexModel };

/** What the shared logic needs from a database handle: lifetime/registration checks and the registered tables. */
export interface CoreContext {
  check(): void;
  writeCheck(): void;
  mapped(table: AnyTable): void;
  readonly tables: ReadonlyMap<string, AnyTable>;
  readonly dialect?: RepositoryDialect;
}

export function compileFor(ctx: CoreContext, model: QueryModel): DialectQuery {
  return ctx.dialect ? ctx.dialect.compile(model) : compileSqlite(model);
}

export function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('QUERY', 'A numeric option is outside its documented integer range.');
  return n;
}
export interface OpenConfig { readOnly: boolean; traceValues: boolean; busyTimeoutMs: number; capacity: number; tables: Map<string, AnyTable> }
/** Validation shared by openDatabase and openAsyncDatabase, in the synchronous order. `extraKeys` are allowed but not checked here. */
export function openConfig(filename: unknown, options: Record<string, unknown> | object, extraKeys: readonly string[] = []): OpenConfig {
  if (!supportedNode(process.versions.node)) fail('UNSUPPORTED_RUNTIME', 'Rowstitch requires ' + NODE_REQUIREMENT + '.');
  if (typeof filename !== 'string' || !filename.length || filename.includes('\0')) fail('VALIDATION', 'Choose a local SQLite filename or :memory:.');
  assertOptions(options, ['tables', 'readOnly', 'busyTimeoutMs', 'maxTraceEntries', 'traceValues', ...extraKeys]);
  const o = options as { tables?: readonly AnyTable[]; readOnly?: unknown; traceValues?: unknown; busyTimeoutMs?: number; maxTraceEntries?: number };
  if (o.readOnly !== undefined && typeof o.readOnly !== 'boolean'
      || o.traceValues !== undefined && typeof o.traceValues !== 'boolean') fail('VALIDATION', 'readOnly and traceValues must be booleans when supplied.');
  const busyTimeoutMs = integer(o.busyTimeoutMs, 1000, 0, 10_000);
  const capacity = integer(o.maxTraceEntries, 200, 1, 1000);
  const tables = new Map<string, AnyTable>();
  const names = new Set<string>();
  if (!Array.isArray(o.tables ?? []) || (o.tables?.length ?? 0) > 100) fail('SCHEMA', 'Register at most 100 mapped tables.');
  for (const table of o.tables ?? []) {
    if (!isTable(table) || names.has(table.name.toLowerCase())) fail('SCHEMA', 'Register genuine mapped tables with unique names.');
    identifier(table.name);
    names.add(table.name.toLowerCase()); tables.set(table.name, table);
  }
  return { readOnly: o.readOnly === true, traceValues: o.traceValues === true, busyTimeoutMs, capacity, tables };
}
function foreignIndex(table: AnyTable, name: string): string {
  return 'rs_fk_' + createHash('sha256').update(table.name + '\0' + name).digest('hex').slice(0, 16);
}
function countValue(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('DATA', 'A database count exceeds the supported range.');
  return Number(value);
}
const toPlan = (rows: Rows): QueryPlan[] => rows.map(row => ({ id: Number(row.id), parent: Number(row.parent), detail: String(row.detail) }));

// ------------------------------------------------------------------------------------------------ schema

export function* inspectSchemaWork(): Work<SchemaTable[]> {
  const metadata = (sql: string, parameters: readonly Parameter[] = []): Work<Rows> => request({ sql, parameters, operation: 'select', table: '', metadata: true });
  const tables = yield* metadata("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name LIMIT 101");
  if (tables.length > 100) fail('RESULT_LIMIT', 'Schema inspection supports at most 100 tables.');
  const result: SchemaTable[] = [];
  for (const t of tables) {
    const name = String(t.name);
    const columns = yield* metadata('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid LIMIT 101', [name]);
    if (columns.length > 100) fail('SCHEMA', 'Schema inspection supports at most 100 columns per table.');
    const foreignKeys = yield* metadata('SELECT "from", "to", "table", seq, on_delete, on_update FROM pragma_foreign_key_list(?) LIMIT 101', [name]);
    const indices = yield* metadata('SELECT name, "unique", origin, partial FROM pragma_index_list(?) LIMIT 101', [name]);
    if (foreignKeys.length > 100 || indices.length > 100) fail('RESULT_LIMIT', 'Schema inspection exceeded its key or index limit.');
    const primary = columns.filter(c => c.pk !== 0n);
    const rowidKey = primary.length === 1 && String(primary[0].type).toUpperCase() === 'INTEGER'
      && !indices.some(i => i.origin === 'pk');
    const parentKeys = new Map<string, string[]>();
    const targets: string[] = [];
    for (const f of foreignKeys) {
      if (f.to !== null) { targets.push(String(f.to)); continue; }
      const parent = String(f.table);
      if (!parentKeys.has(parent)) parentKeys.set(parent, (yield* metadata('SELECT name FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk LIMIT 101', [parent])).map(c => String(c.name)));
      targets.push(parentKeys.get(parent)?.[Number(f.seq)] ?? '(unresolved implicit primary key)');
    }
    const indexes: SchemaIndex[] = [];
    for (const i of indices) {
      const indexColumns = (yield* metadata('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 101', [String(i.name)])).map(c => c.name === null ? null : String(c.name));
      indexes.push({ name: String(i.name), unique: i.unique === 1n, origin: String(i.origin), partial: i.partial === 1n, columns: indexColumns });
    }
    result.push({
      name,
      columns: columns.map(c => ({ name: String(c.name), type: String(c.type).toLowerCase(), nullable: c.notnull === 0n && !(rowidKey && c.pk !== 0n),
        primaryKey: c.pk !== 0n, primaryKeyOrder: Number(c.pk), default: c.dflt_value === null ? null : String(c.dflt_value), generated: c.hidden === 2n || c.hidden === 3n, hidden: c.hidden === 1n })),
      foreignKeys: foreignKeys.map((f, k) => ({ column: String(f.from), table: String(f.table), target: targets[k], onDelete: String(f.on_delete).toLowerCase(), onUpdate: String(f.on_update).toLowerCase() })),
      indexes,
    });
  }
  return result;
}

export function* schemaPlansWork(ctx: CoreContext): Work<PlannedSchema[]> {
  ctx.check();
  if (ctx.dialect && ctx.dialect.name !== 'sqlite') fail('QUERY', 'Schema planning is not implemented for this database dialect.');
  const actual = yield* inspectSchemaWork();
  const plans: PlannedSchema[] = [];
  const add = (table: string, action: SchemaPlan['action'], model: CreateTableModel | CreateIndexModel): void => { plans.push({ table, action, model, sql: compileFor(ctx, model).sql }); };
  for (const table of ctx.tables.values()) {
    const found = actual.find(t => t.name.toLowerCase() === table.name.toLowerCase());
    const columns = Object.entries(table.columns as Columns);
    for (const [, c] of columns) {
      const fk = c.config.foreignKey;
      if (fk && ctx.tables.get(fk.table.name) !== fk.table) fail('SCHEMA', 'Foreign-key targets must be registered on the same database.');
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
export const publicPlans = (plans: readonly PlannedSchema[]): SchemaPlan[] => plans.map(({ table, action, sql }) => ({ table, action, sql }));

/** Runs inside the caller's atomic callback: plans against the live schema, then applies each DDL statement. */
export function* ensureSchemaWork(ctx: CoreContext): Work<SchemaPlan[]> {
  const plans = yield* schemaPlansWork(ctx);
  for (const plan of plans) yield* request({ sql: plan.sql, parameters: [], operation: 'schema', table: plan.table, control: true });
  return publicPlans(plans);
}

// ------------------------------------------------------------------------------------------------ repositories

/**
 * Call-time snapshot of an include tree. Every include record that is a valid plain record (validated exactly as the
 * later checks will) is copied with its prototype; anything invalid is kept as-is so the later validation rejects it
 * with the same error. Relation descriptors keep their brands; only their mutable nested include records are copied.
 */
export type IncludeCapture = Map<object, Includes | undefined>;
function plainRecordCopy(value: unknown): unknown {
  try { plainRecord(value); } catch { return value; }
  return Object.assign(Object.create(Object.getPrototypeOf(value)) as object, value as object);
}
function captureIncludes(include: unknown, captured: IncludeCapture, depth: number): unknown {
  if (include === undefined) return undefined;
  const copy = plainRecordCopy(include);
  if (copy === include || depth > 5) return copy;
  for (const relation of Object.values(copy as Record<string, unknown>)) {
    if (!isRelation(relation) || captured.has(relation)) continue;
    captured.set(relation, captureIncludes(relation.options.include, captured, depth + 1) as Includes | undefined);
  }
  return copy;
}
/** Selection arrays are copied and frozen; anything else is passed through unchanged for the usual validation. */
function captureSelect<S>(select: S): S {
  return (Array.isArray(select) ? Object.freeze([...select]) : select) as S;
}
export interface Planned<T extends AnyTable> {
  model: SelectModel; fields: string[]; plan?: ProjectedPlan; select: Selection<T> | undefined; include: Includes | undefined; core: RepositoryCore<T>;
}
export type Captured<V> = { ok: true; value: V } | { ok: false; error: unknown };
function capture<V>(fn: () => V): Captured<V> {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

export interface PreparedWrite { predicate: PredicateModel; max: number; fields: string[]; values: Parameter[]; remove: boolean; conflict: boolean }

export class RepositoryCore<T extends AnyTable> {
  #captured: IncludeCapture = new Map();
  constructor(readonly ctx: CoreContext, readonly definition: T) {}
  compile(model: QueryModel): DialectQuery { return compileFor(this.ctx, model); }
  #child<U extends AnyTable>(table: U): RepositoryCore<U> {
    const core = new RepositoryCore(this.ctx, table);
    core.#captured = this.#captured;
    return core;
  }
  /** The nested include record of a relation as captured at call time (the live record if it was never captured). */
  #nested(relation: { options: { include?: Includes } }): Includes | undefined {
    return this.#captured.has(relation) ? this.#captured.get(relation) : relation.options.include;
  }

  #predicate(where?: Predicate, budget?: LoweringBudget, relationDepth = 0): PredicateModel | undefined {
    return predicateToModel(this.definition, where, table => this.ctx.mapped(table), budget, relationDepth);
  }
  predicate(where?: Predicate): PredicateModel | undefined { return this.#predicate(where); }
  #columns(): [string, Columns[string]][] { return Object.entries(this.definition.columns as Columns); }
  decodeRow(row: Record<string, unknown>, fields = this.#columns().map(([name]) => name)): Row<T> {
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
      this.ctx.mapped(relation.table);
      validateRelation(relation.table, relation.options, relation instanceof SingularRelation);
      this.#child(relation.table).#predicate(relation.options.where);
      const { localKey, foreignKey } = relation.options;
      if (!isColumnRef(localKey) || !isColumnRef(foreignKey) || localKey.table !== this.definition || foreignKey.table !== relation.table) fail('QUERY', 'Relationship keys must reference their respective mapped tables.');
      const source = this.definition.columns[localKey.name].config;
      const target = relation.table.columns[foreignKey.name].config;
      if (!relationKindsCompatible(source.kind, target.kind)) fail('QUERY', 'Relationship keys must be compatible scalar columns.');
      fields.add(localKey.name);
      this.#child(relation.table).#fetchFields(relation.options.select, this.#nested(relation), [foreignKey.name], depth + 1);
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
      const repository = this.#child(relation.table);
      const child = (value: Row<AnyTable>): Record<string, unknown> => {
        if (--budget.remaining < 0) fail('RESULT_LIMIT', 'Eager results exceeded 10,000 related row copies. Narrow the root query or per-parent limits.');
        return repository.#materialize(value, repository.#nested(relation), relation.options.select, budget);
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

  /** Validates and encodes one insert record; the result holds only immutable bound values. */
  encodeInsert(data: InsertRow<T>): [string[], Parameter[]] { return this.#data(data, true); }
  /** Call-time capture of an insert. A validation error is replayed inside the atomic callback, as in the sync API. */
  captureInsert(data: InsertRow<T>): Captured<[string[], Parameter[]]> { return capture(() => this.encodeInsert(data)); }
  /** Runs inside the caller's atomic callback. */
  *insertOne(data: InsertRow<T>): Work<Row<T>> {
    return yield* this.insertEncoded(this.encodeInsert(data));
  }
  *insertCaptured(captured: Captured<[string[], Parameter[]]>): Work<Row<T>> {
    if (!captured.ok) throw captured.error;
    return yield* this.insertEncoded(captured.value);
  }
  *insertEncoded([fields, values]: [string[], Parameter[]]): Work<Row<T>> {
    const query = this.compile(queryModel.insert({ table: mappedTableModel(this.definition), columns: fields, values }));
    const rows = yield* request({ ...query, operation: 'insert', table: this.definition.name });
    if (rows.length !== 1) fail('DATA', 'An insert did not return one record.');
    return this.decodeRow(rows[0]);
  }
  /** Pre-atomic checks for insert/insertMany, in the synchronous order. */
  prepareInsert(): void { this.ctx.mapped(this.definition); this.ctx.writeCheck(); }
  prepareInsertMany(rows: unknown): void {
    this.prepareInsert();
    if (!Array.isArray(rows) || rows.length > 1000) fail('VALIDATION', 'Insert at most 1,000 records in one batch.');
  }

  /** Each call plans on its own core, so concurrent calls on one repository never share an include snapshot. */
  selectPlan(input: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates>): Planned<T> {
    return new RepositoryCore(this.ctx, this.definition).#selectPlanCaptured(input);
  }
  #selectPlanCaptured(input: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates>): Planned<T> {
    this.ctx.mapped(this.definition);
    assertOptions(input, ['where', 'orderBy', 'limit', 'offset', 'include', 'select', 'aggregates']);
    // Planning, SQL and materialization all use one call-time snapshot of the selection and include tree.
    this.#captured = new Map();
    const options = { ...input, select: captureSelect(input.select), include: captureIncludes(input.include, this.#captured, 0) as Includes | undefined };
    if (this.ctx.dialect?.supportsIncludes === false && Object.keys(options.include ?? {}).length)
      fail('QUERY', 'Eager relationships are not implemented for this database dialect.');
    const fields = this.#fetchFields(options.select, options.include);
    const limit = integer(options.limit, 1000, 0, 10_000);
    const offset = integer(options.offset, 0, 0, 1_000_000_000);
    // One lowering budget covers the root where and every related aggregate domain.
    const budget: LoweringBudget = { nodes: 0, bound: 0 };
    const where = this.#predicate(options.where, budget);
    let plan: ProjectedPlan | undefined;
    if (options.aggregates !== undefined) {
      const reserved = [...selectionFields(this.definition, options.select), ...Object.keys(options.include ?? {})];
      plan = projectedAggregatesToModel(this.definition, options.aggregates, {
        mapped: table => this.ctx.mapped(table), reserved,
        where: (table, domain, shared, depth) => this.#child(table).#predicate(domain, shared, depth),
      }, budget);
      // Like include keys, every root correlation key is fetched (hidden unless selected) so the strict row decoder
      // validates its stored value before any aggregate built on it is exposed.
      for (const model of plan.models) if (!fields.includes(model.path[0].localKey)) fields.push(model.path[0].localKey);
    }
    const model = queryModel.select({ table: mappedTableModel(this.definition), columns: fields, ...(where === undefined ? {} : { where }),
      ...(plan === undefined ? {} : { aggregates: plan.models }), orderBy: orderToModel(this.definition, options.orderBy, true), limit, offset });
    const captured = { select: options.select, include: options.include, core: this as RepositoryCore<T> };
    return plan === undefined ? { model, fields, ...captured } : { model, fields, plan, ...captured };
  }
  *explainWork(model: SelectModel | AggregateModel | GroupModel): Work<QueryPlan[]> {
    const query = this.compile(queryModel.explain({ query: model }));
    return toPlan(yield* request({ ...query, operation: 'select', table: this.definition.name, explain: true }));
  }
  /** Plans synchronously (call time); only the returned Work performs I/O. */
  findMany(options: FindOptions<Includes, Selection<T> | undefined, RelatedAggregates>): Work<Record<string, unknown>[]> {
    const planned = this.selectPlan(options);
    return planned.core.#findPlanned(planned);
  }
  *#findPlanned(planned: Planned<T>): Work<Record<string, unknown>[]> {
    const { model, fields, plan, select, include } = planned;
    const query = this.compile(model);
    const raw = yield* request({ ...query, operation: 'select', table: this.definition.name });
    // The same-query storage guard covers every returned row; fail before decoding, loading includes or exposing rows.
    if (plan) assertProjectedGuard(raw);
    const rows = raw.map(row => this.decodeRow(row, fields));
    const projected = plan ? raw.map(row => decodeProjectedRow(plan, row)) : undefined;
    yield* this.#loadIncludes(rows, include, { remaining: 10_000 }, 0);
    const budget = { remaining: 10_000 };
    return rows.map((row, index) => {
      const result = this.#materialize(row, include, select, budget);
      if (projected) Object.assign(result, projected[index]);
      return result;
    });
  }
  countPrepare(where?: Predicate): PredicateModel | undefined {
    this.ctx.mapped(this.definition);
    return this.#predicate(where);
  }
  *countWork(where: PredicateModel | undefined): Work<number> {
    const query = this.compile(queryModel.count({ table: mappedTableModel(this.definition), ...(where === undefined ? {} : { where }) }));
    const rows = yield* request({ ...query, operation: 'select', table: this.definition.name });
    return countValue(rows[0].n);
  }

  /** Registration and one shared lowering budget for the root where and every related domain. */
  #aggregateLowering(): AggregateLowering {
    return {
      where: (where, budget) => this.#predicate(where, budget),
      mapped: table => this.ctx.mapped(table),
      domain: (table, domain, budget, depth) => new RepositoryCore(this.ctx, table).#predicate(domain, budget, depth),
    };
  }
  aggregatePlan(options: unknown): AggregatePlan<AggregateModel> {
    this.ctx.mapped(this.definition);
    return aggregateToPlan(this.definition, options, this.#aggregateLowering());
  }
  groupPlan(options: unknown): AggregatePlan<GroupModel> {
    this.ctx.mapped(this.definition);
    return groupToPlan(this.definition, options, this.#aggregateLowering());
  }
  *aggregateWork(plan: AggregatePlan<AggregateModel>): Work<unknown> {
    const { model, leaves } = plan, query = this.compile(model);
    const rows = yield* request({ ...query, operation: 'select', table: this.definition.name });
    if (rows.length !== 1) fail('DATA', 'An aggregate query must return one result.');
    return decodeAggregateRow(this.definition, model, rows[0], leaves);
  }
  *groupWork(plan: AggregatePlan<GroupModel>): Work<unknown[]> {
    const { model, leaves } = plan, query = this.compile(model);
    const rows = yield* request({ ...query, operation: 'select', table: this.definition.name });
    if (model.overflow && rows.length > 10_000) fail('RESULT_LIMIT', 'Grouped results exceed 10,000 rows. Add an explicit limit and offset to page the groups.');
    return rows.map(row => decodeAggregateRow(this.definition, model, row, leaves));
  }

  *#loadIncludes(rows: Row<T>[], includes: Includes | undefined, budget: { remaining: number }, depth: number): Work<void> {
    if (includes === undefined) return;
    plainRecord(includes);
    const entries = Object.entries(includes);
    if (entries.length && depth >= 4 || entries.length > 8) fail('QUERY', 'Eager relationships support at most four levels and eight includes per level.');
    for (const [name, relation] of entries) {
      identifier(name);
      if (Object.hasOwn(this.definition.columns, name) || !isRelation(relation)) fail('QUERY', 'An include must have a unique name and be built with a Rowstitch relationship helper.');
      this.ctx.mapped(relation.table);
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
      const repository = this.#child(relation.table);
      const nested = this.#nested(relation);
      const fields = repository.#fetchFields(relation.options.select, nested, [foreignKey.name], depth + 1);
      const children: Row<AnyTable>[] = [];
      const sourceKeys = new WeakMap<object, string>();
      const where = repository.#predicate(relation.options.where);
      const ordering = orderToModel(relation.table, relation.options.orderBy, true);
      for (let index = 0; index < values.length && limit > 0; index += MAX_RELATION_KEYS) {
        const chunk = values.slice(index, index + MAX_RELATION_KEYS);
        // Both integer codecs use SQLite INTEGER; bind the validated source value
        // losslessly instead of forcing number IDs through the bigint JS codec.
        const encoded = chunk.map(value => encode(this.definition.columns[localKey.name].config, value));
        const query = this.compile(queryModel.relation({ table: mappedTableModel(relation.table), columns: fields, partitionBy: foreignKey.name, keys: encoded,
          ...(correlateKeys ? { correlateKeys: true } : {}), ...(where === undefined ? {} : { where }), orderBy: ordering, offset, limit, readLimit: budget.remaining + 1 }));
        const raw = yield* request({ ...query, operation: 'select', table: relation.table.name });
        const result = raw.map(row => {
          const decoded = repository.decodeRow(row, fields);
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
      yield* repository.#loadIncludes(children, nested, budget, depth + 1);
      for (const row of rows) {
        const group = row[localKey.name] === null ? [] : groups.get(key(row[localKey.name])) ?? [];
        (row as Record<string, unknown>)[name] = many ? group : group[0] ?? null;
      }
    }
  }

  /** Every guarded-write check that the synchronous API performs before opening its atomic callback. */
  prepareWrite(data: UpdateRow<T> | null, options: WriteOptions, conflict = false): PreparedWrite {
    this.ctx.mapped(this.definition); this.ctx.writeCheck();
    assertOptions(options, ['where', 'maxRows']);
    const predicate = this.#predicate(options.where);
    if (hasRelationFilter(predicate)) fail('UNSAFE_WRITE', 'Relation filters currently support reads only. Use explicit key filters for guarded writes.');
    if (predicate === undefined || predicateTruth(predicate) === true) fail('UNSAFE_WRITE', 'Updates and deletes require a meaningful filter. Whole-table writes have no implicit opt-in.');
    const max = integer(options.maxRows, 100, 0, 10_000);
    const [fields, values] = data === null ? [[], []] : this.#data(data, false);
    return { predicate, max, fields, values, remove: data === null, conflict };
  }
  /** Runs inside the caller's atomic callback: count, guard, write, then verify the affected rows. */
  *writeWork(prepared: PreparedWrite): Work<Row<T>[]> {
    const { predicate, max, fields, values, remove, conflict } = prepared;
    const matched = yield* this.countWork(predicate);
    if (matched > max) fail('AFFECTED_ROWS', 'The filter matches more records than maxRows allows. No records were changed.');
    if (!matched && conflict) throw new ConflictError();
    if (!matched) return [];
    const table = mappedTableModel(this.definition);
    const model = remove ? queryModel.delete({ table, where: predicate })
      : queryModel.update({ table, where: predicate, assignments: fields.map((column, i) => ({ column, value: values[i] })) });
    const query = this.compile(model);
    const raw = yield* request({ ...query, operation: remove ? 'delete' : 'update', table: this.definition.name });
    const result = raw.map(row => this.decodeRow(row));
    if (result.length !== matched || result.length > max) fail('AFFECTED_ROWS', 'Affected records did not match the guarded count. The transaction was rolled back.');
    return result;
  }
  /** Validates a versioned update and returns its guarded filter, in the synchronous order. */
  versionFilter(key: KeyRow<T>, expectedVersion: number): Predicate {
    this.ctx.mapped(this.definition);
    if (!this.definition.version || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) fail('VALIDATION', 'A versioned update needs a mapped version column and an incrementable expected version.');
    plainRecord(key);
    const primary = this.#columns().filter(([, c]) => c.config.primary).map(([name]) => name);
    if (Object.keys(key).length !== primary.length || !primary.every(name => Object.hasOwn(key, name))) fail('VALIDATION', 'Provide every primary-key column, and no other key fields.');
    const filters = primary.map(name => eq(this.definition.col(name), (key as Record<string, unknown>)[name]));
    filters.push(eq(this.definition.col(this.definition.version), expectedVersion));
    return and(...filters);
  }
}

/** Drives a Work generator synchronously. I/O errors are thrown into the generator so its own cleanup can run. */
export function runSync<R>(work: Work<R>, perform: (step: Step) => Rows): R {
  let state = work.next();
  while (!state.done) {
    let rows: Rows;
    try { rows = perform(state.value); } catch (error) { state = work.throw(error); continue; }
    state = work.next(rows);
  }
  return state.value;
}
/** Drives a Work generator through an asynchronous performer, one awaited step at a time. */
export async function runAsync<R>(work: Work<R>, perform: (step: Step) => Promise<Rows>): Promise<R> {
  let state = work.next();
  while (!state.done) {
    let rows: Rows;
    try { rows = await perform(state.value); } catch (error) { state = work.throw(error); continue; }
    state = work.next(rows);
  }
  return state.value;
}
