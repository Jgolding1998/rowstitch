import assert from 'node:assert/strict';
import { agg, column, defineTable, eq, openDatabase } from 'rowstitch';

const orders = defineTable('orders', {
  id: column.integer().primaryKey(), category: column.text(), paid: column.boolean(), cents: column.integer(),
});
const db = openDatabase(':memory:', { tables: [orders] });
try {
  db.ensureSchema();
  const repo = db.table(orders);
  repo.insertMany([
    { id: 1, category: 'Books', paid: true, cents: 1250 },
    { id: 2, category: 'Books', paid: true, cents: 800 },
    { id: 3, category: 'Plants', paid: true, cents: 1500 },
    { id: 4, category: 'Plants', paid: false, cents: 300 },
  ]);
  const where = eq(orders.col('paid'), true);
  const totals = repo.aggregate({ where, select: { orders: agg.count(), totalCents: agg.sum(orders.col('cents')) } });
  assert.deepEqual(totals, { orders: 3, totalCents: 3550n });
  const groups = repo.groupBy({ by: ['category'], where,
    select: { orders: agg.count(), totalCents: agg.sum(orders.col('cents')) },
    orderBy: [{ field: 'totalCents', direction: 'desc' }],
  });
  assert.deepEqual(groups, [{ category: 'Books', orders: 2, totalCents: 2050n }, { category: 'Plants', orders: 1, totalCents: 1500n }]);
  console.log('Paid order totals:', totals);
  console.table(groups);
  // Integer sums are always bigint. Convert deliberately when preparing JSON for your application.
  console.log(JSON.stringify(groups.map(row => ({ ...row, totalCents: row.totalCents?.toString() ?? null }))));
} finally { db.close(); }
