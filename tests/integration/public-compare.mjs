// Behavioral comparison on one caller-owned disposable PostgreSQL server. No timing or superiority ranking.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const quote=value=>'"'+value.replaceAll('"','""')+'"';
const MAX=9223372036854775807n,MIN=-9223372036854775808n;
const marker="O'Hara %_\\",document={a:1,tags:['sample']};
const seed=[
  {id:1,label:'Alpha',score:10,active:true,ratio:.5,exact:9007199254740993n,payload:document,note:null,version:1},
  {id:2,label:'Beta',score:20,active:true,ratio:-0,exact:MAX,payload:document,note:'note',version:1},
  {id:3,label:marker,score:30,active:false,ratio:Number.MIN_VALUE,exact:MIN,payload:{a:2,tags:[]},note:null,version:1},
];
function normalized(row){
  assert.ok(typeof row.exact==='bigint'||typeof row.exact==='string','int64 must reach the application without Number rounding');
  return Object.fromEntries(Object.keys(seed[0]).map(key=>[key,key==='exact'?BigInt(row[key]):key==='ratio'&&Object.is(row[key],-0)?0:row[key]]));
}
const ids=rows=>rows.map(row=>Number(row.id)).sort((a,b)=>a-b);
const sameRows=(actual,wanted)=>assert.deepEqual(actual.map(normalized).sort((a,b)=>a.id-b.id),wanted.map(normalized));

/**
 * Supply actual SDK/factory imports from one build, actual pinned reference modules and their verified package versions.
 * Both references must resolve the supplied pg module's copy. Orange changes that copy's global NUMERIC parser;
 * this runner restores the original parser, and its fixture deliberately has no NUMERIC columns.
 * admin.query returns positional raw-text rows. postgresOptions is an explicit direct-field target for the SAME owned
 * disposable PostgreSQL server, with ssl:false. This runner creates three random schemas, closes its own handles and
 * drops those schemas; it never closes admin or owns Docker. The caller must establish fixture ownership first:
 * connection fields alone cannot prove that a server is disposable. Connection strings are deliberately refused.
 */
