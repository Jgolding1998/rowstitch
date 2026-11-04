/** Private mapped-root context. Six kinds, explicit inserts, no public driver or arbitrary SQL. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RowstitchError } from './errors.js';
import { trackTransactionPromise, type AsyncOperationOptions, type AsyncSession, type AsyncTransaction } from './async-session.js';
import { identifier,isTable,plainRecord,type AnyTable,type KeyRow,type Row } from './schema.js';
import type { PostgresRawResult } from './postgres-result.js';
import { compilePostgresRoot,decodePostgresRoot,planPostgresByKey,planPostgresCount,planPostgresInsert,type PostgresRootPlan } from './postgres-root-plan.js';
import { comparePostgresPhysical,comparePostgresSettings,postgresPhysicalFingerprint } from './postgres-physical.js';
import { readPostgresPhysical,readPostgresSettings } from './postgres-catalog.js';

export interface PostgresRootsOptions { readonly tables:readonly AnyTable[]; readonly schema?:string; readonly readOnly?:boolean }
interface Lease { active:boolean }
interface State {
  readonly schema:string; readonly readOnly:boolean; readonly tables:readonly AnyTable[];
  readonly fingerprints:Map<AnyTable,string>; readonly context:AsyncLocalStorage<Lease>;
  searchPath:string; drift:RowstitchError | undefined; closing:AbortController | undefined;
}
const CONSTRUCT=Symbol('rowstitch.postgres-roots');
const failure=(code:string,message:string):RowstitchError=>new RowstitchError(code,message);
function operationOptions(input:AsyncOperationOptions | undefined):AsyncOperationOptions | undefined {
  if(input===undefined)return undefined;
  try {
    plainRecord(input);
    if(Object.keys(input).some(key=>key!=='signal'))throw new Error();
    const signal=input.signal;
    if(signal!==undefined)Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!.call(signal);
    return Object.freeze(signal===undefined?{}:{signal});
  } catch {throw failure('VALIDATION','Invalid PostgreSQL operation options.');}
}
function configuration(input:PostgresRootsOptions):Pick<State,'schema'|'readOnly'|'tables'> {
  try {
    plainRecord(input);
    if(Object.keys(input).some(key=>!['tables','schema','readOnly'].includes(key)))throw new Error();
    const schema=input.schema===undefined?'public':input.schema;
    identifier(schema);
    if(/^(?:pg_|information_schema$)/i.test(schema))throw new Error();
    if(input.readOnly!==undefined&&typeof input.readOnly!=='boolean')throw new Error();
    const values=input.tables;
    if(!Array.isArray(values)||![null,Array.prototype].includes(Object.getPrototypeOf(values))||values.length<1||values.length>64)throw new Error();
    const descriptors=Object.getOwnPropertyDescriptors(values);
    if(Reflect.ownKeys(descriptors).length!==values.length+1)throw new Error();
    const tables=Array.from({length:values.length},(_,i)=>{
      const d=descriptors[String(i)];
      if(!d||!('value' in d)||!d.enumerable||!isTable(d.value))throw new Error();
      return d.value as AnyTable;
    });
    if(new Set(tables.map(table=>table.name)).size!==tables.length)throw new Error();
    tables.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    return {schema,readOnly:input.readOnly??false,tables:Object.freeze(tables)};
  }catch {throw failure('VALIDATION','Invalid PostgreSQL mapped-root configuration.');}
}
function latch(state:State,code:'SCHEMA'|'DATA',reason:string):never {
  state.drift??=failure(code,'PostgreSQL verification refused this context: '+reason+'.');
  state.closing?.abort();
  throw state.drift;
}
async function checkSettings(state:State,owner:AsyncTransaction<PostgresRawResult>,options?:AsyncOperationOptions):Promise<void> {
  try {
    const reason=comparePostgresSettings(await readPostgresSettings(owner,options),state.searchPath);
    if(reason)latch(state,'DATA',reason);
  }catch(error){
    if(error instanceof RowstitchError&&error.code==='DATA')latch(state,'DATA','SETTINGS');
    throw error;
  }
}
async function prepare(state:State,owner:AsyncTransaction<PostgresRawResult>,tables:readonly AnyTable[],write:boolean,options?:AsyncOperationOptions):Promise<void> {
  if(state.drift)throw state.drift;
  // All locks precede the first SELECT of the serializable transaction. Names are captured authenticated mappings.
  for(const table of tables)await owner.all('LOCK TABLE ONLY '+identifier(state.schema)+'.'+identifier(table.name)
    +(write?' IN ROW EXCLUSIVE MODE':' IN ACCESS SHARE MODE'),[],options);
  for(const table of tables){
    try {
      const snapshot=await readPostgresPhysical(owner,table,state.schema,options);
      const reason=comparePostgresPhysical(table,state.schema,snapshot);
      if(reason)latch(state,'SCHEMA',reason);
      if(postgresPhysicalFingerprint(snapshot!)!==state.fingerprints.get(table))latch(state,'SCHEMA','FINGERPRINT');
    }catch(error){
      if(error instanceof RowstitchError&&error.code==='SCHEMA')latch(state,'SCHEMA','PHYSICAL');
      throw error;
    }
  }
  await checkSettings(state,owner,options);
}

export class PostgresRoots {
  #state:State; #handle:AsyncTransaction<PostgresRawResult>; #lease:Lease | undefined;
  /** Internal: use openPostgresRoots. The owner must be a trusted dedicated Rowstitch session. */
  constructor(token:symbol,state:State,handle:AsyncTransaction<PostgresRawResult>,lease?:Lease){
    if(token!==CONSTRUCT)throw failure('VALIDATION','Use openPostgresRoots.');
    this.#state=state;this.#handle=handle;this.#lease=lease;
  }
  #check(table?:AnyTable):void {
    const current=this.#state.context.getStore();
    if(this.#lease&&!this.#lease.active||current&&!current.active)throw failure('TRANSACTION_CLOSED','This PostgreSQL transaction handle has finished.');
    if(this.#lease&&!current)throw failure('TRANSACTION_CONTEXT','Use this PostgreSQL handle inside its callback.');
    if(current&&current!==this.#lease)throw failure('TRANSACTION_ACTIVE','Use the current PostgreSQL transaction handle.');
    if(this.#state.drift)throw this.#state.drift;
    if(table!==undefined&&!this.#state.fingerprints.has(table))throw failure('SCHEMA','Use a table registered in this PostgreSQL context.');
  }
  #scoped<T>(work:()=>Promise<T>):Promise<T>{
    let promise:Promise<T>;
    try{promise=work();}catch(error){promise=Promise.reject(error);}
    return trackTransactionPromise(this.#handle,promise);
  }
  #query(table:AnyTable,build:()=>PostgresRootPlan,inputOptions?:AsyncOperationOptions):Promise<Record<string,unknown>|number|null>{
    return this.#scoped(()=>{
      this.#check(table);
      const options=operationOptions(inputOptions),compiled=compilePostgresRoot(build());
      const write=compiled.operation==='insert';
      if(write&&this.#state.readOnly)throw failure('READ_ONLY','This PostgreSQL context is read-only.');
      const execute=async(owner:AsyncTransaction<PostgresRawResult>)=>{
        // Checking after the statement, before decoding/COMMIT, prevents precision drift becoming a successful value.
        const raw=await owner.all(compiled.sql,compiled.parameters,options);
        await checkSettings(this.#state,owner,options);
        this.#check(table);
        return decodePostgresRoot(compiled,raw);
      };
      if(!this.#lease)return this.#handle.transaction(async tx=>{
        await prepare(this.#state,tx,[table],write,options);
        return execute(tx);
      },options);
      if(write)return this.#handle.transaction(async tx=>{
        await checkSettings(this.#state,tx,options);
        return execute(tx);
      },options);
      return (async()=>{await checkSettings(this.#state,this.#handle,options);return execute(this.#handle);})();
    });
  }
  /** Current prototype requires every field explicitly and refuses generated inserts. */
  insert<T extends AnyTable>(table:T,data:Row<T>,options?:AsyncOperationOptions):Promise<Row<T>>{
    return this.#query(table,()=>planPostgresInsert(table,data,this.#state.schema),options) as Promise<Row<T>>;
  }
  byKey<T extends AnyTable>(table:T,key:KeyRow<T>,options?:AsyncOperationOptions):Promise<Row<T>|null>{
    return this.#query(table,()=>planPostgresByKey(table,key,this.#state.schema),options) as Promise<Row<T>|null>;
  }
  count(table:AnyTable,options?:AsyncOperationOptions):Promise<number>{
    return this.#query(table,()=>planPostgresCount(table,this.#state.schema),options) as Promise<number>;
  }
  transaction<T>(callback:(roots:PostgresRoots)=>T|PromiseLike<T>,inputOptions?:AsyncOperationOptions):Promise<Awaited<T>>{
    return this.#scoped(()=>{
      this.#check();
      if(typeof callback!=='function')throw failure('VALIDATION','A PostgreSQL transaction requires a callback.');
      const options=operationOptions(inputOptions);
      const closing=this.#lease?undefined:new AbortController(),state=this.#state;
      const frameOptions=!closing?options:{signal:options?.signal?AbortSignal.any([options.signal,closing.signal]):closing.signal};
      const run=this.#handle.transaction(async handle=>{
        this.#check();
        if(!this.#lease)await prepare(this.#state,handle,this.#state.tables,!this.#state.readOnly,options);
        else await checkSettings(this.#state,handle,options);
        const lease={active:true},roots=new PostgresRoots(CONSTRUCT,this.#state,handle,lease);
        try{return await this.#state.context.run(lease,async()=>{
          const value=await callback(roots);
          roots.#check();
          // A latch in the remaining promise-settlement microtasks must still veto COMMIT synchronously.
          if(closing)state.closing=closing;
          // Do not await library work after the user's callback settles: that could drain forgotten operations
          // before the underlying session detects them. Every issued mapped operation already checks settings.
          return value;
        });}finally{lease.active=false;}
      },frameOptions);
      if(!closing)return run;
      const clear=()=>{if(state.closing===closing)state.closing=undefined;};
      return run.then(value=>{clear();return value;},error=>{
        clear();
        let cleanAbort=false;
        if(closing.signal.aborted&&state.drift)try{
          cleanAbort=error instanceof RowstitchError&&Object.getOwnPropertyDescriptor(error,'code')?.value==='ABORTED'
            &&!Object.hasOwn(error,'rowstitchCleanup');
        }catch{/* A callback's thrown proxy must retain its own failure. */}
        // Preserve unknown/failed rollback metadata; a known drift is not evidence that cleanup succeeded.
        throw cleanAbort?state.drift:error;
      });
    });
  }
}

/** Open-time structural subset, then per-operation guards. No lasting schema or authorization certification. */
export async function openPostgresRoots(owner:AsyncSession<PostgresRawResult>,input:PostgresRootsOptions,inputOptions?:AsyncOperationOptions):Promise<PostgresRoots>{
  const config=configuration(input),options=operationOptions(inputOptions);
  const state:State={...config,fingerprints:new Map(),context:new AsyncLocalStorage(),searchPath:'',drift:undefined,closing:undefined};
  await owner.transaction(async handle=>{
    const settings=await readPostgresSettings(handle,options),reason=comparePostgresSettings(settings);
    if(reason)throw failure('DATA','PostgreSQL settings are not supported: '+reason+'.');
    state.searchPath=settings.searchPath;
    for(const table of state.tables){
      const snapshot=await readPostgresPhysical(handle,table,state.schema,options),reason=comparePostgresPhysical(table,state.schema,snapshot);
      if(reason)throw failure('SCHEMA','PostgreSQL mapping is not supported: '+reason+'.');
      state.fingerprints.set(table,postgresPhysicalFingerprint(snapshot!));
    }
    await checkSettings(state,handle,options);
  },options);
  return new PostgresRoots(CONSTRUCT,state,owner);
}
