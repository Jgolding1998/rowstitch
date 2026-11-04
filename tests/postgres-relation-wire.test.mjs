import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=process.env.ROWSTITCH_TEST_DIST?pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/'):new URL('../dist/',import.meta.url);
const {decodePostgresRelationStorage:decode,postgresRelationWireBytes:bytes}=await import(new URL('core/postgres-relation-storage.js',dist));
const {decodePostgresStorage}=await import(new URL('core/postgres-storage.js',dist));
const {snapshotPostgresResult,isPostgresRawResult}=await import(new URL('core/postgres-result.js',dist));
const {isAcknowledgedRejection}=await import(new URL('core/executor.js',dist));
const {POSTGRES_RELATION_LIMITS}=await import(new URL('core/postgres-relation-profile.js',dist));
const sdk=await import(new URL('index.js',dist));
const marker='SYNTHETIC_PRIVATE_WIRE_VALUE';
const code=expected=>error=>{assert.equal(error?.code,expected);assert.equal(error.cause,undefined);assert.ok(!inspect(error,{showHidden:true,depth:8}).includes(marker));return true;};
const profile=(extra={})=>({outputs:[{alias:'__rs_pg_0',property:'parentId',kind:'bigint',nullable:false},{alias:'__rs_pg_1',property:'value',kind:'text',nullable:true}],
  partitionBy:'parentId',keys:[1n,2n],correlateKeys:false,offset:0,limit:3,readLimit:10,...extra});
const raw=(p,rows)=>({command:'SELECT',rowCount:BigInt(rows.length),fields:[...p.outputs.map(f=>({name:f.alias,typeOid:f.kind==='text'?25:20})),
  {name:'__rs_pg_'+p.outputs.length,typeOid:20},...(p.correlateKeys?[{name:'__rs_pg_'+(p.outputs.length+1),typeOid:20}]:[])],rows});
const oracle=r=>r.fields.reduce((n,f)=>n+Buffer.byteLength(f.name,'utf8'),0)+r.rows.reduce((n,row)=>n+row.reduce((sum,cell)=>sum+(cell===null?0:Buffer.byteLength(cell,'utf8')),0),0);
const textProfile=(extra={})=>profile({outputs:[{alias:'__rs_pg_0',property:'parentId',kind:'text',nullable:false},{alias:'__rs_pg_1',property:'value',kind:'text',nullable:true}],
  keys:['a','A'],correlateKeys:true,...extra});

