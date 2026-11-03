import { agg, column, defineTable, eq, openDatabase, some, hasMany, type AggregateSelection, type AggregateSelector, type ColumnRef } from '../../src/index.js';

const customers = defineTable('agg_customers', { id: column.integer().primaryKey(), region: column.text(), tier: column.text().nullable() });
const orders = defineTable('agg_orders', {
  id: column.integer().primaryKey(),
  customerId: column.integer().references(customers, 'id'),
  status: column.text(),
  paid: column.boolean(),
  quantity: column.integer(),
  discount: column.integer().nullable(),
  cents: column.bigint(),
  weight: column.real().nullable(),
  note: column.text().nullable(),
  meta: column.json<{ tag: string }>().nullable(),
});
const db = openDatabase(':memory:', { tables: [customers, orders] });
const repo = db.table(orders);

// ---- Root aggregate: exact literal result shape and numeric contracts ----
const totals = repo.aggregate({
  where: eq(orders.col('status'), 'paid'),
  select: {
    rows: agg.count(),
    discounted: agg.count(orders.col('discount')),
    units: agg.sum(orders.col('quantity')),
    centsTotal: agg.sum(orders.col('cents')),
    weightTotal: agg.sum(orders.col('weight')),
    meanUnits: agg.avg(orders.col('quantity')),
    meanCents: agg.avg(orders.col('cents'), { approximate: true }),
    firstStatus: agg.min(orders.col('status')),
    lastNote: agg.max(orders.col('note')),
    smallestCents: agg.min(orders.col('cents')),
    lightest: agg.min(orders.col('weight')),
  },
});
const rows: number = totals.rows;
const discounted: number = totals.discounted;
const units: bigint | null = totals.units;                 // integer SUM is exact bigint, never number
const centsTotal: bigint | null = totals.centsTotal;
const weightTotal: number | null = totals.weightTotal;
const meanUnits: number | null = totals.meanUnits;
const meanCents: number | null = totals.meanCents;
const firstStatus: string | null = totals.firstStatus;      // min over a NOT NULL column can still be null (empty input)
const lastNote: string | null = totals.lastNote;
const smallestCents: bigint | null = totals.smallestCents;
const lightest: number | null = totals.lightest;
void [rows, discounted, units, centsTotal, weightTotal, meanUnits, meanCents, firstStatus, lastNote, smallestCents, lightest];
// @ts-expect-error Integer sums are bigint: assigning to number would silently lose exactness.
const unitsAsNumber: number | null = totals.units;
// @ts-expect-error Aggregates over empty input are null, even for NOT NULL columns.
const statusNotNull: string = totals.firstStatus;
// @ts-expect-error COUNT is always a number, never null.
const rowsNullable: null = totals.rows;
// @ts-expect-error Unselected aliases do not exist on the result.
totals.missing;
// Results are plain mutable objects, like row reads.
totals.rows = 1;

// ---- Selector argument typing ----
// @ts-expect-error SUM is numeric-only: text is rejected.
agg.sum(orders.col('status'));
// @ts-expect-error SUM is numeric-only: boolean is rejected.
agg.sum(orders.col('paid'));
// @ts-expect-error AVG is numeric-only: JSON is rejected.
agg.avg(orders.col('meta'));
// @ts-expect-error A bigint average needs the explicit approximate acknowledgement.
agg.avg(orders.col('cents'));
// @ts-expect-error The acknowledgement must be the literal true.
agg.avg(orders.col('cents'), { approximate: false });
// @ts-expect-error MIN/MAX do not order JSON documents.
agg.max(orders.col('meta'));
// @ts-expect-error MIN/MAX on booleans are deferred in this slice.
agg.min(orders.col('paid'));
// @ts-expect-error COUNT(column) excludes JSON in this slice.
agg.count(orders.col('meta'));
// @ts-expect-error A raw column name is not a selector argument.
agg.sum('quantity');
// A broad ColumnRef annotation loses the kind and is not accepted for numeric aggregates.
declare const broad: ColumnRef<number>;
// @ts-expect-error Keep inferred references; ColumnRef<number> has an unknown kind.
agg.sum(broad);

