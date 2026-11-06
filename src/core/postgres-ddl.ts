/** Creation from captured structured models. No migration, caller SQL or connection lives here. */
import { types } from 'node:util';
import { fail } from './errors.js';
import type { Kind, Parameter } from './schema.js';
import { modelPhysicalColumn, modelPhysicalTable, physicalTableIdentity, quotePhysicalName, quotePhysicalTable } from './physical-identity.js';
import { normalizeQueryModel, type CreateIndexModel, type CreateTableModel, type ForeignKeyTargetModel } from './query-model.js';
import { bindPostgresEncoded } from './postgres-compiler.js';
import { isPostgresRawResult, snapshotPostgresResult } from './postgres-result.js';

const TYPES: Readonly<Record<Kind, string>> = Object.freeze({
  integer: 'int8', bigint: 'int8', real: 'float8', text: 'text', boolean: 'bool', json: 'jsonb',
});
const ACTIONS = Object.freeze({ cascade: 'CASCADE', restrict: 'RESTRICT', 'set null': 'SET NULL', 'no action': 'NO ACTION' });
const typeSql = (kind: Kind): string => '"pg_catalog"."' + TYPES[kind] + '"';
const { isProxy } = types;
const { getPrototypeOf, ownKeys } = Reflect;
const { getOwnPropertyDescriptors, hasOwn } = Object;
const invalidDefault = (): never => fail('VALIDATION', 'The PostgreSQL default is outside its typed scalar contract.');
const invalidDDL = (): never => fail('SCHEMA', 'The PostgreSQL creation plan must contain bounded plain structured data.');
const invalidAck = (): never => fail('DATA', 'PostgreSQL did not acknowledge the expected creation statement.');

/** Detached data only, before the shared model normalizer: no model getter or Proxy trap is executed. */
function capture(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 10_000 || depth > 12) return invalidDDL();
  if (value === null || ['string', 'number', 'bigint', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value !== 'object' || isProxy(value)) return invalidDDL();
  const prototype = getPrototypeOf(value), descriptors = getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype && prototype !== null) return invalidDDL();
    const length: unknown = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 100 || ownKeys(descriptors).length !== length + 1) return invalidDDL();
    return Array.from({ length }, (_, i) => {
      const key = String(i), descriptor = hasOwn(descriptors, key) ? descriptors[key] : undefined;
      if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return invalidDDL();
      return capture(descriptor.value, depth + 1, budget);
    });
  }
  if (prototype !== Object.prototype && prototype !== null || ownKeys(descriptors).length > 100) return invalidDDL();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys(descriptors)) {
    if (typeof key !== 'string') return invalidDDL();
    const descriptor = descriptors[key];
    if (!hasOwn(descriptor, 'value') || !descriptor.enumerable) return invalidDDL();
    result[key] = capture(descriptor.value, depth + 1, budget);
  }
  return result;
}

/**
 * PostgreSQL forbids bind parameters in a DEFAULT expression. Render only a validated typed scalar.
 * E-strings escape backslashes independently of standard_conforming_strings, as well as single quotes.
 */
export function postgresDefaultLiteral(kind: Kind, value: Parameter, nullable: boolean): string {
  if (typeof kind !== 'string' || !hasOwn(TYPES, kind) || typeof nullable !== 'boolean') return invalidDefault();
  let text: string | null;
  try { text = bindPostgresEncoded(kind, value, nullable); } catch { return invalidDefault(); }
  if (text === null) return 'NULL';
  const literal = "E'" + text.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  return literal + '::' + typeSql(kind);
}

