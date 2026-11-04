/** Pure PostgreSQL rendering of captured structured plans. No connection, driver or caller SQL. */
import { fail } from './errors.js';
import { encode, identifier, plainRecord, type Kind, type Parameter } from './schema.js';
import { MAX_REQUEST_PARAMETERS, normalizeQueryModel, type ColumnComparisonOperator, type OrderModel, type PredicateModel, type QueryModel, type TableModel } from './query-model.js';
import { compilePostgresControl } from './postgres-control.js';
import type { PostgresOutputField } from './postgres-result.js';

export interface CompiledPostgresQuery {
  sql: string;
  parameters: readonly (string | null)[];
  outputs: readonly PostgresOutputField[];
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | null;
  /** A count has its own exact int8, one-row, nonnegative safe-integer result contract. */
  count?: true;
}
export interface PostgresCompileOptions { schema?: string; only?: boolean }

const CAST = Object.freeze({ integer: 'int8', bigint: 'int8', real: 'float8', text: 'text', boolean: 'bool', json: 'json' });
const ROOT = '"__rs_pg_root"';
const MIN_INT64 = -(2n ** 63n), MAX_INT64 = 2n ** 63n - 1n;
const wireError = (): never => fail('VALIDATION', 'An encoded value is outside its PostgreSQL type contract.');
const unsupported = (): never => fail('QUERY', 'This PostgreSQL query feature is not implemented yet.');
const cast = (name: string): string => '::"pg_catalog"."' + name + '"';
const operator = (value: '=' | '<>' | '>' | '>=' | '<' | '<=' | '+'): string => ' OPERATOR("pg_catalog".' + value + ') ';

/** PostgreSQL text/jsonb cannot represent NUL or unmatched UTF-16 surrogates. No values enter errors. */
function wireText(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0) wireError();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) wireError();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) wireError();
  }
}
function jsonStrings(value: unknown): void {
  if (typeof value === 'string') { wireText(value); return; }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) jsonStrings(item); return; }
  for (const [key, child] of Object.entries(value)) { wireText(key); jsonStrings(child); }
}
function columnKind(table: TableModel, column: string): Kind {
  if (!table.kinds || !table.nullable || !Object.hasOwn(table.kinds, column) || !Object.hasOwn(table.nullable, column)) {
    fail('QUERY', 'PostgreSQL compilation requires complete mapped kinds and nullability.');
  }
  return table.kinds[column];
}
function metadata(table: TableModel): void { for (const column of table.columns) columnKind(table, column); }

/** Invert only encode()'s supported image; never re-encode an encoded JSON string as a logical string. */
function encodedWire(type: Kind, value: Parameter, nullable: boolean, jsonb = false): string | null {
  if (value === null) { if (!nullable) wireError(); return null; }
  switch (type) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return wireError();
      return String(value);
    case 'bigint':
      if (typeof value !== 'bigint' || value < MIN_INT64 || value > MAX_INT64) return wireError();
      return String(value);
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) return wireError();
      return Object.is(value, -0) ? '-0' : String(value);
    case 'boolean':
      if (value !== 0 && value !== 1 || typeof value !== 'number') return wireError();
      return value === 1 ? 'true' : 'false';
    case 'text':
      if (typeof value !== 'string' || value.length > 1_048_576) return wireError();
      wireText(value); return value;
    case 'json': {
      if (typeof value !== 'string' || value.length > 1_048_576) return wireError();
      wireText(value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
        const encoded = encode({ kind: 'json', nullable, primary: false, generated: false, unique: false, hasDefault: false }, parsed);
        if (encoded !== value) return wireError();
      } catch { return wireError(); }
      // Native json preserves legal escaped JSON code units. jsonb has stricter string constraints; the physical
      // assignment target decides those on writes, while comparison parameters explicitly request jsonb here.
      if (jsonb) jsonStrings(parsed);
      return value;
    }
  }
}
/** Typed encoded constants for the internal PostgreSQL DDL renderer; not arbitrary SQL or a public extension hook. */
export { encodedWire as bindPostgresEncoded };

