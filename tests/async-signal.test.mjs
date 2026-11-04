import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist=process.env.ROWSTITCH_TEST_DIST?pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST)+'/'):new URL('../dist/',import.meta.url);
const {createAsyncSession}=await import(new URL('core/async-session.js',dist));
const {openSqliteExecutor}=await import(new URL('core/sqlite-executor.js',dist));
const {inlineAsyncExecutor}=await import(new URL('core/executor.js',dist));
const secret='fictional-signal-secret';
const code=wanted=>error=>{assert.equal(error?.code,wanted);assert.ok(!inspect(error,{showHidden:true,depth:8}).includes(secret));return true;};
function deferred(){let resolve;const promise=new Promise(ok=>{resolve=ok;});return {promise,resolve};}
function fixture(t,options){
  const native=openSqliteExecutor(':memory:');native.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)');
  const base=inlineAsyncExecutor(native),log=[];
  const session=createAsyncSession({all:(sql,values)=>{log.push(sql);return base.all(sql,values);},exec:sql=>{log.push(sql);return base.exec(sql);},
    inTransaction:()=>base.inTransaction(),close:()=>base.close()},options);
  t.after(()=>session.close());return {session,log};
}
function hostileCases(counter){
  const getter=()=>{counter.calls++;throw new Error(secret);};
  const accessor=name=>{const signal=new AbortController().signal;Object.defineProperty(signal,name,{get:getter,configurable:true});return {signal};};
  const traps={get:getter,getPrototypeOf:getter,ownKeys:getter,getOwnPropertyDescriptor:getter,has:getter};
  return [
    {get signal(){return getter();}},
    accessor('aborted'),accessor('addEventListener'),accessor('removeEventListener'),
    {signal:new Proxy(new AbortController().signal,traps)},new Proxy({signal:new AbortController().signal},traps),
    {signal:Object.create(AbortSignal.prototype)},
    {signal:Object.freeze(new AbortController().signal)},
    {signal:Object.preventExtensions(new AbortController().signal)},
    {signal:{get aborted(){return getter();},addEventListener:getter}},
    {signal:null},
  ];
}
function throwingMethods(signal,counter){
  for(const name of ['addEventListener','removeEventListener'])Object.defineProperty(signal,name,{value:()=>{counter.calls++;throw new Error(secret);},configurable:true});
}

test('captured platform operations ignore throwing signal methods and shadowed aborted data',async t=>{
  const {session}=fixture(t),controller=new AbortController(),counter={calls:0};throwingMethods(controller.signal,counter);
  Object.defineProperty(controller.signal,'aborted',{value:true,configurable:true});
  assert.equal(await session.transaction(async tx=>{
    await tx.all('INSERT INTO sample VALUES(?)',[1],{signal:controller.signal});
    return tx.transaction(child=>child.all('SELECT id FROM sample'),{signal:controller.signal});
  },{signal:controller.signal}).then(rows=>rows[0].id),1n);
  assert.equal(counter.calls,0);assert.deepEqual((await session.all('SELECT id FROM sample')).map(row=>row.id),[1n]);
});

test('hostile operation options and forged/proxied signals reject as promises before SQL without invoking supplied code',async t=>{
  const {session,log}=fixture(t),counter={calls:0};
  for(const options of hostileCases(counter))for(const kind of ['all','transaction']){
    const before=log.length;let pending;
    assert.doesNotThrow(()=>{pending=kind==='all'?session.all('SELECT 1',[],options):session.transaction(()=>assert.fail('Invalid signal callback ran'),options);});
    assert.ok(pending instanceof Promise);await assert.rejects(pending,code('VALIDATION'));assert.equal(log.length,before);
    assert.deepEqual((await session.all('SELECT 7 AS n')).map(row=>row.n),[7n]);
  }
  assert.equal(counter.calls,0);
});

test('invalid signals leave nested transaction and statement admission usable without SAVEPOINT or supplied code',async t=>{
  const {session,log}=fixture(t),counter={calls:0};
  await session.transaction(async tx=>{
    for(const options of hostileCases(counter)){
      const before=log.length;let statement,child;
      assert.doesNotThrow(()=>{statement=tx.all('INSERT INTO sample VALUES(99)',[],options);});
      await assert.rejects(statement,code('VALIDATION'));
      assert.doesNotThrow(()=>{child=tx.transaction(()=>assert.fail('Invalid child ran'),options);});
      await assert.rejects(child,code('VALIDATION'));assert.equal(log.length,before);
    }
    await tx.all('INSERT INTO sample VALUES(1)');
  });
  assert.equal(counter.calls,0);assert.ok(!log.some(sql=>sql.startsWith('SAVEPOINT')));
  assert.deepEqual((await session.all('SELECT id FROM sample')).map(row=>row.id),[1n]);
});

test('genuine abort still rolls back completed writes despite overridden signal methods and false aborted shadow',async t=>{
  const {session,log}=fixture(t),controller=new AbortController(),counter={calls:0};throwingMethods(controller.signal,counter);
  Object.defineProperty(controller.signal,'aborted',{value:false,configurable:true});
  await assert.rejects(session.transaction(async tx=>{
    await tx.all('INSERT INTO sample VALUES(1)');controller.abort(new Error(secret));return 'must not commit';
  },{signal:controller.signal}),code('ABORTED'));
  assert.ok(log.includes('ROLLBACK'));assert.equal(counter.calls,0);assert.deepEqual(await session.all('SELECT id FROM sample'),[]);
  const before=log.length;await assert.rejects(session.all('SELECT 1',[],{signal:controller.signal}),code('ABORTED'));assert.equal(log.length,before);
  assert.equal(await session.transaction(async tx=>(await tx.all('SELECT 8 AS n'))[0].n),8n);
});

test('queued abort removes its entry with captured listeners and preserves FIFO capacity',async t=>{
  const {session,log}=fixture(t,{maxQueue:1}),entered=deferred(),release=deferred(),controller=new AbortController(),counter={calls:0};
  throwingMethods(controller.signal,counter);
  const owner=session.transaction(async()=>{entered.resolve();await release.promise;});
  try{
    await entered.promise;const queued=session.all('INSERT INTO sample VALUES(99)',[],{signal:controller.signal});controller.abort();
    await assert.rejects(queued,code('ABORTED'));assert.ok(!log.includes('INSERT INTO sample VALUES(99)'));
    const next=session.all('SELECT 9 AS n');release.resolve();await owner;assert.equal((await next)[0].n,9n);
  }finally{release.resolve();await owner;}
  assert.equal(counter.calls,0);
});

test('public signal getters introduced after admission cannot interrupt native cleanup or leak frame state',async t=>{
  const {session}=fixture(t),controller=new AbortController(),counter={calls:0};
  await session.transaction(async tx=>{
    await tx.all('INSERT INTO sample VALUES(1)');
    for(const name of ['aborted','addEventListener','removeEventListener'])Object.defineProperty(controller.signal,name,{get:()=>{counter.calls++;throw new Error(secret);},configurable:true});
  },{signal:controller.signal});
  assert.equal(counter.calls,0);assert.equal(await session.transaction(async tx=>(await tx.all('SELECT id FROM sample'))[0].id),1n);
});
