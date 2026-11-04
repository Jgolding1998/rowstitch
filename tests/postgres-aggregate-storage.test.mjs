import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=process.env.ROWSTITCH_TEST_DIST?pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/'):new URL('../dist/',import.meta.url);
const {decodePostgresAggregateStorage:decode}=await import(new URL('core/postgres-aggregate-storage.js',dist));
const {decodePostgresStorage}=await import(new URL('core/postgres-storage.js',dist));
const {snapshotPostgresResult}=await import(new URL('core/postgres-result.js',dist));
const {POSTGRES_AGGREGATE_LIMITS:LIMITS}=await import(new URL('core/postgres-aggregate-profile.js',dist));
const secret='SYNTHETIC_PRIVATE_AGGREGATE';
const code=expected=>error=>{assert.equal(error?.code,expected);assert.ok(!inspect(error,{showHidden:true,depth:8}).includes(secret));assert.equal(error.cause,undefined);return true;};
const field=(kind,index,extra)=>({kind,alias:'__rs_pg_'+index,...extra});
const profile=(kind,extra={},mode='group')=>({mode,fields:[field(kind,0,kind==='integer-sum'?{high:'__rs_sum_hi_0',low:'__rs_sum_lo_0',...extra}:{target:'value',...extra}),field('guard',1,{target:mode==='projected'?'__rs_ragg_bad':'__rs_bad'})]});
const raw=(p,oids,rows)=>({fields:p.fields.map((f,i)=>({name:f.alias,typeOid:oids[i]})),rows,command:'SELECT',rowCount:BigInt(rows.length)});
const values=(kind,oid,cells,extra={})=>{const p=profile(kind,extra);return decode(raw(p,[oid,23],cells.map(value=>[value,'0'])),p);};
const mapped=(kind,oid,cells,nullable=false,canonical=false)=>values('mapped',oid,cells,{storageKind:kind,nullable,canonical}).map(row=>row.value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

test('COUNT storage is exact nonnegative safe bigint; nullable, unsafe, malformed and wrong-OID counts refuse',()=>{
  assert.deepEqual(values('count',20,['0','1','9007199254740991']).map(r=>r.value),[0n,1n,9007199254740991n]);
  for(const text of [null,'-1','-0','9007199254740992','9223372036854775807','18446744073709551616','+1','01','1.0','1e2',' 1','1\0',secret])assert.throws(()=>values('count',20,[text]),code('DATA'));
  for(const oid of [21,23,1700,701,0])assert.throws(()=>values('count',oid,['1']),code('DATA'));
});

test('integer SUM uses an exact Euclidean high/low pair including negative totals, NULL and beyond-int64 values',()=>{
  const totals=[0n,1n,-1n,4294967295n,4294967296n,-4294967296n,-4294967297n,9007199254740993n,9223372036854775807n,-9223372036854775808n,2n**130n+71n,-(2n**130n)-71n];
  for(const [i,row]of values('integer-sum',1700,totals.map(String)).entries()){
    assert.equal(row.__rs_sum_hi_0,totals[i]>>32n);assert.equal(row.__rs_sum_lo_0,totals[i]&0xffffffffn);
    assert.equal(row.__rs_sum_hi_0*4294967296n+row.__rs_sum_lo_0,totals[i]);
  }
  assert.deepEqual(values('integer-sum',1700,[null,'12.000','-0.00']),[
    {__rs_sum_hi_0:null,__rs_sum_lo_0:null,__rs_bad:0n},{__rs_sum_hi_0:0n,__rs_sum_lo_0:12n,__rs_bad:0n},{__rs_sum_hi_0:0n,__rs_sum_lo_0:0n,__rs_bad:0n}]);
});

test('SUM decimal grammar refuses fractions, exponent, noncanonical integer spelling and nonfinite values',()=>{
  for(const text of ['','01','-01','+1','.0','1.','1.01','1.0001','-0.0001','1e3','NaN','Infinity','-Infinity',' 1','1\n','0x10','1_000',secret])assert.throws(()=>values('integer-sum',1700,[text]),code('DATA'));
  for(const oid of [20,23,701,25])assert.throws(()=>values('integer-sum',oid,['1']),code('DATA'));
});

test('NUMERIC integer/fraction digit boundaries accept native maxima and refuse one beyond without Number coercion',()=>{
  const digits='9'.repeat(LIMITS.integerDigits),decimal='-'+digits+'.'+'0'.repeat(LIMITS.fractionDigits),row=values('integer-sum',1700,[decimal])[0];
  const wanted=-BigInt(digits);assert.equal(row.__rs_sum_hi_0,wanted>>32n);assert.equal(row.__rs_sum_lo_0,wanted&0xffffffffn);
  assert.throws(()=>values('integer-sum',1700,['1'.repeat(LIMITS.integerDigits+1)]),code('DATA'));
  assert.throws(()=>values('integer-sum',1700,['0.'+'0'.repeat(LIMITS.fractionDigits+1)]),code('DATA'));
  assert.throws(()=>values('integer-sum',1700,['1.'+'0'.repeat(LIMITS.fractionDigits)+'1']),code('DATA'));
});

test('real aggregate keeps finite float8 extremes, NULL and signed zero; only literal infinities mean range',()=>{
  const result=values('real-aggregate',701,[null,'-0','0.1','5e-324','-5e-324','1.7976931348623157e308']).map(r=>r.value);
  assert.equal(result[0],null);assert.ok(Object.is(result[1],-0));assert.equal(result[2],.1);assert.equal(result[3],Number.MIN_VALUE);assert.equal(result[4],-Number.MIN_VALUE);assert.equal(result[5],Number.MAX_VALUE);
  for(const text of ['Infinity','-Infinity'])assert.throws(()=>values('real-aggregate',701,[text]),code('AGGREGATE_RANGE'));
  for(const text of ['NaN','+Infinity','infinity','1e309','1e-400','+1','01','1.','0x10','1junk',' 1','',secret,'1'.repeat(65)])assert.throws(()=>values('real-aggregate',701,[text]),code('DATA'));
  for(const oid of [700,1700,20])assert.throws(()=>values('real-aggregate',oid,['1']),code('DATA'));
});

test('the input DATA guard is scanned across all rows before any range conversion',()=>{
  const p=profile('real-aggregate');
  for(const rows of [[['Infinity','1']],[['Infinity','0'],['1','1']],[['Infinity','0'],['1',null]],[['Infinity','0'],['1','01']]])assert.throws(()=>decode(raw(p,[701,23],rows),p),code('DATA'));
  assert.throws(()=>decode(raw(p,[701,23],[['Infinity','0']]),p),code('AGGREGATE_RANGE'));
});

test('guard has exact mode target, OID23 and text0; NULL, booleans and alternate spellings refuse',()=>{
  for(const mode of ['aggregate','group','projected']){
    const p=profile('count',{},mode);assert.equal(decode(raw(p,[20,23],[['1','0']]),p)[0][mode==='projected'?'__rs_ragg_bad':'__rs_bad'],0n);
    for(const value of ['1',null,'-0','00','t','f','false',''])assert.throws(()=>decode(raw(p,[20,23],[['1',value]]),p),code('DATA'));
    for(const oid of [20,16,1700])assert.throws(()=>decode(raw(p,[20,oid],[]),p),code('DATA'));
  }
});

test('ordinary mapped families retain the exact M14 scalar/storage behavior across physical widths and codecs',()=>{
  const corpus=[['integer',21,['-32768','0','32767']],['integer',23,['-2147483648','2147483647']],['integer',20,['-9007199254740991','9007199254740991']],
    ['bigint',20,['-9223372036854775808','9223372036854775807']],['real',700,['0.1','1e-45','-0']],['real',701,['5e-324','1.7976931348623157e308','-0']],
    ['text',25,['é𝄞',secret]],['text',1043,['varchar']],['boolean',16,['t','f']],['json',114,['null','{"a":[true,null,1]}','"\\u0000"','"\\ud800"']],['json',3802,['{"a":1}']]];
  for(const [kind,oid,cells]of corpus){
    const original=decodePostgresStorage({fields:[{name:'__rs_pg_0',typeOid:oid}],rows:cells.map(v=>[v]),command:'SELECT',rowCount:BigInt(cells.length)},[{alias:'__rs_pg_0',property:'p',kind,nullable:false}],'SELECT').map(row=>row.p);
    assert.deepEqual(mapped(kind,oid,cells),original);
  }
  assert.equal(mapped('real',700,['0.1'])[0],Math.fround(.1));assert.notEqual(mapped('real',700,['0.1'])[0],.1);
});

test('canonical mapped slots require the promised exact OID, including JSON114 rather than JSONB3802',()=>{
  const cases=[['integer',20,'1',[21,23]],['bigint',20,'9223372036854775807',[21,23]],['real',701,'.1',[700]],['text',25,'plain',[1043]],['boolean',16,'t',[23]],['json',114,'{"a":1}',[3802]]];
  for(const [kind,oid,text,wrong]of cases){
    const cell=kind==='real'?'0.1':text;assert.equal(mapped(kind,oid,[cell],false,true).length,1);
    for(const other of wrong)assert.throws(()=>mapped(kind,other,[cell],false,true),code('DATA'));
  }
});

test('mapped widths, nullability, finite values, UTF8 wire text and shared JSON limits stay strict',()=>{
  for(const [kind,oid,text]of [['integer',21,'32768'],['integer',23,'2147483648'],['integer',20,'9007199254740992'],['bigint',20,'9223372036854775808'],
    ['real',701,'Infinity'],['real',701,'NaN'],['real',700,'1e-50'],['boolean',16,'true'],['json',114,'{"x":1e999}'],['text',25,'bad\0text'],['text',25,'\ud800'],['json',114,'"\udfff"']])assert.throws(()=>mapped(kind,oid,[text]),code('DATA'));
  for(const [kind,oid]of [['integer',20],['bigint',20],['real',701],['text',25],['boolean',16],['json',114]]){
    assert.deepEqual(mapped(kind,oid,[null],true),[null]);assert.throws(()=>mapped(kind,oid,[null]),code('DATA'));
  }
  assert.throws(()=>mapped('json',114,[' '.repeat(1_048_577)]),code('DATA'));
});

test('all original metadata is checked, even empty groups, before detached mapped-codec projection',()=>{
  const p=profile('mapped',{storageKind:'text',nullable:false,canonical:false});
  assert.deepEqual(decode(raw(p,[25,23],[]),p),[]);
  for(const change of [r=>r.fields[0].name='wrong',r=>r.fields[1].name='__rs_pg_0',r=>r.fields.reverse(),r=>r.fields[0].typeOid=20,r=>r.fields[1].typeOid=20,r=>r.fields.push({name:'extra',typeOid:25})]){
    const r=raw(p,[25,23],[]);change(r);assert.throws(()=>decode(r,p),code('DATA'));
  }
});

test('aggregate requires exactly one row; group/projected allow empty and multiple rows with exact SELECT counts',()=>{
  for(const mode of ['group','projected']){const p=profile('count',{},mode);assert.deepEqual(decode(raw(p,[20,23],[]),p),[]);assert.equal(decode(raw(p,[20,23],[['1','0'],['2','0']]),p).length,2);}
  const p=profile('count',{},'aggregate');
  for(const rows of [[],[['1','0'],['2','0']]])assert.throws(()=>decode(raw(p,[20,23],rows),p),code('DATA'));
  for(const change of [r=>r.command='UPDATE',r=>r.rowCount=null,r=>r.rowCount=0n,r=>r.rowCount=1,r=>r.rows[0].pop(),r=>r.rows[0].push('extra'),r=>r.rows[0][0]=1]){
    const r=raw(p,[20,23],[['1','0']]);change(r);assert.throws(()=>decode(r,p),code('DATA'));
  }
});

test('profile variants are closed plain records with no arbitrary OIDs, flags, targets or extra fields',()=>{
  const changes=[p=>p.mode='select',p=>p.extra=true,p=>delete p.mode,p=>p.fields[0].extra=1,p=>p.fields[0].kind='numeric',p=>p.fields[0].alias='__rs_pg_1',
    p=>p.fields[0].target='bad name',p=>p.fields[0].target='__proto__',p=>p.fields[0].target='constructor',p=>p.fields[0].target='prototype',p=>p.fields[0].target='sqlite_x',
    p=>p.fields[0].target='x'.repeat(64),p=>p.fields[1].target='__rs_ragg_bad',p=>p.fields[0].target='__rs_bad',p=>p.fields.pop(),p=>p.fields.push(field('guard',2,{target:'__rs_bad'})),
    p=>p.fields[0].typeOid=20,p=>p.fields[0].nullable=false];
  for(const change of changes){const p=profile('count');change(p);assert.throws(()=>decode(raw(profile('count'),[20,23],[['1','0']]),p),code('DATA'));}
  const same=profile('integer-sum',{high:'same',low:'same'});assert.throws(()=>decode(raw(same,[1700,23],[['1','0']]),same),code('DATA'));
  const renamed=profile('count');renamed.fields[0].alias='__rs_pg_count';assert.throws(()=>decode(raw(renamed,[20,23],[['1','0']]),renamed),code('DATA'));
  const onlyGuard={mode:'group',fields:[field('guard',0,{target:'__rs_bad'})]};assert.throws(()=>decode(raw(onlyGuard,[23],[]),onlyGuard),code('DATA'));
  for(const change of [p=>p.fields[0].canonical=undefined,p=>p.fields[0].nullable=0,p=>p.fields[0].storageKind='numeric']){const p=profile('mapped',{storageKind:'integer',nullable:false,canonical:false});change(p);assert.throws(()=>decode(raw(p,[20,23],[['1','0']]),p),code('DATA'));}
});

test('plain/null-prototype captured inputs work; arrays with holes/extras/custom prototypes refuse',()=>{
  const p=profile('count'),r=raw(p,[20,23],[['1','0']]);Object.setPrototypeOf(p,null);Object.setPrototypeOf(r,null);assert.equal(decode(r,p)[0].value,1n);
  for(const modify of [p=>delete p.fields[0],p=>p.fields.extra=1,p=>Object.setPrototypeOf(p.fields,{}),p=>p.fields[0]=new(class{kind='count';alias='__rs_pg_0';target='value';})()]){const p=profile('count');modify(p);assert.throws(()=>decode(raw(profile('count'),[20,23],[['1','0']]),p),code('DATA'));}
});

test('raw/profile/metadata/row accessors and proxies are rejected without invoking any supplied code',()=>{
  let calls=0;const trap=()=>{calls++;throw new Error(secret);},accessor={get:trap,enumerable:true,configurable:true};
  const proxy=target=>new Proxy(target,{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,has:trap});
  for(const make of [r=>proxy(r),r=>{r.fields=proxy(r.fields);return r;},r=>{r.fields[0]=proxy(r.fields[0]);return r;},r=>{r.rows=proxy(r.rows);return r;},r=>{r.rows[0]=proxy(r.rows[0]);return r;},
    r=>Object.defineProperty(r,'rows',accessor),r=>{Object.defineProperty(r.fields[0],'name',accessor);return r;},r=>{Object.defineProperty(r.rows[0],'0',accessor);return r;}]){
    const p=profile('count');assert.throws(()=>decode(make(raw(p,[20,23],[['1','0']])),p),code('DATA'));
  }
  for(const make of [p=>proxy(p),p=>{p.fields=proxy(p.fields);return p;},p=>{p.fields[0]=proxy(p.fields[0]);return p;},p=>Object.defineProperty(p,'mode',accessor),p=>{Object.defineProperty(p.fields[0],'kind',accessor);return p;}])assert.throws(()=>decode(raw(profile('count'),[20,23],[['1','0']]),make(profile('count'))),code('DATA'));
  const revoked=Proxy.revocable(profile('count'),{});revoked.revoke();assert.throws(()=>decode(raw(profile('count'),[20,23],[['1','0']]),revoked.proxy),code('DATA'));assert.equal(calls,0);
});

test('result properties are owned data even with inherited setters; caller data/profile remain detached',()=>{
  let writes=0;Object.defineProperty(Object.prototype,'value',{set(){writes++;throw new Error(secret);},configurable:true});
  try{const p=profile('count'),r=raw(p,[20,23],[['1','0']]),before=structuredClone({p,r});const result=decode(freeze(r),freeze(p));
    assert.deepEqual({p,r},before);assert.equal(result[0].value,1n);assert.ok(Object.hasOwn(result[0],'value'));assert.equal(Object.getOwnPropertyDescriptor(result[0],'value').writable,true);assert.equal(writes,0);
  }finally{delete Object.prototype.value;}
});

test('branded immutable raw snapshots still obey aggregate metadata, cardinality and guard policies',()=>{
  const p=profile('count'),r=raw(p,[20,23],[['1','0']]),snapshot=snapshotPostgresResult(r);r.rows[0][0]='changed';assert.equal(decode(snapshot,p)[0].value,1n);
  assert.throws(()=>decode(snapshotPostgresResult(raw(p,[20,23],[['1','1']])),p),code('DATA'));
  assert.throws(()=>decode(snapshotPostgresResult(raw(p,[20,20],[])),p),code('DATA'));
});

test('raw UTF8 byte budget counts names/all cells, accepts exact boundary and refuses unbranded or branded excess',()=>{
  const p=profile('mapped',{storageKind:'text',nullable:false,canonical:false}),overhead=p.fields.reduce((n,f)=>n+Buffer.byteLength(f.alias),0)+1;
  const text='x'.repeat(LIMITS.bytes-overhead),r=raw(p,[25,23],[[text,'0']]);assert.equal(decode(r,p)[0].value.length,text.length);
  const tooLarge=raw(p,[25,23],[[text+'x','0']]);assert.throws(()=>decode(tooLarge,p),code('RESULT_LIMIT'));assert.throws(()=>decode(snapshotPostgresResult(tooLarge),p),code('RESULT_LIMIT'));
  const unicode=raw(p,[25,23],[['é'.repeat(Math.floor((LIMITS.bytes-overhead)/2)+1),'0']]);assert.throws(()=>decode(unicode,p),code('RESULT_LIMIT'));
});

test('a valid large projected text page is a resource limit rather than malformed stored data',()=>{
  const p=profile('mapped',{storageKind:'text',nullable:false,canonical:true},'projected');
  const text='x'.repeat(1_048_576),rows=new Array(17).fill([text,'0']);
  assert.throws(()=>decode(raw(p,[25,23],rows),p),code('RESULT_LIMIT'));
  const ordinary={fields:[{name:'__rs_pg_0',typeOid:25}],rows:rows.map(row=>[row[0]]),command:'SELECT',rowCount:17n};
  assert.equal(decodePostgresStorage(ordinary,[{alias:'__rs_pg_0',property:'value',kind:'text',nullable:false}],'SELECT').length,17);
});

test('field/row/cell limits hold before conversion, including maximum empty metadata and repeated large row input',()=>{
  const p={mode:'group',fields:[...Array.from({length:LIMITS.fields-1},(_,i)=>field('count',i,{target:'p'+i})),field('guard',LIMITS.fields-1,{target:'__rs_bad'})]};
  assert.deepEqual(decode(raw(p,new Array(LIMITS.fields).fill(20).map((x,i)=>i===LIMITS.fields-1?23:x),[]),p),[]);
  p.fields.push(field('count',LIMITS.fields,{target:'last'}));assert.throws(()=>decode(raw(p,new Array(p.fields.length).fill(20),[]),p),code('DATA'));
  const q=profile('count'),r=raw(q,[20,23],new Array(LIMITS.rows).fill(['0','0']));assert.equal(decode(r,q).length,LIMITS.rows);
  r.rows.push(['0','0']);r.rowCount++;assert.throws(()=>decode(r,q),code('DATA'));
  const many={mode:'group',fields:[...Array.from({length:13},(_,i)=>field('count',i,{target:'v'+i})),field('guard',13,{target:'__rs_bad'})]};
  assert.throws(()=>decode(raw(many,[...new Array(13).fill(20),23],new Array(100_000).fill(new Array(14).fill('0'))),many),code('DATA'));
});

test('deterministic signed arbitrary-size integer corpus preserves sum exactly without float conversion',()=>{
  let state=0x9e3779b9;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const totals=[];for(let i=0;i<256;i++){let n=0n;for(let j=0;j<1+i%8;j++)n=n<<32n|BigInt(random());totals.push(i%2?-n:n);}
  const rows=values('integer-sum',1700,totals.map((n,i)=>n.toString()+(i%3===0?'.0000':'')));
  rows.forEach((row,i)=>{assert.equal(row.__rs_sum_hi_0,totals[i]>>32n);assert.equal(row.__rs_sum_lo_0,totals[i]&0xffffffffn);});
});
