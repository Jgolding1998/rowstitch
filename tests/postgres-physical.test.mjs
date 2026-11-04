import test from 'node:test';
import assert from 'node:assert/strict';
import { column,defineTable } from '../dist/core/schema.js';
import { snapshotPostgresPhysical as capture,snapshotPostgresSettings,comparePostgresPhysical as compare,comparePostgresSettings,postgresPhysicalFingerprint as fingerprint } from '../dist/core/postgres-physical.js';
const mapped=defineTable('physical_rows',{id:column.integer().primaryKey(),exact:column.bigint(),enabled:column.boolean(),data:column.json(),label:column.text().nullable(),ratio:column.real()});
const col=(name,position,typeOid,notNull=true,extra={})=>({name,position,typeOid,typeModifier:-1,arrayDimensions:0,notNull,notNullValid:true,hasDefault:false,identity:'',generated:'',collationOid:typeOid===25?100:0,...extra});
const index=(extra={})=>({oid:20001,primary:true,unique:true,valid:true,ready:true,live:true,immediate:true,nullsNotDistinct:false,keyColumns:['id'],includedColumns:[],collationOids:[0],hasExpressions:false,partial:false,...extra});
const fixture=()=>({format:'rowstitch-postgres-physical-v1',serverVersion:180006,schema:'public',name:'physical_rows',oid:20000,
  relation:{kind:'r',persistence:'p',isPartition:false,hasDescendants:false,hasAncestors:false,rowSecurity:false,forceRowSecurity:false,hasRules:false,userTriggers:0},
  columns:[col('id',1,20),col('exact',2,20),col('enabled',3,16),col('data',4,3802),col('label',5,25,false),col('ratio',6,701)],indexes:[index()]});
const rejected=(reason,edit,table=mapped)=>{const value=fixture();edit(value);assert.equal(compare(table,'public',capture(value)),reason);};
const code=wanted=>error=>error?.code===wanted&&!error.message.includes('SYNTHETIC_PRIVATE_VALUE');

