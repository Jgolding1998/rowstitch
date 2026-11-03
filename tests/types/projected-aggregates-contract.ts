import { agg, column, defineTable, eq, hasMany, belongsTo, openDatabase, type RelatedAggregate, type RelatedAggregates } from '../../src/index.js';

const shops = defineTable('pt_shops', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable() });
const sales = defineTable('pt_sales', { id: column.integer().primaryKey(), shopId: column.integer().references(shops, 'id'), cents: column.bigint(), qty: column.integer(), weight: column.real().nullable(), note: column.text().nullable() });
const parts = defineTable('pt_parts', { id: column.integer().primaryKey(), saleId: column.integer().references(sales, 'id'), label: column.text() });
const db = openDatabase(':memory:', { tables: [shops, sales, parts] });
const shopSales = hasMany(sales, { localKey: shops.col('id'), foreignKey: sales.col('shopId'), where: eq(sales.col('qty'), 1) });
const saleParts = hasMany(parts, { localKey: sales.col('id'), foreignKey: parts.col('saleId') });
const saleShop = belongsTo(shops, { localKey: sales.col('shopId'), foreignKey: shops.col('id') });

// ---- Positive: per-row result types follow the M6 selector contracts ----
const rows = db.table(shops).findMany({ select: ['name'], aggregates: {
  sales: agg.related(shopSales, agg.count()),
  notes: agg.related(shopSales, agg.count(sales.col('note'))),
  cents: agg.related(shopSales, agg.sum(sales.col('cents'))),
  qty: agg.related(shopSales, agg.sum(sales.col('qty'))),
  weight: agg.related(shopSales, agg.sum(sales.col('weight'))),
  meanQty: agg.related(shopSales, agg.avg(sales.col('qty'))),
  meanCents: agg.related(shopSales, agg.avg(sales.col('cents'), { approximate: true })),
  firstNote: agg.related(shopSales, agg.min(sales.col('note'))),
  lastLabel: agg.related(shopSales, agg.related(saleParts, agg.max(parts.col('label')))),
  partCount: agg.related(shopSales, agg.related(saleParts, agg.count())),
} });
const name: string = rows[0].name;
const salesCount: number = rows[0].sales;
const notes: number = rows[0].notes;
const cents: bigint | null = rows[0].cents;
const qty: bigint | null = rows[0].qty;
const weight: number | null = rows[0].weight;
const meanQty: number | null = rows[0].meanQty;
const meanCents: number | null = rows[0].meanCents;
const firstNote: string | null = rows[0].firstNote;
const lastLabel: string | null = rows[0].lastLabel;
const partCount: number = rows[0].partCount;
void [name, salesCount, notes, cents, qty, weight, meanQty, meanCents, firstNote, lastLabel, partCount];
const first = db.table(sales).findFirst({ aggregates: { shops: agg.related(saleShop, agg.count()) }, include: { shop: saleShop } });
const shopCount: number | undefined = first?.shops;
const included: string | undefined = first?.shop?.name;
void [shopCount, included];
// A broad dictionary of related aggregates does not promise any alias.
declare const dynamic: Record<string, RelatedAggregate<number>>;
const broad = db.table(shops).findMany({ aggregates: dynamic });
// A dynamic lookup may reach any selected column (id, name, region) as well as an aggregate result.
const maybe: number | string | null | undefined = broad[0].anything;
const literalName: string = broad[0].name;   // literal selected fields stay precise
void [maybe, literalName];
// @ts-expect-error A dynamic lookup can be the selected text column, so number | undefined is unsound.
const narrowDynamic: number | undefined = broad[0].anything;

