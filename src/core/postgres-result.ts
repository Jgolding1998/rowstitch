/** Internal PostgreSQL wire values and positional decoding. Not a public driver API. */
import { RowstitchError } from './errors.js';
import { decode, encode, identifier, type Kind } from './schema.js';

export interface PostgresRawField { readonly name: string; readonly typeOid: number }
export interface PostgresRawResult {
  readonly fields: readonly PostgresRawField[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly command: string;
  readonly rowCount: bigint | null;
}
export interface PostgresOutputField {
  readonly alias: string;
  readonly property: string;
  readonly kind: Kind;
  readonly nullable: boolean;
}
export interface PostgresBoundValue {
  readonly kind: Kind;
  readonly cast: 'bigint' | 'double precision' | 'text' | 'boolean' | 'jsonb';
  readonly value: string | null;
}

const TYPES = Object.freeze({
  integer: { oid:20, cast:'bigint' }, bigint: { oid:20, cast:'bigint' }, real: { oid:701, cast:'double precision' },
  text: { oid:25, cast:'text' }, boolean: { oid:16, cast:'boolean' }, json: { oid:3802, cast:'jsonb' },
} as const);
const MIN_INT64 = -(2n ** 63n), MAX_INT64 = 2n ** 63n - 1n;
const MAX_ROW_COUNT = 2n ** 64n - 1n;
const MAX_FIELDS = 512, MAX_ROWS = 100_000, MAX_CELLS = 1_000_000;
const snapshots = new WeakSet<object>();
/** Shape identity only. This never acknowledges execution or proves that a value came from an engine. */
export function isPostgresRawResult(value: unknown): value is PostgresRawResult {
  return value !== null && typeof value === 'object' && snapshots.has(value);
}
const bad = (code: 'DATA' | 'VALIDATION'): never => { throw new RowstitchError(code, code === 'DATA'
  ? 'PostgreSQL data did not match its compiled field contract.' : 'The PostgreSQL value is outside its supported type contract.'); };
function kind(value: unknown, code: 'DATA' | 'VALIDATION'): Kind {
  if (typeof value !== 'string' || !Object.hasOwn(TYPES, value)) return bad(code);
  return value as Kind;
}
function config(type: Kind, nullable: boolean) {
  return { kind:type, nullable, primary:false, generated:false, unique:false, hasDefault:false };
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad('DATA');
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return bad('DATA');
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return bad('DATA');
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || ![Array.prototype, null].includes(Object.getPrototypeOf(value))) return bad('DATA');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(descriptors).length !== length + 1) return bad('DATA');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return bad('DATA');
    result.push(descriptor.value);
  }
  return result;
}

/** Makes a stable copy without invoking data accessors. A transport must supply raw text, never parsed JS values. */
export function snapshotPostgresResult(value: unknown): PostgresRawResult {
  if (isPostgresRawResult(value)) return value;
  try {
    const input = record(value, ['fields','rows','command','rowCount']);
    if (typeof input.command !== 'string' || !/^[A-Z]+$/.test(input.command)
        || !(input.rowCount === null || typeof input.rowCount === 'bigint' && input.rowCount >= 0n && input.rowCount <= MAX_ROW_COUNT)) return bad('DATA');
    const fields = list(input.fields, MAX_FIELDS).map(item => {
      const field = record(item, ['name','typeOid']);
      if (typeof field.name !== 'string' || field.name.includes('\0') || /[\uD800-\uDFFF]/u.test(field.name)
          || typeof field.typeOid !== 'number' || !Number.isSafeInteger(field.typeOid) || field.typeOid < 1 || field.typeOid > 0xffff_ffff) return bad('DATA');
      return Object.freeze({ name:field.name, typeOid:field.typeOid });
    });
    const inputRows = list(input.rows, MAX_ROWS);
    if (inputRows.length * fields.length > MAX_CELLS) return bad('DATA');
    const rows = inputRows.map(item => {
      const row = list(item, fields.length);
      if (row.length !== fields.length) return bad('DATA');
      return Object.freeze(row.map(cell => {
        if (cell !== null && typeof cell !== 'string') return bad('DATA');
        return cell;
      }));
    });
    const result = Object.freeze({ command:input.command, rowCount:input.rowCount, fields:Object.freeze(fields), rows:Object.freeze(rows) });
    snapshots.add(result);
    return result;
  } catch { return bad('DATA'); }
}

