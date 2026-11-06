import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const build=process.env.ROWSTITCH_TEST_DIST ? pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/') : new URL('../dist/',import.meta.url);
const { column, defineTable, eq, hasMany, agg }=await import(new URL('index.js',build));
const { openAsyncDatabaseWithDialect }=await import(new URL('core/async-database.js',build));
const { createPostgresDialect }=await import(new URL('core/postgres-dialect.js',build));
const { decodePostgresDDL }=await import(new URL('core/postgres-ddl.js',build));
const { isPostgresRawResult, snapshotPostgresResult }=await import(new URL('core/postgres-result.js',build));
const { acknowledgedPostgresRejection }=await import(new URL('core/postgres-acknowledgment.js',build));

const items=defineTable('sample_rows',{
  id:column.integer().primaryKey(),label:column.text(),active:column.boolean(),payload:column.json(),score:column.real().nullable(),version:column.integer().default(1),
},{version:'version'});
const fields=[23,1043,16,114,700,23].map((typeOid,i)=>({name:'__rs_pg_'+i,typeOid}));
const raw=(command='SELECT',rows=[['1','Sample','t','{"n":1}','0.1','1']],overrides={})=>snapshotPostgresResult({command,rowCount:BigInt(rows.length),fields,rows,...overrides});
const count=n=>snapshotPostgresResult({command:'SELECT',rowCount:1n,fields:[{name:'__rs_pg_count',typeOid:20}],rows:[[String(n)]]});
const code=expected=>error=>error.code===expected;
async function fixture(t,responses=[],override={},faults={}) {
  const calls=[],controls=[];let inspections=0,closed=0,active=false;
  const executor={
    async all(sql,parameters){calls.push({sql,parameters:[...parameters]});assert.ok(responses.length,'Unexpected database request');const next=responses.shift();return typeof next==='function'?next(sql,parameters):next;},
    async exec(sql){controls.push(sql);if(sql==='ROLLBACK'&&faults.rollback)throw new Error('Fictional lost rollback');if(sql.startsWith('BEGIN'))active=true;else if(sql==='COMMIT'||sql==='ROLLBACK')active=false;},
    async inTransaction(){return active;},async close(){closed++;},
  };
  const runtime={dialect:createPostgresDialect({schema:'sample'}),sessionDialect:'postgresql',isResult:isPostgresRawResult,
    inspectSchema:function*(){inspections++;return [];},...override};
  const db=await openAsyncDatabaseWithDialect(executor,{tables:[items]},runtime);
  t.after(()=>db.close());
  return {db,calls,controls,get inspections(){return inspections;},get closed(){return closed;}};
}