// ---- Selection records ----
// @ts-expect-error Plain values are not aggregate selectors.
repo.aggregate({ select: { rows: 1 } });
// @ts-expect-error A selector string is not executable SQL.
repo.aggregate({ select: { rows: 'COUNT(*)' } });
// @ts-expect-error select is required.
repo.aggregate({ where: eq(orders.col('status'), 'paid') });
// @ts-expect-error HAVING is not supported in this release.
repo.aggregate({ select: { rows: agg.count() }, having: eq(orders.col('status'), 'paid') });
// A broad, dynamically built selection cannot promise any particular field.
declare const dynamic: Record<string, ReturnType<typeof agg.count>>;
const broadResult = repo.aggregate({ select: dynamic });
// @ts-expect-error Fields of a broad selection may be undefined.
const certain: number = broadResult.anything;
const maybe: number | undefined = broadResult.anything;
void maybe;
const reusable = { rows: agg.count(), units: agg.sum(orders.col('quantity')) } satisfies AggregateSelection;
const reused: bigint | null = repo.aggregate({ select: reusable }).units;
void reused;

// ---- groupBy: keys, nullability, ordering ----
const groups = repo.groupBy({
  by: ['status', 'note'],
  where: some(hasMany(orders, { localKey: orders.col('id'), foreignKey: orders.col('id') })),
  select: { rows: agg.count(), units: agg.sum(orders.col('quantity')) },
  orderBy: [{ field: 'units', direction: 'desc' }, { field: 'status', direction: 'asc' }],
  limit: 50,
});
const statusKey: string = groups[0].status;
const noteKey: string | null = groups[0].note;           // nullable key keeps declared nullability
const groupRows: number = groups[0].rows;
const groupUnits: bigint | null = groups[0].units;
void [statusKey, noteKey, groupRows, groupUnits];
// @ts-expect-error Non-grouped columns are not part of a group result.
groups[0].quantity;
// @ts-expect-error A non-null key is never null.
const statusNull: null = groups[0].status;
// @ts-expect-error At least one group key is required.
repo.groupBy({ by: [], select: { rows: agg.count() } });
// @ts-expect-error Group keys must be mapped columns.
repo.groupBy({ by: ['missing'], select: { rows: agg.count() } });
// @ts-expect-error JSON columns cannot be group keys.
repo.groupBy({ by: ['meta'], select: { rows: agg.count() } });
// @ts-expect-error orderBy fields must be a selected key or alias; typos are not widened to string.
repo.groupBy({ by: ['status'], select: { rows: agg.count() }, orderBy: [{ field: 'rowz', direction: 'asc' }] });
// @ts-expect-error A non-selected column is not an ordering field.
repo.groupBy({ by: ['status'], select: { rows: agg.count() }, orderBy: [{ field: 'quantity', direction: 'asc' }] });
// @ts-expect-error Directions are lower-case asc/desc.
repo.groupBy({ by: ['status'], select: { rows: agg.count() }, orderBy: [{ field: 'rows', direction: 'DESC' }] });
// @ts-expect-error Row-scope asc()/desc() orderings are not group orderings.
repo.groupBy({ by: ['status'], select: { rows: agg.count() }, orderBy: [{ ref: orders.col('status'), direction: 'ASC' }] });
// A dynamic key list is accepted, but no particular key is promised.
declare const keys: ('status' | 'note')[];
const dynamicGroups = repo.groupBy({ by: keys, select: { rows: agg.count() } });
// @ts-expect-error A dynamic key list does not guarantee the status field.
const dynamicStatus: string = dynamicGroups[0].status;
const dynamicStatusMaybe: string | undefined = dynamicGroups[0].status;
void dynamicStatusMaybe;
// An alias that matches a possible dynamic key is the aggregate value whenever the call succeeds
// (an alias equal to an actually selected key is rejected at runtime), never string & number = never.
const labels = defineTable('agg_labels', { id: column.integer().primaryKey(), label: column.text(), score: column.real() });
const labelRepo = db.table(labels);
declare const labelKeys: ('id' | 'label')[];
const aliasOverKey = labelRepo.groupBy({ by: labelKeys, select: { label: agg.count() } });
const aliasCount: number = aliasOverKey[0].label;
// @ts-expect-error The alias label is a count, not the text key it shadows.
const aliasAsText: string = aliasOverKey[0].label;
// @ts-expect-error The shadowed field is not never: an impossible type would accept anything.
const aliasAsBoolean: boolean = aliasOverKey[0].label;
const maybeId: number | undefined = aliasOverKey[0].id;
// @ts-expect-error The id key is uncertain for a dynamic key list.
const certainId: number = aliasOverKey[0].id;
void [aliasCount, maybeId];
// A broad selector dictionary: dynamic lookups can reach a key column as well as any aggregate result.
declare const countSelectors: Record<string, ReturnType<typeof agg.count>>;
declare const dynamicField: string;
const broadGroups = labelRepo.groupBy({ by: ['label'], select: countSelectors });
const lookedUp: number | string | undefined = broadGroups[0][dynamicField];
// @ts-expect-error A dynamic lookup may return the text key, so number | undefined is unsound.
const lookedUpNumber: number | undefined = broadGroups[0][dynamicField];
const literalKey: string = broadGroups[0].label;           // a literal selected key stays precise
// @ts-expect-error A broad selection does not promise any particular alias.
const promisedAlias: number = broadGroups[0].rows;
void [lookedUp, literalKey];
// Precise literal keys and aliases stay exact (no widening from the fixes above).
const exact = labelRepo.groupBy({ by: ['label'], select: { total: agg.sum(labels.col('score')), n: agg.count() } });
const exactLabel: string = exact[0].label;
const exactTotal: number | null = exact[0].total;
const exactN: number = exact[0].n;
// @ts-expect-error A real sum is number | null, not bigint.
const exactTotalBig: bigint | null = exact[0].total;
void [exactLabel, exactTotal, exactN];

