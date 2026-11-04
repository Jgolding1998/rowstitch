// Actual engine checks of the internal structural context, not full PostgreSQL ORM support.
import assert from 'node:assert/strict';
import { createAsyncSession } from '../../dist/core/async-session.js';
import { createPostgresExecutor } from '../../dist/core/postgres-executor.js';
import { isPostgresRawResult } from '../../dist/core/postgres-result.js';
import { column,defineTable } from '../../dist/core/schema.js';
import { openPostgresRoots } from '../../dist/core/postgres-roots.js';
const code=wanted=>error=>error?.code===wanted;
export async function checkVerifiedRoots(connect){
  const cases=[];
  async function fixture(suffix,callback,{create=true,readOnly=false}={}){
    const name='verified_'+suffix,table=defineTable(name,{id:column.integer().primaryKey(),label:column.text(),ratio:column.real()});
    const native=await connect();let session,hook,failed=false;const sent=[];
    try{
      if(create)await native.query('CREATE TABLE public."'+name+'"(id BIGINT PRIMARY KEY,label TEXT NOT NULL,ratio DOUBLE PRECISION NOT NULL)',[]);
      const wrapped={...native,async query(sql,values){sent.push(sql);const result=await native.query(sql,values);return hook?await hook(sql,result,native):result;}};
      session=createAsyncSession(createPostgresExecutor(wrapped),{dialect:'postgresql',isResult:isPostgresRawResult,readOnly});
      await callback({name,table,native,session,sent,hook(fn){hook=fn;},roots(){return openPostgresRoots(session,{tables:[table],readOnly});}});
    }catch(error){failed=true;throw error;}
    finally{try{if(session)await session.close();await native.close();}catch(error){if(!failed)throw error;}}
  }
  await fixture('basic',async f=>{
    const roots=await f.roots(),input={id:1,label:"SYNTHETIC_' OR 1=1--",ratio:0.30000000000000004};
    assert.deepEqual(await roots.insert(f.table,input),input);assert.deepEqual(await roots.byKey(f.table,{id:1}),input);assert.equal(await roots.count(f.table),1);
    assert.deepEqual((await f.native.query('SELECT id::text,label,ratio::text FROM ONLY public.verified_basic',[])).rows,[['1',input.label,String(input.ratio)]]);
    cases.push('verified insert, key and count match independent native SQL with exact float and bound text');
    const original=(await f.native.query('SHOW extra_float_digits',[])).rows[0][0];
    await f.native.query('SET extra_float_digits = 0',[]);
    assert.equal((await f.native.query('SELECT ratio::text FROM ONLY public.verified_basic',[])).rows[0][0],'0.3');
    await assert.rejects(roots.byKey(f.table,{id:1}),code('DATA'));
    await f.native.query("SELECT pg_catalog.set_config('extra_float_digits',$1,false)",[original]);
    const length=f.sent.length;await assert.rejects(roots.count(f.table),code('DATA'));assert.equal(f.sent.length,length);
    assert.deepEqual(await(await f.roots()).byKey(f.table,{id:1}),input);
    cases.push('actual precision drift is refused; old context stays latched and a fresh context reads the exact stored value');
  });
  await fixture('post_drift',async f=>{
    const roots=await f.roots(),original=(await f.native.query('SHOW extra_float_digits',[])).rows[0][0];
    f.hook(async(sql,result,native)=>{if(sql.startsWith('INSERT '))await native.query('SET LOCAL extra_float_digits = 0',[]);return result;});
    await assert.rejects(roots.insert(f.table,{id:1,label:'post-statement drift',ratio:1.2345678901234567}),code('DATA'));
    assert.equal((await f.native.query('SELECT count(*)::text FROM ONLY public.verified_post_drift',[])).rows[0][0],'0');
    assert.equal((await f.native.query('SHOW extra_float_digits',[])).rows[0][0],original);
    assert.ok(!f.sent.slice(f.sent.lastIndexOf('BEGIN ISOLATION LEVEL SERIALIZABLE')).includes('COMMIT'));
    cases.push('setting changed by a deliberate post-INSERT hook is caught before COMMIT and the actual row rolls back');
  });
  await fixture('recovery',async f=>{
    const roots=await f.roots();let inject=true;
    f.hook(async(sql,result)=>{if(inject&&sql.startsWith('INSERT ')){inject=false;return {...result,fields:result.fields.map((field,i)=>i?field:{...field,typeOid:25})};}return result;});
    await roots.transaction(async tx=>{
      await assert.rejects(tx.insert(f.table,{id:1,label:'injected OID',ratio:1}),code('DATA'));
      assert.deepEqual(await tx.insert(f.table,{id:2,label:'good parent',ratio:2}),{id:2,label:'good parent',ratio:2});
      await assert.rejects(tx.insert(f.table,{id:2,label:'duplicate',ratio:2}),code('CONSTRAINT'));
    });
    assert.deepEqual((await f.native.query('SELECT id::text,label FROM ONLY public.verified_recovery ORDER BY id',[])).rows,[['2','good parent']]);
    cases.push('injected OID mismatch and an actual duplicate-key rejection roll back child savepoints and permit a valid parent commit');
  });
  await fixture('child_drift',async f=>{
    const roots=await f.roots();let drift=false;
    f.hook(async(sql,result,native)=>{if(drift&&sql.startsWith('INSERT '))await native.query("SET LOCAL session_replication_role = 'replica'",[]);return result;});
    await assert.rejects(roots.transaction(async tx=>{
      await tx.insert(f.table,{id:1,label:'before drift',ratio:1});drift=true;
      await assert.rejects(tx.insert(f.table,{id:2,label:'drift',ratio:2}),code('DATA'));
    }),code('DATA'));
    assert.equal((await f.native.query('SELECT count(*)::text FROM ONLY public.verified_child_drift',[])).rows[0][0],'0');
    assert.equal((await f.native.query('SHOW session_replication_role',[])).rows[0][0],'origin');
    cases.push('caught child replication-role drift latches the context and rolls back earlier native parent work too');
  });
  await fixture('replaced',async f=>{
    const roots=await f.roots();await f.native.query('DROP TABLE public.verified_replaced',[]);
    await f.native.query('CREATE TABLE public.verified_replaced(id BIGINT PRIMARY KEY,label TEXT NOT NULL,ratio DOUBLE PRECISION NOT NULL)',[]);
    await assert.rejects(roots.insert(f.table,{id:1,label:'stale identity',ratio:1}),code('SCHEMA'));
    assert.equal((await f.native.query('SELECT count(*)::text FROM ONLY public.verified_replaced',[])).rows[0][0],'0');
    cases.push('identical-shape drop and recreate changes the native OID and refuses a write');
  });
  await fixture('readonly',async f=>{
    const roots=await f.roots();assert.equal(await roots.count(f.table),0);const length=f.sent.length;
    await assert.rejects(roots.insert(f.table,{id:1,label:'refused',ratio:1}),code('READ_ONLY'));assert.equal(f.sent.length,length);
    await roots.transaction(async tx=>{assert.equal(await tx.count(f.table),0);});
    cases.push('actual read-only sessions can open, lock and read; mapped writes send no SQL');
  },{readOnly:true});
  await fixture('hidden',async f=>{
    const roots=await f.roots();f.hook(async(sql,result)=>{if(sql==='COMMIT')throw new Error('synthetic post-ack loss');return result;});
    await assert.rejects(roots.insert(f.table,{id:1,label:'durable',ratio:1}),code('COMMIT_UNCONFIRMED'));
    assert.equal(f.sent.filter(sql=>sql.startsWith('INSERT ')).length,1);assert.ok(!f.sent.includes('ROLLBACK'));
    await assert.rejects(roots.count(f.table),code('CONNECTION_UNUSABLE'));
  });
  await fixture('hidden',async f=>{
    assert.deepEqual(await(await f.roots()).byKey(f.table,{id:1}),{id:1,label:'durable',ratio:1});
    cases.push('applied COMMIT with deliberately hidden ACK stays unknown and is not replayed; a fresh context proves the durable row');
  },{create:false});
  return {cases,limitations:['Fixed schemas on dedicated connections; OID, post-statement setting and hidden-ACK faults are deliberate injection.','Native concurrent-DDL exclusion, roles, pool behavior and arbitrary schema support need separate checks.']};
}
