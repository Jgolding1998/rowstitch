import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePostgres } from '../dist/core/postgres-compiler.js';
import { compilePostgresDDL } from '../dist/core/postgres-ddl.js';
import { queryModel, tableModel } from '../dist/core/query-model.js';

const q = value => '"' + value.replaceAll('"', '""') + '"';
const kinds = {id:'integer',parentId:'integer',label:'text',amount:'real',version:'integer'};
const columns = Object.keys(kinds);
const storage = {schema:'owner .Δ',table:'Order."Δ',columns:{id:'select',parentId:'id.part',label:'display "name"',amount:'__rs_family_0',version:'__proto__'}};
const mapped = (overrides = {}) => tableModel({name:'logical_rows',columns,primaryKey:['id'],kinds,
  nullable:{id:false,parentId:false,label:true,amount:false,version:false},version:'version',storage,...overrides});
const table = mapped();
const compare = (column, values = [1]) => ({kind:'compare',column,operator:'=',values});
const select = (table, extra = {}) => queryModel.select({table,columns:['id','label'],orderBy:[],limit:10,offset:0,...extra});
const physical = (column, scope = '"__rs_pg_root"') => scope + '.' + q(storage.columns[column]);
const qualified = q(storage.schema) + '.' + q(storage.table);
const schemaError = error => error?.code === 'SCHEMA' && !error.message.includes('PRIVATE_NAME');

test('native CRUD maps physical components once while keeping positional logical results', () => {
  const read = compilePostgres(select(table,{where:compare('id'),orderBy:[{column:'label',direction:'ASC'}]}),{schema:'factory.default'});
  assert.ok(read.sql.includes('FROM ' + qualified + ' AS "__rs_pg_root"'));
  assert.ok(read.sql.startsWith('SELECT ' + physical('id') + ' AS "__rs_pg_0", ' + physical('label') + ' AS "__rs_pg_1"'));
  assert.ok(read.sql.includes('ORDER BY ' + physical('label') + ' ASC NULLS FIRST'));
  assert.deepEqual(read.parameters,['1','10','0']);
  assert.deepEqual(read.outputs.map(field => field.property),['id','label']);
  const counted = compilePostgres(queryModel.count({table,where:compare('id')}));
  assert.equal(counted.count,true); assert.deepEqual(counted.parameters,['1']);
  assert.ok(counted.sql.includes('FROM ' + qualified));
  const inserted = compilePostgres(queryModel.insert({table,columns:['id','label'],values:[1,'fictional']}));
  assert.ok(inserted.sql.includes('(' + q('select') + ', ' + q('display "name"') + ') OVERRIDING SYSTEM VALUE VALUES'));
  const updated = compilePostgres(queryModel.update({table,assignments:[{column:'label',value:'changed'}],where:compare('id')}));
  assert.ok(updated.sql.includes('SET ' + q('display "name"') + ' = $1::"pg_catalog"."text", ' + q('__proto__') + ' = ' + physical('version') + ' OPERATOR("pg_catalog".+) 1'));
  const deleted = compilePostgres(queryModel.delete({table,where:compare('id')}));
  for (const result of [inserted,updated,deleted]) {
    assert.ok(result.sql.includes('RETURNING ' + physical('id') + ' AS "__rs_pg_0"'));
    assert.deepEqual(result.outputs.map(field => field.property),columns);
    assert.ok(!result.sql.includes('RETURNING *'));
  }
});

