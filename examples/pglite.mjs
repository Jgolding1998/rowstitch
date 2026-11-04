import assert from 'node:assert/strict';
import { agg, asc, column, defineTable, eq } from 'rowstitch';
import { openPgliteDatabase } from 'rowstitch/pglite';

// Fictional, in-memory data. Needs the optional peer: npm install --save-exact @electric-sql/pglite@0.5.15
// Nothing here touches a server or a file. Everything is lost when the database closes.
const tickets = defineTable('example_tickets', {
  id: column.integer().primaryKey({ generated: true }),
  title: column.text(),
  open: column.boolean().default(true),
  version: column.integer().default(1),
}, { version: 'version' });

let db;
try {
  db = await openPgliteDatabase({ tables: [tickets] });
} catch (error) {
  if (error?.code !== 'DRIVER_UNAVAILABLE' && error?.code !== 'DRIVER_VERSION') throw error;
  console.log(error.message);
  process.exit(1);
}
try {
  // Creates the missing table. It never alters a table that already exists.
  await db.ensureSchema();
  const rows = db.table(tickets);

  const first = await rows.insert({ title: 'Water the moon garden' });
  await rows.insert({ title: 'Paint the paper kite' });
  assert.equal(await rows.count(eq(tickets.col('open'), true)), 2);

  // A version check stops a stale edit from overwriting a newer one.
  await rows.updateVersion({ id: first.id }, 1, { title: 'Water the garden twice' });
  await assert.rejects(rows.updateVersion({ id: first.id }, 1, { title: 'Stale edit' }), error => error.code === 'CONFLICT');

  // A write needs a filter and a limit, and a failed transaction keeps nothing.
  await rows.update({ open: false }, { where: eq(tickets.col('id'), first.id), maxRows: 1 });
  await assert.rejects(db.transaction(async tx => {
    await tx.table(tickets).insert({ title: 'Rolled back' });
    throw new Error('Fictional callback failure');
  }), /Fictional callback failure/);

  console.log(await rows.findMany({ select: ['id', 'title', 'open'], orderBy: [asc(tickets.col('id'))] }));

  // Features the PostgreSQL path does not have yet refuse clearly instead of guessing.
  await assert.rejects(rows.aggregate({ select: { total: agg.count() } }), error => error.code === 'QUERY');

  // The trace names its database and redacts bound values. Open the saved JSON in Rowstitch Studio.
  const trace = db.exportTrace({ title: 'Fictional PGlite example' });
  assert.equal(trace.dialect, 'postgresql');
  console.log(trace.queries.length + ' statements traced');
} finally {
  await db.close();
}

// Proof that nothing was kept: a new database starts empty.
const again = await openPgliteDatabase({ tables: [tickets] });
try {
  await again.ensureSchema();
  assert.equal(await again.table(tickets).count(), 0);
} finally {
  await again.close();
}
