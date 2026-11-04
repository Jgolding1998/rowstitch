/** Internal first PostgreSQL root-query slice. No public driver, schema creation or arbitrary SQL. */
import { RowstitchError } from './errors.js';
import { identifier, isTable, type AnyTable, type Columns, type Kind, type Table } from './schema.js';
import { bindPostgresValue, decodePostgresRows, snapshotPostgresResult, type PostgresOutputField } from './postgres-result.js';

type Mapping = Table<Columns, string | undefined>;
interface LogicalValue { readonly column: string; readonly kind: Kind; readonly nullable: boolean; readonly value: unknown }
export interface PostgresRootPlan {
  readonly operation: 'insert' | 'by-key' | 'count';
  readonly schema: string;
  readonly table: Mapping;
  readonly values: readonly LogicalValue[];
}
export interface CompiledPostgresRoot {
  readonly operation: PostgresRootPlan['operation'];
  readonly sql: string;
  readonly parameters: readonly (string | null)[];
  readonly outputs: readonly PostgresOutputField[];
}
const plans = new WeakSet<object>(), statements = new WeakSet<object>();
const invalid = (code: 'VALIDATION' | 'QUERY' | 'DATA' | 'SCHEMA', message: string): never => { throw new RowstitchError(code, message); };
const CAST = Object.freeze({ bigint:'"pg_catalog"."int8"', 'double precision':'"pg_catalog"."float8"', text:'"pg_catalog"."text"', boolean:'"pg_catalog"."bool"', jsonb:'"pg_catalog"."jsonb"' });
function mapping(input: AnyTable): Mapping {
  if (!isTable(input)) return invalid('SCHEMA', 'A PostgreSQL root plan requires a genuine mapped table.');
  return input;
}
function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function capturedRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
    const properties = Object.getOwnPropertyDescriptors(input), result: Record<string, unknown> = Object.create(null);
    if (Reflect.ownKeys(properties).length !== keys.length) throw new Error();
    for (const key of keys) {
      const property = properties[key];
      if (!property || !('value' in property) || !property.enumerable) throw new Error();
      result[key] = property.value;
    }
    return result;
  } catch { return invalid('VALIDATION', 'The PostgreSQL root record must provide exactly its required fields as plain data.'); }
}
function plan(operation: PostgresRootPlan['operation'], input: AnyTable, data: unknown, schema: string): PostgresRootPlan {
  const table = mapping(input);
  identifier(schema);
  if (/^(?:pg_|information_schema$)/i.test(schema)) return invalid('SCHEMA', 'System and temporary PostgreSQL schemas are not supported by root plans.');
  const names = Object.keys(table.columns);
  const keys = operation === 'count' ? [] : operation === 'by-key' ? names.filter(name => table.columns[name]!.config.primary) : names;
  if (operation === 'insert' && names.some(name => table.columns[name]!.config.generated))
    return invalid('QUERY', 'Generated PostgreSQL inserts are not implemented by this root-plan slice.');
  const captured = operation === 'count' ? {} : capturedRecord(data, keys);
  const values = keys.map(column => {
    const { kind, nullable } = table.columns[column]!.config;
    // Reuse validation, but hold logical values rather than driver text in the plan. JSON is detached from the caller.
    const bound = bindPostgresValue(kind, captured[column], nullable);
    const value = kind === 'json' && bound.value !== null ? freezeJson(JSON.parse(bound.value)) : captured[column];
    return Object.freeze({ column, kind, nullable, value });
  });
  const result = Object.freeze({ operation, schema, table, values:Object.freeze(values) });
  plans.add(result);
  return result;
}
/** First slice: supply every mapped value explicitly, including nullable/defaulted columns. */
export function planPostgresInsert(table: AnyTable, data: unknown, schema = 'public'): PostgresRootPlan { return plan('insert', table, data, schema); }
export function planPostgresByKey(table: AnyTable, key: unknown, schema = 'public'): PostgresRootPlan { return plan('by-key', table, key, schema); }
export function planPostgresCount(table: AnyTable, schema = 'public'): PostgresRootPlan { return plan('count', table, undefined, schema); }
/** Compilation identity only, never evidence of execution or authorization. */
export function isCompiledPostgresRoot(value: unknown): value is CompiledPostgresRoot { return value !== null && typeof value === 'object' && statements.has(value); }

