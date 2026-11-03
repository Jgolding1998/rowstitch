import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agg, column, defineTable, openDatabase, hasMany, eq, inArray, and, some, RowstitchError } from '../dist/index.js';
import { queryModel } from '../dist/core/query-model.js';
import { compileSqlite } from '../dist/core/sqlite-compiler.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
function tables() {
  const root = defineTable('ga_roots', { id: column.integer().primaryKey(), category: column.text().nullable(), active: column.boolean() });
  const child = defineTable('ga_children', { id: column.integer().primaryKey(), rootId: column.integer().nullable(), amount: column.bigint().nullable(), score: column.real().nullable(), approved: column.boolean() });
  const pay = defineTable('ga_payments', { id: column.integer().primaryKey(), rootId: column.integer(), amount: column.integer() });
  return { root, child, pay, relation: hasMany(child, { localKey: root.col('id'), foreignKey: child.col('rootId') }), payments: hasMany(pay, { localKey: root.col('id'), foreignKey: pay.col('rootId') }) };
}
function memory(t, models) {
  const db = openDatabase(':memory:', { tables: models }); db.ensureSchema(); t.after(() => db.close()); return db;
}
function disk(t, ddl, models) {
  const folder = mkdtempSync(join(tmpdir(), 'rowstitch-grouped-related-'));
  const path = join(folder, 'fictional.sqlite'); const raw = new DatabaseSync(path);
  try { raw.exec(ddl); } finally { raw.close(); }
  const db = openDatabase(path, { tables: models, readOnly: true });
  t.after(() => { db.close(); unlinkSync(path); rmdirSync(folder); }); return db;
}
const total = values => values.length ? values.reduce((a,b) => a + BigInt(b), 0n) : null;
const low = values => values.length ? values.reduce((a,b) => a < b ? a : b) : null;
const high = values => values.length ? values.reduce((a,b) => a > b ? a : b) : null;

test('mixed root and two related collections match an independent grouped BigInt oracle', t => {
  const { root, child, pay, relation, payments } = tables(), db = memory(t, [root, child, pay]);
  const parents = Array.from({ length: 47 }, (_, i) => ({ id: i+1, category: i%11 === 0 ? null : 'Region '+i%7, active: i%3 !== 0 }));
  const children = [], paid = [], max = 2n**63n-1n;
  for (const p of parents) {
    for (let i=0;i<p.id%8;i++) children.push({id:children.length+1, rootId:p.id, amount:i%4===0?null:i%3===0?-max:max, score:i%4===0?null:i+.25, approved:i%2===0});
    for (let i=0;i<p.id%5;i++) paid.push({id:paid.length+1,rootId:p.id,amount:i+2});
  }
  children.push({id:children.length+1,rootId:null,amount:max,score:99,approved:true}, {id:children.length+2,rootId:900,amount:max,score:100,approved:true});
  db.table(root).insertMany(parents); db.table(child).insertMany(children); db.table(pay).insertMany(paid);
  const select = { parents:agg.count(), n:agg.related(relation,agg.count()), present:agg.related(relation,agg.count(child.col('amount'))),
    total:agg.related(relation,agg.sum(child.col('amount'))), min:agg.related(relation,agg.min(child.col('amount'))), max:agg.related(relation,agg.max(child.col('amount'))),
    average:agg.related(relation,agg.avg(child.col('score'))), payments:agg.related(payments,agg.sum(pay.col('amount'))) };
  function expected(ps) {
    const ids = new Set(ps.map(p=>p.id)), cs = children.filter(c=>ids.has(c.rootId)), amounts = cs.flatMap(c=>c.amount===null?[]:[c.amount]), scores = cs.flatMap(c=>c.score===null?[]:[c.score]);
    return {parents:ps.length,n:cs.length,present:amounts.length,total:total(amounts),min:low(amounts),max:high(amounts),average:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null,payments:total(paid.filter(p=>ids.has(p.rootId)).map(p=>p.amount))};
  }
  const categories = [...new Set(parents.map(p=>p.category))].sort((a,b)=>a===b?0:a===null?-1:b===null?1:a<b?-1:1);
  for (const filtered of [false,true]) {
    const ps = filtered ? parents.filter(p=>p.active) : parents, options = {select,...(filtered?{where:eq(root.col('active'),true)}:{})};
    db.clearTrace(); assert.deepEqual(db.table(root).aggregate(options),expected(ps)); assert.equal(db.exportTrace().queries.length,1);
    assert.deepEqual(db.table(root).groupBy({by:['category'],...options}),categories.filter(c=>ps.some(p=>p.category===c)).map(category=>({category,...expected(ps.filter(p=>p.category===category))})));
  }
});

