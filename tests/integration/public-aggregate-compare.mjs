// Fixed native PostgreSQL aggregate comparisons. Application recipes and representation differences are explicit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const quote=value=>'"'+value.replaceAll('"','""')+'"';
const MAX=9223372036854775807n;
const exactTotal=2n*MAX+6n;
const parents=[{id:1,team:'A',region:'N',budget:10},{id:2,team:'A',region:'S',budget:20},{id:3,team:null,region:'N',budget:30},{id:4,team:'B',region:'N',budget:40}];
const items=[{id:11,parent_id:1,qty:2,wide:MAX,ratio:1.5,label:'b'},{id:12,parent_id:1,qty:-1,wide:MAX,ratio:2.5,label:'A'},
  {id:21,parent_id:2,qty:3,wide:-1n,ratio:4,label:'c'},{id:31,parent_id:3,qty:null,wide:null,ratio:null,label:null},
  {id:99,parent_id:null,qty:9,wide:7n,ratio:10,label:'orphan'}];
const refunds=[{id:1,parent_id:1,amount:3},{id:2,parent_id:1,amount:4},{id:3,parent_id:2,amount:5}];
const links=[{id:1,item_id:11,weight:1},{id:2,item_id:11,weight:2},{id:3,item_id:21,weight:3}];
const plain=value=>Array.isArray(value)?value.map(plain):value!==null&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item)])):value;
function representation(value){
  if(typeof value==='bigint')return {type:'bigint',decimal:value.toString()};
  if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))return {type:'number',value:Number.isNaN(value)?'NaN':Object.is(value,-0)?'-0':String(value)};
  if(Array.isArray(value))return value.map(representation);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,representation(item)]));
  return value;
}
function integer(value){
  if(typeof value==='bigint')return value;
  if(typeof value==='string'&&/^-?(?:0|[1-9][0-9]*)$/.test(value))return BigInt(value);
  assert.ok(typeof value==='number'&&Number.isSafeInteger(value),'Do not normalize an unsafe Number into an exact integer');
  return BigInt(value);
}
const numbers=(row,integerKeys=[])=>Object.fromEntries(Object.entries(plain(row)).map(([key,value])=>[key,value===null?null:integerKeys.includes(key)?integer(value):['mean','realMean'].includes(key)?Number(value):value]));
const sort=(rows,keys)=>[...rows].sort((a,b)=>{for(const key of keys){if(a[key]===b[key])continue;if(a[key]===null)return -1;if(b[key]===null)return 1;return a[key]<b[key]?-1:1;}return 0;});

