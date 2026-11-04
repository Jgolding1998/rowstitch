import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPostgresEncoded, compilePostgres } from '../dist/core/postgres-compiler.js';
import { queryModel, tableModel } from '../dist/core/query-model.js';
import { encode } from '../dist/core/schema.js';
import { bindPostgresValue } from '../dist/core/postgres-result.js';

const types={id:'integer',wide:'bigint',ratio:'real',label:'text',enabled:'boolean',doc:'json',version:'integer'};
const table=tableModel({name:'sample_rows',columns:Object.keys(types),primaryKey:['id'],kinds:types,
  nullable:Object.fromEntries(Object.keys(types).map(k=>[k,k==='label'||k==='doc'])),version:'version'});
const child=tableModel({name:'sample_children',columns:['id','parentId','active'],primaryKey:['id'],
  kinds:{id:'integer',parentId:'bigint',active:'boolean'},nullable:{id:false,parentId:false,active:true}});
const compare=(column,operator,values)=>({kind:'compare',column,operator,values});
const select=(overrides={})=>queryModel.select({table,columns:['id'],orderBy:[],limit:10,offset:0,...overrides});
const count=where=>queryModel.count({table,...(where===undefined?{}:{where})});
const code=(...expected)=>error=>expected.includes(error?.code)&&!error.message.includes('PRIVATE_TEST_VALUE');
const cfg=(kind,nullable=false)=>({kind,nullable,primary:false,generated:false,unique:false,hasDefault:false});