test('physical capture detaches and freezes every nested metadata container',()=>{
  const input=fixture(),snapshot=capture(input),before=fingerprint(snapshot);
  input.columns[0].name='changed';input.indexes[0].keyColumns[0]='changed';input.relation.kind='v';
  assert.equal(snapshot.columns[0].name,'id');assert.equal(snapshot.indexes[0].keyColumns[0],'id');assert.equal(snapshot.relation.kind,'r');
  for(const value of [snapshot,snapshot.relation,snapshot.columns,snapshot.columns[0],snapshot.indexes,snapshot.indexes[0],snapshot.indexes[0].keyColumns,snapshot.indexes[0].includedColumns,snapshot.indexes[0].collationOids])assert.ok(Object.isFrozen(value));
  assert.equal(fingerprint(snapshot),before);assert.equal(compare(mapped,'public',snapshot),null);
});
test('physical reasons distinguish a missing mapping from a different relation and version',()=>{
  assert.equal(compare(mapped,'public',null),'MISSING');
  rejected('SERVER_VERSION',v=>{v.serverVersion=170006;});
  rejected('RELATION_IDENTITY',v=>{v.schema='other';});rejected('RELATION_IDENTITY',v=>{v.name='other';});
  for(const kind of ['v','m','p','f'])rejected('RELATION_KIND',v=>{v.relation.kind=kind;});
  rejected('RELATION_KIND',v=>{v.relation.isPartition=true;});
  for(const persistence of ['u','t'])rejected('RELATION_PERSISTENCE',v=>{v.relation.persistence=persistence;});
});
test('inheritance, rewriting, RLS and even disabled user triggers are outside the first policy',()=>{
  for(const property of ['hasDescendants','hasAncestors'])rejected('INHERITANCE',v=>{v.relation[property]=true;});
  for(const property of ['rowSecurity','forceRowSecurity'])rejected('ROW_SECURITY',v=>{v.relation[property]=true;});
  rejected('REWRITE_RULES',v=>{v.relation.hasRules=true;});rejected('USER_TRIGGERS',v=>{v.relation.userTriggers=1;});
});
test('the physical column set must match, including unmapped columns that could have defaults',()=>{
  rejected('COLUMN_SET',v=>{v.columns.pop();});
  rejected('COLUMN_SET',v=>{v.columns.push(col('unmapped',7,25,true,{hasDefault:true}));});
  rejected('COLUMN_SET',v=>{v.columns[4].name='renamed';});
});
test('native OIDs, dimensions and typmods reject coercions and domains instead of guessing',()=>{
  for(const [position,typeOid] of [[0,23],[2,25],[3,114],[4,1043],[5,700],[4,20099]])rejected('COLUMN_TYPE',v=>{v.columns[position].typeOid=typeOid;});
  rejected('COLUMN_TYPE',v=>{v.columns[4].typeModifier=14;});rejected('COLUMN_TYPE',v=>{v.columns[0].arrayDimensions=1;});
});
test('nullable and validated not-null contracts are separate checks',()=>{
  rejected('COLUMN_NULLABILITY',v=>{v.columns[4].notNull=true;});rejected('COLUMN_NULLABILITY',v=>{v.columns[1].notNull=false;});
  rejected('COLUMN_NOT_NULL_INVALID',v=>{v.columns[1].notNullValid=false;});
});
test('generated expressions and identity need explicit mapping rather than accidental writes',()=>{
  for(const generated of ['s','v'])rejected('COLUMN_GENERATED',v=>{v.columns[0].generated=generated;});
  for(const identity of ['a','d'])rejected('COLUMN_IDENTITY',v=>{v.columns[0].identity=identity;});
  const generated=defineTable('physical_rows',{id:column.integer().primaryKey({generated:true})});
  const value=fixture();value.columns=[value.columns[0]];
  assert.equal(compare(generated,'public',capture(value)),'COLUMN_IDENTITY');
  value.columns[0].identity='d';assert.equal(compare(generated,'public',capture(value)),null);
  value.columns[0].identity='';value.columns[0].hasDefault=true;assert.equal(compare(generated,'public',capture(value)),null);
});
test('default presence is checked while explicit unmapped engine defaults remain allowed',()=>{
  const defaults=defineTable('physical_rows',{id:column.integer().primaryKey(),ratio:column.real().default(1)});
  const value=fixture();value.columns=[value.columns[0],value.columns[5]];
  assert.equal(compare(defaults,'public',capture(value)),'COLUMN_DEFAULT');
  value.columns[1].hasDefault=true;assert.equal(compare(defaults,'public',capture(value)),null);
  const original=fixture();original.columns[4].hasDefault=true;assert.equal(compare(mapped,'public',capture(original)),null);
});
test('only one live immediate primary key over the complete declared key is accepted',()=>{
  rejected('PRIMARY_KEY',v=>{v.indexes=[];});
  for(const field of ['unique','valid','ready','live','immediate'])rejected('PRIMARY_KEY',v=>{v.indexes[0][field]=false;});
  for(const field of ['hasExpressions','partial'])rejected('PRIMARY_KEY',v=>{v.indexes[0][field]=true;});
  for(const keys of [['exact'],['id','exact'],['id','id'],[null]])rejected('PRIMARY_KEY',v=>{v.indexes[0].keyColumns=keys;v.indexes[0].collationOids=keys.map(()=>0);});
  rejected('PRIMARY_KEY',v=>{v.indexes[0].includedColumns=['label'];});
  rejected('PRIMARY_KEY',v=>{v.indexes.push(index({oid:20002}));});
});
test('composite primary keys compare as sets, independently of index order',()=>{
  const table=defineTable('physical_rows',{tenant:column.text().primaryKey(),id:column.integer().primaryKey()});
  const value=fixture();value.columns=[col('tenant',1,25),col('id',2,20)];
  value.indexes=[index({keyColumns:['id','tenant'],collationOids:[0,100]})];assert.equal(compare(table,'public',capture(value)),null);
  value.indexes[0].keyColumns=['id'];value.indexes[0].collationOids=[0];assert.equal(compare(table,'public',capture(value)),'PRIMARY_KEY');
});
test('text primary keys require default column and index collation',()=>{
  const table=defineTable('physical_rows',{id:column.text().primaryKey()});
  const value=fixture();value.columns=[col('id',1,25)];value.indexes[0].collationOids=[100];
  assert.equal(compare(table,'public',capture(value)),null);
  value.columns[0].collationOid=951;assert.equal(compare(table,'public',capture(value)),'KEY_COLLATION');
  value.columns[0].collationOid=100;value.indexes[0].collationOids=[951];assert.equal(compare(table,'public',capture(value)),'KEY_COLLATION');
});
test('mapped uniqueness needs its own complete immediate key, with compatible nullable behavior',()=>{
  const table=defineTable('physical_rows',{id:column.integer().primaryKey(),label:column.text().nullable().unique()});
  const value=fixture();value.columns=[value.columns[0],value.columns[4]];
  assert.equal(compare(table,'public',capture(value)),'UNIQUE');
  const unique=index({oid:20002,primary:false,keyColumns:['label'],collationOids:[100]});value.indexes.push(unique);
  assert.equal(compare(table,'public',capture(value)),null);
  for(const [field,replacement] of [['nullsNotDistinct',true],['partial',true],['hasExpressions',true],['immediate',false],['live',false]]){
    const changed=structuredClone(value);changed.indexes[1][field]=replacement;assert.equal(compare(table,'public',capture(changed)),'UNIQUE');
  }
  unique.keyColumns=['label','id'];unique.collationOids=[100,0];assert.equal(compare(table,'public',capture(value)),'UNIQUE');
});
test('fingerprints detect physical identity, type, key, trigger and default changes',()=>{
  const original=fingerprint(capture(fixture()));
  for(const edit of [v=>{v.oid++;},v=>{v.columns[1].typeOid=23;},v=>{v.indexes[0].immediate=false;},v=>{v.relation.userTriggers=1;},v=>{v.columns[4].hasDefault=true;}]){
    const value=fixture();edit(value);assert.notEqual(fingerprint(capture(value)),original);
  }
});
test('snapshots reject malformed, huge and accessor-bearing records without exposing values',()=>{
  let reads=0;const accessor=fixture();Object.defineProperty(accessor.columns[0],'typeOid',{enumerable:true,get(){reads++;return 20;}});
  assert.throws(()=>capture(accessor),code('SCHEMA'));assert.equal(reads,0);
  const malformed=[null,[],{}, {...fixture(),extra:'SYNTHETIC_PRIVATE_VALUE'}];
  for(const edit of [v=>{v.oid=0;},v=>{v.oid=2**32;},v=>{v.columns[0].notNull=1;},v=>{v.columns[0].name='bad\0';},v=>{v.columns[1].position=1;},v=>{v.columns[1].name='id';},v=>{v.indexes[0].keyColumns=[];},v=>{v.indexes[0].collationOids=[];},v=>{v.indexes.push(index());},v=>{v.columns=Array(513).fill(v.columns[0]);},v=>{v.indexes=Array(513).fill(v.indexes[0]);},v=>{delete v.columns[1];},v=>{v[Symbol('secret')]=1;}]){const v=fixture();edit(v);malformed.push(v);}
  for(const value of malformed)assert.throws(()=>capture(value),code('SCHEMA'));
  const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.throws(()=>capture(proxy),code('SCHEMA'));
});
test('shape identities are not forgeable through copies or proxies',()=>{
  const snapshot=capture(fixture());assert.throws(()=>fingerprint({...snapshot}),code('SCHEMA'));assert.throws(()=>fingerprint(new Proxy(snapshot,{})),code('SCHEMA'));
  assert.throws(()=>compare({...mapped},'public',snapshot),code('SCHEMA'));
  for(const schema of ['pg_catalog','pg_temp_3','information_schema','bad.schema'])assert.throws(()=>compare(mapped,schema,snapshot),code('SCHEMA'));
});
const settings=()=>({serverVersion:180006,clientEncoding:'UTF8',serverEncoding:'UTF8',extraFloatDigits:1,replicationRole:'origin',searchPath:'"$user", public'});
test('settings require precision-preserving UTF8 origin sessions and a stable captured search path',()=>{
  const original=settings(),captured=snapshotPostgresSettings(original);original.searchPath='changed';assert.ok(Object.isFrozen(captured));
  assert.equal(comparePostgresSettings(captured),null);
  assert.equal(comparePostgresSettings(captured,'"$user", public'),null);
  for(const [key,value,reason] of [['serverVersion',170006,'SERVER_VERSION'],['clientEncoding','LATIN1','ENCODING'],['serverEncoding','SQL_ASCII','ENCODING'],['extraFloatDigits',0,'FLOAT_PRECISION'],['extraFloatDigits',-15,'FLOAT_PRECISION'],['extraFloatDigits',4,'FLOAT_PRECISION'],['replicationRole','replica','REPLICATION_ROLE'],['replicationRole','local','REPLICATION_ROLE'],['searchPath','changed','SEARCH_PATH']]){
    assert.equal(comparePostgresSettings(snapshotPostgresSettings({...settings(),[key]:value}),'"$user", public'),reason);
  }
  for(const extraFloatDigits of [1,2,3])assert.equal(comparePostgresSettings(snapshotPostgresSettings({...settings(),extraFloatDigits})),null);
});
test('settings shape errors and copies stay sanitized',()=>{
  for(const value of [null,{}, {...settings(),extraFloatDigits:'1'},{...settings(),extraFloatDigits:NaN},{...settings(),searchPath:'x'.repeat(8193)},{...settings(),extra:'SYNTHETIC_PRIVATE_VALUE'}])assert.throws(()=>snapshotPostgresSettings(value),code('DATA'));
  const captured=snapshotPostgresSettings(settings());assert.throws(()=>comparePostgresSettings({...captured}),code('DATA'));
  let reads=0;const value=settings();Object.defineProperty(value,'searchPath',{enumerable:true,get(){reads++;return 'SYNTHETIC_PRIVATE_VALUE';}});assert.throws(()=>snapshotPostgresSettings(value),code('DATA'));assert.equal(reads,0);
});