export async function runPublicComparisonCases({sdk,openPostgresDatabase,postgresOptions,admin,orange,kysely,pg,versions}){
  assert.deepEqual(versions,{orange:'5.5.1',kysely:'0.29.8',pg:'8.23.1'});
  assert.equal(typeof admin?.query,'function');assert.equal(typeof openPostgresDatabase,'function');
  assert.equal(postgresOptions?.connectionString,undefined);assert.equal(postgresOptions?.ssl,false);
  for(const key of ['host','user','database'])assert.equal(typeof postgresOptions[key],'string');
  const token=randomBytes(6).toString('hex'),schemas=['rs','orange','kysely'].map(name=>'rs_compare_'+name+'_'+token);
  const numericParser=pg.types.getTypeParser(1700,'text');
  const cases=[],tools=[],created=[];
  const cleanup={openedHandles:0,closedHandles:0,schemasDropped:0};
  const report={format:'rowstitch-public-postgres-comparison',versions,cases,cleanup,limits:[
    'One fixed fictional dataset on the same PostgreSQL engine; no latency, AI-usage or universal superiority claim.',
    'Separate schemas/connections, equivalent native constraints and explicit UTF8/extra_float_digits=3 settings; no concurrency workload.',
    'Kysely is a SQL query builder: its guard/version recipes are application code, not assumed ORM capabilities.',
    'Orange tracked-row conflict semantics differ from Rowstitch explicit version tokens. The tested conflict overlaps a changed field.',
    'Native JSONB structural equality is compared; text-JSON equality, richer relations, migrations and other databases are outside this sample.',
    'Reference default pg int8 strings and Rowstitch bigint values are normalized losslessly; raw JavaScript representations are reported.',
  ]};
  const native=async(sql,parameters=[])=>admin.query(sql,parameters);
  const server=(await native("SELECT current_setting('server_version'),current_setting('server_encoding')")).rows;
  assert.equal(server.length,1);assert.equal(server[0][1],'UTF8');report.server={version:server[0][0],encoding:server[0][1]};
  const settings="-c extra_float_digits=3 -c client_encoding=UTF8 -c statement_timeout=5000 -c lock_timeout=2000";
  async function check(tool,name,fn,unsupported){
    try{cases.push({tool:tool.name,name,status:'pass',...await fn()});}
    catch(error){cases.push({tool:tool.name,name,status:unsupported&&error?.code===unsupported?'unsupported':'fail',code:typeof error?.code==='string'?error.code:null,
      detail:unsupported&&error?.code===unsupported?'Public API refuses this native feature explicitly.':String(error?.message).replaceAll(postgresOptions.password??'\0','<password>').slice(0,350)});}
  }
  try{
    for(const schema of schemas){
      await native('CREATE SCHEMA '+quote(schema));created.push(schema);
      await native('REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');
      await native('CREATE TABLE '+quote(schema)+'.items(id int4 PRIMARY KEY,label text NOT NULL UNIQUE,score int4 NOT NULL,active bool NOT NULL,ratio float8 NOT NULL,exact int8 NOT NULL,payload jsonb NOT NULL,note text,version int4 NOT NULL DEFAULT 1)');
    }
    const {column,defineTable,eq,gte,and,inArray,isNull,contains,asc,agg}=sdk;
    const table=defineTable('items',{id:column.integer().primaryKey(),label:column.text().unique(),score:column.integer(),active:column.boolean(),ratio:column.real(),
      exact:column.bigint(),payload:column.json(),note:column.text().nullable(),version:column.integer().default(1)},{version:'version'});
    const rowDb=await openPostgresDatabase({...postgresOptions,statementTimeoutMs:5000,lockTimeoutMs:2000,tables:[table],schema:schemas[0]});cleanup.openedHandles++;
    const repository=rowDb.table(table),predicate=kind=>kind==='combined'?and(gte(table.col('score'),20),eq(table.col('active'),true)):
      kind==='null'?isNull(table.col('note')):kind==='empty'?inArray(table.col('id'),[]):kind==='literal'?contains(table.col('label'),'%_'):
      kind==='json'?eq(table.col('payload'),{tags:['sample'],a:1}):kind==='injection'?eq(table.col('label'),"' OR 1=1 --"):eq(table.col('active'),true);
    tools.push({name:'rowstitch',close:()=>rowDb.close(),insert:row=>repository.insert(row),all:()=>repository.findMany({orderBy:[asc(table.col('id'))]}),
      filtered:kind=>repository.findMany({where:predicate(kind),orderBy:[asc(table.col('id'))]}),count:()=>repository.count(),
      change:async id=>(await repository.update({label:'Changed'},{where:eq(table.col('id'),id),maxRows:1}))[0],remove:id=>repository.delete({where:eq(table.col('id'),id),maxRows:1}),
      rollback:marker=>rowDb.transaction(async tx=>{await tx.table(table).insert({...seed[0],id:10,label:'Rollback'});throw marker;}),
      guard:()=>repository.update({note:'guard changed'},{where:eq(table.col('active'),true),maxRows:1}),guardCode:'AFFECTED_ROWS',guardKind:'built-in maxRows',
      version:async()=>{await repository.updateVersion({id:20},1,{label:'Winner'});await assert.rejects(repository.updateVersion({id:20},1,{label:'Loser'}),e=>e?.code==='CONFLICT');},
      versionKind:'built-in explicit version token',aggregate:async()=>BigInt((await repository.aggregate({select:{total:agg.sum(table.col('score'))}})).total)});

    const uri=new URL('postgres://localhost');uri.hostname=postgresOptions.host;uri.port=String(postgresOptions.port??5432);uri.username=postgresOptions.user;
    uri.password=postgresOptions.password??'';uri.pathname='/'+postgresOptions.database;uri.searchParams.set('sslmode','disable');uri.searchParams.set('search_path',schemas[1]);uri.searchParams.set('options',settings);
    const map=orange.map(x=>({items:x.table('items').map(({column:c})=>({id:c('id').numeric().primary(),label:c('label').string().notNull(),score:c('score').numeric().notNull(),
      active:c('active').boolean().notNull(),ratio:c('ratio').numeric().notNull(),exact:c('exact').bigint().notNull(),payload:c('payload').json().notNull(),note:c('note').string(),version:c('version').numeric().notNull()}))}));
    const orangeDb=map.postgres(uri.href,{size:1,min:0});cleanup.openedHandles++;
    const orangeWhere=kind=>x=>kind==='combined'?x.score.greaterThanOrEqual(20).and(x.active.eq(true)):kind==='null'?x.note.eq(null):kind==='empty'?x.id.in([]):
      kind==='literal'?x.label.contains('%_'):kind==='json'?x.payload.eq({tags:['sample'],a:1}):kind==='injection'?x.label.eq("' OR 1=1 --"):x.active.eq(true);
    tools.push({name:'orange-orm@5.5.1',close:()=>orangeDb.close(),insert:row=>orangeDb.items.insert({...row,exact:row.exact.toString()}),all:()=>orangeDb.items.getMany({orderBy:'id'}),
      filtered:kind=>orangeDb.items.getMany({where:orangeWhere(kind),orderBy:'id'}),count:()=>orangeDb.items.count(),
      literalRecipe:()=>orangeDb.items.getMany({where:x=>x.label.contains('\\%\\_'),orderBy:'id'}),
      change:async id=>{const row=await orangeDb.items.getById(id);row.label='Changed';await row.saveChanges();return row;},remove:async id=>(await orangeDb.items.getById(id)).delete(),
      rollback:marker=>orangeDb.transaction(async tx=>{await tx.items.insert({...seed[0],id:10,label:'Rollback',exact:seed[0].exact.toString()});throw marker;}),
      guard:()=>orangeDb.transaction(async tx=>{const found=await tx.items.getMany({where:x=>x.active.eq(true)});if(found.length>1)throw Object.assign(new Error('Application cardinality guard'),{code:'APP_GUARD'});
        for(const row of found){row.note='guard changed';await row.saveChanges();}}),guardCode:'APP_GUARD',guardKind:'application-authored transactional cardinality check; no concurrent-write claim',
      version:async()=>{const first=await orangeDb.items.getById(20),stale=await orangeDb.items.getById(20);first.label='Winner';first.version=2;await first.saveChanges();
        stale.label='Loser';stale.version=2;await assert.rejects(stale.saveChanges());},versionKind:'built-in tracked-row overlapping-change conflict; application changes version field',
      aggregate:async()=>BigInt((await orangeDb.items.aggregate({total:x=>x.sum(x=>x.score)}))[0].total)});

    const pool=new pg.Pool({...postgresOptions,max:1,options:settings+' -c search_path='+schemas[2]});
    const kdb=new kysely.Kysely({dialect:new kysely.PostgresDialect({pool})});cleanup.openedHandles++;
    const kWhere=(query,kind)=>kind==='combined'?query.where('score','>=',20).where('active','=',true):kind==='null'?query.where('note','is',null):kind==='empty'?query.where('id','in',[]):
      kind==='literal'?query.where(kysely.sql`strpos(label, ${'%_'})`,'>',0):kind==='json'?query.where('payload','=',JSON.stringify({tags:['sample'],a:1})):
      kind==='injection'?query.where('label','=',"' OR 1=1 --"):query.where('active','=',true);
    const kValues=row=>({...row,exact:row.exact.toString()});
    tools.push({name:'kysely@0.29.8',close:()=>kdb.destroy(),insert:row=>kdb.insertInto('items').values(kValues(row)).returningAll().executeTakeFirstOrThrow(),
      all:()=>kdb.selectFrom('items').selectAll().orderBy('id').execute(),filtered:kind=>kWhere(kdb.selectFrom('items').selectAll(),kind).orderBy('id').execute(),
      emptyRecipe:()=>kdb.selectFrom('items').selectAll().where(kysely.sql`false`).execute(),
      count:async()=>(await kdb.selectFrom('items').select(eb=>eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n,
      change:id=>kdb.updateTable('items').set({label:'Changed'}).where('id','=',id).returningAll().executeTakeFirstOrThrow(),remove:id=>kdb.deleteFrom('items').where('id','=',id).execute(),
      rollback:marker=>kdb.transaction().execute(async tx=>{await tx.insertInto('items').values(kValues({...seed[0],id:10,label:'Rollback'})).execute();throw marker;}),
      guard:()=>kdb.transaction().setIsolationLevel('serializable').execute(async tx=>{const n=await tx.selectFrom('items').select(eb=>eb.fn.countAll().as('n')).where('active','=',true).executeTakeFirstOrThrow();
        if(BigInt(n.n)>1n)throw Object.assign(new Error('Application cardinality guard'),{code:'APP_GUARD'});await tx.updateTable('items').set({note:'guard changed'}).where('active','=',true).execute();}),
      guardCode:'APP_GUARD',guardKind:'application-authored SERIALIZABLE count/write recipe; no concurrent-write workload',
      version:async()=>{const first=await kdb.updateTable('items').set({label:'Winner',version:2}).where('id','=',20).where('version','=',1).executeTakeFirstOrThrow();
        const stale=await kdb.updateTable('items').set({label:'Loser',version:2}).where('id','=',20).where('version','=',1).executeTakeFirstOrThrow();assert.equal(first.numUpdatedRows,1n);assert.equal(stale.numUpdatedRows,0n);},
      versionKind:'application-authored version predicate and affected-row interpretation',aggregate:async()=>BigInt((await kdb.selectFrom('items').select(eb=>eb.fn.sum('score').as('total')).executeTakeFirstOrThrow()).total)});

    for(let index=0;index<tools.length;index++){
      const tool=tools[index],schema=schemas[index];
      await check(tool,'scalar insert/read/count: JSON, booleans, null, signed zero, subnormal and exact int64',async()=>{
        for(const row of seed)await tool.insert(row);const rows=await tool.all();sameRows(rows,seed);assert.equal(BigInt(await tool.count()),3n);
        return {rows:3,representations:{int64:typeof rows[0].exact,count:typeof await tool.count(),json:typeof rows[0].payload}};
      });
      await check(tool,'signed zero: raw representation and physical native value are disclosed',async()=>{
        const row=(await tool.all()).find(row=>row.id===2),bits=(await native('SELECT encode(float8send(ratio),\'hex\') FROM '+quote(schema)+'.items WHERE id=2')).rows[0][0];
        assert.equal(bits,Object.is(row.ratio,-0)?'8000000000000000':'0000000000000000');
        return {negativeZeroPreserved:Object.is(row.ratio,-0),nativeBits:bits,note:'The common numeric roundtrip treats signed zeros as equal; this separate observation preserves the distinction.'};
      });
      for(const [kind,wanted]of[['combined',[2]],['null',[1,3]],['empty',[]],['literal',[3]],['json',[1,2]],['injection',[]]])
        await check(tool,'filter '+kind,async()=>{
          if(kind==='empty'&&tool.emptyRecipe){
            await assert.rejects(tool.filtered(kind),error=>error?.code==='42601');assert.deepEqual(ids(await tool.emptyRecipe()),[]);
            return {status:'difference',defaultSqlstate:'42601',recipeMatchedIds:[],semantics:'Kysely passes the empty IN list through to SQL; an application false-predicate recipe returns no rows.'};
          }
          const observed=ids(await tool.filtered(kind));
          if(kind==='literal'&&tool.literalRecipe){
            assert.deepEqual(observed,[1,2,3]);assert.deepEqual(ids(await tool.literalRecipe()),wanted);
            return {status:'difference',defaultMatchedIds:observed,recipeMatchedIds:wanted,semantics:'Orange contains exposes PostgreSQL LIKE wildcards; caller backslash escaping makes these characters literal.'};
          }
          assert.deepEqual(observed,wanted);return {matchedIds:wanted};
        });
      await check(tool,'update and delete affect only the selected fictional row',async()=>{await tool.insert({...seed[0],id:9,label:'Temporary'});assert.equal((await tool.change(9)).label,'Changed');await tool.remove(9);assert.equal(BigInt(await tool.count()),3n);});
      await check(tool,'native UNIQUE violation leaves the stored fixture intact',async()=>{await assert.rejects(tool.insert({...seed[0],id:99,label:'Alpha'}));assert.equal(BigInt(await tool.count()),3n);});
      await check(tool,'callback failure rolls back a completed insert',async()=>{const failure=new Error('Fictional rollback');await assert.rejects(tool.rollback(failure));assert.equal(BigInt(await tool.count()),3n);});
      await check(tool,'refused cardinality guard leaves both matching rows unchanged',async()=>{await assert.rejects(tool.guard(),e=>e?.code===tool.guardCode);
        assert.deepEqual((await native('SELECT note FROM '+quote(schema)+'.items WHERE active ORDER BY id')).rows,[[null],['note']]);return {semantics:tool.guardKind};});
      await check(tool,'stale update preserves the winning write',async()=>{await tool.insert({...seed[0],id:20,label:'Versioned'});await tool.version();
        assert.deepEqual((await native('SELECT label,version::text FROM '+quote(schema)+'.items WHERE id=20')).rows,[['Winner','2']]);await tool.remove(20);return {semantics:tool.versionKind};});
      await check(tool,'root sum aggregate',async()=>{assert.equal(await tool.aggregate(),60n);});
    }
  }finally{
    let cleanupFailed=false;
    for(const tool of [...tools].reverse()){try{await tool.close();cleanup.closedHandles++;}catch{cleanupFailed=true;}}
    for(const schema of [...created].reverse()){try{await native('DROP SCHEMA '+quote(schema)+' CASCADE');
      assert.deepEqual((await native('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1::text',[schema])).rows,[]);cleanup.schemasDropped++;
    }catch{cleanupFailed=true;}}
    pg.types.setTypeParser(1700,'text',numericParser);
    if(cleanupFailed)throw new Error('Owned comparison cleanup did not complete.');
  }
  report.summary={pass:cases.filter(x=>x.status==='pass').length,difference:cases.filter(x=>x.status==='difference').length,fail:cases.filter(x=>x.status==='fail').length,unsupported:cases.filter(x=>x.status==='unsupported').length};
  return report;
}