test('nested predicates resolve each table namespace independently and map both correlation sides', () => {
  const child = mapped({name:'logical_child',storage:{table:'child.table',columns:{...storage.columns,id:'child key',parentId:'parent "key"'}}});
  const where = {kind:'relation-filter',quantifier:'some',table:child,localKey:'id',foreignKey:'parentId',
    predicate:{kind:'logic',operator:'AND',children:[{kind:'text-match',column:'label',mode:'contains',case:'sensitive',literal:'a%'},
      {kind:'column-compare',left:'id',right:'parentId',operator:'>'}]}};
  const result = compilePostgres(select(table,{where}),{schema:'factory.default'});
  assert.ok(result.sql.includes('FROM "factory.default"."child.table" AS "__rs_pg_filter_0"'));
  assert.ok(result.sql.includes('"__rs_pg_filter_0"."parent ""key""" OPERATOR("pg_catalog".=) ' + physical('id')));
  assert.ok(result.sql.includes('"__rs_pg_filter_0"."child key" OPERATOR("pg_catalog".>) "__rs_pg_filter_0"."parent ""key"""'));
  assert.deepEqual(result.parameters,['a%','10','0']);
  assert.ok(!result.sql.includes('FROM "owner .Δ"."child.table"'));
});

test('eager relation windows map base fields and declare private positional window columns', () => {
  const result = compilePostgres(queryModel.relation({table,columns:['id','parentId','label'],partitionBy:'parentId',keys:[1,2],
    orderBy:[{column:'label',direction:'DESC'}],offset:0,limit:2,readLimit:20}));
  assert.ok(result.sql.includes('PARTITION BY ' + physical('parentId') + ' ORDER BY ' + physical('label') + ' DESC NULLS LAST'));
  assert.ok(result.sql.includes('AS "__rs_pg_window"("__rs_pg_0", "__rs_pg_1", "__rs_pg_2", "__rs_pg_3")'));
  assert.deepEqual(result.relation.outputs.map(field => field.property),['id','parentId','label']);
  assert.deepEqual(result.parameters,['1','2','0','2','20']);
});

test('aggregate and projected paths keep base identities separate from every private CTE slot', () => {
  const child = mapped({name:'logical_child',storage:{schema:'children.Δ',table:'__rs_pa_root_0',columns:{...storage.columns,parentId:'__rs_input_bad',amount:'__rs_col_0'}}});
  const path = [{table:child,localKey:'id',foreignKey:'parentId'}];
  const plans = [
    queryModel.aggregate({table,select:[{alias:'total',operation:'sum',column:'amount'},{alias:'mean',operation:'avg',column:'amount',path}]}),
    queryModel.group({table,by:['label'],select:[{alias:'total',operation:'sum',column:'amount'},{alias:'children',operation:'count',path}],
      orderBy:[{field:'label',direction:'ASC'}],limit:10,offset:0,overflow:false}),
    select(table,{orderBy:[{column:'amount',direction:'ASC'}],aggregates:[{alias:'mean',operation:'avg',column:'amount',path}]}),
  ];
  for (const plan of plans) {
    const result = compilePostgres(plan);
    assert.ok(result.sql.includes('FROM ' + qualified + ' AS "r"'));
    assert.ok(result.sql.includes('FROM "children.Δ"."__rs_pa_root_0" AS "c"'));
    const boundaries = [...result.sql.matchAll(/"__rs_pa_[a-z_]+_\d+"\(([^)]+)\) AS MATERIALIZED/g)];
    assert.ok(boundaries.length >= 7);
    assert.equal(boundaries.length,(result.sql.match(/ AS MATERIALIZED/g) ?? []).length);
    for (const [,list] of boundaries) {
      const slots = list.split(', ');
      assert.equal(new Set(slots).size,slots.length);
      assert.ok(slots.every(slot => /^"(?:__rs_(?:(?:raw|col|family|link_key|group)_\d+|value_\d+(?:_(?:sum|count))?|dummy|input_bad|root_ord|seed)|bad)"$/.test(slot)));
      assert.ok(!list.includes(q('display "name"')));
    }
    assert.ok(result.sql.includes('"c"."__rs_input_bad" AS "__rs_raw_0"'));
    assert.ok(result.sql.includes('"c"."__rs_col_0" AS "__rs_raw_1"') || plan.kind === 'group');
    assert.ok(!/SELECT\s+(?:"[^"]+"\.)?\*/.test(result.sql));
    assert.ok(!result.sql.includes('"undefined"'));
  }
});

