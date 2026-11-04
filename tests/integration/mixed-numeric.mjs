// Native, CI-sized exact mixed-column regressions. Only fictional connection-local temporary fixtures are created.
import assert from 'node:assert/strict';
import { compilePostgres } from '../../dist/core/postgres-compiler.js';
import { decodePostgresStorage } from '../../dist/core/postgres-storage.js';
import { MAX_BOUND_PARAMETERS, MAX_REQUEST_PARAMETERS, queryModel, tableModel } from '../../dist/core/query-model.js';
import { createPostgresExecutor } from '../../dist/core/postgres-executor.js';
import { createAsyncSession } from '../../dist/core/async-session.js';
import { isPostgresRawResult } from '../../dist/core/postgres-result.js';

const OPERATORS=Object.freeze(['=','<>','<','<=','>','>=']);
const bits=new DataView(new ArrayBuffer(8));
const wire=value=>value===null?null:Number.isNaN(value)?'NaN':value===Infinity?'Infinity':value===-Infinity?'-Infinity':Object.is(value,-0)?'-0':String(value);
function next(value,up){
  if(value===0)return up?Number.MIN_VALUE:-Number.MIN_VALUE;
  bits.setFloat64(0,value,false);bits.setBigUint64(0,bits.getBigUint64(0,false)+((value>0)===up?1n:-1n),false);return bits.getFloat64(0,false);
}
/** Independent IEEE754 rational oracle: never round the integer to Number or use the SQL truncation expression. */
function relation(integer,real){
  if(integer===null||real===null)return null;
  if(Number.isNaN(real)||real===Infinity)return -1; // Native PostgreSQL NaN sorts above every non-NaN value.
  if(real===-Infinity)return 1;
  bits.setFloat64(0,real,false);const raw=bits.getBigUint64(0,false),exponent=Number(raw>>52n&2047n),fraction=raw&((1n<<52n)-1n);
  const significand=exponent===0?fraction:(1n<<52n)|fraction,power=exponent===0?-1074:exponent-1075;
  let numerator=(raw>>63n?-1n:1n)*significand,denominator=1n;
  if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power);
  const left=integer*denominator;return left<numerator?-1:left>numerator?1:0;
}
function expected(integer,real,operator,reverse=false){
  let order=relation(integer,real);if(order===null)return null;if(reverse)order=-order;
  return operator==='='?order===0:operator==='<>'?order!==0:operator==='<'?order<0:operator==='<='?order<=0:operator==='>'?order>0:order>=0;
}
const cmp=(operator,reverse=false)=>({kind:'column-compare',left:reverse?'r':'i',right:reverse?'i':'r',operator});
const value=(column,operator,values)=>({kind:'compare',column,operator,values});
const mapped=(name,integer='bigint')=>tableModel({name,columns:['id','i','r','label','version'],primaryKey:['id'],version:'version',
  kinds:{id:'integer',i:integer,r:'real',label:'text',version:'integer'},nullable:{id:false,i:true,r:true,label:false,version:false}});