test('empty roots and empty or all-NULL related domains retain explicit identities', t => {
  const {root,child,relation}=tables(), db=memory(t,[root,child]);
  const select={roots:agg.count(),n:agg.related(relation,agg.count()),present:agg.related(relation,agg.count(child.col('amount'))),sum:agg.related(relation,agg.sum(child.col('amount'))),avg:agg.related(relation,agg.avg(child.col('score'))),min:agg.related(relation,agg.min(child.col('amount')))};
  const empty={roots:0,n:0,present:0,sum:null,avg:null,min:null};
  assert.deepEqual(db.table(root).aggregate({select}),empty); assert.deepEqual(db.table(root).groupBy({by:['category'],select}),[]);
  db.table(root).insertMany([{id:1,category:null,active:true},{id:2,category:'Empty',active:true}]);
  db.table(child).insert({id:1,rootId:1,amount:null,score:null,approved:true});
  assert.deepEqual(db.table(root).groupBy({by:['category'],select}),[{category:null,...empty,roots:1,n:1},{category:'Empty',...empty,roots:1}]);
  assert.deepEqual(db.table(root).aggregate({where:eq(root.col('id'),9),select}),empty);
});

test('nested self paths and domains use all matching leaves, not averages of parent averages', t => {
  const node=defineTable('ga_nodes',{id:column.integer().primaryKey(),parentId:column.integer().nullable(),region:column.text(),value:column.real().nullable(),active:column.boolean()});
  const db=memory(t,[node]); db.table(node).insertMany([{id:1,parentId:null,region:'R',value:null,active:true},{id:2,parentId:1,region:'R',value:null,active:true},{id:3,parentId:1,region:'R',value:null,active:true},{id:4,parentId:2,region:'R',value:2,active:true},{id:5,parentId:3,region:'R',value:3,active:true},{id:6,parentId:3,region:'R',value:4,active:false}]);
  const r=hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId')}), active=hasMany(node,{localKey:node.col('id'),foreignKey:node.col('parentId'),where:eq(node.col('active'),true)});
  const select={n:agg.related(r,agg.related(r,agg.count())),average:agg.related(r,agg.related(r,agg.avg(node.col('value')))),active:agg.related(r,agg.related(active,agg.avg(node.col('value'))))};
  const options={select,where:and(eq(node.col('id'),1),some(r))};
  assert.deepEqual(db.table(node).aggregate(options),{n:3,average:3,active:2.5});
  assert.deepEqual(db.table(node).groupBy({...options,by:['region']}),[{region:'R',n:3,average:3,active:2.5}]);
});

test('matching path multiplicity is retained, without multiplying unrelated root counts', t => {
  const root=defineTable('ga_path_roots',{id:column.integer().primaryKey(),region:column.text()}), link=defineTable('ga_links',{id:column.integer().primaryKey(),rootId:column.integer(),target:column.integer()}), leaf=defineTable('ga_leaves',{id:column.integer().primaryKey(),value:column.integer()});
  const db=memory(t,[root,link,leaf]); db.table(root).insert({id:1,region:'One'}); db.table(link).insertMany([{id:1,rootId:1,target:8},{id:2,rootId:1,target:8}]); db.table(leaf).insert({id:8,value:7});
  const links=hasMany(link,{localKey:root.col('id'),foreignKey:link.col('rootId')}), targets=hasMany(leaf,{localKey:link.col('target'),foreignKey:leaf.col('id')});
  assert.deepEqual(db.table(root).groupBy({by:['region'],select:{roots:agg.count(),n:agg.related(links,agg.related(targets,agg.count())),sum:agg.related(links,agg.related(targets,agg.sum(leaf.col('value'))))}}),[{region:'One',roots:1,n:2,sum:14n}]);
});

test('group key equivalence and leaf extrema preserve independent native collations', t => {
  const root=defineTable('ga_text_roots',{id:column.text().primaryKey(),region:column.text().nullable(),sub:column.text().nullable()}), child=defineTable('ga_text_children',{id:column.integer().primaryKey(),parent:column.text(),label:column.text()});
  const db=disk(t,"CREATE TABLE ga_text_roots(id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,region TEXT COLLATE NOCASE,sub TEXT COLLATE RTRIM); CREATE TABLE ga_text_children(id INTEGER PRIMARY KEY,parent TEXT COLLATE NOCASE NOT NULL,label TEXT COLLATE NOCASE NOT NULL); INSERT INTO ga_text_roots VALUES('p','a','x'),('q','A','x '),('n',NULL,NULL),('e','Empty','x'); INSERT INTO ga_text_children VALUES(1,'P','b'),(2,'Q','C'),(3,'N','Y'),(4,'N','x');",[root,child]);
  const relation=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('parent')});
  const rows=db.table(root).groupBy({by:['region','sub'],select:{roots:agg.count(),n:agg.related(relation,agg.count()),min:agg.related(relation,agg.min(child.col('label'))),max:agg.related(relation,agg.max(child.col('label')))}});
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>({...row,region:row.region?.toLowerCase()??null,sub:row.sub?.trimEnd()??null})),[{region:null,sub:null,roots:1,n:2,min:'x',max:'Y'},{region:'a',sub:'x',roots:2,n:2,min:'b',max:'C'},{region:'empty',sub:'x',roots:1,n:0,min:null,max:null}]);
});

