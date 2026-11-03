import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkerSqliteExecutor, connectSqliteWorker } from '../dist/core/worker-executor.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { inlineAsyncExecutor, isAcknowledgedRejection } from '../dist/core/executor.js';

const code = expected => error => error?.code === expected;
const plain = rows => rows.map(r => ({ ...r }));
function file(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-worker-')), filename = join(directory, 'fixture.sqlite');
  t.after(() => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) try { unlinkSync(filename + suffix); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    rmdirSync(directory);
  });
  return filename;
}

test('worker SQLite preserves exact values, settings, bound snapshots and definite errors', async () => {
  const db = await openWorkerSqliteExecutor();
  try {
    assert.equal((await db.all('PRAGMA foreign_keys', []))[0].foreign_keys, 1n);
    assert.equal((await db.all('PRAGMA trusted_schema', []))[0].trusted_schema, 0n);
    await db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT UNIQUE)');
    const values = [9223372036854775807n, "SYNTHETIC_' OR 1=1 --\0value"];
    const request = db.all('INSERT INTO item VALUES(?,?) RETURNING *', values);
    values[0] = 2n; values[1] = 'changed after send';
    assert.deepEqual(plain(await request), [{ id: 9223372036854775807n, value: "SYNTHETIC_' OR 1=1 --\0value" }]);
    await assert.rejects(db.all('INSERT INTO item VALUES(?,?)', [1, "SYNTHETIC_' OR 1=1 --\0value"]), error => isAcknowledgedRejection(error) && error.code === 'CONSTRAINT');
    await assert.rejects(db.all('SELECT :x', [{ x: 'map' }]), code('VALIDATION'));
    assert.equal(await db.inTransaction(), false);
  } finally { await db.close(); }
  await db.close();
  await assert.rejects(db.all('SELECT 1', []), code('CLOSED'));
});

test('the async session awaits real worker writes and rollback survives reopening', async t => {
  const filename = file(t), session = createAsyncSession(await openWorkerSqliteExecutor(filename));
  try {
    await session.all('CREATE TABLE item(id INTEGER PRIMARY KEY)');
    await session.transaction(async tx => { await tx.all('INSERT INTO item VALUES (?)', [1]); });
    await assert.rejects(session.transaction(async tx => { await tx.all('INSERT INTO item VALUES (?)', [2]); throw new Error('synthetic rollback'); }), /synthetic rollback/);
  } finally { await session.close(); }
  const reopened = openSqliteExecutor(filename, { readOnly: true });
  try { assert.deepEqual(plain(reopened.all('SELECT id FROM item', [])), [{ id: 1n }]); } finally { reopened.close(); }
});

test('read-only worker setup and failures keep host paths out of errors', async t => {
  const filename = file(t);
  await assert.rejects(openWorkerSqliteExecutor(filename, { readOnly: true }), error => error.code === 'OPEN' && !error.message.includes(filename));
  const setup = openSqliteExecutor(filename); setup.exec('CREATE TABLE item(id INTEGER PRIMARY KEY)'); setup.close();
  const reader = await openWorkerSqliteExecutor(filename, { readOnly: true });
  try {
    await assert.rejects(reader.all('INSERT INTO item VALUES(1)', []), error => isAcknowledgedRejection(error) && error.code === 'READ_ONLY');
    assert.deepEqual(await reader.all('SELECT * FROM item', []), []);
  } finally { await reader.close(); }
  for (const options of [null, { readonly: true }, { readOnly: 'true' }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 120001 }, { busyTimeoutMs: null }])
    await assert.rejects(openWorkerSqliteExecutor(':memory:', options));
});

const slow = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 1000000) SELECT sum(x) AS total FROM n';
test('the parent event loop runs during worker SQLite execution; the inline control blocks it', async () => {
  const worker = await openWorkerSqliteExecutor(), inline = inlineAsyncExecutor(openSqliteExecutor());
  try {
    let inlineTicks = 0, workerTicks = 0;
    let timer = setInterval(() => inlineTicks++, 2);
    const control = await inline.all(slow, []); clearInterval(timer);
    assert.equal(inlineTicks, 0, 'The synchronous control must block its calling thread');
    timer = setInterval(() => workerTicks++, 2);
    const actual = await worker.all(slow, []); clearInterval(timer);
    assert.deepEqual(plain(actual), plain(control));
    assert.equal(actual[0].total, 500000500000n);
    assert.ok(workerTicks > 0, 'The parent timer must run while SQLite is executing in the worker');
  } finally { await worker.close(); await inline.close(); }
});

