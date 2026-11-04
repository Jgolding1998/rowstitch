/** Optional embedded PostgreSQL entry point using a worker-owned in-memory PGlite instance. */
import { openPgliteExecutor, type PgliteExecutorOptions } from './adapters/pglite.js';
import { captureNativeOpen, type NativeDatabaseOptions } from './core/native-open.js';
import { openPreparedAsyncDatabase, type AsyncDatabase } from './core/async-database.js';

export type PgliteDatabaseOptions = NativeDatabaseOptions & PgliteExecutorOptions;
const DRIVER_KEYS = Object.freeze(['openTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs']);

/** Nothing persists after closing this in-memory database. Use mapped ensureSchema() before its first insert. */
export async function openPgliteDatabase(options: PgliteDatabaseOptions = {}): Promise<AsyncDatabase> {
  const captured = captureNativeOpen(options, DRIVER_KEYS);
  const executor = await openPgliteExecutor(captured.driver as PgliteExecutorOptions);
  return openPreparedAsyncDatabase(executor, captured.database, captured.runtime);
}
