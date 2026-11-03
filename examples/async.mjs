import assert from 'node:assert/strict';
import { agg, column, defineTable, hasMany, openAsyncDatabase } from 'rowstitch';

// Fictional in-memory data. No account, server or API key is required.
const shops = defineTable('example_shops', {
  id: column.integer().primaryKey(), name: column.text(), region: column.text(),
});
const sales = defineTable('example_sales', {
  id: column.integer().primaryKey(), shopId: column.integer().references(shops, 'id'), cents: column.bigint(),
});
const db = await openAsyncDatabase(':memory:', { tables: [shops, sales] });
try {
  await db.ensureSchema();
  await db.transaction(async tx => {
    await tx.table(shops).insertMany([{ id: 1, name: 'Moon garden', region: 'north' }, { id: 2, name: 'Paper kite', region: 'north' }]);
    await tx.table(sales).insertMany([{ id: 1, shopId: 1, cents: 199n }, { id: 2, shopId: 1, cents: 301n }]);
  });
  const related = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId') });
  const regions = await db.table(shops).groupBy({ by: ['region'], select: {
    shops: agg.count(), sales: agg.related(related, agg.count()), cents: agg.related(related, agg.sum(sales.col('cents'))),
  } });
  assert.deepEqual(regions, [{ region: 'north', shops: 2, sales: 2, cents: 500n }]);
  console.log(JSON.stringify(regions, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  const before = await db.table(shops).count();
  await assert.rejects(db.transaction(async tx => {
    await tx.table(shops).insert({ id: 3, name: 'Rollback example', region: 'south' });
    throw new Error('Fictional callback failure');
  }), /Fictional callback failure/);
  assert.equal(await db.table(shops).count(), before);
  const trace = db.exportTrace({ title: 'Fictional async shop example' });
  assert.ok(trace.queries.some(query => query.sql === 'ROLLBACK' && query.status === 'ok'));
  console.log('The failed transaction left the original two shops in place.');
} finally {
  await db.close();
}