test('wire provenance is the exact physical field-name and non-NULL cell UTF8 total including hidden rank',()=>{
  const p=profile(),r=raw(p,[['1','é🌱','1'],['1',null,'2'],['2','last','1']]),rows=decode(r,p);
  assert.equal(bytes(rows),oracle(r));assert.equal(bytes(rows),27+1+6+1+1+1+1+4+1);
  assert.deepEqual(rows,[{parentId:1n,value:'é🌱'},{parentId:1n,value:null},{parentId:2n,value:'last'}]);
});
test('empty successful numeric and correlated results register metadata bytes instead of confusing zero rows with no provenance',()=>{
  for(const p of [profile(),textProfile()]){
    const r=raw(p,[]),rows=decode(r,p);assert.deepEqual(rows,[]);assert.equal(bytes(rows),oracle(r));assert.ok(bytes(rows)>0);
    assert.throws(()=>bytes([]),code('DATA'));assert.notEqual(rows,decode(r,p));
  }
});
test('correlated parent and multi-digit rank tokens and multibyte mapped text are all included',()=>{
  const p=textProfile({keys:Array.from({length:11},(_,i)=>'key'+i),offset:99,limit:2});
  const r=raw(p,[['É','😀','100','0'],['é',null,'101','0'],['Z','é','100','10']]),rows=decode(r,p);
  assert.equal(bytes(rows),oracle(r));assert.deepEqual(rows.map(row=>row.__rs_parent),[0n,0n,10n]);
  assert.ok(rows.every(row=>!Object.hasOwn(row,'__rs_rank')));
});
test('NULL and empty wire strings add no cell text bytes and unused profile keys are not response bytes',()=>{
  const p=profile(),empty=decode(raw(p,[['1','','1']]),p),nil=decode(raw(p,[['1',null,'1']]),p);
  assert.equal(bytes(empty),bytes(nil));
  const other=profile({keys:[1n,2n,9223372036854775807n]});assert.equal(bytes(decode(raw(other,[['1','','1']]),other)),bytes(empty));
});
test('registration adds no observable array/row properties and is not a raw-result or acknowledgment brand',()=>{
  const p=textProfile(),r=raw(p,[['A',marker,'1','0']]),rows=decode(r,p);
  assert.deepEqual(Reflect.ownKeys(rows),['0','length']);assert.deepEqual(Reflect.ownKeys(rows[0]),['parentId','value','__rs_parent']);
  assert.equal(Object.getOwnPropertySymbols(rows).length,0);assert.equal(Object.getOwnPropertySymbols(rows[0]).length,0);
  assert.equal(isPostgresRawResult(rows),false);assert.equal(isAcknowledgedRejection(rows),false);assert.throws(()=>bytes(rows[0]),code('DATA'));
  Object.freeze(rows[0]);Object.freeze(rows);assert.equal(bytes(rows),oracle(r));
});
test('forged copied scalar-decoded raw and profile inputs never acquire relation accounting provenance',()=>{
  const p=profile(),r=raw(p,[['1','sample','1']]),rows=decode(r,p),snapshot=snapshotPostgresResult(r);
  const scalar=decodePostgresStorage({...r,fields:r.fields.slice(0,2),rows:r.rows.map(row=>row.slice(0,2))},p.outputs,'SELECT');
  for(const value of [undefined,null,1,1n,true,marker,Symbol('private'),()=>{},p,r,r.rows,snapshot,snapshot.rows,scalar,rows.slice(),[...rows],structuredClone(rows),{wireBytes:bytes(rows)},Object.create(rows)])
    assert.throws(()=>bytes(value),code('DATA'));
  assert.equal(bytes(rows),oracle(r));assert.equal(Object.hasOwn(sdk,'postgresRelationWireBytes'),false);
});
test('unknown accessor/proxy inputs and wrappers of a genuine array refuse without invoking any supplied trap',()=>{
  let calls=0;const trap=()=>{calls++;throw new Error(marker);};
  const handler={get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,has:trap};
  const p=profile(),r=raw(p,[['1','sample','1']]),rows=decode(r,p),accessor=Object.defineProperty({},'length',{get:trap,enumerable:true});
  const revoked=Proxy.revocable(rows,handler);revoked.revoke();
  for(const value of [accessor,new Proxy({},handler),new Proxy([],handler),new Proxy(rows,handler),revoked.proxy])assert.throws(()=>bytes(value),code('DATA'));
  Object.defineProperty(rows,'unrelated',{get:trap,enumerable:true});Object.defineProperty(rows[0],'unrelated',{get:trap,enumerable:true});
  assert.equal(bytes(rows),oracle(r));assert.equal(calls,0);
});
test('failed metadata framing mapped membership and byte decoding never brand caller-owned arrays',()=>{
  const p=profile(),valid=raw(p,[['1','ok','1']]),previous=decode(valid,p),expected=bytes(previous);
  const failures=[
    {make:r=>{r.fields[0].typeOid=16;},code:'DATA'},
    {make:r=>{r.rows[0][2]='2';},code:'DATA'},
    {make:r=>{r.rows[0][0]='9223372036854775808';},code:'DATA'},
    {make:r=>{r.rows[0][0]='3';},code:'DATA'},
    {make:r=>{r.rows[0][1]='x'.repeat(POSTGRES_RELATION_LIMITS.bytes);},code:'RESULT_LIMIT'},
  ];
  for(const failure of failures){const r=structuredClone(valid);failure.make(r);assert.throws(()=>decode(r,p),code(failure.code));
    assert.throws(()=>bytes(r),code('DATA'));assert.throws(()=>bytes(r.rows),code('DATA'));assert.throws(()=>bytes(r.rows[0]),code('DATA'));}
  assert.equal(bytes(previous),expected);assert.throws(()=>bytes(valid.rows),code('DATA'));
});
test('provenance retains the received text count rather than rereading mutable source profile or returned rows',()=>{
  const p=profile(),r=raw(p,[['1','original','1']]),rows=decode(r,p),original=bytes(rows);
  r.rows[0][1]='a longer multibyte value é😀';p.keys.push(99n);p.partitionBy='changed';
  assert.deepEqual(rows,[{parentId:1n,value:'original'}]);assert.equal(bytes(rows),original);
  rows[0].value='user edit';rows.push({parentId:99n,value:'user row'});assert.equal(bytes(rows),original);
  const nextProfile=profile(),next=decode(raw(nextProfile,[['1','a longer multibyte value é😀','1']]),nextProfile);
  assert.ok(bytes(next)>original);assert.equal(bytes(rows),original);
});
