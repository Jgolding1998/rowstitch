/** SQLite root aggregate rendering. The caller normalizes the model and renders WHERE. */
import { aggregateLayout, type AggregateOutput } from './aggregate-layout.js';
import { identifier } from './schema.js';
import type { AggregateModel, GroupModel, TableModel } from './query-model.js';
import type { CompiledQuery } from './sqlite-compiler.js';

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

export function compileSqliteAggregate(query: AggregateModel | GroupModel, where: CompiledQuery): CompiledQuery {
  const layout = aggregateLayout(query), table = identifier(query.table.name);
  const ref = (column: string): string => table + '.' + identifier(column);
  // Only fixed names produced by aggregateLayout reach this quoting helper.
  const as = (expression: string, output: AggregateOutput): string => expression + ' AS "' + output.name + '"';
  const selections = layout.keys.map(key => as(ref(key.column), key.output));
  for (const item of layout.aggregates) {
    const selection = item.selection, column = selection.column === undefined ? '*' : ref(selection.column);
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
  const guard = query.kind === 'group' ? 'COALESCE(MAX(MAX(' + flag + ')) OVER (), 0)' : 'COALESCE(MAX(' + flag + '), 0)';
  selections.push(as(guard, layout.guard));
  let sql = 'SELECT ' + selections.join(', ') + ' FROM ' + table + (where.sql ? ' WHERE ' + where.sql : '');
  const parameters = [...where.parameters];
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
