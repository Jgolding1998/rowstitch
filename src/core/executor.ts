/** Internal connection boundary. It is not an SDK raw-SQL or driver extension API. */
import { RowstitchError, databaseError } from './errors.js';
import type { Parameter } from './schema.js';

export type ExecutorRows = Record<string, unknown>[];

export interface SyncExecutor {
  all(sql: string, parameters: readonly Parameter[]): ExecutorRows;
  exec(sql: string): void;
  inTransaction(): boolean;
  close(): void;
}

/** A rejected promise alone never proves that a remote statement did not run. */
export interface AsyncExecutor {
  all(sql: string, parameters: readonly Parameter[]): Promise<ExecutorRows>;
  exec(sql: string): Promise<void>;
  inTransaction(): Promise<boolean>;
  close(): Promise<void>;
}

const rejected = new WeakSet<object>();
const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  BUSY: 'The database is busy. No callback was automatically retried.',
  CONSTRAINT: 'A database constraint rejected this change.',
  READ_ONLY: 'This database is read-only.',
  DATABASE_ERROR: 'The database could not complete this operation.',
  TRANSACTION_ABORTED: 'The database rolled back the aborted transaction.',
  SERIALIZATION_FAILURE: 'A concurrent transaction prevented serialization. No callback was automatically retried.',
  DEADLOCK: 'The database detected a deadlock. No callback was automatically retried.',
});

/** An engine response proves acknowledgment, not absence of effects from earlier statements in a batch. Never use for transport loss. */
export function acknowledgedRejection(error: unknown): RowstitchError {
  let code = 'DATABASE_ERROR';
  try {
    const mappedCode = databaseError(error).code;
    if (Object.hasOwn(SAFE_MESSAGES, mappedCode)) code = mappedCode;
  } catch { /* Even malformed driver error objects cannot leak their own messages. */ }
  const safe = new RowstitchError(code, SAFE_MESSAGES[code]!);
  rejected.add(safe);
  return Object.freeze(safe);
}

export function isAcknowledgedRejection(error: unknown): error is RowstitchError {
  return typeof error === 'object' && error !== null && rejected.has(error);
}

/** Conformance adapter only: its SQLite work still runs synchronously on the calling thread. */
export function inlineAsyncExecutor(executor: SyncExecutor): AsyncExecutor {
  return Object.freeze({
    async all(sql: string, parameters: readonly Parameter[]): Promise<ExecutorRows> {
      try { return executor.all(sql, parameters); } catch (error) { throw acknowledgedRejection(error); }
    },
    async exec(sql: string): Promise<void> {
      try { executor.exec(sql); } catch (error) { throw acknowledgedRejection(error); }
    },
    async inTransaction(): Promise<boolean> {
      try { return executor.inTransaction(); } catch { throw new RowstitchError('DATABASE_ERROR', SAFE_MESSAGES.DATABASE_ERROR!); }
    },
    async close(): Promise<void> {
      try { executor.close(); } catch { throw new RowstitchError('DATABASE_ERROR', SAFE_MESSAGES.DATABASE_ERROR!); }
    },
  });
}
