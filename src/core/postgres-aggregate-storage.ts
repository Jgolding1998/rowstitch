/** Native aggregate wire results normalized into the existing shared aggregate layouts. No SQL or connection ownership. */
import { types } from 'node:util';
import { RowstitchError } from './errors.js';
import { isPostgresRawResult, snapshotPostgresResult, type PostgresOutputField, type PostgresRawResult } from './postgres-result.js';
import { decodePostgresStorage, POSTGRES_MAX_MAPPED_CELLS } from './postgres-storage.js';
import { POSTGRES_AGGREGATE_LIMITS as LIMITS, type PostgresAggregateField, type PostgresAggregateProfile } from './postgres-aggregate-profile.js';
import type { Kind } from './schema.js';

const { isProxy } = types;
const { getPrototypeOf, ownKeys, defineProperty } = Reflect;
const { getOwnPropertyDescriptors, hasOwn } = Object;
const BASE = 4_294_967_296n, SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const OIDS: Readonly<Record<Kind, readonly number[]>> = Object.freeze({
  integer: [21, 23, 20], bigint: [21, 23, 20], real: [700, 701], text: [25, 1043], boolean: [16], json: [114, 3802],
});
const CANONICAL: Readonly<Record<Kind, number>> = Object.freeze({ integer: 20, bigint: 20, real: 701, text: 25, boolean: 16, json: 114 });
const bad = (): never => { throw new RowstitchError('DATA', 'PostgreSQL aggregate data did not match its compiled storage contract.'); };
const range = (): never => { throw new RowstitchError('AGGREGATE_RANGE', 'An aggregate result is not a finite number.'); };
const limited = (): never => { throw new RowstitchError('RESULT_LIMIT', 'The native summary result exceeds its 16 MiB wire-text limit.'); };

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![null, Object.prototype].includes(getPrototypeOf(value))) return bad();
  const descriptors = getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys(descriptors)) {
    if (typeof key !== 'string') return bad();
    const property = descriptors[key]!;
    if (!hasOwn(property, 'value') || !property.enumerable) return bad();
    result[key] = property.value;
  }
  return result;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (ownKeys(value).length !== keys.length || keys.some(key => !hasOwn(value, key))) bad();
}
function list(value: unknown, maximum: number): unknown[] {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return bad();
  const prototype = getPrototypeOf(value);
  if (prototype !== null && prototype !== Array.prototype) return bad();
  const descriptors = getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum
    || ownKeys(descriptors).length !== length + 1) return bad();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const property = hasOwn(descriptors, String(i)) ? descriptors[String(i)] : undefined;
    if (!property || !hasOwn(property, 'value') || !property.enumerable) return bad();
    result.push(property.value);
  }
  return result;
}
function profileOf(value: unknown): PostgresAggregateProfile {
  const profile = plain(value); exact(profile, ['mode', 'fields']);
  if (!['aggregate', 'group', 'projected'].includes(profile.mode as string)) return bad();
  const targets = new Set<string>(); let guards = 0;
  const target = (name: unknown): string => {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || /^sqlite_/i.test(name)
      || ['__proto__', 'constructor', 'prototype'].includes(name) || targets.has(name)) return bad();
    targets.add(name); return name;
  };
  const fields = list(profile.fields, LIMITS.fields).map((item, i): PostgresAggregateField => {
    const field = plain(item);
    if (field.alias !== '__rs_pg_' + i) return bad();
    switch (field.kind) {
      case 'count': case 'real-aggregate':
        exact(field, ['alias', 'kind', 'target']); return { alias: field.alias as string, kind: field.kind, target: target(field.target) };
      case 'integer-sum':
        exact(field, ['alias', 'kind', 'high', 'low']); return { alias: field.alias as string, kind: field.kind, high: target(field.high), low: target(field.low) };
      case 'mapped': {
        exact(field, ['alias', 'kind', 'target', 'storageKind', 'nullable', 'canonical']);
        if (typeof field.storageKind !== 'string' || !hasOwn(OIDS, field.storageKind)
          || typeof field.nullable !== 'boolean' || typeof field.canonical !== 'boolean') return bad();
        return { alias: field.alias as string, kind: field.kind, target: target(field.target), storageKind: field.storageKind as Kind,
          nullable: field.nullable, canonical: field.canonical };
      }
      case 'guard': {
        exact(field, ['alias', 'kind', 'target']);
        if (++guards !== 1 || field.target !== (profile.mode === 'projected' ? '__rs_ragg_bad' : '__rs_bad')) return bad();
        return { alias: field.alias as string, kind: field.kind, target: target(field.target) };
      }
      default: return bad();
    }
  });
  if (fields.length < 2 || guards !== 1) return bad();
  return { mode: profile.mode as PostgresAggregateProfile['mode'], fields };
}
function snapshot(value: unknown): PostgresRawResult {
  if (isPostgresRawResult(value)) return snapshotPostgresResult(value);
  const input = plain(value); exact(input, ['fields', 'rows', 'command', 'rowCount']);
  const fields = list(input.fields, LIMITS.fields).map(item => { const field = plain(item); exact(field, ['name', 'typeOid']); return field; });
  const rows = list(input.rows, LIMITS.rows);
  if (rows.length * fields.length > LIMITS.cells) return bad();
  return snapshotPostgresResult({ fields, rows: rows.map(row => list(row, fields.length)), command: input.command, rowCount: input.rowCount });
}
function oidMatches(field: PostgresAggregateField, oid: number): boolean {
  switch (field.kind) {
    case 'count': return oid === 20;
    case 'integer-sum': return oid === 1700;
    case 'real-aggregate': return oid === 701;
    case 'guard': return oid === 23;
    case 'mapped': return field.canonical ? oid === CANONICAL[field.storageKind] : OIDS[field.storageKind].includes(oid);
  }
}
function sum(text: string | null): readonly [bigint | null, bigint | null] {
  if (text === null) return [null, null];
  if (text.length > LIMITS.integerDigits + LIMITS.fractionDigits + 2 || !/^-?(?:0|[1-9][0-9]*)(?:\.0+)?$/.test(text)) return bad();
  const dot = text.indexOf('.'), integer = dot < 0 ? text : text.slice(0, dot);
  if (integer.length - (integer.startsWith('-') ? 1 : 0) > LIMITS.integerDigits
    || dot >= 0 && text.length - dot - 1 > LIMITS.fractionDigits) return bad();
  const total = BigInt(integer), low = (total % BASE + BASE) % BASE;
  return [(total - low) / BASE, low];
}
function count(text: string | null): bigint {
  if (text === null || text.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(text)) return bad();
  const value = BigInt(text); if (value > SAFE_MAX) return bad(); return value;
}
function real(text: string | null): number | null {
  if (text === null) return null;
  if (text === 'Infinity' || text === '-Infinity') return range();
  if (text.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) return bad();
  const value = Number(text);
  if (!Number.isFinite(value)) return bad();
  if (value === 0 && /[1-9]/.test(text.split(/[eE]/)[0]!)) return bad();
  return value;
}