// A known alias replaces an uncertain (dynamically selected) field of the same name on a successful return.
declare const shopColumns: readonly ('id' | 'name')[];
const overlap = db.table(shops).findFirst({ select: shopColumns, aggregates: { name: agg.related(shopSales, agg.count()) } })!;
const overlapCount: number = overlap.name;
void overlapCount;
// @ts-expect-error The aggregate is a number, not the text column it replaces (and never the bottom type).
const overlapAsText: string = overlap.name;
// @ts-expect-error A collapsed never type would accept boolean; the merged type does not.
const overlapAsBoolean: boolean = overlap.name;
// Broad aggregates with includes: a dynamic lookup may also be an included array.
const withSales = db.table(shops).findFirst({ include: { sales: shopSales }, aggregates: dynamic })!;
const includedQty: number | undefined = withSales.sales[0]?.qty;   // literal include stays precise
void includedQty;
// @ts-expect-error A dynamic lookup can be the included array, so scalars-only is unsound.
const scalarOnly: string | number | null | undefined = withSales.anything;
// A union of aggregate records with a dynamic selection: each branch merges separately.
declare const labelOrQuantity: { name: RelatedAggregate<number> } | { quantity: RelatedAggregate<number> };
const unionOverlap = db.table(shops).findFirst({ select: shopColumns, aggregates: labelOrQuantity })!;
const unionName: number | string | undefined = unionOverlap.name;
void unionName;
// @ts-expect-error Neither branch makes name boolean (no collapse to never).
const unionNameAsBoolean: boolean = unionOverlap.name;
// Unions of aggregate records resolve per branch.
declare const either: { a: RelatedAggregate<number> } | { b: RelatedAggregate<bigint | null> };
const unionRows = db.table(shops).findMany({ select: ['id'], aggregates: either });
if ('a' in unionRows[0]) {
  const a: number = unionRows[0].a;
  // @ts-expect-error In the a branch the alias is a count (unions must distribute; not unknown or never).
  const aAsText: string = unionRows[0].a;
  void a;
}
const reusable = { n: agg.related(shopSales, agg.count()) } satisfies RelatedAggregates;
const reused: number = db.table(shops).findMany({ aggregates: reusable })[0].n;
void reused;

// ---- Negative: result types ----
// @ts-expect-error A count is a number, not text.
const countAsText: string = rows[0].sales;
// @ts-expect-error Integer sums are exact bigint, never number.
const centsAsNumber: number | null = rows[0].cents;
// @ts-expect-error Per-row aggregates over an empty relation can be null.
const notNullCents: bigint = rows[0].cents;
// @ts-expect-error Nested path results keep the leaf type: max(text) is string | null.
const labelAsNumber: number | null = rows[0].lastLabel;
// @ts-expect-error Unselected root columns are not returned.
rows[0].region;
// @ts-expect-error Unknown aliases do not exist.
rows[0].missing;
// @ts-expect-error A broad dictionary does not promise its fields.
const certain: number = broad[0].anything;
// @ts-expect-error findFirst can return null.
const firstShops: number = db.table(sales).findFirst({ aggregates: { shops: agg.related(saleShop, agg.count()) } }).shops;

// ---- Negative: separate branding and API shape ----
// @ts-expect-error Plain root selectors are not per-row aggregates.
db.table(shops).findMany({ aggregates: { n: agg.count() } });
// M8 (intentional contract change): root aggregate/groupBy accept agg.related; results keep the selector's type.
const rootRelated: number = db.table(shops).aggregate({ select: { n: agg.related(shopSales, agg.count()) } }).n;
const groupRelated: number = db.table(shops).groupBy({ by: ['region'], select: { n: agg.related(shopSales, agg.count()) } })[0].n;
void [rootRelated, groupRelated];
// @ts-expect-error A table is not a relation descriptor.
agg.related(sales, agg.count());
// @ts-expect-error The selector must be an agg selector or a nested agg.related value.
agg.related(shopSales, sales.col('qty'));
// @ts-expect-error A raw SQL string is not a selector.
agg.related(shopSales, 'COUNT(*)');
// @ts-expect-error agg.related takes exactly a relation and a selector.
agg.related(shopSales);
// @ts-expect-error agg.related takes exactly a relation and a selector.
agg.related(shopSales, agg.count(), agg.count());
// @ts-expect-error The M6 selector contracts still apply: text cannot be summed.
agg.related(shopSales, agg.sum(sales.col('note')));
// @ts-expect-error Aggregates are a read option; writes do not accept them.
db.table(shops).update({ name: 'x' }, { where: eq(shops.col('id'), 1), aggregates: { n: agg.related(shopSales, agg.count()) } });
// @ts-expect-error Values must be agg.related results, not numbers.
db.table(shops).findMany({ aggregates: { n: 1 } });
db.close();
