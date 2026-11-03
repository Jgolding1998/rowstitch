import { fail } from './errors.js';
import { ColumnRef, encode, identifier, isColumnRef, isTable, plainRecord, type AnyTable, type Kind, type Parameter, type Row } from './schema.js';
import { mappedTableModel } from './model-mapping.js';
import { columnKindsCompatible, relationKindsCompatible, relationCountComparison, orderingModel, predicateModel, textMatchLiteral, textMatchOptions, type ColumnComparisonOperator, type ComparisonOperator, type OrderModel, type PredicateModel, type RelationQuantifier, type TextMatchCase, type TextMatchMode } from './query-model.js';
import { compileSqliteOrder, compileSqlitePredicate } from './sqlite-compiler.js';

type Node = { kind: 'column-compare'; left: ColumnRef; right: ColumnRef; operator: ColumnComparisonOperator }
  | { kind: 'relation-filter'; relation: FilterRelation; quantifier: RelationQuantifier; predicate?: Predicate }
  | { kind: 'relation-count'; relation: FilterRelation; operator: ColumnComparisonOperator; threshold: number; predicate?: Predicate }
  | { kind: 'text-match'; ref: ColumnRef; mode: TextMatchMode; case: TextMatchCase; literal: string }
  | { kind: 'comparison'; ref: ColumnRef; operator: string; values: readonly Parameter[] }
  | { kind: 'logic'; operator: 'AND' | 'OR'; children: readonly Predicate[] }
  | { kind: 'not'; child: Predicate };
export class Predicate {
  constructor(public readonly node: Node) { Object.freeze(node); Object.freeze(this); }
}
function comparison<T>(ref: ColumnRef<T>, operator: string, values: readonly unknown[]): Predicate {
  if (!isColumnRef(ref)) fail('QUERY', 'A predicate needs a mapped column reference.');
  if (values.length > 10_000) fail('QUERY', 'A predicate has too many parameters.');
  const config = ref.table.columns[ref.name].config;
  return new Predicate({ kind: 'comparison', ref, operator, values: Object.freeze(values.map(value => {
    if (value === null) return null;
    return encode(config, value);
  })) });
}
export const eq = <T>(ref: ColumnRef<T>, value: T): Predicate => comparison(ref, '=', [value]);
export const ne = <T>(ref: ColumnRef<T>, value: T): Predicate => comparison(ref, '<>', [value]);
export const gt = <T>(ref: ColumnRef<T>, value: Exclude<T, null>): Predicate => comparison(ref, '>', [value]);
export const gte = <T>(ref: ColumnRef<T>, value: Exclude<T, null>): Predicate => comparison(ref, '>=', [value]);
export const lt = <T>(ref: ColumnRef<T>, value: Exclude<T, null>): Predicate => comparison(ref, '<', [value]);
export const lte = <T>(ref: ColumnRef<T>, value: Exclude<T, null>): Predicate => comparison(ref, '<=', [value]);
export const inArray = <T>(ref: ColumnRef<T>, values: readonly T[]): Predicate => {
  if (!Array.isArray(values)) fail('QUERY', 'IN requires an array.');
  return comparison(ref, 'IN', values);
};
export const isNull = (ref: ColumnRef): Predicate => comparison(ref, '=', [null]);
export const and = (...children: Predicate[]): Predicate => new Predicate({ kind: 'logic', operator: 'AND', children: Object.freeze([...children]) });
export const or = (...children: Predicate[]): Predicate => new Predicate({ kind: 'logic', operator: 'OR', children: Object.freeze([...children]) });
export const not = (child: Predicate): Predicate => new Predicate({ kind: 'not', child });

