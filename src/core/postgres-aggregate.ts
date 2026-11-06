/** Native aggregate/group/projected-related rendering of normalized plans. No caller SQL, connection or execution. */
import { isDeepStrictEqual } from 'node:util';
import { aggregateLayout } from './aggregate-layout.js';
import { projectedLayout } from './projected-layout.js';
import { fail } from './errors.js';
import type { Kind } from './schema.js';
import type { AggregateModel, AggregateSelectModel, GroupModel, OrderModel, PredicateModel, ProjectedAggregateModel, SelectModel, TableModel } from './query-model.js';
import type { PostgresAggregateField, PostgresAggregateProfile } from './postgres-aggregate-profile.js';
import { postgresAggregateInput, POSTGRES_CANONICAL_TYPE } from './postgres-aggregate-input.js';
import { postgresRealAverage } from './postgres-real-average.js';

export interface PostgresAggregateContext {
  source(table: TableModel): string;
  /** Base-table reads only. Derived CTE slots must never pass through a physical column map. */
  column(table: TableModel, scope: string, logicalColumn: string): string;
  predicate(table: TableModel, scope: string, predicate?: PredicateModel): string;
  kind(table: TableModel, column: string): Kind;
  metadata(table: TableModel): void;
  bindInteger(value: number): string;
}
export interface PostgresAggregateCompilation { readonly sql: string; readonly profile: PostgresAggregateProfile; readonly realRange: boolean }
type Model = AggregateModel | GroupModel | SelectModel;
type Selection = AggregateSelectModel | ProjectedAggregateModel;
type WithoutAlias<T> = T extends { readonly alias: string } ? Omit<T, 'alias'> : never;
interface Domain {
  name: string; table: TableModel; columns: Map<string, string>; families: Map<string, string>;
  groups: string[]; ordinal: string; bad: string;
}
interface RawDomain { readonly name: string; readonly columns: Map<string, string> }
interface Statistic { readonly name: string; readonly scope: string; readonly groups: string[]; readonly ordinal: string }
interface RelatedValue { readonly statistic: Statistic; readonly value: string }
interface ValueParts { readonly select: string[]; readonly slots: string[]; readonly value: (scope: string) => string }
const q = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const f = (scope: string, name: string): string => scope + '.' + q(name);
const cast = (name: string): string => '::"pg_catalog"."' + name + '"';
const fn = (name: string, argument: string): string => '"pg_catalog"."' + name + '"(' + argument + ')';
const equal = (left: string, right: string): string => '(' + left + ' OPERATOR("pg_catalog".=) ' + right + ')';
const nullSafeEqual = (left: string, right: string): string => '((' + left + ' IS NULL AND ' + right + ' IS NULL) OR ('
  + left + ' IS NOT NULL AND ' + right + ' IS NOT NULL AND ' + equal(left, right) + '))';
const anyBad = (items: readonly string[]): string => items.length ? '(CASE WHEN ' + items.map(item => equal('(' + item + ')', '1')).join(' OR ') + ' THEN 1 ELSE 0 END)' : '0';
const order = (table: TableModel, entries: readonly OrderModel[], ctx: PostgresAggregateContext, resolve: (logical: string) => string): string => entries.length
  ? ' ORDER BY ' + entries.map(entry => (ctx.kind(table, entry.column) === 'json' ? '(' + resolve(entry.column) + ')' + cast('jsonb') : resolve(entry.column))
    + ' ' + entry.direction + (entry.direction === 'ASC' ? ' NULLS FIRST' : ' NULLS LAST')).join(', ') : '';

