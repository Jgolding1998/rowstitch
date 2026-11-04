// PostgreSQL-only adversarial public graph controls. Caller owns the disposable server and its admin connection.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const quote=value=>'"'+value.replaceAll('"','""')+'"';
const literal=value=>"E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const code=expected=>error=>error?.code===expected&&error.cause===undefined;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/**
 * All SDK/factory imports must be from one build. admin.query(sql,values) and makeAdmin(overrides).query return
 * positional raw-text rows on the SAME caller-verified disposable PostgreSQL server. makeAdmin accepts only
 * applicationName/user/password overrides and returns {query,close}. This module closes only clients it creates.
 * No Docker, peer installs, global settings, PGlite cross-connection claim or caller-admin closure.
 */
export async function runEagerNativeControlCases({sdk,openPostgresDatabase,postgresOptions,admin,makeAdmin}){
  assert.equal(typeof openPostgresDatabase,'function');assert.equal(typeof admin?.query,'function');assert.equal(typeof makeAdmin,'function');
  assert.equal(postgresOptions?.connectionString,undefined);for(const name of ['host','user','database'])assert.equal(typeof postgresOptions?.[name],'string');
  const {column,defineTable,hasMany,hasOne,eq,gt,lte,and,or,asc,desc}=sdk;
  const token=randomBytes(6).toString('hex'),schema='rs_eager_controls_'+token,role='rs_eager_role_'+token,rolePassword=randomBytes(32).toString('base64url');
  const table=name=>quote(schema)+'.'+quote(name),app=name=>'rs_ec_'+token+'_'+name;
  const databases=new Set(),clients=new Set(),pending=new Set(),releases=new Set(),cases=[],skipped=[];
  const cleanup={openedDatabases:0,closedDatabases:0,openedClients:0,closedClients:0,schemaDropped:false,roleDropped:false};
  const report={engine:'postgresql',cases,skipped,cleanup,visibility:[],limits:[
    'Owned PostgreSQL public-factory controls only. PGlite private-worker ICU/external-session controls are not claimed.',
    'ICU absence is an explicit skip, never a passing collation case.',
    'The same-child projected-summary visibility anomaly needs a separate step barrier: its root query already references the locked child table. This module does not mislabel that as a completed-root barrier.',
    'Cancellation drains an issued child request after its lock is released; it is not immediate cancellation of sent SQL.',
  ]};
  let created=false,roleCreated=false,failed=false;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned native eager control completion exceeded22 seconds')),22000);})]);}finally{clearTimeout(timer);}};
  const query=async(client,sql,values=[])=>{try{return await client.query(sql,values);}catch(error){
    const command=/^[A-Za-z]+/.exec(sql)?.[0]??'SQL';
    const state=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:'UNKNOWN';
    throw new Error('Owned native eager control administration failed ('+command+', '+state+').');}};
  const ownClient=async(overrides={})=>{let client;try{client=await makeAdmin(overrides);}catch{throw new Error('Owned native eager control client could not open.');}
    assert.equal(typeof client?.query,'function');assert.equal(typeof client?.close,'function');clients.add(client);cleanup.openedClients++;
    await query(client,"SET statement_timeout='15000ms'");return client;};
  const closeClient=async client=>{await bounded(client.close());if(clients.delete(client))cleanup.closedClients++;};
  const ownDb=async(tables,name,extra={})=>{const db=await openPostgresDatabase({...postgresOptions,ssl:false,tables,schema,traceValues:false,
    applicationName:app(name),statementTimeoutMs:15000,requestTimeoutMs:20000,...extra});databases.add(db);cleanup.openedDatabases++;return db;};
  const closeDb=async db=>{await bounded(db.close());if(databases.delete(db))cleanup.closedDatabases++;};
  const check=async(name,fn)=>{try{await fn();cases.push(name);}catch(error){
    const detail=String(error?.message??'failure').replaceAll(rolePassword,'<fixture-secret>').replaceAll(postgresOptions.password??'\0','<fixture-secret>');
    throw new Error('Native eager control '+name+': '+detail);}};
  const watch=promise=>{const state={done:false,result:null};state.promise=Promise.resolve(promise).then(value=>(state.done=true,state.result={ok:true,value}),error=>(state.done=true,state.result={ok:false,error}));
    pending.add(state.promise);state.promise.then(()=>pending.delete(state.promise));return state;};
  const finish=async state=>{const outcome=await bounded(state.promise);if(!outcome.ok)throw outcome.error;return outcome.value;};
  const until=async predicate=>{const deadline=Date.now()+10000;for(;;){if(await predicate())return;assert.ok(Date.now()<deadline,'Owned native eager control observation exceeded10 seconds');await pause(20);}};
  const pidFor=async name=>{let pid;await until(async()=>{const rows=(await query(admin,'SELECT pid::pg_catalog.text FROM pg_catalog.pg_stat_activity WHERE application_name=$1 AND datname=pg_catalog.current_database()',[app(name)])).rows;
    assert.ok(rows.length<=1,'Owned application name must identify one backend');if(rows.length){pid=Number(rows[0][0]);return true;}return false;});assert.ok(Number.isSafeInteger(pid)&&pid>0);return pid;};
  const relationOid=async name=>String((await query(admin,'SELECT $1::pg_catalog.regclass::pg_catalog.oid::pg_catalog.text',[table(name)])).rows[0][0]);
  const blocked=async(db,name,child,operation)=>{const pid=await pidFor(name),oid=await relationOid(child.name);await until(async()=>{
    if(operation.done){if(!operation.result.ok)throw operation.result.error;assert.fail('Public graph completed before the child lock barrier');}
    const rows=(await query(admin,"SELECT count(*)::pg_catalog.text FROM pg_catalog.pg_locks WHERE pid=$1::pg_catalog.int4 AND relation=$2::pg_catalog.oid AND mode='AccessShareLock' AND NOT granted",[String(pid),oid])).rows;
    return Number(rows[0][0])>0;
  });assert.ok(db.exportTrace().queries.some(entry=>entry.operation==='select'&&entry.table==='visibility_roots'&&entry.status==='ok'),'The root SELECT must finish before the child barrier');return pid;};

  const visibilityRoots=defineTable('visibility_roots',{id:column.integer().primaryKey(),name:column.text()});
  const visibilityChildren=defineTable('visibility_children',{id:column.integer().primaryKey(),rootId:column.integer(),label:column.text()});
  const markers=defineTable('control_markers',{id:column.integer().primaryKey(),label:column.text()});
  const visibilityTables=[visibilityRoots,visibilityChildren,markers];
  const visibilityOptions={select:['name'],include:{children:hasMany(visibilityChildren,{localKey:visibilityRoots.col('id'),foreignKey:visibilityChildren.col('rootId'),select:['label']})}};
  const resetVisibility=async()=>{await query(admin,'TRUNCATE '+table('visibility_children')+', '+table('visibility_roots')+', '+table('control_markers'));
    await query(admin,'INSERT INTO '+table('visibility_roots')+" VALUES(1,'old-root')");};
  try{
    await query(admin,'CREATE SCHEMA '+quote(schema));created=true;await query(admin,'REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');
    await query(admin,'CREATE TABLE '+table('visibility_roots')+'(id int4 PRIMARY KEY,name text NOT NULL)');
    await query(admin,'CREATE TABLE '+table('visibility_children')+'(id int4 PRIMARY KEY,"rootId" int4 NOT NULL,label text NOT NULL)');
    await query(admin,'CREATE TABLE '+table('control_markers')+'(id int4 PRIMARY KEY,label text NOT NULL)');
    const defaults=(await query(admin,"SELECT current_setting('default_transaction_isolation'),current_setting('transaction_isolation')")).rows[0];
    assert.deepEqual(defaults,['read committed','read committed'],'This explicit visibility fixture requires actual READ COMMITTED defaults');report.defaultIsolation=defaults[0];

    // Collation equivalence must be engine-proven; exact JS strings remain separate source ordinals across400-key chunks.
    const icu=(await query(admin,"SELECT count(*)::pg_catalog.text FROM pg_catalog.pg_collation WHERE collprovider='i'")).rows[0][0];
    if(Number(icu)===0)skipped.push({cluster:'ICU case/canonical-equivalence graph controls',reason:'The owned server exposes no ICU provider collations.'});
    else{
      await query(admin,'CREATE COLLATION '+table('key_equivalence')+" (provider=icu,locale='und-u-ks-level2',deterministic=false)");
      const equality=(await query(admin,'SELECT ($1::pg_catalog.text COLLATE '+table('key_equivalence')+' OPERATOR(pg_catalog.=) $2::pg_catalog.text)::pg_catalog.text, ($3::pg_catalog.text COLLATE '+table('key_equivalence')+' OPERATOR(pg_catalog.=) $4::pg_catalog.text)::pg_catalog.text',['MiXeD','mixed','café','cafe\u0301'])).rows;
      assert.deepEqual(equality,[['true','true']]);
      const roots=defineTable('collation_roots',{id:column.integer().primaryKey(),key:column.text().nullable()});
      const children=defineTable('collation_children',{id:column.integer().primaryKey(),key:column.text().nullable(),label:column.text()});
      const leaves=defineTable('collation_leaves',{id:column.integer().primaryKey(),childId:column.integer(),label:column.text()});
      await query(admin,'CREATE TABLE '+table(roots.name)+'(id int4 PRIMARY KEY,key text COLLATE pg_catalog."C")');
      await query(admin,'CREATE TABLE '+table(children.name)+'(id int4 PRIMARY KEY,key text COLLATE '+table('key_equivalence')+',label text NOT NULL)');
      await query(admin,'CREATE TABLE '+table(leaves.name)+'(id int4 PRIMARY KEY,"childId" int4 NOT NULL,label text NOT NULL)');
      const keys=Array.from({length:801},(_,i)=>'key'+i);keys[0]='MiXeD';keys[400]='mixed';keys[800]='MIXED';keys[1]='café';keys[401]='cafe\u0301';
      const expected=keys.map((_,i)=>[0,400,800].includes(i)?'case':[1,401].includes(i)?'canonical':'row'+i);
      for(let start=0;start<keys.length;start+=200){const part=keys.slice(start,start+200),values=part.flatMap((key,i)=>[String(start+i+1),key]);
        await query(admin,'INSERT INTO '+table(roots.name)+' VALUES '+part.map((_,i)=>'($'+(i*2+1)+'::int4,$'+(i*2+2)+'::text)').join(','),values);}
      await query(admin,'INSERT INTO '+table(roots.name)+' VALUES(802,NULL)');
      const unique=[0,1,...Array.from({length:801},(_,i)=>i).filter(i=>![0,1,400,401,800].includes(i))];
      for(let start=0;start<unique.length;start+=150){const part=unique.slice(start,start+150),values=part.flatMap(i=>[String(i+1),keys[i],expected[i]]);
        await query(admin,'INSERT INTO '+table(children.name)+' VALUES '+part.map((_,i)=>'($'+(i*3+1)+'::int4,$'+(i*3+2)+'::text,$'+(i*3+3)+'::text)').join(','),values);}
      await query(admin,'INSERT INTO '+table(children.name)+" VALUES(2000,NULL,'null-child')");
      await query(admin,'INSERT INTO '+table(leaves.name)+' SELECT id,id,\'leaf:\' OPERATOR(pg_catalog.||) label FROM '+table(children.name));
      const db=await ownDb([roots,children,leaves],'collation');
      const nested={leaves:hasMany(leaves,{localKey:children.col('id'),foreignKey:leaves.col('childId'),select:['label']})};
      const relation={localKey:roots.col('key'),foreignKey:children.col('key'),select:['label'],include:nested};
      for(const size of [401,801])await check('ICU case/NFC-NFD source ordinals across '+size+' keys preserve hasMany/hasOne and NULL/nested copies',async()=>{
        db.clearTrace();const rows=await db.table(roots).findMany({select:['id','key'],where:or(lte(roots.col('id'),size),eq(roots.col('id'),802)),orderBy:[asc(roots.col('id'))],limit:10000,
          include:{many:hasMany(children,relation),one:hasOne(children,relation)}});
        assert.equal(rows.length,size+1);
        for(let i=0;i<size;i++){const child={label:expected[i],leaves:[{label:'leaf:'+expected[i]}]};assert.deepEqual(rows[i],{id:i+1,key:keys[i],many:[child],one:child});}
        assert.deepEqual(rows.at(-1),{id:802,key:null,many:[],one:null});
        assert.equal(db.exportTrace().queries.filter(entry=>entry.operation==='select'&&entry.table===children.name).length,2*Math.ceil(size/400));
        rows[0].many[0].leaves[0].label='only-this-copy';assert.equal(rows[400].many[0].leaves[0].label,'leaf:case');assert.equal(rows[0].one.leaves[0].label,'leaf:case');
      });await closeDb(db);
    }

    await check('owned hostile role search_path shadows raw row_number and int8/text operators while public graphs remain qualified',async()=>{
      await query(admin,'CREATE FUNCTION '+table('row_number')+'() RETURNS pg_catalog.int8 LANGUAGE sql IMMUTABLE AS $$SELECT 99::pg_catalog.int8$$');
      for(const [suffix,type]of [['i','int8'],['t','text']])for(const [name,symbol]of [['eq','='],['gt','>'],['le','<=']]){
        const fn='bad_'+name+'_'+suffix;await query(admin,'CREATE FUNCTION '+table(fn)+'(pg_catalog.'+type+',pg_catalog.'+type+') RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE AS $$SELECT false$$');
        await query(admin,'CREATE OPERATOR '+quote(schema)+'.'+symbol+' (FUNCTION='+table(fn)+',LEFTARG=pg_catalog.'+type+',RIGHTARG=pg_catalog.'+type+')');
      }
      const roots=defineTable('hostile_roots',{id:column.bigint().primaryKey(),key:column.text()});
      const children=defineTable('hostile_children',{id:column.bigint().primaryKey(),rootId:column.bigint(),key:column.text(),label:column.text()});
      await query(admin,'CREATE TABLE '+table(roots.name)+'(id int8 PRIMARY KEY,key text NOT NULL)');
      await query(admin,'CREATE TABLE '+table(children.name)+'(id int8 PRIMARY KEY,"rootId" int8 NOT NULL,key text NOT NULL,label text NOT NULL)');
      await query(admin,'INSERT INTO '+table(roots.name)+" VALUES(1,'z')");await query(admin,'INSERT INTO '+table(children.name)+" VALUES(1,1,'z','safe')");
      await query(admin,'CREATE ROLE '+quote(role)+' LOGIN PASSWORD '+literal(rolePassword));roleCreated=true;
      await query(admin,'ALTER ROLE '+quote(role)+' IN DATABASE '+quote(postgresOptions.database)+' SET search_path TO '+quote(schema)+',pg_catalog');
      await query(admin,'GRANT USAGE ON SCHEMA '+quote(schema)+' TO '+quote(role));await query(admin,'GRANT SELECT ON ALL TABLES IN SCHEMA '+quote(schema)+' TO '+quote(role));
      const rawClient=await ownClient({user:role,password:rolePassword,applicationName:app('hostile_raw')});
      assert.deepEqual((await query(rawClient,'SELECT row_number()::pg_catalog.text, (1::pg_catalog.int8 = 1::pg_catalog.int8)::pg_catalog.text, (2::pg_catalog.int8 > 1::pg_catalog.int8)::pg_catalog.text, (1::pg_catalog.int8 <= 2::pg_catalog.int8)::pg_catalog.text, (\'z\'::pg_catalog.text = \'z\'::pg_catalog.text)::pg_catalog.text, (\'z\'::pg_catalog.text > \'a\'::pg_catalog.text)::pg_catalog.text')).rows,[['99','false','false','false','false','false']]);
      let rejected=false;try{await rawClient.query('SELECT row_number() OVER ()',[]);}catch{rejected=true;}assert.equal(rejected,true,'The shadow ordinary function must break the unqualified window control');
      await closeClient(rawClient);
      const db=await ownDb([roots,children],'hostile_public',{user:role,password:rolePassword});
      const scope={select:['label'],where:gt(children.col('id'),0n),orderBy:[desc(children.col('id'))],limit:1};
      assert.deepEqual(await db.table(roots).findMany({select:['id'],where:and(gt(roots.col('id'),0n),gt(roots.col('key'),'a')),include:{
        numeric:hasMany(children,{localKey:roots.col('id'),foreignKey:children.col('rootId'),...scope}),text:hasMany(children,{localKey:roots.col('key'),foreignKey:children.col('key'),...scope})}}),[{id:1n,numeric:[{label:'safe'}],text:[{label:'safe'}]}]);
      await closeDb(db);
    });

    for(const mode of [{name:'plain_writable',readOnly:false,transaction:false,newChild:true},{name:'plain_readonly',readOnly:true,transaction:false,newChild:true},
      {name:'readonly_transaction',readOnly:true,transaction:true,newChild:true},{name:'serializable_transaction',readOnly:false,transaction:true,newChild:false}])
      await check('child-lock barrier proves '+mode.name+' graph visibility under actual READ COMMITTED defaults',async()=>{
        await resetVisibility();const db=await ownDb(visibilityTables,mode.name,{readOnly:mode.readOnly}),writer=await ownClient({applicationName:app(mode.name+'_writer')});
        assert.deepEqual((await query(writer,"SELECT current_setting('default_transaction_isolation'),current_setting('transaction_isolation')")).rows,[['read committed','read committed']]);
        await query(writer,'BEGIN');await query(writer,'LOCK TABLE '+table(visibilityChildren.name)+' IN ACCESS EXCLUSIVE MODE');db.clearTrace();
        const operation=watch(mode.transaction?db.transaction(tx=>tx.table(visibilityRoots).findMany(visibilityOptions)):db.table(visibilityRoots).findMany(visibilityOptions));
        await blocked(db,mode.name,visibilityChildren,operation);
        await query(writer,'UPDATE '+table(visibilityRoots.name)+" SET name='new-root' WHERE id=1");await query(writer,'INSERT INTO '+table(visibilityChildren.name)+" VALUES(1,1,'new-child')");await query(writer,'COMMIT');
        assert.deepEqual(await finish(operation),[{name:'old-root',children:mode.newChild?[{label:'new-child'}]:[]}]);
        const control=db.exportTrace().queries.filter(entry=>entry.operation==='transaction').map(entry=>entry.sql);
        assert.equal(control.filter(sql=>sql==='COMMIT').length,mode.transaction?1:mode.readOnly?2:0);
        if(mode.transaction)assert.ok(control.includes(mode.readOnly?'BEGIN READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE'));
        report.visibility.push({mode:mode.name,root:'old-root',child:mode.newChild?'new-child':'old empty snapshot',childBlockObserved:true,commitCount:control.filter(sql=>sql==='COMMIT').length});
        await closeClient(writer);await closeDb(db);
      });

    const driftRoots=defineTable('drift_roots',{id:column.integer().primaryKey(),key:column.text(),label:column.text()});
    const driftChildren=defineTable('drift_children',{id:column.integer().primaryKey(),key:column.text(),label:column.text()});
    await query(admin,'CREATE TABLE '+table(driftRoots.name)+'(id int4 PRIMARY KEY,key text NOT NULL,label text NOT NULL)');
    await query(admin,'CREATE TABLE '+table(driftChildren.name)+'(id int4 PRIMARY KEY,key int4 NOT NULL,label text NOT NULL)');
    await query(admin,'INSERT INTO '+table(driftRoots.name)+" VALUES(1,'1','original')");await query(admin,'INSERT INTO '+table(driftChildren.name)+" VALUES(1,1,'physical-family-drift')");
    const driftOptions={include:{children:hasMany(driftChildren,{localKey:driftRoots.col('key'),foreignKey:driftChildren.col('key')})}};
    const drift=await ownDb([driftRoots,driftChildren],'drift');
    await check('physical text-key mapping over int4 is a constant engine DATABASE_ERROR with a healthy idle session',async()=>{
      await assert.rejects(drift.table(driftRoots).findMany(driftOptions),error=>code('DATABASE_ERROR')(error)&&!String(error.message).includes('physical-family-drift'));
      assert.equal(await drift.table(driftRoots).count(),1);
    });
    await check('caught physical key-family engine error leaves transaction aborted and prior write rolls back',async()=>{
      drift.clearTrace();await assert.rejects(drift.transaction(async tx=>{
        await tx.table(driftRoots).update({label:'must-rollback'},{where:eq(driftRoots.col('id'),1),maxRows:1});
        await assert.rejects(tx.table(driftRoots).findMany(driftOptions),code('DATABASE_ERROR'));await assert.rejects(tx.table(driftRoots).count(),code('DATABASE_ERROR'));
      }),code('TRANSACTION_ABORTED'));
      assert.equal((await drift.table(driftRoots).findFirst()).label,'original');assert.ok(drift.exportTrace().queries.some(entry=>entry.sql==='COMMIT'&&entry.status==='error'));
    });await closeDb(drift);

    await check('terminating the observed blocked child backend rejects the whole graph, does not replay and poisons its handle',async()=>{
      await resetVisibility();const db=await ownDb(visibilityTables,'lost_child'),writer=await ownClient({applicationName:app('lost_writer')});
      await query(writer,'BEGIN');await query(writer,'LOCK TABLE '+table(visibilityChildren.name)+' IN ACCESS EXCLUSIVE MODE');db.clearTrace();
      const operation=watch(db.table(visibilityRoots).findMany(visibilityOptions)),pid=await blocked(db,'lost_child',visibilityChildren,operation);
      const ownership=(await query(admin,'SELECT count(*)::pg_catalog.text FROM pg_catalog.pg_stat_activity WHERE pid=$1::int4 AND application_name=$2 AND datname=pg_catalog.current_database()',[String(pid),app('lost_child')])).rows;
      assert.deepEqual(ownership,[['1']]);assert.deepEqual((await query(admin,'SELECT pg_catalog.pg_terminate_backend($1::int4)::text',[String(pid)])).rows,[['true']]);
      await assert.rejects(finish(operation),code('EXECUTION_UNCONFIRMED'));await assert.rejects(db.table(visibilityRoots).count(),code('CONNECTION_UNUSABLE'));
      const traces=db.exportTrace().queries.filter(entry=>entry.operation==='select');assert.equal(traces.filter(entry=>entry.table===visibilityRoots.name&&entry.status==='ok').length,1);
      assert.equal(traces.filter(entry=>entry.table===visibilityChildren.name&&entry.status==='error').length,1);assert.equal(traces.length,2);
      await query(writer,'ROLLBACK');await closeClient(writer);await closeDb(db);
    });
    await check('pre-aborted graph transaction sends no SQL and never invokes its callback',async()=>{
      const db=await ownDb(visibilityTables,'preabort'),controller=new AbortController();controller.abort();let callbacks=0;db.clearTrace();
      await assert.rejects(db.transaction(async tx=>{callbacks++;return tx.table(visibilityRoots).findMany(visibilityOptions);},{signal:controller.signal}),code('ABORTED'));
      assert.equal(callbacks,0);assert.deepEqual(db.exportTrace().queries,[]);assert.equal(await db.table(visibilityRoots).count(),1);await closeDb(db);
    });
    for(const mode of ['abort','forgotten'])await check(mode==='abort'?'an in-flight graph transaction signal drains the blocked child then rolls back':'forgotten graph work at callback settlement drains the child and refuses COMMIT',async()=>{
      await resetVisibility();const name=mode+'_graph',db=await ownDb(visibilityTables,name),writer=await ownClient({applicationName:app(name+'_writer')});
      await query(writer,'BEGIN');await query(writer,'LOCK TABLE '+table(visibilityChildren.name)+' IN ACCESS EXCLUSIVE MODE');
      const controller=new AbortController();let release;const gate=new Promise(resolve=>{release=resolve;});db.clearTrace();
      const cleanupGate=()=>{controller.abort();release();};releases.add(cleanupGate);
      const transaction=watch(db.transaction(async tx=>{
        await tx.table(markers).insert({id:1,label:'must-rollback'});
        const graph=tx.table(visibilityRoots).findMany(visibilityOptions);graph.catch(()=>{});
        if(mode==='abort')return await graph;await gate;return 'callback finished with pending graph';
      },mode==='abort'?{signal:controller.signal}:undefined));
      await blocked(db,name,visibilityChildren,transaction);if(mode==='abort')controller.abort();else release();
      await query(writer,'ROLLBACK');await assert.rejects(finish(transaction),code(mode==='abort'?'ABORTED':'TRANSACTION_PENDING'));
      releases.delete(cleanupGate);
      assert.equal(await db.table(markers).count(),0);assert.equal(await db.table(visibilityRoots).count(),1);
      assert.ok(!db.exportTrace().queries.some(entry=>entry.sql==='COMMIT'));assert.ok(db.exportTrace().queries.some(entry=>entry.sql==='ROLLBACK'&&entry.status==='ok'));
      await closeClient(writer);await closeDb(db);
    });
    return report;
  }catch(error){failed=true;throw error;}
  finally{
    const errors=[];
    // Unlock first so issued public work can drain; caller admin is never in this ownership set.
    for(const release of releases)release();
    for(const client of clients)try{await client.query('ROLLBACK',[]);}catch{}
    try{await bounded(Promise.all([...pending]));}catch{errors.push('pending');}
    for(const db of [...databases])try{await closeDb(db);}catch{errors.push('database');}
    for(const client of [...clients])try{await closeClient(client);}catch{errors.push('client');}
    if(created)try{await query(admin,'DROP SCHEMA '+quote(schema)+' CASCADE');cleanup.schemaDropped=true;}catch{errors.push('schema');}
    if(roleCreated)try{await query(admin,'DROP ROLE '+quote(role));cleanup.roleDropped=true;}catch{errors.push('role');}
    else cleanup.roleDropped=true;
    if(!failed){assert.equal(cleanup.openedDatabases,cleanup.closedDatabases);assert.equal(cleanup.openedClients,cleanup.closedClients);if(errors.length)throw new Error('Owned native eager control cleanup failed.');}
  }
}