export interface TextMatchOptions { case?: TextMatchCase }
type TextRef = ColumnRef<string | null, 'text'>;
type RangeKind = Extract<Kind, 'integer' | 'bigint' | 'real' | 'text'>;
function checkRef(ref: ColumnRef, allowed: readonly Kind[]): void {
  if (!isColumnRef(ref) || !isTable(ref.table) || typeof ref.name !== 'string' || !Object.hasOwn(ref.table.columns, ref.name)
      || !allowed.includes(ref.table.columns[ref.name].config.kind)) fail('QUERY', 'This predicate requires a mapped column of a supported scalar kind.');
}
function textMatch(ref: TextRef, literal: string, options: TextMatchOptions | undefined, mode: TextMatchMode): Predicate {
  checkRef(ref, ['text']);
  return new Predicate({ kind: 'text-match', ref, mode, case: textMatchOptions(options), literal: textMatchLiteral(literal) });
}
export const contains = (ref: TextRef, literal: string, options?: TextMatchOptions): Predicate => textMatch(ref, literal, options, 'contains');
export const startsWith = (ref: TextRef, literal: string, options?: TextMatchOptions): Predicate => textMatch(ref, literal, options, 'starts-with');
export const endsWith = (ref: TextRef, literal: string, options?: TextMatchOptions): Predicate => textMatch(ref, literal, options, 'ends-with');
export function between<T extends string | number | bigint, K extends RangeKind>(ref: ColumnRef<T | null, K>, from: NoInfer<T>, to: NoInfer<T>): Predicate {
  checkRef(ref, ['integer', 'bigint', 'real', 'text']);
  if (from === null || from === undefined || to === null || to === undefined) fail('QUERY', 'A range needs two non-null scalar bounds.');
  return and(comparison(ref, '>=', [from]), comparison(ref, '<=', [to]));
}

type NumericKind = Extract<Kind, 'integer' | 'bigint' | 'real'>;
type EqualityKind = NumericKind | 'text' | 'boolean';
type OrderedKind = NumericKind | 'text';
type CompatibleKind<K> = [K] extends [NumericKind] ? NumericKind
  : [K] extends ['text'] ? 'text' : [K] extends ['boolean'] ? 'boolean' : never;
type EqualityColumnComparison = <K extends EqualityKind>(left: ColumnRef<unknown, K>, right: ColumnRef<unknown, CompatibleKind<NoInfer<K>>>) => Predicate;
type OrderedColumnComparison = <K extends OrderedKind>(left: ColumnRef<unknown, K>, right: ColumnRef<unknown, CompatibleKind<NoInfer<K>>>) => Predicate;
function validateColumnRefs(left: ColumnRef, right: ColumnRef, operator: ColumnComparisonOperator): void {
  if (!isColumnRef(left) || !isColumnRef(right)) fail('QUERY', 'Column comparisons need two genuine mapped column references.');
  if (left.table !== right.table) fail('QUERY', 'Column comparison operands must belong to the exact same mapped table.');
  if (left.name === right.name) fail('QUERY', 'Compare two distinct mapped columns. Use an explicit NULL predicate for a self check.');
  if (!columnKindsCompatible(left.table.columns[left.name].config.kind, right.table.columns[right.name].config.kind, operator)) fail('QUERY', 'Column comparison operands must have compatible scalar kinds.');
}
function columnComparison(left: ColumnRef, right: ColumnRef, operator: ColumnComparisonOperator): Predicate {
  validateColumnRefs(left, right, operator);
  return new Predicate({ kind: 'column-compare', left, right, operator });
}
export const eqColumns: EqualityColumnComparison = (left, right) => columnComparison(left, right, '=');
export const neColumns: EqualityColumnComparison = (left, right) => columnComparison(left, right, '<>');
export const gtColumns: OrderedColumnComparison = (left, right) => columnComparison(left, right, '>');
export const gteColumns: OrderedColumnComparison = (left, right) => columnComparison(left, right, '>=');
export const ltColumns: OrderedColumnComparison = (left, right) => columnComparison(left, right, '<');
export const lteColumns: OrderedColumnComparison = (left, right) => columnComparison(left, right, '<=');

