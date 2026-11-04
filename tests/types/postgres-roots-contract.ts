import { column,defineTable } from '../../src/core/schema.js';
import type { AsyncSession } from '../../src/core/async-session.js';
import type { PostgresRawResult } from '../../src/core/postgres-result.js';
import { openPostgresRoots } from '../../src/core/postgres-roots.js';
declare const session:AsyncSession<PostgresRawResult>;
const table=defineTable('typed_roots',{tenant:column.text().primaryKey(),id:column.integer().primaryKey(),enabled:column.boolean(),data:column.json<{label:string}>(),optional:column.text().nullable()});
async function check(){
  const roots=await openPostgresRoots(session,{tables:[table]});
  const row=await roots.insert(table,{tenant:'north',id:1,enabled:true,data:{label:'fictional'},optional:null});
  const enabled:boolean=row.enabled;
  const found=await roots.byKey(table,{tenant:'north',id:1});
  const label:string|null=found?.optional??null;
  const count:number=await roots.count(table);
  const value:number=await roots.transaction(async tx=>{await tx.count(table);return 3;});
  // @ts-expect-error Explicit inserts require even nullable fields in this prototype.
  await roots.insert(table,{tenant:'north',id:1,enabled:true,data:{label:'fictional'}});
  // @ts-expect-error Native boolean mapping does not accept numeric booleans.
  await roots.insert(table,{tenant:'north',id:1,enabled:1,data:{label:'fictional'},optional:null});
  // @ts-expect-error Typed JSON insert shapes still apply.
  await roots.insert(table,{tenant:'north',id:1,enabled:true,data:{label:1},optional:null});
  // @ts-expect-error All composite key components are required.
  await roots.byKey(table,{id:1});
  // @ts-expect-error Key values retain logical types.
  await roots.byKey(table,{tenant:'north',id:'1'});
  // @ts-expect-error Counts are numbers, not strings.
  const badCount:string=await roots.count(table);
  // @ts-expect-error Transaction results retain their awaited return type.
  const badTransaction:string=await roots.transaction(()=>2);
  void [enabled,label,count,value,badCount,badTransaction];
}
void check;
