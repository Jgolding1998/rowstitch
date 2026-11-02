import { fail } from './errors.js';
import { ColumnRef, encode, identifier, plainRecord, type AnyTable, type Parameter, type Row } from './schema.js';

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
export function compilePredicate(table: AnyTable, predicate?: Predicate): CompiledPredicate {
  if (predicate === undefined) return { sql: '', parameters: [], truth: true };
  let count = 0;
  const parameters: Parameter[] = [];
  function visit(p: Predicate, depth: number): { sql: string; truth: true | false | null } {
    if (!(p instanceof Predicate) || ++count > 100 || depth > 16) fail('QUERY', 'Predicates must be bounded expressions built with Rowstitch helpers.');
    const n = p.node;
    if (n.kind === 'comparison') {
      if (!(n.ref instanceof ColumnRef) || n.ref.table !== table || !Object.hasOwn(table.columns, n.ref.name)) fail('QUERY', 'A predicate must reference the queried table.');
      const name = identifier(n.ref.name);
      if (!['=', '<>', '>', '>=', '<', '<=', 'IN'].includes(n.operator)) fail('QUERY', 'The predicate operator is not supported.');
      if (n.operator === 'IN') {
        if (!n.values.length) return { sql: '0', truth: false };
        const nonNull = n.values.filter(v => v !== null);
        const hasNull = nonNull.length !== n.values.length;
        const parts: string[] = [];
        if (nonNull.length) {
          parameters.push(...nonNull);
          parts.push(name + ' IN (' + nonNull.map(() => '?').join(', ') + ')');
        }
        if (hasNull) parts.push(name + ' IS NULL');
        return { sql: '(' + parts.join(' OR ') + ')', truth: null };
      }
      if (n.values.length !== 1) fail('QUERY', 'A comparison requires one value.');
      if (n.values[0] === null) {
        if (n.operator !== '=' && n.operator !== '<>') fail('QUERY', 'NULL only supports equality or inequality comparisons.');
        return { sql: name + (n.operator === '=' ? ' IS NULL' : ' IS NOT NULL'), truth: null };
      }
      parameters.push(n.values[0]);
      return { sql: name + ' ' + n.operator + ' ?', truth: null };
    }
    if (n.kind === 'not') {
      const child = visit(n.child, depth + 1);
      return { sql: 'NOT (' + child.sql + ')', truth: child.truth === null ? null : !child.truth };
    }
    if (n.kind !== 'logic' || !['AND', 'OR'].includes(n.operator) || !Array.isArray(n.children)) fail('QUERY', 'The predicate expression is not supported.');
    const parts = n.children.map(child => visit(child, depth + 1));
    const truth = n.operator === 'AND'
      ? parts.some(p => p.truth === false) ? false : parts.every(p => p.truth === true) ? true : null
      : parts.some(p => p.truth === true) ? true : parts.every(p => p.truth === false) ? false : null;
    return { sql: parts.length ? '(' + parts.map(p => p.sql).join(' ' + n.operator + ' ') + ')' : n.operator === 'AND' ? '1' : '0', truth };
  }
  const result = visit(predicate, 0);
  if (parameters.length > 10_000) fail('QUERY', 'A query has too many bound parameters.');
  return { ...result, parameters };
}

export interface Ordering { readonly ref: ColumnRef; readonly direction: 'ASC' | 'DESC' }
export function asc(ref: ColumnRef): Ordering { return Object.freeze({ ref, direction: 'ASC' }); }
export function desc(ref: ColumnRef): Ordering { return Object.freeze({ ref, direction: 'DESC' }); }
export function orderSql(table: AnyTable, order: readonly Ordering[] = [], deterministic = false): string {
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
  return items.length ? ' ORDER BY ' + items.map(i => identifier(i.ref.name) + ' ' + i.direction).join(', ') : '';
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
