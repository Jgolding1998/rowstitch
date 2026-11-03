import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agg, column, defineTable, openDatabase, hasMany, hasOne, belongsTo, eq, and, some, inArray, asc, RowstitchError } from '../dist/index.js';

const code = value => error => error instanceof RowstitchError && error.code === value;
const invalid = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA', 'VALIDATION'].includes(error.code);
function models() {
  const parent = defineTable('pa_parents', { id: column.integer().primaryKey(), label: column.text() });
  const child = defineTable('pa_children', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), amount: column.bigint().nullable(), real: column.real().nullable(), approved: column.boolean() });
  return { parent, child, relation: hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parentId') }) };
}
function memory(t, tables) {
  const db = openDatabase(':memory:', { tables }); db.ensureSchema(); t.after(() => db.close()); return db;
}
function disk(t, ddl) {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-related-aggregate-'));
  const path = join(folder, 'fictional.sqlite');
  const raw = new DatabaseSync(path); raw.exec(ddl); raw.close();
  const fixture = { path, database: undefined };
  t.after(() => { fixture.database?.close(); unlinkSync(path); rmdirSync(folder); });
  return fixture;
}

test('related aggregate results agree with an independent per-parent BigInt oracle', t => {
  const { parent, child, relation } = models(); const db = memory(t, [parent, child]);
  const parents = Array.from({ length: 47 }, (_, i) => ({ id: i + 1, label: 'Group ' + i }));
  const children = [];
  const max = 2n ** 63n - 1n;
  for (const p of parents) for (let i = 0; i < p.id % 9; i++) {
    children.push({ id: children.length + 1, parentId: p.id, amount: i % 4 === 0 ? null : (i % 3 === 0 ? -max : max), real: i % 3 === 0 ? null : i + .25, approved: i % 2 === 0 });
  }
  children.push({ id: children.length + 1, parentId: null, amount: max, real: 99, approved: true });
  db.table(parent).insertMany(parents); db.table(child).insertMany(children); db.clearTrace();
  const got = db.table(parent).findMany({ select: ['id'], aggregates: {
    n: agg.related(relation, agg.count()), present: agg.related(relation, agg.count(child.col('amount'))),
    total: agg.related(relation, agg.sum(child.col('amount'))), low: agg.related(relation, agg.min(child.col('amount'))),
    high: agg.related(relation, agg.max(child.col('amount'))), average: agg.related(relation, agg.avg(child.col('real'))),
  } });
  const expected = parents.map(p => {
    const rows = children.filter(c => c.parentId === p.id), amounts = rows.flatMap(c => c.amount === null ? [] : [c.amount]), reals = rows.flatMap(c => c.real === null ? [] : [c.real]);
    return { id: p.id, n: rows.length, present: amounts.length, total: amounts.length ? amounts.reduce((a,b) => a+b, 0n) : null,
      low: amounts.length ? amounts.reduce((a,b) => a<b?a:b) : null, high: amounts.length ? amounts.reduce((a,b) => a>b?a:b) : null,
      average: reals.length ? reals.reduce((a,b) => a+b, 0)/reals.length : null };
  });
  assert.deepEqual(got, expected);
  assert.ok(got.some(row => row.total > max));
  assert.equal(db.exportTrace().queries.length, 1, 'projected values must not use one query per parent');
});

test('two independent child collections do not multiply either total', t => {
  const { parent, child, relation } = models();
  const payments = defineTable('pa_payments', { id: column.integer().primaryKey(), parentId: column.integer(), cents: column.integer() });
  const paid = hasMany(payments, { localKey: parent.col('id'), foreignKey: payments.col('parentId') });
  const db = memory(t, [parent, child, payments]);
  db.table(parent).insertMany([{ id:1,label:'Two sources' },{ id:2,label:'Empty' }]);
  db.table(child).insertMany([{ id:1,parentId:1,amount:5n,real:1,approved:true },{ id:2,parentId:1,amount:7n,real:1,approved:true }]);
  db.table(payments).insertMany([{ id:1,parentId:1,cents:3 },{ id:2,parentId:1,cents:4 },{ id:3,parentId:1,cents:8 }]);
  assert.deepEqual(db.table(parent).findMany({ select:['id'], aggregates: {
    lines:agg.related(relation,agg.count()), total:agg.related(relation,agg.sum(child.col('amount'))), paid:agg.related(paid,agg.sum(payments.col('cents'))),
  } }), [{ id:1,lines:2,total:12n,paid:15n },{ id:2,lines:0,total:null,paid:null }]);
});