export function compilePostgresRoot(input: PostgresRootPlan): CompiledPostgresRoot {
  if (!input || typeof input !== 'object' || !plans.has(input)) return invalid('QUERY', 'Compile a genuine PostgreSQL root plan.');
  const { operation, schema, table } = input;
  const qualified = identifier(schema) + '.' + identifier(table.name);
  const parameters: (string | null)[] = [];
  const bind = (kind: Kind, value: unknown, nullable = false): string => {
    const captured = bindPostgresValue(kind, value, nullable);
    parameters.push(captured.value);
    return '$' + parameters.length + '::' + CAST[captured.cast];
  };
  const outputs: PostgresOutputField[] = operation === 'count'
    ? [{ alias:'__rs_pg_count', property:'count', kind:'integer', nullable:false }]
    : Object.keys(table.columns).map((property, i) => ({ alias:'__rs_pg_'+i, property, kind:table.columns[property]!.config.kind, nullable:table.columns[property]!.config.nullable }));
  // Aliases are fixed compiler tokens. The public identifier validator deliberately reserves this namespace.
  const projection = outputs.map(field => identifier(field.property) + ' AS "' + field.alias + '"').join(', ');
  let sql: string;
  if (operation === 'insert') {
    const names = input.values.map(value => identifier(value.column)).join(', ');
    const values = input.values.map(value => bind(value.kind, value.value, value.nullable)).join(', ');
    sql = 'INSERT INTO ' + qualified + ' (' + names + ') VALUES (' + values + ') RETURNING ' + projection;
  } else if (operation === 'by-key') {
    const where = input.values.map(value => identifier(value.column) + ' OPERATOR("pg_catalog".=) ' + bind(value.kind, value.value, value.nullable)).join(' AND ');
    sql = 'SELECT ' + projection + ' FROM ONLY ' + qualified + ' WHERE ' + where + ' LIMIT ' + bind('integer', 2);
  } else {
    sql = 'SELECT "pg_catalog"."count"(*) AS "__rs_pg_count" FROM ONLY ' + qualified;
  }
  const result = Object.freeze({ operation, sql, parameters:Object.freeze(parameters), outputs:Object.freeze(outputs.map(field => Object.freeze(field))) });
  statements.add(result);
  return result;
}

/** Decode an acknowledged result inside the write transaction, before COMMIT. Does not perform any I/O. */
export function decodePostgresRoot(compiled: CompiledPostgresRoot, value: unknown): Record<string, unknown> | number | null {
  if (!isCompiledPostgresRoot(compiled)) return invalid('QUERY', 'Decode with a genuine compiled PostgreSQL root statement.');
  const raw = snapshotPostgresResult(value), command = compiled.operation === 'insert' ? 'INSERT' : 'SELECT';
  if (raw.command !== command || raw.rowCount === null || raw.rowCount !== BigInt(raw.rows.length))
    return invalid('DATA', 'PostgreSQL returned an unexpected command or row count for this root statement.');
  const rows = decodePostgresRows(raw, compiled.outputs);
  if (compiled.operation === 'by-key') {
    if (rows.length > 1) return invalid('DATA', 'A declared primary key matched more than one PostgreSQL row.');
    return rows[0] ?? null;
  }
  if (rows.length !== 1) return invalid('DATA', 'PostgreSQL did not return exactly one row for this root statement.');
  if (compiled.operation === 'count') {
    const count: unknown = rows[0]!.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return invalid('DATA', 'The PostgreSQL count is outside its safe integer contract.');
    return count;
  }
  return rows[0]!;
}