export function compilePostgresAggregate(query: Model, ctx: PostgresAggregateContext): PostgresAggregateCompilation {
  ctx.metadata(query.table);
  const projected = query.kind === 'select', grouped = query.kind === 'group';
  const selections: readonly Selection[] = projected ? query.aggregates! : query.select;
  if (!selections?.length) fail('QUERY', 'An aggregate plan requires selected summaries.');
  const groupColumns = grouped ? query.by : [];
  const fields: PostgresAggregateField[] = [], ctes: string[] = [], familyFailures: string[] = [];
  let serial = 0, realRange = false;
  const name = (prefix: string): string => '__rs_pa_' + prefix + '_' + serial++;
  const add = (prefix: string, slots: readonly string[], sql: string): string => {
    if (!slots.length || new Set(slots).size !== slots.length) fail('QUERY', 'An aggregate boundary requires distinct private slots.');
    const id = name(prefix); ctes.push(q(id) + '(' + slots.map(q).join(', ') + ') AS MATERIALIZED (' + sql + ')'); return id;
  };
  const exists = (domain: string, where?: string): string => 'EXISTS (SELECT 1 FROM ' + q(domain) + ' AS "e"' + (where ? ' WHERE ' + where : '') + ')';
  const ownColumns = (table: TableModel, columns: Iterable<string>): string[] => {
    ctx.metadata(table);
    const result = [...new Set(columns)];
    for (const column of result) ctx.kind(table, column);
    return result;
  };
  const typed = (raw: RawDomain, table: TableModel, logicalColumns: string[], logicalGroups: string[], ordinal: string, ordering: readonly OrderModel[] = []): Domain => {
    const values: string[] = [], slots: string[] = [], invalid: string[] = [], columns = new Map<string, string>(), families = new Map<string, string>();
    for (const [i, column] of logicalColumns.entries()) {
      const input = postgresAggregateInput(f('"r"', raw.columns.get(column)!), ctx.kind(table, column), table.nullable![column]);
      const slot = '__rs_col_' + i, family = '__rs_family_' + i; columns.set(column, slot); families.set(column, family);
      values.push(input.value + ' AS ' + q(slot), input.familyInvalid + ' AS ' + q(family)); slots.push(slot, family); invalid.push(input.invalid);
    }
    values.push(anyBad(invalid) + ' AS "__rs_input_bad"'); slots.push('__rs_input_bad');
    if (ordinal) {
      values.push(fn('row_number', '') + ' OVER (' + order(table, ordering, ctx, logical => f('"r"', raw.columns.get(logical)!)).trim() + ') AS ' + q(ordinal));
      slots.push(ordinal);
    }
    const id = add('typed', slots, 'SELECT ' + values.join(', ') + ' FROM ' + q(raw.name) + ' AS "r"');
    return { name: id, table, columns, families, groups: logicalGroups.map(column => columns.get(column)!), ordinal, bad: '__rs_input_bad' };
  };
  const needed = new Set<string>(projected ? query.columns : aggregateLayout(query).inputColumns);
  for (const selection of selections) if (selection.path) needed.add(selection.path[0].localKey);
  const rootColumns = ownColumns(query.table, needed);
  const pageColumns = projected ? ownColumns(query.table, [...rootColumns, ...query.orderBy.map(item => item.column)]) : rootColumns;
  const rawColumns = new Map(pageColumns.map((column, index) => [column, '__rs_raw_' + index]));
  const where = ctx.predicate(query.table, '"r"', query.where);
  let rawSql = 'SELECT ' + (pageColumns.length ? pageColumns.map(column => ctx.column(query.table, '"r"', column) + ' AS ' + q(rawColumns.get(column)!)).join(', ') : '1 AS "__rs_dummy"')
    + ' FROM ' + ctx.source(query.table) + ' AS "r"' + (where ? ' WHERE ' + where : '');
  if (projected) rawSql += order(query.table, query.orderBy, ctx, logical => ctx.column(query.table, '"r"', logical)) + ' LIMIT ' + ctx.bindInteger(query.limit) + ' OFFSET ' + ctx.bindInteger(query.offset);
  const rootRaw = { name: add('root', pageColumns.length ? [...rawColumns.values()] : ['__rs_dummy'], rawSql), columns: rawColumns };
  const root = typed(rootRaw, query.table, rootColumns, [...groupColumns], projected ? '__rs_root_ord' : '', projected ? query.orderBy : []);
  // Captured models contain only normalized own data. Share only complete structurally equal paths, including
  // table metadata and every scoped predicate; neither alias names nor serialized caller values identify a domain.
  const paths: { path: NonNullable<Selection['path']>; indices: number[] }[] = [];
  for (const [selectionIndex, selection] of selections.entries()) {
    if (!selection.path) continue;
    const shared = paths.find(candidate => isDeepStrictEqual(candidate.path, selection.path));
    if (shared) shared.indices.push(selectionIndex);
    else paths.push({ path: selection.path, indices: [selectionIndex] });
  }
  const terminals: { domain: Domain; indices: number[] }[] = [];
  for (const shared of paths) {
    let previous = root;
    const argumentsAtLeaf = shared.indices.flatMap(index => selections[index].column ? [selections[index].column!] : []);
    for (const [hop, step] of shared.path.entries()) {
      const next = shared.path[hop + 1];
      const columns = ownColumns(step.table, [step.foreignKey, ...(next ? [next.localKey] : argumentsAtLeaf)]);
      const domainWhere = ctx.predicate(step.table, '"c"', step.where);
      const childRawColumns = new Map(columns.map((column, index) => [column, '__rs_raw_' + index]));
      const childRaw = { name: add('child', [...childRawColumns.values()], 'SELECT ' + columns.map(column => ctx.column(step.table, '"c"', column) + ' AS ' + q(childRawColumns.get(column)!)).join(', ')
        + ' FROM ' + ctx.source(step.table) + ' AS "c"' + (domainWhere ? ' WHERE ' + domainWhere : '')), columns: childRawColumns };
      const child = typed(childRaw, step.table, columns, [], '');
      const localFamily = previous.families.get(step.localKey)!, foreignFamily = child.families.get(step.foreignKey)!;
      // A wrong physical family has no valid native comparison. Do not sanitize it away and return a plausible zero.
      familyFailures.push(exists(previous.name, equal(f('"e"', localFamily), '1')));
      familyFailures.push('(' + exists(previous.name) + ' AND ' + exists(child.name, equal(f('"e"', foreignFamily), '1')) + ')');
      const groups = groupColumns.map((_, i) => '__rs_link_key_' + i), ord = previous.ordinal;
      const projection = columns.map(column => f('"c"', child.columns.get(column)!) + ' AS ' + q(child.columns.get(column)!));
      for (const [i, key] of previous.groups.entries()) projection.push(f('"p"', key) + ' AS ' + q(groups[i]));
      if (ord) projection.push(f('"p"', ord) + ' AS ' + q(ord));
      projection.push(anyBad([f('"p"', previous.bad), f('"c"', child.bad)]) + ' AS "__rs_input_bad"');
      for (const family of child.families.values()) projection.push(f('"c"', family) + ' AS ' + q(family));
      const joined = add('path', [...child.columns.values(), ...groups, ...(ord ? [ord] : []), child.bad, ...child.families.values()],
        'SELECT ' + projection.join(', ') + ' FROM ' + q(previous.name) + ' AS "p" JOIN ' + q(child.name)
        + ' AS "c" ON ' + equal(f('"c"', child.columns.get(step.foreignKey)!), f('"p"', previous.columns.get(step.localKey)!)));
      previous = { ...child, name: joined, groups, ordinal: ord };
    }
    terminals.push({ domain: previous, indices: shared.indices });
  }
  const badDomains = [root, ...terminals.map(terminal => terminal.domain)].map(domain => exists(domain.name, equal(f('"e"', domain.bad), '1')));
  const global = add('guard', ['bad'], 'SELECT CASE WHEN ' + [...badDomains, ...familyFailures].join(' OR ') + ' THEN 1 ELSE 0 END AS "bad"');
  const argument = (domain: Domain, column: string): string => '(CASE WHEN ' + equal('"g"."bad"', '0') + ' THEN ' + f('"d"', domain.columns.get(column)!)
    + ' ELSE NULL' + cast(POSTGRES_CANONICAL_TYPE[ctx.kind(domain.table, column)]) + ' END)';
  const valueParts = (domain: Domain, selection: Selection, suffix: string): ValueParts => {
    const base = '__rs_value_' + suffix, arg = selection.column ? argument(domain, selection.column) : '*';
    const kind = selection.column ? ctx.kind(domain.table, selection.column) : undefined;
    if (selection.operation === 'avg' && kind === 'real') {
      realRange = true;
      return { select: [fn('sum', arg) + ' AS ' + q(base + '_sum'), fn('count', arg) + ' AS ' + q(base + '_count')], slots: [base + '_sum', base + '_count'],
        value: scope => postgresRealAverage(f(scope, base + '_sum'), f(scope, base + '_count')) };
    }
    if (selection.operation === 'sum' && kind === 'real') realRange = true;
    const input = selection.operation === 'sum' && (kind === 'integer' || kind === 'bigint') ? '(' + arg + ')' + cast('numeric')
      : selection.operation === 'avg' && (kind === 'integer' || kind === 'bigint') ? '(' + arg + ')' + cast('numeric') : arg;
    let expression = fn(selection.operation, input);
    if (selection.operation === 'avg') expression = '(' + expression + ')' + cast('float8');
    return { select: [expression + ' AS ' + q(base)], slots: [base], value: scope => f(scope, base) };
  };
  const related = new Map<number, RelatedValue>(), attachments: Statistic[] = [];
  for (const { domain, indices } of terminals) {
    const groups = grouped ? domain.groups : [], ordinal = projected ? domain.ordinal : '';
    const keys = [...groups, ...(ordinal ? [ordinal] : [])];
    const selected = keys.map((column, i) => f('"d"', column) + ' AS ' + q('__rs_group_' + i));
    const selectedSlots = keys.map((_, i) => '__rs_group_' + i);
    // Aggregate every distinct operation once over this domain, then reuse its typed value for repeated aliases.
    const operations: { selection: Selection; parts: ValueParts; alias: string }[] = [];
    const outputs: { index: number; operation: typeof operations[number] }[] = [];
    for (const index of indices) {
      const selection = selections[index];
      let operation = operations.find(candidate => candidate.selection.operation === selection.operation
        && candidate.selection.column === selection.column && candidate.selection.approximate === selection.approximate);
      if (!operation) {
        operation = { selection, parts: valueParts(domain, selection, String(index)), alias: '__rs_value_' + index };
        operations.push(operation); selected.push(...operation.parts.select); selectedSlots.push(...operation.parts.slots);
      }
      outputs.push({ index, operation });
    }
    const basic = add('related_stats', selectedSlots, 'SELECT ' + selected.join(', ') + ' FROM ' + q(domain.name) + ' AS "d" CROSS JOIN ' + q(global)
      + ' AS "g"' + (keys.length ? ' GROUP BY ' + keys.map(column => f('"d"', column)).join(', ') : ''));
    const aliases = keys.map((_, i) => '__rs_group_' + i);
    const finished = add('related_values', [...aliases, ...operations.map(operation => operation.alias)], 'SELECT ' + [...aliases.map(column => f('"s"', column) + ' AS ' + q(column)),
      ...operations.map(operation => operation.parts.value('"s"') + ' AS ' + q(operation.alias))].join(', ')
      + ' FROM ' + q(basic) + ' AS "s"');
    const statistic = { name: finished, scope: q('__rs_related_' + attachments.length), groups: grouped ? aliases : [], ordinal: projected ? aliases[0] : '' };
    attachments.push(statistic);
    for (const output of outputs) related.set(output.index, { statistic, value: output.operation.alias });
  }
  const rootValues = new Map<number, (scope: string) => string>();
  let base = root.name;
  if (!projected) {
    const selected = groupColumns.map((column, i) => f('"d"', root.columns.get(column)!) + ' AS ' + q('__rs_group_' + i));
    const selectedSlots = groupColumns.map((_, i) => '__rs_group_' + i);
    for (const [index, selection] of selections.entries()) if (!selection.path) {
      const parts = valueParts(root, selection, String(index)); selected.push(...parts.select); selectedSlots.push(...parts.slots); rootValues.set(index, parts.value);
    }
    if (!rootValues.size) { selected.push(fn('count', '*') + ' AS "__rs_seed"'); selectedSlots.push('__rs_seed'); }
    base = add('root_stats', selectedSlots, 'SELECT ' + selected.join(', ') + ' FROM ' + q(root.name) + ' AS "d" CROSS JOIN ' + q(global)
      + ' AS "g"' + (grouped ? ' GROUP BY ' + groupColumns.map(column => f('"d"', root.columns.get(column)!)).join(', ') : ''));
  }
  const physical: string[] = [], logicalOrder = new Map<string, string>();
  const emit = (expression: string, field: WithoutAlias<PostgresAggregateField>): string => {
    const alias = '__rs_pg_' + fields.length;
    physical.push(expression + ' AS ' + q(alias)); fields.push({ ...field, alias } as PostgresAggregateField); return q(alias);
  };
  const rootLayout = projected ? undefined : aggregateLayout(query);
  const rowLayout = projected ? projectedLayout(query.aggregates!) : undefined;
  if (projected) for (const column of query.columns) emit(f('"o"', root.columns.get(column)!), { kind: 'mapped', target: column,
    storageKind: ctx.kind(query.table, column), nullable: query.table.nullable![column], canonical: true });
  else for (const [i, entry] of rootLayout!.keys.entries()) logicalOrder.set(entry.column, emit(f('"o"', '__rs_group_' + i), { kind: 'mapped', target: entry.output.name,
    storageKind: ctx.kind(query.table, entry.column), nullable: query.table.nullable![entry.column], canonical: true }));
  for (const [index, selection] of selections.entries()) {
    let expression: string;
    if (selection.path) {
      const value = related.get(index)!;
      expression = f(value.statistic.scope, value.value);
      if (selection.operation === 'count') expression = 'COALESCE(' + expression + ', 0' + cast('int8') + ')';
    } else expression = rootValues.get(index)!('"o"');
    const layout = projected ? rowLayout!.outputs[index] : rootLayout!.aggregates[index];
    if (layout.kind === 'integer-sum') logicalOrder.set(selection.alias, emit(expression, { kind: 'integer-sum',
      high: typeof layout.high === 'string' ? layout.high : layout.high.name,
      low: typeof layout.low === 'string' ? layout.low : layout.low.name }));
    else {
      const target = projected ? (layout as { name: string }).name : (layout as { output: { name: string } }).output.name;
      const table = selection.path ? selection.path[selection.path.length - 1].table : query.table;
      const kind = selection.column ? ctx.kind(table, selection.column) : undefined;
      logicalOrder.set(selection.alias, emit(expression, selection.operation === 'count' ? { kind: 'count', target }
        : selection.operation === 'sum' || selection.operation === 'avg' ? { kind: 'real-aggregate', target }
        : { kind: 'mapped', target, storageKind: kind!, nullable: true, canonical: true }));
    }
  }
  emit('"g"."bad"', { kind: 'guard', target: projected ? rowLayout!.guard : rootLayout!.guard.name });
  let sql = 'WITH ' + ctes.join(', ') + ' SELECT ' + physical.join(', ') + ' FROM ' + q(base) + ' AS "o" CROSS JOIN ' + q(global) + ' AS "g"';
  for (const statistic of attachments) {
    const correlations = grouped ? statistic.groups.map((column, i) => nullSafeEqual(f(statistic.scope, column), f('"o"', '__rs_group_' + i)))
      : projected ? [equal(f(statistic.scope, statistic.ordinal), f('"o"', root.ordinal))] : [];
    sql += ' LEFT JOIN ' + q(statistic.name) + ' AS ' + statistic.scope + ' ON ' + (correlations.length ? correlations.join(' AND ') : 'TRUE');
  }
  if (projected) sql += ' ORDER BY ' + f('"o"', root.ordinal);
  if (grouped) sql += ' ORDER BY ' + query.orderBy.map(entry => logicalOrder.get(entry.field) + ' ' + entry.direction + (entry.direction === 'ASC' ? ' NULLS FIRST' : ' NULLS LAST')).join(', ')
    + ' LIMIT ' + ctx.bindInteger(query.limit) + ' OFFSET ' + ctx.bindInteger(query.offset);
  const profile: PostgresAggregateProfile = Object.freeze({ mode: projected ? 'projected' : grouped ? 'group' : 'aggregate', fields: Object.freeze(fields.map(field => Object.freeze(field))) });
  return Object.freeze({ sql, profile, realRange });
}
