/** Pure SQLite rendering from validated structured plans. Never opens a connection. */
import { fail } from './errors.js';
import { identifier, literal, type Parameter } from './schema.js';
import { compileSqliteAggregate, invalidInput } from './sqlite-aggregate.js';
import { projectedLayout } from './projected-layout.js';
import { modelPhysicalColumn, quotePhysicalName, quotePhysicalTable, validateModelStorage } from './physical-identity.js';
import { MAX_BOUND_PARAMETERS, hasRelationFilter, normalizeQueryModel, orderingModel, predicateModel, predicateTruth, selectPhysicalParameters, tableModel,
  type ColumnDefinitionModel, type OrderModel, type PredicateModel, type ProjectedAggregateModel, type QueryModel, type SelectModel, type TableModel } from './query-model.js';

export interface CompiledQuery { sql: string; parameters: Parameter[] }
export interface CompiledPredicate extends CompiledQuery { truth: true | false | null }
const comparisons = { '=': '=', '<>': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=', IN: 'IN' } as const;
const logical = { AND: 'AND', OR: 'OR' } as const;
const directions = { ASC: 'ASC', DESC: 'DESC' } as const;
const deleteActions = { cascade: 'CASCADE', restrict: 'RESTRICT', 'set null': 'SET NULL', 'no action': 'NO ACTION' } as const;

const quote = (name: string): string => quotePhysicalName(name, 'sqlite');
const rootScope = '"__rs_root"';
function identity(table: TableModel): ReturnType<typeof validateModelStorage> {
  return validateModelStorage(table, 'main', 'sqlite');
}
function physicalTable(table: TableModel): string {
  const target = identity(table);
  return quotePhysicalTable(target.schema, target.table, 'sqlite');
}
const physicalColumn = (table: TableModel, column: string): string => quote(modelPhysicalColumn(table, column, 'sqlite'));
const reference = (table: TableModel, column: string, scope?: string): string => (scope ? scope + '.' : '') + physicalColumn(table, column);
const projection = (table: TableModel, columns: readonly string[], scope: string): string => columns.map(column => reference(table, column, scope) + ' AS ' + identifier(column)).join(', ');

function renderPredicate(table: TableModel, predicate?: PredicateModel, scope?: string, aliases = { next: 0 }): CompiledQuery {
  if (predicate === undefined) return { sql: '', parameters: [] };
  const field = (name: string): string => reference(table, name, scope);
  if (predicate.kind === 'relation-filter' || predicate.kind === 'relation-count') {
    // Every physical source has its own scope; physical helper-shaped names remain ordinary data.
    const alias = '"__rs_filter_' + aliases.next++ + '"';
    const domain = renderPredicate(predicate.table, predicate.where, alias, aliases);
    const test = renderPredicate(predicate.table, predicate.predicate, alias, aliases);
    const join = reference(predicate.table, predicate.foreignKey, alias) + ' = ' + field(predicate.localKey);
    const condition = test.sql ? ' AND (' + test.sql + ')' + (predicate.kind === 'relation-filter' && predicate.quantifier === 'every' ? ' IS NOT TRUE' : '') : '';
    if (predicate.kind === 'relation-count') return {
      sql: '(SELECT count(*) FROM ' + physicalTable(predicate.table) + ' AS ' + alias + ' WHERE ' + join
        + (domain.sql ? ' AND (' + domain.sql + ')' : '') + condition + ') ' + comparisons[predicate.operator] + ' ?',
      parameters: [...domain.parameters, ...test.parameters, predicate.threshold],
    };
    const sql = (predicate.quantifier === 'some' ? '' : 'NOT ') + 'EXISTS (SELECT 1 FROM ' + physicalTable(predicate.table) + ' AS ' + alias
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
    const child = renderPredicate(table, predicate.child, scope, aliases);
    return { sql: 'NOT (' + child.sql + ')', parameters: child.parameters };
  }
  const children = predicate.children.map(child => renderPredicate(table, child, scope, aliases));
  return { sql: children.length ? '(' + children.map(c => c.sql).join(' ' + logical[predicate.operator] + ' ') + ')'
    : predicate.operator === 'AND' ? '1' : '0', parameters: children.flatMap(c => c.parameters) };
}
/**
 * Correlated per-row aggregates. Each selector is its own scalar subquery over its whole join path (no cross-joining of
 * independent selectors, no implicit DISTINCT). The related key is the left operand of every hop, so its column collation
 * decides text matches, as in relation filters. MIN/MAX run inside the subquery directly over the leaf column, keeping
 * that column's declared collation.
 */
function renderProjected(query: SelectModel, root: string, aliases: { next: number }): CompiledQuery {
  const layout = projectedLayout(query.aggregates ?? []);
  const selections: string[] = [], guards: string[] = [], parameters: Parameter[] = [], guardParameters: Parameter[] = [];
  for (const output of layout.outputs) {
    const aggregate: ProjectedAggregateModel = output.aggregate;
    // Each physical copy re-renders the path so every copy has its own fresh inner aliases and bound values.
    const path = (): { from: string; where: string; parameters: Parameter[]; leaf: string; checked: string[] } => {
      let scope = root, owner = query.table, from = '', leaf = '';
      const conditions: string[] = [], values: Parameter[] = [], checked: string[] = [];
      aggregate.path.forEach((step, index) => {
        const alias = '"__rs_filter_' + aliases.next++ + '"';
        const join = reference(step.table, step.foreignKey, alias) + ' = ' + reference(owner, step.localKey, scope);
        if (index === 0) { from = physicalTable(step.table) + ' AS ' + alias; conditions.push(join); }
        else from += ' JOIN ' + physicalTable(step.table) + ' AS ' + alias + ' ON ' + join;
        const domain = renderPredicate(step.table, step.where, alias, aliases);
        if (domain.sql) { conditions.push('(' + domain.sql + ')'); values.push(...domain.parameters); }
        checked.push(invalidInput(step.table, step.foreignKey, reference(step.table, step.foreignKey, alias)));
        const next = aggregate.path[index + 1];
        if (next) checked.push(invalidInput(step.table, next.localKey, reference(step.table, next.localKey, alias)));
        scope = alias; leaf = alias; owner = step.table;
      });
      const table = aggregate.path[aggregate.path.length - 1].table;
      if (aggregate.column !== undefined) checked.push(invalidInput(table, aggregate.column, reference(table, aggregate.column, leaf)));
      return { from, where: conditions.join(' AND '), parameters: values, leaf, checked };
    };
    const subquery = (expression: (leaf: string) => string): string => {
      const rendered = path();
      parameters.push(...rendered.parameters);
      return '(SELECT ' + expression(rendered.leaf) + ' FROM ' + rendered.from + ' WHERE ' + rendered.where + ')';
    };
    const column = (leaf: string): string => reference(aggregate.path[aggregate.path.length - 1].table, aggregate.column!, leaf);
    if (output.kind === 'integer-sum') {
      selections.push(subquery(leaf => 'SUM((' + column(leaf) + ' >> 32)) + (SUM((' + column(leaf) + ' & 4294967295)) >> 32)') + ' AS "' + output.high + '"');
      selections.push(subquery(leaf => '(SUM((' + column(leaf) + ' & 4294967295)) & 4294967295)') + ' AS "' + output.low + '"');
    } else {
      const leafKind = aggregate.path[aggregate.path.length - 1].table.kinds![aggregate.column ?? ''];
      const expression = (leaf: string): string => aggregate.operation === 'count' ? (aggregate.column === undefined ? 'COUNT(*)' : 'COUNT(' + column(leaf) + ')')
        : aggregate.operation === 'sum' && leafKind === 'real' ? 'SUM(CAST(' + column(leaf) + ' AS REAL))'
        : { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[aggregate.operation] + '(' + column(leaf) + ')';
      selections.push(subquery(expression) + ' AS "' + output.name + '"');
    }
    const rendered = path();
    guardParameters.push(...rendered.parameters);
    guards.push('EXISTS (SELECT 1 FROM ' + rendered.from + ' WHERE ' + rendered.where + ' AND (' + rendered.checked.join(' OR ') + '))');
  }
  selections.push('(CASE WHEN ' + guards.join(' OR ') + ' THEN 1 ELSE 0 END) AS "' + layout.guard + '"');
  // Guard SQL is emitted after every selected value. Its bindings must follow all value bindings too.
  return { sql: selections.join(', '), parameters: [...parameters, ...guardParameters] };
}
function renderOrder(table: TableModel, order: readonly OrderModel[], scope?: string): string {
  return order.length ? ' ORDER BY ' + order.map(value => reference(table, value.column, scope) + ' ' + directions[value.direction]).join(', ') : '';
}
function columnType(kind: ColumnDefinitionModel['kind']): string {
  return kind === 'text' || kind === 'json' ? 'TEXT' : kind === 'real' ? 'REAL' : 'INTEGER';
}
function renderColumn(table: TableModel, column: ColumnDefinitionModel): string {
  const name = physicalColumn(table, column.name);
  let sql = name + ' ' + columnType(column.kind);
  if (column.generated) sql += ' PRIMARY KEY AUTOINCREMENT';
  else if (!column.nullable) sql += ' NOT NULL';
  if (column.unique) sql += ' UNIQUE';
  if (column.hasDefault) sql += ' DEFAULT ' + literal(column.defaultValue!);
  if (column.kind === 'boolean') sql += ' CHECK (' + name + ' IN (0, 1))';
  if (column.kind === 'json') sql += ' CHECK (json_valid(' + name + '))';
  if (column.foreignKey) {
    const fk = column.foreignKey;
    const target: { schema?: string; table: string; column: string } = 'target' in fk
      ? fk.target as { schema?: string; table: string; column: string } : fk;
    const schema = target.schema ?? 'main';
    if (!['main', 'temp'].includes(schema.toLowerCase()) || schema.toLowerCase() !== identity(table).schema.toLowerCase())
      fail('SCHEMA', 'SQLite foreign keys must target the same supported schema.');
    sql += ' REFERENCES ' + quote(target.table) + '(' + quote(target.column) + ') ON DELETE ' + deleteActions[fk.onDelete];
  }
  return sql;
}

export function compileSqlitePredicate(tableInput: TableModel, predicate?: PredicateModel): CompiledPredicate {
  const table = tableModel(tableInput);
  const target = identity(table);
  const validated = predicate === undefined ? undefined : predicateModel(table, predicate);
  return { ...renderPredicate(table, validated, hasRelationFilter(validated) ? quote(target.table) : undefined), truth: predicateTruth(validated) };
}
export function compileSqliteOrder(tableInput: TableModel, order: readonly OrderModel[]): string {
  const table = tableModel(tableInput);
  identity(table);
  return renderOrder(table, orderingModel(table, order));
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
  const owner = query.table, target = identity(owner), table = physicalTable(owner);
  const source = table + ' AS ' + rootScope;
  const mutationScope = quote(target.table);
  const returning = projection(owner, owner.columns, mutationScope);
  if (query.kind === 'create-table') {
    if (/^sqlite_/i.test(target.table)) fail('SCHEMA', 'SQLite reserves the sqlite_ prefix for internal objects.');
    const definitions = query.definitions.map(column => renderColumn(owner, column));
    if (!query.definitions.some(c => c.generated)) definitions.push('PRIMARY KEY (' + owner.primaryKey.map(column => physicalColumn(owner, column)).join(', ') + ')');
    return { sql: 'CREATE TABLE ' + table + ' (' + definitions.join(', ') + ')', parameters: [] };
  }
  if (query.kind === 'create-index') return {
    sql: 'CREATE INDEX ' + quotePhysicalTable(target.schema, query.name, 'sqlite') + ' ON ' + quote(target.table)
      + ' (' + query.columns.map(column => physicalColumn(owner, column)).join(', ') + ')', parameters: [],
  };
  if (query.kind === 'insert') return {
    sql: 'INSERT INTO ' + table + (query.columns.length ? ' (' + query.columns.map(column => physicalColumn(owner, column)).join(', ') + ') VALUES (' + query.columns.map(() => '?').join(', ') + ')' : ' DEFAULT VALUES') + ' RETURNING ' + returning,
    parameters: [...query.values],
  };
  if (query.kind === 'aggregate' || query.kind === 'group') {
    // The main WHERE is rendered first with a fresh counter, so statements without related selectors are unchanged.
    // Related subqueries continue the same counter, keeping every generated alias distinct.
    const aliases = { next: 0 };
    const where = renderPredicate(owner, query.where, rootScope, aliases);
    return compileSqliteAggregate(query, where, (model, predicate, scope) => renderPredicate(model, predicate, scope, aliases), () => '"__rs_filter_' + aliases.next++ + '"', rootScope);
  }
  if (query.kind === 'select' && query.aggregates?.length) {
    // Select-list subqueries precede WHERE in the statement text, so their values are bound first.
    const aliases = { next: 0 };
    const projected = renderProjected(query, rootScope, aliases);
    const where = renderPredicate(owner, query.where, rootScope, aliases);
    const parameters = [...projected.parameters, ...where.parameters];
    // The normalizer budgets physical copies; the rendered statement must agree exactly with that count.
    if (parameters.length !== selectPhysicalParameters(query)) fail('QUERY', 'Generated related-aggregate bindings do not match the validated plan.');
    if (parameters.length > MAX_BOUND_PARAMETERS) fail('QUERY', 'A query has too many bound parameters once repeated relation domains are counted.');
    return {
      sql: 'SELECT ' + projection(owner, query.columns, rootScope) + ', ' + projected.sql + ' FROM ' + source + (where.sql ? ' WHERE ' + where.sql : '') + renderOrder(owner, query.orderBy, rootScope) + ' LIMIT ? OFFSET ?',
      parameters: [...parameters, query.limit, query.offset],
    };
  }
  const scope = query.kind === 'update' || query.kind === 'delete' ? mutationScope : rootScope;
  const where = renderPredicate(owner, query.where, scope);
  if (query.kind === 'count') return { sql: 'SELECT count(*) AS n FROM ' + source + (where.sql ? ' WHERE ' + where.sql : ''), parameters: where.parameters };
  if (query.kind === 'select') return {
    sql: 'SELECT ' + projection(owner, query.columns, rootScope) + ' FROM ' + source + (where.sql ? ' WHERE ' + where.sql : '') + renderOrder(owner, query.orderBy, rootScope) + ' LIMIT ? OFFSET ?',
    parameters: [...where.parameters, query.limit, query.offset],
  };
  if (query.kind === 'update') return {
    sql: 'UPDATE ' + table + ' SET ' + query.assignments.map(a => physicalColumn(owner, a.column) + ' = ?').join(', ')
      + (owner.version ? ', ' + physicalColumn(owner, owner.version) + ' = ' + reference(owner, owner.version, mutationScope) + ' + 1' : '')
      + ' WHERE ' + where.sql + ' RETURNING ' + returning,
    parameters: [...query.assignments.map(a => a.value), ...where.parameters],
  };
  if (query.kind === 'delete') return { sql: 'DELETE FROM ' + table + ' WHERE ' + where.sql + ' RETURNING ' + returning, parameters: where.parameters };
  // Derived columns have private positional names. They are never fed back through the physical mapping.
  const derived = '"__rs_window"';
  const slot = (index: number): string => '"__rs_col_' + index + '"';
  const inner = query.columns.map((column, index) => reference(owner, column, rootScope) + ' AS ' + slot(index)).join(', ');
  const outer = query.columns.map((column, index) => derived + '.' + slot(index) + ' AS ' + identifier(column));
  const rank = derived + '."__rs_rank"';
  const rankProjection = rank + ' AS "__rs_rank"';
  const bounds = ' WHERE ' + rank + ' > ? AND ' + rank + ' <= ?';
  if (query.correlateKeys) {
    const parent = derived + '."__rs_parent"';
    return {
      sql: 'WITH "__rs_keys"("__rs_key", "__rs_ordinal") AS (VALUES ' + query.keys.map((_, index) => '(?, ' + index + ')').join(', ') + ') '
        + 'SELECT ' + [...outer, parent + ' AS "__rs_parent"', rankProjection].join(', ')
        + ' FROM (SELECT ' + inner + ', "__rs_keys"."__rs_ordinal" AS "__rs_parent", ROW_NUMBER() OVER (PARTITION BY "__rs_keys"."__rs_ordinal"' + renderOrder(owner, query.orderBy, rootScope)
        + ') AS "__rs_rank" FROM ' + source + ' JOIN "__rs_keys" ON ' + reference(owner, query.partitionBy, rootScope) + ' = "__rs_keys"."__rs_key"'
        + (where.sql ? ' WHERE ' + where.sql : '') + ') AS ' + derived + bounds + ' ORDER BY ' + parent + ', ' + rank + ' LIMIT ?',
      parameters: [...query.keys, ...where.parameters, query.offset, query.offset + query.limit, query.readLimit],
    };
  }
  const partition = derived + '.' + slot(query.columns.indexOf(query.partitionBy));
  return {
    sql: 'SELECT ' + [...outer, rankProjection].join(', ') + ' FROM (SELECT ' + inner + ', ROW_NUMBER() OVER (PARTITION BY ' + reference(owner, query.partitionBy, rootScope) + renderOrder(owner, query.orderBy, rootScope)
      + ') AS "__rs_rank" FROM ' + source + ' WHERE ' + reference(owner, query.partitionBy, rootScope) + ' IN (' + query.keys.map(() => '?').join(', ') + ')'
      + (where.sql ? ' AND (' + where.sql + ')' : '') + ') AS ' + derived + bounds + ' ORDER BY '
      + partition + ', ' + rank + ' LIMIT ?',
    parameters: [...query.keys, ...where.parameters, query.offset, query.offset + query.limit, query.readLimit],
  };
}
