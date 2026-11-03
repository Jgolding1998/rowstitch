/** Bounded, redacted query history shared by the synchronous and asynchronous databases. Trace format version 1. */
import { performance } from 'node:perf_hooks';
import { fail } from './errors.js';
import type { Parameter } from './schema.js';
import type { Operation, QueryPlan, SchemaTable } from './repository-core.js';

export interface TraceEntry {
  id: string; operation: Operation; table: string; sql: string; parameters: (string | number | null)[];
  durationMs: number; rowCount: number; transactionId: string | null; status: 'ok' | 'error'; plan?: QueryPlan[];
}
export interface TraceDocument {
  format: 'rowstitch-trace'; version: 1; title: string; generatedAt: string; source: 'local-trace';
  schema: { name: string; columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[]; foreignKeys: { column: string; table: string; target: string }[] }[];
  queries: TraceEntry[]; notes: string[];
}
export interface TraceState {
  traceValues: boolean; capacity: number; traces: TraceEntry[]; sequence: number; traceBytes: number; omittedEntries: number;
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

/** Builds a version 1 document. `extraNotes` follow the standard notes so the synchronous document is unchanged. */
export function traceDocument(state: TraceState, title: string, schema: readonly SchemaTable[], extraNotes: readonly string[]): TraceDocument {
  const document: TraceDocument = {
    format: 'rowstitch-trace', version: 1, title, generatedAt: new Date().toISOString(), source: 'local-trace',
    schema: schema.map(t => ({ name: small(t.name), columns: t.columns.map(c => ({ name: small(c.name), type: c.type, nullable: c.nullable, primaryKey: c.primaryKey })),
      foreignKeys: t.foreignKeys.map(f => ({ column: small(f.column), table: small(f.table), target: small(f.target) })) })),
    queries: [],
    notes: [state.traceValues ? 'Bound values were explicitly included. Review before sharing.' : 'Bound values are redacted at collection time.',
      'Schema names, identifiers, SQL literals and titles may still be sensitive. Redaction is not anonymization.',
      'History is limited to ' + state.capacity + ' entries and one MiB of serialized entries. Oversized entries and oldest entries may be omitted; ' + state.omittedEntries + ' entries have been omitted since Clear.',
      'Exports may omit more oldest entries to fit two MiB. Internal schema introspection is excluded.', ...extraNotes],
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (baseBytes > MAX_DOCUMENT_BYTES) fail('TRACE_LIMIT', 'This schema and title exceed the two-MiB trace export limit. Inspect the schema locally instead.');
  const entries = state.traces;
  const sizes = entries.map(e => Buffer.byteLength(JSON.stringify(e), 'utf8'));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let first = 0;
  while (baseBytes + total + Math.max(0, entries.length - first - 1) > MAX_DOCUMENT_BYTES) total -= sizes[first++];
  document.queries = entries.slice(first).map(e => ({ ...e, parameters: [...e.parameters], ...(e.plan ? { plan: e.plan.map(p => ({ ...p })) } : {}) }));
  return document;
}
