// Fixed native operator-shadow regression. No server, driver or SDK imports: the owned-engine harness supplies them.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const quote=value=>'"'+value.replaceAll('"','""')+'"';

function selectSnapshot(raw) {
  assert.ok(Array.isArray(raw.rows));
  for(const row of raw.rows)assert.ok(Array.isArray(row)&&row.every(value=>value===null||typeof value==='string'),'Supply positional raw-text rows');
  let count;
  if(typeof raw.commandTag==='string') { assert.match(raw.commandTag,/^SELECT [0-9]+$/);count=BigInt(raw.commandTag.slice(7)); }
  else { assert.equal(raw.command,'SELECT');assert.ok(typeof raw.rowCount==='bigint'||Number.isSafeInteger(raw.rowCount));count=BigInt(raw.rowCount); }
  assert.equal(count,BigInt(raw.rows.length));
  const fields=raw.fields.map(field=>{let typeOid=field.typeOid??field.dataTypeID;if(typeOid<0)typeOid+=2**32;return{name:field.name,typeOid};});
  return{fields,rows:raw.rows,command:'SELECT',rowCount:count};
}

/**
 * Run ONLY on a caller-owned disposable database. The caller establishes engine ownership and supplies one exclusively
 * leased administrative transport. query(sql, values) must return positional text/null rows, fields and either exact
 * protocol commandTag/typeOid metadata or actual pg command/rowCount/dataTypeID metadata. Values stay bound.
 * sdk, RepositoryCore and createPostgresDialect must come from the SAME build (genuine table identity matters).
 * This function owns only its random schemas/functions/operators/collation, restores the captured search_path, and
 * never opens/closes the client, installs dependencies, owns Docker or accesses another application's database.
 * Core/dialect execution is tested directly; this is not an AsyncSession, RLS or universal security claim.
 */
