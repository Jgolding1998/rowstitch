/** Root aggregate/group selectors, their result types and validated lowering to pure models. No SQL, IO or runtime imports. */
import { RowstitchError, fail } from './errors.js';
import { Column, isColumnRef, isTable, type AnyTable, type ColumnRef, type Kind, type Row } from './schema.js';
import { mappedTableModel } from './model-mapping.js';
import { filterRelationSnapshot, type FilterRelation, type Predicate, type SelectedRow } from './predicates.js';
import { queryModel, type AggregateModel, type AggregateSelectModel, type GroupModel, type PredicateModel } from './query-model.js';
export type { AggregateModel, AggregateSelectModel, GroupModel } from './query-model.js';

export type AggregateOperation = 'count' | 'sum' | 'avg' | 'min' | 'max';
type CountKind = 'integer' | 'bigint' | 'real' | 'text' | 'boolean';
type ExtremeKind = 'integer' | 'bigint' | 'real' | 'text';
type IntegerKind = 'integer' | 'bigint';

declare const resultType: unique symbol;
/** An immutable aggregate selector created only by `agg`. `R` is the decoded result type. */
export interface AggregateSelector<R> {
  readonly operation: AggregateOperation;
  readonly ref: ColumnRef | undefined;
  readonly approximate: boolean;
  readonly [resultType]: R;
}
export type AnyAggregateSelector = AggregateSelector<unknown>;

declare const relatedResultType: unique symbol;
/**
 * A per-row aggregate over a relation path, created only by agg.related. Separately branded: it is not an
 * AggregateSelector, so root aggregate/groupBy reject it statically and at runtime in this release.
 */
export interface RelatedAggregate<R> {
  readonly relation: FilterRelation;
  readonly selector: AnyAggregateSelector | AnyRelatedAggregate;
  readonly [relatedResultType]: R;
}
export type AnyRelatedAggregate = RelatedAggregate<unknown>;
export type RelatedAggregates = Readonly<Record<string, AnyRelatedAggregate>>;
const relatedAggregates = new WeakSet<object>();
export function isRelatedAggregate(value: unknown): value is AnyRelatedAggregate {
  return value !== null && typeof value === 'object' && relatedAggregates.has(value);
}
/** Internal: whether a value is a genuine agg selector (not a related aggregate). */
export function isAggregateSelector(value: unknown): value is AnyAggregateSelector {
  return isSelector(value);
}
type RelatedResultOf<D> = D extends RelatedAggregate<infer R> ? R : never;
type SelectorResult<S> = S extends RelatedAggregate<infer R> ? R : S extends AggregateSelector<infer R> ? R : never;
/** Literal aliases are certain; a broad string-indexed record promises no field. Distributes over unions. */
export type ProjectedAggregateResult<A extends RelatedAggregates> = A extends unknown
  ? string extends keyof A
    ? { [alias: string]: RelatedResultOf<A[string]> | undefined }
    : { -readonly [K in keyof A]: RelatedResultOf<A[K]> }
  : never;
type OmitEach<X, K extends PropertyKey> = X extends unknown ? Omit<X, K> : never;
/** Every value a base row (selected fields and included relations) can hold under some key. */
type BaseValue<Base> = Base extends unknown ? Base[keyof Base] : never;
/**
 * A findMany/findFirst row with per-row aggregates, merged per branch of BOTH the aggregate-selection union and the
 * base row/include union (never a plain intersection):
 * - known aliases replace same-named base fields, because at runtime an alias equal to a selected column or include is
 *   rejected, so on a successful return that field is the aggregate (an uncertain selected text field cannot collapse it
 *   to never);
 * - a broad string-indexed aggregate record cannot name its aliases, so its index signature admits every possible base
 *   value (selected fields and included rows/arrays), every aggregate result and undefined;
 * - without aggregates the base row type is unchanged.
 */
