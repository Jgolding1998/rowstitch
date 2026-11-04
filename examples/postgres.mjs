import assert from 'node:assert/strict';
import { asc, column, defineTable, eq } from 'rowstitch';
import { openPostgresDatabase } from 'rowstitch/postgres';

// Fictional data. Needs a PostgreSQL server you control and the optional peer: npm install --save-exact pg@8.23.1
// This creates a table and writes to it, so point it at a disposable database, never at real data.
// It deletes the row it adds, but the table stays, and a run that fails partway can leave a row behind.
// The library itself never reads this variable or any other environment value. Only this example does.
const url = process.env.ROWSTITCH_EXAMPLE_POSTGRES_URL;
if (!url) {
  console.log('Set ROWSTITCH_EXAMPLE_POSTGRES_URL to a disposable database to run this example.');
  console.log('Remote server: postgres://app_user:password@db.example.test:5432/scratch?sslmode=verify-full');
  process.exit(0);
}

// Without sslmode=verify-full or an ssl option, the connection is not encrypted. Only allow that on this machine.
let parsed;
try {
  parsed = new URL(url);
} catch {
  // The parser's error repeats the whole value, including any password, so it is never printed or rethrown.
  console.log('ROWSTITCH_EXAMPLE_POSTGRES_URL is not a valid URL. Expected: postgres://user:password@host:5432/database?sslmode=verify-full');
  process.exit(1);
}
const mode = parsed.searchParams.get('sslmode');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
if (mode !== 'verify-full' && !(local && mode === 'disable')) {
  console.log('Use sslmode=verify-full. sslmode=disable is only accepted here for a trusted server on this machine.');
  process.exit(1);
}

const tickets = defineTable('example_tickets', {
  id: column.integer().primaryKey({ generated: true }),
  title: column.text(),
  open: column.boolean().default(true),
  version: column.integer().default(1),
}, { version: 'version' });

// One dedicated connection, not a pool. Connection errors are constant and never include the URL or password.
const db = await openPostgresDatabase({ connectionString: url, tables: [tickets], applicationName: 'rowstitch-example' });
try {
  // Creates the missing table. An existing table is checked and never altered; a mismatch raises SCHEMA_DRIFT.
  console.log(await db.planSchema());
  await db.ensureSchema();
  const rows = db.table(tickets);

  const created = await rows.insert({ title: 'Water the moon garden' });
  await rows.updateVersion({ id: created.id }, 1, { title: 'Water the garden twice' });
  await assert.rejects(rows.updateVersion({ id: created.id }, 1, { title: 'Stale edit' }), error => error.code === 'CONFLICT');

  await assert.rejects(db.transaction(async tx => {
    await tx.table(tickets).insert({ title: 'Rolled back' });
    throw new Error('Fictional callback failure');
  }), /Fictional callback failure/);

  console.log(await rows.findMany({ where: eq(tickets.col('id'), created.id), select: ['id', 'title', 'version'], orderBy: [asc(tickets.col('id'))] }));

  await rows.delete({ where: eq(tickets.col('id'), created.id), maxRows: 1 });
  console.log(db.exportTrace({ title: 'Fictional PostgreSQL example' }).queries.length + ' statements traced');
} finally {
  await db.close();
}
