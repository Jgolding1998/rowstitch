/** Optional PostgreSQL entry point. Importing the SQLite SDK does not load its driver. */
import { openPgExecutor, type PgExecutorOptions } from './adapters/pg.js';
import { captureNativeOpen, type NativeDatabaseOptions } from './core/native-open.js';
import { openPreparedAsyncDatabase, type AsyncDatabase } from './core/async-database.js';

/** Choose either a URI or an explicit target. Credentials still receive runtime validation. */
export type PostgresConnectionOptions =
  | { readonly connectionString: string; readonly host?: never; readonly port?: never; readonly user?: never; readonly database?: never }
  | { readonly connectionString?: never; readonly host: string; readonly port?: number; readonly user: string; readonly database: string };
export type PostgresDatabaseOptions = NativeDatabaseOptions
  & Omit<PgExecutorOptions, 'connectionString' | 'host' | 'port' | 'user' | 'database'>
  & PostgresConnectionOptions;
const DRIVER_KEYS = Object.freeze(['connectionString', 'host', 'port', 'user', 'database', 'password', 'ssl', 'applicationName',
  'connectTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs', 'statementTimeoutMs', 'lockTimeoutMs',
  'transactionTimeoutMs', 'idleInTransactionTimeoutMs']);

/** Owns one dedicated connection. Tables and ORM limits are captured before any driver loading or connection await. */
export async function openPostgresDatabase(options: PostgresDatabaseOptions): Promise<AsyncDatabase> {
  const captured = captureNativeOpen(options, DRIVER_KEYS);
  const executor = await openPgExecutor(captured.driver as PgExecutorOptions);
  return openPreparedAsyncDatabase(executor, captured.database, captured.runtime);
}
