import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=process.env.ROWSTITCH_TEST_DIST?pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/'):new URL('../dist/',import.meta.url);
const {decodePostgresRelationStorage:decode}=await import(new URL('core/postgres-relation-storage.js',dist));
const {POSTGRES_RELATION_LIMITS:LIMITS}=await import(new URL('core/postgres-relation-profile.js',dist));
const {decodePostgresStorage,POSTGRES_MAX_MAPPED_CELLS}=await import(new URL('core/postgres-storage.js',dist));
const {snapshotPostgresResult}=await import(new URL('core/postgres-result.js',dist));
const MIN=-(2n**63n),MAX=2n**63n-1n,secret='SYNTHETIC_PRIVATE_RELATION';
const code=expected=>error=>{assert.equal(error?.code,expected);assert.equal(error.cause,undefined);assert.ok(!inspect(error,{showHidden:true,depth:8}).includes(secret));return true;};
const output=(property,kind='bigint',nullable=false,index=0)=>({alias:'__rs_pg_'+index,property,kind,nullable});
const profile=(extra={})=>({outputs:[output('parentId'),output('value','text',true,1)],partitionBy:'parentId',keys:[1n,2n],correlateKeys:false,offset:0,limit:1000,readLimit:10001,...extra});
const textProfile=(extra={})=>profile({outputs:[output('parentId','text'),output('value','text',true,1)],keys:['a','A'],correlateKeys:true,...extra});
const oid={integer:20,bigint:20,real:701,text:25,boolean:16,json:114};
const raw=(p,rows,extra={})=>({command:'SELECT',rowCount:BigInt(rows.length),fields:[...p.outputs.map(f=>({name:f.alias,typeOid:oid[f.kind]})),
  {name:'__rs_pg_'+p.outputs.length,typeOid:20},...(p.correlateKeys?[{name:'__rs_pg_'+(p.outputs.length+1),typeOid:20}]:[])],rows,...extra});
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

