/** Bounded, redacted query history shared by the synchronous and asynchronous databases. */
import { performance } from 'node:perf_hooks';
import { fail } from './errors.js';
import { mappedTableModel } from './model-mapping.js';
import { physicalNameKey, validateModelStorage, type PhysicalTableIdentity } from './physical-identity.js';
import type { AnyTable, Parameter, Table } from './schema.js';
import type { Operation, QueryPlan, SchemaTable } from './repository-core.js';

export interface TraceEntry {
  id: string; operation: Operation; table: string; sql: string; parameters: (string | number | null)[];
  durationMs: number; rowCount: number; transactionId: string | null; status: 'ok' | 'error'; plan?: QueryPlan[];
}
/** The database that produced a trace. A document without it is a legacy SQLite trace. */
export type TraceDialect = 'sqlite' | 'postgresql';
interface TraceColumn { name: string; type: string; nullable: boolean; primaryKey: boolean }
interface TraceHeader {
  format: 'rowstitch-trace'; title: string; generatedAt: string; source: 'local-trace';
  queries: TraceEntry[]; notes: string[];
}
export interface TraceDocumentV1 extends TraceHeader {
  version: 1; dialect?: TraceDialect;
  schema: { name: string; columns: TraceColumn[]; foreignKeys: { column: string; table: string; target: string }[] }[];
}
export interface TraceMappingTable {
  logical: string; physical: PhysicalTableIdentity; schemaSource: 'explicit' | 'default'; policy: Table['schemaPolicy'];
  columns: { logical: string; physical: string }[];
}
interface TraceForeignKey {
  constraint: string; width: number; columns: { column: string; target: string | null }[]; targetIdentity: PhysicalTableIdentity;
}
export interface TraceSchemaTable {
  name: string; identity: PhysicalTableIdentity;
  coverage: { columns: 'all' | 'mapped-and-key'; totalColumnCount?: number };
  columns: TraceColumn[]; foreignKeys: TraceForeignKey[];
}
export interface TraceDocumentV2 extends TraceHeader {
  version: 2; dialect: TraceDialect;
  mapping: { tables: TraceMappingTable[]; omittedTables: number };
  inspection: { scope: 'all' | 'mapped'; registeredTables: number; omittedTables: number };
  schema: TraceSchemaTable[];
}
export type TraceDocument = TraceDocumentV1 | TraceDocumentV2;
export interface TraceState {
  traceValues: boolean; capacity: number; traces: TraceEntry[]; sequence: number; traceBytes: number; omittedEntries: number;
  dialect?: TraceDialect;
}
export interface TraceRecord {
  operation: Operation; table: string; sql: string; parameters: readonly Parameter[]; start: number; rowCount: number;
  transactionId: string | null; status: 'ok' | 'error'; plan?: QueryPlan[];
}
const MAX_TRACE_BYTES = 1_048_576;
const MAX_DOCUMENT_BYTES = 2_097_152;

export function small(value: string): string {
  const suffix = '... [truncated]';
  return value.length <= 4096 ? value : value.slice(0, 4096 - suffix.length) + suffix;
}

export function recordTrace(state: TraceState, record: TraceRecord): void {
  const { operation, table, sql, parameters, start, rowCount, transactionId, status, plan } = record;
  const values = parameters.slice(0, 100).map(v => !state.traceValues ? '[redacted]'
    : typeof v === 'bigint' ? String(v) : typeof v === 'string' ? small(v) : v);
  if (parameters.length > 100) values.push('[additional parameters omitted]');
  const entry: TraceEntry = { id: 'q' + ++state.sequence, operation, table: small(table), sql: small(sql), parameters: values,
    durationMs: Math.round(Math.max(0, performance.now() - start) * 1000) / 1000,
    rowCount, transactionId, status };
  if (plan) entry.plan = plan.map(p => ({ ...p, detail: small(p.detail) }));
  const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  if (bytes > MAX_TRACE_BYTES) { state.omittedEntries++; return; }
  state.traces.push(entry);
  state.traceBytes += bytes;
  while (state.traces.length > state.capacity || state.traceBytes > MAX_TRACE_BYTES) {
    state.traceBytes -= Buffer.byteLength(JSON.stringify(state.traces.shift()!), 'utf8');
    state.omittedEntries++;
  }
}

export function clearTraceState(state: TraceState): void {
  state.traces.length = 0; state.traceBytes = 0; state.omittedEntries = 0;
}

interface TraceInspection {
  schema: readonly SchemaTable[];
  scope: 'all' | 'mapped';
  registrations: ReadonlyMap<string, AnyTable>;
  defaultSchema: string;
}