// The emptiness test runs per aggregate branch: keyof a union such as {a} | {b} is never, which must not mean "no aggregates".
export type ProjectedRow<Base, A extends RelatedAggregates> = A extends unknown
  ? [keyof A] extends [never] ? Base
    : Base extends unknown
      ? string extends keyof A
        ? Base & { [field: string]: BaseValue<Base> | RelatedResultOf<A[string]> | undefined }
        : OmitEach<Base, keyof A> & { -readonly [K in keyof A]: RelatedResultOf<A[K]> }
      : never
  : never;

const selectors = new WeakSet<object>();
function isSelector(value: unknown): value is AnyAggregateSelector {
  return value !== null && typeof value === 'object' && selectors.has(value);
}
function kindOf(ref: ColumnRef): Kind {
  return (ref.table.columns[ref.name] as Column<unknown, boolean, boolean>).config.kind;
}
function selector<R>(operation: AggregateOperation, ref: unknown, allowed: readonly Kind[], approximate = false): AggregateSelector<R> {
  if (ref !== undefined && (!isColumnRef(ref) || !isTable(ref.table) || !Object.hasOwn(ref.table.columns, ref.name) || !allowed.includes(kindOf(ref)))) {
    fail('QUERY', 'This aggregate needs a mapped column of a supported kind.');
  }
  const value = Object.freeze({ operation, ref: ref as ColumnRef | undefined, approximate });
  selectors.add(value);
  return value as unknown as AggregateSelector<R>;
}
/** Reads a small options record once without invoking accessors. */
function avgOptions(options: unknown): boolean {
  if (options === undefined) return false;
  const value = capture(options, ['approximate'], 'Average options support only { approximate: true }.');
  if (value.approximate !== undefined && value.approximate !== true) fail('QUERY', 'Average options support only { approximate: true }.');
  return value.approximate === true;
}

interface Agg {
  /** COUNT(*), or COUNT(column) excluding NULL. Returns a checked safe number. */
  count(): AggregateSelector<number>;
  count(ref: ColumnRef<unknown, CountKind>): AggregateSelector<number>;
  /** Exact integer total, possibly beyond int64; NULL for empty or all-NULL input. */
  sum(ref: ColumnRef<unknown, IntegerKind>): AggregateSelector<bigint | null>;
  /** Approximate finite real total. */
  sum(ref: ColumnRef<unknown, 'real'>): AggregateSelector<number | null>;
  avg(ref: ColumnRef<unknown, 'integer' | 'real'>, options?: { readonly approximate?: true }): AggregateSelector<number | null>;
  /** A bigint average loses integer precision and must be acknowledged. */
  avg(ref: ColumnRef<unknown, 'bigint'>, options: { readonly approximate: true }): AggregateSelector<number | null>;
  min<T, K extends ExtremeKind>(ref: ColumnRef<T, K>): AggregateSelector<Exclude<T, null> | null>;
  max<T, K extends ExtremeKind>(ref: ColumnRef<T, K>): AggregateSelector<Exclude<T, null> | null>;
  /**
   * Per-row aggregate over a relation (and, nested, a path of up to four relations) for findMany/findFirst aggregates.
   * The leaf selector's column must belong to the last relation's table (checked at runtime).
   */
  // The result is computed from the argument type, so a contextual type (for example `satisfies RelatedAggregates`)
  // cannot widen it to unknown.
  related<S extends AnyAggregateSelector | AnyRelatedAggregate>(relation: FilterRelation, selector: S): RelatedAggregate<SelectorResult<S>>;
}
/** Exact arity: an extra argument (for example a filter or distinct flag) must never be silently ignored. */
function single(args: readonly unknown[], name: string): unknown {
  if (args.length !== 1) fail('QUERY', name + ' accepts exactly one column; selector filters and distinct are not supported in this release.');
  return args[0] ?? null;
}
export const agg: Readonly<Agg> = Object.freeze({
  count: (...args: unknown[]) => {
    if (args.length > 1) fail('QUERY', 'count accepts at most one column.');
    return args.length ? selector('count', args[0] ?? null, ['integer', 'bigint', 'real', 'text', 'boolean']) : selector('count', undefined, []);
  },
  sum: (...args: unknown[]) => selector('sum', single(args, 'sum'), ['integer', 'bigint', 'real']),
  avg: (...args: unknown[]) => {
    if (args.length < 1 || args.length > 2) fail('QUERY', 'avg accepts a column and optional { approximate: true } only.');
    const [ref, options] = args;
    const approximate = avgOptions(options);
    const value = selector<number | null>('avg', ref ?? null, ['integer', 'bigint', 'real'], approximate);
    if (kindOf(value.ref!) === 'bigint' && !approximate) fail('QUERY', 'A bigint average is approximate; pass { approximate: true }.');
    return value;
  },
  min: (...args: unknown[]) => selector('min', single(args, 'min'), ['integer', 'bigint', 'real', 'text']),
  max: (...args: unknown[]) => selector('max', single(args, 'max'), ['integer', 'bigint', 'real', 'text']),
  related: (...args: unknown[]) => {
    if (args.length !== 2) fail('QUERY', 'agg.related accepts exactly a relation and one aggregate selector.');
    const [relation, inner] = args;
    // Validates the genuine descriptor and refuses loading-only options now; lowering re-checks scope and registration.
    filterRelationSnapshot(relation);
    if (!isSelector(inner) && !isRelatedAggregate(inner)) fail('QUERY', 'agg.related needs an agg selector or a nested agg.related value.');
    let depth = 1;
    for (let item: unknown = inner; isRelatedAggregate(item); item = item.selector) if (++depth > 4) fail('QUERY', 'Related aggregates support at most four relationships in a path.');
    const value = Object.freeze({ relation: relation as FilterRelation, selector: inner as AnyAggregateSelector | AnyRelatedAggregate });
    relatedAggregates.add(value);
    return value as unknown as AnyRelatedAggregate;
  },
}) as Readonly<Agg>;

