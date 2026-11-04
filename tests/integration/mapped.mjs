// Narrow internal root-query conformance checks. These do not establish public PostgreSQL ORM support.
import assert from 'node:assert/strict';
import { createAsyncSession } from '../../dist/core/async-session.js';
import { createPostgresExecutor } from '../../dist/core/postgres-executor.js';
import { isPostgresRawResult } from '../../dist/core/postgres-result.js';
import { column,defineTable } from '../../dist/core/schema.js';
import { compilePostgresRoot,planPostgresByKey,planPostgresCount,planPostgresInsert } from '../../dist/core/postgres-root-plan.js';
import { executePostgresRoot } from '../../dist/core/postgres-root-execution.js';
const code=wanted=>error=>error?.code===wanted;
const table=defineTable('mapped_roots',{id:column.integer().primaryKey(),exact:column.bigint(),enabled:column.boolean(),data:column.json(),label:column.text().nullable(),ratio:column.real()});
const duplicate=defineTable('mapped_duplicates',{id:column.integer().primaryKey(),name:column.text()});
const sample=id=>({id,exact:9223372036854775807n,enabled:true,data:JSON.parse('{"__proto__":{"polluted":true},"nested":[1,true]}'),label:"SYNTHETIC_' OR 1=1--",ratio:-0});
const insert=(row)=>compilePostgresRoot(planPostgresInsert(table,row));
const count=compilePostgresRoot(planPostgresCount(table));
export async function checkMappedRoots(name,connect){
  const cases=[];let context,failed=false;
  async function start({readOnly=false,hideCommit=false}={}){
    const transport=await connect();let inject=false;const sent=[];
    const wrapped={...transport,async query(sql,parameters){sent.push(sql);const r=await transport.query(sql,parameters);
      if(hideCommit&&sql==='COMMIT')throw new Error('synthetic post-ack loss');
      if(inject&&sql.startsWith('INSERT')){inject=false;return {...r,fields:r.fields.map((field,i)=>i?field:{...field,typeOid:25})};}return r;}};
    const session=createAsyncSession(createPostgresExecutor(wrapped),{dialect:'postgresql',readOnly,isResult:isPostgresRawResult});
    return {session,transport,sent,inject(){inject=true;},async close(){await session.close();await transport.close();}};
  }
  try{
    context=await start();const {session,transport}=context;
    await transport.query('CREATE TABLE public.mapped_roots(id BIGINT PRIMARY KEY,exact BIGINT NOT NULL,enabled BOOLEAN NOT NULL,data JSONB NOT NULL,label TEXT NULL,ratio DOUBLE PRECISION NOT NULL)',[]);
    const input=sample(1),logical=planPostgresInsert(table,input);input.label='changed';input.data.nested[0]=999;
    assert.deepEqual(await executePostgresRoot(session,compilePostgresRoot(logical)),sample(1));assert.equal({}.polluted,undefined);
    const oracle=await transport.query('SELECT id::text,exact::text,enabled::text,data::text,label,ratio::text FROM public.mapped_roots ORDER BY id',[]);
    assert.deepEqual(oracle.rows[0].slice(0,3),['1','9223372036854775807','true']);assert.deepEqual(JSON.parse(oracle.rows[0][3]),sample(1).data);assert.equal(oracle.rows[0][4],sample(1).label);assert.ok(Object.is(Number(oracle.rows[0][5]),-0));
    cases.push('automatic mapped insert commits typed values; independent native SQL verifies capture, int64, bool, JSON proto key and minus zero');
    assert.deepEqual(await executePostgresRoot(session,compilePostgresRoot(planPostgresByKey(table,{id:1}))),sample(1));
    assert.equal(await executePostgresRoot(session,compilePostgresRoot(planPostgresByKey(table,{id:999}))),null);assert.equal(await executePostgresRoot(session,count),1);
    cases.push('compiled key lookup, missing row and count through the actual driver/session');
    const wide={...sample(3),data:Array(6000).fill(1e-300)};
    await assert.rejects(executePostgresRoot(session,insert(wide)),code('DATA'));
    assert.equal((await transport.query('SELECT count(*)::text FROM public.mapped_roots WHERE id=3',[])).rows[0][0],'0');
    assert.equal(await executePostgresRoot(session,count),1);
    cases.push('JSONB normalization expansion fails decoder inside automatic transaction, rolls back and leaves reusable session');
    context.inject();await assert.rejects(executePostgresRoot(session,insert(sample(2))),code('DATA'));
    assert.equal((await transport.query('SELECT count(*)::text FROM public.mapped_roots WHERE id=2',[])).rows[0][0],'0');
    cases.push('injected native OID mismatch rejects write before commit and physical row is absent');
    await transport.query('CREATE TABLE public.mapped_duplicates(id BIGINT NOT NULL,name TEXT NOT NULL)',[]);
    await transport.query('INSERT INTO public.mapped_duplicates VALUES($1,$2),($3,$4)',['1','first','1','second']);
    await assert.rejects(executePostgresRoot(session,compilePostgresRoot(planPostgresByKey(duplicate,{id:1}))),code('DATA'));
    assert.equal((await transport.query('SELECT count(*)::text FROM public.mapped_duplicates',[])).rows[0][0],'2');
    cases.push('a declared key missing its physical constraint returns two rows and is rejected, not silently truncated');
    await session.transaction(async tx=>{
      await assert.rejects(executePostgresRoot(tx,insert({...sample(7),data:Array(6000).fill(1e-300)})),code('DATA'));
      assert.equal(await executePostgresRoot(tx,count),1);assert.deepEqual(await executePostgresRoot(tx,insert(sample(8))),sample(8));
    });
    assert.equal((await transport.query('SELECT count(*)::text FROM public.mapped_roots WHERE id=7',[])).rows[0][0],'0');assert.equal(await executePostgresRoot(session,count),2);
    cases.push('nested mapped decoder failure rolls back its savepoint; parent remains usable and commits a separate mapped write');
    await context.close();context=await start({readOnly:true});
    assert.equal(await executePostgresRoot(context.session,count),2);
    await assert.rejects(executePostgresRoot(context.session,insert(sample(6))),code('READ_ONLY'));
    assert.equal(await executePostgresRoot(context.session,count),2);
    cases.push('read-only mapped count works and automatic mapped insert is refused without poisoning');
    await context.close();context=await start({hideCommit:true});
    await assert.rejects(executePostgresRoot(context.session,insert(sample(99))),code('COMMIT_UNCONFIRMED'));
    assert.equal(context.sent.filter(sql=>sql.startsWith('INSERT')).length,1);assert.ok(!context.sent.includes('ROLLBACK'));
    await assert.rejects(executePostgresRoot(context.session,count),code('CONNECTION_UNUSABLE'));
    await context.close();context=await start();
    assert.deepEqual(await executePostgresRoot(context.session,compilePostgresRoot(planPostgresByKey(table,{id:99}))),sample(99));
    assert.equal(await executePostgresRoot(context.session,count),3);
    cases.push('applied mapped COMMIT with hidden acknowledgment is unconfirmed, not replayed; close/reopen proves its durable row');
    return {cases,limitations:name==='pglite'?['One embedded connection reopened sequentially; no pool/network claim.']:['Dedicated clients only; deliberately hidden ACK is not actual TCP-loss evidence.']};
  }catch(error){failed=true;throw error;}
  finally{if(context){try{await context.close();}catch(error){if(!failed)throw error;}}}
}