function schemaTraceTable(table: SchemaTable, dialect: TraceDialect): TraceSchemaTable | undefined {
  if (!table.identity || !table.coverage) return;
  // The catalog can contain names longer than Rowstitch's mapping limit. Omit that whole entry.
  try {
    const check = (name: string): void => { physicalNameKey(name, dialect); };
    check(table.identity.schema);
    check(table.identity.table);
    for (const column of table.columns) check(column.name);
    for (const fk of table.foreignKeys) {
      if (!fk.targetIdentity || fk.constraint === undefined || fk.position === undefined || fk.width === undefined) return;
      check(fk.targetIdentity.schema);
      check(fk.targetIdentity.table);
      check(fk.column);
      check(fk.constraint);
      if (fk.targetResolved !== false) check(fk.target);
    }
  } catch { return; }

  const constraints = new Map<string, typeof table.foreignKeys>();
  for (const fk of table.foreignKeys) {
    const group = constraints.get(fk.constraint!);
    if (group) group.push(fk);
    else constraints.set(fk.constraint!, [fk]);
  }
  const foreignKeys = Array.from(constraints, ([constraint, components]) => {
    components.sort((left, right) => left.position! - right.position!);
    return {
      constraint,
      width: components[0].width!,
      targetIdentity: { ...components[0].targetIdentity! },
      columns: components.map(fk => ({ column: fk.column, target: fk.targetResolved === false ? null : fk.target })),
    };
  });
  const { columns: coverage, totalColumnCount } = table.coverage;
  return {
    name: table.identity.table,
    identity: { ...table.identity },
    coverage: { columns: coverage, ...(totalColumnCount === undefined ? {} : { totalColumnCount }) },
    columns: table.columns.map(c => ({ name: c.name, type: small(c.type), nullable: c.nullable, primaryKey: c.primaryKey })),
    foreignKeys,
  };
}

export function traceDocument(state: TraceState, title: string, snapshot: TraceInspection, extraNotes: readonly string[]): TraceDocumentV2 {
  const dialect = state.dialect ?? 'sqlite';
  const document: TraceDocumentV2 = {
    format: 'rowstitch-trace', version: 2, title, generatedAt: new Date().toISOString(), source: 'local-trace', dialect,
    mapping: { tables: [], omittedTables: snapshot.registrations.size },
    inspection: { scope: snapshot.scope, registeredTables: snapshot.registrations.size, omittedTables: snapshot.schema.length },
    schema: [],
    queries: [],
    notes: [state.traceValues ? 'Bound values were explicitly included. Review before sharing.' : 'Bound values are redacted at collection time.',
      'Schema names, identifiers, SQL literals and titles may still be sensitive. Redaction is not anonymization.',
      'History is limited to ' + state.capacity + ' entries and one MiB of serialized entries. Oversized entries and oldest entries may be omitted; ' + state.omittedEntries + ' entries have been omitted since Clear.',
      'Exports may omit more oldest entries to fit two MiB. Internal schema introspection is excluded.', ...extraNotes],
  };
  const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  let used = bytesOf(document);
  if (used > MAX_DOCUMENT_BYTES) fail('TRACE_LIMIT', 'The trace header exceeds the two-MiB export limit.');
  const append = <T>(list: T[], value: T, omittedBefore: number): boolean => {
    const countBytes = String(omittedBefore - 1).length - String(omittedBefore).length;
    const bytes = bytesOf(value) + (list.length === 0 ? 0 : 1) + countBytes;
    if (used + bytes > MAX_DOCUMENT_BYTES) return false;
    list.push(value);
    used += bytes;
    return true;
  };
  for (const table of snapshot.registrations.values()) {
    const physical = validateModelStorage(mappedTableModel(table), snapshot.defaultSchema, dialect);
    const added = append(document.mapping.tables, {
      logical: table.name, physical,
      schemaSource: table.storage.schema === undefined ? 'default' : 'explicit',
      policy: table.schemaPolicy,
      columns: Object.entries(table.storage.columns).map(([logical, name]) => ({ logical, physical: name as string })),
    }, document.mapping.omittedTables);
    if (added) document.mapping.omittedTables--;
  }
  for (const table of snapshot.schema) {
    const entry = schemaTraceTable(table, dialect);
    if (entry && append(document.schema, entry, document.inspection.omittedTables)) document.inspection.omittedTables--;
  }
  const baseBytes = bytesOf(document);
  const entries = state.traces;
  const sizes = entries.map(bytesOf);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let first = 0;
  while (baseBytes + total + Math.max(0, entries.length - first - 1) > MAX_DOCUMENT_BYTES) total -= sizes[first++];
  document.queries = entries.slice(first).map(e => ({ ...e, parameters: [...e.parameters], ...(e.plan ? { plan: e.plan.map(p => ({ ...p })) } : {}) }));
  return document;
}
