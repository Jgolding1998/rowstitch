// Real inheritance regression for the narrow compiler. This does not verify the physical mapping.
import assert from 'node:assert/strict';
import { createAsyncSession } from '../../dist/core/async-session.js';
import { createPostgresExecutor } from '../../dist/core/postgres-executor.js';
import { isPostgresRawResult } from '../../dist/core/postgres-result.js';
import { column,defineTable } from '../../dist/core/schema.js';
import { compilePostgresRoot,planPostgresByKey,planPostgresCount } from '../../dist/core/postgres-root-plan.js';
import { executePostgresRoot } from '../../dist/core/postgres-root-execution.js';
export async function checkInheritanceRoots(connect) {
  const transport=await connect();
  const session=createAsyncSession(createPostgresExecutor(transport),{dialect:'postgresql',isResult:isPostgresRawResult});
  let failed=false;
  try {
    await transport.query('CREATE TABLE public.inheritance_parent(id BIGINT PRIMARY KEY,label TEXT NOT NULL)',[]);
    await transport.query('CREATE TABLE public.inheritance_child() INHERITS(public.inheritance_parent)',[]);
    await transport.query('INSERT INTO public.inheritance_parent VALUES($1::bigint,$2::text)',['1','SYNTHETIC_PARENT']);
    await transport.query('INSERT INTO public.inheritance_child VALUES($1::bigint,$2::text),($3::bigint,$4::text)',['1','SYNTHETIC_DUPLICATE','2','SYNTHETIC_CHILD']);
    // Native positive controls demonstrate that ordinary SELECT actually includes descendants.
    assert.equal((await transport.query('SELECT count(*)::text FROM public.inheritance_parent',[])).rows[0][0],'3');
    assert.equal((await transport.query('SELECT count(*)::text FROM ONLY public.inheritance_parent',[])).rows[0][0],'1');
    assert.equal((await transport.query('SELECT count(*)::text FROM public.inheritance_parent WHERE id=1',[])).rows[0][0],'2');
    const mapped=defineTable('inheritance_parent',{id:column.integer().primaryKey(),label:column.text()});
    assert.equal(await executePostgresRoot(session,compilePostgresRoot(planPostgresCount(mapped))),1);
    assert.equal(await executePostgresRoot(session,compilePostgresRoot(planPostgresByKey(mapped,{id:2}))),null);
    assert.deepEqual(await executePostgresRoot(session,compilePostgresRoot(planPostgresByKey(mapped,{id:1}))),{id:1,label:'SYNTHETIC_PARENT'});
    return {cases:['native SELECT positive controls include child rows while compiled count includes only its mapped table','a key present only in an inherited child does not match the mapped parent','an inherited duplicate cannot replace or invalidate the parent key result']};
  } catch(error) { failed=true;throw error; }
  finally { try { await session.close();await transport.close(); } catch(error) { if(!failed)throw error; } }
}