test('related exact totals order across int64 boundaries with paging and negative carries', t => {
  const {root,child,relation}=tables(),db=memory(t,[root,child]),max=2n**63n-1n;
  const amounts=[[null],[-1n,-1n],[0n],[4294967295n,4294967295n],[max,max-1n],[max,max]];
  db.table(root).insertMany(amounts.map((_,i)=>({id:i+1,category:String(i),active:true})));
  let id=0; db.table(child).insertMany(amounts.flatMap((values,i)=>values.map(amount=>({id:++id,rootId:i+1,amount,score:null,approved:true}))));
  const options={by:['category'],select:{sum:agg.related(relation,agg.sum(child.col('amount')))},orderBy:[{field:'sum',direction:'asc'}]};
  assert.deepEqual(db.table(root).groupBy(options).map(r=>r.sum),[null,-2n,0n,8589934590n,max*2n-1n,max*2n]);
  assert.deepEqual(db.table(root).groupBy({...options,orderBy:[{field:'sum',direction:'desc'}],limit:3,offset:1}).map(r=>r.sum),[max*2n-1n,8589934590n,0n]);
});

test('a related storage guard covers malformed off-page values but respects root and domain filters', t => {
  const {root,child,relation}=tables(); const db=disk(t,"CREATE TABLE ga_roots(id INTEGER PRIMARY KEY,category TEXT,active INTEGER NOT NULL); CREATE TABLE ga_children(id INTEGER PRIMARY KEY,rootId INTEGER,amount INTEGER,score REAL,approved INTEGER NOT NULL); INSERT INTO ga_roots VALUES(1,'A',1),(2,'B',0); INSERT INTO ga_children VALUES(1,1,5,1,1),(2,2,'bad',2,0);",[root,child]);
  const select={total:agg.related(relation,agg.sum(child.col('amount')))};
  assert.throws(()=>db.table(root).groupBy({by:['category'],select,limit:1}),coded('DATA'));
  assert.deepEqual(db.table(root).groupBy({by:['category'],select,limit:1,where:eq(root.col('active'),true)}),[{category:'A',total:5n}]);
  const filtered=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('rootId'),where:eq(child.col('approved'),true)});
  assert.deepEqual(db.table(root).aggregate({select:{total:agg.related(filtered,agg.sum(child.col('amount')))}}),{total:5n});
  assert.deepEqual(db.table(root).aggregate({select:{n:agg.related(relation,agg.count())}}),{n:2});
  assert.deepEqual(db.table(root).groupBy({by:['category'],select,limit:0}),[]);
});

test('hidden root correlation keys are checked even when the group key itself is valid', t => {
  const root=defineTable('ga_badroot',{id:column.integer().primaryKey(),key:column.integer(),region:column.text()}), child=defineTable('ga_badchild',{id:column.integer().primaryKey(),key:column.bigint()});
  const db=disk(t,"CREATE TABLE ga_badroot(id INTEGER PRIMARY KEY,key INTEGER NOT NULL,region TEXT NOT NULL); CREATE TABLE ga_badchild(id INTEGER PRIMARY KEY,key INTEGER NOT NULL); INSERT INTO ga_badroot VALUES(1,9007199254740993,'R'); INSERT INTO ga_badchild VALUES(1,9007199254740993);",[root,child]);
  const r=hasMany(child,{localKey:root.col('key'),foreignKey:child.col('key')}),select={n:agg.related(r,agg.count())};
  assert.throws(()=>db.table(root).aggregate({select}),coded('DATA'));
  assert.throws(()=>db.table(root).groupBy({by:['region'],select}),coded('DATA'));
});