export type AggregateSelection = Readonly<Record<string, AnyAggregateSelector>>;
type ResultOf<D> = D extends AggregateSelector<infer R> ? R : never;
/**
 * Literal selection keys are certain; a broad string-indexed selection does not promise any field.
 * Distributes over a union of selections so each branch keeps its own aliases.
 */
export type AggregateResult<S extends AggregateSelection> = S extends unknown
  ? string extends keyof S
    ? { [alias: string]: ResultOf<S[string]> | undefined }
    : { -readonly [K in keyof S]: ResultOf<S[K]> }
  : never;
export interface AggregateOptions<S extends AggregateSelection> {
  readonly select: S;
  readonly where?: Predicate;
}

/** Mapped column names usable as group keys (JSON columns are excluded). */
export type GroupKey<T extends AnyTable> = {
  [K in keyof T['columns'] & string]: T['columns'][K] extends Column<any, boolean, boolean, 'json'> ? never : K
}[keyof T['columns'] & string];
export interface GroupOrder<F extends string> { readonly field: F; readonly direction: 'asc' | 'desc' }
export interface GroupOptions<T extends AnyTable, B extends readonly GroupKey<T>[], S extends AggregateSelection> {
  /** At least one key. A literal empty list is rejected. */
  readonly by: B & ([B] extends [readonly []] ? never : unknown);
  readonly select: S;
  readonly where?: Predicate;
  readonly orderBy?: readonly GroupOrder<NoInfer<(B[number] & string) | (keyof S & string)>>[];
  readonly limit?: number;
  readonly offset?: number;
}
type DistributiveOmit<X, K extends PropertyKey> = X extends unknown ? Omit<X, K> : never;
/** Values a group row can hold under a dynamic key: any selected key column or any selector result. */
type GroupValue<T extends AnyTable, B extends readonly string[], S extends AggregateSelection> = Row<T>[B[number] & keyof Row<T>] | ResultOf<S[keyof S]>;
/**
 * Resolved per selection branch (S distributes before keyof S / Omit, and SelectedRow distributes too). Known aliases
 * replace (rather than intersect with) uncertain key fields of the same name: at runtime an alias equal to a selected key
 * is rejected, so if the call succeeds that field is the aggregate. A broad string-indexed selection cannot name its
 * aliases, so its index signature also admits every possible key value and undefined.
 */