test('DDL maps owner columns and resolves canonical foreign targets independently of owner schema', () => {
  const definitions = columns.map(name => ({name,kind:kinds[name],nullable:table.nullable[name],primary:name==='id',generated:false,unique:false,hasDefault:false,
    ...(name==='parentId'?{foreignKey:{target:{table:'parent."table',column:'parent id'},onDelete:'restrict'}}:{})}));
  const creation = queryModel.createTable({table,definitions});
  const sql = compilePostgresDDL(creation,'factory.default');
  assert.ok(sql.startsWith('CREATE TABLE ' + qualified));
  assert.ok(sql.includes('REFERENCES "factory.default"."parent.""table" ("parent id") ON DELETE RESTRICT'));
  assert.ok(sql.includes('PRIMARY KEY ("select")'));
  const explicit = structuredClone(creation);
  explicit.definitions[1].foreignKey.target.schema = 'target.Δ';
  assert.ok(compilePostgresDDL(explicit,'factory.default').includes('REFERENCES "target.Δ"."parent.""table"'));
  assert.equal(compilePostgresDDL(queryModel.createIndex({table,name:'mapped_idx',columns:['parentId','label']}),'factory.default'),
    'CREATE INDEX "mapped_idx" ON ' + qualified + ' ("id.part", "display ""name""")');
});

test('PostgreSQL validates UTF8 bytes for every mapped component before returning SQL', () => {
  const accepted = 'X' + 'é'.repeat(31), rejected = accepted + 'é';
  assert.equal(Buffer.byteLength(accepted),63); assert.equal(accepted.length,32);
  assert.ok(compilePostgres(select(mapped({storage:{...storage,table:accepted}}))).sql.includes(q(accepted)));
  assert.throws(() => compilePostgres(select(table),{schema:rejected}),schemaError);
  for (const invalidStorage of [{...storage,table:rejected},{...storage,schema:rejected},
    {...storage,columns:{...storage.columns,amount:rejected}}]) {
    assert.throws(() => compilePostgres(select(mapped({storage:invalidStorage}))),schemaError);
  }
  const child = mapped({name:'logical_child',storage:{...storage,table:'child',columns:{...storage.columns,amount:rejected}}});
  const where = {kind:'relation-filter',quantifier:'some',table:child,localKey:'id',foreignKey:'parentId'};
  assert.throws(() => compilePostgres(select(table,{where})),schemaError);
  const path = [{table:child,localKey:'id',foreignKey:'parentId'}];
  assert.throws(() => compilePostgres(queryModel.aggregate({table,select:[{alias:'children',operation:'count',path}]})),schemaError);
  for (const target of [{table:rejected,column:'id'},{schema:rejected,table:'parent',column:'id'},{table:'parent',column:rejected}]) {
    const definitions = columns.map(name => ({name,kind:kinds[name],nullable:table.nullable[name],primary:name==='id',generated:false,unique:false,hasDefault:false,
      ...(name==='parentId'?{foreignKey:{target,onDelete:'restrict'}}:{})}));
    assert.throws(() => compilePostgresDDL(queryModel.createTable({table,definitions})),schemaError);
  }
});

test('native namespaces reject system targets after physical resolution', () => {
  for (const schema of ['pg_catalog','pg_private','information_schema']) {
    assert.throws(() => compilePostgres(select(table),{schema}),schemaError);
    assert.throws(() => compilePostgres(select(mapped({storage:{...storage,schema}}))),schemaError);
    const definitions = columns.map(name => ({name,kind:kinds[name],nullable:table.nullable[name],primary:name==='id',generated:false,unique:false,hasDefault:false,
      ...(name==='parentId'?{foreignKey:{target:{schema,table:'parent',column:'id'},onDelete:'restrict'}}:{})}));
    assert.throws(() => compilePostgresDDL(queryModel.createTable({table,definitions})),schemaError);
  }
});