test('worker loss after an actual COMMIT is unconfirmed and never replayed', async t => {
  const filename = file(t), setup = openSqliteExecutor(filename);
  setup.exec('CREATE TABLE item(id INTEGER PRIMARY KEY)'); setup.close();
  // A test-only protocol peer applies COMMIT on real SQLite, then exits before sending its acknowledgment.
  const script = `
    const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.module).then(({openSqliteExecutor})=>{
      const db=openSqliteExecutor(workerData.filename);
      parentPort.postMessage({protocol:1,kind:'ready'});
      parentPort.on('message',p=>{
        let value;
        try {
          if(p.op==='exec'){db.exec(p.sql);if(p.sql==='COMMIT')process.exit(0);}
          else if(p.op==='all')value=db.all(p.sql,p.parameters);
          else if(p.op==='state')value=db.inTransaction();
          else if(p.op==='close'){db.close();parentPort.close();}
          parentPort.postMessage({protocol:1,kind:'result',id:p.id,ok:true,value});
        }catch{parentPort.postMessage({protocol:1,kind:'result',id:p.id,ok:false,code:'DATABASE_ERROR'});}
      });
    });`;
  const peer = new Worker(script, { eval: true, workerData: { filename, module: new URL('../dist/core/sqlite-executor.js', import.meta.url).href } });
  const session = createAsyncSession(await connectSqliteWorker(peer, 10000));
  let callbacks = 0;
  try {
    await assert.rejects(session.transaction(async tx => { callbacks++; await tx.all('INSERT INTO item VALUES(?)', [7]); }), code('COMMIT_UNCONFIRMED'));
    assert.equal(callbacks, 1);
    await assert.rejects(session.all('SELECT * FROM item'), code('CONNECTION_UNUSABLE'));
  } finally { await session.close(); }
  const reopened = openSqliteExecutor(filename, { readOnly: true });
  try { assert.deepEqual(plain(reopened.all('SELECT id FROM item', [])), [{ id: 7n }]); } finally { reopened.close(); }
});

test('invalid worker responses are unconfirmed errors and end the connection', async () => {
  const peer = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.postMessage({protocol:1,kind:'ready'});parentPort.on('message',p=>parentPort.postMessage({protocol:1,kind:'result',id:p.id+1,ok:true,value:[]}));`, { eval: true });
  const db = await connectSqliteWorker(peer, 10000);
  await assert.rejects(db.all('SELECT 1', []), error => error.code === 'DRIVER_UNAVAILABLE' && !isAcknowledgedRejection(error));
  await db.close();
});

test('an unanswered worker request times out as unconfirmed and termination releases the worker', async () => {
  const peer = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.postMessage({protocol:1,kind:'ready'});parentPort.on('message',()=>{});`, { eval: true });
  const db = await connectSqliteWorker(peer, 5000);
  await assert.rejects(db.all('SELECT 1', []), error => error.code === 'DRIVER_TIMEOUT' && !isAcknowledgedRejection(error));
  await db.close(); assert.equal(peer.threadId, -1);
  await db.close();
});

test('worker loss after a sent autocommit operation makes the session unusable', async () => {
  const peer = new Worker(`const {parentPort}=require('node:worker_threads');parentPort.postMessage({protocol:1,kind:'ready'});parentPort.on('message',()=>process.exit(0));`, { eval: true });
  const session = createAsyncSession(await connectSqliteWorker(peer, 10000));
  await assert.rejects(session.all('SELECT 1'), code('EXECUTION_UNCONFIRMED'));
  await assert.rejects(session.all('SELECT 2'), code('CONNECTION_UNUSABLE'));
  await session.close(); assert.equal(peer.threadId, -1);
});
