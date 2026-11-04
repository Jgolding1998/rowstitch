import test from 'node:test';
import assert from 'node:assert/strict';
import { RowstitchError } from '../dist/core/errors.js';
import { acknowledgedRejection, isAcknowledgedRejection } from '../dist/core/executor.js';
import { createPostgresExecutor } from '../dist/core/postgres-executor.js';
import { postgresRealAggregateError } from '../dist/core/postgres-acknowledgment.js';
import { createPostgresDialect } from '../dist/core/postgres-dialect.js';
import { queryModel, tableModel } from '../dist/core/query-model.js';

// Simulated private transport: tests evidence/identity handling, not native arithmetic.
function fixture(sqlstate='22003',{afterCommandComplete=false,confirmed=true,badTransition=false}={}) {
  let state='I', rejects=true;
  const original=Object.assign(new Error('SYNTHETIC_PRIVATE_VALUE'),{code:sqlstate});
  const executor=createPostgresExecutor({
    async query(sql) {
      if(sql==='BEGIN READ ONLY'){state='T';return {fields:[],rows:[],commandTag:'BEGIN'};}
      if(sql==='ROLLBACK'){state='I';return {fields:[],rows:[],commandTag:'ROLLBACK'};}
      if(rejects){if(state==='T'&&!badTransition)state='E';throw original;}
      return {fields:[],rows:[],commandTag:'SELECT 0'};
    },
    transactionStatus(){return state;},
    serverError(error){return confirmed&&error===original?{sqlstate,afterCommandComplete}:undefined;},
    async close(){},
  });
  return {executor,recover(){rejects=false;},state:()=>state};
}
const capture=async promise=>{try{await promise;assert.fail('Expected rejection');}catch(error){return error;}};

test('only the genuine confirmed 22003 error identity can be classified as aggregate range',async()=>{
  const d=fixture(),error=await capture(d.executor.all('SELECT generated_summary',[]));
  assert.equal(error.code,'DATABASE_ERROR');assert.ok(isAcknowledgedRejection(error));
  const mapped=postgresRealAggregateError(error);
  assert.equal(mapped.code,'AGGREGATE_RANGE');assert.notEqual(mapped,error);
  assert.ok(!isAcknowledgedRejection(mapped),'classification happens after the session processed original acknowledgment');
  assert.deepEqual(Object.keys(mapped).sort(),['code','name']);
  assert.ok(!JSON.stringify(mapped).includes('22003'));assert.ok(!mapped.message.includes('SYNTHETIC'));
  for(const lookalike of [new RowstitchError('22003','SYNTHETIC_PRIVATE_VALUE'),new RowstitchError('DATABASE_ERROR','SYNTHETIC_PRIVATE_VALUE'),
    {code:'22003'},acknowledgedRejection(new RowstitchError('DATABASE_ERROR','22003'))])assert.equal(postgresRealAggregateError(lookalike),lookalike);
  d.recover();assert.equal((await d.executor.all('SELECT healthy',[])).rowCount,0n);await d.executor.close();
});

test('other confirmed SQLSTATEs retain their original safe error codes and identities',async()=>{
  for(const [state,expected] of [['23505','CONSTRAINT'],['42601','DATABASE_ERROR'],['25P02','DATABASE_ERROR'],['40001','SERIALIZATION_FAILURE']]){
    const d=fixture(state),error=await capture(d.executor.all('SELECT generated_summary',[]));
    assert.equal(error.code,expected);assert.equal(postgresRealAggregateError(error),error);await d.executor.close();
  }
});

test('unconfirmed transport errors, wrong state transitions and implicit commit failures never become aggregate range',async()=>{
  for(const options of [{confirmed:false},{afterCommandComplete:true}]){
    const d=fixture('22003',options),error=await capture(d.executor.all('SELECT generated_summary',[]));
    assert.ok(!isAcknowledgedRejection(error));assert.equal(postgresRealAggregateError(error),error);
    d.recover();await assert.rejects(d.executor.all('SELECT healthy',[]));await d.executor.close();
  }
  const d=fixture('22003',{badTransition:true});await d.executor.exec('BEGIN READ ONLY');
  const error=await capture(d.executor.all('SELECT generated_summary',[]));
  assert.ok(!isAcknowledgedRejection(error));assert.equal(postgresRealAggregateError(error),error);await d.executor.close();
});

test('range classification does not heal an engine-aborted transaction',async()=>{
  const d=fixture();await d.executor.exec('BEGIN READ ONLY');
  const error=await capture(d.executor.all('SELECT generated_summary',[]));
  assert.equal(postgresRealAggregateError(error).code,'AGGREGATE_RANGE');assert.equal(d.state(),'E');
  await d.executor.exec('ROLLBACK');assert.equal(d.state(),'I');
  d.recover();await d.executor.all('SELECT healthy',[]);await d.executor.close();
});

test('only compiled real SUM/AVG operations receive the narrow range classifier',()=>{
  const table=tableModel({name:'summary_samples',columns:['id','amount','wide'],primaryKey:['id'],
    kinds:{id:'integer',amount:'real',wide:'bigint'},nullable:{id:false,amount:true,wide:true}});
  const dialect=createPostgresDialect();
  for(const operation of ['sum','avg']){
    const compiled=dialect.compile(queryModel.aggregate({table,select:[{alias:'answer',operation,column:'amount'}]}));
    assert.equal(compiled.mapError,postgresRealAggregateError);
  }
  for(const selection of [{alias:'answer',operation:'count'}, {alias:'answer',operation:'sum',column:'wide'},
    {alias:'answer',operation:'avg',column:'wide',approximate:true},{alias:'answer',operation:'min',column:'amount'}]){
    assert.equal(dialect.compile(queryModel.aggregate({table,select:[selection]})).mapError,undefined);
  }
  assert.equal(dialect.compile(queryModel.select({table,columns:['amount'],orderBy:[],limit:1,offset:0})).mapError,undefined);
});
