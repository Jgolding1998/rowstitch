/** SQLite root aggregate rendering. The caller normalizes the model and renders WHERE. */
import { aggregateLayout, type AggregateOutput } from './aggregate-layout.js';
import { identifier } from './schema.js';
import { fail } from './errors.js';
import { MAX_BOUND_PARAMETERS, aggregatePhysicalParameters, type AggregateModel, type AggregateSelectModel, type GroupModel, type PredicateModel, type TableModel } from './query-model.js';
import type { Parameter } from './schema.js';
import type { CompiledQuery } from './sqlite-compiler.js';

type Render = (predicate: PredicateModel | undefined, scope: string) => CompiledQuery;
type Alias = () => string;
interface RelatedSource { from: string; where: string; parameters: Parameter[]; leaf: string; checked: string[] }
/**
 * The filtered root rows (aliased, so self-relations cannot shadow the outer row) joined along a selection's relation
 * path. The related key is the left operand of every hop, as in relation filters, so its collation decides text matches.
 * With `correlate`, the root rows are restricted to the current group by `IS` on every group key: the left operand is
 * the same key column, so its collation and the NULL group reproduce GROUP BY equivalence.
 */
function relatedSource(query: AggregateModel | GroupModel, selection: AggregateSelectModel, render: Render, alias: Alias, correlate: boolean): RelatedSource {
  const table = identifier(query.table.name), root = alias();
  const conditions: string[] = [], parameters: Parameter[] = [], checked: string[] = [];
  const where = render(query.where, root);
  if (where.sql) { conditions.push('(' + where.sql + ')'); parameters.push(...where.parameters); }
  if (correlate && query.kind === 'group') for (const key of query.by) conditions.push(root + '.' + identifier(key) + ' IS ' + table + '.' + identifier(key));
  let from = table + ' AS ' + root, scope = root;
  const path = selection.path!;
  path.forEach((step, index) => {
    const next = alias();
    from += ' JOIN ' + identifier(step.table.name) + ' AS ' + next + ' ON ' + next + '.' + identifier(step.foreignKey) + ' = ' + scope + '.' + identifier(step.localKey);
    const domain = render(step.where, next);
    if (domain.sql) { conditions.push('(' + domain.sql + ')'); parameters.push(...domain.parameters); }
    checked.push(invalidInput(step.table, step.foreignKey, next + '.' + identifier(step.foreignKey)));
    const following = path[index + 1];
    if (following) checked.push(invalidInput(step.table, following.localKey, next + '.' + identifier(following.localKey)));
    scope = next;
  });
  const leafTable = path[path.length - 1].table;
  if (selection.column !== undefined) checked.push(invalidInput(leafTable, selection.column, scope + '.' + identifier(selection.column)));
  return { from, where: conditions.length ? conditions.join(' AND ') : '1', parameters, leaf: scope, checked };
}

