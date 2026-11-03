import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as sdk from '../dist/index.js';
import { openAsyncDatabaseWithExecutor } from '../dist/core/async-database.js';
import { connectSqliteWorker } from '../dist/core/worker-executor.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';
import { inlineAsyncExecutor } from '../dist/core/executor.js';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-async-orm-')), file = join(directory, 'sample.sqlite');
  const handles = [];
  t.after(async () => {
    for (const db of handles.reverse()) await db.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) try { unlinkSync(file + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    rmdirSync(directory);
  });
  const owners = sdk.defineTable('async_owners', { id: sdk.column.integer().primaryKey(), region: sdk.column.text().nullable(), name: sdk.column.text(), version: sdk.column.integer().default(0) }, { version: 'version' });
  const sales = sdk.defineTable('async_sales', { id: sdk.column.integer().primaryKey(), ownerId: sdk.column.integer().references(owners, 'id'), cents: sdk.column.bigint(), paid: sdk.column.boolean() });
  const refunds = sdk.defineTable('async_refunds', { id: sdk.column.integer().primaryKey(), ownerId: sdk.column.integer().references(owners, 'id'), cents: sdk.column.bigint() });
  return { file, owners, sales, refunds, tables: [owners, sales, refunds], own(db) { handles.push(db); return db; } };
}
async function seed(f) {
  const db = f.own(await sdk.openAsyncDatabase(f.file, { tables: f.tables }));
  await db.ensureSchema();
  await db.table(f.owners).insertMany([{ id: 1, region: 'north', name: 'Ada' }, { id: 2, region: 'north', name: 'Bo' }, { id: 3, region: null, name: 'Cy' }]);
  const MAX = 2n ** 63n - 1n;
  await db.table(f.sales).insertMany([{ id: 1, ownerId: 1, cents: MAX, paid: true }, { id: 2, ownerId: 1, cents: MAX, paid: false }, { id: 3, ownerId: 2, cents: -7n, paid: true }]);
  await db.table(f.refunds).insertMany([{ id: 1, ownerId: 1, cents: 2n }, { id: 2, ownerId: 1, cents: 3n }, { id: 3, ownerId: 2, cents: 5n }]);
  return db;
}

test('public async guarded and versioned writes remain atomic and durable after reopen', async t => {
  const f = fixture(t), db = await seed(f), repo = db.table(f.owners);
  await assert.rejects(repo.update({ name: 'wrong' }, { where: sdk.gt(f.owners.col('id'), 0), maxRows: 1 }), code('AFFECTED_ROWS'));
  assert.deepEqual((await repo.findMany({ select: ['name'] })).map(r => r.name), ['Ada', 'Bo', 'Cy']);
  const updated = await repo.updateVersion({ id: 1 }, 0, { name: 'Ada saved' });
  assert.equal(updated.version, 1);
  await assert.rejects(repo.updateVersion({ id: 1 }, 0, { name: 'stale' }), code('CONFLICT'));
  await db.close();
  const ro = f.own(await sdk.openAsyncDatabase(f.file, { tables: f.tables, readOnly: true }));
  assert.equal((await ro.table(f.owners).findFirst({ where: sdk.eq(f.owners.col('id'), 1) })).name, 'Ada saved');
  await assert.rejects(ro.table(f.owners).delete({ where: sdk.eq(f.owners.col('id'), 2) }), code('READ_ONLY'));
});

test('worker-backed related groups retain independent totals and the 0.7.1 domain-binding correction', async t => {
  const f = fixture(t), db = await seed(f), { agg, hasMany, eq } = sdk;
  const sales = paid => hasMany(f.sales, { localKey: f.owners.col('id'), foreignKey: f.sales.col('ownerId'), ...(paid === undefined ? {} : { where: eq(f.sales.col('paid'), paid) }) });
  const refunds = hasMany(f.refunds, { localKey: f.owners.col('id'), foreignKey: f.refunds.col('ownerId') });
  const MAX = 2n ** 63n - 1n;
  const select = { owners: agg.count(), cents: agg.related(sales(), agg.sum(f.sales.col('cents'))), refunds: agg.related(refunds, agg.sum(f.refunds.col('cents'))), paid: agg.related(sales(true), agg.count()), pending: agg.related(sales(false), agg.count()) };
  assert.deepEqual(await db.table(f.owners).groupBy({ by: ['region'], select, orderBy: [{ field: 'region', direction: 'asc' }] }), [
    { region: null, owners: 1, cents: null, refunds: null, paid: 0, pending: 0 },
    { region: 'north', owners: 2, cents: 2n * MAX - 7n, refunds: 10n, paid: 2, pending: 1 },
  ]);
  const rows = await db.table(f.owners).findMany({ select: ['name'], aggregates: { paid: agg.related(sales(true), agg.count()), pending: agg.related(sales(false), agg.count()) } });
  assert.deepEqual(rows, [{ name: 'Ada', paid: 1, pending: 1 }, { name: 'Bo', paid: 1, pending: 0 }, { name: 'Cy', paid: 0, pending: 0 }]);
});