export type GroupResult<T extends AnyTable, B extends readonly string[], S extends AggregateSelection> = S extends unknown
  ? string extends keyof S
    ? SelectedRow<T, B> & { [field: string]: GroupValue<T, B, S> | undefined }
    : DistributiveOmit<SelectedRow<T, B>, keyof S> & AggregateResult<S>
  : never;

export type PredicateLowering = (where: Predicate) => PredicateModel | undefined;

export const MAX_SELECTORS = 32, MAX_GROUP_KEYS = 16, MAX_GROUP_ROWS = 10_000, MAX_OFFSET = 1_000_000_000;
const unsupported = ['having', 'distinct', 'filter', 'include', 'aggregates', 'groupBy'];

/** Copies own data properties of a plain record once; accessors are refused without being called. */
function capture(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('QUERY', message);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) fail('QUERY', 'Aggregate options cannot use accessors or symbol keys.');
      if (!allowed.includes(key)) fail('QUERY', unsupported.includes(key) ? 'The ' + key + ' aggregate option is not supported in this release.' : message);
      if (descriptor.value !== undefined) copy[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof RowstitchError) throw error;
    fail('QUERY', message);
  }
  return copy;
}
function captureList(value: unknown, minimum: number, maximum: number, message: string): unknown[] {
  try {
    if (!Array.isArray(value) || ![null, Array.prototype].includes(Object.getPrototypeOf(value))) fail('QUERY', message);
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
    const length = descriptors.length?.value;
    if (typeof length !== 'number' || length < minimum || length > maximum) fail('QUERY', message);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || +key >= length)) fail('QUERY', message);
    }
    const copy: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !('value' in descriptor)) fail('QUERY', message);
      copy.push(descriptor.value);
    }
    return copy;
  } catch (error) {
    if (error instanceof RowstitchError) throw error;
    return fail('QUERY', message);
  }
}
function aliasName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) || /^(?:sqlite_|__rs_)/i.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    fail('QUERY', 'Aggregate aliases must be simple names of 1 to 63 characters and cannot use reserved names.');
  }
  return value;
}
function integerOption(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('QUERY', 'An aggregate limit or offset is outside its supported integer range.');
  return value;
}
function selection(table: AnyTable, input: unknown): AggregateSelectModel[] {
  let entries: [string, unknown][];
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail('QUERY', 'select must be a plain record of agg selectors.');
    entries = Reflect.ownKeys(input).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) fail('QUERY', 'Aggregate options cannot use accessors or symbol keys.');
      return [key, descriptor.value] as [string, unknown];
    });
  } catch (error) {
    if (error instanceof RowstitchError) throw error;
    return fail('QUERY', 'select must be a plain record of agg selectors.');
  }
  if (entries.length < 1 || entries.length > MAX_SELECTORS) fail('QUERY', 'Select 1 to 32 aggregate values.');
  const seen = new Set<string>();
  return entries.map(([alias, value]) => {
    aliasName(alias);
    if (seen.has(alias.toLowerCase())) fail('QUERY', 'Aggregate aliases must be unique ignoring case.');
    seen.add(alias.toLowerCase());
    if (isRelatedAggregate(value)) fail('QUERY', 'agg.related is supported only in findMany/findFirst aggregates in this release.');
    if (!isSelector(value)) fail('QUERY', 'Aggregate values must be created with agg.');
    const ref = value.ref;
    if (ref !== undefined && (ref.table !== table || !Object.hasOwn(table.columns, ref.name))) fail('QUERY', 'Aggregate columns must belong to the queried table.');
    if (ref === undefined && value.operation !== 'count') fail('QUERY', 'This aggregate needs a column.');
    if (ref !== undefined && value.operation === 'avg' && kindOf(ref) === 'bigint' && !value.approximate) fail('QUERY', 'A bigint average is approximate; pass { approximate: true }.');
    return Object.freeze({ alias, operation: value.operation, ...(ref === undefined ? {} : { column: ref.name }), ...(value.approximate ? { approximate: true as const } : {}) });
  });
}
function lowerWhere(where: unknown, predicate: PredicateLowering): { where?: PredicateModel } {
  if (where === undefined) return {};
  const model = predicate(where as Predicate);
  return model === undefined ? {} : { where: model };
}
function genuine(table: AnyTable): void {
  if (!isTable(table)) fail('SCHEMA', 'Aggregates require a genuine mapped table.');
}