const safeInteger = ' BETWEEN -9007199254740991 AND 9007199254740991';
const finiteReal = ' BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308';
const operations = { count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' } as const;

/** 1 when a referenced stored value does not satisfy the mapped codec's storage rules, else 0. Shared by projected aggregates. */
export function invalidInput(table: TableModel, column: string, ref: string): string {
  const type = 'typeof(' + ref + ')';
  let valid: string;
  switch (table.kinds![column]) {
    case 'integer': valid = type + " = 'integer' AND " + ref + safeInteger; break;
    case 'bigint': valid = type + " = 'integer'"; break;
    case 'real': valid = '(' + type + " = 'real' AND " + ref + finiteReal + ') OR (' + type + " = 'integer' AND " + ref + safeInteger + ')'; break;
    case 'boolean': valid = type + " = 'integer' AND " + ref + ' IN (0, 1)'; break;
    case 'text': valid = type + " = 'text'"; break;
    default: throw new Error('An aggregate input needs a normalized scalar kind.');
  }
  return '(CASE WHEN ' + ref + ' IS NULL THEN ' + (table.nullable![column] ? '0' : '1')
    + ' WHEN ' + valid + ' THEN 0 ELSE 1 END)';
}

export function compileSqliteAggregate(query: AggregateModel | GroupModel, where: CompiledQuery, render: Render, alias: Alias): CompiledQuery {
  const layout = aggregateLayout(query), table = identifier(query.table.name);
  const ref = (column: string): string => table + '.' + identifier(column);
  // Only fixed names produced by aggregateLayout reach this quoting helper.
  const as = (expression: string, output: AggregateOutput): string => expression + ' AS "' + output.name + '"';
  const selections = layout.keys.map(key => as(ref(key.column), key.output));
  const selectParameters: Parameter[] = [], guardParameters: Parameter[] = [], relatedGuards: string[] = [];
  for (const item of layout.aggregates) {
    const selection = item.selection;
    if (selection.path !== undefined) {
      // A separate scalar subquery per related selection over the whole matching path of the group's root rows: no
      // related table joins the main GROUP BY (no fan-out), AVG is leaf-weighted, and MIN/MAX run once directly on the
      // leaf column so its declared collation applies (composing per-row extrema would lose it).
      const subquery = (expression: (leaf: string) => string): string => {
        const source = relatedSource(query, selection, render, alias, true);
        selectParameters.push(...source.parameters);
        return '(SELECT ' + expression(source.leaf) + ' FROM ' + source.from + ' WHERE ' + source.where + ')';
      };
      const leafColumn = (leaf: string): string => leaf + '.' + identifier(selection.column!);
      if (item.kind === 'integer-sum') {
        selections.push(as(subquery(leaf => 'SUM((' + leafColumn(leaf) + ' >> 32)) + (SUM((' + leafColumn(leaf) + ' & 4294967295)) >> 32)'), item.high));
        selections.push(as(subquery(leaf => '(SUM((' + leafColumn(leaf) + ' & 4294967295)) & 4294967295)'), item.low));
      } else {
        const leafKind = selection.column === undefined ? undefined : selection.path[selection.path.length - 1].table.kinds![selection.column];
        selections.push(as(subquery(leaf => selection.operation === 'count' ? (selection.column === undefined ? 'COUNT(*)' : 'COUNT(' + leafColumn(leaf) + ')')
          : selection.operation === 'sum' && leafKind === 'real' ? 'SUM(CAST(' + leafColumn(leaf) + ' AS REAL))'
          : operations[selection.operation] + '(' + leafColumn(leaf) + ')'), item.output));
      }
      // Uncorrelated: the whole filtered domain, independent of grouping and pagination.
      const guard = relatedSource(query, selection, render, alias, false);
      // The combined guard column is emitted last, after every value expression, so its bindings follow them.
      guardParameters.push(...guard.parameters);
      relatedGuards.push('EXISTS (SELECT 1 FROM ' + guard.from + ' WHERE ' + guard.where + ' AND (' + guard.checked.join(' OR ') + '))');
      continue;
    }
    const column = selection.column === undefined ? '*' : ref(selection.column);
    if (item.kind === 'integer-sum') {
      // A canonical base-2^32 pair preserves exact integer sums beyond int64 and sorts numerically.
      const high = 'SUM((' + column + ' >> 32))', low = 'SUM((' + column + ' & 4294967295))';
      selections.push(as('(' + high + ' + (' + low + ' >> 32))', item.high), as('(' + low + ' & 4294967295)', item.low));
    } else {
      // Real mappings also accept safe INTEGER storage. Cast before SUM to avoid integer overflow.
      const argument = selection.operation === 'sum' && query.table.kinds![selection.column!] === 'real'
        ? 'CAST(' + column + ' AS REAL)' : column;
      selections.push(as(operations[selection.operation] + '(' + argument + ')', item.output));
    }
  }
  const flags = layout.inputColumns.map(column => invalidInput(query.table, column, ref(column)));
  const flag = flags.length ? '(CASE WHEN ' + flags.join(' OR ') + ' THEN 1 ELSE 0 END)' : '0';
  // The window observes every filtered group before ORDER/LIMIT, not only the displayed page.
  const rootGuard = query.kind === 'group' ? 'COALESCE(MAX(MAX(' + flag + ')) OVER (), 0)' : 'COALESCE(MAX(' + flag + '), 0)';
  const guard = relatedGuards.length ? '(CASE WHEN ' + rootGuard + ' = 1 OR ' + relatedGuards.join(' OR ') + ' THEN 1 ELSE 0 END)' : rootGuard;
  selections.push(as(guard, layout.guard));
  let sql = 'SELECT ' + selections.join(', ') + ' FROM ' + table + (where.sql ? ' WHERE ' + where.sql : '');
  // Select-list subqueries precede WHERE in the statement text, so their values are bound first.
  const parameters = [...selectParameters, ...guardParameters, ...where.parameters];
  if (parameters.length !== aggregatePhysicalParameters(query)) fail('QUERY', 'Generated aggregate bindings do not match the validated plan.');
  if (parameters.length > MAX_BOUND_PARAMETERS) fail('QUERY', 'A query has too many bound parameters once the root filter and related domains are repeated for related selectors.');
  if (query.kind === 'group') {
    sql += ' GROUP BY ' + query.by.map(ref).join(', ');
    const order = query.orderBy.flatMap(item => {
      const key = layout.keys.find(key => key.column === item.field);
      if (key) return [key.output.ordinal + ' ' + item.direction];
      const aggregate = layout.aggregates.find(value => value.selection.alias === item.field)!;
      return aggregate.kind === 'integer-sum'
        ? [aggregate.high.ordinal + ' ' + item.direction, aggregate.low.ordinal + ' ' + item.direction]
        : [aggregate.output.ordinal + ' ' + item.direction];
    });
    sql += ' ORDER BY ' + order.join(', ') + ' LIMIT ? OFFSET ?';
    parameters.push(query.limit, query.offset);
  }
  return { sql, parameters };
}