export interface CompiledQuery { sql: string; parameters: Parameter[] }
export interface CompiledPredicate extends CompiledQuery { truth: true | false | null }
/** Lower public helpers only after exact mapped-table identity validation. */
export function predicateToModel(table: AnyTable, predicate?: Predicate, mapped?: (table: AnyTable) => void): PredicateModel | undefined {
  if (predicate === undefined) return undefined;
  let count = 0, bound = 0;
  function visit(p: Predicate, depth: number, scope: AnyTable = table, relationDepth = 0): PredicateModel {
    if (!(p instanceof Predicate) || ++count > 100 || depth > 16) fail('QUERY', 'Predicates must be bounded expressions built with Rowstitch helpers.');
    const n = p.node;
    if (n.kind === 'relation-filter' || n.kind === 'relation-count') {
      if (relationDepth >= 4) fail('QUERY', 'Relation filters support at most four nested relationships.');
      const relation = validateFilterRelation(n.relation);
      if (n.kind === 'relation-filter' && (!['some', 'none', 'every'].includes(n.quantifier) || n.quantifier === 'every' && n.predicate === undefined)) fail('QUERY', 'A relation filter needs a supported quantifier and every requires a predicate.');
      const { localKey, foreignKey, where } = relation.options;
      if (localKey.table !== scope) fail('QUERY', 'A relation filter local key must reference the current table.');
      mapped?.(relation.table);
      const base = { table: mappedTableModel(relation.table), localKey: localKey.name, foreignKey: foreignKey.name,
        ...(where === undefined ? {} : { where: visit(where, depth + 1, relation.table, relationDepth + 1) }),
        ...(n.predicate === undefined ? {} : { predicate: visit(n.predicate, depth + 1, relation.table, relationDepth + 1) }) };
      if (n.kind === 'relation-count') {
        bound++;
        return { ...base, kind: 'relation-count', ...relationCountComparison(n.operator, n.threshold) };
      }
      return { ...base, kind: 'relation-filter', quantifier: n.quantifier };
    }
    if (n.kind === 'column-compare') {
      const left = n.left, right = n.right, operator = n.operator;
      validateColumnRefs(left, right, operator);
      if (left.table !== scope || right.table !== scope) fail('QUERY', 'A predicate must reference the queried table.');
      return { kind: 'column-compare', left: left.name, right: right.name, operator };
    }
    if (n.kind === 'text-match') {
      const ref = n.ref;
      if (!isColumnRef(ref) || ref.table !== scope || !Object.hasOwn(scope.columns, ref.name)) fail('QUERY', 'A predicate must reference the queried table.');
      checkRef(ref, ['text']);
      bound += n.mode === 'ends-with' ? 3 : 1;
      return { kind: 'text-match', column: ref.name, mode: n.mode, case: n.case, literal: n.literal };
    }
    if (n.kind === 'comparison') {
      const ref = n.ref;
      if (!isColumnRef(ref) || ref.table !== scope || !Object.hasOwn(scope.columns, ref.name)) fail('QUERY', 'A predicate must reference the queried table.');
      identifier(ref.name);
      if (!['=', '<>', '>', '>=', '<', '<=', 'IN'].includes(n.operator)) fail('QUERY', 'The predicate operator is not supported.');
      if (n.operator !== 'IN' && n.values.length !== 1) fail('QUERY', 'A comparison requires one value.');
      if (n.operator !== 'IN' && n.values[0] === null && n.operator !== '=' && n.operator !== '<>') fail('QUERY', 'NULL only supports equality or inequality comparisons.');
      bound += n.values.filter(v => v !== null).length;
      return { kind: 'compare', column: ref.name, operator: n.operator as ComparisonOperator, values: [...n.values] };
    }
    if (n.kind === 'not') return { kind: 'not', child: visit(n.child, depth + 1, scope, relationDepth) };
    if (n.kind !== 'logic' || !['AND', 'OR'].includes(n.operator) || !Array.isArray(n.children)) fail('QUERY', 'The predicate expression is not supported.');
    return { kind: 'logic', operator: n.operator, children: n.children.map(child => visit(child, depth + 1, scope, relationDepth)) };
  }
  const result = visit(predicate, 0);
  if (bound > 10_000) fail('QUERY', 'A query has too many bound parameters.');
  return predicateModel(mappedTableModel(table), result);
}
export function compilePredicate(table: AnyTable, predicate?: Predicate): CompiledPredicate {
  return compileSqlitePredicate(mappedTableModel(table), predicateToModel(table, predicate));
}