export async function runAggregateOperatorCases({engine:name,sdk,RepositoryCore,createPostgresDialect,admin:t}){
  assert.ok(name === 'pglite' || name === 'postgresql');
  assert.equal(typeof t?.query,'function');
  assert.equal(typeof RepositoryCore,'function');
  assert.equal(typeof createPostgresDialect,'function');
  const {column,defineTable,agg,hasMany,eq,between,inArray,asc}=sdk;
  const engine={format:'rowstitch-native-aggregate-operator-cases',engine:name,cases:[],failures:[],cleanup:{createdSchemas:0,droppedSchemas:0,searchPathRestored:false}};const query=(sql,values=[])=>t.query(sql,values);
  const token=randomBytes(5).toString('hex'),data='rs_m15_data_'+token,shadow='rs_m15_ops_'+token,d=quote(data),s=quote(shadow);
  engine.version=(await query('SELECT pg_catalog.version()')).rows[0][0];
  const originalSearchPath=(await query('SHOW search_path')).rows[0][0];
  assert.equal(typeof originalSearchPath,'string'); const created=[];
  const roots=defineTable('shadow_roots',{id:column.integer().primaryKey(),key:column.text().nullable(),grp:column.text().nullable(),qty:column.integer()});
  const children=defineTable('shadow_children',{id:column.integer().primaryKey(),rootKey:column.text().nullable(),value:column.integer()});
  const wrong=defineTable('shadow_wrong',{id:column.integer().primaryKey(),value:column.integer().nullable()});
  const reals=defineTable('shadow_reals',{id:column.integer().primaryKey(),value:column.real()});
  const relation=hasMany(children,{localKey:roots.col('key'),foreignKey:children.col('rootKey')});
  const tables=new Map([roots,children,wrong,reals].map(table=>[table.name,table]));
  const dialect=createPostgresDialect({schema:data});
  const ctx={check(){},writeCheck(){throw new Error('Read-only private CoreContext');},mapped(table){assert.equal(tables.get(table.name),table);},tables,dialect};
  const parent=new RepositoryCore(ctx,roots),wrongRepo=new RepositoryCore(ctx,wrong),realRepo=new RepositoryCore(ctx,reals);
  let active;
  async function drive(work){
    let step=work.next();
    while(!step.done){const input=step.value;active.queries.push({sql:input.sql,parameters:input.parameters});
      const raw=await query(input.sql,input.parameters);const value=selectSnapshot(raw);
      step=work.next(input.decode(value));}
    return step.value;
  }
  const aggregate=(repo,options)=>drive(repo.aggregateWork(repo.aggregatePlan(options)));
  const group=(options)=>drive(parent.groupWork(parent.groupPlan(options)));
  async function check(label,fn){active={label,queries:[]};try{active.observed=await fn();engine.cases.push(active);}catch(error){engine.failures.push({...active,code:error?.code,message:String(error?.message).slice(0,1000)});}finally{active=null;}}
  const summary={n:agg.count(),qty:agg.sum(roots.col('qty')),children:agg.related(relation,agg.count()),total:agg.related(relation,agg.sum(children.col('value')))};
  try{
    await query('CREATE SCHEMA '+d);created.push(data);engine.cleanup.createdSchemas++;
    await query('CREATE SCHEMA '+s);created.push(shadow);engine.cleanup.createdSchemas++;
    await query('CREATE TABLE '+d+'.shadow_roots(id int8 PRIMARY KEY,key text,grp text,qty int8 NOT NULL)');
    await query('CREATE TABLE '+d+'.shadow_children(id int8 PRIMARY KEY,"rootKey" text,value int8 NOT NULL)');
    await query('CREATE TABLE '+d+'.shadow_wrong(id int8 PRIMARY KEY,value uuid)');
    await query('CREATE TABLE '+d+'.shadow_reals(id int8 PRIMARY KEY,value float8 NOT NULL)');
    await query('INSERT INTO '+d+'.shadow_roots VALUES(1,\'A\',\'G\',2),(2,\'B\',\'G\',3),(3,NULL,NULL,4),(4,\'C\',\'H\',5)');
    await query('INSERT INTO '+d+'.shadow_children VALUES(11,\'A\',10),(12,\'A\',20),(21,\'B\',30),(31,NULL,999)');
    await query('INSERT INTO '+d+'.shadow_wrong VALUES(1,NULL)');
    await query('INSERT INTO '+d+'.shadow_reals VALUES(1,$1::float8),(2,$2::float8)',[String(-Number.MIN_VALUE),String(-2*Number.MIN_VALUE)]);
    const operators=[['eq_i4','int4','=','FALSE'],['eq_oid','oid','=','FALSE'],['eq_i8','int8','=','FALSE'],['ge_i8','int8','>=','TRUE'],['le_i8','int8','<=','TRUE'],['eq_text','text','=','FALSE']];
    for(const [fn,type,operator,value]of operators){await query('CREATE FUNCTION '+s+'.'+quote(fn)+'(pg_catalog.'+type+',pg_catalog.'+type+') RETURNS pg_catalog.bool LANGUAGE SQL IMMUTABLE STRICT AS $$SELECT '+value+'$$');
      await query('CREATE OPERATOR '+s+'.'+operator+' (FUNCTION='+s+'.'+quote(fn)+',LEFTARG=pg_catalog.'+type+',RIGHTARG=pg_catalog.'+type+')');}
    await query('CREATE FUNCTION '+s+'.neg_i8(pg_catalog.int8) RETURNS pg_catalog.int8 LANGUAGE SQL IMMUTABLE STRICT AS $$SELECT 7::pg_catalog.int8$$');
    await query('CREATE OPERATOR '+s+'.- (FUNCTION='+s+'.neg_i8,RIGHTARG=pg_catalog.int8)');
    await query('SET search_path='+s+',pg_catalog');
    await check('negative control: unqualified equality/IN/BETWEEN route to shadow functions',async()=>{
      const raw=await query('SELECT 1::int4 = 1::int4,20::oid IN(20::oid,21::oid),1::int8 = 1::int8,9007199254740992::int8 BETWEEN -9007199254740991::int8 AND 9007199254740991::int8,\'G\'::text = \'G\'::text,\'G\'::text IS NOT DISTINCT FROM \'G\'::text,NULL::text IS NOT DISTINCT FROM NULL::text,(-1::int8)::text');
      assert.deepEqual(raw.rows[0].slice(0,5),['f','f','f','t','f']);assert.equal(raw.rows[0][6],'t');assert.equal(raw.rows[0][7],'7');return{raw:raw.rows,oldNonNullIsNotDistinct:raw.rows[0][5],oldUnaryMinus:raw.rows[0][7]};
    });
    await check('positive control: qualified operators retain builtin semantics',async()=>{
      const raw=await query('SELECT 1::int4 OPERATOR(pg_catalog.=) 1::int4,20::oid OPERATOR(pg_catalog.=) ANY(ARRAY[20,21]::oid[]),1::int8 OPERATOR(pg_catalog.=) 1::int8,9007199254740992::int8 OPERATOR(pg_catalog.<=) 9007199254740991::int8,\'G\'::text OPERATOR(pg_catalog.=) \'G\'::text');
      assert.deepEqual(raw.rows,[['t','t','t','f','t']]);return raw.rows;
    });
    await check('real compiled root aggregate preserves OID family and guard branches under shadowing',async()=>{const value=await aggregate(parent,{select:summary});assert.deepEqual(value,{n:4,qty:14n,children:3,total:60n});return value;});
    await check('real compiled IN and BETWEEN predicates preserve bound domain',async()=>{
      const first=await aggregate(parent,{select:{n:agg.count(),qty:agg.sum(roots.col('qty'))},where:between(roots.col('qty'),2,4)});
      const second=await aggregate(parent,{select:{n:agg.count(),qty:agg.sum(roots.col('qty'))},where:inArray(roots.col('qty'),[2,4])});
      assert.deepEqual(first,{n:3,qty:9n});assert.deepEqual(second,{n:2,qty:6n});return{between:first,inArray:second};
    });
    await check('real grouped text correlation uses qualified equality and preserves NULL group',async()=>{
      const value=await group({by:['grp'],select:summary});assert.deepEqual(value,[{grp:null,n:1,qty:4n,children:0,total:null},{grp:'G',n:2,qty:5n,children:3,total:60n},{grp:'H',n:1,qty:5n,children:0,total:null}]);return value;
    });
    await check('real projected related join ignores shadow equality and keeps empty domains',async()=>{
      const value=await drive(parent.findMany({select:['id','grp'],orderBy:[asc(roots.col('id'))],aggregates:{n:agg.related(relation,agg.count()),total:agg.related(relation,agg.sum(children.col('value')))}}));
      assert.deepEqual(value,[{id:1,grp:'G',n:2,total:30n},{id:2,grp:'G',n:1,total:30n},{id:3,grp:null,n:0,total:null},{id:4,grp:'H',n:0,total:null}]);return value;
    });
    await check('bound negative safe-integer limit resists shadow unary minus in the generated lower bound',async()=>{
      await query('UPDATE '+d+'.shadow_roots SET qty=$1::int8 WHERE id OPERATOR(pg_catalog.=) 4::int8',[String(Number.MIN_SAFE_INTEGER)]);
      try{const value=await aggregate(parent,{select:{n:agg.count(roots.col('qty')),total:agg.sum(roots.col('qty')),low:agg.min(roots.col('qty'))}});
        assert.deepEqual(value,{n:4,total:BigInt(Number.MIN_SAFE_INTEGER)+9n,low:Number.MIN_SAFE_INTEGER});return value;
      }finally{await query('UPDATE '+d+'.shadow_roots SET qty=5 WHERE id OPERATOR(pg_catalog.=) 4::int8');}
    });
    await check('negative subnormal AVG rounding direction resists shadow unary int8 minus',async()=>{
      const value=await aggregate(realRepo,{select:{mean:agg.avg(reals.col('value'))}});assert.equal(value.mean,-2*Number.MIN_VALUE);return value;
    });
    await check('actual renderer preserves declared ICU collation through group and text-key path correlation under shadowing',async()=>{
      await query('CREATE COLLATION '+d+'.ci(provider=icu,locale=\'und-u-ks-level2\',deterministic=false)');
      await query('ALTER TABLE '+d+'.shadow_roots ALTER COLUMN grp TYPE text COLLATE '+d+'.ci USING grp,ALTER COLUMN key TYPE text COLLATE '+d+'.ci USING key');
      await query('ALTER TABLE '+d+'.shadow_children ALTER COLUMN "rootKey" TYPE text COLLATE '+d+'.ci USING "rootKey"');
      await query('UPDATE '+d+'.shadow_roots SET grp=$1::text,key=$2::text WHERE id OPERATOR(pg_catalog.=) $3::int8',['a','A','1']);
      await query('UPDATE '+d+'.shadow_roots SET grp=$1::text,key=$2::text WHERE id OPERATOR(pg_catalog.=) $3::int8',['A','a','2']);
      const caseEquality=(await query('SELECT ($1::text COLLATE '+d+'.ci) OPERATOR(pg_catalog.=) ($2::text COLLATE '+d+'.ci)',['a','A'])).rows[0][0];
      const result=await group({by:['grp'],select:summary});
      if(caseEquality==='t')assert.deepEqual(result.map(row=>({...row,grp:row.grp===null?null:row.grp.toLowerCase()})),[
        {grp:null,n:1,qty:4n,children:0,total:null},{grp:'a',n:2,qty:5n,children:4,total:60n},{grp:'h',n:1,qty:5n,children:0,total:null}]);
      else assert.deepEqual(result,[{grp:null,n:1,qty:4n,children:0,total:null},{grp:'a',n:1,qty:2n,children:2,total:30n},
        {grp:'A',n:1,qty:3n,children:0,total:null},{grp:'H',n:1,qty:5n,children:0,total:null}]);
      return{nativeCaseEquality:caseEquality,result,note:'Native equality is observed directly; no cross-engine ICU parity claim.'};
    });
    await query('UPDATE '+d+'.shadow_roots SET qty=$1::int8 WHERE id OPERATOR(pg_catalog.=) $2::int8',['9007199254740992','4']);
    await check('unsafe integer still yields DATA despite shadow BETWEEN operators',async()=>{await assert.rejects(aggregate(parent,{select:{n:agg.count(roots.col('qty')),low:agg.min(roots.col('qty'))}}),error=>error?.code==='DATA');return{error:'DATA'};});
    await check('COUNT(*) does not invent validation of an unreferenced unsafe integer',async()=>{const value=await aggregate(parent,{select:{n:agg.count()}});assert.deepEqual(value,{n:4});return value;});
    await query('UPDATE '+d+'.shadow_roots SET qty=5 WHERE id OPERATOR(pg_catalog.=) 4::int8');
    await check('isolated COUNT(column) rejects UUID typed NULL family without MIN',async()=>{await assert.rejects(aggregate(wrongRepo,{select:{n:agg.count(wrong.col('value'))}}),error=>error?.code==='DATA');const value=await aggregate(wrongRepo,{select:{n:agg.count()}});assert.deepEqual(value,{n:1});return{referenced:'DATA',unreferenced:value};});
    await query('UPDATE '+d+'.shadow_children SET value=$1::int8 WHERE id OPERATOR(pg_catalog.=) $2::int8',['9007199254740992','12']);
    await check('related off-page invalid value flags DATA; unrelated filtered roots remain usable',async()=>{
      await assert.rejects(group({by:['grp'],select:summary,limit:1}),error=>error?.code==='DATA');
      const value=await aggregate(parent,{select:summary,where:eq(roots.col('grp'),'H')});assert.deepEqual(value,{n:1,qty:5n,children:0,total:null});return{offpage:'DATA',filtered:value};
    });
  }catch(error){engine.setupError={code:error?.code,message:String(error?.message).slice(0,1000)};}
  finally {
    const errors=[];
    try { await query("SELECT pg_catalog.set_config('search_path',$1::pg_catalog.text,false)",[originalSearchPath]);assert.equal((await query('SHOW search_path')).rows[0][0],originalSearchPath);engine.cleanup.searchPathRestored=true; } catch { errors.push('search_path restore'); }
    for(const schema of [...created].reverse())try{await query('DROP SCHEMA '+quote(schema)+' CASCADE');assert.deepEqual((await query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname::pg_catalog.text OPERATOR(pg_catalog.=) $1::pg_catalog.text',[schema])).rows,[]);engine.cleanup.droppedSchemas++;}catch{errors.push('owned schema cleanup');}
    if(errors.length)throw new Error('Owned aggregate operator fixture cleanup failed.');
  }
  engine.status=!engine.setupError&&!engine.failures.length?'passed':'failed';return engine;
}