test('nested paths average leaf rows rather than averaging the intermediate averages', t => {
  const node = defineTable('pa_nodes', { id:column.integer().primaryKey(), parentId:column.integer().nullable(), value:column.real().nullable(), active:column.boolean() });
  const db = memory(t, [node]);
  db.table(node).insertMany([{id:1,parentId:null,value:null,active:true},{id:2,parentId:1,value:null,active:true},{id:3,parentId:1,value:null,active:true},
    {id:4,parentId:2,value:2,active:true},{id:5,parentId:2,value:4,active:false},{id:6,parentId:3,value:100,active:true}]);
  const children = hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId')});
  const active = hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId'),where:eq(node.col('active'),true)});
  const row = db.table(node).findFirst({select:['id'],where:eq(node.col('id'),1),aggregates:{
    n:agg.related(children,agg.related(children,agg.count())), average:agg.related(children,agg.related(children,agg.avg(node.col('value')))),
    activeCount:agg.related(children,agg.related(active,agg.count())),
  }});
  assert.deepEqual(row,{id:1,n:3,average:106/3,activeCount:2});
});

test('projection, includes and hidden keys coexist without leaking hidden fields', t => {
  const { parent, child, relation } = models(); const db = memory(t,[parent,child]);
  db.table(parent).insert({id:41,label:'Visible label'}); db.table(child).insert({id:1,parentId:41,amount:3n,real:2,approved:true});
  const include = { children: hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),select:['amount']}) };
  assert.deepEqual(db.table(parent).findFirst({select:['label'],include,aggregates:{n:agg.related(relation,agg.count())}}),
    {label:'Visible label',children:[{amount:3n}],n:1});
  for(const alias of ['label','LABEL','children','Children','__proto__','constructor','__rs_count']) {
    const aggregates = Object.fromEntries([[alias,agg.related(relation,agg.count())]]);
    assert.throws(()=>db.table(parent).findMany({select:['label'],include,aggregates}),invalid,alias);
  }
  // An unselected column may be an aggregate alias; the hidden join key must survive until includes are assembled.
  assert.deepEqual(db.table(parent).findFirst({select:['label'],include,aggregates:{id:agg.related(relation,agg.count())}}),
    {label:'Visible label',children:[{amount:3n}],id:1});
});

test('projected counts use the entire relation even beyond eager child limits', t => {
  const {parent,child,relation}=models(); const db=memory(t,[parent,child]);
  db.table(parent).insert({id:1,label:'Large collection'});
  const values=Array.from({length:1205},(_,i)=>({id:i+1,parentId:1,amount:1n,real:1,approved:true}));
  db.table(child).insertMany(values.slice(0,1000)); db.table(child).insertMany(values.slice(1000));
  for(const make of [hasMany,hasOne,belongsTo]) {
    const rel=make(child,{localKey:parent.col('id'),foreignKey:child.col('parentId')});
    assert.equal(db.table(parent).findFirst({aggregates:{n:agg.related(rel,agg.count())}}).n,1205);
  }
  assert.equal(db.table(parent).findFirst({aggregates:{total:agg.related(relation,agg.sum(child.col('amount')))}}).total,1205n);
});

