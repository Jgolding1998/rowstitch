/** Native eager windows normalized to shared mapped storage and an optional private source ordinal. */
import { types } from 'node:util';
import { RowstitchError } from './errors.js';
import { identifier, type Kind } from './schema.js';
import { isPostgresRawResult, snapshotPostgresResult, POSTGRES_MAX_RESULT_CELLS, type PostgresOutputField, type PostgresRawResult } from './postgres-result.js';
import { decodePostgresStorage, POSTGRES_MAX_MAPPED_CELLS } from './postgres-storage.js';
import { POSTGRES_RELATION_LIMITS as LIMITS, type PostgresRelationProfile } from './postgres-relation-profile.js';

const { isProxy } = types;
const { getPrototypeOf, ownKeys, defineProperty } = Reflect;
const { getOwnPropertyDescriptors, hasOwn } = Object;
const KINDS = new Set<Kind>(['integer', 'bigint', 'real', 'text', 'boolean', 'json']);
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
const bad = (): never => { throw new RowstitchError('DATA', 'PostgreSQL eager data did not match its compiled storage contract.'); };
const limited = (): never => { throw new RowstitchError('RESULT_LIMIT', 'The native eager result exceeds its 16 MiB wire-text limit.'); };
const wireBytes = new WeakMap<object, number>();

/** Accounting provenance for one successfully decoded array, never engine acknowledgment or authorization. */
export function postgresRelationWireBytes(value: unknown): number {
  if (value === null || typeof value !== 'object') return bad();
  const bytes = wireBytes.get(value);
  if (bytes === undefined) return bad();
  return bytes;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![null, Object.prototype].includes(getPrototypeOf(value))) return bad();
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
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return bad();
  const prototype = getPrototypeOf(value);
  if (prototype !== null && prototype !== Array.prototype) return bad();
  const descriptors = getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>, length: unknown = descriptors.length?.value;
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
function bounded(value: unknown, maximum: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return bad();
  return value;
}
function wireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_048_576 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) return bad();
  return value;
}
function profileOf(value: unknown): PostgresRelationProfile {
  const profile = record(value, ['outputs', 'partitionBy', 'keys', 'correlateKeys', 'offset', 'limit', 'readLimit']);
  const properties = new Set<string>();
  const outputs = list(profile.outputs, LIMITS.outputs).map((item, i): PostgresOutputField => {
    const output = record(item, ['alias', 'property', 'kind', 'nullable']);
    if (output.alias !== '__rs_pg_' + i || typeof output.property !== 'string' || properties.has(output.property)
      || typeof output.kind !== 'string' || !KINDS.has(output.kind as Kind) || typeof output.nullable !== 'boolean') return bad();
    identifier(output.property); properties.add(output.property);
    return { alias: output.alias as string, property: output.property, kind: output.kind as Kind, nullable: output.nullable };
  });
  if (!outputs.length || typeof profile.partitionBy !== 'string' || typeof profile.correlateKeys !== 'boolean') return bad();
  const partition = outputs.find(output => output.property === profile.partitionBy);
  if (!partition || (profile.correlateKeys ? partition.kind !== 'text' : partition.kind !== 'integer' && partition.kind !== 'bigint')) return bad();
  const keys = list(profile.keys, LIMITS.keys).map(value => {
    if (profile.correlateKeys) return wireKey(value);
    if (typeof value !== 'bigint' || value < INT64_MIN || value > INT64_MAX) return bad();
    return value;
  });
  if (!keys.length) return bad();
  let keyBytes = 0;
  for (const key of keys) {
    const text = typeof key === 'string' ? key : String(key);
    if (text.length > LIMITS.keyBytes - keyBytes) return bad();
    keyBytes += Buffer.byteLength(text, 'utf8'); if (keyBytes > LIMITS.keyBytes) return bad();
  }
  return { outputs, partitionBy: profile.partitionBy, keys, correlateKeys: profile.correlateKeys,
    offset: bounded(profile.offset, LIMITS.offset), limit: bounded(profile.limit, LIMITS.limit), readLimit: bounded(profile.readLimit, LIMITS.readLimit, 1) };
}
function snapshot(value: unknown): PostgresRawResult {
  if (isPostgresRawResult(value)) return snapshotPostgresResult(value);
  const input = record(value, ['fields', 'rows', 'command', 'rowCount']);
  const fields = list(input.fields, 512).map(item => record(item, ['name', 'typeOid']));
  const rows = list(input.rows, 100_000);
  if (rows.length * fields.length > POSTGRES_MAX_RESULT_CELLS) return bad();
  return snapshotPostgresResult({ fields, rows: rows.map(row => list(row, fields.length)), command: input.command, rowCount: input.rowCount });
}
function token(text: string | null, minimum: bigint, maximum: bigint): bigint {
  if (text === null || text.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(text)) return bad();
  const value = BigInt(text); if (value < minimum || value > maximum) return bad(); return value;
}

