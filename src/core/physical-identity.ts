/** Physical names are data. Logical property validation stays in schema.identifier(). */
import { fail } from './errors.js';
import type { TableModel } from './query-model.js';

export type PhysicalDialect = 'sqlite' | 'postgresql';
export interface PhysicalTableIdentity { readonly schema: string; readonly table: string }

// The generic bound is Rowstitch policy, not SQLite's engine maximum. PostgreSQL uses bytes, not characters.
const MAX_NAME_BYTES = 4096, MAX_POSTGRES_NAME_BYTES = 63;
const invalid = (): never => fail('SCHEMA', 'A physical name must be nonempty well-formed text within its byte limit.');

function checkedName(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.length || value.length > limit) return invalid();
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
      bytes += 4;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) return invalid();
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) return invalid();
  }
  return value;
}

export function capturePhysicalName(value: unknown): string {
  return checkedName(value, MAX_NAME_BYTES);
}

function dialectName(value: unknown, dialect: PhysicalDialect): string {
  if (dialect !== 'sqlite' && dialect !== 'postgresql') fail('SCHEMA', 'The physical identity dialect is unsupported.');
  return checkedName(value, dialect === 'postgresql' ? MAX_POSTGRES_NAME_BYTES : MAX_NAME_BYTES);
}

export function quotePhysicalName(value: unknown, dialect: PhysicalDialect): string {
  return '"' + dialectName(value, dialect).replaceAll('"', '""') + '"';
}

export function physicalTableIdentity(schema: unknown, table: unknown, dialect: PhysicalDialect): PhysicalTableIdentity {
  return Object.freeze({ schema: dialectName(schema, dialect), table: dialectName(table, dialect) });
}

export function quotePhysicalTable(schema: unknown, table: unknown, dialect: PhysicalDialect): string {
  return quotePhysicalName(schema, dialect) + '.' + quotePhysicalName(table, dialect);
}

/** SQLite folds ASCII identifiers. Unicode normalization and Unicode case folding would merge distinct names. */
function identityPart(value: string, dialect: PhysicalDialect): string {
  return dialect === 'sqlite' ? value.replace(/[A-Z]/g, unit => unit.toLowerCase()) : value;
}

export function physicalNameKey(value: unknown, dialect: PhysicalDialect): string {
  return identityPart(dialectName(value, dialect), dialect);
}

export function physicalTableKey(schema: unknown, table: unknown, dialect: PhysicalDialect): string {
  const identity = physicalTableIdentity(schema, table, dialect);
  return JSON.stringify([identityPart(identity.schema, dialect), identityPart(identity.table, dialect)]);
}

export function modelPhysicalTable(model: TableModel, defaultSchema: string, dialect: PhysicalDialect): PhysicalTableIdentity {
  return physicalTableIdentity(model.storage?.schema ?? defaultSchema, model.storage?.table ?? model.name, dialect);
}

export function modelPhysicalColumn(model: TableModel, column: string, dialect: PhysicalDialect): string {
  if (!model.columns.includes(column)) fail('QUERY', 'A query references an unmapped column.');
  if (model.storage && !Object.hasOwn(model.storage.columns, column)) fail('SCHEMA', 'Storage metadata is incomplete.');
  return dialectName(model.storage ? model.storage.columns[column] : column, dialect);
}

/** Validates every mapped component before a backend opens or a renderer emits SQL. */
export function validateModelStorage(model: TableModel, defaultSchema: string, dialect: PhysicalDialect): PhysicalTableIdentity {
  const target = modelPhysicalTable(model, defaultSchema, dialect);
  if (dialect === 'sqlite' ? !['main', 'temp'].includes(identityPart(target.schema, dialect))
    : /^(?:pg_|information_schema$)/i.test(target.schema)) fail('SCHEMA', 'The mapped namespace is unsupported.');
  const columns = model.columns.map(column => physicalNameKey(modelPhysicalColumn(model, column, dialect), dialect));
  if (new Set(columns).size !== columns.length) fail('SCHEMA', 'Mapped physical column names must be distinct for this backend.');
  return target;
}