test('foreign-key matching and text extrema retain native column collations', t => {
  const parent=defineTable('pa_text_parents',{id:column.text().primaryKey()});
  const child=defineTable('pa_text_children',{id:column.integer().primaryKey(),parentId:column.text(),label:column.text()});
  const fixture=disk(t,"CREATE TABLE pa_text_parents(id TEXT COLLATE BINARY NOT NULL PRIMARY KEY); CREATE TABLE pa_text_children(id INTEGER NOT NULL PRIMARY KEY,parentId TEXT COLLATE NOCASE NOT NULL,label TEXT COLLATE NOCASE NOT NULL); INSERT INTO pa_text_parents VALUES('a'),('Z'); INSERT INTO pa_text_children VALUES(1,'A','a'),(2,'a','B');");
  const db=fixture.database=openDatabase(fixture.path,{tables:[parent,child],readOnly:true});
  const relation=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId')});
  assert.deepEqual(db.table(parent).findMany({where:eq(parent.col('id'),'a'),aggregates:{
    n:agg.related(relation,agg.count()),low:agg.related(relation,agg.min(child.col('label'))),high:agg.related(relation,agg.max(child.col('label'))),
  }}),[{id:'a',n:2,low:'a',high:'B'}]);
});

test('invalid referenced child data fails only when its parent is returned', t => {
  const {parent,child,relation}=models();
  const fixture=disk(t,"CREATE TABLE pa_parents(id INTEGER NOT NULL PRIMARY KEY,label TEXT NOT NULL); CREATE TABLE pa_children(id INTEGER NOT NULL PRIMARY KEY,parentId INTEGER,amount INTEGER,real REAL,approved INTEGER NOT NULL); INSERT INTO pa_parents VALUES(1,'Clean'),(2,'Malformed child'); INSERT INTO pa_children VALUES(1,1,5,2,1),(2,2,'wrong',3,1);");
  const db=fixture.database=openDatabase(fixture.path,{tables:[parent,child],readOnly:true});
  const aggregates={total:agg.related(relation,agg.sum(child.col('amount')))};
  assert.deepEqual(db.table(parent).findMany({select:['id'],aggregates,orderBy:[asc(parent.col('id'))],limit:1}),[{id:1,total:5n}]);
  assert.throws(()=>db.table(parent).findMany({select:['id'],aggregates}),code('DATA'));
  assert.deepEqual(db.table(parent).findMany({select:['id'],aggregates:{n:agg.related(relation,agg.count())}}),[{id:1,n:1},{id:2,n:1}]);
  assert.deepEqual(db.table(parent).findMany({select:['id'],aggregates,limit:0}),[]);
});

test('all projected domains and root predicates share a finite query budget', t => {
  const {parent,child,relation}=models(); const db=memory(t,[parent,child]);
  const small=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),where:and(...Array.from({length:5},()=>eq(child.col('approved'),true)))});
  const tooManyNodes=Object.fromEntries(Array.from({length:20},(_,i)=>['n'+i,agg.related(small,agg.count())]));
  db.clearTrace(); assert.throws(()=>db.table(parent).compileSelect({aggregates:tooManyNodes}),code('QUERY'));
  const many=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),where:inArray(child.col('id'),Array.from({length:6000},(_,i)=>i))});
  assert.throws(()=>db.table(parent).compileSelect({aggregates:{a:agg.related(many,agg.count()),b:agg.related(many,agg.count())}}),code('QUERY'));
  const aliases=Object.fromEntries(Array.from({length:33},(_,i)=>['n'+i,agg.related(relation,agg.count())]));
  assert.throws(()=>db.table(parent).compileSelect({aggregates:aliases}),code('QUERY'));
  assert.equal(db.exportTrace().queries.length,0);
});

