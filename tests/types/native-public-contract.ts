import { column, defineTable } from '../../dist/index.js';
import { openPostgresDatabase, type PostgresDatabaseOptions } from '../../dist/postgres.js';
import { openPgliteDatabase, type PgliteDatabaseOptions } from '../../dist/pglite.js';

const entries = defineTable('native_entries', { id: column.integer().primaryKey(), title: column.text(), count: column.bigint() });
const direct: PostgresDatabaseOptions = { host: 'localhost', user: 'example', database: 'example', ssl: true, tables: [entries] };
const uri: PostgresDatabaseOptions = { connectionString: 'postgres://example@localhost/example', ssl: { ca: 'example certificate', cert: 'example certificate', key: 'example key' } };
const memory: PgliteDatabaseOptions = { tables: [entries], schema: 'public', openTimeoutMs: 30_000 };
void [direct, uri, memory];

async function nativeContracts() {
  const pg = await openPostgresDatabase(direct);
  const embedded = await openPgliteDatabase(memory);
  const row = await pg.table(entries).insert({ id: 1, title: 'Example', count: 1n });
  const id: number = row.id;
  const count: bigint = row.count;
  const projected = await embedded.table(entries).findMany({ select: ['title'] });
  const title: string | undefined = projected[0]?.title;
  void [id, count, title];
  // @ts-expect-error PostgreSQL needs an explicit connection target
  openPostgresDatabase({});
  // @ts-expect-error direct connections require a database
  openPostgresDatabase({ host: 'localhost', user: 'example' });
  // @ts-expect-error direct connections require a user
  openPostgresDatabase({ host: 'localhost', database: 'example' });
  // @ts-expect-error URI and direct fields cannot be mixed
  openPostgresDatabase({ connectionString: 'postgres://example@localhost/example', host: 'localhost' });
  // @ts-expect-error a URI supplies its own port
  openPostgresDatabase({ connectionString: 'postgres://example@localhost/example', port: 5432 });
  // @ts-expect-error the native database has no arbitrary SQL method
  pg.all('SELECT 1');
  // @ts-expect-error the executor is not part of the public database
  pg.executor;
  // @ts-expect-error disabling certificate verification is not an option
  openPostgresDatabase({ ...direct, ssl: { rejectUnauthorized: false } });
  // @ts-expect-error native target ports are numbers
  openPostgresDatabase({ ...direct, port: '5432' });
  // @ts-expect-error native adapter timeouts are numbers
  openPostgresDatabase({ ...direct, requestTimeoutMs: '1000' });
  // @ts-expect-error PGlite currently does not offer persistent files
  openPgliteDatabase({ dataDir: 'example.db' });
  // @ts-expect-error PGlite does not take a network connection
  openPgliteDatabase({ host: 'localhost' });
  // @ts-expect-error PGlite does not take PostgreSQL connection URIs
  openPgliteDatabase({ connectionString: 'postgres://example@localhost/example' });
  // @ts-expect-error file paths are not native ORM options
  openPgliteDatabase({ path: 'example.db' });
  // @ts-expect-error the public API preserves bigint field types
  await pg.table(entries).insert({ id: 2, title: 'Example', count: 2 });
  // @ts-expect-error a projection cannot return unselected columns
  projected[0]?.count;
  await pg.close();
  await embedded.close();
}
void nativeContracts;
