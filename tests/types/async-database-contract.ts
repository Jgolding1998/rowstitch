import { agg, column, defineTable, eq, hasMany, openAsyncDatabase, openDatabase, AsyncDatabase, type AsyncRepository, type CompiledQuery, type TraceDocument } from '../../src/index.js';

const owners = defineTable('adc_owners', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable(), version: column.integer().default(0) }, { version: 'version' });
const items = defineTable('adc_items', { id: column.integer().primaryKey(), ownerId: column.integer().references(owners, 'id'), amount: column.bigint() });
const ownerItems = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId') });

export async function contract(): Promise<void> {
  // ---- Positive: the async API keeps the synchronous result types, wrapped in promises.
  const db: AsyncDatabase = await openAsyncDatabase(':memory:', { tables: [owners, items], readOnly: false, maxQueue: 8, maxPending: 8, queueTimeoutMs: 100, requestTimeoutMs: 1000, traceValues: false });
  const repo: AsyncRepository<typeof owners> = db.table(owners);
  const inserted = await repo.insert({ id: 1, name: 'Ada' });
  const version: number = inserted.version;
  const region: string | null = inserted.region;
  const many: number = (await repo.insertMany([{ id: 2, name: 'Bo', region: 'north' }])).length;
  const names: { name: string }[] = await repo.findMany({ select: ['name'] });
  const first = await repo.findFirst({ where: eq(owners.col('id'), 1) });
  const firstName: string | undefined = first?.name;
  const withItems = await repo.findMany({ select: ['name'], include: { items: hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId'), select: ['amount'] }) } });
  const amount: bigint | undefined = withItems[0]?.items[0]?.amount;
  const totals = await repo.findMany({ select: ['name'], aggregates: { n: agg.related(ownerItems, agg.count()), sum: agg.related(ownerItems, agg.sum(items.col('amount'))) } });
  const relatedCount: number | undefined = totals[0]?.n;
  const relatedSum: bigint | null | undefined = totals[0]?.sum;
  const count: number = await repo.count(eq(owners.col('region'), 'north'));
  const summary = await db.table(items).aggregate({ select: { n: agg.count(), total: agg.sum(items.col('amount')) } });
  const total: bigint | null = summary.total;
  const groups = await repo.groupBy({ by: ['region'], select: { n: agg.count() }, orderBy: [{ field: 'n', direction: 'desc' }] });
  const groupRegion: string | null | undefined = groups[0]?.region;
  const updated = await repo.update({ name: 'Ada 2' }, { where: eq(owners.col('id'), 1), maxRows: 1 });
  const versioned = await repo.updateVersion({ id: 1 }, 1, { region: 'south' });
  const removed = await repo.delete({ where: eq(owners.col('id'), 2) });
  const compiled: CompiledQuery = repo.compileSelect({ where: eq(owners.col('id'), 1) });
  const fromTx: number = await db.transaction(async tx => (await tx.table(owners).findMany()).length);
  const fromSync: string = await db.transaction(() => 'value');
  const nested: bigint = await db.transaction(tx => tx.transaction(async () => 1n), { signal: new AbortController().signal });
  const trace: TraceDocument = db.exportTrace({ title: 'contract' });
  const closed: void = await db.close();
  void [version, region, many, names, firstName, amount, relatedCount, relatedSum, count, total, groupRegion, updated, versioned, removed, compiled, fromTx, fromSync, nested, trace, closed];

  // ---- Negative: promises are not results.
  // @ts-expect-error findMany returns a promise; it must be awaited.
  const notAwaited: { name: string }[] = repo.findMany({ select: ['name'] });
  // @ts-expect-error compileSelect is pure and synchronous; it does not return a promise.
  const compiledPromise: Promise<CompiledQuery> = repo.compileSelect();
  // @ts-expect-error A transaction returning a number does not resolve to a string.
  const wrongTx: string = await db.transaction(async () => 1);
  void [notAwaited, compiledPromise, wrongTx];

  // ---- Negative: the synchronous type contracts still hold.
  // @ts-expect-error Fields excluded by projection are not returned.
  (await repo.findMany({ select: ['name'] }))[0].id;
  // @ts-expect-error findFirst may return null.
  (await repo.findFirst()).name;
  // @ts-expect-error Required insert data cannot be omitted.
  await repo.insert({ id: 3 });
  // @ts-expect-error Primary keys cannot be patched.
  await repo.update({ id: 9 }, { where: eq(owners.col('id'), 1) });
  // @ts-expect-error Version increments belong to the ORM.
  await repo.update({ version: 9 }, { where: eq(owners.col('id'), 1) });
  // @ts-expect-error Filter values match their column.
  await repo.findMany({ where: eq(owners.col('id'), 'one') });
  // @ts-expect-error A related integer sum is exact bigint, never number.
  const sumAsNumber: number | null | undefined = (await repo.findMany({ aggregates: { s: agg.related(ownerItems, agg.sum(items.col('amount'))) } }))[0]?.s;
  // @ts-expect-error orderBy names a selected key or alias only.
  await repo.groupBy({ by: ['region'], select: { n: agg.count() }, orderBy: [{ field: 'missing', direction: 'asc' }] });
  void sumAsNumber;

  // ---- Negative: no raw SQL, construction or option escapes.
  // @ts-expect-error The public async database has no raw SQL method.
  await db.all('SELECT 1');
  // @ts-expect-error Async databases are opened with openAsyncDatabase, not constructed.
  new AsyncDatabase();
  // @ts-expect-error A synchronous database is not an asynchronous one.
  const wrongKind: AsyncDatabase = openDatabase(':memory:');
  // @ts-expect-error Numeric limits are numbers.
  await openAsyncDatabase(':memory:', { maxQueue: '8' });
  // @ts-expect-error Unknown options are rejected.
  await openAsyncDatabase(':memory:', { retries: 3 });
  // @ts-expect-error The transaction signal must be an AbortSignal.
  await db.transaction(async () => 1, { signal: {} });
  void wrongKind;
}
