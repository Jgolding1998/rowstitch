// Private lifecycle over a non-default result type. Not an SDK surface and not a claim of PostgreSQL support.
import {
  createAsyncSession, trackTransactionPromise,
  type AsyncControlEvent, type AsyncResultGuard, type AsyncSession, type AsyncSessionObserver, type AsyncSessionOptions, type AsyncTransaction,
} from '../../src/core/async-session.js';
import type { AsyncExecutor, ExecutorRows } from '../../src/core/executor.js';

interface RawLike { readonly fields: readonly { readonly name: string; readonly typeOid: number }[]; readonly rows: readonly (readonly (string | null)[])[]; readonly command: string }
interface OtherRaw { readonly other: true }

declare const rawExecutor: AsyncExecutor<RawLike>;
declare const defaultExecutor: AsyncExecutor;
declare const isRaw: AsyncResultGuard<RawLike>;
declare const isOther: AsyncResultGuard<OtherRaw>;
declare const isRows: AsyncResultGuard<ExecutorRows>;

// Positive: the result type reaches root, transaction, child, observer handle and tracked promises.
const observer: AsyncSessionObserver<RawLike> = {
  control(event: AsyncControlEvent<RawLike>) {
    const handle: AsyncTransaction<RawLike> = event.handle;
    const later: Promise<RawLike> = handle.all('SELECT 1');
    void later;
  },
};
const raw: AsyncSession<RawLike> = createAsyncSession(rawExecutor, { isResult: isRaw, dialect: 'postgresql', observer, readOnly: true, maxQueue: 8 });
const inferred = createAsyncSession(rawExecutor, { isResult: isRaw });
const sameType: AsyncSession<RawLike> = inferred;

export async function positive(): Promise<void> {
  const root: RawLike = await raw.all('SELECT 1', ['x', 1, 2n, null], { signal: new AbortController().signal });
  const command: string = root.command;
  const oid: number = root.fields[0]!.typeOid;
  const nested: readonly [number, string] = await raw.transaction(async tx => {
    const inTx: RawLike = await tx.all('SELECT 2');
    const tracked: RawLike = await trackTransactionPromise(tx, tx.all('SELECT 3'));
    const count: number = await tx.transaction(async child => {
      const handle: AsyncTransaction<RawLike> = child;
      const inChild: RawLike = await handle.all('SELECT 4');
      return inChild.rows.length;
    });
    return [count + tracked.rows.length, inTx.command] as const;
  });
  const fromThenable: number = await raw.transaction(() => Promise.resolve(1));
  const closed: void = await raw.close();
  void [command, oid, nested, fromThenable, closed, sameType];
}

// Positive: the default stays the row array, written or inferred, with or without a guard.
const plain = createAsyncSession(defaultExecutor);
const plainExplicit: AsyncSession = plain;
const plainRows: AsyncSession<ExecutorRows> = plain;
const plainGuarded: AsyncSession = createAsyncSession(defaultExecutor, { isResult: isRows });
const plainOptions: AsyncSessionOptions = { readOnly: true, observer: { control(event) { const handle: AsyncTransaction = event.handle; void handle; } } };
const executorDefault: AsyncExecutor<ExecutorRows> = defaultExecutor;
export async function defaults(): Promise<void> {
  const rows: ExecutorRows = await plain.all('SELECT 1');
  const value: unknown = rows[0]?.anything;
  const inTx: ExecutorRows = await plain.transaction(tx => tx.all('SELECT 1'));
  void [value, inTx, plainExplicit, plainRows, plainGuarded, plainOptions, executorDefault];
}

export async function negative(): Promise<void> {
  // A non-default result cannot be created without its guard: the runtime check would refuse every result.
  // @ts-expect-error
  createAsyncSession(rawExecutor);
  // @ts-expect-error
  createAsyncSession(rawExecutor, {});
  // @ts-expect-error
  createAsyncSession(rawExecutor, { dialect: 'postgresql' });
  // @ts-expect-error The guard must recognize this executor's result.
  createAsyncSession(rawExecutor, { isResult: isOther });
  // @ts-expect-error A guard for another result does not change the default executor's result.
  createAsyncSession(defaultExecutor, { isResult: isRaw });
  // @ts-expect-error A plain boolean function is not a guard.
  createAsyncSession(rawExecutor, { isResult: (value: unknown): boolean => value !== null });
  // An inferred predicate widens the result to what it really checked; it cannot produce a raw-typed session.
  const widened: AsyncSession<{} | undefined> = createAsyncSession(rawExecutor, { isResult: (value: unknown) => value !== null });
  // @ts-expect-error
  const widenedAsRaw: AsyncSession<RawLike> = createAsyncSession(rawExecutor, { isResult: (value: unknown) => value !== null });
  void [widened, widenedAsRaw];
  // @ts-expect-error Unknown options stay refused.
  createAsyncSession(rawExecutor, { isResult: isRaw, retries: 3 });
  // @ts-expect-error An observer for the default result cannot observe raw handles.
  createAsyncSession(rawExecutor, { isResult: isRaw, observer: {} as AsyncSessionObserver });
  // @ts-expect-error A raw observer cannot be given to a default session.
  createAsyncSession(defaultExecutor, { observer });

  // @ts-expect-error A raw session is not a default session, in either direction.
  const toDefault: AsyncSession = raw;
  // @ts-expect-error
  const toRaw: AsyncSession<RawLike> = plain;
  // @ts-expect-error
  const executorToDefault: AsyncExecutor = rawExecutor;
  // @ts-expect-error
  const executorToRaw: AsyncExecutor<RawLike> = defaultExecutor;
  // @ts-expect-error A raw handle is not a default handle.
  await raw.transaction(tx => { const handle: AsyncTransaction = tx; return handle; });

  // @ts-expect-error Raw results are not row arrays.
  const rawAsRows: ExecutorRows = await raw.all('SELECT 1');
  // @ts-expect-error Default rows have no raw metadata.
  const rowsAsRaw: RawLike = await plain.all('SELECT 1');
  // @ts-expect-error
  (await plain.all('SELECT 1')).fields;
  // @ts-expect-error
  (await raw.all('SELECT 1')).length;
  await raw.transaction(async tx => {
    // @ts-expect-error The transaction and child handles keep the type too.
    const rows: ExecutorRows = await tx.all('SELECT 1');
    await tx.transaction(async child => {
      // @ts-expect-error
      const childRows: ExecutorRows = await child.all('SELECT 1');
      void childRows;
    });
    void rows;
  });
  const wrongHandle: AsyncSessionObserver<RawLike> = {
    // @ts-expect-error The observer's event keeps the result type.
    control(event: AsyncControlEvent) { void event; },
  };
  const observedDefault: AsyncSessionObserver = {
    control(event) {
      // @ts-expect-error A default observer's handle resolves default rows.
      const later: Promise<RawLike> = event.handle.all('SELECT 1');
      void later;
    },
  };
  // @ts-expect-error A raw handle tracked for its own promise keeps both types separate.
  const trackedWrong: Promise<string> = trackTransactionPromise(raw, Promise.resolve(1));
  // @ts-expect-error The guard is not a session member.
  raw.isResult;
  void [toDefault, toRaw, executorToDefault, executorToRaw, rawAsRows, rowsAsRaw, wrongHandle, observedDefault, trackedWrong];
}
