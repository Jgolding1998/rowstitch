import assert from 'node:assert/strict';
import { agg, column, defineTable, eq, hasMany, openDatabase } from 'rowstitch';

// Fictional bookshop data: per-customer totals without loading every order line.
const customers = defineTable('customers', { id: column.integer().primaryKey(), name: column.text() });
const orders = defineTable('orders', {
  id: column.integer().primaryKey(), customerId: column.integer().references(customers, 'id'), status: column.text(),
});
const lines = defineTable('order_lines', {
  id: column.integer().primaryKey(), orderId: column.integer().references(orders, 'id'),
  title: column.text(), quantity: column.integer(), cents: column.bigint(),
});
const db = openDatabase(':memory:', { tables: [customers, orders, lines] });
try {
  db.ensureSchema();
  db.table(customers).insertMany([{ id: 1, name: 'Avery' }, { id: 2, name: 'Blake' }, { id: 3, name: 'Casey' }]);
  db.table(orders).insertMany([
    { id: 10, customerId: 1, status: 'open' }, { id: 11, customerId: 1, status: 'shipped' }, { id: 12, customerId: 2, status: 'open' },
  ]);
  db.table(lines).insertMany([
    { id: 1, orderId: 10, title: 'Maps', quantity: 1, cents: 1500n }, { id: 2, orderId: 10, title: 'Atlas', quantity: 3, cents: 4200n },
    { id: 3, orderId: 11, title: 'Tide tables', quantity: 2, cents: 900n },
  ]);
  const allOrders = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId') });
  const openOrders = hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), where: eq(orders.col('status'), 'open') });
  const orderLines = hasMany(lines, { localKey: orders.col('id'), foreignKey: lines.col('orderId') });

  const summary = db.table(customers).findMany({
    select: ['name'],
    aggregates: {
      openOrders: agg.related(openOrders, agg.count()),                                         // 0 when none
      openCents: agg.related(openOrders, agg.related(orderLines, agg.sum(lines.col('cents')))),  // exact bigint, or null
      averageQuantity: agg.related(allOrders, agg.related(orderLines, agg.avg(lines.col('quantity')))), // over all lines
      firstTitle: agg.related(allOrders, agg.related(orderLines, agg.min(lines.col('title')))),
    },
  });
  assert.deepEqual(summary, [
    { name: 'Avery', openOrders: 1, openCents: 5700n, averageQuantity: 2, firstTitle: 'Atlas' },
    { name: 'Blake', openOrders: 1, openCents: null, averageQuantity: null, firstTitle: null },
    { name: 'Casey', openOrders: 0, openCents: null, averageQuantity: null, firstTitle: null },
  ]);

  // Aggregates sit alongside normal includes; the correlation key stays hidden unless selected.
  const avery = db.table(customers).findFirst({
    select: ['name'], where: eq(customers.col('id'), 1),
    include: { orders: hasMany(orders, { localKey: customers.col('id'), foreignKey: orders.col('customerId'), select: ['status'] }) },
    aggregates: { lineCount: agg.related(allOrders, agg.related(orderLines, agg.count())) },
  });
  assert.deepEqual(avery, { name: 'Avery', orders: [{ status: 'open' }, { status: 'shipped' }], lineCount: 3 });

  console.table(summary);
  // Integer sums are always bigint. Convert deliberately when preparing JSON for your application.
  console.log(JSON.stringify(summary.map(row => ({ ...row, openCents: row.openCents?.toString() ?? null }))));
} finally { db.close(); }