/**
 * Compare an int64 scalar with a floating scalar without ever rounding the integer to float8 or numeric. Inside the
 * int64 interval, trunc(real) is an exactly representable integral float; its guarded int8 cast is therefore exact.
 * When the integer equals that truncation, only the real's fractional part decides their order. The cast's own CASE
 * keeps it safe even when a view/constant is folded at planning time. PostgreSQL's NaN/Infinity ordering is retained;
 * returning such a nonfinite value through the finite real column codec is still refused separately.
 */
function mixedNumeric(integer: string, real: string, comparison: ColumnComparisonOperator, realLeft: boolean): string {
  const swapped = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' } as const;
  const comparisonOperator = realLeft ? swapped[comparison] : comparison;
  const i = '(' + integer + ')' + cast('int8'), r = '(' + real + ')' + cast('float8');
  const lower = '\'-9223372036854775808\'' + cast('float8'), upper = '\'9223372036854775808\'' + cast('float8');
  const compare = (a: string, op: ColumnComparisonOperator, b: string): string => '(' + a + operator(op) + b + ')';
  const truncated = '"pg_catalog"."trunc"(' + r + ')';
  const outside = compare(r, '>=', upper) + ' OR ' + compare(r, '<', lower);
  const integral = '(CASE WHEN ' + outside + ' THEN \'0\'' + cast('float8') + ' ELSE ' + truncated + ' END)' + cast('int8');
  let inside: string;
  if (comparisonOperator === '=') inside = compare(i, '=', integral) + ' AND ' + compare(truncated, '=', r);
  else if (comparisonOperator === '<>') inside = compare(i, '<>', integral) + ' OR ' + compare(truncated, '<>', r);
  else inside = compare(i, comparisonOperator === '<' || comparisonOperator === '<=' ? '<' : '>', integral)
    + ' OR (' + compare(i, '=', integral) + ' AND ' + compare(truncated, comparisonOperator, r) + ')';
  const above = comparisonOperator === '<' || comparisonOperator === '<=' || comparisonOperator === '<>' ? 'TRUE' : 'FALSE';
  const below = comparisonOperator === '>' || comparisonOperator === '>=' || comparisonOperator === '<>' ? 'TRUE' : 'FALSE';
  return '(CASE WHEN (' + i + ' IS NULL OR ' + r + ' IS NULL) THEN NULL' + cast('bool')
    + ' WHEN ' + compare(r, '>=', upper) + ' THEN ' + above + ' WHEN ' + compare(r, '<', lower) + ' THEN ' + below
    + ' ELSE (' + inside + ') END)';
}

