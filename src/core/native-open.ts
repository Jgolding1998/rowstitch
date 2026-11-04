/** Internal call-time capture shared by optional native entry points. No connection information enters traces. */
import { captureOptions } from '../adapters/shared.js';
import { fail } from './errors.js';
import { identifier } from './schema.js';
import { captureAsyncDatabaseOptions, type AsyncDatabaseOptions, type CapturedAsyncDatabaseOptions, type AsyncDatabaseRuntime } from './async-database.js';
import { createPostgresDialect } from './postgres-dialect.js';
import { inspectPostgresSchemaWork } from './postgres-schema.js';
import { ensurePostgresSchemaWork, planPostgresSchemaWork } from './postgres-schema-plan.js';
import { isPostgresRawResult } from './postgres-result.js';
import { publicPlans } from './repository-core.js';

export type NativeDatabaseOptions = Pick<AsyncDatabaseOptions,
  'tables' | 'readOnly' | 'maxTraceEntries' | 'traceValues' | 'maxQueue' | 'maxPending' | 'queueTimeoutMs'> & { readonly schema?: string };
const COMMON = Object.freeze(['tables', 'readOnly', 'maxTraceEntries', 'traceValues', 'maxQueue', 'maxPending', 'queueTimeoutMs'] as const);

export interface CapturedNativeOpen {
  readonly database: CapturedAsyncDatabaseOptions;
  readonly driver: Readonly<Record<string, unknown>>;
  readonly runtime: AsyncDatabaseRuntime;
}
export function captureNativeOpen(input: unknown, driverKeys: readonly string[]): CapturedNativeOpen {
  const captured = captureOptions(input, [...COMMON, 'schema', ...driverKeys]);
  const schema = captured.schema === undefined ? 'public' : captured.schema;
  if (typeof schema !== 'string') fail('SCHEMA', 'Choose a supported PostgreSQL namespace.');
  identifier(schema);
  if (/^(?:pg_|information_schema$)/i.test(schema)) fail('SCHEMA', 'Choose a supported PostgreSQL user namespace.');
  const options: Record<string, unknown> = {}, driver: Record<string, unknown> = {};
  for (const key of COMMON) if (Object.hasOwn(captured, key)) options[key] = captured[key];
  for (const key of driverKeys) if (Object.hasOwn(captured, key)) driver[key] = captured[key];
  const database = captureAsyncDatabaseOptions(options as AsyncDatabaseOptions);
  const tables = database.config.tables;
  const runtime: AsyncDatabaseRuntime = Object.freeze({
    dialect: createPostgresDialect({ schema }),
    sessionDialect: 'postgresql',
    isResult: isPostgresRawResult,
    inspectSchema: () => inspectPostgresSchemaWork(schema),
    planSchema: function* () { return publicPlans(yield* planPostgresSchemaWork(tables, schema)); },
    ensureSchema: () => ensurePostgresSchemaWork(tables, schema),
  });
  return Object.freeze({ database, driver: Object.freeze(driver), runtime });
}