/** Validates the native profile first, then returns the shared codecs' canonical storage rows, never public objects. */
export function decodePostgresAggregateStorage(value: unknown, compiled: PostgresAggregateProfile): Record<string, unknown>[] {
  try {
    const profile = profileOf(compiled), raw = snapshot(value);
    if (raw.command !== 'SELECT' || raw.rowCount !== BigInt(raw.rows.length) || raw.fields.length !== profile.fields.length
      || raw.rows.length > LIMITS.rows || raw.rows.length * raw.fields.length > LIMITS.cells
      || profile.mode === 'aggregate' && raw.rows.length !== 1) return bad();
    profile.fields.forEach((field, i) => { if (raw.fields[i]!.name !== field.alias || !oidMatches(field, raw.fields[i]!.typeOid)) bad(); });
    let bytes = 0;
    const addText = (text: string): void => {
      if (text.length > LIMITS.bytes - bytes) return limited();
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > LIMITS.bytes) limited();
    };
    for (const field of raw.fields) addText(field.name);
    for (const row of raw.rows) for (const cell of row) if (cell !== null) addText(cell);
    const guard = profile.fields.findIndex(field => field.kind === 'guard');
    // Input-invalid DATA takes priority over even an earlier row's range result; no partial row is delivered.
    for (const row of raw.rows) if (row[guard] !== '0') return bad();
    const mapped = profile.fields.flatMap((field, index) => field.kind === 'mapped' ? [{ field, index }] : []);
    // Reuse the scalar codec in bounded detached batches. Related MIN/MAX add mapped slots beyond ordinary columns;
    // a valid aggregate page must not weaken the ordinary codec's1M-cell entry contract or fail merely for using them.
    // All original metadata, bytes and every row's guard were checked before decoding any batch.
    const mappedRows: Record<string, unknown>[] = [];
    if (mapped.length) {
      const fields = mapped.map((entry, i) => ({ name: '__rs_pg_' + i, typeOid: raw.fields[entry.index]!.typeOid }));
      const outputs = mapped.map((entry, i): PostgresOutputField => ({ alias: '__rs_pg_' + i, property: 'p' + i,
        kind: entry.field.storageKind, nullable: entry.field.nullable }));
      const batchRows = Math.floor(POSTGRES_MAX_MAPPED_CELLS / mapped.length);
      for (let offset = 0; offset < raw.rows.length; offset += batchRows) {
        const rows = raw.rows.slice(offset, offset + batchRows).map(row => mapped.map(entry => row[entry.index]!));
        const decoded = decodePostgresStorage({ command: 'SELECT', rowCount: BigInt(rows.length), fields, rows }, outputs, 'SELECT');
        for (const row of decoded) mappedRows.push(row);
      }
    }
    return raw.rows.map((row, rowIndex) => {
      const result: Record<string, unknown> = {};
      const put = (name: string, cell: unknown): void => { defineProperty(result, name, { value: cell, enumerable: true, writable: true, configurable: true }); };
      let mappedIndex = 0;
      profile.fields.forEach((field, i) => {
        switch (field.kind) {
          case 'guard': put(field.target, 0n); break;
          case 'count': put(field.target, count(row[i]!)); break;
          case 'integer-sum': { const [high, low] = sum(row[i]!); put(field.high, high); put(field.low, low); break; }
          case 'real-aggregate': put(field.target, real(row[i]!)); break;
          case 'mapped': put(field.target, mappedRows[rowIndex]!['p' + mappedIndex++]); break;
        }
      });
      return result;
    });
  } catch (error) { if (error instanceof RowstitchError && (error.code === 'AGGREGATE_RANGE' || error.code === 'RESULT_LIMIT')) throw error; return bad(); }
}