test('root predicate copies and domains share physical and logical budgets before execution', t => {
  const {root,child,relation}=tables(),db=memory(t,[root,child]);
  const select={a:agg.related(relation,agg.count()),b:agg.related(relation,agg.count())};
  const options=n=>({select,where:inArray(root.col('id'),Array.from({length:n},(_,i)=>i))});
  db.clearTrace(); assert.equal(db.table(root).compileAggregate(options(2000)).parameters.length,10000);
  assert.equal(db.table(root).compileGroupBy({...options(2000),by:['category']}).parameters.length,10002);
  assert.throws(()=>db.table(root).compileAggregate(options(2001)),coded('QUERY'));
  const domain=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('rootId'),where:and(...Array.from({length:5},()=>eq(child.col('approved'),true)))});
  assert.throws(()=>db.table(root).compileAggregate({select:Object.fromEntries(Array.from({length:20},(_,i)=>['a'+i,agg.related(domain,agg.count())]))}),coded('QUERY'));
  assert.equal(db.exportTrace().queries.length,0);
});

test('root filters and domains remain bound and redacted across repeated subqueries', t => {
  const {root,child}=tables(),db=memory(t,[root,child]),literal="' OR 1=1 -- fictional";
  db.table(root).insertMany([{id:1,category:literal,active:true},{id:2,category:'Other',active:true}]);
  db.table(child).insertMany([{id:1,rootId:1,amount:5n,score:1,approved:true},{id:2,rootId:2,amount:999n,score:1,approved:true}]);
  const relation=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('rootId'),where:eq(child.col('approved'),true)});
  const options={select:{sum:agg.related(relation,agg.sum(child.col('amount')))},where:eq(root.col('category'),literal)};
  db.clearTrace();const compiled=db.table(root).compileAggregate(options); assert.equal(compiled.sql.includes(literal),false);assert.ok(compiled.parameters.includes(literal));
  assert.deepEqual(db.table(root).aggregate(options),{sum:5n}); assert.equal(JSON.stringify(db.exportTrace()).includes(literal),false);
  assert.ok(db.table(root).explainAggregate(options).length); assert.ok(db.table(root).explainGroupBy({...options,by:['category']}).length);
});

test('different selector domains bind in SQL order even with split sums and trailing storage guards', t => {
  const {root,child}=tables(),db=memory(t,[root,child]);
  db.table(root).insertMany([{id:1,category:'Visible',active:true},{id:2,category:'Excluded',active:false}]);
  db.table(child).insertMany([{id:1,rootId:1,amount:3n,score:2,approved:true},{id:2,rootId:1,amount:-11n,score:9,approved:false},{id:3,rootId:2,amount:77n,score:77,approved:true}]);
  const paid=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('rootId'),where:eq(child.col('approved'),true)}),pending=hasMany(child,{localKey:root.col('id'),foreignKey:child.col('rootId'),where:eq(child.col('approved'),false)});
  const select={paid:agg.related(paid,agg.sum(child.col('amount'))),pending:agg.related(pending,agg.sum(child.col('amount'))),pendingLow:agg.related(pending,agg.min(child.col('score'))),paidCount:agg.related(paid,agg.count()),roots:agg.count()};
  const options={select,where:eq(root.col('active'),true)},expected={paid:3n,pending:-11n,pendingLow:9,paidCount:1,roots:1};
  assert.deepEqual(db.table(root).aggregate(options),expected);
  assert.deepEqual(db.table(root).groupBy({...options,by:['category']}),[{category:'Visible',...expected}]);
});

test('pure aggregate models independently validate relation paths, leaf kinds and copied parameters', () => {
  const table={name:'ga_model_root',columns:['id'],primaryKey:['id'],kinds:{id:'integer'},nullable:{id:false}};
  const related={name:'ga_model_child',columns:['rootId','value'],primaryKey:['rootId'],kinds:{rootId:'integer',value:'bigint'},nullable:{rootId:false,value:true}};
  const path=[{table:related,localKey:'id',foreignKey:'rootId'}], select=[{alias:'total',operation:'sum',column:'value',path}];
  const model=queryModel.aggregate({table,select}); assert.ok(compileSqlite(model).sql.includes('SUM'));
  for(const patch of [{path:[]},{path:[{...path[0],localKey:'missing'}]},{column:'rootOnly'},{path:[{...path[0],extra:'ignored'}]}]) assert.throws(()=>queryModel.aggregate({table,select:[{...select[0],...patch}]}),coded('QUERY'));
  let reads=0;const unsafe={...select[0]};Object.defineProperty(unsafe,'path',{get(){reads++;return path;}});
  assert.throws(()=>queryModel.aggregate({table,select:[unsafe]}),coded('QUERY')); assert.equal(reads,0);
  const where={kind:'compare',column:'id',operator:'IN',values:Array.from({length:3334},(_,i)=>i)};
  assert.throws(()=>queryModel.aggregate({table,select,where}),coded('QUERY'));
});
