/** Internal execution of authenticated root plans through the existing transaction lifecycle. */
import { RowstitchError } from './errors.js';
import { trackTransactionPromise, type AsyncOperationOptions, type AsyncTransaction } from './async-session.js';
import { decodePostgresRoot, isCompiledPostgresRoot, type CompiledPostgresRoot } from './postgres-root-plan.js';
import type { PostgresRawResult } from './postgres-result.js';

export type PostgresRootValue = Record<string, unknown> | number | null;

/** Every write decodes inside its atomic scope. No automatic retry or inference about an uncertain COMMIT. */
export function executePostgresRoot(owner: AsyncTransaction<PostgresRawResult>, compiled: CompiledPostgresRoot, options?: AsyncOperationOptions): Promise<PostgresRootValue> {
  let work: Promise<PostgresRootValue>;
  try {
    if (!isCompiledPostgresRoot(compiled)) throw new RowstitchError('QUERY', 'Execute a genuine compiled PostgreSQL root statement.');
    const decode = async (handle: AsyncTransaction<PostgresRawResult>): Promise<PostgresRootValue> =>
      decodePostgresRoot(compiled, await handle.all(compiled.sql, compiled.parameters, options));
    work = compiled.operation === 'insert' ? owner.transaction(decode, options) : decode(owner);
  } catch (error) { work = Promise.reject(error); }
  return trackTransactionPromise(owner, work);
}