/** Lowers public `aggregate` options. The result is revalidated again by the compiler's model normalizer. */
export function aggregateToModel(table: AnyTable, input: unknown, predicate: PredicateLowering): AggregateModel {
  genuine(table);
  const options = capture(input, ['select', 'where'], 'aggregate accepts only select and where.');
  if (!Object.hasOwn(options, 'select')) fail('QUERY', 'aggregate requires a select record.');
  const select = Object.freeze(selection(table, options.select));
  return queryModel.aggregate({ table: mappedTableModel(table), select, ...lowerWhere(options.where, predicate) });
}

/** Lowers public `groupBy` options, appending missing group keys as ascending tie-breakers. */
export function groupToModel(table: AnyTable, input: unknown, predicate: PredicateLowering): GroupModel {
  genuine(table);
  const options = capture(input, ['by', 'select', 'where', 'orderBy', 'limit', 'offset'], 'groupBy accepts only by, select, where, orderBy, limit and offset.');
  if (!Object.hasOwn(options, 'select') || !Object.hasOwn(options, 'by')) fail('QUERY', 'groupBy requires by and select.');
  const by = captureList(options.by, 1, MAX_GROUP_KEYS, 'by must list 1 to 16 distinct mapped columns.').map(key => {
    if (typeof key !== 'string' || !Object.hasOwn(table.columns, key) || (table.columns[key] as Column<unknown, boolean, boolean>).config.kind === 'json') fail('QUERY', 'Group keys must be mapped non-JSON columns.');
    return key;
  });
  if (new Set(by).size !== by.length) fail('QUERY', 'by must list 1 to 16 distinct mapped columns.');
  const select = selection(table, options.select);
  const keys = new Set(by.map(key => key.toLowerCase()));
  if (select.some(item => keys.has(item.alias.toLowerCase()))) fail('QUERY', 'Aggregate aliases cannot repeat a group key name.');
  const fields = new Set<string>([...by, ...select.map(item => item.alias)]);
  const used = new Set<string>();
  const orderBy = (options.orderBy === undefined ? [] : captureList(options.orderBy, 0, by.length + select.length, 'orderBy must be a bounded list of { field, direction }.')).map(item => {
    const order = capture(item, ['field', 'direction'], 'orderBy entries accept only field and direction.');
    if (typeof order.field !== 'string' || !fields.has(order.field) || used.has(order.field)) fail('QUERY', 'orderBy fields must be distinct selected keys or aliases.');
    if (order.direction !== 'asc' && order.direction !== 'desc') fail('QUERY', 'orderBy direction must be asc or desc.');
    used.add(order.field);
    return Object.freeze({ field: order.field, direction: order.direction === 'asc' ? 'ASC' as const : 'DESC' as const });
  });
  for (const key of by) if (!used.has(key)) orderBy.push(Object.freeze({ field: key, direction: 'ASC' as const }));
  const explicit = options.limit !== undefined;
  const limit = explicit ? integerOption(options.limit, 0, MAX_GROUP_ROWS) : MAX_GROUP_ROWS + 1;
  const offset = options.offset === undefined ? 0 : integerOption(options.offset, 0, MAX_OFFSET);
  return queryModel.group({ table: mappedTableModel(table), select, by, ...lowerWhere(options.where, predicate), orderBy, limit, offset, overflow: !explicit });
}
