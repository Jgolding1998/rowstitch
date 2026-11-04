/** Native PostgreSQL rows normalized for the shared column codecs. Not a public raw-SQL API. */
import { types } from 'node:util';
import { RowstitchError } from './errors.js';
import { decode, identifier, type Kind } from './schema.js';
import { isPostgresRawResult, snapshotPostgresResult, type PostgresOutputField, type PostgresRawResult } from './postgres-result.js';

type Command = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const MAX_FIELDS = 512, MAX_ROWS = 100_000, MAX_CELLS = 1_000_000;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER), SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
const { isProxy } = types;
const { getPrototypeOf, defineProperty, ownKeys } = Reflect;
const { hasOwn, getOwnPropertyDescriptors } = Object;
const fround = Math.fround;
const OIDS: Readonly<Record<Kind, readonly number[]>> = Object.freeze({
  integer: Object.freeze([21, 23, 20]), bigint: Object.freeze([21, 23, 20]),
  real: Object.freeze([700, 701]), text: Object.freeze([25, 1043]),
  boolean: Object.freeze([16]), json: Object.freeze([114, 3802]),
});
const bad = (): never => { throw new RowstitchError('DATA', 'PostgreSQL data did not match its compiled storage contract.'); };

/** Plain own data only: neither metadata nor an unbranded driver result can run a getter or Proxy trap here. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(getPrototypeOf(value))) return bad();
  const descriptors = getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  if (ownKeys(descriptors).length !== keys.length) return bad();
  for (const key of keys) {
    const property = hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!property || !hasOwn(property, 'value') || !property.enumerable) return bad();
    result[key] = property.value;
  }
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return bad();
  const prototype = getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return bad();
  const descriptors = getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum
    || ownKeys(descriptors).length !== length + 1) return bad();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const key = String(i), property = hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!property || !hasOwn(property, 'value') || !property.enumerable) return bad();
    result.push(property.value);
  }
  return result;
}
function snapshot(value: unknown): PostgresRawResult {
  // This brand identifies an immutable shape, never an engine acknowledgment or authorization.
  if (isPostgresRawResult(value)) return snapshotPostgresResult(value);
  const input = record(value, ['fields', 'rows', 'command', 'rowCount']);
  const fields = list(input.fields, MAX_FIELDS).map(field => record(field, ['name', 'typeOid']));
  const rows = list(input.rows, MAX_ROWS);
  if (rows.length * fields.length > MAX_CELLS) return bad();
  // Capture plain data first so the existing snapshot validator never encounters a caller's Proxy or accessor.
  return snapshotPostgresResult({ fields, rows: rows.map(row => list(row, fields.length)), command: input.command, rowCount: input.rowCount });
}
function outputsOf(value: unknown, count: boolean): PostgresOutputField[] {
  const properties = new Set<string>();
  const outputs = list(value, MAX_FIELDS).map((item, i) => {
    const field = record(item, ['alias', 'property', 'kind', 'nullable']);
    if (field.alias !== (count ? '__rs_pg_count' : '__rs_pg_' + i)
      || typeof field.property !== 'string' || properties.has(field.property)
      || typeof field.kind !== 'string' || !hasOwn(OIDS, field.kind) || typeof field.nullable !== 'boolean') return bad();
    identifier(field.property);
    properties.add(field.property);
    return { alias: field.alias, property: field.property, kind: field.kind as Kind, nullable: field.nullable };
  });
  if (outputs.length === 0 || count && (outputs.length !== 1 || outputs[0]!.property !== 'n'
    || outputs[0]!.kind !== 'bigint' || outputs[0]!.nullable)) return bad();
  return outputs;
}
function wireText(value: string): void {
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) bad();
}
function integer(text: string, oid: number): bigint {
  if (text.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text)) return bad();
  const value = BigInt(text);
  const min = oid === 21 ? -32768n : oid === 23 ? -2147483648n : INT64_MIN;
  const max = oid === 21 ? 32767n : oid === 23 ? 2147483647n : INT64_MAX;
  if (value < min || value > max) return bad();
  return value;
}
function scalar(field: PostgresOutputField, oid: number, text: string | null): unknown {
  if (text === null) { if (!field.nullable) return bad(); return null; }
  wireText(text);
  switch (field.kind) {
    case 'integer': case 'bigint': {
      const value = integer(text, oid);
      if (field.kind === 'integer' && (value < SAFE_MIN || value > SAFE_MAX)) return bad();
      return value;
    }
    case 'real': {
      if (text.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) return bad();
      const value = Number(text);
      if (!Number.isFinite(value) || value === 0 && /[1-9]/.test(text.split(/[eE]/)[0]!)) return bad();
      if (oid === 701) return value;
      // float4's shortest text roundtrips at binary32 precision, not at JavaScript's binary64 precision.
      const narrowed = fround(value);
      if (!Number.isFinite(narrowed) || narrowed === 0 && value !== 0) return bad();
      return narrowed;
    }
    case 'text': return text;
    case 'boolean': if (text === 't') return 1n; if (text === 'f') return 0n; return bad();
    case 'json':
      // Validate, but retain wire text for the shared codec to decode once into the application value.
      // This is JS JSON: arbitrary numeric precision, JSON-null provenance and nested -0 are not guaranteed.
      // Escaped JSON NUL/surrogates are legal under that codec; actual wire strings must remain valid UTF-8 text.
      decode({ kind: 'json', nullable: field.nullable, primary: false, generated: false, unique: false, hasDefault: false }, text);
      return text;
  }
}

/**
 * Public-native query profile only. M13's exact OID decoder and physical-mapping policy remain separate.
 * Returns internal shared-codec inputs: bigint integers, 0n/1n booleans and JSON text, never application objects.
 */
export function decodePostgresStorage(value: unknown, outputs: readonly PostgresOutputField[], command: Command,
  options?: { count?: boolean }): Record<string, unknown>[] {
  try {
    if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(command)) return bad();
    let count = false;
    if (options !== undefined) {
      if (options === null || typeof options !== 'object' || isProxy(options)) return bad();
      const keys = ownKeys(options);
      if (keys.length > 1 || keys.some(key => key !== 'count')) return bad();
      const captured = record(options, keys as string[]);
      if (hasOwn(captured, 'count')) {
        if (typeof captured.count !== 'boolean') return bad();
        count = captured.count;
      }
    }
    if (count && command !== 'SELECT') return bad();
    const fields = outputsOf(outputs, count), raw = snapshot(value);
    if (raw.command !== command || raw.rowCount === null || raw.rowCount !== BigInt(raw.rows.length)
      || raw.fields.length !== fields.length || count && raw.rows.length !== 1) return bad();
    fields.forEach((field, i) => {
      const actual = raw.fields[i]!;
      if (actual.name !== field.alias || !(count ? actual.typeOid === 20 : OIDS[field.kind].includes(actual.typeOid))) bad();
    });
    return raw.rows.map(row => {
      const result: Record<string, unknown> = {};
      fields.forEach((field, i) => {
        const cell = scalar(field, raw.fields[i]!.typeOid, row[i]!);
        if (count && (typeof cell !== 'bigint' || cell < 0n || cell > SAFE_MAX)) bad();
        defineProperty(result, field.property, { value: cell, enumerable: true, writable: true, configurable: true });
      });
      return result;
    });
  } catch { return bad(); }
}
