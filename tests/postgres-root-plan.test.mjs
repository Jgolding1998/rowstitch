import test from 'node:test';
import assert from 'node:assert/strict';
import { column, defineTable } from '../dist/core/schema.js';
import { compilePostgresRoot, decodePostgresRoot, isCompiledPostgresRoot, planPostgresByKey, planPostgresCount, planPostgresInsert } from '../dist/core/postgres-root-plan.js';

const code = wanted => error => error?.code === wanted && !error.message.includes('SYNTHETIC_PRIVATE_VALUE');
const table=defineTable('root_samples',{
  id:column.integer().primaryKey(), exact:column.bigint(), enabled:column.boolean(), data:column.json(), label:column.text().nullable(), ratio:column.real(),
});
const data=()=>({id:1,exact:9223372036854775807n,enabled:true,data:{nested:[1,true,'🙂']},label:null,ratio:-0});
const oid={integer:20,bigint:20,boolean:16,json:3802,text:25,real:701};
function raw(compiled,rows,command=compiled.operation==='insert'?'INSERT':'SELECT',count=BigInt(rows.length)){
  return {fields:compiled.outputs.map(f=>({name:f.alias,typeOid:oid[f.kind]})),rows,command,rowCount:count};
}
const wireRow=['1','9223372036854775807','t','{"nested":[1,true,"🙂"]}',null,'-0'];

test('logical insert plans retain logical booleans and detached frozen JSON',()=>{
  const input=data(),plan=planPostgresInsert(table,input);
  assert.equal(plan.values.find(v=>v.column==='enabled').value,true);
  const json=plan.values.find(v=>v.column==='data').value;
  assert.deepEqual(json,input.data);assert.notEqual(json,input.data);assert.ok(Object.isFrozen(json));assert.ok(Object.isFrozen(json.nested));
  input.data.nested[0]=99;input.enabled=false;input.id=77;
  assert.equal(plan.values.find(v=>v.column==='id').value,1);assert.deepEqual(json,{nested:[1,true,'🙂']});
  assert.ok(!Object.isFrozen(input));assert.ok(!Object.isFrozen(input.data));
});

test('insert SQL is schema-qualified and binds every value with explicit native casts',()=>{
  const input=data();input.label="SYNTHETIC_PRIVATE_VALUE_' OR 1=1--";
  const compiled=compilePostgresRoot(planPostgresInsert(table,input,'demo_space'));
  assert.ok(compiled.sql.startsWith('INSERT INTO "demo_space"."root_samples" ("id", "exact", "enabled", "data", "label", "ratio") VALUES ('));
  assert.ok(compiled.sql.includes('$1::"pg_catalog"."int8"'));assert.ok(compiled.sql.includes('$3::"pg_catalog"."bool"'));assert.ok(compiled.sql.includes('$4::"pg_catalog"."jsonb"'));assert.ok(compiled.sql.includes('$6::"pg_catalog"."float8"'));
  assert.ok(compiled.sql.includes('RETURNING "id" AS "__rs_pg_0"'));assert.ok(!compiled.sql.includes(input.label));
  assert.deepEqual(compiled.parameters,['1','9223372036854775807','true','{"nested":[1,true,"🙂"]}',input.label,'-0']);
  assert.ok(Object.isFrozen(compiled));assert.ok(Object.isFrozen(compiled.parameters));assert.ok(Object.isFrozen(compiled.outputs[0]));
});

test('key selection binds all composite components and its duplicate-detection limit',()=>{
  const composite=defineTable('composite_rows',{tenant:column.text().primaryKey(),id:column.integer().primaryKey(),name:column.text()});
  const key={id:3,tenant:'north'},plan=planPostgresByKey(composite,key);key.tenant='changed';
  const compiled=compilePostgresRoot(plan);
  assert.deepEqual(compiled.parameters,['north','3','2']);
  assert.ok(compiled.sql.includes('WHERE "tenant" OPERATOR("pg_catalog".=) $1::"pg_catalog"."text" AND "id" OPERATOR("pg_catalog".=) $2::"pg_catalog"."int8" LIMIT $3::"pg_catalog"."int8"'));
});

test('counts qualify the aggregate and require no caller SQL or values',()=>{
  const compiled=compilePostgresRoot(planPostgresCount(table));
  assert.equal(compiled.sql,'SELECT "pg_catalog"."count"(*) AS "__rs_pg_count" FROM ONLY "public"."root_samples"');
  assert.deepEqual(compiled.parameters,[]);
  assert.equal(decodePostgresRoot(compiled,raw(compiled,[['9']])),9);
  assert.equal(decodePostgresRoot(compiled,raw(compiled,[['0']])),0);
});

