import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSession } from '../dist/core/async-session.js';
import { isPostgresRawResult,snapshotPostgresResult } from '../dist/core/postgres-result.js';
import { column,defineTable } from '../dist/core/schema.js';
import { openPostgresRoots } from '../dist/core/postgres-roots.js';
const table=defineTable('verified_rows',{id:column.integer().primaryKey(),label:column.text()});
const code=wanted=>error=>error?.code===wanted&&!error.message.includes('SYNTHETIC_PRIVATE_VALUE');
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};};
const columnMeta=(name,position,typeOid)=>({name,position,typeOid,typeModifier:-1,arrayDimensions:0,notNull:true,notNullValid:true,hasDefault:false,identity:'',generated:'',collationOid:typeOid===25?100:0});
function fixture(){
  const calls=[],settings={serverVersion:180006,clientEncoding:'UTF8',serverEncoding:'UTF8',extraFloatDigits:1,replicationRole:'origin',searchPath:'"$user", public'};
  const metadata={format:'rowstitch-postgres-physical-v1',serverVersion:180006,schema:'public',name:'verified_rows',oid:20000,
    relation:{kind:'r',persistence:'p',isPartition:false,hasDescendants:false,hasAncestors:false,rowSecurity:false,forceRowSecurity:false,hasRules:false,userTriggers:0},
    columns:[columnMeta('id',1,20),columnMeta('label',2,25)],indexes:[{oid:20001,primary:true,unique:true,valid:true,ready:true,live:true,immediate:true,nullsNotDistinct:false,keyColumns:['id'],includedColumns:[],collationOids:[0],hasExpressions:false,partial:false}]};
  let active=false,rows=[],badOid=false,afterInsert,afterCount,afterSettings,heldRead,hideCommit=false,failRollback=false;
  const snapshots=[];
  const raw=(command,fields=[],values=[],rowCount=BigInt(values.length))=>snapshotPostgresResult({command,fields,rows:values,rowCount});
  const json=(name,value)=>raw('SELECT',[{name,typeOid:3802}],[[JSON.stringify(value)]]);
  const session=createAsyncSession({
    async all(sql,parameters=[]){
      calls.push(sql);
      if(sql.startsWith('LOCK '))return raw('LOCK',[],[],null);
      if(sql.includes('AS "__rs_pg_settings"')){const result=json('__rs_pg_settings',settings);afterSettings?.();return result;}
      if(sql.includes('AS "__rs_pg_catalog"'))return json('__rs_pg_catalog',metadata);
      let result;
      if(sql.startsWith('INSERT ')){
        rows.push([String(parameters[0]),parameters[1]]);afterInsert?.();
        result=raw('INSERT',[{name:'__rs_pg_0',typeOid:badOid?25:20},{name:'__rs_pg_1',typeOid:25}],[rows.at(-1)]);
      }else if(sql.includes('AS "__rs_pg_count"')){result=raw('SELECT',[{name:'__rs_pg_count',typeOid:20}],[[String(rows.length)]]);afterCount?.();}
      else result=raw('SELECT',[{name:'__rs_pg_0',typeOid:20},{name:'__rs_pg_1',typeOid:25}],rows.filter(row=>row[0]===String(parameters[0])));
      if(heldRead&&sql.startsWith('SELECT ')){heldRead.reached.resolve();await heldRead.release.promise;}
      return result;
    },
    async exec(sql){
      calls.push(sql);
      if(sql.startsWith('BEGIN')){active=true;snapshots.push(structuredClone(rows));}
      else if(sql.startsWith('SAVEPOINT '))snapshots.push(structuredClone(rows));
      else if(sql.startsWith('ROLLBACK TO '))rows=structuredClone(snapshots.at(-1));
      else if(sql.startsWith('RELEASE '))snapshots.pop();
      else if(sql==='ROLLBACK'){if(failRollback)throw new Error('SYNTHETIC_PRIVATE_VALUE');rows=snapshots[0];snapshots.length=0;active=false;}
      else if(sql==='COMMIT'){snapshots.length=0;active=false;if(hideCommit)throw new Error('SYNTHETIC_PRIVATE_VALUE');}
    },
    async inTransaction(){return active;},async close(){calls.push('CLOSE');}
  },{dialect:'postgresql',isResult:isPostgresRawResult});
  return {session,calls,settings,metadata,rows:()=>structuredClone(rows),badOid(value){badOid=value;},afterInsert(fn){afterInsert=fn;},afterCount(fn){afterCount=fn;},afterSettings(fn){afterSettings=fn;},hideCommit(){hideCommit=true;},failRollback(){failRollback=true;},holdRead(){heldRead={reached:deferred(),release:deferred()};return heldRead;}};
}
const open=async f=>{const roots=await openPostgresRoots(f.session,{tables:[table]});f.calls.length=0;return roots;};
const kind=sql=>sql.includes('AS "__rs_pg_catalog"')?'CATALOG':sql.includes('AS "__rs_pg_settings"')?'SETTINGS':sql.startsWith('INSERT ')?'INSERT':sql.startsWith('SELECT ')?'SELECT':sql;

