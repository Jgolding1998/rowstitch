/** Internal, dedicated-connection PostgreSQL protocol adapter. Not exported from the SDK. */
import { RowstitchError } from './errors.js';
import { acknowledgedRejection, type AsyncExecutor, type ExecutorRows } from './executor.js';
import { MAX_BOUND_PARAMETERS } from './query-model.js';
import type { Parameter } from './schema.js';

type PostgresRows = Record<string, string | null>[];
/** Engine-specific ownership and error identity belong to the private connection transport. Preserve raw text; no global parsers. */
export interface PostgresTransport {
  query(sql: string, parameters: readonly Parameter[]): Promise<{ rows: PostgresRows; command: string }>;
  transactionStatus(): 'I' | 'T' | 'E';
  /** Return SQLSTATE only for a genuine nonfatal engine ErrorResponse, never a socket, parser or callback error. */
  serverError(error: unknown): string | undefined;
  close(): Promise<void>;
}

function invalid(): RowstitchError { return new RowstitchError('VALIDATION', 'The PostgreSQL executor received an invalid argument.'); }
function unknown(): RowstitchError { return new RowstitchError('DATABASE_ERROR', 'The PostgreSQL operation was not confirmed.'); }
function rawRows(value: unknown): value is PostgresRows {
  if (!Array.isArray(value)) return false;
  return value.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) return false;
    const fields = Object.getOwnPropertyDescriptors(row);
    return Reflect.ownKeys(row).every(name => typeof name === 'string' && 'value' in fields[name]!
      && (fields[name]!.value === null || typeof fields[name]!.value === 'string'));
  });
}
function errorCode(state: string): string {
  if (/^23[0-9A-Z]{3}$/.test(state)) return 'CONSTRAINT';
  if (state === '25006') return 'READ_ONLY';
  if (state === '40001') return 'SERIALIZATION_FAILURE';
  if (state === '40P01') return 'DEADLOCK';
  return 'DATABASE_ERROR';
}
function controlCommand(sql: string): string | undefined {
  if (sql === 'BEGIN READ ONLY' || sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') return 'BEGIN';
  if (sql === 'COMMIT' || sql === 'ROLLBACK') return sql;
  if (/^SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return 'SAVEPOINT';
  if (/^RELEASE SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return 'RELEASE';
  if (/^ROLLBACK TO SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return 'ROLLBACK';
  return undefined;
}

export function createPostgresExecutor(transport: PostgresTransport): AsyncExecutor {
  if (!transport || typeof transport !== 'object') throw invalid();
  const query = transport.query?.bind(transport), status = transport.transactionStatus?.bind(transport);
  const serverError = transport.serverError?.bind(transport), close = transport.close?.bind(transport);
  if (![query, status, serverError, close].every(fn => typeof fn === 'function')) throw invalid();
  let ended: Promise<void> | undefined;
  const request = async (sql: string, parameters: readonly Parameter[]) => {
    if (ended) throw new RowstitchError('CLOSED', 'This PostgreSQL connection is closed.');
    let result: Awaited<ReturnType<PostgresTransport['query']>>;
    try { result = await query(sql, parameters); }
    catch (error) {
      let state: string | undefined;
      try { state = serverError(error); } catch { throw unknown(); }
      if (typeof state === 'string' && /^[0-9A-Z]{5}$/.test(state))
        throw acknowledgedRejection(new RowstitchError(errorCode(state), 'A PostgreSQL engine response rejected this operation.'));
      throw unknown();
    }
    // Validation is outside the ErrorResponse catch: malformed success is not an acknowledged rejection.
    if (!result || !rawRows(result.rows) || typeof result.command !== 'string') throw unknown();
    return result;
  };
  return Object.freeze({
    async all(sql: string, parameters: readonly Parameter[]): Promise<ExecutorRows> {
      if (typeof sql !== 'string' || !sql || sql.includes('\0') || !Array.isArray(parameters) || parameters.length > MAX_BOUND_PARAMETERS) throw invalid();
      const values = Array.from(parameters);
      if (values.some(value => !(value === null || typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value)))) throw invalid();
      return (await request(sql, Object.freeze(values))).rows;
    },
    async exec(sql: string): Promise<void> {
      const expected = typeof sql === 'string' ? controlCommand(sql) : undefined;
      if (expected === undefined) throw invalid();
      const result = await request(sql, []);
      // PostgreSQL COMMIT can acknowledge ROLLBACK when a caught error left the transaction aborted.
      if (sql === 'COMMIT' && result.command === 'ROLLBACK')
        throw acknowledgedRejection(new RowstitchError('TRANSACTION_ABORTED', 'The database rolled back the aborted transaction.'));
      if (result.command !== expected) throw unknown();
    },
    async inTransaction(): Promise<boolean> {
      if (ended) throw unknown();
      let state: unknown;
      try { state = status(); } catch { throw unknown(); }
      if (state !== 'I' && state !== 'T' && state !== 'E') throw unknown();
      return state !== 'I';
    },
    close(): Promise<void> {
      if (!ended) ended = Promise.resolve().then(close);
      return ended;
    },
  });
}
