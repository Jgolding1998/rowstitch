// Internal async session contract. These modules are not exported from the SDK; the fixture imports them directly.
import { createAsyncSession, type AsyncSession, type AsyncTransaction } from '../../src/core/async-session.js';
import { inlineAsyncExecutor, type AsyncExecutor, type ExecutorRows, type SyncExecutor } from '../../src/core/executor.js';

declare const sync: SyncExecutor;
declare const executor: AsyncExecutor;
const session: AsyncSession = createAsyncSession(inlineAsyncExecutor(sync), { readOnly: true, maxQueue: 8, maxPending: 8, queueTimeoutMs: 100 });

export async function contract(): Promise<void> {
  // ---- Positive
  const rows: ExecutorRows = await session.all('SELECT ? AS a, ? AS b, ? AS c, ? AS d', [1, 2n, 'x', null], { signal: new AbortController().signal });
  const none: ExecutorRows = await session.all('SELECT 1');
  const count: number = await session.transaction(async tx => (await tx.all('SELECT 1')).length);
  const fromThenable: string = await session.transaction(() => Promise.resolve('value'));
  const plain: boolean = await session.transaction(() => true);
  const nested: bigint = await session.transaction(tx => tx.transaction(async inner => { await inner.all('SELECT 1'); return 1n; }));
  const closed: void = await session.close();
  void [rows, none, count, fromThenable, plain, nested, closed, createAsyncSession(executor)];

  // ---- Negative: results keep their callback types
  // @ts-expect-error A transaction returning a number does not produce a string.
  const wrong: string = await session.transaction(async () => 1);
  // @ts-expect-error Rows are records, not a scalar.
  const scalar: number = await session.all('SELECT 1');

  // ---- Negative: handles and capabilities
  // @ts-expect-error A transaction handle cannot close the session.
  await session.transaction(tx => tx.close());
  // @ts-expect-error A transaction handle is not a session.
  await session.transaction(tx => { const escaped: AsyncSession = tx; return escaped; });
  const handle: AsyncTransaction = session;
  void handle;

  // ---- Negative: bound values and options
  // @ts-expect-error undefined is not a bound SQLite value.
  await session.all('SELECT ?', [undefined]);
  // @ts-expect-error Objects are not bound values.
  await session.all('SELECT ?', [{ id: 1 }]);
  // @ts-expect-error Parameters are an array, not a single value.
  await session.all('SELECT ?', 1);
  // @ts-expect-error The signal must be an AbortSignal.
  await session.all('SELECT 1', [], { signal: {} });
  // @ts-expect-error Unknown operation options are rejected.
  await session.transaction(async () => 1, { timeout: 5 });
  // @ts-expect-error readOnly is a boolean option.
  createAsyncSession(executor, { readOnly: 'yes' });
  // @ts-expect-error Unknown session options are rejected.
  createAsyncSession(executor, { retries: 3 });
  // @ts-expect-error A synchronous executor must be adapted explicitly.
  createAsyncSession(sync);
  // @ts-expect-error The callback receives a transaction handle, not raw SQL.
  await session.transaction('SELECT 1');
}
