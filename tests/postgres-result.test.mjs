import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPostgresValue, decodePostgresRows, isPostgresRawResult, snapshotPostgresResult } from '../dist/core/postgres-result.js';

const code = wanted => error => error?.code === wanted && !error.message.includes('SYNTHETIC_PRIVATE_VALUE');
const oid = { integer:20, bigint:20, real:701, text:25, boolean:16, json:3802 };
const output = (kind, nullable=false) => [{ alias:'v', property:'value', kind, nullable }];
const raw = (kind, values) => ({ fields:[{name:'v',typeOid:oid[kind]}], rows:values.map(value=>[value]), command:'SELECT', rowCount:BigInt(values.length) });
const values = (kind, input, nullable=false) => decodePostgresRows(raw(kind,input),output(kind,nullable)).map(row=>row.value);

test('wire binding captures six logical kinds with constant explicit cast names',()=>{
  const cases = [
    ['integer',Number.MAX_SAFE_INTEGER,'bigint','9007199254740991'],
    ['bigint',9223372036854775807n,'bigint','9223372036854775807'],
    ['bigint',-9223372036854775808n,'bigint','-9223372036854775808'],
    ['real',-0,'double precision','-0'],['real',0.125,'double precision','0.125'],
    ['text',"🙂 ' $1 OR 1=1 --",'text',"🙂 ' $1 OR 1=1 --"],
    ['boolean',true,'boolean','true'],['boolean',false,'boolean','false'],
    ['json',{enabled:true,exact:'9223372036854775807'},'jsonb','{"enabled":true,"exact":"9223372036854775807"}'],
  ];
  for(const [kind,value,cast,expected] of cases) {
    const bound=bindPostgresValue(kind,value);
    assert.deepEqual(bound,{kind,cast,value:expected});assert.ok(Object.isFrozen(bound));
  }
});

test('nullable binds remain SQL NULL; non-null and unsupported scalar inputs are rejected',()=>{
  for(const kind of Object.keys(oid)) {
    assert.equal(bindPostgresValue(kind,null,true).value,null);
    assert.throws(()=>bindPostgresValue(kind,null),code('VALIDATION'));
  }
  for(const [kind,value] of [['integer',9007199254740992],['integer',1n],['bigint',1],['bigint',9223372036854775808n],
    ['real',NaN],['real',Infinity],['text',3],['boolean',1],['json',{x:undefined}],['uuid','not-supported']])
    assert.throws(()=>bindPostgresValue(kind,value),code('VALIDATION'));
  assert.throws(()=>bindPostgresValue('text','ok',1),code('VALIDATION'));
});

test('PostgreSQL refuses NUL and lone surrogates before binding, including JSON keys and nested values',()=>{
  for(const invalid of ['before\0after','\ud800','\udfff']) {
    assert.throws(()=>bindPostgresValue('text',invalid),code('VALIDATION'));
    assert.throws(()=>bindPostgresValue('json',{nested:[invalid]}),code('VALIDATION'));
    assert.throws(()=>bindPostgresValue('json',{[invalid]:'key'}),code('VALIDATION'));
  }
  assert.equal(bindPostgresValue('text','𐀀🙂').value,'𐀀🙂');
});

test('JSON binding takes an immutable value snapshot without executing data accessors',()=>{
  const data={nested:{name:'first'},items:[1,true]};
  const captured=bindPostgresValue('json',data);data.nested.name='later';data.items.push(3);
  assert.equal(captured.value,'{"nested":{"name":"first"},"items":[1,true]}');
  let called=0;const getter={get data(){called++;return 'SYNTHETIC_PRIVATE_VALUE';}};
  assert.throws(()=>bindPostgresValue('json',getter),code('VALIDATION'));assert.equal(called,0);
  const cycle={};cycle.self=cycle;assert.throws(()=>bindPostgresValue('json',cycle),code('VALIDATION'));
  assert.throws(()=>bindPostgresValue('text','x'.repeat(1_048_577)),code('VALIDATION'));
});