test('verified root writes lock and recheck before writing, with nothing after COMMIT',async()=>{
  const f=fixture();try{const roots=await open(f);
    assert.deepEqual(await roots.insert(table,{id:1,label:'fictional'}),{id:1,label:'fictional'});
    assert.deepEqual(f.calls.map(kind),['BEGIN ISOLATION LEVEL SERIALIZABLE','LOCK TABLE ONLY "public"."verified_rows" IN ROW EXCLUSIVE MODE','CATALOG','SETTINGS','INSERT','SETTINGS','COMMIT']);
    assert.deepEqual(f.rows(),[['1','fictional']]);f.calls.length=0;
    assert.deepEqual(await roots.byKey(table,{id:1}),{id:1,label:'fictional'});
    assert.deepEqual(f.calls.map(kind),['BEGIN ISOLATION LEVEL SERIALIZABLE','LOCK TABLE ONLY "public"."verified_rows" IN ACCESS SHARE MODE','CATALOG','SETTINGS','SELECT','SETTINGS','COMMIT']);
    assert.equal(await roots.count(table),1);
  }finally{await f.session.close();}
});
test('open rejects bad settings or physical mappings before returning any context',async()=>{
  for(const [edit,wanted] of [[f=>{f.settings.extraFloatDigits=0;},'DATA'],[f=>{f.metadata.columns[0].typeOid=23;},'SCHEMA']]){
    const f=fixture();try{edit(f);await assert.rejects(open(f),code(wanted));assert.equal(f.calls.at(-1),'ROLLBACK');assert.ok(!f.calls.some(sql=>sql.startsWith('INSERT ')));}finally{await f.session.close();}
  }
});
test('legacy verified roots refuse a mapping before starting a transaction or inspecting its logical decoy', async () => {
  const f = fixture();
  try {
    const unsupported = [
      defineTable(table.name, table.columns, { storage: { table: 'SYNTHETIC_PRIVATE_VALUE' } }),
      defineTable(table.name, table.columns, { storage: { schema: 'SYNTHETIC_PRIVATE_VALUE' } }),
      defineTable(table.name, { ...table.columns, label: table.columns.label.storedAs('Label') }),
    ];
    for (const mapped of unsupported) {
      await assert.rejects(openPostgresRoots(f.session, { tables: [mapped] }), code('SCHEMA'));
      assert.deepEqual(f.calls, []);
    }
    const identity = defineTable(table.name, { ...table.columns, label: table.columns.label.storedAs('label') },
      { storage: { table: table.name, schema: 'public' } });
    const roots = await openPostgresRoots(f.session, { tables: [identity] });
    assert.equal(await roots.count(identity), 0);
    assert.ok(f.calls.includes('LOCK TABLE ONLY "public"."verified_rows" IN ACCESS SHARE MODE'));
  } finally { await f.session.close(); }
});
test('drop/recreate identity and structural drift refuse before INSERT and latch the context',async()=>{
  for(const edit of [f=>{f.metadata.oid++;},f=>{f.metadata.relation.userTriggers=1;},f=>{f.metadata.indexes[0].immediate=false;}]){
    const f=fixture();try{const roots=await open(f);edit(f);
      await assert.rejects(roots.insert(table,{id:1,label:'fictional'}),code('SCHEMA'));assert.equal(f.calls.at(-1),'ROLLBACK');assert.deepEqual(f.rows(),[]);
      const length=f.calls.length;await assert.rejects(roots.count(table),code('SCHEMA'));assert.equal(f.calls.length,length);
    }finally{await f.session.close();}
  }
});
test('post-statement settings drift rolls back the write before decoding or COMMIT',async()=>{
  const f=fixture();try{const roots=await open(f);f.afterInsert(()=>{f.settings.extraFloatDigits=0;});
    await assert.rejects(roots.insert(table,{id:1,label:'fictional'}),code('DATA'));assert.deepEqual(f.rows(),[]);assert.equal(f.calls.at(-1),'ROLLBACK');assert.ok(!f.calls.includes('COMMIT'));
    f.settings.extraFloatDigits=1;const length=f.calls.length;await assert.rejects(roots.count(table),code('DATA'));assert.equal(f.calls.length,length);
  }finally{await f.session.close();}
});
test('a caught child drift still prevents the parent committing its earlier valid write',async()=>{
  const f=fixture();try{const roots=await open(f);
    await assert.rejects(roots.transaction(async tx=>{
      await tx.insert(table,{id:1,label:'before drift'});f.afterInsert(()=>{f.settings.replicationRole='replica';});
      await assert.rejects(tx.insert(table,{id:2,label:'drift'}),code('DATA'));
    }),code('DATA'));
    assert.deepEqual(f.rows(),[]);assert.ok(f.calls.some(sql=>sql.startsWith('ROLLBACK TO ')));assert.equal(f.calls.at(-1),'ROLLBACK');assert.ok(!f.calls.includes('COMMIT'));
  }finally{await f.session.close();}
});
test('ordinary decoder failures roll back only the child and permit valid parent work',async()=>{
  const f=fixture();try{const roots=await open(f);
    await roots.transaction(async tx=>{f.badOid(true);await assert.rejects(tx.insert(table,{id:1,label:'bad'}),code('DATA'));f.badOid(false);await tx.insert(table,{id:2,label:'good'});assert.equal(await tx.count(table),1);});
    assert.deepEqual(f.rows(),[['2','good']]);assert.equal(f.calls.at(-1),'COMMIT');
  }finally{await f.session.close();}
});
test('hidden COMMIT remains unconfirmed with no replay or rollback',async()=>{
  const f=fixture();try{const roots=await open(f);f.hideCommit();
    await assert.rejects(roots.insert(table,{id:1,label:'durable'}),code('COMMIT_UNCONFIRMED'));
    assert.deepEqual(f.rows(),[['1','durable']]);assert.equal(f.calls.filter(sql=>sql.startsWith('INSERT ')).length,1);assert.ok(!f.calls.includes('ROLLBACK'));
    await assert.rejects(roots.count(table),code('CONNECTION_UNUSABLE'));
  }finally{await f.session.close();}
});
test('read-only contexts, pre-aborts and malformed requests send no write or transaction SQL',async()=>{
  const f=fixture();try{const roots=await openPostgresRoots(f.session,{tables:[table],readOnly:true});f.calls.length=0;
    await assert.rejects(roots.insert(table,{id:1,label:'no'}),code('READ_ONLY'));
    const abort=new AbortController();abort.abort();await assert.rejects(roots.count(table,{signal:abort.signal}),code('ABORTED'));
    await assert.rejects(roots.count({...table}),code('SCHEMA'));await assert.rejects(roots.count(table,{signal:{}}),code('VALIDATION'));
    assert.deepEqual(f.calls,[]);assert.equal(await roots.count(table),0);
    assert.ok(f.calls.some(sql=>sql.includes('ACCESS SHARE')));assert.ok(!f.calls.some(sql=>sql.includes('ROW EXCLUSIVE')));
  }finally{await f.session.close();}
});
test('escaped handles, root use inside a callback and immutable call-time values follow the session contract',async()=>{
  const f=fixture();try{const roots=await open(f);let escaped;
    await roots.transaction(async tx=>{escaped=tx;await assert.rejects(roots.count(table),code('TRANSACTION_ACTIVE'));const row={id:1,label:'captured'};const pending=tx.insert(table,row);row.label='changed';assert.deepEqual(await pending,{id:1,label:'captured'});});
    const length=f.calls.length;await assert.rejects(escaped.count(table),code('TRANSACTION_CLOSED'));assert.equal(f.calls.length,length);
  }finally{await f.session.close();}
});
test('forgotten issued work cannot be drained by a final library check and then committed',async()=>{
  const f=fixture();try{const roots=await open(f),held=f.holdRead();let forgotten;
    const transaction=roots.transaction(async tx=>{forgotten=tx.count(table);await held.reached.promise;});
    const outcome=transaction.then(()=> 'incorrect success',error=>error.code);
    await held.reached.promise;await new Promise(ok=>setImmediate(ok));held.release.resolve();
    assert.equal(await outcome,'TRANSACTION_PENDING');await assert.rejects(forgotten,code('TRANSACTION_CLOSED'));
    assert.ok(!f.calls.includes('COMMIT'));assert.equal(f.calls.at(-1),'ROLLBACK');
  }finally{await f.session.close();}
});