function postgresStrings(value: unknown, code: 'DATA' | 'VALIDATION'): void {
  // JSON has already passed the shared finite/depth/node validator before this walk.
  if (typeof value === 'string') {
    if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) bad(code);
  } else if (Array.isArray(value)) {
    for (const child of value) postgresStrings(child, code);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { postgresStrings(key, code); postgresStrings(child, code); }
  }
}

/** Captures a logical scalar before any await. Casts are selected from constants, never caller SQL. */
export function bindPostgresValue(type: Kind, value: unknown, nullable = false): PostgresBoundValue {
  try {
    type = kind(type, 'VALIDATION');
    if (typeof nullable !== 'boolean') return bad('VALIDATION');
    const captured = encode(config(type, nullable), value);
    let text: string | null = null;
    if (captured !== null) {
      if (type === 'boolean') text = captured === 1 ? 'true' : 'false';
      else if (type === 'real' && Object.is(captured, -0)) text = '-0';
      else text = String(captured);
      if (type === 'text') postgresStrings(text, 'VALIDATION');
      if (type === 'json') postgresStrings(JSON.parse(text), 'VALIDATION');
    }
    return Object.freeze({ kind:type, cast:TYPES[type].cast, value:text });
  } catch { return bad('VALIDATION'); }
}

function integer(text: string): bigint {
  if (text.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text)) return bad('DATA');
  const value = BigInt(text);
  if (value < MIN_INT64 || value > MAX_INT64) return bad('DATA');
  return value;
}
function scalar(field: PostgresOutputField, text: string | null): unknown {
  if (text === null) { if (!field.nullable) return bad('DATA'); return null; }
  switch (field.kind) {
    case 'integer': {
      const value = integer(text);
      if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return bad('DATA');
      return Number(value);
    }
    case 'bigint': return integer(text);
    case 'real': {
      if (text.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text)) return bad('DATA');
      const value = Number(text);
      if (!Number.isFinite(value) || value === 0 && /[1-9]/.test(text.split(/[eE]/)[0]!)) return bad('DATA');
      return value;
    }
    case 'boolean': if (text === 't') return true; if (text === 'f') return false; return bad('DATA');
    case 'text': postgresStrings(text, 'DATA'); return text;
    case 'json': { const value = decode(config('json', field.nullable), text); postgresStrings(value, 'DATA'); return value; }
  }
}

/** OIDs and aliases are checked even for an empty result. Duplicate raw names never merge two columns. */
export function decodePostgresRows(value: unknown, outputs: readonly PostgresOutputField[]): Record<string, unknown>[] {
  try {
    const raw = snapshotPostgresResult(value), properties = new Set<string>();
    const fields = list(outputs, MAX_FIELDS).map(item => {
      const field = record(item, ['alias','property','kind','nullable']);
      if (typeof field.alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field.alias)
          || typeof field.property !== 'string' || typeof field.nullable !== 'boolean' || properties.has(field.property)) return bad('DATA');
      identifier(field.property);
      properties.add(field.property);
      return { alias:field.alias, property:field.property, kind:kind(field.kind, 'DATA'), nullable:field.nullable };
    });
    if (raw.fields.length !== fields.length) return bad('DATA');
    fields.forEach((field, i) => { if (raw.fields[i]!.name !== field.alias || raw.fields[i]!.typeOid !== TYPES[field.kind].oid) bad('DATA'); });
    return raw.rows.map(row => {
      const result: Record<string, unknown> = {};
      fields.forEach((field, i) => Object.defineProperty(result, field.property, { value:scalar(field, row[i]!), enumerable:true, writable:true, configurable:true }));
      return result;
    });
  } catch { return bad('DATA'); }
}
