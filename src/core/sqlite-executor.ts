import { DatabaseSync } from 'node:sqlite';
import { NODE_REQUIREMENT, supportedNode } from '../runtime.js';
import { fail } from './errors.js';
import { plainRecord } from './schema.js';
import type { SyncExecutor } from './executor.js';

/** Private connection factory shared by the synchronous ORM and driver conformance tests. */
export function openSqliteExecutor(filename = ':memory:', options: { readOnly?: boolean; busyTimeoutMs?: number } = {}): SyncExecutor {
  if (!supportedNode(process.versions.node)) fail('UNSUPPORTED_RUNTIME', 'Rowstitch requires ' + NODE_REQUIREMENT + '.');
  if (typeof filename !== 'string' || !filename.length || filename.includes('\0')) fail('VALIDATION', 'Choose a local SQLite filename or :memory:.');
  plainRecord(options);
  if (Object.keys(options).some(key => key !== 'readOnly' && key !== 'busyTimeoutMs')) fail('QUERY', 'A connection option is not supported. Check the option names.');
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') fail('VALIDATION', 'readOnly must be a boolean when supplied.');
  const timeout = options.busyTimeoutMs === undefined ? 1000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 10_000) fail('QUERY', 'A numeric option is outside its documented integer range.');
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(filename, { readOnly: options.readOnly === true, timeout,
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
    handle.enableDefensive(true);
    handle.exec('PRAGMA trusted_schema = OFF');
    if (handle.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Foreign keys unavailable');
  } catch {
    try { handle?.close(); } catch { /* Do not leak an incompletely initialized connection. */ }
    return fail('OPEN', 'The local SQLite database could not be opened with the required safety settings.');
  }
  const connection = handle;
  return Object.freeze({
    all(sql: string, parameters: Parameters<SyncExecutor['all']>[1]) {
      if (!Array.isArray(parameters)) fail('VALIDATION', 'Executor parameters must be a list of scalar bound values.');
      const values = Array.from(parameters);
      if (values.some(value => !(value === null || typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value))))
        fail('VALIDATION', 'Executor parameters must be a list of scalar bound values.');
      const statement = connection.prepare(sql);
      statement.setReadBigInts(true);
      return statement.all(...values);
    },
    exec(sql: string) { connection.exec(sql); },
    inTransaction() { return connection.isTransaction; },
    close() { connection.close(); },
  });
}
