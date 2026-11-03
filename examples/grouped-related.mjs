import assert from 'node:assert/strict';
import { agg, column, defineTable, eq, hasMany, openDatabase } from 'rowstitch';

// Fictional bookshop branches: totals per region over related sales and returns, without joining them together.
const branches = defineTable('branches', { id: column.integer().primaryKey(), region: column.text(), city: column.text() });
const sales = defineTable('sales', {
  id: column.integer().primaryKey(), branchId: column.integer().references(branches, 'id'),
  cents: column.bigint(), copies: column.integer(), title: column.text(), online: column.boolean(),
});
const returns = defineTable('returns', { id: column.integer().primaryKey(), branchId: column.integer().references(branches, 'id'), cents: column.bigint() });
const db = openDatabase(':memory:', { tables: [branches, sales, returns] });
try {
  db.ensureSchema();
  db.table(branches).insertMany([
    { id: 1, region: 'Coast', city: 'Harbor' }, { id: 2, region: 'Coast', city: 'Dune' }, { id: 3, region: 'Hills', city: 'Ridge' },
  ]);
  db.table(sales).insertMany([
    { id: 1, branchId: 1, cents: 1500n, copies: 1, title: 'Maps', online: false },
    { id: 2, branchId: 1, cents: 4200n, copies: 3, title: 'Atlas', online: true },
    { id: 3, branchId: 2, cents: 900n, copies: 2, title: 'Tides', online: false },
  ]);
  db.table(returns).insertMany([{ id: 1, branchId: 1, cents: 300n }, { id: 2, branchId: 1, cents: 200n }]);
  const branchSales = hasMany(sales, { localKey: branches.col('id'), foreignKey: sales.col('branchId') });
  const onlineSales = hasMany(sales, { localKey: branches.col('id'), foreignKey: sales.col('branchId'), where: eq(sales.col('online'), true) });
  const branchReturns = hasMany(returns, { localKey: branches.col('id'), foreignKey: returns.col('branchId') });

  const regions = db.table(branches).groupBy({
    by: ['region'],
    select: {
      branches: agg.count(),                                                // root rows
      sales: agg.related(branchSales, agg.count()),                         // 0 when none
      salesCents: agg.related(branchSales, agg.sum(sales.col('cents'))),    // exact bigint, or null
      returnedCents: agg.related(branchReturns, agg.sum(returns.col('cents'))),
      onlineCents: agg.related(onlineSales, agg.sum(sales.col('cents'))),
      averageCopies: agg.related(branchSales, agg.avg(sales.col('copies'))), // over sales, not per branch
      firstTitle: agg.related(branchSales, agg.min(sales.col('title'))),
    },
    orderBy: [{ field: 'salesCents', direction: 'desc' }],
  });
  // Coast has 3 sales and 2 returns: separate subqueries keep them from multiplying (6600 cents, not 13200).
  assert.deepEqual(regions, [
    { region: 'Coast', branches: 2, sales: 3, salesCents: 6600n, returnedCents: 500n, onlineCents: 4200n, averageCopies: 2, firstTitle: 'Atlas' },
    { region: 'Hills', branches: 1, sales: 0, salesCents: null, returnedCents: null, onlineCents: null, averageCopies: null, firstTitle: null },
  ]);

  const coast = db.table(branches).aggregate({ where: eq(branches.col('region'), 'Coast'), select: { branches: agg.count(), sales: agg.related(branchSales, agg.count()) } });
  assert.deepEqual(coast, { branches: 2, sales: 3 });

  console.table(regions);
  // Integer sums are always bigint. Convert deliberately when preparing JSON for your application.
  console.log(JSON.stringify(regions.map(row => ({ ...row, salesCents: row.salesCents?.toString() ?? null, returnedCents: row.returnedCents?.toString() ?? null, onlineCents: row.onlineCents?.toString() ?? null }))));
} finally { db.close(); }