test('PostgreSQL SELECT has fixed positional aliases and a qualified table',()=>{
  const q=compilePostgres(select());
  assert.equal(q.sql,'SELECT "__rs_pg_root"."id" AS "__rs_pg_0" FROM "public"."sample_rows" AS "__rs_pg_root" LIMIT $1::"pg_catalog"."int8" OFFSET $2::"pg_catalog"."int8"');
  assert.deepEqual(q.parameters,['10','0']);assert.equal(q.command,'SELECT');
  assert.deepEqual(q.outputs,[{alias:'__rs_pg_0',property:'id',kind:'integer',nullable:false}]);
  assert.equal(q.count,undefined);
});
test('selected order and nullability define metadata independently of returned rows',()=>{
  const q=compilePostgres(select({columns:['doc','label','enabled','id']}),{schema:'sample_space'});
  assert.deepEqual(q.outputs.map(o=>[o.alias,o.property,o.kind,o.nullable]),[
    ['__rs_pg_0','doc','json',true],['__rs_pg_1','label','text',true],['__rs_pg_2','enabled','boolean',false],['__rs_pg_3','id','integer',false],
  ]);
  assert.match(q.sql,/FROM "sample_space"\."sample_rows"/);
});
test('ordering pins SQLite NULL placement while page bounds remain typed bindings',()=>{
  const q=compilePostgres(select({orderBy:[{column:'label',direction:'ASC'},{column:'ratio',direction:'DESC'}],limit:0,offset:1_000_000_000}));
  assert.match(q.sql,/ORDER BY "__rs_pg_root"\."label" ASC NULLS FIRST, "__rs_pg_root"\."ratio" DESC NULLS LAST LIMIT/);
  assert.deepEqual(q.parameters,['0','1000000000']);
});
test('all supported values bind from their encoded image without JSON double encoding',()=>{
  const logical=[7,9_007_199_254_740_993n,-0,'quote\' %_\\ 😀',true,{b:[1,false],a:'sample'}];
  const columns=['id','wide','ratio','label','enabled','doc'];
  const values=logical.map((v,i)=>encode(cfg(types[columns[i]],table.nullable[columns[i]]),v));
  const q=compilePostgres(queryModel.insert({table,columns,values}));
  assert.deepEqual(q.parameters,['7','9007199254740993','-0',logical[3],'true','{"b":[1,false],"a":"sample"}']);
  assert.match(q.sql,/OVERRIDING SYSTEM VALUE VALUES/);
  assert.match(q.sql,/\$5::"pg_catalog"\."bool", \$6::"pg_catalog"\."json"/);
  assert.equal(q.command,'INSERT');assert.equal(q.outputs.length,table.columns.length);
  assert.ok(!q.sql.includes(logical[3]));assert.ok(!q.sql.includes('"b":'));
});
test('strict wire inversion agrees with the existing logical binder over edge values',()=>{
  const corpus={id:[0,-0,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],wide:[0n,-(2n**63n),2n**63n-1n],
    ratio:[-0,0,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,1e21,0.1],label:['','😀','%_\\','x\ny'],
    enabled:[false,true],doc:[false,0,-0,'null',[],{a:[null,true,1],b:'x'}]};
  for(const [column,items] of Object.entries(corpus))for(const value of items){
    const kind=types[column],encoded=encode(cfg(kind,table.nullable[column]),value);
    const q=compilePostgres(queryModel.insert({table,columns:[column],values:[encoded]}));
    assert.equal(q.parameters[0],bindPostgresValue(kind,value,table.nullable[column]).value,`${column}: wire differs`);
  }
});
test('empty inserts preserve DEFAULT VALUES and every returned mapped field',()=>{
  const q=compilePostgres(queryModel.insert({table,columns:[],values:[]}));
  assert.match(q.sql,/ DEFAULT VALUES RETURNING /);assert.ok(!q.sql.includes('OVERRIDING'));
  assert.deepEqual(q.parameters,[]);assert.deepEqual(q.outputs.map(f=>f.property),table.columns);
});
test('explicit nullable SQL NULL differs from an omitted JSON field',()=>{
  const q=compilePostgres(queryModel.insert({table,columns:['doc'],values:[null]}));
  assert.deepEqual(q.parameters,[null]);assert.match(q.sql,/\$1::"pg_catalog"\."json"/);
  assert.throws(()=>compilePostgres(queryModel.insert({table,columns:['enabled'],values:[null]})),code('VALIDATION'));
});
test('UPDATE bindings precede filters and the version increments atomically',()=>{
  const q=compilePostgres(queryModel.update({table,assignments:[{column:'label',value:'changed'},{column:'enabled',value:0}],where:compare('id','=',[4])}));
  assert.deepEqual(q.parameters,['changed','false','4']);assert.equal(q.command,'UPDATE');
  assert.match(q.sql,/SET "label" = \$1::"pg_catalog"\."text", "enabled" = \$2::"pg_catalog"\."bool", "version" = "__rs_pg_root"\."version" OPERATOR\("pg_catalog"\.\+\) 1 WHERE/);
  assert.match(q.sql,/RETURNING "__rs_pg_root"\."id" AS "__rs_pg_0"/);
  assert.deepEqual(q.outputs.map(f=>f.property),table.columns);
});
test('DELETE returns explicit typed columns instead of RETURNING star',()=>{
  const q=compilePostgres(queryModel.delete({table,where:compare('id','IN',[2,3])}));
  assert.equal(q.command,'DELETE');assert.deepEqual(q.parameters,['2','3']);
  assert.ok(!q.sql.includes('RETURNING *'));assert.equal(q.outputs.length,table.columns.length);
});
test('count advertises its distinct one-row safe-int8 contract',()=>{
  const q=compilePostgres(count(compare('enabled','=',[1])));
  assert.equal(q.command,'SELECT');assert.equal(q.count,true);assert.deepEqual(q.parameters,['true']);
  assert.deepEqual(q.outputs,[{alias:'__rs_pg_count',property:'n',kind:'bigint',nullable:false}]);
  assert.match(q.sql,/SELECT "pg_catalog"\."count"\(\*\) AS "__rs_pg_count"/);
});
test('ONLY is explicit for root reads, writes and correlated domains',()=>{
  const where={kind:'relation-filter',quantifier:'some',table:child,localKey:'id',foreignKey:'parentId'};
  const q=compilePostgres(count(where),{only:true});
  assert.match(q.sql,/FROM ONLY "public"\."sample_rows"/);assert.match(q.sql,/FROM ONLY "public"\."sample_children"/);
  assert.match(compilePostgres(queryModel.update({table,assignments:[{column:'label',value:'x'}],where:compare('id','=',[1])}),{only:true}).sql,/^UPDATE ONLY/);
  assert.match(compilePostgres(queryModel.delete({table,where:compare('id','=',[1])}),{only:true}).sql,/^DELETE FROM ONLY/);
  assert.ok(!compilePostgres(count()).sql.includes('ONLY'));
});
test('every ordinary comparison uses a pg_catalog operator and typed parameter',()=>{
  for(const op of ['=','<>','>','>=','<','<=']){
    const q=compilePostgres(count(compare('id',op,[5])));
    assert.ok(q.sql.includes('OPERATOR("pg_catalog".'+op+') $1::"pg_catalog"."int8"'));
    assert.deepEqual(q.parameters,['5']);
  }
});
test('NULL equality and inequality never bind null, including non-null mappings',()=>{
  for(const [op,sql] of [['=',' IS NULL'],['<>',' IS NOT NULL']]){
    const q=compilePostgres(count(compare('id',op,[null])));
    assert.ok(q.sql.endsWith('"id"'+sql));assert.deepEqual(q.parameters,[]);
  }
});
test('IN lowers to qualified ANY plus optional IS NULL, preserving NOT and empty-set truth',()=>{
  const q=compilePostgres(count({kind:'not',child:compare('label','IN',['a',null,'b'])}));
  assert.match(q.sql,/NOT \(\("__rs_pg_root"\."label" OPERATOR\("pg_catalog"\.=\) ANY \(ARRAY\[\$1::"pg_catalog"\."text", \$2::"pg_catalog"\."text"\]\) OR "__rs_pg_root"\."label" IS NULL\)\)/);
  assert.deepEqual(q.parameters,['a','b']);
  const empty=compilePostgres(count(compare('id','IN',[])));
  assert.ok(empty.sql.endsWith('WHERE FALSE'));assert.deepEqual(empty.parameters,[]);
  const allNull=compilePostgres(count(compare('label','IN',[null,null])));
  assert.ok(allNull.sql.endsWith('WHERE ("__rs_pg_root"."label" IS NULL)'));assert.deepEqual(allNull.parameters,[]);
});
test('empty logic and nested NOT compile as booleans, never SQLite integer truth values',()=>{
  const q=compilePostgres(count({kind:'logic',operator:'OR',children:[{kind:'logic',operator:'AND',children:[]},{kind:'not',child:{kind:'logic',operator:'OR',children:[]}}]}));
  assert.ok(q.sql.endsWith('WHERE (TRUE OR NOT (FALSE))'));assert.deepEqual(q.parameters,[]);
});
test('integer/bigint column comparisons stay simple and mixed real comparisons use an exact guarded renderer',()=>{
  assert.match(compilePostgres(count({kind:'column-compare',left:'id',right:'wide',operator:'<='})).sql,/"id" OPERATOR\("pg_catalog"\.<=\) "__rs_pg_root"\."wide"/);
  for(const [left,right]of[['wide','ratio'],['ratio','id'],['id','ratio'],['ratio','wide']])for(const operator of ['=','<>','<','<=','>','>=']){
    const q=compilePostgres(count({kind:'column-compare',left,right,operator}));
    assert.match(q.sql,/CASE WHEN/);assert.match(q.sql,/"pg_catalog"\."trunc"/);assert.deepEqual(q.parameters,[]);
    assert.ok(!q.sql.includes('("__rs_pg_root"."id")::"pg_catalog"."float8"'));
    assert.ok(!q.sql.includes('("__rs_pg_root"."wide")::"pg_catalog"."float8"'));
    assert.ok(!q.sql.includes('::"pg_catalog"."numeric"'));assert.equal(q.count,true);
  }
});
test('mixed comparisons compose with logical filters without introducing hidden parameter slots',()=>{
  const mixed={kind:'column-compare',left:'wide',right:'ratio',operator:'>'};
  const where={kind:'logic',operator:'AND',children:[compare('label','=',["sample'" ]),{kind:'not',child:mixed}]};
  const q=compilePostgres(select({where,limit:4,offset:7}));
  assert.deepEqual(q.parameters,["sample'",'4','7']);assert.match(q.sql,/LIMIT \$2::"pg_catalog"\."int8" OFFSET \$3::"pg_catalog"\."int8"$/);
  assert.match(q.sql,/NOT \(\(CASE WHEN/);assert.ok(!q.sql.includes("sample'"));
});
test('mixed comparisons preserve the model binding and node budgets at the boundaries',()=>{
  const mixed={kind:'column-compare',left:'wide',right:'ratio',operator:'<='};
  const where={kind:'logic',operator:'AND',children:[mixed,compare('id','IN',Array.from({length:10_000},(_,i)=>i))]};
  const q=compilePostgres(select({where}));assert.equal(q.parameters.length,10_002);
  assert.equal(q.parameters[0],'0');assert.equal(q.parameters[9_999],'9999');assert.deepEqual(q.parameters.slice(-2),['10','0']);
  assert.match(q.sql,/LIMIT \$10001::"pg_catalog"\."int8" OFFSET \$10002::"pg_catalog"\."int8"$/);
  const nodes={kind:'logic',operator:'AND',children:Array.from({length:99},()=>mixed)};
  assert.deepEqual(compilePostgres(count(nodes)).parameters,[]);
  assert.throws(()=>compilePostgres(count({...nodes,children:[...nodes.children,mixed]})),code('QUERY'));
});
test('encoded constant helper exposes the same typed validation without rendering SQL',()=>{
  assert.equal(bindPostgresEncoded('boolean',1,false),'true');assert.equal(bindPostgresEncoded('real',-0,false),'-0');
  assert.equal(bindPostgresEncoded('json','{"a":1}',false),'{"a":1}');assert.equal(bindPostgresEncoded('json',null,true),null);
  assert.throws(()=>bindPostgresEncoded('boolean',2,false),code('VALIDATION'));
});
test('JSON filters use native structural jsonb operators, not text or pre-normalized writes',()=>{
  for(const op of ['=','<>','>','>=','<','<=']){
    const q=compilePostgres(count(compare('doc',op,['{"b":1,"a":2}'])));
    assert.ok(q.sql.includes('"doc"::"pg_catalog"."jsonb" OPERATOR("pg_catalog".'+op+') $1::"pg_catalog"."jsonb"'));
    assert.deepEqual(q.parameters,['{"b":1,"a":2}']);
  }
  const ordered=compilePostgres(select({orderBy:[{column:'doc',direction:'ASC'}]}));
  assert.match(ordered.sql,/"doc"::"pg_catalog"\."jsonb" ASC NULLS FIRST/);
});
test('text contains and starts-with bind literal wildcard-looking text',()=>{
  for(const [mode,ending]of[['contains','OPERATOR("pg_catalog".>) 0'],['starts-with','OPERATOR("pg_catalog".=) 1']]){
    const q=compilePostgres(count({kind:'text-match',column:'label',mode,case:'sensitive',literal:'%_\\'}));
    assert.deepEqual(q.parameters,['%_\\']);assert.ok(q.sql.endsWith(ending));
    assert.match(q.sql,/"pg_catalog"\."strpos"/);assert.match(q.sql,/COLLATE "pg_catalog"\."C"/);
    assert.ok(!q.sql.includes('LIKE'));assert.ok(!q.sql.includes('%_'));
  }
});
test('ASCII-insensitive suffix uses translate and repeats one immutable bound literal',()=>{
  const q=compilePostgres(count({kind:'text-match',column:'label',mode:'ends-with',case:'ascii-insensitive',literal:'ÉAa😀'}));
  assert.deepEqual(q.parameters,['ÉAa😀']);assert.match(q.sql,/"pg_catalog"\."right"/);
  assert.match(q.sql,/"pg_catalog"\."char_length"/);assert.match(q.sql,/"pg_catalog"\."translate"/);
  assert.ok(!q.sql.includes('lower('));assert.equal((q.sql.match(/\$1/g)||[]).length,2);
});
test('some, none and every preserve domain parameters, null tests and fixed scope aliases',()=>{
  for(const quantifier of ['some','none','every']){
    const q=compilePostgres(count({kind:'relation-filter',quantifier,table:child,localKey:'id',foreignKey:'parentId',
      where:compare('id','>',[2]),predicate:compare('active','=',[1])}));
    assert.deepEqual(q.parameters,['2','true']);assert.match(q.sql,/"__rs_pg_filter_0"\."parentId" OPERATOR\("pg_catalog"\.=\) "__rs_pg_root"\."id"/);
    assert.equal(q.sql.includes('NOT EXISTS'),quantifier!=='some');assert.equal(q.sql.includes('IS NOT TRUE'),quantifier==='every');
  }
});
test('related counts bind the threshold after the related domain and tested predicate',()=>{
  const q=compilePostgres(count({kind:'relation-count',table:child,localKey:'id',foreignKey:'parentId',operator:'>=',threshold:2,
    where:compare('id','>',[4]),predicate:compare('active','=',[0])}));
  assert.deepEqual(q.parameters,['4','false','2']);assert.match(q.sql,/\) OPERATOR\("pg_catalog"\.>=\) \$3::"pg_catalog"\."int8"$/);
});
test('nested related predicates receive distinct reserved aliases and the same chosen schema',()=>{
  const nested={kind:'relation-filter',quantifier:'some',table:child,localKey:'id',foreignKey:'parentId',
    predicate:{kind:'relation-filter',quantifier:'none',table:child,localKey:'id',foreignKey:'parentId',predicate:compare('active','=',[1])}};
  const q=compilePostgres(count(nested),{schema:'sandbox'});
  assert.match(q.sql,/AS "__rs_pg_filter_0"/);assert.match(q.sql,/AS "__rs_pg_filter_1"/);
  assert.equal((q.sql.match(/"sandbox"\."sample_children"/g)||[]).length,2);assert.deepEqual(q.parameters,['true']);
});
test('transaction control reuses the PG session compiler with no result columns',()=>{
  const expected={begin:'BEGIN READ ONLY','begin-immediate':'BEGIN ISOLATION LEVEL SERIALIZABLE',commit:'COMMIT',rollback:'ROLLBACK',
    savepoint:'SAVEPOINT "sample_savepoint"',release:'RELEASE SAVEPOINT "sample_savepoint"','rollback-to':'ROLLBACK TO SAVEPOINT "sample_savepoint"'};
  for(const [action,sql]of Object.entries(expected)){
    const q=compilePostgres(queryModel.transaction({action,...(['savepoint','release','rollback-to'].includes(action)?{name:'sample_savepoint'}:{})}));
    assert.equal(q.sql,sql);assert.deepEqual(q.parameters,[]);assert.deepEqual(q.outputs,[]);assert.equal(q.command,null);
  }
});
test('call-time capture freezes parameters and output metadata against later mutation',()=>{
  const input={kind:'select',table:{...table,kinds:{...table.kinds},nullable:{...table.nullable}},columns:['label'],
    where:compare('label','=',["PRIVATE_TEST_VALUE'; DROP TABLE sample_rows; --"]),orderBy:[],limit:10,offset:0};
  const q=compilePostgres(input);input.columns[0]='doc';input.where.values[0]='changed';input.table.kinds.label='json';
  assert.equal(q.outputs[0].property,'label');assert.equal(q.outputs[0].kind,'text');assert.ok(q.parameters[0].startsWith('PRIVATE_TEST_VALUE'));
  assert.ok(!q.sql.includes('PRIVATE_TEST_VALUE'));assert.throws(()=>q.parameters.push('x'),TypeError);assert.throws(()=>{q.outputs[0].alias='bad';},TypeError);
});
test('wrong encoded values are refused rather than coerced into another logical value',()=>{
  const cases=[['enabled',2],['enabled',0n],['enabled','true'],['id',1n],['id',1.25],['id',Number.MAX_SAFE_INTEGER+1],
    ['wide',1],['ratio',1n],['label',4],['doc','{ "a": 1 }'],['doc','{"a":1,"a":2}'],['doc','null'],['doc','not JSON']];
  for(const[column,value]of cases)assert.throws(()=>compilePostgres(queryModel.insert({table,columns:[column],values:[value]})),code('VALIDATION','QUERY'),`${column} accepted wrong encoded kind`);
});
test('wire NUL and invalid Unicode are refused in text and search literals',()=>{
  for(const value of ['\0','\ud800','\udfff','x\ud800y']){
    assert.throws(()=>compilePostgres(queryModel.insert({table,columns:['label'],values:[value]})),code('VALIDATION'));
  }
  assert.throws(()=>compilePostgres(count({kind:'text-match',column:'label',mode:'contains',case:'sensitive',literal:'x\0y'})),code('VALIDATION'));
});
test('legal escaped JSON strings remain native-json writes while jsonb comparisons refuse invalid jsonb escapes',()=>{
  for(const value of ['\0','\ud800','\udfff','x\ud800y'])for(const doc of [{value},{[value]:'x'},[value]]){
    const encoded=JSON.stringify(doc),q=compilePostgres(queryModel.insert({table,columns:['doc'],values:[encoded]}));
    assert.deepEqual(q.parameters,[encoded]);assert.match(q.sql,/\$1::"pg_catalog"\."json"/);
    assert.throws(()=>compilePostgres(count(compare('doc','=',[encoded]))),code('VALIDATION'));
    assert.throws(()=>compilePostgres(count(compare('doc','IN',[encoded]))),code('VALIDATION'));
  }
});
test('missing kind/nullability metadata, injection identifiers and unsupported options are rejected',()=>{
  for(const missing of ['kinds','nullable']){const bare={...table};delete bare[missing];assert.throws(()=>compilePostgres(select({table:bare})),code('QUERY'));}
  assert.throws(()=>compilePostgres(select(),{schema:'public; DROP TABLE sample_rows'}),code('SCHEMA'));
  assert.throws(()=>compilePostgres(select(),{only:'yes'}),code('QUERY'));assert.throws(()=>compilePostgres(select(),{arbitrarySql:'PRIVATE_TEST_VALUE'}),code('QUERY'));
  assert.throws(()=>compilePostgres(select(),Object.defineProperty({},'arbitrarySql',{value:'PRIVATE_TEST_VALUE'})),code('QUERY'));
  let invoked=0;assert.throws(()=>compilePostgres(select(),{get schema(){invoked++;return 'bad';}}),code('QUERY'));assert.equal(invoked,0);
  const forged={...select(),get columns(){invoked++;return ['id'];}};assert.throws(()=>compilePostgres(forged),code('QUERY'));assert.equal(invoked,0);
});
test('unsupported query families and unsafe writes never masquerade as SQLite SQL',()=>{
  assert.throws(()=>compilePostgres(queryModel.explain({query:select()})),code('QUERY'));
  assert.throws(()=>compilePostgres(queryModel.createIndex({table,name:'sample_index',columns:['id']})),code('QUERY'));
  assert.throws(()=>compilePostgres(queryModel.relation({table,columns:['id'],partitionBy:'id',keys:[1],orderBy:[],offset:0,limit:1,readLimit:2})),code('QUERY'));
  assert.throws(()=>compilePostgres({kind:'update',table,assignments:[{column:'label',value:'x'}],where:{kind:'logic',operator:'AND',children:[]}}),code('UNSAFE_WRITE'));
  assert.throws(()=>compilePostgres({kind:'delete',table}),code('UNSAFE_WRITE'));
});

test('native summaries advertise their distinct aggregate contract while ordinary counts keep their own',()=>{
  const compiled=compilePostgres(queryModel.aggregate({table,select:[{alias:'total',operation:'count'}]}));
  assert.equal(compiled.command,'SELECT');assert.equal(compiled.aggregate.mode,'aggregate');
  assert.deepEqual(compiled.aggregate.fields,[{alias:'__rs_pg_0',kind:'count',target:'__rs_agg_0'},{alias:'__rs_pg_1',kind:'guard',target:'__rs_bad'}]);
  assert.equal(compiled.count,undefined);assert.equal(compiled.realAggregateRange,undefined);
  assert.deepEqual(compiled.outputs,[]);
  assert.ok(Object.isFrozen(compiled.aggregate));assert.ok(Object.isFrozen(compiled.aggregate.fields[0]));
  assert.equal(compilePostgres(count()).aggregate,undefined);
});
