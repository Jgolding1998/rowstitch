import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=process.env.ROWSTITCH_TEST_DIST?pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/'):new URL('../dist/',import.meta.url);
const {column,defineTable,hasMany,agg,asc}=await import(new URL('index.js',dist));
const {openAsyncDatabaseWithDialect}=await import(new URL('core/async-database.js',dist));
const {createPostgresDialect}=await import(new URL('core/postgres-dialect.js',dist));
const {compilePostgres}=await import(new URL('core/postgres-compiler.js',dist));
const {createPostgresExecutor}=await import(new URL('core/postgres-executor.js',dist));
const {isPostgresRawResult,snapshotPostgresResult,POSTGRES_MAX_RESULT_CELLS}=await import(new URL('core/postgres-result.js',dist));
const {decodePostgresStorage}=await import(new URL('core/postgres-storage.js',dist));
const {POSTGRES_AGGREGATE_LIMITS}=await import(new URL('core/postgres-aggregate-profile.js',dist));
const code=expected=>error=>error?.code===expected;

// Controlled positional-text transport, not a native-engine capacity or performance claim. The public repository
// still performs its genuine mapping, option normalization, compiler, executor snapshot, session and decoding work.
async function fixture(t,columnCount,selectorCount,operation='count'){
  const columns={id:column.integer().primaryKey()};
  for(let i=1;i<columnCount;i++)columns['c'+i]=column.integer();
  const roots=defineTable('capacity_roots',columns);
  const children=defineTable('capacity_children',{id:column.integer().primaryKey(),rootId:column.integer().references(roots,'id'),label:column.text().nullable()});
  const relation=hasMany(children,{localKey:roots.col('id'),foreignKey:children.col('rootId')});
  const counted=i=>operation==='count'||operation==='mixed'&&i%2===0;
  const aggregates=Object.fromEntries(Array.from({length:selectorCount},(_,i)=>['n'+i,agg.related(relation,
    counted(i)?agg.count():operation==='text-max'?agg.max(children.col('label')):agg.min(children.col('id')))]));
  const options={aggregates,orderBy:[asc(roots.col('id'))],limit:10_000};
  const pending=[],sent=[],compiled=[],native=createPostgresDialect({schema:'capacity'});
  let latest,closed=0,replies=0,errorClassifications=0;
  const executor=createPostgresExecutor({
    async query(sql,parameters){
      sent.push({sql,parameters:[...parameters]});assert.ok(pending.length,'Unexpected controlled transport request');
      assert.equal(sql,latest.sql);assert.deepEqual(parameters,latest.parameters);
      const response=pending.shift()(latest);replies++;return response;
    },
    transactionStatus(){return 'I';},serverError(){errorClassifications++;return undefined;},async close(){closed++;},
  });
  const runtime={
    dialect:{...native,compile(model){latest=compilePostgres(model,{schema:'capacity'});compiled.push(latest);return native.compile(model);}},
    sessionDialect:'postgresql',isResult:isPostgresRawResult,inspectSchema:function*(){return [];},
  };
  const db=await openAsyncDatabaseWithDialect(executor,{tables:[roots,children]},runtime),repo=db.table(roots);
  t.after(async()=>{await db.close();assert.equal(closed,1,'the owned controlled connection closes once');});
  const page=rowCount=>plan=>{
    assert.equal(plan.aggregate?.mode,'projected');
    const fields=plan.aggregate.fields;
    assert.equal(fields.length,columnCount+selectorCount+1);
    const countFields=Array.from({length:selectorCount},(_,i)=>counted(i)).filter(Boolean).length;
    assert.equal(fields.filter(field=>field.kind==='mapped').length,columnCount+selectorCount-countFields);
    assert.equal(fields.filter(field=>field.kind==='count').length,countFields);
    assert.deepEqual(fields.filter(field=>field.kind==='guard').map(field=>field.target),['__rs_ragg_bad']);
    for(const field of fields.filter(field=>field.kind==='mapped')){
      const related=field.target.startsWith('__rs_ragg_');
      assert.equal(field.storageKind,related&&operation==='text-max'?'text':'integer');assert.equal(field.nullable,related);assert.equal(field.canonical,true);
    }
    const rows=Array.from({length:rowCount},(_,i)=>fields.map(field=>field.kind==='mapped'
      ?field.target==='id'?String(i+1):field.target.startsWith('__rs_ragg_')?null:'0':'0'));
    return {fields:fields.map((field,i)=>{assert.equal(field.alias,'__rs_pg_'+i);return {name:field.alias,
      typeOid:field.kind==='guard'?23:field.kind==='mapped'&&field.storageKind==='text'?25:20};}),rows,commandTag:'SELECT '+rowCount};
  };
  const count=value=>plan=>{assert.equal(plan.count,true);return {fields:[{name:'__rs_pg_count',typeOid:20}],rows:[[String(value)]],commandTag:'SELECT 1'};};
  return {db,repo,options,compiled,sent,get replies(){return replies;},get errorClassifications(){return errorClassifications;},
    replyPage(rows){pending.push(page(rows));},replyCount(value){pending.push(count(value));}};
}