test('int64 decoding is exact and safe integers never silently narrow',()=>{
  assert.deepEqual(values('bigint',['-9223372036854775808','0','9223372036854775807']),[-9223372036854775808n,0n,9223372036854775807n]);
  assert.deepEqual(values('integer',['-9007199254740991','0','9007199254740991']),[-9007199254740991,0,9007199254740991]);
  for(const text of ['9007199254740992','-9007199254740992']) assert.throws(()=>values('integer',[text]),code('DATA'));
  for(const text of ['9223372036854775808','-9223372036854775809','01','-0','+1','1.0','1e2',' 1','0x10',''])
    assert.throws(()=>values('bigint',[text]),code('DATA'));
});

test('finite real decoding preserves minus zero and subnormals, rejects overflow and underflow',()=>{
  const decoded=values('real',['-0','0.125','1.7976931348623157e+308','5e-324']);
  assert.ok(Object.is(decoded[0],-0));assert.equal(decoded[1],0.125);assert.equal(decoded[2],Number.MAX_VALUE);assert.equal(decoded[3],Number.MIN_VALUE);
  for(const text of ['NaN','Infinity','-Infinity','1e309','1e-400','0x10','1junk','+1',' 1','', '1'.repeat(65)])
    assert.throws(()=>values('real',[text]),code('DATA'));
});

test('boolean parsing accepts native PostgreSQL text, never SQLite bits or truthy strings',()=>{
  assert.deepEqual(values('boolean',['t','f',null],true),[true,false,null]);
  for(const text of ['1','0','true','false','yes','', 'TRUE']) assert.throws(()=>values('boolean',[text]),code('DATA'));
});

test('JSON decoding uses the finite shared JSON contract and distinguishes SQL NULL from JSON null',()=>{
  assert.deepEqual(values('json',['{"items":[true,null,1],"exact":"9223372036854775807"}']),[{items:[true,null,1],exact:'9223372036854775807'}]);
  assert.deepEqual(values('json',['null']),[null]);
  assert.throws(()=>values('json',[null]),code('DATA'));
  assert.deepEqual(values('json',[null],true),[null]);
  for(const text of ['not json','{"n":1e999}','"\\u0000"','"\\ud800"','{"\\u0000":1}', ' '.repeat(1_048_577)])
    assert.throws(()=>values('json',[text]),code('DATA'));
  let deep=0;for(let i=0;i<65;i++) deep=[deep];assert.throws(()=>values('json',[JSON.stringify(deep)]),code('DATA'));
});

test('a JSON __proto__ key stays ordinary data through capture and decoding',()=>{
  const input=JSON.parse('{"__proto__":{"polluted":true},"value":1}');
  const bound=bindPostgresValue('json',input),decoded=values('json',[bound.value])[0];
  assert.deepEqual(decoded,input);assert.ok(Object.hasOwn(decoded,'__proto__'));
  assert.equal(Object.getPrototypeOf(decoded),Object.prototype);assert.equal({}.polluted,undefined);
});

test('OIDs and aliases are mandatory even on empty results',()=>{
  for(const kind of Object.keys(oid)) {
    assert.deepEqual(decodePostgresRows(raw(kind,[]),output(kind)),[]);
    const wrong=raw(kind,[]);wrong.fields[0].typeOid=1700;
    assert.throws(()=>decodePostgresRows(wrong,output(kind)),code('DATA'));
    const otherName=raw(kind,[]);otherName.fields[0].name='another';
    assert.throws(()=>decodePostgresRows(otherName,output(kind)),code('DATA'));
  }
  const int4=raw('integer',['1']);int4.fields[0].typeOid=23;
  assert.throws(()=>decodePostgresRows(int4,output('integer')),code('DATA'));
});

test('duplicate wire names are decoded by position into distinct mapped properties',()=>{
  const result={fields:[{name:'v',typeOid:20},{name:'v',typeOid:25}],rows:[['9223372036854775807','right']],command:'SELECT',rowCount:1n};
  assert.deepEqual(decodePostgresRows(result,[{alias:'v',property:'left',kind:'bigint',nullable:false},{alias:'v',property:'right',kind:'text',nullable:false}]),[{left:9223372036854775807n,right:'right'}]);
  const duplicate=[...output('bigint'),...output('text')];assert.throws(()=>decodePostgresRows(result,duplicate),code('DATA'));
});