test('unrelated root work cannot enter or observe an in-progress async transaction', async t => {
  const f = fixture(t), db = await seed(f), entered = deferred(), release = deferred();
  const tx = db.transaction(async session => {
    await session.table(f.owners).update({ name: 'temporary' }, { where: sdk.eq(f.owners.col('id'), 1) });
    entered.resolve(); await release.promise; throw new Error('synthetic rollback');
  });
  const txOutcome = assert.rejects(tx, /synthetic rollback/);
  await entered.promise;
  const outside = db.table(f.owners).findFirst({ where: sdk.eq(f.owners.col('id'), 1) });
  release.resolve(); await txOutcome;
  assert.equal((await outside).name, 'Ada');
});

test('nested async rollback and escaped handles preserve their transaction boundaries', async t => {
  const f = fixture(t), db = await seed(f); let escaped;
  await db.transaction(async parent => {
    await parent.table(f.owners).update({ name: 'parent' }, { where: sdk.eq(f.owners.col('id'), 1) });
    await assert.rejects(parent.transaction(async child => {
      escaped = child.table(f.owners);
      await escaped.update({ name: 'child' }, { where: sdk.eq(f.owners.col('id'), 1) });
      throw new Error('synthetic child rollback');
    }), /synthetic child rollback/);
    assert.equal((await parent.table(f.owners).findFirst({ where: sdk.eq(f.owners.col('id'), 1) })).name, 'parent');
  });
  await assert.rejects(escaped.findMany(), code('TRANSACTION_CLOSED'));
  assert.equal((await db.table(f.owners).findFirst({ where: sdk.eq(f.owners.col('id'), 1) })).name, 'parent');
});

test('async compile stays pure and trace values remain redacted after real worker execution', async t => {
  const f = fixture(t), db = await seed(f), sentinel = "SYNTHETIC_' OR 1=1 --";
  db.clearTrace();
  const compiled = db.table(f.owners).compileSelect({ where: sdk.eq(f.owners.col('name'), sentinel) });
  assert.ok(!compiled.sql.includes(sentinel)); assert.ok(compiled.parameters.includes(sentinel));
  assert.equal(db.exportTrace().queries.length, 0);
  assert.deepEqual(await db.table(f.owners).findMany({ where: sdk.eq(f.owners.col('name'), sentinel) }), []);
  const trace = db.exportTrace();
  assert.equal(trace.format, 'rowstitch-trace');
  assert.ok(!JSON.stringify(trace).includes(sentinel));
  for (const name of ['openWorkerSqliteExecutor', 'connectSqliteWorker', 'createAsyncSession']) assert.equal(name in sdk, false);
});

test('insert captures its input before waiting for the worker transaction', async t => {
  const f = fixture(t), db = await seed(f), input = { id: 4, region: null, name: 'original' };
  const pending = db.table(f.owners).insert(input);
  input.name = 'changed after call';
  assert.equal((await pending).name, 'original');
  assert.equal((await db.table(f.owners).findFirst({ where: sdk.eq(f.owners.col('id'), 4) })).name, 'original');
});

test('insertMany captures its row list and values before its first await', async t => {
  const f = fixture(t), db = await seed(f);
  const input = [{ id: 4, region: null, name: 'four' }, { id: 5, region: null, name: 'five' }];
  const pending = db.table(f.owners).insertMany(input);
  input[0].name = 'changed after call'; input.push({ id: 6, region: null, name: 'six' });
  const result = await pending;
  assert.deepEqual(result.map(r => [r.id, r.name]), [[4, 'four'], [5, 'five']]);
  assert.equal(await db.table(f.owners).count(), 5);
});

test('mutating a pending selection cannot expose a fetched hidden correlation key', async t => {
  const f = fixture(t), db = await seed(f), select = ['name'];
  const included = sdk.hasMany(f.sales, { localKey: f.owners.col('id'), foreignKey: f.sales.col('ownerId'), select: ['cents'] });
  const pending = db.table(f.owners).findMany({ select, include: { sales: included } });
  select.push('id');
  const rows = await pending;
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['name', 'sales']);
    assert.equal('id' in row, false);
    for (const sale of row.sales) assert.deepEqual(Object.keys(sale), ['cents']);
  }
});