function checkPage(rows,columnCount,selectorCount,operation='count',rowCount=10_000){
  assert.equal(rows.length,rowCount);
  for(let i=0;i<rows.length;i++){
    const row=rows[i];assert.equal(row.id,i+1);assert.equal(Object.keys(row).length,columnCount+selectorCount);
    for(let column=1;column<columnCount;column++)assert.equal(row['c'+column],0);
    for(let selector=0;selector<selectorCount;selector++)assert.equal(row['n'+selector],operation==='count'||operation==='mixed'&&selector%2===0?0:null);
    assert.equal(Object.hasOwn(row,'__rs_ragg_bad'),false);
  }
}

test('99 mapped columns plus one projected count and guard admit the original 1,010,000-cell page',async t=>{
  const f=await fixture(t,99,1);assert.equal(f.repo.compileSelect(f.options).parameters.at(-2),'10000');assert.equal(f.sent.length,0);
  f.replyPage(10_000);checkPage(await f.repo.findMany(f.options),99,1);
  assert.equal(f.compiled.at(-1).aggregate.fields.length*10_000,1_010_000);
  f.replyCount(10_000);assert.equal(await f.repo.count(),10_000);assert.equal(f.sent.length,2);
});

test('100 mapped columns plus all 32 projected counts and guard admit exactly 1,330,000 cells and remain usable',async t=>{
  assert.equal(POSTGRES_MAX_RESULT_CELLS,1_330_000);assert.equal(POSTGRES_AGGREGATE_LIMITS.cells,POSTGRES_MAX_RESULT_CELLS);
  const f=await fixture(t,100,32),pure=f.repo.compileSelect(f.options);
  assert.deepEqual(pure.parameters.slice(-2),['10000','0']);assert.equal(f.sent.length,0);
  f.replyPage(10_000);checkPage(await f.repo.findMany(f.options),100,32);
  assert.equal(f.compiled.at(-1).aggregate.fields.length,133);assert.equal(133*10_000,POSTGRES_MAX_RESULT_CELLS);
  f.replyCount(10_000);assert.equal(await f.repo.count(),10_000);assert.equal(f.sent.length,2);
});

test('one extra same-width row crosses the fixed raw cell budget, remains unconfirmed and poisons before another send',async t=>{
  const f=await fixture(t,100,32);f.replyPage(10_001);
  // SELECT 10001 matches the returned row count; all aliases/OIDs/values are otherwise valid and unique IDs are used.
  // This crosses only the raw snapshot cell bound (not its 100,000-row or 512-field bound).
  await assert.rejects(f.repo.findMany(f.options),code('EXECUTION_UNCONFIRMED'));
  assert.equal(f.replies,1,'the complete controlled response was returned, not a fixture assertion/import failure');
  assert.equal(f.errorClassifications,0,'the refusal came after the response, not from a transport rejection');
  assert.equal(f.compiled.at(-1).aggregate.fields.length*10_001,POSTGRES_MAX_RESULT_CELLS+133);
  assert.equal(f.sent.length,1);
  await assert.rejects(f.repo.count(),code('CONNECTION_UNUSABLE'));assert.equal(f.sent.length,1);
});

test('ordinary mapped storage retains its independent one-million-cell bound after raw capacity expands',()=>{
  const outputs=Array.from({length:100},(_,i)=>({alias:'__rs_pg_'+i,property:i?'c'+i:'id',kind:'integer',nullable:false}));
  const rows=Array.from({length:10_001},(_,i)=>outputs.map((_,column)=>column?'0':String(i+1)));
  const raw=snapshotPostgresResult({command:'SELECT',rowCount:10_001n,fields:outputs.map(field=>({name:field.alias,typeOid:20})),rows});
  assert.equal(isPostgresRawResult(raw),true);assert.equal(rows.length*outputs.length,1_000_100);
  assert.throws(()=>decodePostgresStorage(raw,outputs,'SELECT'),code('DATA'));
});

test('99 ordinary columns plus two related minima decode all 1,010,000 mapped cells in bounded batches',async t=>{
  const f=await fixture(t,99,2,'min');f.replyPage(10_000);checkPage(await f.repo.findMany(f.options),99,2,'min');
  f.replyCount(10_000);assert.equal(await f.repo.count(),10_000);
});

test('32 related minima span the internal mapped batch boundary without reducing the public page',async t=>{
  for(const rows of [7_575,7_576,10_000]){
    const f=await fixture(t,100,32,'min');f.replyPage(rows);checkPage(await f.repo.findMany(f.options),100,32,'min',rows);
    f.replyCount(rows);assert.equal(await f.repo.count(),rows);
  }
});

test('text maxima and mixed count/minimum pages preserve codecs beyond the ordinary mapped cell budget',async t=>{
  for(const operation of ['text-max','mixed']){
    const f=await fixture(t,100,32,operation);f.replyPage(10_000);checkPage(await f.repo.findMany(f.options),100,32,operation);
    f.replyCount(10_000);assert.equal(await f.repo.count(),10_000);
  }
});
