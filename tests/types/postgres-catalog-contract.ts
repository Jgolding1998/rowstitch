// The private catalog readers. Not an SDK surface and not a claim of PostgreSQL support.
import type { AsyncSession, AsyncTransaction } from '../../src/core/async-session.js';
import { readPostgresPhysical, readPostgresSettings } from '../../src/core/postgres-catalog.js';
import type { PostgresPhysicalSnapshot, PostgresSettings } from '../../src/core/postgres-physical.js';
import type { PostgresRawResult } from '../../src/core/postgres-result.js';
import { column, defineTable } from '../../src/core/schema.js';

const table = defineTable('catalog_contract', { id: column.integer().primaryKey() });
declare const session: AsyncSession<PostgresRawResult>;
declare const tx: AsyncTransaction<PostgresRawResult>;
declare const defaultSession: AsyncSession;

export async function positive(): Promise<void> {
  const physical: PostgresPhysicalSnapshot | null = await readPostgresPhysical(session, table);
  const named: PostgresPhysicalSnapshot | null = await readPostgresPhysical(tx, table, 'demo_space', { signal: new AbortController().signal });
  const settings: PostgresSettings = await readPostgresSettings(session);
  const inTransaction: PostgresSettings = await readPostgresSettings(tx, { signal: new AbortController().signal });
  const owner = { all: session.all };
  const narrow: PostgresSettings = await readPostgresSettings(owner);
  const keyEntry: string | null | undefined = physical?.indexes[0]?.keyColumns[0];
  void [named, inTransaction, narrow, keyEntry, settings.searchPath];
}

export async function negative(): Promise<void> {
  // @ts-expect-error A default row session cannot read raw catalog results.
  await readPostgresPhysical(defaultSession, table);
  // @ts-expect-error
  await readPostgresSettings(defaultSession);
  // @ts-expect-error The target is a mapped table, never caller SQL or a name.
  await readPostgresPhysical(session, 'catalog_contract');
  // @ts-expect-error The schema is a name, not an options record.
  await readPostgresPhysical(session, table, { signal: new AbortController().signal });
  // @ts-expect-error Settings names are fixed: a caller cannot choose one.
  await readPostgresSettings(session, 'search_path');
  // @ts-expect-error Unknown options are refused.
  await readPostgresSettings(session, { retries: 1 });
  const physical = await readPostgresPhysical(session, table);
  // @ts-expect-error No match is null.
  const required: PostgresPhysicalSnapshot = physical;
  // @ts-expect-error An expression index entry has a null name.
  const entry: string | undefined = physical?.indexes[0]?.keyColumns[0];
  // @ts-expect-error Snapshots are immutable.
  if (physical) physical.columns = [];
  void [required, entry];
}