// A union of selections resolves per branch: the alias replaces the uncertain key only where that alias is selected.
type CountSelector = ReturnType<typeof agg.count>;
declare const eitherSelection: { label: CountSelector } | { n: CountSelector };
const unionGroups = labelRepo.groupBy({ by: labelKeys, select: eitherSelection });
for (const row of unionGroups) {
  if (!('n' in row)) {
    const branchCount: number = row.label;
    // @ts-expect-error In the label-selector branch, label is the numeric aggregate, not the grouped text.
    const branchText: string = row.label;
    void branchCount;
  } else {
    const n: number = row.n;
    const keyLabel: string | undefined = row.label;      // in the n branch, label is the uncertain text key
    // @ts-expect-error In the n branch label is the uncertain text key, not a count.
    const keyLabelCount: number | undefined = row.label;
    void [n, keyLabel];
  }
}
// A union of a literal selection and a broad dictionary keeps each branch's guarantees, and literal keys stay precise.
declare const mixedSelection: { total: AggregateSelector<number | null> } | Record<string, CountSelector>;
const mixedGroups = labelRepo.groupBy({ by: ['label'], select: mixedSelection });
const mixedLabel: string = mixedGroups[0].label;          // the literal key is certain in both branches
// @ts-expect-error The total alias exists only in one branch, so it is not certain.
const mixedTotal: number | null = mixedGroups[0].total;
// @ts-expect-error No dynamic lookup on the union: the literal branch has no index signature (stricter than the broad branch alone).
const mixedDynamic: number | null | undefined = mixedGroups[0][dynamicField];
void mixedLabel;
// Root aggregate over a selection union also resolves per branch.
const unionTotals = labelRepo.aggregate({ select: eitherSelection });
if ('label' in unionTotals) {
  const total: number = unionTotals.label;
  // @ts-expect-error The root label alias is a count.
  const totalText: string = unionTotals.label;
  void total;
}

// ---- Exact arity: options that would change meaning are never silently ignored ----
// @ts-expect-error Selector filters are not supported in this release.
agg.sum(orders.col('quantity'), { where: eq(orders.col('status'), 'paid') });
// @ts-expect-error DISTINCT is not supported in this release.
agg.min(orders.col('quantity'), { distinct: true });
// @ts-expect-error max takes exactly one column.
agg.max(orders.col('quantity'), orders.col('cents'));
// @ts-expect-error avg takes a column and optional options only.
agg.avg(orders.col('quantity'), { approximate: true }, { where: eq(orders.col('status'), 'paid') });
// @ts-expect-error avg accepts only the approximate option.
agg.avg(orders.col('quantity'), { distinct: true });
// @ts-expect-error count takes at most one column.
agg.count(orders.col('quantity'), orders.col('cents'));

// Compiled/explain variants share the same option types.
repo.compileGroupBy({ by: ['status'], select: { rows: agg.count() } });
repo.explainAggregate({ select: { rows: agg.count() } });
// @ts-expect-error Compile methods reject the same invalid options.
repo.compileAggregate({ select: { units: agg.sum(orders.col('note')) } });
db.close();
