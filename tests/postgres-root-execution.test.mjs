import test from 'node:test';
import assert from 'node:assert/strict';
import { column,defineTable } from '../dist/core/schema.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { isPostgresRawResult,snapshotPostgresResult } from '../dist/core/postgres-result.js';
import { compilePostgresRoot,planPostgresByKey,planPostgresInsert } from '../dist/core/postgres-root-plan.js';
import { executePostgresRoot } from '../dist/core/postgres-root-execution.js';

const table=defineTable('execution_samples',{id:column.integer().primaryKey(),name:column.text()});
const insert=compilePostgresRoot(planPostgresInsert(table,{id:1,name:'fictional'}));
const select=compilePostgresRoot(planPostgresByKey(table,{id:1}));
const code=wanted=>error=>error?.code===wanted;
function fixture({bad=false,held=false}={}){
  let active=false,release,started;
  const gate=new Promise(ok=>{release=ok;}),reached=new Promise(ok=>{started=ok;});
  const calls=[];
  const session=createAsyncSession({
    async all(sql){calls.push(sql);started();if(held)await gate;
      return snapshotPostgresResult({command:sql.startsWith('INSERT')?'INSERT':'SELECT',rowCount:1n,fields:[{name:'__rs_pg_0',typeOid:bad?25:20},{name:'__rs_pg_1',typeOid:25}],rows:[['1','fictional']]});},
    async exec(sql){calls.push(sql);if(sql.startsWith('BEGIN'))active=true;if(sql==='COMMIT'||sql==='ROLLBACK')active=false;},
    async inTransaction(){return active;},async close(){calls.push('CLOSE');},
  },{dialect:'postgresql',isResult:isPostgresRawResult});
  return {session,calls,release,reached};
}

test('mapped writes decode and commit in an automatic transaction; reads use the same owner',async()=>{
  const f=fixture();try{
    assert.deepEqual(await executePostgresRoot(f.session,insert),{id:1,name:'fictional'});
    assert.deepEqual(f.calls,['BEGIN ISOLATION LEVEL SERIALIZABLE',insert.sql,'COMMIT']);
    assert.deepEqual(await executePostgresRoot(f.session,select),{id:1,name:'fictional'});
    assert.equal(f.calls.at(-1),select.sql);
  }finally{await f.session.close();}
});

test('a decoder failure rolls back before COMMIT and preserves a reusable session',async()=>{
  const f=fixture({bad:true});try{
    await assert.rejects(executePostgresRoot(f.session,insert),code('DATA'));
    assert.deepEqual(f.calls,['BEGIN ISOLATION LEVEL SERIALIZABLE',insert.sql,'ROLLBACK']);
    assert.ok(!f.calls.includes('COMMIT'));
    await assert.rejects(executePostgresRoot(f.session,select),code('DATA'));
    assert.equal(f.calls.at(-1),select.sql,'data validation does not invent a transport failure');
  }finally{await f.session.close();}
});

test('writes inside a transaction use a child savepoint and remain subject to the outer rollback',async()=>{
  const f=fixture();const failure=new Error('fictional callback failure');
  try{
    await assert.rejects(f.session.transaction(async tx=>{assert.deepEqual(await executePostgresRoot(tx,insert),{id:1,name:'fictional'});throw failure;}),error=>error===failure);
    assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL SERIALIZABLE');assert.match(f.calls[1],/^SAVEPOINT /);
    assert.equal(f.calls[2],insert.sql);assert.match(f.calls[3],/^RELEASE SAVEPOINT /);assert.equal(f.calls[4],'ROLLBACK');
    assert.ok(!f.calls.includes('COMMIT'));
  }finally{await f.session.close();}
});

test('pre-aborted operations and forged statements send no SQL',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  try{
    await assert.rejects(executePostgresRoot(f.session,insert,{signal:abort.signal}),code('ABORTED'));
    await assert.rejects(executePostgresRoot(f.session,select,{signal:abort.signal}),code('ABORTED'));
    await assert.rejects(executePostgresRoot(f.session,{...insert}),code('QUERY'));
    assert.deepEqual(f.calls,[]);
  }finally{await f.session.close();}
});

test('a forgotten mapped operation still pending at callback settlement cannot be committed',async()=>{
  const f=fixture({held:true});let work;
  const running=f.session.transaction(async tx=>{work=executePostgresRoot(tx,select);await f.reached;});
  const result=running.then(()=>undefined,error=>error.code);
  try{
    await f.reached;await new Promise(ok=>setImmediate(ok));
    assert.ok(!f.calls.includes('COMMIT'));f.release();
    assert.equal(await result,'TRANSACTION_PENDING');
    // Issued reads may finish with provisional data; the transaction promise is what establishes rollback/commit.
    assert.deepEqual(await work,{id:1,name:'fictional'});
    assert.ok(f.calls.includes('ROLLBACK'));assert.ok(!f.calls.includes('COMMIT'));
  }finally{f.release();await running.catch(()=>{});await f.session.close();}
});