test('insert captures nested JSON before asynchronous transaction admission', async t => {
  const f = fixture(t), notes = sdk.defineTable('async_notes', { id: sdk.column.integer().primaryKey(), payload: sdk.column.json() });
  const db = f.own(await sdk.openAsyncDatabase(f.file, { tables: [notes] }));
  await db.ensureSchema();
  const payload = { preferences: { mode: 'original' } };
  const pending = db.table(notes).insert({ id: 1, payload });
  payload.preferences.mode = 'changed after call';
  assert.deepEqual((await pending).payload, { preferences: { mode: 'original' } });
  assert.deepEqual((await db.table(notes).findFirst()).payload, { preferences: { mode: 'original' } });
});

test('public async traces keep an applied but unconfirmed COMMIT distinct from rollback', async t => {
  const f = fixture(t), setup = sdk.openDatabase(f.file, { tables: f.tables });
  setup.ensureSchema(); setup.close();
  const script = `const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.module).then(({openSqliteExecutor})=>{
      const db=openSqliteExecutor(workerData.filename);parentPort.postMessage({protocol:1,kind:'ready'});
      parentPort.on('message',p=>{let value;try{
        if(p.op==='exec'){db.exec(p.sql);if(p.sql==='COMMIT')process.exit(0);}
        else if(p.op==='all')value=db.all(p.sql,p.parameters);
        else if(p.op==='state')value=db.inTransaction();
        else if(p.op==='close'){db.close();parentPort.close();}
        parentPort.postMessage({protocol:1,kind:'result',id:p.id,ok:true,value});
      }catch{parentPort.postMessage({protocol:1,kind:'result',id:p.id,ok:false,code:'DATABASE_ERROR'});}});
    });`;
  const peer = new Worker(script, { eval: true, workerData: { filename: f.file, module: new URL('../dist/core/sqlite-executor.js', import.meta.url).href } });
  const db = f.own(await openAsyncDatabaseWithExecutor(await connectSqliteWorker(peer, 10000), { tables: f.tables }));
  let callbacks = 0;
  await assert.rejects(db.transaction(async tx => { callbacks++; await tx.table(f.owners).insert({ id: 1, region: 'demo', name: 'Durable' }); }), code('COMMIT_UNCONFIRMED'));
  assert.equal(callbacks, 1);
  const trace = db.exportTrace();
  const commit = trace.queries.findIndex(q => q.sql === 'COMMIT' && q.status === 'error');
  assert.ok(commit >= 0);
  assert.ok(!trace.queries.slice(commit + 1).some(q => q.sql === 'ROLLBACK' && q.status === 'ok'));
  assert.ok(trace.notes.some(note => /unconfirmed outcomes/.test(note)));
  await db.close();
  const reopened = sdk.openDatabase(f.file, { tables: f.tables, readOnly: true });
  try { assert.equal(reopened.table(f.owners).findFirst().name, 'Durable'); } finally { reopened.close(); }
});

test('opening captures table registration before awaiting worker startup', async t => {
  const f = fixture(t), options = { tables: f.tables };
  const opening = sdk.openAsyncDatabase(f.file, options);
  options.tables = [];
  const db = f.own(await opening);
  await db.ensureSchema();
  assert.equal(await db.table(f.owners).count(), 0);
  assert.deepEqual((await db.inspectSchema()).map(table => table.name).sort(), ['async_owners', 'async_refunds', 'async_sales']);
});

test('an expired async callback cannot use the root handle for pure compilation', async t => {
  const f = fixture(t), db = await seed(f), release = deferred();
  let escaped;
  await db.transaction(() => { escaped = release.promise.then(() => db.table(f.owners).compileSelect()); });
  release.resolve();
  await assert.rejects(escaped, code('TRANSACTION_CLOSED'));
});

test('callback contexts expire before a held COMMIT acknowledgment arrives', async t => {
  const f = fixture(t), setup = sdk.openDatabase(f.file, { tables: f.tables }); setup.ensureSchema(); setup.close();
  const driver = inlineAsyncExecutor(openSqliteExecutor(f.file));
  const commitReached = deferred(), commitRelease = deferred(), callbackRelease = deferred();
  const db = f.own(await openAsyncDatabaseWithExecutor({ ...driver, async exec(sql) {
    if (sql === 'COMMIT') { commitReached.resolve(); await commitRelease.promise; }
    await driver.exec(sql);
  } }, { tables: f.tables }));
  let escaped;
  const transaction = db.transaction(() => { escaped = callbackRelease.promise.then(() => db.table(f.owners).compileSelect()); return 17; });
  await commitReached.promise;
  try {
    callbackRelease.resolve();
    await assert.rejects(escaped, code('TRANSACTION_CLOSED'));
  } finally { commitRelease.resolve(); assert.equal(await transaction, 17); }
});