test('native opening uses its schema hook and never sends SQLite catalog SQL',async t=>{
  const f=await fixture(t);assert.equal(f.inspections,1);assert.deepEqual(f.calls,[]);
  assert.deepEqual(await f.db.inspectSchema(),[]);assert.equal(f.inspections,2);
  await assert.rejects(f.db.planSchema(),code('QUERY'));await assert.rejects(f.db.ensureSchema(),code('QUERY'));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.controls,[]);
});
test('native rows normalize once before the shared boolean JSON integer and float codecs',async t=>{
  const f=await fixture(t,[raw()]);
  assert.deepEqual(await f.db.table(items).findMany(),[{id:1,label:'Sample',active:true,payload:{n:1},score:Math.fround(0.1),version:1}]);
  assert.match(f.calls[0].sql,/"sample"\."sample_rows"/);assert.deepEqual(f.calls[0].parameters,['1000','0']);
});
test('native counts reach the shared bigint count contract and return a safe number',async t=>{
  const f=await fixture(t,[count(7)]);assert.equal(await f.db.table(items).count(),7);
});
test('native compiler metadata is checked for empty reads',async t=>{
  const wrong=fields.map((field,i)=>i===2?{...field,typeOid:25}:field);
  const f=await fixture(t,[raw('SELECT',[],{fields:wrong})]);
  await assert.rejects(f.db.table(items).findMany(),code('DATA'));
});
test('insert result decoding happens before commit and preserves ordinary public values',async t=>{
  const f=await fixture(t,[raw('INSERT')]);
  const row=await f.db.table(items).insert({id:1,label:'Sample',active:true,payload:{n:1},score:0.1});
  assert.equal(row.active,true);assert.deepEqual(row.payload,{n:1});
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','COMMIT']);
  assert.deepEqual(f.calls[0].parameters,['1','Sample','true','{"n":1}','0.1']);
});
test('a malformed native write result rejects and rolls back before COMMIT',async t=>{
  const wrong=fields.map((field,i)=>i===0?{...field,typeOid:16}:field);
  const f=await fixture(t,[raw('INSERT',[['t','Sample','t','{}','0','1']],{fields:wrong})]);
  await assert.rejects(f.db.table(items).insert({id:1,label:'Sample',active:true,payload:{},score:0}),code('DATA'));
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','ROLLBACK']);
});
test('the shared maxRows guard aborts native writes without sending UPDATE',async t=>{
  const f=await fixture(t,[count(2)]);
  await assert.rejects(f.db.table(items).update({label:'Changed'},{where:eq(items.col('active'),true),maxRows:1}),code('AFFECTED_ROWS'));
  assert.equal(f.calls.length,1);assert.match(f.calls[0].sql,/count/);
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','ROLLBACK']);
});
test('a native affected-row mismatch rolls the shared guarded transaction back',async t=>{
  const f=await fixture(t,[count(1),raw('UPDATE',[])]);
  await assert.rejects(f.db.table(items).update({label:'Changed'},{where:eq(items.col('id'),1),maxRows:1}),code('AFFECTED_ROWS'));
  assert.equal(f.calls.length,2);assert.match(f.calls[1].sql,/^UPDATE /);
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','ROLLBACK']);
});
test('native optimistic version updates retain conflict and increment semantics',async t=>{
  const f=await fixture(t,[count(1),raw('UPDATE',[['1','Changed','t','{}',null,'2']]),count(0)]);
  const changed=await f.db.table(items).updateVersion({id:1},1,{label:'Changed'});assert.equal(changed.version,2);
  await assert.rejects(f.db.table(items).updateVersion({id:1},1,{label:'Stale'}),code('CONFLICT'));
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','COMMIT','BEGIN ISOLATION LEVEL SERIALIZABLE','ROLLBACK']);
});
test('native pure compilation returns PostgreSQL SQL without running or exposing decoders',async t=>{
  const f=await fixture(t);const compiled=f.db.table(items).compileSelect({where:eq(items.col('active'),true),select:['id'],limit:2});
  assert.deepEqual(Object.keys(compiled).sort(),['parameters','sql']);assert.match(compiled.sql,/"sample"\."sample_rows"/);
  assert.deepEqual(compiled.parameters,['true','2','0']);compiled.parameters.push('caller edit');
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.controls,[]);
});
test('eager compilation is pure while unavailable explanation fails before a root statement runs',async t=>{
  const f=await fixture(t);const children=hasMany(items,{localKey:items.col('id'),foreignKey:items.col('id')});
  const compiled=f.db.table(items).compileSelect({select:['label'],include:{children}});
  assert.deepEqual(Object.keys(compiled).sort(),['parameters','sql']);
  assert.match(compiled.sql,/"label" AS "__rs_pg_0"/);assert.match(compiled.sql,/"id" AS "__rs_pg_1"/);
  await assert.rejects(f.db.table(items).explain(),code('QUERY'));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.controls,[]);
});

test('native summary compilation is pure and its result reaches the shared logical decoder',async t=>{
  const result=snapshotPostgresResult({command:'SELECT',rowCount:1n,
    fields:[{name:'__rs_pg_0',typeOid:20},{name:'__rs_pg_1',typeOid:23}],rows:[['7','0']]});
  const f=await fixture(t,[result]),repo=f.db.table(items),options={select:{n:agg.count()}};
  const compiled=repo.compileAggregate(options);
  assert.deepEqual(Object.keys(compiled).sort(),['parameters','sql']);assert.deepEqual(f.calls,[]);
  assert.deepEqual(await repo.aggregate(options),{n:7});assert.equal(f.calls.length,1);assert.deepEqual(f.controls,[]);
});

