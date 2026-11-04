import test from 'node:test';
import assert from 'node:assert/strict';
import { column,defineTable,inArray,or,openDatabase,openAsyncDatabase } from '../dist/index.js';
import { MAX_BOUND_PARAMETERS,MAX_RELATION_KEYS,MAX_REQUEST_PARAMETERS,queryModel } from '../dist/core/query-model.js';
import { compilePostgres } from '../dist/core/postgres-compiler.js';
import { mappedTableModel } from '../dist/core/model-mapping.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { inlineAsyncExecutor } from '../dist/core/executor.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';

const columns={id:column.integer().primaryKey(),...Object.fromEntries(Array.from({length:99},(_,i)=>['c'+i,column.integer().default(0)]))};
const rows=defineTable('budget_rows',columns);
const values=()=>Array.from({length:1000},(_,i)=>i);
const where=()=>or(...Array.from({length:10},()=>inArray(rows.col('id'),values())));
const data=()=>Object.fromEntries(Array.from({length:99},(_,i)=>['c'+i,2]));
const code=expected=>error=>error.code===expected;

test('modeled caller values and physical request values have distinct bounded limits',()=>{
  assert.equal(MAX_BOUND_PARAMETERS,10_000);assert.equal(MAX_RELATION_KEYS,400);assert.equal(MAX_REQUEST_PARAMETERS,10_403);
  const table=mappedTableModel(rows);
  const predicate={kind:'logic',operator:'OR',children:Array.from({length:10},()=>({kind:'compare',column:'id',operator:'IN',values:values()}))};
  const query=compilePostgres(queryModel.update({table,where:predicate,assignments:Object.entries(data()).map(([column,value])=>({column,value}))}));
  assert.equal(query.parameters.length,10_099);assert.equal(query.outputs.length,100);
  const tooMany={kind:'logic',operator:'OR',children:[...predicate.children,{kind:'compare',column:'id',operator:'=',values:[1]}]};
  assert.throws(()=>queryModel.count({table,where:tooMany}),code('QUERY'));
});
test('synchronous SQLite executes the full caller-value budget with paging and update fields',()=>{
  const db=openDatabase(':memory:',{tables:[rows]});
  try {
    db.ensureSchema();db.table(rows).insert({id:1});
    assert.equal(db.table(rows).compileSelect({where:where(),select:['id'],limit:1}).parameters.length,10_002);
    assert.deepEqual(db.table(rows).findMany({where:where(),select:['id'],limit:1}),[{id:1}]);
    const changed=db.table(rows).update(data(),{where:where(),maxRows:1});assert.equal(changed.length,1);assert.equal(changed[0].c98,2);
  } finally {db.close();}
});
test('worker-backed SQLite also executes valid paging and guarded updates at the caller-value budget',async t=>{
  const db=await openAsyncDatabase(':memory:',{tables:[rows]});t.after(()=>db.close());
  await db.ensureSchema();await db.table(rows).insert({id:1});
  assert.deepEqual(await db.table(rows).findMany({where:where(),select:['id'],limit:1}),[{id:1}]);
  const changed=await db.table(rows).update(data(),{where:where(),maxRows:1});assert.equal(changed.length,1);assert.equal(changed[0].c98,2);
  assert.throws(()=>db.table(rows).compileSelect({where:or(where(),inArray(rows.col('id'),[1]))}),code('QUERY'));
});
test('the async session accepts the maximum generated request and rejects one value beyond it',async t=>{
  const session=createAsyncSession(inlineAsyncExecutor(openSqliteExecutor(':memory:')));t.after(()=>session.close());
  const sql='SELECT 1 AS n WHERE 0 IN ('+new Array(MAX_REQUEST_PARAMETERS).fill('?').join(',')+')';
  assert.deepEqual((await session.all(sql,new Array(MAX_REQUEST_PARAMETERS).fill(0))).map(row=>row.n),[1n]);
  await assert.rejects(session.all('SELECT 1',new Array(MAX_REQUEST_PARAMETERS+1).fill(0)),code('VALIDATION'));
});
