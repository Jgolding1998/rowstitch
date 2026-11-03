import { agg, column, defineTable, hasMany, openDatabase, type AggregateSelector, type RelatedAggregate } from '../../src/index.js';

const shops = defineTable('gt_shops', { id: column.integer().primaryKey(), area: column.text().nullable(), tier: column.integer() });
const sales = defineTable('gt_sales', { id: column.integer().primaryKey(), shopId: column.integer().references(shops, 'id'), cents: column.bigint(), qty: column.integer().nullable(), label: column.text() });
const parts = defineTable('gt_parts', { id: column.integer().primaryKey(), saleId: column.integer().references(sales, 'id'), weight: column.real() });
const db = openDatabase(':memory:', { tables: [shops, sales, parts] });
const shopSales = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId') });
const saleParts = hasMany(parts, { localKey: sales.col('id'), foreignKey: parts.col('saleId') });

// ---- Positive: root and related selectors together; related results keep the M6 selector contracts ----
const totals = db.table(shops).aggregate({ select: {
  shops: agg.count(), tiers: agg.sum(shops.col('tier')),
  sales: agg.related(shopSales, agg.count()), cents: agg.related(shopSales, agg.sum(sales.col('cents'))),
  meanQty: agg.related(shopSales, agg.avg(sales.col('qty'))), firstLabel: agg.related(shopSales, agg.min(sales.col('label'))),
  weight: agg.related(shopSales, agg.related(saleParts, agg.sum(parts.col('weight')))),
} });
const shopCount: number = totals.shops;
const tiers: bigint | null = totals.tiers;
const saleCount: number = totals.sales;
const cents: bigint | null = totals.cents;
const meanQty: number | null = totals.meanQty;
const firstLabel: string | null = totals.firstLabel;
const weight: number | null = totals.weight;
void [shopCount, tiers, saleCount, cents, meanQty, firstLabel, weight];
const groups = db.table(shops).groupBy({ by: ['area'], select: { n: agg.count(), cents: agg.related(shopSales, agg.sum(sales.col('cents'))) },
  orderBy: [{ field: 'cents', direction: 'desc' }], limit: 10 });
const area: string | null = groups[0].area;
const groupCents: bigint | null = groups[0].cents;
void [area, groupCents];

// ---- Negative: result types ----
// @ts-expect-error A related integer sum is exact bigint, never number.
const centsAsNumber: number | null = totals.cents;
// @ts-expect-error A related minimum over an empty path is null.
const labelNotNull: string = totals.firstLabel;
// @ts-expect-error A related count is a number.
const countAsText: string = totals.sales;
// @ts-expect-error A nested related real sum is number | null, not bigint.
const weightAsBigint: bigint | null = totals.weight;
// @ts-expect-error Unknown aliases do not exist.
totals.missing;
// @ts-expect-error orderBy names a selected key or alias only.
db.table(shops).groupBy({ by: ['area'], select: { cents: agg.related(shopSales, agg.sum(sales.col('cents'))) }, orderBy: [{ field: 'sales', direction: 'asc' }] });

// ---- Dynamic keys, unions and broad selections stay sound ----
declare const keys: ('id' | 'area')[];
const overlap = db.table(shops).groupBy({ by: keys, select: { area: agg.related(shopSales, agg.count()) } });
const overlapCount: number = overlap[0].area;
void overlapCount;
// @ts-expect-error The related alias replaces the uncertain text key on success; it is never text or never.
const overlapAsText: string = overlap[0].area;
declare const broad: Record<string, AggregateSelector<number> | RelatedAggregate<number>>;
declare const dynamicField: string;
const broadGroups = db.table(shops).groupBy({ by: ['area'], select: broad });
const anyValue: number | string | null | undefined = broadGroups[0][dynamicField];
void anyValue;
// @ts-expect-error A dynamic lookup may return the text group key, so number | undefined is unsound.
const narrow: number | undefined = broadGroups[0][dynamicField];
declare const either: { a: RelatedAggregate<number> } | { b: AggregateSelector<number> };
const unionTotals = db.table(shops).aggregate({ select: either });
if ('a' in unionTotals) {
  const a: number = unionTotals.a;
  // @ts-expect-error Each union branch keeps its own alias type.
  const aAsText: string = unionTotals.a;
  void a;
}

// ---- Negative: brands and API shape ----
// @ts-expect-error findMany per-row aggregates still accept only agg.related values.
db.table(shops).findMany({ aggregates: { n: agg.count() } });
// @ts-expect-error A relation descriptor is not a selector; wrap it with agg.related.
db.table(shops).aggregate({ select: { n: shopSales } });
// @ts-expect-error A table is not a relation.
agg.related(sales, agg.count());
// @ts-expect-error A related bigint average still needs the approximate acknowledgement.
agg.related(shopSales, agg.avg(sales.col('cents')));
// @ts-expect-error Raw SQL is not a selector.
db.table(shops).groupBy({ by: ['area'], select: { n: 'COUNT(*)' } });
db.close();