/** Caller proves fixture ownership. Only supplied direct-field local target is used; all resources created here are random owned schemas/handles. */
export async function runPublicAggregateComparisonCases({sdk,openPostgresDatabase,postgresOptions,admin,orange,kysely,pg,versions}){
  assert.deepEqual(versions,{orange:'5.5.1',kysely:'0.29.8',pg:'8.23.1'});
  assert.equal(typeof admin?.query,'function');assert.equal(typeof openPostgresDatabase,'function');
  assert.equal(postgresOptions?.connectionString,undefined);assert.equal(postgresOptions?.ssl,false);
  for(const key of ['host','user','database'])assert.equal(typeof postgresOptions[key],'string');
  const token=randomBytes(6).toString('hex'),schemas=['rowstitch','orange','kysely'].map(name=>'rs_agg_'+name+'_'+token);
  const numericParser=pg.types.getTypeParser(1700,'text'),created=[],tools=[],cases=[];
  const cleanup={openedHandles:0,closedHandles:0,schemasDropped:0};
  const report={format:'rowstitch-public-postgres-aggregate-comparison',versions,cases,cleanup,limits:[
    'One deterministic fictional dataset and native PostgreSQL server, not a latency, concurrency, AI-cost or universal ranking.',
    'All equivalent fixtures are seeded by the same raw-text administrative transport, separating aggregate behavior from insert codecs.',
    'Kysely uses explicit correlated-subquery/application SQL recipes. Orange uses documented aggregate and getMany selector APIs.',
    'Lossless count/integer strings are normalized through BigInt only; unsafe Number results remain observable differences.',
    'Approximate AVG outputs may be NUMERIC decimal strings; these small finite fixture means are converted to Number explicitly and their original representation is retained.',
    'SUM/AVG empty-set behavior, aggregate output representation and native float arithmetic can intentionally differ.',
    'Relation comparisons cover paths up to two hops here; deeper path support needs separate coverage.',
  ]};
  report.apiSources=['https://orange-orm.io/aggregates.html','orange-orm@5.5.1 README Aggregate functions and src/map2.d.ts','kysely@0.29.8 aggregate/order-builder public APIs'];
  const native=(sql,values=[])=>admin.query(sql,values);
  const settings='-c extra_float_digits=3 -c client_encoding=UTF8 -c statement_timeout=5000 -c lock_timeout=2000';
  let lastObservation;
  const observe=value=>{lastObservation=value;return value;};
  async function check(tool,name,fn){
    lastObservation=undefined;
    try{const result=await fn();cases.push({tool:tool.name,name,status:'pass',...result});}
    catch(error){cases.push({tool:tool.name,name,status:'fail',code:typeof error?.code==='string'?error.code:null,
      detail:String(error?.message).replaceAll(postgresOptions.password??'\0','<password>').slice(0,350),observed:representation(lastObservation)});}
  }
  try{
    const server=await native("SELECT current_setting('server_version'),current_setting('server_encoding')");
    assert.equal(server.rows[0][1],'UTF8');report.server={version:server.rows[0][0],encoding:server.rows[0][1]};
    for(const schema of schemas){
      await native('CREATE SCHEMA '+quote(schema));created.push(schema);await native('REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');
      for(const [table,definition]of [['parents','id int4 PRIMARY KEY,team text,region text NOT NULL,budget int4 NOT NULL'],
        ['items','id int4 PRIMARY KEY,parent_id int4,qty int4,wide int8,ratio float8,label text'],
        ['refunds','id int4 PRIMARY KEY,parent_id int4 NOT NULL,amount int4 NOT NULL'],['links','id int4 PRIMARY KEY,item_id int4 NOT NULL,weight int4 NOT NULL']]){
        await native('CREATE TABLE '+quote(schema)+'.'+quote(table)+'('+definition+')');
      }
      for(const [table,rows]of [['parents',parents],['items',items],['refunds',refunds],['links',links]])for(const row of rows){
        const keys=Object.keys(row),values=keys.map(key=>row[key]===null?null:String(row[key]));
        await native('INSERT INTO '+quote(schema)+'.'+quote(table)+'('+keys.map(quote).join(',')+') VALUES('+values.map((_,i)=>'$'+(i+1)).join(',')+')',values);
      }
    }
    // Independent raw-text controls establish this fixture's exact data and the multiplication produced by one joined domain.
    const controlledSchema=quote(schemas[1]);
    const control=(await native('SELECT SUM(wide)::text,MIN(label),MAX(label),AVG(qty)::float8 FROM '+controlledSchema+'.items')).rows;
    assert.deepEqual(control,[[exactTotal.toString(),'A','orphan','3.25']]);
    const joined=(await native('SELECT COUNT(*)::text,SUM(p.budget)::text,COUNT(i.id)::text,COUNT(i.qty)::text,SUM(i.qty)::text,AVG(i.qty)::float8,SUM(f.amount)::text,COUNT(l.id)::text FROM '
      +controlledSchema+'.parents p LEFT JOIN '+controlledSchema+'.items i ON i.parent_id=p.id LEFT JOIN '+controlledSchema+'.refunds f ON f.parent_id=p.id LEFT JOIN '
      +controlledSchema+'.links l ON l.item_id=i.id')).rows;
    assert.deepEqual(joined,[['9','150','8','7','9',String(9/7),'26','5']]);
    report.nativeControls={exactSumTextAndTypedExtrema:control,oneJoinedDomain:joined};
    const {column,defineTable,hasMany,agg,gt,eq,asc}=sdk;
    const rt=defineTable('parents',{id:column.integer().primaryKey(),team:column.text().nullable(),region:column.text(),budget:column.integer()});
    const it=defineTable('items',{id:column.integer().primaryKey(),parent_id:column.integer().nullable(),qty:column.integer().nullable(),wide:column.bigint().nullable(),ratio:column.real().nullable(),label:column.text().nullable()});
    const ft=defineTable('refunds',{id:column.integer().primaryKey(),parent_id:column.integer(),amount:column.integer()});
    const lt=defineTable('links',{id:column.integer().primaryKey(),item_id:column.integer(),weight:column.integer()});
    const relation=hasMany(it,{localKey:rt.col('id'),foreignKey:it.col('parent_id')}),refundRelation=hasMany(ft,{localKey:rt.col('id'),foreignKey:ft.col('parent_id')}),linkRelation=hasMany(lt,{localKey:it.col('id'),foreignKey:lt.col('item_id')});
    const rowDb=await openPostgresDatabase({...postgresOptions,tables:[rt,it,ft,lt],schema:schemas[0],statementTimeoutMs:5000,lockTimeoutMs:2000});cleanup.openedHandles++;
    const rr=rowDb.table(rt),ir=rowDb.table(it);
    const rootSelection={rows:agg.count(),present:agg.count(it.col('qty')),total:agg.sum(it.col('qty')),mean:agg.avg(it.col('qty')),low:agg.min(it.col('qty')),high:agg.max(it.col('qty')),
      realTotal:agg.sum(it.col('ratio')),realMean:agg.avg(it.col('ratio')),labelLow:agg.min(it.col('label')),labelHigh:agg.max(it.col('label'))};
    const relatedSelection={rows:agg.count(),budget:agg.sum(rt.col('budget')),leaves:agg.related(relation,agg.count()),present:agg.related(relation,agg.count(it.col('qty'))),
      total:agg.related(relation,agg.sum(it.col('qty'))),mean:agg.related(relation,agg.avg(it.col('qty'))),refund:agg.related(refundRelation,agg.sum(ft.col('amount'))),
      deep:agg.related(relation,agg.related(linkRelation,agg.count()))};
    const projectedSelection={leaves:relatedSelection.leaves,total:relatedSelection.total,mean:relatedSelection.mean,refund:relatedSelection.refund,deep:relatedSelection.deep};
    tools.push({name:'rowstitch',close:()=>rowDb.close(),
      root:where=>ir.aggregate({select:rootSelection,...(where?{where:where==='empty'?gt(it.col('id'),1000):eq(it.col('parent_id'),3)}:{})}),
      wide:async()=>(await ir.aggregate({select:{total:agg.sum(it.col('wide'))}})).total,
      group:({multi=false,page=false}={})=>ir.groupBy({by:multi?['parent_id','label']:['parent_id'],select:{rows:agg.count(),present:agg.count(it.col('qty')),total:agg.sum(it.col('qty'))},
        ...(page?{orderBy:[{field:'total',direction:'desc'}],limit:2,offset:1}:{})}),
      related:()=>rr.aggregate({select:relatedSelection}),relatedGroup:()=>rr.groupBy({by:['team'],select:relatedSelection}),
      projected:page=>rr.findMany({select:['id','team'],aggregates:projectedSelection,orderBy:[asc(rt.col('id'))],...(page?{limit:2,offset:1}:{})}),
    });
    const uri=new URL('postgres://localhost');uri.hostname=postgresOptions.host;uri.port=String(postgresOptions.port??5432);uri.username=postgresOptions.user;
    uri.password=postgresOptions.password??'';uri.pathname='/'+postgresOptions.database;uri.searchParams.set('sslmode','disable');uri.searchParams.set('search_path',schemas[1]);uri.searchParams.set('options',settings);
    const map=orange.map(x=>({
      parents:x.table('parents').map(({column:c})=>({id:c('id').numeric().primary(),team:c('team').string(),region:c('region').string().notNull(),budget:c('budget').numeric().notNull()})),
      items:x.table('items').map(({column:c})=>({id:c('id').numeric().primary(),parent_id:c('parent_id').numeric(),qty:c('qty').numeric(),wide:c('wide').bigint(),ratio:c('ratio').numeric(),label:c('label').string()})),
      refunds:x.table('refunds').map(({column:c})=>({id:c('id').numeric().primary(),parent_id:c('parent_id').numeric().notNull(),amount:c('amount').numeric().notNull()})),
      links:x.table('links').map(({column:c})=>({id:c('id').numeric().primary(),item_id:c('item_id').numeric().notNull(),weight:c('weight').numeric().notNull()})),
    })).map(x=>({parents:x.parents.map(({hasMany:many})=>({items:many(x.items).by('parent_id'),refunds:many(x.refunds).by('parent_id')})),
      items:x.items.map(({hasMany:many})=>({links:many(x.links).by('item_id')}))}));
    const orangeDb=map.postgres(uri.href,{size:1,min:0});cleanup.openedHandles++;
    const orangeRoot={rows:x=>x.count(x=>x.id),present:x=>x.count(x=>x.qty),total:x=>x.sum(x=>x.qty),mean:x=>x.avg(x=>x.qty),low:x=>x.min(x=>x.qty),high:x=>x.max(x=>x.qty),
      realTotal:x=>x.sum(x=>x.ratio),realMean:x=>x.avg(x=>x.ratio),labelLow:x=>x.min(x=>x.label),labelHigh:x=>x.max(x=>x.label)};
    const orangeRelated={rows:x=>x.count(x=>x.id),budget:x=>x.sum(x=>x.budget),leaves:x=>x.count(x=>x.items.id),present:x=>x.count(x=>x.items.qty),
      total:x=>x.sum(x=>x.items.qty),mean:x=>x.avg(x=>x.items.qty),refund:x=>x.sum(x=>x.refunds.amount),deep:x=>x.count(x=>x.items.links.id)};
    const orangeProjection={id:true,team:true,leaves:orangeRelated.leaves,total:orangeRelated.total,mean:orangeRelated.mean,refund:orangeRelated.refund,deep:orangeRelated.deep};
    // An explicit application recipe uses separate child domains and count witnesses. This is multiple queries on a fixed fixture,
    // not a dedicated single-statement relation feature or a concurrent snapshot guarantee.
    async function orangeIndependent({team,ids}={}){
      const rootWhere=ids?x=>x.id.in(ids):team!==undefined?x=>x.team.eq(team):undefined;
      const rootRows=await orangeDb.parents.getMany({id:true,orderBy:'id',...(rootWhere?{where:rootWhere}:{})});
      const keys=rootRows.map(row=>row.id);
      const childWhere=x=>x.parent_id.in(keys);
      const child=(await orangeDb.items.aggregate({where:childWhere,leaves:x=>x.count(x=>x.id),present:x=>x.count(x=>x.qty),total:x=>x.sum(x=>x.qty),mean:x=>x.avg(x=>x.qty)}))[0];
      const refund=(await orangeDb.refunds.aggregate({where:x=>x.parent_id.in(keys),present:x=>x.count(x=>x.id),total:x=>x.sum(x=>x.amount)}))[0];
      const childKeys=(await orangeDb.items.getMany({id:true,where:childWhere})).map(row=>row.id);
      const deep=(await orangeDb.links.aggregate({where:x=>x.item_id.in(childKeys),value:x=>x.count(x=>x.id)}))[0].value;
      return {leaves:child.leaves,present:child.present,total:child.present?child.total:null,mean:child.present?child.mean:null,refund:refund.present?refund.total:null,deep};
    }
    async function orangeAcrossRecipe(grouped=false){
      const base=await orangeDb.parents.aggregate({...grouped?{team:x=>x.team}:{},rows:x=>x.count(x=>x.id),budget:x=>x.sum(x=>x.budget)});
      return Promise.all(base.map(async row=>({...plain(row),...await orangeIndependent(grouped?{team:row.team}:{})})));
    }
    async function orangeProjectionRecipe(page){
      const base=await orangeDb.parents.getMany({id:true,team:true,orderBy:'id',...(page?{limit:2,offset:1}:{})});
      const results=[];
      for(const row of base){const {present,...summary}=await orangeIndependent({ids:[row.id]});results.push({id:row.id,team:row.team,...summary});}
      return results;
    }
    tools.push({name:'orange-orm@5.5.1',close:()=>orangeDb.close(),
      root:async where=>(await orangeDb.items.aggregate({...orangeRoot,...(where?{where:x=>where==='empty'?x.id.gt(1000):x.parent_id.eq(3)}:{})}))[0],
      wide:async()=>(await orangeDb.items.aggregate({total:x=>x.sum(x=>x.wide)}))[0].total,
      group:({multi=false,page=false}={})=>orangeDb.items.aggregate({parent_id:x=>x.parent_id,...(multi?{label:x=>x.label}:{}),rows:x=>x.count(x=>x.id),present:x=>x.count(x=>x.qty),total:x=>x.sum(x=>x.qty),
        ...(page?{orderBy:'total desc',limit:2,offset:1}:{})}),
      related:async()=>(await orangeDb.parents.aggregate(orangeRelated))[0],relatedGroup:()=>orangeDb.parents.aggregate({team:x=>x.team,...orangeRelated}),
      projected:page=>orangeDb.parents.getMany({...orangeProjection,orderBy:'id',...(page?{limit:2,offset:1}:{})}),
      relatedRecipe:async()=>(await orangeAcrossRecipe())[0],relatedGroupRecipe:()=>orangeAcrossRecipe(true),projectedRecipe:orangeProjectionRecipe,
      wideRecipe:async()=>(await orangeDb.query('SELECT SUM(wide)::text AS total FROM '+quote(schemas[1])+'.items'))[0].total,
    });
    // Trigger Orange's documented lazy connection before restoring NUMERIC for the independent Kysely connection.
    await orangeDb.items.count();pg.types.setTypeParser(1700,'text',numericParser);
    const pool=new pg.Pool({...postgresOptions,max:1,options:settings+' -c search_path='+schemas[2]});
    const kdb=new kysely.Kysely({dialect:new kysely.PostgresDialect({pool})});cleanup.openedHandles++;
    const kRoot=()=>kdb.selectFrom('items').select(eb=>[eb.fn.countAll().as('rows'),eb.fn.count('qty').as('present'),eb.fn.sum('qty').as('total'),eb.fn.avg('qty').as('mean'),eb.fn.min('qty').as('low'),eb.fn.max('qty').as('high'),
      eb.fn.sum('ratio').as('realTotal'),eb.fn.avg('ratio').as('realMean'),eb.fn.min('label').as('labelLow'),eb.fn.max('label').as('labelHigh')]);
    const kRelated=(column,op,root='p')=>kdb.selectFrom('items as i').select(eb=>eb.fn[op](column).as('value')).whereRef('i.parent_id','=',root+'.id');
    const kRefund=(root='p')=>kdb.selectFrom('refunds as f').select(eb=>eb.fn.sum('f.amount').as('value')).whereRef('f.parent_id','=',root+'.id');
    const kDeep=(root='p')=>kdb.selectFrom('items as i').innerJoin('links as l','l.item_id','i.id').select(eb=>eb.fn.count('l.id').as('value')).whereRef('i.parent_id','=',root+'.id');
    const kProjection=()=>kdb.selectFrom('parents as p').select(['p.id','p.team']).select(eb=>[kRelated('i.id','count').as('leaves'),kRelated('i.qty','sum').as('total'),kRelated('i.qty','avg').as('mean'),kRefund().as('refund'),kDeep().as('deep')]);
    // Root/group relation recipes aggregate the joined leaf domain independently, avoiding a multi-child join fanout.
    const kAcross=(grouped=false)=>kdb.selectFrom('parents as p').select(eb=>[
      eb.fn.countAll().as('rows'),eb.fn.sum('p.budget').as('budget'),
      ...[['leaves','id','count'],['present','qty','count'],['total','qty','sum'],['mean','qty','avg']].map(([alias,column,operation])=>{
        let query=kdb.selectFrom('items as i').innerJoin('parents as q','q.id','i.parent_id').select(inner=>inner.fn[operation]('i.'+column).as('value'));
        if(grouped)query=query.where(kysely.sql`q.team is not distinct from p.team`);return query.as(alias);
      }),
      (()=>{let query=kdb.selectFrom('refunds as f').innerJoin('parents as q','q.id','f.parent_id').select(inner=>inner.fn.sum('f.amount').as('value'));if(grouped)query=query.where(kysely.sql`q.team is not distinct from p.team`);return query.as('refund');})(),
      (()=>{let query=kdb.selectFrom('links as l').innerJoin('items as i','i.id','l.item_id').innerJoin('parents as q','q.id','i.parent_id').select(inner=>inner.fn.count('l.id').as('value'));if(grouped)query=query.where(kysely.sql`q.team is not distinct from p.team`);return query.as('deep');})(),
    ]).$if(grouped,query=>query.select('p.team').groupBy('p.team'));
    tools.push({name:'kysely@0.29.8',close:()=>kdb.destroy(),
      root:where=>{let query=kRoot();if(where)query=where==='empty'?query.where('id','>',1000):query.where('parent_id','=',3);return query.executeTakeFirstOrThrow();},
      wide:async()=>(await kdb.selectFrom('items').select(eb=>eb.fn.sum('wide').as('total')).executeTakeFirstOrThrow()).total,
      group:({multi=false,page=false}={})=>{let query=kdb.selectFrom('items').select(['parent_id',...(multi?['label']:[])]).select(eb=>[eb.fn.countAll().as('rows'),eb.fn.count('qty').as('present'),eb.fn.sum('qty').as('total')]).groupBy(['parent_id',...(multi?['label']:[])]);
        if(page)query=query.orderBy('total',order=>order.desc().nullsLast()).limit(2).offset(1);return query.execute();},
      related:()=>kAcross().executeTakeFirstOrThrow(),relatedGroup:()=>kAcross(true).execute(),
      projected:page=>{let query=kProjection().orderBy('p.id');if(page)query=query.limit(2).offset(1);return query.execute();},
      defaultGroupPage:()=>kdb.selectFrom('items').select('parent_id').select(eb=>eb.fn.sum('qty').as('total')).groupBy('parent_id').orderBy('total','desc').limit(2).offset(1).execute(),
      recipe:'Kysely correlated-subquery and independent-domain SQL recipes, not an assumed dedicated ORM relation API',
    });
    const integerKeys=['rows','present','total'];
    const ordinary={rows:5n,present:4n,total:13n,mean:3.25,low:-1,high:9,realTotal:18,realMean:4.5,labelLow:'A',labelHigh:'orphan'};
    const independent={rows:4n,budget:100n,leaves:4n,present:3n,total:4n,mean:4/3,refund:12n,deep:3n};
    const groupedIndependent=[{team:null,rows:1n,budget:30n,leaves:1n,present:0n,total:null,mean:null,refund:null,deep:0n},
      {team:'A',rows:2n,budget:30n,leaves:3n,present:3n,total:4n,mean:4/3,refund:12n,deep:3n},
      {team:'B',rows:1n,budget:40n,leaves:0n,present:0n,total:null,mean:null,refund:null,deep:0n}];
    const projectedExpected=[{id:1,team:'A',leaves:2n,total:1n,mean:.5,refund:7n,deep:2n},{id:2,team:'A',leaves:1n,total:3n,mean:3,refund:5n,deep:1n},
      {id:3,team:null,leaves:1n,total:null,mean:null,refund:null,deep:0n},{id:4,team:'B',leaves:0n,total:null,mean:null,refund:null,deep:0n}];
    for(const tool of tools){
      await check(tool,'root scalar count/sum/avg/min/max with nullable arguments',async()=>{
        const observed=observe(await tool.root());
        if(tool.name==='orange-orm@5.5.1'){
          assert.deepEqual(numbers(observed,integerKeys),{...ordinary,labelLow:NaN,labelHigh:NaN});
          return {status:'difference',observed:representation(observed),semantics:'Pinned Orange root aggregate decoding returns NaN for these text MIN/MAX values; numeric aggregates match. This is an observed representation difference, not a claim that MIN/MAX APIs are absent.'};
        }
        assert.deepEqual(numbers(observed,integerKeys),ordinary);return {observed:representation(observed),recipe:tool.recipe};
      });
      await check(tool,'root empty domain and all-null arguments',async()=>{
        const empty=await tool.root('empty'),allNull=await tool.root('null');
        observe({empty,allNull});
        const wantEmpty={rows:0n,present:0n,total:null,mean:null,low:null,high:null,realTotal:null,realMean:null,labelLow:null,labelHigh:null};
        const wantNull={...wantEmpty,rows:1n};
        if(tool.name==='orange-orm@5.5.1'){
          const zero={...wantEmpty,total:0n,mean:0,realTotal:0,realMean:0,low:NaN,high:NaN,labelLow:NaN,labelHigh:NaN};
          assert.deepEqual(numbers(empty,integerKeys),zero);assert.deepEqual(numbers(allNull,integerKeys),{...zero,rows:1n});
          return {status:'difference',empty:representation(empty),allNull:representation(allNull),semantics:'Pinned Orange coalesces empty/all-null SUM and AVG to0 and decodes these NULL MIN/MAX values as NaN; Rowstitch and the explicit Kysely recipe retain SQL NULL.'};
        }
        assert.deepEqual(numbers(empty,integerKeys),wantEmpty);assert.deepEqual(numbers(allNull,integerKeys),wantNull);
        return {empty:representation(empty),allNull:representation(allNull)};
      });
      await check(tool,'exact integer SUM beyond int64 exposes raw representation',async()=>{
        const observed=observe(await tool.wide());
        if(tool.name==='orange-orm@5.5.1'){
          assert.equal(observed,Number(exactTotal));assert.ok(!Number.isSafeInteger(observed));assert.notEqual(BigInt(observed),exactTotal);
          const recipe=await tool.wideRecipe();assert.equal(integer(recipe),exactTotal);
          return {status:'difference',observed:representation(observed),roundedInteger:BigInt(observed).toString(),exactDecimal:exactTotal.toString(),recipeMatched:representation(recipe),semantics:'Orange root aggregate decodes the NUMERIC SUM into an unsafe Number. Its explicit raw-query recipe casts SUM to text and preserves the exact total.'};
        }
        assert.equal(integer(observed),exactTotal);return {observed:representation(observed),exactDecimal:exactTotal.toString()};
      });
      await check(tool,'groups preserve NULL keys and all-null SUM',async()=>{
        const observed=observe(await tool.group()),actual=sort(observed.map(row=>numbers(row,integerKeys)),['parent_id']);
        const expected=[{parent_id:null,rows:1n,present:1n,total:9n},{parent_id:1,rows:2n,present:2n,total:1n},{parent_id:2,rows:1n,present:1n,total:3n},{parent_id:3,rows:1n,present:0n,total:null}];
        if(tool.name==='orange-orm@5.5.1'){
          assert.deepEqual(actual,expected.map(row=>row.total===null?{...row,total:0n}:row));
          assert.deepEqual(actual.map(row=>row.present===0n?{...row,total:null}:row),expected);
          return {status:'difference',observed:representation(observed),semantics:'Orange coalesces the all-null grouped SUM to0. An application count witness restores NULL without changing a legitimate zero total.'};
        }
        assert.deepEqual(actual,expected);
        return {observed:representation(observed)};
      });
      await check(tool,'multi-key groups do not merge NULL and non-NULL argument rows',async()=>{
        const observed=observe(await tool.group({multi:true})),actual=sort(observed.map(row=>numbers(row,integerKeys)),['parent_id','label']);
        const expected=[{parent_id:null,label:'orphan',rows:1n,present:1n,total:9n},{parent_id:1,label:'A',rows:1n,present:1n,total:-1n},{parent_id:1,label:'b',rows:1n,present:1n,total:2n},
          {parent_id:2,label:'c',rows:1n,present:1n,total:3n},{parent_id:3,label:null,rows:1n,present:0n,total:null}];
        if(tool.name==='orange-orm@5.5.1'){
          assert.deepEqual(actual,expected.map(row=>row.total===null?{...row,total:0n}:row));
          return {status:'difference',observed:representation(observed),semantics:'Keys and counts match; the pinned Orange multi-key all-null SUM is0 rather than SQL NULL.'};
        }
        assert.deepEqual(actual,expected);return {observed:representation(observed)};
      });
      await check(tool,'aggregate ordering and limit/offset use database-side group outputs',async()=>{
        const observed=observe(await tool.group({page:true}));assert.deepEqual(observed.map(row=>row.parent_id),[2,1]);
        if(tool.defaultGroupPage){const defaults=await tool.defaultGroupPage();assert.deepEqual(defaults.map(row=>row.parent_id),[null,2]);
          return {status:'difference',defaultPage:representation(defaults),recipeMatched:representation(observed),semantics:'Kysely DESC retains PostgreSQL NULLS FIRST; the explicit nullsLast order-builder recipe matches Rowstitch DESC NULLS LAST. Orange coalesces the all-null SUM to0 before ordering.'};}
        return {observed:representation(observed)};
      });
      await check(tool,'independent related domains avoid fanout and retain leaf-weighted AVG',async()=>{
        const observed=observe(await tool.related());
        if(tool.relatedRecipe){
          assert.deepEqual(numbers(observed,['rows','budget','leaves','present','total','refund','deep']),{rows:9n,budget:150n,leaves:8n,present:7n,total:9n,mean:9/7,refund:26n,deep:5n});
          const recipe=await tool.relatedRecipe();assert.deepEqual(numbers(recipe,['rows','budget','leaves','present','total','refund','deep']),independent);
          return {status:'difference',observed:representation(observed),recipeMatched:representation(recipe),semantics:'The pinned Orange combined selectors use a joined leaf domain, which multiplies this multi-child fixture. An explicit application recipe queries independent domains and matches the intended independent counts/totals/leaf-weighted mean; it uses multiple requests.'};
        }
        assert.deepEqual(numbers(observed,['rows','budget','leaves','present','total','refund','deep']),independent);
        return {observed:representation(observed),recipe:tool.recipe};
      });
      await check(tool,'related grouped summaries retain NULL keys and empty child domains',async()=>{
        const observed=observe(await tool.relatedGroup()),actual=sort(observed.map(row=>numbers(row,['rows','budget','leaves','present','total','refund','deep'])),['team']);
        if(tool.relatedGroupRecipe){
          assert.deepEqual(actual,[{team:null,rows:1n,budget:30n,leaves:1n,present:0n,total:0n,mean:0,refund:0n,deep:0n},
            {team:'A',rows:7n,budget:80n,leaves:7n,present:7n,total:9n,mean:9/7,refund:26n,deep:5n},
            {team:'B',rows:1n,budget:40n,leaves:0n,present:0n,total:0n,mean:0,refund:0n,deep:0n}]);
          const recipe=await tool.relatedGroupRecipe();assert.deepEqual(sort(recipe.map(row=>numbers(row,['rows','budget','leaves','present','total','refund','deep'])),['team']),groupedIndependent);
          return {status:'difference',observed:representation(observed),recipeMatched:representation(recipe),semantics:'The same joined-domain/coalescing differences occur per group. An application recipe queries each independent domain with explicit group/root keys and count witnesses; it matches the fixed fixture, without claiming concurrent snapshot parity.'};
        }
        assert.deepEqual(actual,groupedIndependent);return {observed:representation(observed),recipe:tool.recipe};
      });
      await check(tool,'projected child summaries, multiple selectors and a two-hop path',async()=>{
        const observed=observe(await tool.projected());
        if(tool.projectedRecipe){
          assert.deepEqual(plain(observed),[{id:1,team:'A',leaves:2,total:1,mean:.5,refund:7,deep:2},{id:2,team:'A',leaves:1,total:3,mean:3,refund:5,deep:1},
            {id:3,team:null,leaves:1,total:0,mean:0,refund:0,deep:NaN},{id:4,team:'B',leaves:NaN,total:0,mean:0,refund:0,deep:NaN}]);
          const recipe=await tool.projectedRecipe(false);assert.deepEqual(recipe.map(row=>numbers(row,['leaves','total','refund','deep'])),projectedExpected);
          return {status:'difference',observed:representation(observed),recipeMatched:representation(recipe),semantics:'Nonempty projected values match. Missing related counts decode as NaN in this pinned Orange path and SUM/AVG coalesce to0. A multi-request independent-domain/count-witness application recipe matches explicit0/null semantics.'};
        }
        const actual=observed.map(row=>numbers(row,['leaves','total','refund','deep']));assert.deepEqual(actual,projectedExpected);return {observed:representation(observed),recipe:tool.recipe};
      });
      await check(tool,'projected root page keeps child summaries attached to their own roots',async()=>{
        const observed=observe(await tool.projected(true));
        if(tool.projectedRecipe){
          assert.deepEqual(plain(observed),[{id:2,team:'A',leaves:1,total:3,mean:3,refund:5,deep:1},{id:3,team:null,leaves:1,total:0,mean:0,refund:0,deep:NaN}]);
          const recipe=await tool.projectedRecipe(true);assert.deepEqual(recipe.map(row=>numbers(row,['leaves','total','refund','deep'])),projectedExpected.slice(1,3));
          return {status:'difference',observed:representation(observed),recipeMatched:representation(recipe),semantics:'Parent page identity matches. The same missing-domain representation differences remain and the explicit multi-request count-witness recipe matches0/null semantics.'};
        }
        const actual=observed.map(row=>numbers(row,['leaves','total','refund','deep']));assert.deepEqual(actual,projectedExpected.slice(1,3));return {observed:representation(observed),recipe:tool.recipe};
      });
    }
  }finally{
    let cleanupFailed=false;
    for(const tool of [...tools].reverse()){try{await tool.close();cleanup.closedHandles++;}catch{cleanupFailed=true;}}
    for(const schema of [...created].reverse()){try{await native('DROP SCHEMA '+quote(schema)+' CASCADE');assert.deepEqual((await native('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1::text',[schema])).rows,[]);cleanup.schemasDropped++;}catch{cleanupFailed=true;}}
    pg.types.setTypeParser(1700,'text',numericParser);if(cleanupFailed)throw new Error('Owned aggregate comparison cleanup did not complete.');
  }
  report.summary={pass:cases.filter(item=>item.status==='pass').length,difference:cases.filter(item=>item.status==='difference').length,fail:cases.filter(item=>item.status==='fail').length};
  return report;
}