export interface Ordering { readonly ref: ColumnRef; readonly direction: 'ASC' | 'DESC' }
export function asc(ref: ColumnRef): Ordering { return Object.freeze({ ref, direction: 'ASC' }); }
export function desc(ref: ColumnRef): Ordering { return Object.freeze({ ref, direction: 'DESC' }); }
export function orderToModel(table: AnyTable, order: readonly Ordering[] = [], deterministic = false): readonly OrderModel[] {
  if (!Array.isArray(order) || order.length > 100) fail('QUERY', 'Ordering must be a bounded list of mapped columns.');
  const items = [...order].map(item => {
    const ref = item?.ref, direction = item?.direction;
    if (!isColumnRef(ref) || ref.table !== table || !Object.hasOwn(table.columns, ref.name) || !['ASC', 'DESC'].includes(direction)) fail('QUERY', 'Ordering must reference the queried table.');
    return { ref, direction };
  });
  if (deterministic) {
    for (const [name, c] of Object.entries(table.columns) as [string, { config: { primary: boolean } }][]) {
      if (c.config.primary && !items.some(i => i.ref.name === name)) items.push(asc(table.col(name)));
    }
  }
  return orderingModel(mappedTableModel(table), items.map(i => ({ column: i.ref.name, direction: i.direction })));
}
export function orderSql(table: AnyTable, order: readonly Ordering[] = [], deterministic = false): string {
  return compileSqliteOrder(mappedTableModel(table), orderToModel(table, order, deterministic));
}

export type Selection<T extends AnyTable> = readonly (keyof T['columns'] & string)[];
export function assertOptions(value: unknown, allowed: readonly string[]): void {
  plainRecord(value);
  if (Object.keys(value as object).some(key => !allowed.includes(key))) fail('QUERY', 'A query option is not supported. Check the option names.');
}
export function selectionFields(table: AnyTable, select: readonly string[] | undefined): string[] {
  if (select === undefined) return Object.keys(table.columns);
  if (!Array.isArray(select) || !select.length || select.length > 100
      || select.some(name => typeof name !== 'string' || !Object.hasOwn(table.columns, name))
      || new Set(select).size !== select.length) fail('QUERY', 'Select a nonempty list of distinct mapped column names.');
  return [...select];
}
export interface RelationOptions<I extends Includes = Includes, S extends readonly string[] | undefined = undefined> {
  localKey: ColumnRef;
  foreignKey: ColumnRef;
  where?: Predicate;
  orderBy?: readonly Ordering[];
  limit?: number;
  offset?: number;
  include?: I;
  select?: S;
}
export type SingularOptions<I extends Includes = Includes, S extends readonly string[] | undefined = undefined> = Omit<RelationOptions<I, S>, 'limit' | 'offset'>;
const relationDescriptors = new WeakSet<object>();
export class ManyRelation<T extends AnyTable = AnyTable, I extends Includes = {}, S extends readonly string[] | undefined = undefined> {
  readonly kind = 'many';
  constructor(public readonly table: T, public readonly options: Readonly<RelationOptions<I, S>>) { relationDescriptors.add(this); Object.freeze(this); }
}
export class SingularRelation<T extends AnyTable = AnyTable, I extends Includes = {}, S extends readonly string[] | undefined = undefined> {
  readonly kind = 'one';
  constructor(public readonly table: T, public readonly options: Readonly<SingularOptions<I, S>>, public readonly direction: 'hasOne' | 'belongsTo') { relationDescriptors.add(this); Object.freeze(this); }
}
export type Includes = Record<string, ManyRelation<AnyTable, any, any> | SingularRelation<AnyTable, any, any>>;