test('raw snapshots are detached and frozen, including exact large row counts',()=>{
  const input=raw('text',['first']);input.rowCount=9007199254740993n;
  const copy=snapshotPostgresResult(input);input.fields[0].name='changed';input.rows[0][0]='changed';
  assert.equal(copy.fields[0].name,'v');assert.equal(copy.rows[0][0],'first');assert.equal(copy.rowCount,9007199254740993n);
  for(const part of [copy,copy.fields,copy.fields[0],copy.rows,copy.rows[0]]) assert.ok(Object.isFrozen(part));
});

test('the private result guard recognizes only validated immutable snapshots, not lookalike records',()=>{
  const plain=raw('text',['ok']), snapshot=snapshotPostgresResult(plain);
  assert.equal(isPostgresRawResult(plain),false);assert.equal(isPostgresRawResult(Object.freeze({...snapshot})),false);
  assert.equal(isPostgresRawResult(snapshot),true);assert.equal(snapshotPostgresResult(snapshot),snapshot);
  let called=0;const thenable={...plain,then(){called++;}};
  assert.throws(()=>snapshotPostgresResult(thenable),code('DATA'));assert.equal(called,0);
  assert.equal(isPostgresRawResult(thenable),false);
});

test('malformed raw structures, parsed driver scalars and missing field information are refused',()=>{
  for(const change of [r=>{delete r.rowCount;},r=>{r.rowCount=1;},r=>{r.rowCount=-1n;},r=>{r.rowCount=2n**64n;},r=>{r.command='SELECT 1';},r=>{r.command='';},
    r=>{r.fields[0].typeOid=0;},r=>{r.fields[0].typeOid=1.5;},r=>{r.fields[0].typeOid=2**32;},r=>{r.fields[0].extra=true;},
    r=>{r.rows[0]=[];},r=>{r.rows[0]=['x','y'];},r=>{r.rows[0][0]=1;},r=>{r.rows[0][0]=true;},r=>{r.rows[0][0]={};},
    r=>{r.rows=new Array(2);},r=>{r.rows[0]=new Array(1);},r=>{r.rows[Symbol('hidden')]=true;},r=>{r.rows[0].extra=true;},
    r=>{Object.setPrototypeOf(r.rows[0],{});},r=>{r.fields[0].name='\ud800';},r=>{r.rows=new Array(100_001);},r=>{r.fields=new Array(513);},
  ]) {const result=raw('text',['SYNTHETIC_PRIVATE_VALUE']);change(result);assert.throws(()=>snapshotPostgresResult(result),code('DATA'));}
});

test('driver accessors are never called and hostile proxy errors do not disclose their messages',()=>{
  let calls=0;const result=raw('text',['ok']);Object.defineProperty(result.rows,'0',{get(){calls++;throw new Error('SYNTHETIC_PRIVATE_VALUE');},enumerable:true});
  assert.throws(()=>snapshotPostgresResult(result),code('DATA'));assert.equal(calls,0);
  const proxy=new Proxy({}, {getPrototypeOf(){throw new Error('SYNTHETIC_PRIVATE_VALUE');}});
  assert.throws(()=>snapshotPostgresResult(proxy),code('DATA'));
});

test('mapped properties and output metadata are validated without invoking accessors',()=>{
  for(const property of ['__proto__','constructor','prototype','bad-name','__rs_private'])
    assert.throws(()=>decodePostgresRows(raw('text',['ok']),[{...output('text')[0],property}]),code('DATA'));
  for(const change of [r=>{r.kind='uuid';},r=>{r.nullable=1;},r=>{r.alias='bad alias';},r=>{r.extra=true;}]) {
    const field={...output('text')[0]};change(field);assert.throws(()=>decodePostgresRows(raw('text',['ok']),[field]),code('DATA'));
  }
  let called=0;const field={...output('text')[0]};Object.defineProperty(field,'kind',{get(){called++;return 'text';},enumerable:true});
  assert.throws(()=>decodePostgresRows(raw('text',['ok']),[field]),code('DATA'));assert.equal(called,0);
  assert.throws(()=>values('text',['bad\0text']),code('DATA'));assert.throws(()=>values('text',['\ud800']),code('DATA'));
});