const select=(table,where,limit=10_000,offset=0)=>queryModel.select({table,columns:['id'],where,orderBy:[{column:'id',direction:'ASC'}],limit,offset});
const unique=values=>[...new Map(values.map(v=>[wire(v),v])).values()];
function numericLiteral(number,type){
  if(number===null)return 'NULL::"pg_catalog"."'+type+'"';
  const text=wire(number);assert.match(text,/^(?:NaN|-?Infinity|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
  return "'"+text+"'::\"pg_catalog\".\""+type+'"';
}

/** openTransport supplies a fresh dedicated transport. This function owns it and always attempts orderly close. */
export async function runMixedNumericCases(openTransport){
  const cases=[],cleanup={ownedTransportClosed:false,transactionEnded:false,temporaryObjectsDropped:false,temporaryObjectsCreated:0};
  let transport,executor,session,original,requests=0,closeCalls=0;const objects=[];
  const report={cases,comparisons:0,rootSelects:0,rootCounts:0,cleanup};
  const own=async(type,name,sql)=>{
    assert.match(name,/^rs_mixed_[a-z0-9_]+$/);const result=await executor.all(sql,[]);
    assert.equal(result.command,'CREATE');assert.equal(result.rowCount,null);assert.deepEqual(result.fields,[]);assert.deepEqual(result.rows,[]);
    objects.push({type,name});cleanup.temporaryObjectsCreated++;
  };
  const run=async model=>{
    const compiled=compilePostgres(model,{schema:'pg_temp'}),raw=await executor.all(compiled.sql,compiled.parameters);
    return {compiled,rows:decodePostgresStorage(raw,compiled.outputs,compiled.command,compiled.count?{count:true}:{})};
  };
  const insertValues=async(name,type,values)=>{
    await own('TABLE',name,'CREATE TEMP TABLE '+name+'(id int4 PRIMARY KEY,v "pg_catalog"."'+type+'")');
    const parameters=[],tuples=values.map((v,index)=>{parameters.push(String(index),wire(v));return '($'+(parameters.length-1)+'::int4,$'+parameters.length+'::"pg_catalog"."'+type+'")';});
    await executor.all('INSERT INTO pg_temp.'+name+' VALUES '+tuples.join(','),parameters);
    const actual=await executor.all('SELECT v::"pg_catalog"."'+(type.startsWith('int')?'int8':'float8')+'" FROM pg_temp.'+name+' ORDER BY id',[]);
    actual.rows.forEach((row,index)=>assert.ok(Object.is(row[0]===null?null:type.startsWith('int')?BigInt(row[0]):Number(row[0]),values[index]),'Stored native vector differs from oracle'));
  };
  try{
    const native=await openTransport();
    // Count real transport calls without changing its engine responses, errors or transaction state.
    transport={query:(sql,parameters)=>{requests++;return native.query(sql,parameters);},
      transactionStatus:()=>native.transactionStatus(),serverError:error=>native.serverError(error),
      close:()=>{closeCalls++;return native.close();},
      ...(typeof native.forceClose==='function'?{forceClose:()=>native.forceClose()}:{})};
    await transport.query('SET extra_float_digits=3',[]); // Setup of this owned connection, before the executor takes control.
    executor=createPostgresExecutor(transport);
    assert.equal(await executor.inTransaction(),false);
    assert.equal(relation(9007199254740993n,2**53),1);assert.equal(relation(-(2n**63n),-(2**63)),0);
    assert.equal(relation(0n,Number.MIN_VALUE),-1);assert.equal(relation(0n,-Number.MIN_VALUE),1);
    const vectors={
      i8:[null,-(2n**63n),-(2n**63n)+1n,-9007199254740993n,-9007199254740992n,-1n,0n,1n,9007199254740992n,9007199254740993n,2n**63n-1n],
      i4:[null,-2147483648n,-32768n,-1n,0n,1n,32767n,16777216n,16777217n,2147483647n],
      i2:[null,-32768n,-1n,0n,1n,32767n],
      f8:unique([null,-Infinity,next(-(2**63),false),-(2**63),next(-(2**63),true),-(2**53),-1.5,-1,-.5,-Number.MIN_VALUE,-0,0,Number.MIN_VALUE,.5,next(1,false),1,next(1,true),1.5,2**53,next(2**63,false),2**63,Number.MAX_VALUE,Infinity,NaN]),
      f4:unique([null,-Infinity,-((2-2**-23)*2**127),-(2**63),-(2**31),-32768,-1.5,-.5,-(2**-149),-0,0,2**-149,.5,Math.fround(.1),1,1.5,32768,2**24,2**24+2,2**31,2**63,(2-2**-23)*2**127,Infinity,NaN]),
    };
    for(const [key,type]of[['i8','int8'],['i4','int4'],['i2','int2'],['f8','float8'],['f4','float4']])await insertValues('rs_mixed_'+key,type,vectors[key]);
    let naiveMismatches=0;
    for(const ikey of ['i8','i4','i2'])for(const rkey of ['f8','f4']){
      const ints=vectors[ikey],reals=vectors[rkey],table=mapped('rs_mixed_'+ikey+'_'+rkey,ikey==='i8'?'bigint':'integer');
      await own('VIEW',table.name,'CREATE TEMP VIEW '+table.name+' AS SELECT (a.id*1000+b.id)::int4 AS id,a.v AS i,b.v AS r,\'Sample\'::text AS label,1::int4 AS version FROM pg_temp.rs_mixed_'+ikey+' a CROSS JOIN pg_temp.rs_mixed_'+rkey+' b');
      const before=report.comparisons;
      for(const operator of OPERATORS)for(const reverse of [false,true]){
        const yes=[],no=[];
        ints.forEach((i,ii)=>reals.forEach((r,ri)=>{const answer=expected(i,r,operator,reverse);if(answer===true)yes.push(BigInt(ii*1000+ri));else if(answer===false)no.push(BigInt(ii*1000+ri));}));
        const where=cmp(operator,reverse),positive=await run(select(table,where)),negative=await run(select(table,{kind:'not',child:where}));
        assert.deepEqual(positive.compiled.parameters,['10000','0']);assert.deepEqual(positive.rows.map(row=>row.id),yes);assert.deepEqual(negative.rows.map(row=>row.id),no);report.rootSelects+=2;
        const count=await run(queryModel.count({table,where}));assert.equal(count.rows[0].n,BigInt(yes.length));report.rootCounts++;
        report.comparisons+=ints.length*reals.length;
      }
      if(ikey==='i8'&&rkey==='f8'){
        const i=ints.indexOf(9007199254740993n),r=reals.indexOf(2**53),id=i*1000+r;
        const naive=await executor.all('SELECT i::float8 OPERATOR("pg_catalog".=) r FROM pg_temp.'+table.name+' WHERE id=$1::int4',[String(id)]);
        assert.deepEqual(naive.rows,[['t']]);assert.equal(expected(9007199254740993n,2**53,'='),false);naiveMismatches++;
        const zero=ints.indexOf(0n),good=zero*1000+reals.indexOf(.5),bad=zero*1000+reals.indexOf(-.5);
        const compose={kind:'logic',operator:'AND',children:[value('label','=', ['Sample']),value('id','IN',[good,bad]),cmp('<')]};
        const bound=await run(select(table,compose,5,0));assert.deepEqual(bound.compiled.parameters,['Sample',String(good),String(bad),'5','0']);assert.deepEqual(bound.rows.map(row=>row.id),[BigInt(good)]);
        cases.push({name:'bound text/IN filters and paging keep their indices around the mixed expression',queries:1});
      }
      cases.push({name:'exact '+ikey+'/'+rkey+' comparisons in both orders, including SQL NULL under NOT',comparisons:report.comparisons-before,physicalPairs:ints.length*reals.length});
    }
    assert.equal(naiveMismatches,1);cases.push({name:'independent oracle catches the implicit float-cast equality precision bug',controls:naiveMismatches});
    const constants=[[-(2n**63n),-(2**63)],[2n**63n-1n,2**63],[0n,next(-(2**63),false)],[0n,Number.MAX_VALUE],[0n,-Number.MAX_VALUE],
      [0n,Number.MIN_VALUE],[0n,-Number.MIN_VALUE],[0n,-0],[0n,NaN],[0n,Infinity],[0n,-Infinity],[null,null]];
    let folded=0;
    for(let index=0;index<constants.length;index++){
      const [i,r]=constants[index],table=mapped('rs_mixed_constant_'+index);
      await own('VIEW',table.name,'CREATE TEMP VIEW '+table.name+' AS SELECT '+index+'::int4 AS id,'+numericLiteral(i,'int8')+' AS i,'+numericLiteral(r,'float8')+' AS r,\'Sample\'::text AS label,1::int4 AS version');
      for(const operator of OPERATORS)for(const reverse of [false,true]){
        const where={kind:'logic',operator:'AND',children:[cmp(operator,reverse),value('id','=',[index])]},q=compilePostgres(select(table,where,1),{schema:'pg_temp'});
        assert.deepEqual(q.parameters,[String(index),'1','0']);const actual=decodePostgresStorage(await executor.all(q.sql,q.parameters),q.outputs,q.command);
        assert.deepEqual(actual.map(row=>row.id),expected(i,r,operator,reverse)===true?[BigInt(index)]:[]);report.rootSelects++;
        if(operator==='='&&!reverse){const plan=await executor.all('EXPLAIN (VERBOSE TRUE,COSTS FALSE,FORMAT JSON) '+q.sql,q.parameters),text=JSON.stringify(JSON.parse(plan.rows[0][0]));assert.ok(!text.includes('CASE')&&!text.includes('trunc'));folded++;}
      }
    }
    cases.push({name:'constant views fold guarded casts safely at int64 bounds, subnormal, null and nonfinite values',views:constants.length,foldedPlans:folded});
    const writes=mapped('rs_mixed_writes'),samples=[[-(2n**63n),-(2**63)],[2n**63n-1n,2**63],[9007199254740993n,2**53],[0n,.5],[0n,-.5],[0n,-0],[0n,Number.MIN_VALUE],[null,1],[1n,null]];
    await own('TABLE',writes.name,'CREATE TEMP TABLE '+writes.name+'(id int4 PRIMARY KEY,i int8,r float8,label text NOT NULL,version int4 NOT NULL)');
    const reset=async()=>{
      await executor.all('TRUNCATE pg_temp.'+writes.name,[]);
      const parameters=[],rows=samples.map(([i,r],id)=>{parameters.push(String(id),wire(i),wire(r));return '($'+(parameters.length-2)+'::int4,$'+(parameters.length-1)+'::int8,$'+parameters.length+'::float8,\'Sample\',1)';});
      await executor.all('INSERT INTO pg_temp.'+writes.name+' VALUES '+rows.join(','),parameters);
    };
    let updates=0,refused=0;
    for(const operator of OPERATORS)for(const reverse of [false,true]){
      await reset();const where=cmp(operator,reverse),wanted=samples.map(([i,r],id)=>expected(i,r,operator,reverse)===true?BigInt(id):null).filter(id=>id!==null);
      await executor.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const count=await run(queryModel.count({table:writes,where}));assert.equal(count.rows[0].n,BigInt(wanted.length));
      const update=await run(queryModel.update({table:writes,where,assignments:[{column:'label',value:'Changed'}]}));
      assert.deepEqual(update.rows.map(row=>row.id).sort((a,b)=>a<b?-1:1),wanted);assert.ok(update.rows.every(row=>row.version===2n));
      await executor.exec('COMMIT');updates++;
      if(wanted.length){
        await reset();await executor.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const observed=await run(queryModel.count({table:writes,where}));assert.ok(observed.rows[0].n>BigInt(wanted.length-1));
        await executor.exec('ROLLBACK');const unchanged=await run(queryModel.count({table:writes,where:value('label','=', ['Changed'])}));assert.equal(unchanged.rows[0].n,0n);refused++;
      }
    }
    cases.push({name:'count and guarded UPDATE agree exactly before commit; too-small guards change no rows',updates,guardRefusals:refused});
    await reset();await executor.all('INSERT INTO pg_temp.'+writes.name+' VALUES(999,0,\'Infinity\'::float8,\'Sample\',1)',[]);
    const nonfinite={kind:'logic',operator:'AND',children:[cmp('<'),value('id','=',[999])]};
    await executor.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');const count=await run(queryModel.count({table:writes,where:nonfinite}));assert.equal(count.rows[0].n,1n);
    await assert.rejects(run(queryModel.update({table:writes,where:nonfinite,assignments:[{column:'label',value:'Changed'}]})),error=>error?.code==='DATA');
    await executor.exec('ROLLBACK');const unchanged=await run(queryModel.count({table:writes,where:{kind:'logic',operator:'AND',children:[value('id','=',[999]),value('label','=', ['Sample'])]}}));assert.equal(unchanged.rows[0].n,1n);
    cases.push({name:'native nonfinite predicate order is separate from finite-return codec; decode refusal rolls back a write'});
    for(const name of ['rs_mixed_r_sequence','rs_mixed_i_sequence'])await own('SEQUENCE',name,'CREATE TEMP SEQUENCE '+name+' START 1');
    let volatileQueries=0;
    for(const mode of ['real','integer','both']){
      const table=mapped('rs_mixed_volatile_'+mode),i=mode==='real'?'0::int8':"(pg_catalog.nextval('pg_temp.rs_mixed_i_sequence')-1)",r=mode==='integer'?'0.5::float8':"(pg_catalog.nextval('pg_temp.rs_mixed_r_sequence')::float8/2)";
      await own('VIEW',table.name,'CREATE TEMP VIEW '+table.name+' AS SELECT 1::int4 AS id,'+i+' AS i,'+r+' AS r,\'Sample\'::text AS label,1::int4 AS version');
      for(const operator of ['<','>='])for(const reverse of [false,true])for(const family of ['count','select']){
        for(const key of ['r','i'])await executor.all('ALTER SEQUENCE pg_temp.rs_mixed_'+key+'_sequence RESTART WITH 1',[]);
        const where=cmp(operator,reverse),q=family==='count'?queryModel.count({table,where}):select(table,where,1),actual=await run(q),yes=expected(0n,.5,operator,reverse)===true;
        assert.deepEqual(family==='count'?actual.rows[0].n:actual.rows.map(row=>row.id),family==='count'?BigInt(yes):yes?[1n]:[]);
        for(const key of mode==='real'?['r']:mode==='integer'?['i']:['r','i'])assert.deepEqual((await executor.all("SELECT pg_catalog.currval('pg_temp.rs_mixed_"+key+"_sequence')",[])).rows,[['1']]);
        volatileQueries++;
      }
    }
    cases.push({name:'volatile real/integer/both view values are evaluated once per row, not per repeated renderer term',queries:volatileQueries});

    // The caller's 10,000 modeled values exclude bounded generated paging/update/relation values.
    assert.equal(MAX_BOUND_PARAMETERS,10_000);assert.equal(MAX_REQUEST_PARAMETERS,10_403);
    const columns=['id',...Array.from({length:99},(_,i)=>'c'+i)],wide=tableModel({name:'rs_mixed_budget',columns,primaryKey:['id'],
      kinds:Object.fromEntries(columns.map(column=>[column,'integer'])),nullable:Object.fromEntries(columns.map(column=>[column,false]))});
    await own('TABLE',wide.name,'CREATE TEMP TABLE '+wide.name+'(id int4 PRIMARY KEY,'+columns.slice(1).map(column=>column+' int4 NOT NULL DEFAULT 0').join(',')+')');
    await executor.all('INSERT INTO pg_temp.'+wide.name+'(id) VALUES(1)',[]);
    session=createAsyncSession(executor,{dialect:'postgresql',isResult:isPostgresRawResult});
    const fullWhere={kind:'logic',operator:'OR',children:Array.from({length:10},()=>value('id','IN',Array.from({length:1000},(_,i)=>i)))};
    const overWhere={kind:'logic',operator:'OR',children:[...fullWhere.children,value('id','=',[1])]};
    assert.throws(()=>queryModel.count({table:wide,where:overWhere}),error=>error?.code==='QUERY');
    const decode=(raw,q)=>decodePostgresStorage(raw,q.outputs,q.command,q.count?{count:true}:{});
    const page=compilePostgres(select(wide,fullWhere,1),{schema:'pg_temp'});
    assert.equal(page.parameters.length,10_002);
    assert.deepEqual(decode(await session.all(page.sql,page.parameters),page),[{id:1n}]);
    const update=compilePostgres(queryModel.update({table:wide,where:fullWhere,assignments:columns.slice(1).map((column,i)=>({column,value:i+1}))}),{schema:'pg_temp'});
    assert.equal(update.parameters.length,10_099);assert.equal(update.outputs.length,100);
    const countPlan=compilePostgres(queryModel.count({table:wide,where:fullWhere}),{schema:'pg_temp'}),rollback=new Error('Intentional boundary-fixture rollback');
    await assert.rejects(session.transaction(async tx=>{
      const observed=decode(await tx.all(countPlan.sql,countPlan.parameters),countPlan);assert.equal(observed[0].n,1n);
      const changed=decode(await tx.all(update.sql,update.parameters),update);assert.equal(changed.length,1);assert.equal(changed[0].id,1n);
      for(let i=0;i<99;i++)assert.equal(changed[0]['c'+i],BigInt(i+1));
      throw rollback;
    }),error=>error===rollback);
    assert.equal(await executor.inTransaction(),false);
    const after=compilePostgres(queryModel.select({table:wide,columns,where:value('id','=',[1]),orderBy:[{column:'id',direction:'ASC'}],limit:1,offset:0}),{schema:'pg_temp'});
    const budgetUnchanged=decode(await session.all(after.sql,after.parameters),after);assert.equal(budgetUnchanged.length,1);assert.equal(budgetUnchanged[0].id,1n);
    for(const column of columns.slice(1))assert.equal(budgetUnchanged[0][column],0n);
    const generated='SELECT 1::int4 AS "__rs_pg_0" WHERE 0::int4 OPERATOR("pg_catalog".=) ANY(ARRAY['
      +Array.from({length:MAX_REQUEST_PARAMETERS},(_,i)=>'$'+(i+1)+'::int4').join(',')+'])';
    const fullParameters=new Array(MAX_REQUEST_PARAMETERS).fill('0');
    assert.deepEqual(decodePostgresStorage(await session.all(generated,fullParameters),[{alias:'__rs_pg_0',property:'id',kind:'integer',nullable:false}],'SELECT'),[{id:1n}]);
    const beforeRefusals=requests,tooMany=new Array(MAX_REQUEST_PARAMETERS+1).fill('0');
    await assert.rejects(session.all('SELECT 1',tooMany),error=>error?.code==='VALIDATION');
    await assert.rejects(executor.all('SELECT 1',tooMany),error=>error?.code==='VALIDATION');
    assert.equal(requests,beforeRefusals,'Over-budget requests must be refused before transport I/O');
    cases.push({name:'modeled 10000-value budget permits generated SELECT/UPDATE overhead and the bounded physical session limit',
      selectParameters:page.parameters.length,updateParameters:update.parameters.length,physicalParameters:fullParameters.length,
      preIoRefusals:2,callerModelRefusals:1,rollbackVerified:true});
  }catch(error){original=error;}
  finally{
    if(executor){
      try{if(await executor.inTransaction())await executor.exec('ROLLBACK');cleanup.transactionEnded=true;}catch(error){original??=error;}
      try{
        for(const {type,name}of [...objects].reverse())await executor.all('DROP '+type+' pg_temp.'+name,[]);
        for(const {name}of objects)assert.deepEqual((await executor.all('SELECT pg_catalog.to_regclass($1::text)::text',['pg_temp.'+name])).rows,[[null]]);
        cleanup.temporaryObjectsDropped=true;
      }catch(error){original??=error;}
      try{await(session?session.close():executor.close());assert.equal(closeCalls,1);cleanup.ownedTransportClosed=true;cleanup.ownedTransportCloseCalls=closeCalls;}catch(error){original??=error;}
    }else if(transport){try{await transport.close();cleanup.ownedTransportClosed=true;}catch(error){original??=error;}}
  }
  if(original)throw original;
  return report;
}