test('numeric groups preserve exact signed int64 membership and canonical storage without rank leakage',()=>{
  const p=profile({keys:[MAX,MIN,1n]}),r=raw(p,[[String(MIN),'low','1'],[String(MIN),null,'2'],['1','middle','1'],[String(MAX),'high','1']]);
  assert.deepEqual(decode(r,p),[{parentId:MIN,value:'low'},{parentId:MIN,value:null},{parentId:1n,value:'middle'},{parentId:MAX,value:'high'}]);
  assert.ok(!Reflect.ownKeys(decode(r,p)[0]).some(key=>key.startsWith('__rs_')));
});
test('integer and bigint mapped families keep their physical widths and safe logical integer range',()=>{
  for(const physical of [21,23,20]){
    const p=profile({outputs:[output('parentId','integer'),output('value','text',true,1)]}),r=raw(p,[['1','ok','1']]);r.fields[0].typeOid=physical;
    assert.equal(decode(r,p)[0].parentId,1n);
  }
  const p=profile({outputs:[output('parentId','integer')],keys:[9007199254740992n]});
  assert.throws(()=>decode(raw(p,[['9007199254740992','1']]),p),code('DATA'));
});
test('numeric source keys are canonical int64 bigints and membership never rounds neighboring values',()=>{
  const p=profile({keys:[9007199254740992n,9007199254740993n]});
  assert.deepEqual(decode(raw(p,[['9007199254740992','a','1'],['9007199254740993','b','1']]),p).map(r=>r.parentId),p.keys);
  assert.throws(()=>decode(raw(p,[['9007199254740994','outside','1']]),p),code('DATA'));
  for(const key of [1,-0,'1',null,{},MIN-1n,MAX+1n])assert.throws(()=>decode(raw(p,[]),{...p,keys:[key]}),code('DATA'));
});
test('text source ordinals carry correlation without JS membership or text sorting assumptions',()=>{
  const p=textProfile({keys:['z','a']});
  assert.deepEqual(decode(raw(p,[['Z','first','1','0'],['not-JS-equal','second','2','0'],['A','third','1','1']]),p),[
    {parentId:'Z',value:'first',__rs_parent:0n},{parentId:'not-JS-equal',value:'second',__rs_parent:0n},{parentId:'A',value:'third',__rs_parent:1n}]);
});
test('a NULL partition is impossible in either matching mode even when the mapped column is nullable',()=>{
  for(const p of [profile({outputs:[output('parentId','bigint',true)]}),textProfile({outputs:[output('parentId','text',true)]})]){
    assert.throws(()=>decode(raw(p,[[null,'1',...(p.correlateKeys?['0']:[])]]),p),code('DATA'));
  }
});
test('rank offset and upper boundaries use exact canonical tokens including the largest supported page',()=>{
  const p=profile({offset:1_000_000_000,readLimit:1000}),rows=Array.from({length:1000},(_,i)=>['1','x',String(p.offset+i+1)]);
  assert.equal(decode(raw(p,rows),p).length,1000);
  for(const rank of [String(p.offset),String(p.offset+1001)])assert.throws(()=>decode(raw(p,[['1','x',rank]]),p),code('DATA'));
});
test('limit0 has valid empty metadata but can never accept a returned row',()=>{
  for(const p of [profile({limit:0}),textProfile({limit:0})]){
    assert.deepEqual(decode(raw(p,[]),p),[]);
    assert.throws(()=>decode(raw(p,[['1','x','1',...(p.correlateKeys?['0']:[])]]),p),code('DATA'));
  }
});
test('rank and parent grammar refuses noncanonical decimal, NULL and out-of-range values',()=>{
  const p=textProfile();
  for(const token of [null,'-1','-0','+1','01','1.0','1e0',' 1','1\n','0x1','','9223372036854775808',secret,'9'.repeat(1000)]){
    assert.throws(()=>decode(raw(p,[['a','x',token,'0']]),p),code('DATA'));
    assert.throws(()=>decode(raw(p,[['a','x','1',token]]),p),code('DATA'));
  }
  assert.throws(()=>decode(raw(p,[['a','x','1','2']]),p),code('DATA'));
});
test('parent groups are strictly ascending and each begins at offset+1 with contiguous ranks',()=>{
  for(const rows of [[['2','x','1'],['1','x','1']],[['1','x','1'],['2','x','1'],['1','x','2']],
    [['1','x','2']],[['1','x','1'],['1','x','1']],[['1','x','1'],['1','x','3']]])assert.throws(()=>decode(raw(profile(),rows),profile()),code('DATA'));
  const p=textProfile();
  for(const rows of [[['a','x','1','1'],['a','x','1','0']],[['a','x','1','0'],['a','x','1','1'],['a','x','2','0']],
    [['a','x','2','0']],[['a','x','1','0'],['A','x','3','0']]])assert.throws(()=>decode(raw(p,rows),p),code('DATA'));
  const gap=profile({keys:[1n,2n,3n]});assert.equal(decode(raw(gap,[['1','x','1'],['3','x','1']]),gap).length,2);
});
test('SELECT cardinality, exact readLimit and all original metadata are checked even for empty results',()=>{
  const p=profile({readLimit:1});assert.equal(decode(raw(p,[['1','x','1']]),p).length,1);
  assert.throws(()=>decode(raw(p,[['1','x','1'],['1','y','2']]),p),code('DATA'));
  for(const change of [r=>r.command='UPDATE',r=>r.rowCount=null,r=>r.rowCount=1,r=>r.rowCount=1n,r=>r.rowCount=-1n,
    r=>r.fields[0].name='wrong',r=>r.fields[1].name='__rs_pg_0',r=>r.fields.reverse(),r=>r.fields.pop(),r=>r.fields.push({name:'extra',typeOid:20}),r=>r.fields[0].typeOid=16]){
    const r=raw(p,[]);change(r);assert.throws(()=>decode(r,p),code('DATA'));
  }
});
test('rank and parent metadata require exact OID20 and contiguous fixed aliases',()=>{
  for(const p of [profile(),textProfile()])for(let index=p.outputs.length;index<raw(p,[]).fields.length;index++)for(const change of [f=>f.typeOid=21,f=>f.typeOid=23,f=>f.typeOid=1700,f=>f.name='__rs_parent']){
    const r=raw(p,[]);change(r.fields[index]);assert.throws(()=>decode(r,p),code('DATA'));
  }
});
test('profiles are closed exact records and output contracts cannot declare extra flags or arbitrary OIDs',()=>{
  const changes=[p=>p.extra=true,p=>delete p.readLimit,p=>p.partitionBy='missing',p=>p.correlateKeys=1,p=>p.outputs=[],p=>p.outputs[0].alias='__rs_pg_1',
    p=>p.outputs[1].property='parentId',p=>p.outputs[0].property='__proto__',p=>p.outputs[0].property='constructor',p=>p.outputs[0].property='prototype',
    p=>p.outputs[0].property='__rs_parent',p=>p.outputs[0].property='sqlite_hidden',p=>p.outputs[0].property='x'.repeat(64),p=>p.outputs[0].kind='numeric',
    p=>p.outputs[0].nullable=0,p=>p.outputs[0].typeOid=20,p=>p.outputs[0].extra=false];
  for(const change of changes){const p=profile();change(p);assert.throws(()=>decode(raw(profile(),[]),p),code('DATA'));}
});
test('only numeric uncorrelated and text correlated partitions are supported',()=>{
  for(const kind of ['real','boolean','json','text']){const p=profile({outputs:[output('parentId',kind)]});assert.throws(()=>decode(raw(p,[]),p),code('DATA'));}
  for(const kind of ['integer','bigint','real','boolean','json']){const p=textProfile({outputs:[output('parentId',kind)]});assert.throws(()=>decode(raw(p,[]),p),code('DATA'));}
  for(const key of [1n,1,null,{},'bad\0key','\ud800','\udfff','x'.repeat(1_048_577)]){const p=textProfile({keys:[key]});assert.throws(()=>decode(raw(p,[]),p),code('DATA'));}
  const p=textProfile({keys:['','😀','x'.repeat(1_048_576)]});assert.deepEqual(decode(raw(p,[]),p),[]);
});
test('profile numeric ranges, key bounds and maximum metadata are exact',()=>{
  for(const [name,badValues]of Object.entries({offset:[-1,1.1,1_000_000_001,NaN,Infinity,'1'],limit:[-1,1.1,1001,null],readLimit:[0,10002,-1,1.1,'1']}))
    for(const value of badValues){const p=profile({[name]:value});assert.throws(()=>decode(raw(p,[]),p),code('DATA'));}
  const p=profile({keys:new Array(400).fill(1n)});assert.deepEqual(decode(raw(p,[]),p),[]);
  for(const keys of [[],new Array(401).fill(1n)])assert.throws(()=>decode(raw(p,[]),{...p,keys}),code('DATA'));
  const wide=profile({outputs:Array.from({length:100},(_,i)=>output(i?'c'+i:'parentId','integer',false,i))});assert.deepEqual(decode(raw(wide,[]),wide),[]);
  wide.outputs.push(output('last','integer',false,100));assert.throws(()=>decode(raw(wide,[]),wide),code('DATA'));
});
test('aggregate profile-key UTF8 bytes admit exactly16MiB and refuse one extra byte as malformed profile',()=>{
  assert.equal(LIMITS.keyBytes,16_777_216);
  for(const keys of [new Array(16).fill('x'.repeat(1_048_576)),new Array(8).fill('é'.repeat(1_048_576))]){
    const p=textProfile({keys});assert.equal(keys.reduce((n,key)=>n+Buffer.byteLength(key),0),LIMITS.keyBytes);
    assert.deepEqual(decode(raw(p,[]),p),[]);
    assert.throws(()=>decode(raw(p,[]),{...p,keys:[...keys,'x']}),code('DATA'));
  }
});
test('null-prototype own data is valid, while class instances, holes, symbols and array extras refuse',()=>{
  const p=profile(),r=raw(p,[['1','x','1']]);Object.setPrototypeOf(p,null);Object.setPrototypeOf(r,null);Object.setPrototypeOf(p.keys,null);
  assert.equal(decode(r,p)[0].parentId,1n);
  for(const change of [p=>delete p.outputs[0],p=>p.keys.extra=1,p=>p.outputs[Symbol('hidden')]=1,p=>Object.setPrototypeOf(p.keys,{}),
    p=>p.outputs[0]=new(class{alias='__rs_pg_0';property='parentId';kind='bigint';nullable=false;})(),p=>Object.defineProperty(p,'limit',{value:1,enumerable:false})]){
    const p=profile();change(p);assert.throws(()=>decode(raw(profile(),[]),p),code('DATA'));
  }
});
test('raw/profile proxies and accessors are rejected without invoking traps at any depth',()=>{
  let calls=0;const trap=()=>{calls++;throw new Error(secret);},accessor={get:trap,enumerable:true,configurable:true};
  const proxy=target=>new Proxy(target,{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,has:trap});
  for(const make of [r=>proxy(r),r=>{r.fields=proxy(r.fields);return r;},r=>{r.fields[0]=proxy(r.fields[0]);return r;},r=>{r.rows=proxy(r.rows);return r;},r=>{r.rows[0]=proxy(r.rows[0]);return r;},
    r=>Object.defineProperty(r,'rows',accessor),r=>{Object.defineProperty(r.fields[0],'name',accessor);return r;},r=>{Object.defineProperty(r.rows[0],'0',accessor);return r;}])assert.throws(()=>decode(make(raw(profile(),[['1','x','1']])),profile()),code('DATA'));
  for(const make of [p=>proxy(p),p=>{p.outputs=proxy(p.outputs);return p;},p=>{p.outputs[0]=proxy(p.outputs[0]);return p;},p=>{p.keys=proxy(p.keys);return p;},p=>Object.defineProperty(p,'keys',accessor),p=>{Object.defineProperty(p.outputs[0],'kind',accessor);return p;}])assert.throws(()=>decode(raw(profile(),[]),make(profile())),code('DATA'));
  const revoked=Proxy.revocable(profile(),{});revoked.revoke();assert.throws(()=>decode(raw(profile(),[]),revoked.proxy),code('DATA'));assert.equal(calls,0);
});
test('branded snapshots are immutable shape evidence and still require profile framing and correlation validation',()=>{
  const p=profile(),r=raw(p,[['1','x','1']]),snapshot=snapshotPostgresResult(r);r.rows[0][0]='999';assert.equal(decode(snapshot,p)[0].parentId,1n);
  assert.throws(()=>decode(snapshot,{...p,keys:[2n]}),code('DATA'));
  assert.throws(()=>decode(snapshotPostgresResult(raw(p,[['1','x','2']])),p),code('DATA'));
});
test('all ordinary scalar families preserve canonical codec behavior on an independent mapped corpus',()=>{
  const corpus=[['integer',21,['-32768','32767']],['integer',23,['-2147483648','2147483647']],['integer',20,['-9007199254740991','9007199254740991']],
    ['bigint',20,[String(MIN),String(MAX)]],['real',700,['0.1','1e-45','-0']],['real',701,['5e-324','1.7976931348623157e308','-0']],
    ['text',25,['é𝄞',secret]],['text',1043,['varchar']],['boolean',16,['t','f']],['json',114,['null','{"a":[true,null,1]}','"\\u0000"','"\\ud800"']],['json',3802,['{"a":1}']]];
  for(const [kind,typeOid,values]of corpus){
    const p=profile({outputs:[output('parentId'),output('value',kind,false,1)]}),r=raw(p,values.map((value,i)=>['1',value,String(i+1)]));r.fields[1].typeOid=typeOid;
    const ordinary=decodePostgresStorage({...r,fields:r.fields.slice(0,2),rows:r.rows.map(row=>row.slice(0,2))},p.outputs,'SELECT');
    assert.deepEqual(decode(r,p),ordinary);
  }
});
test('invalid mapped physical widths, finite values, JSON and wire text retain DATA refusal',()=>{
  for(const [kind,typeOid,value]of [['integer',21,'32768'],['integer',23,'2147483648'],['bigint',20,'9223372036854775808'],['real',701,'Infinity'],['real',701,'NaN'],
    ['real',700,'1e-50'],['boolean',16,'true'],['json',114,'{"x":1e999}'],['text',25,'bad\0text'],['text',25,'\ud800'],['json',114,'"\udfff"']]){
    const p=profile({outputs:[output('parentId'),output('value',kind,false,1)]}),r=raw(p,[['1',value,'1']]);r.fields[1].typeOid=typeOid;
    assert.throws(()=>decode(r,p),code('DATA'));
  }
});
test('result records own their properties and never invoke inherited setters or mutate captured inputs',()=>{
  let calls=0;const descriptor=Object.assign(Object.create(null),{set(){calls++;throw new Error(secret);},configurable:true});
  try{Object.defineProperty(Object.prototype,'value',descriptor);Object.defineProperty(Object.prototype,'__rs_parent',descriptor);
    const p=textProfile(),r=raw(p,[['A','x','1','0']]),before=structuredClone({p,r}),rows=decode(freeze(r),freeze(p));
    assert.deepEqual({p,r},before);assert.equal(calls,0);assert.ok(Object.hasOwn(rows[0],'value'));assert.ok(Object.hasOwn(rows[0],'__rs_parent'));
    assert.equal(Object.getOwnPropertyDescriptor(rows[0],'__rs_parent').writable,true);
  }finally{delete Object.prototype.value;delete Object.prototype.__rs_parent;}
});

