import { fail } from './errors.js';
import { ColumnRef, encode, identifier, plainRecord, type AnyTable, type Parameter, type Row } from './schema.js';
import { mappedTableModel } from './model-mapping.js';
import { orderingModel, predicateModel, type ComparisonOperator, type OrderModel, type PredicateModel } from './query-model.js';
import { compileSqliteOrder, compileSqlitePredicate } from './sqlite-compiler.js';

type Node = { kind: 'comparison'; ref: ColumnRef; operator: string; values: readonly Parameter[] }
  | { kind: 'logic'; operator: 'AND' | 'OR'; children: readonly Predicate[] }
  | { kind: 'not'; child: Predicate };
export class Predicate {
  constructor(public readonly node: Node) { Object.freeze(node); Object.freeze(this); }
}
function comparison<T>(ref: ColumnRef<T>, operator: string, values: readonly unknown[]): Predicate {
  if (!(ref instanceof ColumnRef)) fail('QUERY', 'A predicate needs a mapped column reference.');
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

export interface CompiledQuery { sql: string; parameters: Parameter[] }
export interface CompiledPredicate extends CompiledQuery { truth: true | false | null }
/** Lower public helpers only after exact mapped-table identity validation. */
export function predicateToModel(table: AnyTable, predicate?: Predicate): PredicateModel | undefined {
  if (predicate === undefined) return undefined;
  let count = 0, bound = 0;
  function visit(p: Predicate, depth: number): PredicateModel {
    if (!(p instanceof Predicate) || ++count > 100 || depth > 16) fail('QUERY', 'Predicates must be bounded expressions built with Rowstitch helpers.');
    const n = p.node;
    if (n.kind === 'comparison') {
      if (!(n.ref instanceof ColumnRef) || n.ref.table !== table || !Object.hasOwn(table.columns, n.ref.name)) fail('QUERY', 'A predicate must reference the queried table.');
      identifier(n.ref.name);
      if (!['=', '<>', '>', '>=', '<', '<=', 'IN'].includes(n.operator)) fail('QUERY', 'The predicate operator is not supported.');
      if (n.operator !== 'IN' && n.values.length !== 1) fail('QUERY', 'A comparison requires one value.');
      if (n.operator !== 'IN' && n.values[0] === null && n.operator !== '=' && n.operator !== '<>') fail('QUERY', 'NULL only supports equality or inequality comparisons.');
      bound += n.values.filter(v => v !== null).length;
      return { kind: 'compare', column: n.ref.name, operator: n.operator as ComparisonOperator, values: [...n.values] };
    }
    if (n.kind === 'not') return { kind: 'not', child: visit(n.child, depth + 1) };
    if (n.kind !== 'logic' || !['AND', 'OR'].includes(n.operator) || !Array.isArray(n.children)) fail('QUERY', 'The predicate expression is not supported.');
    return { kind: 'logic', operator: n.operator, children: n.children.map(child => visit(child, depth + 1)) };
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
  const items = [...order];
  for (const item of items) {
    if (!item || !(item.ref instanceof ColumnRef) || item.ref.table !== table || !Object.hasOwn(table.columns, item.ref.name) || !['ASC', 'DESC'].includes(item.direction)) fail('QUERY', 'Ordering must reference the queried table.');
  }
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
export class ManyRelation<T extends AnyTable = AnyTable, I extends Includes = {}, S extends readonly string[] | undefined = undefined> {
  readonly kind = 'many';
  constructor(public readonly table: T, public readonly options: Readonly<RelationOptions<I, S>>) { Object.freeze(this); }
}
export class SingularRelation<T extends AnyTable = AnyTable, I extends Includes = {}, S extends readonly string[] | undefined = undefined> {
  readonly kind = 'one';
  constructor(public readonly table: T, public readonly options: Readonly<SingularOptions<I, S>>, public readonly direction: 'hasOne' | 'belongsTo') { Object.freeze(this); }
}
export type Includes = Record<string, ManyRelation<AnyTable, any, any> | SingularRelation<AnyTable, any, any>>;

export function validateRelation(table: AnyTable, options: RelationOptions<Includes, readonly string[] | undefined>, singular: boolean): void {
  assertOptions(options, ['localKey', 'foreignKey', 'where', 'orderBy', 'include', 'select', ...(singular ? [] : ['limit', 'offset'])]);
  if (!options || !(options.localKey instanceof ColumnRef) || !(options.foreignKey instanceof ColumnRef)
      || options.foreignKey.table !== table || !Object.hasOwn(options.localKey.table.columns, options.localKey.name)
      || !Object.hasOwn(table.columns, options.foreignKey.name)) fail('QUERY', 'A relation needs mapped local and foreign keys.');
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
export type SelectedRow<T extends AnyTable, S extends readonly string[] | undefined> = S extends readonly string[]
  ? Pick<Row<T>, Extract<S[number], keyof Row<T>>> : Row<T>;
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