/** Filtering reuses unpaginated relations; eager-only options must not change the set silently. */
export type FilterRelation = ManyRelation<AnyTable, any, any> | SingularRelation<AnyTable, any, any>;
export function isRelation(value: unknown): value is FilterRelation {
  return typeof value === 'object' && value !== null && relationDescriptors.has(value);
}
function validateFilterRelation(relation: FilterRelation): { table: AnyTable; options: RelationOptions<Includes, readonly string[] | undefined> } {
  if (!isRelation(relation) || !isTable(relation.table)) fail('QUERY', 'A relation filter needs a mapped Rowstitch relationship.');
  const table = relation.table, input = relation.options;
  plainRecord(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = (descriptors as Record<PropertyKey, PropertyDescriptor>)[key];
    if (typeof key !== 'string' || !('value' in descriptor)) fail('QUERY', 'A relation filter needs plain options without accessors.');
    snapshot[key] = descriptor.value;
  }
  assertOptions(snapshot, ['localKey', 'foreignKey', 'where', 'orderBy', 'limit', 'offset', 'include', 'select']);
  const options = snapshot as unknown as RelationOptions<Includes, readonly string[] | undefined>;
  for (const option of ['orderBy', 'limit', 'offset', 'include', 'select'] as const) {
    if (options[option] !== undefined) fail('QUERY', 'Relation filters do not accept ordering, pagination, includes or selected columns. Use an unpaginated relation.');
  }
  const { localKey, foreignKey } = options;
  if (!isColumnRef(localKey) || !isColumnRef(foreignKey) || foreignKey.table !== table
      || !relationKindsCompatible(localKey.table.columns[localKey.name].config.kind, table.columns[foreignKey.name].config.kind)) fail('QUERY', 'Relation filters require compatible mapped integer, bigint or text keys.');
  return { table, options };
}
function relationFilter(quantifier: RelationQuantifier, relation: FilterRelation, predicate?: Predicate): Predicate {
  validateFilterRelation(relation);
  if (predicate !== undefined && !(predicate instanceof Predicate) || quantifier === 'every' && predicate === undefined) fail('QUERY', 'Every requires a predicate for the related rows.');
  return new Predicate({ kind: 'relation-filter', quantifier, relation, ...(predicate === undefined ? {} : { predicate }) });
}
export const some = (relation: FilterRelation, predicate?: Predicate): Predicate => relationFilter('some', relation, predicate);
export const none = (relation: FilterRelation, predicate?: Predicate): Predicate => relationFilter('none', relation, predicate);
/** Empty domains pass; a related row must evaluate to TRUE, not NULL, to pass. */
export const every = (relation: FilterRelation, predicate: Predicate): Predicate => relationFilter('every', relation, predicate);
export type RelationCountOperator = ColumnComparisonOperator;
/** Compare the count of matching related rows in SQLite, without loading those rows. */
export function countRelated(relation: FilterRelation, operator: RelationCountOperator, threshold: number, predicate?: Predicate): Predicate {
  validateFilterRelation(relation);
  if (predicate !== undefined && !(predicate instanceof Predicate)) fail('QUERY', 'A related count filter needs a Rowstitch predicate.');
  return new Predicate({ kind: 'relation-count', relation, ...relationCountComparison(operator, threshold), ...(predicate === undefined ? {} : { predicate }) });
}