test('summary range classification follows session processing and keeps engine details out of public errors and traces',async t=>{
  const failure=()=>{throw acknowledgedPostgresRejection('DATABASE_ERROR','22003');};
  const f=await fixture(t,[failure,count(1),failure]);
  await assert.rejects(f.db.table(items).aggregate({select:{total:agg.sum(items.col('score'))}}),error=>
    error.code==='AGGREGATE_RANGE'&&!error.message.includes('22003'));
  assert.equal(await f.db.table(items).count(),1,'confirmed idle error does not poison session');
  await assert.rejects(f.db.table(items).aggregate({select:{low:agg.min(items.col('score'))}}),code('DATABASE_ERROR'));
  const trace=JSON.stringify(f.db.exportTrace());assert.ok(!trace.includes('22003'));assert.equal(f.calls.length,3);
});
test('native value parameters and rejected results stay out of default traces',async t=>{
  const marker='FICTIONAL_PRIVATE_VALUE';const f=await fixture(t,[raw('INSERT',[['1',marker,'t','{}',null,'1']])]);
  await f.db.table(items).insert({id:1,label:marker,active:true,payload:{},score:null});
  const trace=f.db.exportTrace();assert.ok(!JSON.stringify(trace).includes(marker));assert.ok(trace.queries.some(q=>q.operation==='insert'));
});
test('a missing native result contract cannot fall through to a SQLite-shaped result',async()=>{
  let sent=0,closed=0;
  const executor={async all(){sent++;return [];},async exec(){sent++;},async inTransaction(){return false;},async close(){closed++;}};
  const runtime={dialect:createPostgresDialect(),sessionDialect:'postgresql',isResult:isPostgresRawResult,
    inspectSchema:function*(){yield {sql:'SELECT 1',parameters:[],operation:'schema',table:'',metadata:true};return [];}};
  await assert.rejects(openAsyncDatabaseWithDialect(executor,{tables:[items]},runtime),code('QUERY'));
  assert.equal(sent,0);assert.equal(closed,1);
});
test('zero-step native schema hooks cannot revive closed or expired handles',async t=>{
  const f=await fixture(t);let expired;
  await f.db.transaction(tx=>{expired=tx;});
  const before=f.inspections;
  await assert.rejects(expired.inspectSchema(),code('TRANSACTION_CLOSED'));
  await assert.rejects(expired.planSchema(),code('TRANSACTION_CLOSED'));
  assert.equal(f.inspections,before);
  await f.db.close();
  await assert.rejects(f.db.inspectSchema(),code('CLOSED'));
  await assert.rejects(f.db.planSchema(),code('CLOSED'));
  assert.equal(f.inspections,before);
});
test('a non-callable native result contract is rejected before SQL is sent',async()=>{
  let sent=0,closed=0;
  const executor={async all(){sent++;return [];},async exec(){sent++;},async inTransaction(){return false;},async close(){closed++;}};
  const runtime={dialect:createPostgresDialect(),sessionDialect:'postgresql',isResult:isPostgresRawResult,
    inspectSchema:function*(){yield {sql:'SELECT 1',parameters:[],operation:'schema',table:'',metadata:true,decode:'invalid'};return [];}};
  await assert.rejects(openAsyncDatabaseWithDialect(executor,{tables:[items]},runtime),code('QUERY'));
  assert.equal(sent,0);assert.equal(closed,1);
});
test('native schema hook failures before a request cannot expose private error text',async t=>{
  let inspections=0;const marker='FICTIONAL_PRIVATE_SCHEMA_MARKER';
  const f=await fixture(t,[],{inspectSchema:function*(){if(++inspections===1)return [];throw new Error(marker);}});
  await assert.rejects(f.db.inspectSchema(),error=>error.code==='DATABASE_ERROR'&&!error.message.includes(marker));
  assert.equal(f.calls.length,0);
});
test('native schema hook failures after a request are sanitized too',async t=>{
  let inspections=0;const marker='FICTIONAL_PRIVATE_SCHEMA_MARKER';
  const f=await fixture(t,[count(0)],{inspectSchema:function*(){
    if(++inspections===1)return [];
    yield {sql:'SELECT count(*)',parameters:[],operation:'schema',table:'',metadata:true,decode:()=>[]};
    throw new Error(marker);
  }});
  await assert.rejects(f.db.inspectSchema(),error=>error.code==='DATABASE_ERROR'&&!error.message.includes(marker));
  assert.equal(f.calls.length,1);
});
test('native trace exports identify PostgreSQL and preserve unknown failed-commit outcomes',async t=>{
  const f=await fixture(t);const trace=f.db.exportTrace();
  assert.equal(trace.version,2);
  assert.equal(trace.dialect,'postgresql');
  assert.deepEqual(trace.inspection,{scope:'mapped',registeredTables:1,omittedTables:0});
  assert.deepEqual(trace.mapping.tables[0].physical,{schema:'sample',table:'sample_rows'});
  assert.ok(trace.notes.some(note=>note.includes('unknown outcome even if a later ROLLBACK succeeds')));
});
test('SQLite async exports identify the v2 dialect and distinguish unobserved registrations',async t=>{
  const { openAsyncDatabase }=await import(new URL('index.js',build));
  const db=await openAsyncDatabase(':memory:',{tables:[items]});t.after(()=>db.close());
  const trace=db.exportTrace();
  assert.equal(trace.version,2);
  assert.equal(trace.dialect,'sqlite');
  assert.deepEqual(trace.inspection,{scope:'mapped',registeredTables:1,omittedTables:0});
  assert.deepEqual(trace.mapping.tables[0].physical,{schema:'main',table:'sample_rows'});
  assert.deepEqual(trace.schema,[]);
});
const schemaPlan={table:'sample_rows',action:'create-table',sql:'CREATE TABLE sample.sample_rows(id integer PRIMARY KEY)'};
const createAck=()=>snapshotPostgresResult({command:'CREATE',rowCount:null,fields:[],rows:[]});
function* schemaEnsure(schema) {
  yield {...schemaPlan,parameters:[],operation:'schema',control:true,decode:decodePostgresDDL};
  return {plans:[schemaPlan],schema};
}
test('native ensure captures its schema before COMMIT without post-commit inspection',async t=>{
  const identity={schema:'sample',table:'sample_rows'};
  const schema=[{name:'sample_rows',identity,coverage:{scope:'mapped',columns:'all'},columns:[],foreignKeys:[],indexes:[]}];
  const f=await fixture(t,[createAck()],{ensureSchema:()=>schemaEnsure(schema)});
  assert.deepEqual(await f.db.ensureSchema(),[schemaPlan]);assert.equal(f.inspections,1);
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','COMMIT']);
  assert.deepEqual(f.db.exportTrace().schema,[{name:'sample_rows',identity,coverage:{columns:'all'},columns:[],foreignKeys:[]}]);
});
test('nested native ensure publishes its trace schema to the root only after the outer commit', async t => {
  const identity = { schema: 'sample', table: 'sample_rows' };
  const schema = [{ name: 'sample_rows', identity, coverage: { scope: 'mapped', columns: 'all' }, columns: [], foreignKeys: [], indexes: [] }];
  const f = await fixture(t, [createAck(), createAck()], { ensureSchema: () => schemaEnsure(schema) });
  const observed = [{ name: 'sample_rows', identity, coverage: { columns: 'all' }, columns: [], foreignKeys: [] }];
  const rollback = new Error('Fictional outer rollback');
  assert.deepEqual(f.db.exportTrace().schema, []);

  await assert.rejects(f.db.transaction(async outer => {
    assert.deepEqual(await outer.ensureSchema(), [schemaPlan]);
    assert.deepEqual(outer.exportTrace().schema, observed);
    throw rollback;
  }), error => error === rollback);
  assert.deepEqual(f.db.exportTrace().schema, []);
  assert.equal(f.controls[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.match(f.controls[1], /^SAVEPOINT "rs_async_sp_\d+"$/);
  assert.deepEqual(f.controls.slice(2), ['RELEASE ' + f.controls[1], 'ROLLBACK']);

  await f.db.transaction(async outer => {
    assert.deepEqual(await outer.ensureSchema(), [schemaPlan]);
    assert.deepEqual(outer.exportTrace().schema, observed);
  });
  assert.deepEqual(f.db.exportTrace().schema, observed);
  assert.equal(f.controls[4], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.match(f.controls[5], /^SAVEPOINT "rs_async_sp_\d+"$/);
  assert.deepEqual(f.controls.slice(6), ['RELEASE ' + f.controls[5], 'COMMIT']);
  assert.equal(f.inspections, 1);
});
test('native ensure allocation errors are sanitized and roll back before COMMIT',async t=>{
  const schema=[{get name(){throw new Error('FICTIONAL_PRIVATE_ALLOCATION');}}];
  const f=await fixture(t,[createAck()],{ensureSchema:()=>schemaEnsure(schema)});
  await assert.rejects(f.db.ensureSchema(),error=>error.code==='DATABASE_ERROR'&&!error.message.includes('FICTIONAL_PRIVATE_ALLOCATION'));
  assert.deepEqual(f.controls,['BEGIN ISOLATION LEVEL SERIALIZABLE','ROLLBACK']);
});
test('native ensure sanitization retains unknown rollback cleanup metadata',async t=>{
  const schema=[{get name(){throw new Error('FICTIONAL_PRIVATE_ALLOCATION');}}];
  const f=await fixture(t,[createAck()],{ensureSchema:()=>schemaEnsure(schema)},{rollback:true});
  await assert.rejects(f.db.ensureSchema(),error=>error.code==='DATABASE_ERROR'&&error.rowstitchCleanup!==undefined
    &&!error.message.includes('FICTIONAL_PRIVATE_ALLOCATION'));
  assert.ok(!f.controls.includes('COMMIT'));
});
test('native planning hook computation errors never expose private text',async t=>{
  const f=await fixture(t,[],{planSchema:function*(){throw new Error('FICTIONAL_PRIVATE_PLAN');}});
  await assert.rejects(f.db.planSchema(),error=>error.code==='DATABASE_ERROR'&&!error.message.includes('FICTIONAL_PRIVATE_PLAN'));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.controls,[]);
});
