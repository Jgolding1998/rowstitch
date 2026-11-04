// Actual public aggregate APIs on fixed fictional data. Caller owns the disposable engine/admin connection.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const quote=name=>'"'+name.replaceAll('"','""')+'"';
const code=expected=>error=>error?.code===expected;

/**
 * Supply sdk and factories from the SAME build/package, so table brands are genuine. PostgreSQL needs an explicit
 * direct-field target plus a caller-owned admin.query(sql, parameters) returning positional raw-text rows on the
 * SAME already verified disposable server. This runner owns only its random schema and ORM handles; not admin/Docker.
 * PGlite uses its real fresh worker-owned in-memory factory. No mocked executor, driver-detail report or timing ranking.
 */
export async function runPublicAggregateCases({engine,sdk,openPostgresDatabase,openPgliteDatabase,postgresOptions,admin}){
  assert.ok(engine==='postgresql'||engine==='pglite');
  const postgres=engine==='postgresql',factory=postgres?openPostgresDatabase:openPgliteDatabase;
  assert.equal(typeof factory,'function');
  if(postgres){assert.equal(typeof admin?.query,'function');assert.equal(postgresOptions?.connectionString,undefined);
    for(const key of ['host','user','database'])assert.equal(typeof postgresOptions?.[key],'string');}
  const {column,defineTable,agg,hasMany,eq,gt,gte,asc}=sdk,MAX=9223372036854775807n;
  const schema=postgres?'rs_aggregates_'+randomBytes(6).toString('hex'):'public',databases=new Set(),cases=[];
  const cleanup={openedDatabases:0,closedDatabases:0,schemaDropped:!postgres};
  const report={engine,cases,cleanup,limits:[
    'Fixed fictional aggregate corpus, not a timing, production reliability or full feature-parity claim.',
    'Real SUM remains native, approximate and order-sensitive. Real AVG uses that SUM/count and may differ from native AVG or SQLite, including signed zero and bounded rounding.',
    'A finite mathematical average can still refuse AGGREGATE_RANGE when its native SUM overflows. No compensated/exact real-average claim.',
    'Native grouped summaries can evaluate an overflowing group outside the returned page. Filter the input domain explicitly; pagination is not an error-isolation boundary.',
    'The deliberately invalid physical integer guard/healthy-transaction control uses only the PostgreSQL admin fixture; PGlite private-worker storage is not externally mutated here.',
    'PostgreSQL range classification is statement-wide SQLSTATE22003 context, not proof of its origin inside a trusted view/predicate.',
  ]};
  let db,schemaCreated=false,failed=false;
  const query=async(sql,parameters=[])=>{try{return await admin.query(sql,parameters);}catch{throw new Error('Owned aggregate fixture administration failed.');}};
  const close=async database=>{await database.close();if(databases.delete(database))cleanup.closedDatabases++;};
  const check=async(name,compile,body)=>{
    if(compile){const result=compile();assert.deepEqual(Object.keys(result).sort(),['parameters','sql']);assert.equal(typeof result.sql,'string');assert.ok(Array.isArray(result.parameters));}
    await body();cases.push(name);
  };
  const roots=defineTable('agg_roots',{id:column.integer().primaryKey(),category:column.text().nullable(),tier:column.integer()});
  const items=defineTable('agg_items',{id:column.integer().primaryKey(),rootId:column.integer().nullable().references(roots,'id'),qty:column.integer().nullable(),
    amount:column.bigint().nullable(),ratio:column.real().nullable(),label:column.text().nullable(),active:column.boolean().nullable()});
  const refunds=defineTable('agg_refunds',{id:column.integer().primaryKey(),rootId:column.integer().references(roots,'id'),amount:column.bigint()});
  const links=defineTable('agg_links',{id:column.integer().primaryKey(),itemId:column.integer().references(items,'id'),weight:column.integer()});
  const atoms=defineTable('agg_atoms',{id:column.integer().primaryKey(),linkId:column.integer().references(links,'id')});
  const dust=defineTable('agg_dust',{id:column.integer().primaryKey(),atomId:column.integer().references(atoms,'id'),weight:column.integer()});
  const numbers=defineTable('agg_numbers',{id:column.integer().primaryKey(),rootId:column.integer().references(roots,'id'),bucket:column.text(),value:column.real().nullable()});
  const rel=hasMany(items,{localKey:roots.col('id'),foreignKey:items.col('rootId')}),refundRel=hasMany(refunds,{localKey:roots.col('id'),foreignKey:refunds.col('rootId')});
  const linkRel=hasMany(links,{localKey:items.col('id'),foreignKey:links.col('itemId')}),atomRel=hasMany(atoms,{localKey:links.col('id'),foreignKey:atoms.col('linkId')});
  const dustRel=hasMany(dust,{localKey:atoms.col('id'),foreignKey:dust.col('atomId')}),numberRel=hasMany(numbers,{localKey:roots.col('id'),foreignKey:numbers.col('rootId')});
  try{
    if(postgres){await query('CREATE SCHEMA '+quote(schema));schemaCreated=true;await query('REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');}
    db=await factory({...(postgres?postgresOptions:{}),tables:[dust,atoms,links,items,refunds,numbers,roots],schema,traceValues:false});
    databases.add(db);cleanup.openedDatabases++;await db.ensureSchema();
    await db.table(roots).insertMany([{id:1,category:'A',tier:1},{id:2,category:'A',tier:2},{id:3,category:null,tier:3},{id:4,category:'B',tier:4}]);
    await db.table(items).insertMany([
      {id:11,rootId:1,qty:2,amount:MAX,ratio:1.5,label:'b',active:true},{id:12,rootId:1,qty:-1,amount:MAX,ratio:2.5,label:'A',active:false},
      {id:21,rootId:2,qty:3,amount:-1n,ratio:4,label:'c',active:null},{id:31,rootId:3,qty:null,amount:null,ratio:null,label:null,active:null},
      {id:99,rootId:null,qty:9,amount:7n,ratio:10,label:'orphan',active:true}]);
    await db.table(refunds).insertMany([{id:1,rootId:1,amount:3n},{id:2,rootId:1,amount:4n},{id:3,rootId:2,amount:5n}]);
    await db.table(links).insertMany([{id:1,itemId:11,weight:1},{id:2,itemId:11,weight:2},{id:3,itemId:21,weight:3}]);
    await db.table(atoms).insertMany([{id:1,linkId:1},{id:2,linkId:1},{id:3,linkId:3}]);
    await db.table(dust).insertMany([{id:1,atomId:1,weight:1},{id:2,atomId:1,weight:2},{id:3,atomId:2,weight:10},{id:4,atomId:3,weight:100}]);
    const r=db.table(items),p=db.table(roots),numeric=db.table(numbers);
    const select={rows:agg.count(),qtyN:agg.count(items.col('qty')),amountN:agg.count(items.col('amount')),ratioN:agg.count(items.col('ratio')),labelN:agg.count(items.col('label')),flagN:agg.count(items.col('active')),
      qty:agg.sum(items.col('qty')),amount:agg.sum(items.col('amount')),ratio:agg.sum(items.col('ratio')),
      qtyAvg:agg.avg(items.col('qty')),amountAvg:agg.avg(items.col('amount'),{approximate:true}),ratioAvg:agg.avg(items.col('ratio')),
      qtyMin:agg.min(items.col('qty')),qtyMax:agg.max(items.col('qty')),amountMin:agg.min(items.col('amount')),amountMax:agg.max(items.col('amount')),
      ratioMin:agg.min(items.col('ratio')),ratioMax:agg.max(items.col('ratio')),labelMin:agg.min(items.col('label')),labelMax:agg.max(items.col('label'))};
    await check('root20 scalar selectors preserve nullable counts, decoded types and exact sums beyond int64',()=>r.compileAggregate({select}),async()=>{
      assert.deepEqual(await r.aggregate({select}),{rows:5,qtyN:4,amountN:4,ratioN:4,labelN:4,flagN:3,qty:13n,amount:2n*MAX+6n,ratio:18,
        qtyAvg:3.25,amountAvg:Number(2n*MAX+6n)/4,ratioAvg:4.5,qtyMin:-1,qtyMax:9,amountMin:-1n,amountMax:MAX,ratioMin:1.5,ratioMax:10,labelMin:'A',labelMax:'orphan'});
    });
    await check('root empty domain returns count0 and nullable summaries',()=>r.compileAggregate({select,where:gt(items.col('id'),1000)}),async()=>{
      const actual=await r.aggregate({select,where:gt(items.col('id'),1000)});
      for(const [key,value]of Object.entries(actual))assert.equal(value,['rows','qtyN','amountN','ratioN','labelN','flagN'].includes(key)?0:null);
    });
    const grouped={by:['rootId'],select:{rows:agg.count(),qty:agg.sum(items.col('qty')),amount:agg.sum(items.col('amount')),ratio:agg.sum(items.col('ratio'))}};
    await check('ordinary groups preserve NULL keys and all-NULL argument groups',()=>r.compileGroupBy(grouped),async()=>{
      assert.deepEqual(await r.groupBy(grouped),[{rootId:null,rows:1,qty:9n,amount:7n,ratio:10},{rootId:1,rows:2,qty:1n,amount:2n*MAX,ratio:4},
        {rootId:2,rows:1,qty:3n,amount:-1n,ratio:4},{rootId:3,rows:1,qty:null,amount:null,ratio:null}]);
    });
    const page={...grouped,orderBy:[{field:'amount',direction:'desc'}],limit:2,offset:1};
    await check('group ordering uses exact integer sums and explicit limit/offset',()=>r.compileGroupBy(page),async()=>{
      assert.deepEqual((await r.groupBy(page)).map(row=>row.rootId),[null,2]);assert.deepEqual(await r.groupBy({...page,limit:0}),[]);
    });
    const related={roots:agg.count(),tiers:agg.sum(roots.col('tier')),items:agg.related(rel,agg.count()),qtyN:agg.related(rel,agg.count(items.col('qty'))),qty:agg.related(rel,agg.sum(items.col('qty'))),
      amount:agg.related(rel,agg.sum(items.col('amount'))),ratio:agg.related(rel,agg.sum(items.col('ratio'))),avg:agg.related(rel,agg.avg(items.col('qty'))),realAvg:agg.related(rel,agg.avg(items.col('ratio'))),
      low:agg.related(rel,agg.min(items.col('label'))),high:agg.related(rel,agg.max(items.col('amount'))),refund:agg.related(refundRel,agg.sum(refunds.col('amount'))),links:agg.related(rel,agg.related(linkRel,agg.count()))};
    await check('root related summaries avoid independent-selector fanout and use leaf-weighted integer/real AVG',()=>p.compileAggregate({select:related}),async()=>{
      assert.deepEqual(await p.aggregate({select:related}),{roots:4,tiers:10n,items:4,qtyN:3,qty:4n,amount:2n*MAX-1n,ratio:8,avg:4/3,realAvg:8/3,low:'A',high:MAX,refund:12n,links:3});
    });
    const groupedRelated={by:['category'],select:related};
    await check('grouped related summaries preserve NULL keys, empty domains and leaf-weighted real AVG',()=>p.compileGroupBy(groupedRelated),async()=>{
      assert.deepEqual(await p.groupBy(groupedRelated),[
        {category:null,roots:1,tiers:3n,items:1,qtyN:0,qty:null,amount:null,ratio:null,avg:null,realAvg:null,low:null,high:null,refund:null,links:0},
        {category:'A',roots:2,tiers:3n,items:3,qtyN:3,qty:4n,amount:2n*MAX-1n,ratio:8,avg:4/3,realAvg:8/3,low:'A',high:MAX,refund:12n,links:3},
        {category:'B',roots:1,tiers:4n,items:0,qtyN:0,qty:null,amount:null,ratio:null,avg:null,realAvg:null,low:null,high:null,refund:null,links:0}]);
    });
    const projection={n:agg.related(rel,agg.count()),qty:agg.related(rel,agg.sum(items.col('qty'))),amount:agg.related(rel,agg.sum(items.col('amount'))),ratio:agg.related(rel,agg.sum(items.col('ratio'))),
      avg:agg.related(rel,agg.avg(items.col('qty'))),realAvg:agg.related(rel,agg.avg(items.col('ratio'))),low:agg.related(rel,agg.min(items.col('label'))),refund:agg.related(refundRel,agg.sum(refunds.col('amount'))),links:agg.related(rel,agg.related(linkRel,agg.count()))};
    const projected={select:['id','category'],orderBy:[asc(roots.col('id'))],aggregates:projection};
    await check('per-row related projections preserve selected fields and independent/empty domains',()=>p.compileSelect(projected),async()=>{
      assert.deepEqual(await p.findMany(projected),[
        {id:1,category:'A',n:2,qty:1n,amount:2n*MAX,ratio:4,avg:.5,realAvg:2,low:'A',refund:7n,links:2},
        {id:2,category:'A',n:1,qty:3n,amount:-1n,ratio:4,avg:3,realAvg:4,low:'c',refund:5n,links:1},
        {id:3,category:null,n:1,qty:null,amount:null,ratio:null,avg:null,realAvg:null,low:null,refund:null,links:0},
        {id:4,category:'B',n:0,qty:null,amount:null,ratio:null,avg:null,realAvg:null,low:null,refund:null,links:0}]);
    });
    const first={select:['category'],where:eq(roots.col('id'),2),aggregates:projection};
    await check('findFirst omits its hidden root correlation key',()=>p.compileSelect({...first,limit:1}),async()=>{
      assert.deepEqual(await p.findFirst(first),{category:'A',n:1,qty:3n,amount:-1n,ratio:4,avg:3,realAvg:4,low:'c',refund:5n,links:1});
    });
    await check('empty filtered roots produce related0/NULL, zero groups and zero projected rows',()=>p.compileAggregate({select:related,where:gt(roots.col('id'),1000)}),async()=>{
      assert.deepEqual(await p.aggregate({select:related,where:gt(roots.col('id'),1000)}),{roots:0,tiers:null,items:0,qtyN:0,qty:null,amount:null,ratio:null,avg:null,realAvg:null,low:null,high:null,refund:null,links:0});
      assert.deepEqual(await p.groupBy({...groupedRelated,where:gt(roots.col('id'),1000)}),[]);assert.deepEqual(await p.findMany({...projected,where:gt(roots.col('id'),1000)}),[]);
    });
    const filteredItems=hasMany(items,{localKey:roots.col('id'),foreignKey:items.col('rootId'),where:gt(items.col('qty'),1)});
    const filteredLinks=hasMany(links,{localKey:items.col('id'),foreignKey:links.col('itemId'),where:gt(links.col('weight'),1)});
    const scoped={n:agg.related(filteredItems,agg.count()),weight:agg.related(filteredItems,agg.related(filteredLinks,agg.sum(links.col('weight'))))};
    await check('scoped filters apply independently at each related hop and combine with the root WHERE',()=>p.compileAggregate({select:scoped,where:eq(roots.col('category'),'A')}),async()=>{
      assert.deepEqual(await p.aggregate({select:scoped,where:eq(roots.col('category'),'A')}),{n:2,weight:5n});
      assert.deepEqual(await p.findFirst({select:['category'],where:eq(roots.col('id'),1),aggregates:scoped}),{category:'A',n:1,weight:2n});
      // Sharing must distinguish two filters on the same table, even when keys and selected columns are identical.
      const aboveTwo=hasMany(items,{localKey:roots.col('id'),foreignKey:items.col('rootId'),where:gt(items.col('qty'),2)});
      const separate={aboveOne:agg.related(filteredItems,agg.count()),aboveTwo:agg.related(aboveTwo,agg.count()),
        sumOne:agg.related(filteredItems,agg.sum(items.col('qty'))),sumTwo:agg.related(aboveTwo,agg.sum(items.col('qty')))};
      assert.deepEqual(await p.aggregate({select:separate}),{aboveOne:2,aboveTwo:1,sumOne:5n,sumTwo:3n});
      assert.deepEqual(await p.groupBy({by:['category'],select:separate}),[
        {category:null,aboveOne:0,aboveTwo:0,sumOne:null,sumTwo:null},
        {category:'A',aboveOne:2,aboveTwo:1,sumOne:5n,sumTwo:3n},
        {category:'B',aboveOne:0,aboveTwo:0,sumOne:null,sumTwo:null}]);
      assert.deepEqual(await p.findMany({select:['id'],orderBy:[asc(roots.col('id'))],aggregates:separate}),[
        {id:1,aboveOne:1,aboveTwo:0,sumOne:2n,sumTwo:null},{id:2,aboveOne:1,aboveTwo:1,sumOne:3n,sumTwo:3n},
        {id:3,aboveOne:0,aboveTwo:0,sumOne:null,sumTwo:null},{id:4,aboveOne:0,aboveTwo:0,sumOne:null,sumTwo:null}]);
    });
    const deepest=selector=>agg.related(rel,agg.related(linkRel,agg.related(atomRel,agg.related(dustRel,selector))));
    const deep={n:deepest(agg.count()),weight:deepest(agg.sum(dust.col('weight'))),mean:deepest(agg.avg(dust.col('weight')))};
    await check('depth4 paths work for root, grouped and per-row count/sum/AVG',()=>p.compileAggregate({select:deep}),async()=>{
      assert.deepEqual(await p.aggregate({select:deep}),{n:4,weight:113n,mean:28.25});
      assert.deepEqual(await p.groupBy({by:['category'],select:deep}),[{category:null,n:0,weight:null,mean:null},{category:'A',n:4,weight:113n,mean:28.25},{category:'B',n:0,weight:null,mean:null}]);
      assert.deepEqual(await p.findMany({select:['id'],orderBy:[asc(roots.col('id'))],aggregates:deep}),[
        {id:1,n:3,weight:13n,mean:13/3},{id:2,n:1,weight:100n,mean:100},{id:3,n:0,weight:null,mean:null},{id:4,n:0,weight:null,mean:null}]);
    });
    if(postgres)await check('caught decoded guard DATA preserves a healthy transaction and its prior write can commit',()=>r.compileAggregate({select:{n:agg.count(items.col('qty'))}}),async()=>{
      // This physical int8 is valid PostgreSQL storage but exceeds the mapped safe-integer contract.
      await query('UPDATE '+quote(schema)+'."agg_items" SET "qty"=$1::pg_catalog.int8 WHERE "id"=$2::pg_catalog.int8',['9007199254740992','11']);
      try{
        await db.transaction(async tx=>{
          await tx.table(roots).insert({id:901,category:'Handled guard marker',tier:9});
          await assert.rejects(tx.table(items).aggregate({select:{n:agg.count(items.col('qty'))}}),code('DATA'));
          await assert.rejects(tx.table(items).aggregate({select:{low:agg.min(items.col('qty'))}}),code('DATA'));
          assert.equal(await tx.table(roots).count(),5);
        });
        assert.equal(await p.count(eq(roots.col('id'),901)),1);
        await p.delete({where:eq(roots.col('id'),901),maxRows:1});
      }finally{await query('UPDATE '+quote(schema)+'."agg_items" SET "qty"=$1::pg_catalog.int8 WHERE "id"=$2::pg_catalog.int8',['2','11']);}
      assert.equal(await p.count(),4);
    });
    const numericSelect={total:agg.sum(numbers.col('value')),mean:agg.avg(numbers.col('value')),n:agg.count(numbers.col('value'))};
    const resetNumbers=async values=>{
      await numeric.delete({where:gte(numbers.col('id'),0),maxRows:20});
      await numeric.insertMany(values.map((value,index)=>({id:index+1,rootId:1,bucket:'sample',value})));
    };
    await check('large opposite real values cancel to a finite zero mean across root/group/related/projected shapes',null,async()=>{
      await resetNumbers([1e154,-1e154]);assert.deepEqual(await numeric.aggregate({select:numericSelect}),{total:0,mean:0,n:2});
      assert.deepEqual(await numeric.groupBy({by:['bucket'],select:numericSelect}),[{bucket:'sample',total:0,mean:0,n:2}]);
      const mean={mean:agg.related(numberRel,agg.avg(numbers.col('value')))};
      assert.deepEqual(await p.aggregate({select:mean}),{mean:0});assert.deepEqual(await p.findFirst({select:['id'],where:eq(roots.col('id'),1),aggregates:mean}),{id:1,mean:0});
    });
    await check('MIN_VALUE mean handles positive/negative underflow and ties-to-even without native division failure',null,async()=>{
      for(const [input,wanted]of [[[Number.MIN_VALUE,0],0],[[-Number.MIN_VALUE,0],-0],[[Number.MIN_VALUE,2*Number.MIN_VALUE],2*Number.MIN_VALUE],[[-Number.MIN_VALUE,-2*Number.MIN_VALUE],-2*Number.MIN_VALUE]]){
        await resetNumbers(input);assert.ok(Object.is((await numeric.aggregate({select:{mean:agg.avg(numbers.col('value'))}})).mean,wanted));
        assert.ok(Object.is((await numeric.groupBy({by:['bucket'],select:{mean:agg.avg(numbers.col('value'))}}))[0].mean,wanted));
        assert.ok(Object.is((await p.findFirst({select:['id'],where:eq(roots.col('id'),1),aggregates:{mean:agg.related(numberRel,agg.avg(numbers.col('value')))}})).mean,wanted));
      }
    });
    await check('signed zero follows the current SUM/count helper rather than claiming native AVG equivalence',null,async()=>{
      await resetNumbers([-0]);assert.ok(Object.is((await numeric.findFirst()).value,-0));
      const observed=await numeric.aggregate({select:numericSelect});assert.ok(Object.is(observed.total,-0));assert.ok(Object.is(observed.mean,-0));assert.equal(observed.n,1);
      await resetNumbers([-0,0]);const mixed=await numeric.aggregate({select:numericSelect});assert.ok(Object.is(mixed.total,0));assert.ok(Object.is(mixed.mean,0));
    });
    await check('an off-page overflowing group still refuses range, while an explicit safe input filter succeeds',null,async()=>{
      await numeric.delete({where:gte(numbers.col('id'),0),maxRows:20});
      await numeric.insertMany([{id:1,rootId:1,bucket:'A-valid',value:1},{id:2,rootId:1,bucket:'Z-overflow',value:Number.MAX_VALUE},{id:3,rootId:1,bucket:'Z-overflow',value:Number.MAX_VALUE}]);
      const page={by:['bucket'],select:{total:agg.sum(numbers.col('value'))},orderBy:[{field:'bucket',direction:'asc'}],limit:1};
      await assert.rejects(numeric.groupBy(page),code('AGGREGATE_RANGE'));
      assert.deepEqual(await numeric.groupBy({...page,where:eq(numbers.col('bucket'),'A-valid')}),[{bucket:'A-valid',total:1}]);
      assert.equal(await numeric.count(),3);
    });
    await check('finite native real SUM overflow and SUM-based AVG limitation are range refusals with usable autocommit session',null,async()=>{
      await resetNumbers([Number.MAX_VALUE,Number.MAX_VALUE]);
      for(const select of [{total:agg.sum(numbers.col('value'))},{mean:agg.avg(numbers.col('value'))}]){
        await assert.rejects(numeric.aggregate({select}),code('AGGREGATE_RANGE'));assert.equal(await numeric.count(),2);
      }
    });
    await check('caught native range error leaves transaction engine-aborted, COMMIT refuses and prior work rolls back',null,async()=>{
      await assert.rejects(db.transaction(async tx=>{
        await tx.table(roots).insert({id:900,category:'Rollback marker',tier:9});
        await assert.rejects(tx.table(numbers).aggregate({select:{total:agg.sum(numbers.col('value'))}}),code('AGGREGATE_RANGE'));
        await assert.rejects(tx.table(roots).count(),code('DATABASE_ERROR'));
      }),code('TRANSACTION_ABORTED'));
      assert.equal(await p.count(eq(roots.col('id'),900)),0);assert.equal(await p.count(),4);assert.equal(await numeric.count(),2);
    });
    return report;
  }catch(error){failed=true;throw error;}
  finally{
    const errors=[];
    for(const database of [...databases])try{await close(database);}catch{errors.push('close');}
    if(postgres&&schemaCreated)try{await query('DROP SCHEMA '+quote(schema)+' CASCADE');cleanup.schemaDropped=true;}catch{errors.push('schema');}
    if(!failed){assert.equal(cleanup.openedDatabases,cleanup.closedDatabases);if(errors.length)throw new Error('Owned aggregate fixture cleanup failed.');}
  }
}