function wide(correlateKeys=false){
  const outputs=Array.from({length:100},(_,i)=>output(i?'c'+i:'parentId',i?'integer':correlateKeys?'text':'bigint',false,i));
  const p=profile({outputs,keys:Array.from({length:11},(_,i)=>correlateKeys?'key'+i:BigInt(i)),correlateKeys});
  const rows=Array.from({length:10001},(_,i)=>[correlateKeys?'key'+Math.floor(i/1000):String(Math.floor(i/1000)),String(i+1),...new Array(98).fill('0'),String(i%1000+1),...(correlateKeys?[String(Math.floor(i/1000))]:[])]);
  return {p,r:raw(p,rows)};
}
test('100 mapped fields and the10001st numeric sentinel decode in bounded batches without weakening ordinary1M cap',()=>{
  const {p,r}=wide();assert.equal(r.rows.length*r.fields.length,1_010_101);assert.equal(p.outputs.length*r.rows.length,POSTGRES_MAX_MAPPED_CELLS+100);
  const rows=decode(r,p);assert.equal(rows.length,10001);assert.deepEqual(rows.at(-1),Object.fromEntries(p.outputs.map((f,i)=>[f.property,i===0?10n:i===1?10001n:0n])));
  assert.throws(()=>decodePostgresStorage({...r,fields:r.fields.slice(0,100),rows:r.rows.map(row=>row.slice(0,100))},p.outputs,'SELECT'),code('DATA'));
});
test('100 mapped fields plus rank/parent at10001 rows preserve text source ordinals across the mapped batch boundary',()=>{
  const {p,r}=wide(true);assert.equal(r.rows.length*r.fields.length,1_020_102);const rows=decode(r,p);
  assert.equal(rows.length,10001);assert.equal(rows.at(-1).parentId,'key10');assert.equal(rows.at(-1).c1,10001n);assert.equal(rows.at(-1).__rs_parent,10n);assert.equal(Object.keys(rows.at(-1)).length,101);
});
test('late mapped conversion, membership and ordering failures after a full batch never return partial results',()=>{
  for(const mutate of [r=>r.rows.at(-1)[1]='9007199254740992',r=>r.rows.at(-1)[0]='999',r=>r.rows.at(-1)[0]='9',r=>r.rows.at(-1)[100]='2']){
    const {p,r}=wide();mutate(r);assert.throws(()=>decode(r,p),code('DATA'));
  }
});
test('UTF8 wire budget counts every physical name/token/cell and admits exactly16MiB',()=>{
  const p=textProfile({readLimit:1}),base=raw(p,[['a','','1','0']]),overhead=base.fields.reduce((n,f)=>n+Buffer.byteLength(f.name),0)+3;
  const available=LIMITS.bytes-overhead,ascii='x'.repeat(available);base.rows[0][1]=ascii;assert.equal(decode(base,p)[0].value.length,available);
  base.rows[0][1]=ascii+'x';assert.throws(()=>decode(base,p),code('RESULT_LIMIT'));
  const unicode='é'.repeat(Math.floor(available/2))+(available%2?'x':'');base.rows[0][1]=unicode;assert.equal(Buffer.byteLength(decode(base,p)[0].value),available);
  base.rows[0][1]=unicode+'x';assert.throws(()=>decode(snapshotPostgresResult(base),p),code('RESULT_LIMIT'));
});
test('precedence is malformed profile/metadata before bytes, then bytes before framing or mapped conversion',()=>{
  const p=profile(),r=raw(p,[['1','x'.repeat(LIMITS.bytes),'invalid-rank']]);
  assert.throws(()=>decode(r,{...p,extra:secret}),code('DATA'));
  const wrong=structuredClone(r);wrong.fields[0].typeOid=16;assert.throws(()=>decode(wrong,p),code('DATA'));
  assert.throws(()=>decode(r,p),code('RESULT_LIMIT'));
  const mapped=profile({outputs:[output('parentId'),output('value','json',false,1)]});
  assert.throws(()=>decode(raw(mapped,[['1','x'.repeat(LIMITS.bytes),'invalid-rank']]),mapped),code('RESULT_LIMIT'));
});
test('malformed raw rows, cell types and raw snapshot size remain bounded independently of logical profiles',()=>{
  const p=profile();for(const row of [null,[],['1','x'],['1','x','1','extra'],['1',1,'1']])assert.throws(()=>decode(raw(p,[row]),p),code('DATA'));
  const huge=raw(p,new Array(100001).fill(['1','x','1']));assert.throws(()=>decode(huge,p),code('DATA'));
  const fields=Array.from({length:512},(_,i)=>({name:'x'+i,typeOid:20}));
  assert.throws(()=>decode({command:'SELECT',rowCount:3000n,fields,rows:new Array(3000).fill(new Array(512).fill('0'))},p),code('DATA'));
});
test('deterministic numeric grouping corpus follows an independent rank/key oracle and detects a missing final rank',()=>{
  let state=0x9e3779b9;const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  for(let i=0;i<64;i++){
    const keys=[-(BigInt(next())<<24n),BigInt(next())<<24n],offset=next()%1000,p=profile({keys,offset});
    const rows=keys.flatMap(key=>Array.from({length:2+next()%5},(_,rank)=>[String(key),'sample',String(offset+rank+1)]));
    assert.deepEqual(decode(raw(p,rows),p).map(row=>row.parentId),rows.map(row=>BigInt(row[0])));
    const broken=structuredClone(rows);broken.at(-1)[2]=String(BigInt(broken.at(-1)[2])+1n);assert.throws(()=>decode(raw(p,broken),p),code('DATA'));
  }
});