test('drift from forgotten work vetoes COMMIT across the callback-settlement microtask window',async()=>{
  for(let tick=0;tick<90;tick++){
    const f=fixture();try{
      const roots=await open(f),gate=deferred();let afterCount=false,forgotten;
      const outcome=await roots.transaction(async tx=>{
        await tx.insert(table,{id:1,label:'before drift'});
        f.afterCount(()=>{f.settings.replicationRole='replica';afterCount=true;});
        f.afterSettings(()=>{if(afterCount){afterCount=false;gate.resolve();}});
        forgotten=tx.count(table).then(()=> 'unexpected success',error=>error.code);
        await gate.promise;for(let i=0;i<tick;i++)await null;
        return 'callback value';
      }).then(()=> 'unexpected success',error=>error.code);
      assert.ok(['DATA','TRANSACTION_PENDING'].includes(outcome),'tick '+tick+' must reject, got '+outcome);
      assert.ok(['DATA','TRANSACTION_CLOSED'].includes(await forgotten));
      assert.ok(!f.calls.includes('COMMIT'),'tick '+tick+' must not send COMMIT');assert.deepEqual(f.rows(),[]);
    }finally{await f.session.close();}
  }
});
test('a stateful then that catches child drift after the final check still cannot commit',async()=>{
  const f=fixture();try{
    const roots=await open(f);let reads=0,drift=false,caught;
    f.afterInsert(()=>{if(drift)f.settings.replicationRole='replica';});
    await assert.rejects(roots.transaction(async tx=>{
      await tx.insert(table,{id:1,label:'before drift'});
      return {get then(){
        if(++reads!==2)return undefined;
        return resolve=>{drift=true;tx.insert(table,{id:2,label:'drift'}).catch(error=>{caught=error.code;drift=false;resolve('value');});};
      }};
    }),code('DATA'));
    assert.ok(['DATA','TRANSACTION_CLOSED'].includes(caught));assert.ok(!f.calls.includes('COMMIT'));assert.deepEqual(f.rows(),[]);
  }finally{await f.session.close();}
});
test('drift cancellation never erases an unconfirmed rollback or claims its cleanup succeeded',async()=>{
  const f=fixture();try{
    const roots=await open(f);let reads=0,drift=false;
    f.afterInsert(()=>{if(drift)f.settings.replicationRole='replica';});f.failRollback();
    const error=await roots.transaction(async tx=>{
      await tx.insert(table,{id:1,label:'before drift'});
      return {get then(){
        if(++reads!==2)return undefined;
        return resolve=>{drift=true;tx.insert(table,{id:2,label:'drift'}).catch(()=>{resolve('value');});};
      }};
    }).then(()=>assert.fail('must reject'),error=>error);
    assert.equal(error.code,'ABORTED');assert.equal(error.rowstitchCleanup?.connectionUnusable,true);
    assert.ok(!f.calls.includes('COMMIT'));await assert.rejects(f.session.all('SELECT 1'),code('CONNECTION_UNUSABLE'));
  }finally{await f.session.close();}
});
test('manual roots transactions preserve the caller signal through the internal commit veto',{timeout:5000},async()=>{
  const f=fixture(),gate=deferred(),started=deferred(),abort=new AbortController();let work;
  try{
    const roots=await open(f);
    work=roots.transaction(async tx=>{await tx.insert(table,{id:1,label:'cancelled'});started.resolve();await gate.promise;},{signal:abort.signal});
    const outcome=work.then(()=> 'unexpected success',error=>error.code);
    await started.promise;abort.abort();assert.equal(await outcome,'ABORTED');
    assert.deepEqual(f.rows(),[]);assert.ok(!f.calls.includes('COMMIT'));
    assert.equal(await roots.count(table),0,'user cancellation does not latch a healthy context');
  }finally{gate.resolve();await work?.catch(()=>{});await f.session.close();}
});
