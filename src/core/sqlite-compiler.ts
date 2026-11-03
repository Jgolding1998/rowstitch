/** Pure SQLite rendering from validated structured plans. Never opens a connection. */
import { identifier, literal, type Parameter } from './schema.js';
import { hasRelationFilter, normalizeQueryModel, orderingModel, predicateModel, predicateTruth, tableModel,
  type ColumnDefinitionModel, type OrderModel, type PredicateModel, type QueryModel, type TableModel } from './query-model.js';

export interface CompiledQuery { sql: string; parameters: Parameter[] }
export interface CompiledPredicate extends CompiledQuery { truth: true | false | null }
const comparisons = { '=': '=', '<>': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=', IN: 'IN' } as const;
const logical = { AND: 'AND', OR: 'OR' } as const;
const directions = { ASC: 'ASC', DESC: 'DESC' } as const;
const deleteActions = { cascade: 'CASCADE', restrict: 'RESTRICT', 'set null': 'SET NULL', 'no action': 'NO ACTION' } as const;

function renderPredicate(predicate?: PredicateModel, scope?: string, aliases = { next: 0 }): CompiledQuery {
  if (predicate === undefined) return { sql: '', parameters: [] };
  const field = (name: string): string => (scope ? scope + '.' : '') + identifier(name);
  if (predicate.kind === 'relation-filter') {
    // Reserved names are generated only here. User mappings cannot shadow them.
    const alias = '"__rs_filter_' + aliases.next++ + '"';
    const domain = renderPredicate(predicate.where, alias, aliases);
    const test = renderPredicate(predicate.predicate, alias, aliases);
    const join = alias + '.' + identifier(predicate.foreignKey) + ' = ' + field(predicate.localKey);
    const condition = test.sql ? ' AND (' + test.sql + ')' + (predicate.quantifier === 'every' ? ' IS NOT TRUE' : '') : '';
    const sql = (predicate.quantifier === 'some' ? '' : 'NOT ') + 'EXISTS (SELECT 1 FROM ' + identifier(predicate.table.name) + ' AS ' + alias
      + ' WHERE ' + join + (domain.sql ? ' AND (' + domain.sql + ')' : '') + condition + ')';
    return { sql, parameters: [...domain.parameters, ...test.parameters] };
  }
  if (predicate.kind === 'column-compare') return {
    sql: field(predicate.left) + ' ' + comparisons[predicate.operator] + ' ' + field(predicate.right), parameters: [],
  };
  if (predicate.kind === 'text-match') {
    const column = field(predicate.column);
    const fold = (sql: string): string => predicate.case === 'ascii-insensitive' ? 'lower(' + sql + ')' : sql;
    const expression = fold(column), value = fold('?');
    if (predicate.mode !== 'ends-with') return {
      sql: 'instr(' + expression + ', ' + value + ')' + (predicate.mode === 'contains' ? ' > 0' : ' = 1'),
      parameters: [predicate.literal],
    };
    const bytes = (sql: string): string => 'CAST(' + sql + ' AS BLOB)';
    return { sql: '(length(' + bytes(expression) + ') >= length(' + bytes(value) + ') AND substr(' + bytes(expression) + ', -length(' + bytes(value) + '))'
      + ' = ' + bytes(value) + ')', parameters: [predicate.literal, predicate.literal, predicate.literal] };
  }
  if (predicate.kind === 'compare') {
    const column = field(predicate.column);
    if (predicate.operator === 'IN') {
      if (!predicate.values.length) return { sql: '0', parameters: [] };
      const parameters = predicate.values.filter(value => value !== null);
      const parts: string[] = [];
      if (parameters.length) parts.push(column + ' IN (' + parameters.map(() => '?').join(', ') + ')');
      if (parameters.length !== predicate.values.length) parts.push(column + ' IS NULL');
      return { sql: '(' + parts.join(' OR ') + ')', parameters: [...parameters] };
    }
    if (predicate.values[0] === null) return { sql: column + (predicate.operator === '=' ? ' IS NULL' : ' IS NOT NULL'), parameters: [] };
    return { sql: column + ' ' + comparisons[predicate.operator] + ' ?', parameters: [predicate.values[0]] };
  }
  if (predicate.kind === 'not') {
    const child = renderPredicate(predicate.child, scope, aliases);
    return { sql: 'NOT (' + child.sql + ')', parameters: child.parameters };
  }
  const children = predicate.children.map(child => renderPredicate(child, scope, aliases));
  return { sql: children.length ? '(' + children.map(c => c.sql).join(' ' + logical[predicate.operator] + ' ') + ')'
    : predicate.operator === 'AND' ? '1' : '0', parameters: children.flatMap(c => c.parameters) };
}
function renderOrder(order: readonly OrderModel[]): string {
  return order.length ? ' ORDER BY ' + order.map(value => identifier(value.column) + ' ' + directions[value.direction]).join(', ') : '';
}
function columnType(kind: ColumnDefinitionModel['kind']): string {
  return kind === 'text' || kind === 'json' ? 'TEXT' : kind === 'real' ? 'REAL' : 'INTEGER';
}
function renderColumn(column: ColumnDefinitionModel): string {
  let sql = identifier(column.name) + ' ' + columnType(column.kind);
  if (column.generated) sql += ' PRIMARY KEY AUTOINCREMENT';
  else if (!column.nullable) sql += ' NOT NULL';
  if (column.unique) sql += ' UNIQUE';
  if (column.hasDefault) sql += ' DEFAULT ' + literal(column.defaultValue!);
  if (column.kind === 'boolean') sql += ' CHECK (' + identifier(column.name) + ' IN (0, 1))';
  if (column.kind === 'json') sql += ' CHECK (json_valid(' + identifier(column.name) + '))';
  if (column.foreignKey) sql += ' REFERENCES ' + identifier(column.foreignKey.table) + '(' + identifier(column.foreignKey.column) + ') ON DELETE ' + deleteActions[column.foreignKey.onDelete];
  return sql;
}

export function compileSqlitePredicate(tableInput: TableModel, predicate?: PredicateModel): CompiledPredicate {
  const table = tableModel(tableInput);
  const validated = predicate === undefined ? undefined : predicateModel(table, predicate);
  return { ...renderPredicate(validated, hasRelationFilter(validated) ? identifier(table.name) : undefined), truth: predicateTruth(validated) };
}
export function compileSqliteOrder(tableInput: TableModel, order: readonly OrderModel[]): string {
  const table = tableModel(tableInput);
  return renderOrder(orderingModel(table, order));
}

export function compileSqlite(input: QueryModel): CompiledQuery {
  const query = normalizeQueryModel(input);
  if (query.kind === 'transaction') {
    const names = {
      begin: 'BEGIN', 'begin-immediate': 'BEGIN IMMEDIATE', commit: 'COMMIT', rollback: 'ROLLBACK',
      savepoint: 'SAVEPOINT ', release: 'RELEASE SAVEPOINT ', 'rollback-to': 'ROLLBACK TO SAVEPOINT ',
    };
    return { sql: names[query.action] + (query.name === undefined ? '' : identifier(query.name)), parameters: [] };
  }
  if (query.kind === 'explain') {
    const compiled = compileSqlite(query.query);
    return { sql: 'EXPLAIN QUERY PLAN ' + compiled.sql, parameters: compiled.parameters };
  }
  const table = identifier(query.table.name);
  if (query.kind === 'create-table') {
    const definitions = query.definitions.map(renderColumn);
    if (!query.definitions.some(c => c.generated)) definitions.push('PRIMARY KEY (' + query.table.primaryKey.map(identifier).join(', ') + ')');
    return { sql: 'CREATE TABLE ' + table + ' (' + definitions.join(', ') + ')', parameters: [] };
  }
  if (query.kind === 'create-index') return { sql: 'CREATE INDEX ' + identifier(query.name) + ' ON ' + table + ' (' + query.columns.map(identifier).join(', ') + ')', parameters: [] };
  if (query.kind === 'insert') return {
    sql: 'INSERT INTO ' + table + (query.columns.length ? ' (' + query.columns.map(identifier).join(', ') + ') VALUES (' + query.columns.map(() => '?').join(', ') + ')' : ' DEFAULT VALUES') + ' RETURNING *',
    parameters: [...query.values],
  };
  const where = renderPredicate(query.where, hasRelationFilter(query.where) ? table : undefined);
  if (query.kind === 'count') return { sql: 'SELECT count(*) AS n FROM ' + table + (where.sql ? ' WHERE ' + where.sql : ''), parameters: where.parameters };
  if (query.kind === 'select') return {
    sql: 'SELECT ' + query.columns.map(identifier).join(', ') + ' FROM ' + table + (where.sql ? ' WHERE ' + where.sql : '') + renderOrder(query.orderBy) + ' LIMIT ? OFFSET ?',
    parameters: [...where.parameters, query.limit, query.offset],
  };
  if (query.kind === 'update') return {
    sql: 'UPDATE ' + table + ' SET ' + query.assignments.map(a => identifier(a.column) + ' = ?').join(', ')
      + (query.table.version ? ', ' + identifier(query.table.version) + ' = ' + identifier(query.table.version) + ' + 1' : '')
      + ' WHERE ' + where.sql + ' RETURNING *',
    parameters: [...query.assignments.map(a => a.value), ...where.parameters],
  };
  if (query.kind === 'delete') return { sql: 'DELETE FROM ' + table + ' WHERE ' + where.sql + ' RETURNING *', parameters: where.parameters };
  if (query.correlateKeys) return {
    sql: 'WITH "__rs_keys"("__rs_key", "__rs_ordinal") AS (VALUES ' + query.keys.map((_, index) => '(?, ' + index + ')').join(', ') + ') '
      + 'SELECT * FROM (SELECT ' + query.columns.map(identifier).join(', ') + ', "__rs_keys"."__rs_ordinal" AS "__rs_parent", ROW_NUMBER() OVER (PARTITION BY "__rs_keys"."__rs_ordinal"' + renderOrder(query.orderBy)
      + ') AS "__rs_rank" FROM ' + table + ' JOIN "__rs_keys" ON ' + identifier(query.partitionBy) + ' = "__rs_keys"."__rs_key"'
      + (where.sql ? ' WHERE ' + where.sql : '') + ') WHERE "__rs_rank" > ? AND "__rs_rank" <= ? ORDER BY "__rs_parent", "__rs_rank" LIMIT ?',
    parameters: [...query.keys, ...where.parameters, query.offset, query.offset + query.limit, query.readLimit],
  };
  return {
    sql: 'SELECT * FROM (SELECT ' + query.columns.map(identifier).join(', ') + ', ROW_NUMBER() OVER (PARTITION BY ' + identifier(query.partitionBy) + renderOrder(query.orderBy)
      + ') AS "__rs_rank" FROM ' + table + ' WHERE ' + identifier(query.partitionBy) + ' IN (' + query.keys.map(() => '?').join(', ') + ')'
      + (where.sql ? ' AND (' + where.sql + ')' : '') + ') WHERE "__rs_rank" > ? AND "__rs_rank" <= ? ORDER BY '
      + identifier(query.partitionBy) + ', "__rs_rank" LIMIT ?',
    parameters: [...query.keys, ...where.parameters, query.offset, query.offset + query.limit, query.readLimit],
  };
}