test('a hidden root correlation key must satisfy its mapped storage kind', t => {
  const parent=defineTable('pa_root_keys',{id:column.integer().primaryKey(),key:column.integer(),label:column.text()});
  const child=defineTable('pa_key_children',{id:column.integer().primaryKey(),parentKey:column.bigint()});
  const fixture=disk(t,"CREATE TABLE pa_root_keys(id INTEGER NOT NULL PRIMARY KEY,key INTEGER NOT NULL,label TEXT NOT NULL); CREATE TABLE pa_key_children(id INTEGER NOT NULL PRIMARY KEY,parentKey INTEGER NOT NULL); INSERT INTO pa_root_keys VALUES(1,9007199254740993,'Invalid safe integer'); INSERT INTO pa_key_children VALUES(1,9007199254740993);");
  const db=fixture.database=openDatabase(fixture.path,{tables:[parent,child],readOnly:true});
  const relation=hasMany(child,{localKey:parent.col('key'),foreignKey:child.col('parentKey')});
  assert.throws(()=>db.table(parent).findMany({select:['label'],aggregates:{n:agg.related(relation,agg.count())}}),code('DATA'));
});

test('relation-depth accounting includes nested predicates inside a projected path', t => {
  const node=defineTable('pa_depth',{id:column.integer().primaryKey(),parentId:column.integer().nullable()});
  const db=memory(t,[node]), relation=hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId')});
  const domain=hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId'),where:some(relation)});
  let allowed=agg.count();for(let i=0;i<4;i++)allowed=agg.related(relation,allowed);
  assert.doesNotThrow(()=>db.table(node).compileSelect({aggregates:{n:allowed}}));
  assert.throws(()=>db.table(node).compileSelect({aggregates:{n:agg.related(relation,allowed)}}),code('QUERY'));
  let over=agg.related(domain,agg.count());for(let i=0;i<3;i++)over=agg.related(relation,over);
  assert.throws(()=>db.table(node).compileSelect({aggregates:{n:over}}),code('QUERY'));
});

test('related selectors are genuine, correctly registered and rejected outside their supported scope', t => {
  const {parent,child,relation}=models();const db=memory(t,[parent,child]);
  const selector=agg.related(relation,agg.count());
  const clone=Object.assign({},selector);
  for(const value of [clone,agg.count(),{},null])assert.throws(()=>db.table(parent).findMany({aggregates:{n:value}}),invalid);
  assert.throws(()=>db.table(parent).aggregate({select:{n:selector}}),invalid);
  assert.throws(()=>db.table(parent).groupBy({by:['label'],select:{n:selector}}),invalid);
  const hidden=defineTable('pa_hidden',{id:column.integer().primaryKey(),parentId:column.integer()});
  const unregistered=hasMany(hidden,{localKey:parent.col('id'),foreignKey:hidden.col('parentId')});
  assert.throws(()=>db.table(parent).compileSelect({aggregates:{n:agg.related(unregistered,agg.count())}}),code('SCHEMA'));
  assert.throws(()=>db.table(parent).compileSelect({aggregates:{n:agg.related(relation,agg.sum(parent.col('id')))}}),invalid);
  for(const options of [{limit:1},{offset:0},{select:['amount']},{orderBy:[asc(child.col('id'))]}]){
    const loading=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),...options});
    assert.throws(()=>db.table(parent).compileSelect({aggregates:{n:agg.related(loading,agg.count())}}),invalid);
  }
  assert.throws(()=>agg.related(relation,agg.count(),{}),invalid);
});

test('bound domain values remain redacted and compile/explain preserve read-only semantics', t => {
  const {parent,child}=models();const db=memory(t,[parent,child]);
  db.table(parent).insert({id:1,label:'Sample'});
  const literal=734901;
  const relation=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),where:eq(child.col('id'),literal)});
  const options={aggregates:{n:agg.related(relation,agg.count())}};db.clearTrace();
  const compiled=db.table(parent).compileSelect(options);
  assert.ok(!compiled.sql.includes(String(literal)));assert.ok(compiled.parameters.includes(literal));assert.equal(db.exportTrace().queries.length,0);
  assert.equal(db.table(parent).findFirst(options).n,0);assert.ok(!JSON.stringify(db.exportTrace()).includes(String(literal)));
  assert.ok(db.table(parent).explain(options).length>0);
  let escaped; db.transaction(tx=>{escaped=tx.table(parent);assert.equal(escaped.findFirst(options).n,0);});
  assert.throws(()=>escaped.findMany(options),code('TRANSACTION_CLOSED'));
});