/** Strict result framing first, ordinary mapped codecs second, correlation/order last. No partial graph can escape. */
export function decodePostgresRelationStorage(value: unknown, compiled: PostgresRelationProfile): Record<string, unknown>[] {
  try {
    const profile = profileOf(compiled), raw = snapshot(value), width = profile.outputs.length;
    const physical = width + 1 + (profile.correlateKeys ? 1 : 0);
    if (raw.command !== 'SELECT' || raw.rowCount !== BigInt(raw.rows.length) || raw.rows.length > profile.readLimit
      || raw.fields.length !== physical || raw.rows.length * raw.fields.length > POSTGRES_MAX_RESULT_CELLS) return bad();
    for (const [i, field] of raw.fields.entries()) if (field.name !== '__rs_pg_' + i || i >= width && field.typeOid !== 20) return bad();
    const fields = raw.fields.slice(0, width);
    // Check original mapped OIDs even for an empty result, before bytes or tokens, using the unchanged scalar policy.
    decodePostgresStorage({ command: 'SELECT', rowCount: 0n, fields, rows: [] }, profile.outputs, 'SELECT');
    let bytes = 0;
    const addText = (text: string): void => {
      if (text.length > LIMITS.bytes - bytes) return limited();
      bytes += Buffer.byteLength(text, 'utf8'); if (bytes > LIMITS.bytes) limited();
    };
    for (const field of raw.fields) addText(field.name);
    for (const row of raw.rows) for (const cell of row) if (cell !== null) addText(cell);
    const first = BigInt(profile.offset) + 1n, last = BigInt(profile.offset + profile.limit);
    const ranks: bigint[] = [], parents: bigint[] = [];
    // Validate every row's raw framing before any mapped conversion, including the last overfetch/sentinel row.
    for (const row of raw.rows) {
      ranks.push(token(row[width]!, first, last));
      if (profile.correlateKeys) parents.push(token(row[width + 1]!, 0n, BigInt(profile.keys.length - 1)));
    }
    const mapped: Record<string, unknown>[] = [], batchRows = Math.floor(POSTGRES_MAX_MAPPED_CELLS / width);
    for (let offset = 0; offset < raw.rows.length; offset += batchRows) {
      const rows = raw.rows.slice(offset, offset + batchRows).map(row => row.slice(0, width));
      const decoded = decodePostgresStorage({ command: 'SELECT', rowCount: BigInt(rows.length), fields, rows }, profile.outputs, 'SELECT');
      for (const row of decoded) mapped.push(row);
    }
    const keys = new Set(profile.keys), groups: bigint[] = [];
    for (let i = 0; i < mapped.length; i++) {
      const partition = mapped[i]![profile.partitionBy];
      // Neither native equality mode can return a NULL partition matched to the non-NULL source keys.
      if (partition === null) return bad();
      if (profile.correlateKeys) { if (typeof partition !== 'string') return bad(); groups.push(parents[i]!); }
      else { if (typeof partition !== 'bigint' || !keys.has(partition)) return bad(); groups.push(partition); }
    }
    for (let i = 0; i < groups.length; i++) {
      if (i === 0 || groups[i] !== groups[i - 1]) {
        if (i > 0 && groups[i]! <= groups[i - 1]! || ranks[i] !== first) return bad();
      } else if (ranks[i] !== ranks[i - 1]! + 1n) return bad();
    }
    if (profile.correlateKeys) for (let i = 0; i < mapped.length; i++)
      defineProperty(mapped[i]!, '__rs_parent', { value: parents[i]!, enumerable: true, writable: true, configurable: true });
    wireBytes.set(mapped, bytes);
    return mapped;
  } catch (error) { if (error instanceof RowstitchError && error.code === 'RESULT_LIMIT') throw error; return bad(); }
}