export function compilePostgresDDL(input: CreateTableModel | CreateIndexModel, schema = 'public'): string {
  let captured: unknown;
  try { captured = capture(input); } catch { return invalidDDL(); }
  const query = normalizeQueryModel(captured as CreateTableModel | CreateIndexModel);
  const namespace = (value: string): string => {
    const quoted = quotePhysicalName(value, 'postgresql');
    if (/^(?:pg_|information_schema$)/i.test(value)) fail('SCHEMA', 'Create mapped objects in a supported user namespace.');
    return quoted;
  };
  namespace(schema);
  if (query.kind !== 'create-table' && query.kind !== 'create-index') fail('QUERY', 'Compile a structured PostgreSQL creation plan.');
  const identity = modelPhysicalTable(query.table, schema, 'postgresql');
  namespace(identity.schema);
  const table = quotePhysicalTable(identity.schema, identity.table, 'postgresql');
  const columnName = (logical: string): string => quotePhysicalName(modelPhysicalColumn(query.table, logical, 'postgresql'), 'postgresql');
  for (const logical of query.table.columns) columnName(logical);
  if (query.kind === 'create-index') return 'CREATE INDEX ' + quotePhysicalName(query.name, 'postgresql') + ' ON ' + table
    + ' (' + query.columns.map(columnName).join(', ') + ')';
  const definitions = query.definitions.map(column => {
    if (query.table.kinds && query.table.kinds[column.name] !== column.kind || query.table.nullable && query.table.nullable[column.name] !== column.nullable)
      fail('SCHEMA', 'Creation definitions must agree with their captured mapping metadata.');
    if (column.generated && column.hasDefault) fail('SCHEMA', 'An identity column cannot also have a mapped default.');
    let sql = columnName(column.name) + ' ' + typeSql(column.kind);
    if (column.generated) sql += ' GENERATED BY DEFAULT AS IDENTITY';
    if (!column.nullable) sql += ' NOT NULL';
    if (column.hasDefault) sql += ' DEFAULT ' + postgresDefaultLiteral(column.kind, column.defaultValue!, column.nullable);
    if (column.unique) sql += ' UNIQUE';
    if (column.foreignKey) {
      const key = column.foreignKey;
      const target: ForeignKeyTargetModel = key.target ?? { table: key.table!, column: key.column! };
      // Omitted target schema belongs to the factory default, independently of the owner's explicit schema.
      const foreign = physicalTableIdentity(target.schema ?? schema, target.table, 'postgresql');
      namespace(foreign.schema);
      sql += ' REFERENCES ' + quotePhysicalTable(foreign.schema, foreign.table, 'postgresql') + ' (' + quotePhysicalName(target.column, 'postgresql') + ') ON DELETE ' + ACTIONS[key.onDelete];
    }
    return sql;
  });
  definitions.push('PRIMARY KEY (' + query.table.primaryKey.map(columnName).join(', ') + ')');
  return 'CREATE TABLE ' + table + ' (' + definitions.join(', ') + ')';
}

/** DDL acknowledgment is not a typed row query. Validate its exact empty CREATE response before the enclosing commit. */
export function decodePostgresDDL(value: unknown): Record<string, unknown>[] {
  try {
    let captured: unknown = value;
    if (!isPostgresRawResult(value)) {
      if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
        || ![null, Object.prototype].includes(getPrototypeOf(value))) return invalidAck();
      const descriptors = getOwnPropertyDescriptors(value), keys = ['fields', 'rows', 'command', 'rowCount'];
      if (ownKeys(descriptors).length !== keys.length) return invalidAck();
      const record: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        const descriptor = hasOwn(descriptors, key) ? descriptors[key] : undefined;
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return invalidAck();
        record[key] = descriptor.value;
      }
      for (const name of ['fields', 'rows']) {
        const list = record[name];
        if (!list || typeof list !== 'object' || isProxy(list) || !Array.isArray(list)) return invalidAck();
        const prototype = getPrototypeOf(list), descriptors = getOwnPropertyDescriptors(list) as unknown as Record<string, PropertyDescriptor>;
        if (prototype !== Array.prototype && prototype !== null || ownKeys(descriptors).length !== 1 || descriptors.length?.value !== 0) return invalidAck();
      }
      captured = { fields: [], rows: [], command: record.command, rowCount: record.rowCount };
    }
    const raw = snapshotPostgresResult(captured);
    if (raw.command !== 'CREATE' || raw.rowCount !== null || raw.fields.length || raw.rows.length) return invalidAck();
    return [];
  } catch { return invalidAck(); }
}
