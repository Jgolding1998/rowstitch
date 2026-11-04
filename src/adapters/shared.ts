/** Helpers shared by the optional PostgreSQL adapters. Every failure here is a constant message: no URI, password, path, SQL or value. */
import { readFile } from 'node:fs/promises';
import { RowstitchError } from '../core/errors.js';
import type { AsyncExecutor } from '../core/executor.js';
import type { PostgresRawResult } from '../core/postgres-result.js';
import type { Parameter } from '../core/schema.js';
import { NODE_REQUIREMENT, supportedNode } from '../runtime.js';

export type Status = 'I' | 'T' | 'E';
export const invalidOptions = (): RowstitchError => new RowstitchError('VALIDATION', 'The database adapter options are invalid.');
export const openFailed = (): RowstitchError => new RowstitchError('OPEN', 'The database connection could not be opened.');
export const settingsFailed = (): RowstitchError => new RowstitchError('OPEN', 'The database did not confirm the session settings Rowstitch requires.');
export const openTimedOut = (): RowstitchError => new RowstitchError('DRIVER_TIMEOUT', 'The database connection was not established before its deadline.');

export function requireSupportedRuntime(): void {
  if (!supportedNode(process.versions.node)) throw new RowstitchError('UNSUPPORTED_RUNTIME', 'Rowstitch requires ' + NODE_REQUIREMENT + '.');
}

/** Copies a plain record once, before any await. Accessors are never invoked, and unknown or inherited options are refused. */
export function captureOptions(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw invalidOptions();
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw invalidOptions();
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw invalidOptions();
      if (descriptor.value !== undefined) result[key] = descriptor.value;
    }
  } catch { throw invalidOptions(); }
  return result;
}
export function boundedInteger(value: unknown, fallback: number | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidOptions();
  return value;
}
export function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw invalidOptions();
  return value;
}

/**
 * Resolves an optional peer from the consumer and refuses any version other than the one tested.
 * The adapters depend on protocol details of that exact version, so a different one is not assumed to behave the same.
 */
export async function resolvePeer(name: string, version: string, label: string): Promise<string> {
  const unavailable = (): RowstitchError => new RowstitchError('DRIVER_UNAVAILABLE', 'The optional ' + label + ' client is not installed. Install ' + name + ' ' + version + ' to use this adapter.');
  const mismatch = (): RowstitchError => new RowstitchError('DRIVER_VERSION', 'This adapter was tested with ' + name + ' ' + version + ' only. Install that exact version.');
  let entry: string;
  try { entry = import.meta.resolve(name); } catch { throw unavailable(); }
  let directory = new URL('./', entry);
  for (let depth = 0; depth < 8; depth++) {
    let text: string | undefined;
    try { text = await readFile(new URL('package.json', directory), 'utf8'); } catch { /* Keep walking up. */ }
    if (text !== undefined) {
      let manifest: unknown;
      try { manifest = JSON.parse(text); } catch { throw unavailable(); }
      const found = manifest as { name?: unknown; version?: unknown } | null;
      if (found?.name === name) {
        if (found.version !== version) throw mismatch();
        return entry;
      }
    }
    const parent = new URL('../', directory);
    if (parent.href === directory.href) break;
    directory = parent;
  }
  throw unavailable();
}

/** Both engines receive parameters as text. `-0` needs its own case because String(-0) is '0'. */
export function wireParameters(parameters: readonly Parameter[]): (string | null)[] {
  return parameters.map(value => {
    if (value === null || typeof value === 'string') return value;
    if (typeof value === 'bigint') return value.toString();
    return Object.is(value, -0) ? '-0' : String(value);
  });
}
/** PGlite 0.5.15 reads a field OID as signed int32 and pg 8.23.1 as unsigned. Both are one uint32 on the wire; zero means no type. */
export function uint32Oid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 32 || value === 0) throw new Error('Invalid field OID');
  return value < 0 ? value + 2 ** 32 : value;
}

/**
 * After a client deadline the outcome stays unconfirmed and the connection is abandoned at once, with or without a session
 * on top. The same close promise is shared, so a later close by the session reports the same result. Errors and results keep
 * their identity, which is what carries acknowledged-rejection and result brands.
 */
export function closingOnDeadline(executor: AsyncExecutor<PostgresRawResult>): AsyncExecutor<PostgresRawResult> {
  const watched = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (error instanceof RowstitchError && error.code === 'DRIVER_TIMEOUT') executor.close().catch(() => { /* A later close call reports this. */ });
      throw error;
    }
  };
  return Object.freeze({
    all: (sql: string, parameters: readonly Parameter[]) => watched(() => executor.all(sql, parameters)),
    exec: (sql: string) => watched(() => executor.exec(sql)),
    inTransaction: () => watched(() => executor.inTransaction()),
    close: () => executor.close(),
  });
}

const SETTINGS_SQL = 'SELECT "name", "setting" FROM "pg_catalog"."pg_settings" WHERE "name" OPERATOR("pg_catalog".=) ANY ($1::"pg_catalog"."text"[])';
const MINIMUM_SERVER_VERSION = 120_000;
/** Asks the server what is really in effect, through the real executor. A requested setting is never assumed to have applied. */
export async function confirmSettings(executor: AsyncExecutor<PostgresRawResult>, expected: Readonly<Record<string, string>>): Promise<void> {
  const required: Readonly<Record<string, string>> = { client_encoding: 'UTF8', server_encoding: 'UTF8', extra_float_digits: '3', ...expected };
  const names = [...Object.keys(required), 'server_version_num'];
  const { fields, rows } = await executor.all(SETTINGS_SQL, ['{' + names.join(',') + '}']);
  if (fields.length !== 2 || rows.length !== names.length) throw settingsFailed();
  const actual = new Map(rows.map(row => [row[0], row[1]]));
  if (actual.size !== names.length) throw settingsFailed();
  for (const [name, value] of Object.entries(required)) if (actual.get(name) !== value) throw settingsFailed();
  const version = actual.get('server_version_num');
  // Shortest-precise float text and the INSERT tag this boundary parses both need PostgreSQL 12 or later.
  if (typeof version !== 'string' || !/^[1-9][0-9]{5,7}$/.test(version) || Number(version) < MINIMUM_SERVER_VERSION) throw settingsFailed();
}
