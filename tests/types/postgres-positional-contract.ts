// The private PostgreSQL executor and transport, in positional raw form. Not an SDK surface and not a claim of PostgreSQL support.
import { createAsyncSession, type AsyncSession } from '../../src/core/async-session.js';
import type { AsyncExecutor, ExecutorRows } from '../../src/core/executor.js';
import { createPostgresExecutor, type PostgresErrorVerdict, type PostgresTransport, type PostgresTransportResult } from '../../src/core/postgres-executor.js';
import { isPostgresRawResult, type PostgresRawField, type PostgresRawResult } from '../../src/core/postgres-result.js';

declare const transport: PostgresTransport;
const executor: AsyncExecutor<PostgresRawResult> = createPostgresExecutor(transport, { requestTimeoutMs: 1000 });
const session: AsyncSession<PostgresRawResult> = createAsyncSession(executor, { dialect: 'postgresql', isResult: isPostgresRawResult });
const response: PostgresTransportResult = { fields: [{ name: 'a', typeOid: 25 }, { name: 'a', typeOid: 20 }], rows: [['x', null]], commandTag: 'SELECT 1' };

export async function positive(): Promise<void> {
  const result: PostgresRawResult = await session.all('SELECT 1');
  const fields: readonly PostgresRawField[] = result.fields;
  const cell: string | null = result.rows[0]![0]!;
  const count: bigint | null = result.rowCount;
  const verb: string = result.command;
  const nested: PostgresRawResult = await session.transaction(tx => tx.transaction(child => child.all('SELECT 1')));
  const verdict: PostgresErrorVerdict | undefined = transport.serverError(new Error('fictional'));
  void [fields, cell, count, verb, nested, response, verdict];
}

export async function negative(): Promise<void> {
  // @ts-expect-error A raw executor cannot be used as a default row executor.
  const asDefault: AsyncExecutor = executor;
  // @ts-expect-error A generic session must be given the raw guard.
  createAsyncSession(executor, { dialect: 'postgresql' });
  // @ts-expect-error
  createAsyncSession(executor);
  const result = await session.all('SELECT 1');
  // @ts-expect-error Rows are positional, not named.
  result.rows[0]!.a;
  // @ts-expect-error A raw result is not a row array.
  const rows: ExecutorRows = result;
  // @ts-expect-error The count is exact: never a Number.
  const rounded: number | null = result.rowCount;
  // @ts-expect-error Results are immutable.
  result.rows[0]![0] = 'changed';
  // @ts-expect-error Field metadata is required.
  const noOid: PostgresRawField = { name: 'a' };
  // @ts-expect-error A transport gives the exact tag, not parsed values.
  const parsed: PostgresTransportResult = { fields: [], rows: [], command: 'SELECT', rowCount: 0n };
  // @ts-expect-error Cells are raw text or NULL, never parsed values.
  const typed: PostgresTransportResult = { fields: [], rows: [[1]], commandTag: 'SELECT 1' };
  // @ts-expect-error The old named-row transport no longer fits.
  const oldTransport: PostgresTransport = { ...transport, async query() { return { rows: [{ a: '1' }], command: 'SELECT' }; } };
  // @ts-expect-error The old bare SQLSTATE no longer fits.
  const bareState: PostgresTransport = { ...transport, serverError() { return '23505'; } };
  // @ts-expect-error The tag observation is required.
  const noObservation: PostgresErrorVerdict = { sqlstate: '23505' };
  // @ts-expect-error The tag observation is a boolean.
  const looseObservation: PostgresErrorVerdict = { sqlstate: '23505', afterCommandComplete: 1 };
  void [asDefault, rows, rounded, noOid, parsed, typed, oldTransport, bareState, noObservation, looseObservation];
}