export function compilePostgres(input: QueryModel, options: PostgresCompileOptions = {}): CompiledPostgresQuery {
  // normalizeQueryModel is the same detached validation boundary used by the SQLite compiler.
  const query = normalizeQueryModel(input);
  try { plainRecord(options); } catch { fail('QUERY', 'PostgreSQL compile options must be a plain record.'); }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const option = (name: string): unknown => Object.hasOwn(descriptors, name) ? descriptors[name].value : undefined;
  const schemaOption = option('schema'), onlyOption = option('only');
  if (Object.keys(descriptors).some(key => key !== 'schema' && key !== 'only')
      || onlyOption !== undefined && typeof onlyOption !== 'boolean') fail('QUERY', 'PostgreSQL compile options contain an unsupported value.');
  const schema = identifier((schemaOption === undefined ? 'public' : schemaOption) as string);
  const only = onlyOption === true;
  const parameters: (string | null)[] = [];
  let aliasSequence = 0;
  const qualified = (table: TableModel): string => schema + '.' + identifier(table.name);
  const source = (table: TableModel): string => (only ? 'ONLY ' : '') + qualified(table);
  const append = (value: string | null, type: string): string => {
    // Query models budget 10,000 user bindings; SELECT adds its two compiler-owned page bounds.
    if (parameters.length >= MAX_REQUEST_PARAMETERS) fail('QUERY', 'The PostgreSQL statement exceeds its binding limit.');
    parameters.push(value);
    return '$' + parameters.length + cast(type);
  };
  const bindInteger = (value: number): string => {
    if (!Number.isSafeInteger(value) || value < 0) return wireError();
    return append(String(value), 'int8');
  };
  const bind = (table: TableModel, column: string, value: Parameter, comparison = false): string => {
    const type = columnKind(table, column);
    return append(encodedWire(type, value, table.nullable![column], type === 'json' && comparison), type === 'json' && comparison ? 'jsonb' : CAST[type]);
  };
  const field = (scope: string, column: string): string => scope + '.' + identifier(column);
  const compared = (table: TableModel, scope: string, column: string): string => {
    const expression = field(scope, column);
    return columnKind(table, column) === 'json' ? expression + cast('jsonb') : expression;
  };
  const predicate = (table: TableModel, scope: string, model?: PredicateModel): string => {
    if (model === undefined) return '';
    if (model.kind === 'logic') {
      const children = model.children.map(child => predicate(table, scope, child));
      return children.length ? '(' + children.join(model.operator === 'AND' ? ' AND ' : ' OR ') + ')' : model.operator === 'AND' ? 'TRUE' : 'FALSE';
    }
    if (model.kind === 'not') return 'NOT (' + predicate(table, scope, model.child) + ')';
    if (model.kind === 'column-compare') {
      const leftKind = columnKind(table, model.left), rightKind = columnKind(table, model.right);
      if (leftKind === 'real' && (rightKind === 'integer' || rightKind === 'bigint')) {
        return mixedNumeric(field(scope, model.right), field(scope, model.left), model.operator, true);
      }
      if (rightKind === 'real' && (leftKind === 'integer' || leftKind === 'bigint')) {
        return mixedNumeric(field(scope, model.left), field(scope, model.right), model.operator, false);
      }
      return compared(table, scope, model.left) + operator(model.operator) + compared(table, scope, model.right);
    }
    if (model.kind === 'text-match') {
      // C plus translate guarantees literal matching and ASCII-only folding, independent of database locale/collation.
      const c = ' COLLATE "pg_catalog"."C"';
      const fold = (sql: string): string => model.case === 'ascii-insensitive'
        ? '"pg_catalog"."translate"((' + sql + c + '), \'ABCDEFGHIJKLMNOPQRSTUVWXYZ\', \'abcdefghijklmnopqrstuvwxyz\')'
        : '(' + sql + c + ')';
      wireText(model.literal);
      const expression = fold(field(scope, model.column)), literal = fold(append(model.literal, 'text'));
      if (model.mode === 'ends-with') return '"pg_catalog"."right"(' + expression + ', "pg_catalog"."char_length"(' + literal + '))' + operator('=') + literal;
      return '"pg_catalog"."strpos"(' + expression + ', ' + literal + ')' + operator(model.mode === 'contains' ? '>' : '=') + (model.mode === 'contains' ? '0' : '1');
    }
    if (model.kind === 'compare') {
      const expression = compared(table, scope, model.column);
      if (model.operator === 'IN') {
        if (!model.values.length) return 'FALSE';
        const values = model.values.filter(value => value !== null);
        const clauses: string[] = [];
        // Explicit operator qualification avoids resolving a caller-defined equality operator through search_path.
        if (values.length) clauses.push(expression + operator('=') + 'ANY (ARRAY[' + values.map(value => bind(table, model.column, value, true)).join(', ') + '])');
        if (values.length !== model.values.length) clauses.push(field(scope, model.column) + ' IS NULL');
        return '(' + clauses.join(' OR ') + ')';
      }
      if (model.values[0] === null) return field(scope, model.column) + (model.operator === '=' ? ' IS NULL' : ' IS NOT NULL');
      return expression + operator(model.operator) + bind(table, model.column, model.values[0], true);
    }
    metadata(model.table);
    const alias = '"__rs_pg_filter_' + aliasSequence++ + '"';
    const join = field(alias, model.foreignKey) + operator('=') + field(scope, model.localKey);
    const domain = predicate(model.table, alias, model.where), test = predicate(model.table, alias, model.predicate);
    const condition = test ? ' AND (' + test + ')' + (model.kind === 'relation-filter' && model.quantifier === 'every' ? ' IS NOT TRUE' : '') : '';
    const from = ' FROM ' + source(model.table) + ' AS ' + alias + ' WHERE ' + join + (domain ? ' AND (' + domain + ')' : '') + condition;
    if (model.kind === 'relation-count') return '(SELECT "pg_catalog"."count"(*)' + from + ')' + operator(model.operator) + bindInteger(model.threshold);
    return (model.quantifier === 'some' ? '' : 'NOT ') + 'EXISTS (SELECT 1' + from + ')';
  };
  const order = (table: TableModel, scope: string, entries: readonly OrderModel[]): string => entries.length
    ? ' ORDER BY ' + entries.map(entry => compared(table, scope, entry.column) + ' ' + entry.direction + (entry.direction === 'ASC' ? ' NULLS FIRST' : ' NULLS LAST')).join(', ') : '';
  const result = (sql: string, outputs: readonly PostgresOutputField[], command: CompiledPostgresQuery['command'], count = false): CompiledPostgresQuery => Object.freeze({
    sql, parameters: Object.freeze(parameters), outputs: Object.freeze(outputs.map(output => Object.freeze(output))), command, ...(count ? { count: true as const } : {}),
  });
  if (query.kind === 'transaction') return result(compilePostgresControl(query), [], null);
  if (query.kind === 'explain' || query.kind === 'create-table' || query.kind === 'create-index' || query.kind === 'relation'
      || query.kind === 'aggregate' || query.kind === 'group') return unsupported();
  metadata(query.table);
  if (query.kind === 'select' && query.aggregates?.length) return unsupported();
  const outputs: PostgresOutputField[] = query.kind === 'count'
    ? [{ alias: '__rs_pg_count', property: 'n', kind: 'bigint', nullable: false }]
    : (query.kind === 'select' ? query.columns : query.table.columns).map((property, index) => ({ alias: '__rs_pg_' + index, property,
      kind: columnKind(query.table, property), nullable: query.table.nullable![property] }));
  const projection = outputs.map(output => field(ROOT, output.property) + ' AS "' + output.alias + '"').join(', ');
  const target = qualified(query.table) + ' AS ' + ROOT;
  if (query.kind === 'insert') {
    const body = query.columns.length
      ? ' (' + query.columns.map(identifier).join(', ') + ') OVERRIDING SYSTEM VALUE VALUES (' + query.columns.map((column, index) => bind(query.table, column, query.values[index])).join(', ') + ')'
      : ' DEFAULT VALUES';
    return result('INSERT INTO ' + target + body + ' RETURNING ' + projection, outputs, 'INSERT');
  }
  if (query.kind === 'update') {
    // Assignment bindings precede WHERE bindings in statement order.
    const assignments = query.assignments.map(assignment => identifier(assignment.column) + ' = ' + bind(query.table, assignment.column, assignment.value));
    if (query.table.version) assignments.push(identifier(query.table.version) + ' = ' + field(ROOT, query.table.version) + operator('+') + '1');
    const where = predicate(query.table, ROOT, query.where);
    return result('UPDATE ' + (only ? 'ONLY ' : '') + target + ' SET ' + assignments.join(', ') + ' WHERE ' + where + ' RETURNING ' + projection, outputs, 'UPDATE');
  }
  const where = predicate(query.table, ROOT, query.where), condition = where ? ' WHERE ' + where : '';
  if (query.kind === 'delete') return result('DELETE FROM ' + (only ? 'ONLY ' : '') + target + condition + ' RETURNING ' + projection, outputs, 'DELETE');
  if (query.kind === 'count') return result('SELECT "pg_catalog"."count"(*) AS "__rs_pg_count" FROM ' + source(query.table) + ' AS ' + ROOT + condition, outputs, 'SELECT', true);
  return result('SELECT ' + projection + ' FROM ' + source(query.table) + ' AS ' + ROOT + condition + order(query.table, ROOT, query.orderBy)
    + ' LIMIT ' + bindInteger(query.limit) + ' OFFSET ' + bindInteger(query.offset), outputs, 'SELECT');
}