test('all input records must have exactly the mapped fields and safe logical values',()=>{
  for(const change of [r=>{delete r.label;},r=>{r.extra='no';},r=>{r.id='1';},r=>{r.enabled=1;},r=>{r.data={x:undefined};},r=>{r.ratio=Infinity;},r=>{r.label='bad\0text';},r=>{r[Symbol('hidden')]=1;}]) {
    const input=data();change(input);assert.throws(()=>planPostgresInsert(table,input),code('VALIDATION'));
  }
  for(const key of [{},{id:1,extra:2},{id:null},{id:9007199254740992},[]]) assert.throws(()=>planPostgresByKey(table,key),code('VALIDATION'));
  assert.throws(()=>planPostgresCount(table,'bad.schema'),code('SCHEMA'));
  for(const schema of ['pg_catalog','pg_temp','pg_temp_3','information_schema','PG_CATALOG']) assert.throws(()=>planPostgresCount(table,schema),code('SCHEMA'));
  const generated=defineTable('generated_samples',{id:column.integer().primaryKey({generated:true}),name:column.text()});
  assert.throws(()=>planPostgresInsert(generated,{id:1,name:'sample'}),code('QUERY'));
});

test('forged/proxied tables and record accessors are refused without reading their values',()=>{
  let calls=0;const forged=Object.create(Object.getPrototypeOf(table));Object.defineProperty(forged,'name',{get(){calls++;return 'SYNTHETIC_PRIVATE_VALUE';}});
  assert.throws(()=>planPostgresCount(forged),code('SCHEMA'));assert.throws(()=>planPostgresCount(new Proxy(table,{})),code('SCHEMA'));assert.equal(calls,0);
  const input=data();Object.defineProperty(input,'id',{enumerable:true,get(){calls++;return 1;}});
  assert.throws(()=>planPostgresInsert(table,input),code('VALIDATION'));assert.equal(calls,0);
  const proxy=new Proxy({}, {getPrototypeOf(){throw new Error('SYNTHETIC_PRIVATE_VALUE');}});
  assert.throws(()=>planPostgresInsert(table,proxy),code('VALIDATION'));
});

test('plan and compiled identities cannot be forged by structural lookalikes',()=>{
  const plan=planPostgresCount(table),compiled=compilePostgresRoot(plan);
  assert.throws(()=>compilePostgresRoot({...plan}),code('QUERY'));
  assert.throws(()=>compilePostgresRoot(new Proxy(plan,{})),code('QUERY'));
  assert.equal(isCompiledPostgresRoot(compiled),true);assert.equal(isCompiledPostgresRoot({...compiled}),false);
  assert.throws(()=>decodePostgresRoot({...compiled},raw(compiled,[['1']])),code('QUERY'));
});

test('insert and key results use OID-checked native values, including minus zero and int64',()=>{
  const insert=compilePostgresRoot(planPostgresInsert(table,data()));
  const decoded=decodePostgresRoot(insert,raw(insert,[wireRow]));
  assert.deepEqual(decoded,data());assert.ok(Object.is(decoded.ratio,-0));
  const select=compilePostgresRoot(planPostgresByKey(table,{id:1}));
  assert.deepEqual(decodePostgresRoot(select,raw(select,[wireRow])),data());
  assert.equal(decodePostgresRoot(select,raw(select,[])),null);
});

test('unexpected commands, row counts and result cardinalities never become success',()=>{
  const insert=compilePostgresRoot(planPostgresInsert(table,data())),select=compilePostgresRoot(planPostgresByKey(table,{id:1})),count=compilePostgresRoot(planPostgresCount(table));
  for(const result of [raw(insert,[]),raw(insert,[wireRow,wireRow]),raw(insert,[wireRow],'SELECT'),raw(insert,[wireRow],'INSERT',null),raw(insert,[wireRow],'INSERT',2n)])
    assert.throws(()=>decodePostgresRoot(insert,result),code('DATA'));
  assert.throws(()=>decodePostgresRoot(select,raw(select,[wireRow,wireRow])),code('DATA'));
  for(const result of [raw(count,[]),raw(count,[['1'],['2']]),raw(count,[['9007199254740992']]),raw(count,[['-1']])])
    assert.throws(()=>decodePostgresRoot(count,result),code('DATA'));
});

test('empty key results still validate aliases and native field types',()=>{
  const compiled=compilePostgresRoot(planPostgresByKey(table,{id:1}));
  const wrongOid=raw(compiled,[]);wrongOid.fields[0].typeOid=25;
  assert.throws(()=>decodePostgresRoot(compiled,wrongOid),code('DATA'));
  const wrongAlias=raw(compiled,[]);wrongAlias.fields[0].name='id';
  assert.throws(()=>decodePostgresRoot(compiled,wrongAlias),code('DATA'));
  const missingField=raw(compiled,[]);missingField.fields.pop();
  assert.throws(()=>decodePostgresRoot(compiled,missingField),code('DATA'));
});