export function validateRelation(table: AnyTable, options: RelationOptions<Includes, readonly string[] | undefined>, singular: boolean): void {
  if (!isTable(table)) fail('QUERY', 'A relation requires a genuine mapped target table.');
  assertOptions(options, ['localKey', 'foreignKey', 'where', 'orderBy', 'include', 'select', ...(singular ? [] : ['limit', 'offset'])]);
  const localKey = options?.localKey, foreignKey = options?.foreignKey;
  if (!isColumnRef(localKey) || !isColumnRef(foreignKey)
      || foreignKey.table !== table || !Object.hasOwn(localKey.table.columns, localKey.name)
      || !Object.hasOwn(table.columns, foreignKey.name)) fail('QUERY', 'A relation needs mapped local and foreign keys.');
  selectionFields(table, options.select);
  compilePredicate(table, options.where);
  orderSql(table, options.orderBy);
  for (const key of ['limit', 'offset'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > (key === 'limit' ? 1000 : 1_000_000_000))) fail('QUERY', 'A relationship limit or offset is outside its documented integer range.');
  }
}
function immutableOptions<O extends RelationOptions<Includes, readonly string[] | undefined>>(options: O): O {
  return Object.freeze({ ...options, ...(options.select ? { select: Object.freeze([...options.select]) } : {}),
    ...(options.orderBy ? { orderBy: Object.freeze([...options.orderBy]) } : {}) });
}
export function hasMany<T extends AnyTable, I extends Includes, const S extends Selection<T> | undefined = undefined>(table: T, options: RelationOptions<I, S> & { include: I }): ManyRelation<T, I, NoInfer<S>>;
export function hasMany<T extends AnyTable, const S extends Selection<T> | undefined = undefined>(table: T, options: Omit<RelationOptions<{}, S>, 'include'>): ManyRelation<T, {}, NoInfer<S>>;
export function hasMany<T extends AnyTable, I extends Includes = {}, S extends Selection<T> | undefined = undefined>(table: T, options: RelationOptions<I, S>): ManyRelation<T, I, S> {
  validateRelation(table, options, false);
  return new ManyRelation(table, immutableOptions(options));
}
export function hasOne<T extends AnyTable, I extends Includes, const S extends Selection<T> | undefined = undefined>(table: T, options: SingularOptions<I, S> & { include: I }): SingularRelation<T, I, NoInfer<S>>;
export function hasOne<T extends AnyTable, const S extends Selection<T> | undefined = undefined>(table: T, options: Omit<SingularOptions<{}, S>, 'include'>): SingularRelation<T, {}, NoInfer<S>>;
export function hasOne<T extends AnyTable, I extends Includes = {}, S extends Selection<T> | undefined = undefined>(table: T, options: SingularOptions<I, S>): SingularRelation<T, I, S> {
  validateRelation(table, options, true);
  return new SingularRelation(table, immutableOptions(options), 'hasOne');
}
export function belongsTo<T extends AnyTable, I extends Includes, const S extends Selection<T> | undefined = undefined>(table: T, options: SingularOptions<I, S> & { include: I }): SingularRelation<T, I, NoInfer<S>>;
export function belongsTo<T extends AnyTable, const S extends Selection<T> | undefined = undefined>(table: T, options: Omit<SingularOptions<{}, S>, 'include'>): SingularRelation<T, {}, NoInfer<S>>;
export function belongsTo<T extends AnyTable, I extends Includes = {}, S extends Selection<T> | undefined = undefined>(table: T, options: SingularOptions<I, S>): SingularRelation<T, I, S> {
  validateRelation(table, options, true);
  return new SingularRelation(table, immutableOptions(options), 'belongsTo');
}
type IsUnion<Value, Whole = Value> = Value extends Whole ? [Whole] extends [Value] ? false : true : never;
/** Arrays and union-valued tuple slots do not guarantee any particular selected key. */
type GuaranteedSelection<S extends readonly string[]> = number extends S['length'] ? never : {
  [K in keyof S]: IsUnion<S[K]> extends false ? S[K] : never
}[number];
// Reify the tuple before distributing: NoInfer<S> in query return types otherwise
// suppresses distribution of tuple unions and optional selection arrays.
type SelectionCopy<S> = S extends readonly [...infer Items extends string[]] | undefined ? readonly [...Items] : never;
type ProjectedRow<T extends AnyTable, S extends readonly string[]> = S extends readonly string[]
  ? Pick<Row<T>, Extract<GuaranteedSelection<S>, keyof Row<T>>>
    & Partial<Pick<Row<T>, Exclude<Extract<S[number], keyof Row<T>>, GuaranteedSelection<S>>>>
  : never;
export type SelectedRow<T extends AnyTable, S extends readonly string[] | undefined> = [S] extends [never] ? never
  : [S] extends [undefined] ? Row<T>
  : undefined extends S ? Row<T> | ProjectedRow<T, SelectionCopy<S>>
  : ProjectedRow<T, SelectionCopy<S>>;
export type WithIncludes<T extends AnyTable, I extends Includes, S extends readonly string[] | undefined = undefined> = SelectedRow<T, S> & {
  [K in keyof I]: I[K] extends ManyRelation<infer Child, infer Nested, infer ChildSelect> ? WithIncludes<Child, Nested, ChildSelect>[]
    : I[K] extends SingularRelation<infer Child, infer Nested, infer ChildSelect> ? WithIncludes<Child, Nested, ChildSelect> | null : never
};
export interface FindOptions<I extends Includes = Includes, S extends readonly string[] | undefined = undefined> {
  where?: Predicate;
  orderBy?: readonly Ordering[];
  limit?: number;
  offset?: number;
  include?: I;
  select?: S;
}
