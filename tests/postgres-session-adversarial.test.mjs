import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSession } from '../dist/core/async-session.js';
import { acknowledgedRejection } from '../dist/core/executor.js';
import { RowstitchError } from '../dist/core/errors.js';

const code = wanted => error => error?.code === wanted;
function engine() {
  const calls = [];
  const holds=[];
  let active=false, readonly=false, writes=0;
  return {calls,get writes(){return writes;},hold(sql){
    let release,reached;
    const gate=new Promise(ok=>{release=ok;}),started=new Promise(ok=>{reached=ok;});
    holds.push({sql,gate,reached});return {release,started};
  },executor:{
    async all(sql) {
      calls.push(sql);
      const held=holds.find(h=>h.sql===sql);if(held){held.reached();await held.gate;}
      if(sql==='INSERT fixture') {
        if(active&&readonly) throw acknowledgedRejection(new RowstitchError('READ_ONLY','synthetic engine rejection'));
        writes++;
      }
      return [{value:'ok'}];
    },
    async exec(sql) {
      calls.push(sql);
      const held=holds.find(h=>h.sql===sql);if(held){held.reached();await held.gate;}
      if(sql.startsWith('BEGIN')) {active=true;readonly=sql==='BEGIN READ ONLY';}
      if(sql==='COMMIT'||sql==='ROLLBACK') {active=false;readonly=false;}
    },
    async inTransaction(){return active;},
    async close(){calls.push('CLOSE');},
  }};
}

test('PostgreSQL readOnly root statements execute in read-only transactions and cannot write through autocommit',async()=>{
  const d=engine(),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true});
  await assert.rejects(session.all('INSERT fixture'),code('READ_ONLY'));
  assert.equal(d.writes,0);
  assert.deepEqual(d.calls,['BEGIN READ ONLY','INSERT fixture','ROLLBACK']);
  assert.deepEqual(await session.all('SELECT fixture'),[{value:'ok'}]);
  assert.deepEqual(d.calls.slice(-3),['BEGIN READ ONLY','SELECT fixture','COMMIT']);
  await session.close();
});

test('PostgreSQL readOnly pre-abort sends no SQL; nested handles use the existing transaction',async()=>{
  const d=engine(),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true});
  const abort=new AbortController();abort.abort();
  await assert.rejects(session.all('INSERT fixture',[],{signal:abort.signal}),code('ABORTED'));
  assert.deepEqual(d.calls,[]);
  await session.transaction(tx=>tx.all('SELECT fixture'));
  assert.deepEqual(d.calls,['BEGIN READ ONLY','SELECT fixture','COMMIT']);
  await session.close();
});

test('ordinary PostgreSQL and SQLite executor root statements keep their existing admission behaviour',async()=>{
  for(const options of [{dialect:'postgresql'},{readOnly:true}]) {
    const d=engine(),session=createAsyncSession(d.executor,options);
    await session.all('SELECT fixture');
    assert.deepEqual(d.calls,['SELECT fixture']);
    await session.close();
  }
});

test('readOnly root FIFO is bounded and queued cancellation frees its admission slot without SQL',async()=>{
  const d=engine(),held=d.hold('SELECT first'),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true,maxQueue:1});
  const first=session.all('SELECT first');await held.started;
  const abort=new AbortController();
  const cancelled=session.all('SELECT cancelled',[],{signal:abort.signal});
  const cancelledResult=cancelled.then(()=>null,error=>error.code);
  const overflow=session.all('SELECT overflow');
  const overflowResult=overflow.then(()=>null,error=>error.code);
  abort.abort();
  const fourth=session.all('SELECT after-cancel');
  const fourthResult=fourth.then(value=>value,error=>error);
  held.release();
  try {
    await first;
    assert.equal(await cancelledResult,'ABORTED');
    assert.equal(await overflowResult,'QUEUE_FULL');
    assert.deepEqual(await fourthResult,[{value:'ok'}]);
    assert.ok(!d.calls.includes('SELECT cancelled')&&!d.calls.includes('SELECT overflow'));
  } finally {await Promise.allSettled([first,cancelled,overflow,fourth]);await session.close();}
});

test('aborting an issued readOnly root read drains it before rollback and returns the transaction abort',async()=>{
  const d=engine(),held=d.hold('SELECT held'),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true});
  const abort=new AbortController(),run=session.all('SELECT held',[],{signal:abort.signal});
  const outcome=run.then(()=>null,error=>error.code);
  await held.started;abort.abort();
  await new Promise(resolve=>setImmediate(resolve));
  const beforeRelease=[...d.calls];held.release();
  try {
    assert.ok(!beforeRelease.includes('ROLLBACK'));
    assert.equal(await outcome,'ABORTED');
    assert.deepEqual(d.calls,['BEGIN READ ONLY','SELECT held','ROLLBACK']);
  }finally{await run.catch(()=>{});await session.close();}
});

test('an acknowledged readOnly root COMMIT wins over a late abort after send',async()=>{
  const d=engine(),held=d.hold('COMMIT'),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true});
  const abort=new AbortController(),run=session.all('SELECT fixture',[],{signal:abort.signal});
  await held.started;abort.abort();held.release();
  try{
    assert.deepEqual(await run,[{value:'ok'}]);
    assert.deepEqual(d.calls,['BEGIN READ ONLY','SELECT fixture','COMMIT']);
  }finally{await session.close();}
});

test('readOnly root requests use transaction lifecycle: await the request before closing',async()=>{
  const d=engine(),held=d.hold('SELECT held'),session=createAsyncSession(d.executor,{dialect:'postgresql',readOnly:true});
  const run=session.all('SELECT held');
  const outcome=run.then(value=>({value}),error=>({error}));
  let closing,timer;
  try {
    await held.started;
    closing=session.close().then(()=>undefined,error=>error);
    const result=await Promise.race([closing,new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),50);})]);
    assert.equal(result?.code,'TRANSACTION_ACTIVE');
    assert.ok(!d.calls.includes('CLOSE'));
  }finally{clearTimeout(timer);held.release();await outcome;await closing;await session.close();}
  assert.deepEqual(await outcome,{value:[{value:'ok'}]});
  assert.deepEqual(d.calls,['BEGIN READ ONLY','SELECT held','COMMIT','CLOSE']);
});
