// Native malformed-storage and domain regression tests. All values and namespaces are fictional and owned.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const quote=name=>'"'+name.replaceAll('"','""')+'"';
const coded=expected=>error=>error?.code===expected;

/**
 * The caller proves native fixture ownership and supplies an admin for the same database. openDatabase accepts
 * mapped options and must use this exact SDK build. PostgreSQL uses its public factory and a separate connection.
 * An inline PGlite fixture may borrow its caller-owned connection; the caller must keep that admin alive until this
 * runner drops its namespace, then physically close it. That mode tests native compiled queries, not the worker factory.
 */
export async function runAggregateGuardCases({engine,sdk,openDatabase,admin}) {
  assert.ok(['postgresql','pglite-inline'].includes(engine));
  assert.equal(typeof openDatabase,'function');assert.equal(typeof admin?.query,'function');
  const {column,defineTable,agg,hasMany,eq,gt,asc}=sdk;
  const schema='rs_aggregate_guard_'+randomBytes(6).toString('hex');
  const tableName=name=>quote(schema)+'.'+quote(name),cases=[],cleanup={schemaDropped:false,openedHandles:0,closedHandles:0};
  const report={engine,cases,cleanup,scope:'Actual native aggregate input guards over fictional externally prepared tables; not a schema validator or sandbox.'};
  const query=(sql,parameters=[])=>admin.query(sql,parameters);
  const simple=(name,kind)=>defineTable(name,{id:column.integer().primaryKey(),bucket:column.text(),value:kind.nullable()});
  const integers=simple('integer_inputs',column.integer()),reals=simple('real_inputs',column.real());
  const uuid=simple('uuid_inputs',column.integer()),text=simple('text_inputs',column.text());
  const boolean=simple('boolean_inputs',column.boolean()),json=simple('json_inputs',column.json());
  const single=simple('float4_inputs',column.real());
  const roots=defineTable('roots',{id:column.bigint().primaryKey(),category:column.text().nullable()});
  const leaves=defineTable('leaves',{id:column.integer().primaryKey(),rootId:column.bigint().nullable(),value:column.integer().nullable()});
  const narrowKeys=defineTable('narrow_keys',{id:column.integer().primaryKey(),rootId:column.integer(),value:column.integer()});
  const wrongKeys=defineTable('wrong_keys',{id:column.integer().primaryKey(),rootId:column.bigint().nullable()});
  const volatile=defineTable('volatile_inputs',{id:column.integer().primaryKey(),value:column.bigint()});
  const tables=[integers,reals,uuid,text,boolean,json,single,roots,leaves,narrowKeys,wrongKeys,volatile];
  const unsafe='9007199254740992';let created=false,db;
  const check=async(name,fn)=>{await fn();cases.push(name);};
  try {
    await query('CREATE SCHEMA '+quote(schema));created=true;
    await query('REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');
    for(const [table,physical] of [[integers,'int8'],[reals,'float8'],[uuid,'uuid'],[text,'int4'],[boolean,'text'],[json,'numeric'],[single,'float4']])
      await query('CREATE TABLE '+tableName(table.name)+'(id int4 PRIMARY KEY,bucket text NOT NULL,value '+physical+')');
    await query('INSERT INTO '+tableName(integers.name)+' VALUES(1,\'A\',1),(2,\'B\',$1::int8)',[unsafe]);
    await query('INSERT INTO '+tableName(reals.name)+' VALUES(1,\'A\',1),(2,\'B\',\'Infinity\'::float8),(3,\'C\',\'NaN\'::float8),(4,\'D\',$1::float8),(5,\'D\',$1::float8)',[String(Number.MAX_VALUE)]);
    for(const table of [uuid,text,boolean,json])await query('INSERT INTO '+tableName(table.name)+" VALUES(1,'A',NULL)");
    await query('INSERT INTO '+tableName(single.name)+" VALUES(1,'A',0.1),(2,'A',0.2)");
    await query('CREATE TABLE '+tableName(roots.name)+'(id int8 PRIMARY KEY,category text)');
    await query('INSERT INTO '+tableName(roots.name)+" VALUES(1,'A'),(2,'A'),(3,NULL),($1::int8,'C')",[unsafe]);
    await query('CREATE TABLE '+tableName(leaves.name)+'(id int4 PRIMARY KEY,"rootId" int8,value int8)');
    await query('INSERT INTO '+tableName(leaves.name)+' VALUES(1,1,10),(2,2,$1::int8),(3,99,$1::int8)',[unsafe]);
    await query('CREATE TABLE '+tableName(narrowKeys.name)+'(id int4 PRIMARY KEY,"rootId" int8 NOT NULL,value int4 NOT NULL)');
    await query('INSERT INTO '+tableName(narrowKeys.name)+' VALUES(1,$1::int8,7)',[unsafe]);
    await query('CREATE TABLE '+tableName(wrongKeys.name)+'(id int4 PRIMARY KEY,"rootId" uuid)');
    await query('INSERT INTO '+tableName(wrongKeys.name)+' VALUES(1,NULL)');
    await query('CREATE SEQUENCE '+tableName('input_sequence')+' START WITH 1');
    await query('CREATE VIEW '+tableName(volatile.name)+' AS SELECT id::int4 AS id,pg_catalog.nextval(\''+schema+'.input_sequence\'::pg_catalog.regclass) AS value FROM pg_catalog.generate_series(1,3) AS id');
    db=await openDatabase({tables,schema,traceValues:false});cleanup.openedHandles++;
    const rows=db.table(integers),realRows=db.table(reals),parents=db.table(roots);

    await check('COUNT(column) and MIN cannot hide an unsafe integer; COUNT(*) asserts no unrelated argument',async()=>{
      for(const selection of [agg.count(integers.col('value')),agg.min(integers.col('value')),agg.max(integers.col('value')),agg.sum(integers.col('value'))])
        await assert.rejects(rows.aggregate({select:{answer:selection}}),coded('DATA'));
      assert.deepEqual(await rows.aggregate({select:{n:agg.count()}}),{n:2});
      assert.deepEqual(await rows.aggregate({select:{answer:agg.sum(integers.col('value'))},where:eq(integers.col('id'),1)}),{answer:1n});
    });
    await check('each wrong physical family is refused by COUNT(column), including typed SQL NULL and UUID without a failing cast',async()=>{
      for(const table of [uuid,text,boolean]){
        await assert.rejects(db.table(table).aggregate({select:{n:agg.count(table.col('value'))}}),coded('DATA'));
        assert.deepEqual(await db.table(table).aggregate({select:{n:agg.count()}}),{n:1});
      }
    });
    await check('projected mapped JSON validates its physical family while JSON aggregate arguments refuse before SQL',async()=>{
      assert.throws(()=>agg.count(json.col('value')),coded('QUERY'));
      const self=hasMany(json,{localKey:json.col('id'),foreignKey:json.col('id')});
      await assert.rejects(db.table(json).findMany({select:['value'],aggregates:{n:agg.related(self,agg.count())}}),coded('DATA'));
      assert.deepEqual(await db.table(json).aggregate({select:{n:agg.count()}}),{n:1});
    });
    await check('group guards cover bad values outside a returned page; empty pages make no input assertion',async()=>{
      const options={by:['bucket'],select:{low:agg.min(integers.col('value'))},orderBy:[{field:'bucket',direction:'asc'}],limit:1};
      await assert.rejects(rows.groupBy(options),coded('DATA'));
      assert.deepEqual(await rows.groupBy({...options,where:eq(integers.col('id'),1)}),[{bucket:'A',low:1}]);
      assert.deepEqual(await rows.groupBy({...options,limit:0}),[]);
      assert.deepEqual(await rows.groupBy({...options,offset:99}),[]);
    });
    await check('NaN and Infinity are invalid stored real data before any count, minimum or arithmetic summary',async()=>{
      for(const id of [2,3])for(const selection of [agg.count(reals.col('value')),agg.min(reals.col('value')),agg.sum(reals.col('value')),agg.avg(reals.col('value'))])
        await assert.rejects(realRows.aggregate({select:{answer:selection},where:eq(reals.col('id'),id)}),coded('DATA'));
    });
    await check('invalid input takes priority over a separate finite real SUM overflow in the same statement',async()=>{
      await assert.rejects(realRows.aggregate({select:{n:agg.count(reals.col('value')),total:agg.sum(reals.col('value'))}}),coded('DATA'));
      assert.equal(await realRows.count(),5,'a successful guarded SELECT does not poison an idle connection');
    });
    await check('float4 physical values are promoted after binary32 decoding for SUM/AVG/MIN/MAX',async()=>{
      const a=Math.fround(.1),b=Math.fround(.2);
      assert.deepEqual(await db.table(single).aggregate({select:{n:agg.count(single.col('value')),total:agg.sum(single.col('value')),
        average:agg.avg(single.col('value')),low:agg.min(single.col('value')),high:agg.max(single.col('value'))}}),
        {n:2,total:a+b,average:(a+b)/2,low:a,high:b});
    });
    const relation=hasMany(leaves,{localKey:roots.col('id'),foreignKey:leaves.col('rootId')});
    const related={n:agg.related(relation,agg.count(leaves.col('value'))),total:agg.related(relation,agg.sum(leaves.col('value')))};
    await check('related guards inspect matching leaf occurrences and do not assert unrelated orphan logical values',async()=>{
      assert.deepEqual(await parents.aggregate({select:related,where:eq(roots.col('id'),1n)}),{n:1,total:10n});
      await assert.rejects(parents.aggregate({select:related,where:eq(roots.col('id'),2n)}),coded('DATA'));
      const filtered=hasMany(leaves,{localKey:roots.col('id'),foreignKey:leaves.col('rootId'),where:eq(leaves.col('id'),1)});
      assert.deepEqual(await parents.aggregate({select:{n:agg.related(filtered,agg.count()),total:agg.related(filtered,agg.sum(leaves.col('value')))}}),{n:1,total:10n});
    });
    await check('projected page excludes later roots, but a returned bad path refuses the whole result',async()=>{
      const options={select:['id'],aggregates:related,orderBy:[asc(roots.col('id'))],limit:1};
      assert.deepEqual(await parents.findMany(options),[{id:1n,n:1,total:10n}]);
      await assert.rejects(parents.findMany({...options,offset:1}),coded('DATA'));
      const groups={by:['category'],select:related,limit:1};await assert.rejects(parents.groupBy(groups),coded('DATA'));
    });
    await check('an unsafe logical join key remains physically comparable so a matching invalid path cannot vanish',async()=>{
      const relation=hasMany(narrowKeys,{localKey:roots.col('id'),foreignKey:narrowKeys.col('rootId')});
      await assert.rejects(parents.aggregate({where:eq(roots.col('id'),BigInt(unsafe)),select:{n:agg.related(relation,agg.count())}}),coded('DATA'));
    });
    await check('a wrong child join-key family is conservatively refused for nonempty roots; empty roots remain empty',async()=>{
      const relation=hasMany(wrongKeys,{localKey:roots.col('id'),foreignKey:wrongKeys.col('rootId')});
      const select={n:agg.related(relation,agg.count())};
      await assert.rejects(parents.aggregate({where:eq(roots.col('id'),1n),select}),coded('DATA'));
      assert.deepEqual(await parents.aggregate({where:gt(roots.col('id'),BigInt(unsafe)),select}),{n:0});
    });
    await check('one materialized raw column evaluation supplies every selected summary over a volatile view',async()=>{
      assert.deepEqual(await db.table(volatile).aggregate({select:{n:agg.count(volatile.col('value')),total:agg.sum(volatile.col('value')),
        low:agg.min(volatile.col('value')),high:agg.max(volatile.col('value'))}}),{n:3,total:6n,low:1n,high:3n});
      assert.deepEqual((await query('SELECT last_value::text FROM '+tableName('input_sequence'))).rows,[['3']]);
    });
    await check('identical related paths share one raw evaluation across count, sum and extrema',async()=>{
      await query('SELECT pg_catalog.setval(\''+schema+'.input_sequence\'::pg_catalog.regclass,1,false)');
      const path=hasMany(volatile,{localKey:roots.col('id'),foreignKey:volatile.col('id')});
      assert.deepEqual(await parents.aggregate({select:{n:agg.related(path,agg.count(volatile.col('value'))),
        total:agg.related(path,agg.sum(volatile.col('value'))),low:agg.related(path,agg.min(volatile.col('value'))),
        high:agg.related(path,agg.max(volatile.col('value')))}}),{n:3,total:6n,low:1n,high:3n});
      assert.deepEqual((await query('SELECT last_value::text FROM '+tableName('input_sequence'))).rows,[['3']]);
    });
    await check('guarded DATA errors keep successful-SELECT transaction state usable',async()=>{
      await db.transaction(async tx=>{
        await assert.rejects(tx.table(integers).aggregate({select:{n:agg.count(integers.col('value'))}}),coded('DATA'));
        assert.equal(await tx.table(integers).count(),2);
      });
      assert.equal(await rows.count(),2);
    });
    return report;
  } finally {
    try{if(db){await db.close();cleanup.closedHandles++;}}
    finally{if(created){await query('DROP SCHEMA '+quote(schema)+' CASCADE');
      assert.deepEqual((await query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1::text',[schema])).rows,[]);cleanup.schemaDropped=true;}}
  }
}
