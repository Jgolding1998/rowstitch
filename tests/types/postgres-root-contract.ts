// Private root compiler/execution contracts. The public SDK does not export these factories.
import { column, defineTable } from '../../src/core/schema.js';
import type { AsyncSession } from '../../src/core/async-session.js';
import type { PostgresRawResult } from '../../src/core/postgres-result.js';
import { compilePostgresRoot, planPostgresByKey, planPostgresCount, planPostgresInsert } from '../../src/core/postgres-root-plan.js';
import { executePostgresRoot, type PostgresRootValue } from '../../src/core/postgres-root-execution.js';

declare const raw: AsyncSession<PostgresRawResult>;
declare const sqlite: AsyncSession;
const table = defineTable('type_root_samples', { id: column.integer().primaryKey(), name: column.text() });
const insert = compilePostgresRoot(planPostgresInsert(table, { id: 1, name: 'fictional' }));
const select = compilePostgresRoot(planPostgresByKey(table, { id: 1 }));
const count = compilePostgresRoot(planPostgresCount(table));
export async function positive(): Promise<void> {
  const value: PostgresRootValue = await executePostgresRoot(raw, insert);
  const nested: PostgresRootValue = await raw.transaction(tx => executePostgresRoot(tx, select));
  const counted: PostgresRootValue = await executePostgresRoot(raw, count, { signal: new AbortController().signal });
  const parameters: readonly (string | null)[] = insert.parameters;
  void [value, nested, counted, parameters];
}
export async function negative(): Promise<void> {
  // @ts-expect-error The named SQLite result session is not a positional PostgreSQL owner.
  executePostgresRoot(sqlite, insert);
  // @ts-expect-error SQL strings are not logical plans.
  compilePostgresRoot('SELECT * FROM private_rows');
  // @ts-expect-error Tables require genuine mapped-table structure (also runtime-branded).
  planPostgresCount({ name: 'fake', columns: {} });
  // @ts-expect-error Only strings and null are driver parameters.
  const values: readonly number[] = insert.parameters;
  // @ts-expect-error Compiled parameters are immutable.
  insert.parameters.push('changed');
  // @ts-expect-error Output metadata is immutable.
  insert.outputs[0]!.alias = 'changed';
  // @ts-expect-error No execution hook or raw SQL option is supported.
  executePostgresRoot(raw, insert, { sql: 'DROP TABLE private_rows' });
  // @ts-expect-error Internal root values are not assumed to be a custom application shape.
  const row: { id: number; name: string } = await executePostgresRoot(raw, select);
  void [values, row];
}
