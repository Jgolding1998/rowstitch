// Independent grouped-result oracle on two fictional fixtures. No timing or general ranking.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const options={},args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){assert(['--entry','--reference-dir','--output'].includes(args[i])&&args[i+1],'Use [--entry BUILT_INDEX] [--reference-dir DIRECTORY] [--output FILE]');options[args[i].slice(2)]=resolve(args[i+1]);}
const entry=options.entry??fileURLToPath(new URL('../dist/index.js',import.meta.url));
const own=JSON.parse(readFileSync(join(dirname(entry),'../package.json'),'utf8'));
const {agg,column,defineTable,openDatabase,hasMany,eq}=await import(pathToFileURL(entry));
let orange;
if(options['reference-dir']){
  const require=createRequire(join(options['reference-dir'],'package.json')),ref=require.resolve('orange-orm');
  assert.equal(JSON.parse(readFileSync(join(dirname(ref),'../package.json'),'utf8')).version,'5.5.1');
  ({default:orange}=await import(pathToFileURL(ref)));
}
const report={format:'rowstitch-grouped-related-comparison',version:1,environment:{node:process.version,rowstitch:own.version},reference:orange?'orange-orm@5.5.1':null,
  scope:'Root and grouped related aggregates on two fixed SQLite fixtures. Checks count complete output rows, not independent use cases. No speed ranking.',
  limitations:['Shared integers stay in the safe number range; exact large sums, storage guards and collations are tested independently.',
    'The two-collection observation compares independent path totals with the explicitly computed cross-product of the two LEFT JOIN domains. It is scoped to the pinned SQLite release and these fixtures.',
    'Related domain filters are tested against the independent oracle only. They are not claimed to reproduce the Orange API.',
    'Unexpected outcomes throw and write no success report. NULL/NaN/zero representation differences are recorded separately.',
    ...(!orange?['Orange was not loaded. Use --reference-dir for the pinned comparison.']:[])],fixtures:[],
  summary:{rowstitchOracleRows:0,referenceEqualRows:0,referenceNormalizedRows:0,observedJoinMultiplicityRows:0,queryScenarios:0}};
const folder=mkdtempSync(join(tmpdir(),'rowstitch-grouped-compare-'));
const normalized=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():typeof v==='number'&&!Number.isFinite(v)?String(v):v));
const sum=values=>values.length?values.reduce((a,b)=>a+BigInt(b),0n):null;
const avg=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const nonnull=(rows,key)=>rows.flatMap(row=>row[key]===null?[]:[row[key]]);
let sql=[],failure;const listener=e=>{if(/^\s*(?:SELECT|WITH|EXPLAIN)\b/i.test(e.sql))sql.push(e.sql);};orange?.on('query',listener);
try{
  for(const [name,size,seed] of [['small',11,37],['uneven',29,191]]){
    const file=join(folder,name+'.sqlite'),raw=new DatabaseSync(file,{enableExtensions:false});let db,ref,fixtureFailure;
    try{
      raw.exec('CREATE TABLE gp(id INTEGER NOT NULL PRIMARY KEY,category TEXT,active INTEGER NOT NULL); CREATE TABLE gc(id INTEGER NOT NULL PRIMARY KEY,parentId INTEGER,amount INTEGER,score REAL,approved INTEGER NOT NULL); CREATE TABLE gm(id INTEGER NOT NULL PRIMARY KEY,parentId INTEGER NOT NULL,amount INTEGER NOT NULL);');
      const parents=Array.from({length:size},(_,i)=>({id:i+1,category:i===size-1?'Empty':i%7===0?null:'Group '+i%4,active:i%3!==0})),children=[],payments=[];
      for(const p of parents){
        for(let i=0;i<(p.category==='Empty'?0:p.id*seed%6);i++)children.push({id:children.length+1,parentId:p.id,amount:i%3===0?null:(p.id*13+i*7)%71-20,score:i%3===0?null:i+.25,approved:i%2===0});
        for(let i=0;i<(p.category==='Empty'?0:p.id%4);i++)payments.push({id:payments.length+1,parentId:p.id,amount:i+2});
      }
      children.push({id:children.length+1,parentId:null,amount:999,score:999,approved:true},{id:children.length+2,parentId:10000,amount:999,score:999,approved:true});
      for(const p of parents)raw.prepare('INSERT INTO gp VALUES(?,?,?)').run(p.id,p.category,Number(p.active));
      for(const c of children)raw.prepare('INSERT INTO gc VALUES(?,?,?,?,?)').run(c.id,c.parentId,c.amount,c.score,Number(c.approved));
      for(const p of payments)raw.prepare('INSERT INTO gm VALUES(?,?,?)').run(p.id,p.parentId,p.amount);
      const parent=defineTable('gp',{id:column.integer().primaryKey(),category:column.text().nullable(),active:column.boolean()}),child=defineTable('gc',{id:column.integer().primaryKey(),parentId:column.integer().nullable(),amount:column.integer().nullable(),score:column.real().nullable(),approved:column.boolean()}),payment=defineTable('gm',{id:column.integer().primaryKey(),parentId:column.integer(),amount:column.integer()});
      db=openDatabase(file,{tables:[parent,child,payment],readOnly:true});
      const relation=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId')}),paid=hasMany(payment,{localKey:parent.col('id'),foreignKey:payment.col('parentId')}),approved=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId'),where:eq(child.col('approved'),true)});
      const map=orange?.map(x=>({gp:x.table('gp').map(({column:c})=>({id:c('id').numeric().primary(),category:c('category').string(),active:c('active').boolean()})),gc:x.table('gc').map(({column:c})=>({id:c('id').numeric().primary(),parentId:c('parentId').numeric(),amount:c('amount').numeric(),score:c('score').numeric(),approved:c('approved').boolean()})),gm:x.table('gm').map(({column:c})=>({id:c('id').numeric().primary(),parentId:c('parentId').numeric(),amount:c('amount').numeric()}))})).map(x=>({gp:x.gp.map(v=>({children:v.hasMany(x.gc).by('parentId'),payments:v.hasMany(x.gm).by('parentId')}))}));
      ref=map?.sqlite(file,{size:1,min:1});
      const fixture={name,parents:parents.length,children:children.length,payments:payments.length,sqlite:{rowstitch:process.versions.sqlite,...(ref?{orange:String((await ref.query('SELECT sqlite_version() AS v'))[0].v)}:{})},cases:[]};
      const childrenOf=ps=>children.filter(c=>ps.some(p=>p.id===c.parentId)),paymentsOf=ps=>payments.filter(c=>ps.some(p=>p.id===c.parentId));
      const categories=[...new Set(parents.map(p=>p.category))].sort((a,b)=>a===b?0:a===null?-1:b===null?1:a<b?-1:1);
      const groups=grouped=>grouped?categories.map(category=>({category,rows:parents.filter(p=>p.category===category)})):[{rows:parents}];
      function compare(actual,wanted){
        const differences=[];assert.deepEqual(Object.keys(actual).sort(),Object.keys(wanted).sort());
        for(const key of Object.keys(wanted)){
          const a=actual[key],w=wanted[key];
          if(Object.is(a,w)||typeof w==='bigint'&&typeof a==='number'&&Number.isSafeInteger(a)&&BigInt(a)===w)continue;
          // Only the known numeric aggregate fields permit the documented empty-value representation difference.
          // Group keys (including NULL) must match exactly.
          if(['value','a','b'].includes(key)&&w===null&&(Number.isNaN(a)||a===0)){differences.push({field:key,expected:null,actual:normalized(a)});continue;}
          assert.fail('Unexpected reference value: '+JSON.stringify(normalized({field:key,actual:a,wanted:w})));
        }
        return differences;
      }
      const definitions=[
        ['count leaves',agg.related(relation,agg.count()),x=>x.count(x=>x.children.id),ps=>childrenOf(ps).length],
        ['count nonnull',agg.related(relation,agg.count(child.col('amount'))),x=>x.count(x=>x.children.amount),ps=>nonnull(childrenOf(ps),'amount').length],
        ['sum leaves',agg.related(relation,agg.sum(child.col('amount'))),x=>x.sum(x=>x.children.amount),ps=>sum(nonnull(childrenOf(ps),'amount'))],
        ['average leaves',agg.related(relation,agg.avg(child.col('score'))),x=>x.avg(x=>x.children.score),ps=>avg(nonnull(childrenOf(ps),'score'))],
        ['min leaves',agg.related(relation,agg.min(child.col('score'))),x=>x.min(x=>x.children.score),ps=>{const vs=nonnull(childrenOf(ps),'score');return vs.length?Math.min(...vs):null;}],
        ['max leaves',agg.related(relation,agg.max(child.col('score'))),x=>x.max(x=>x.children.score),ps=>{const vs=nonnull(childrenOf(ps),'score');return vs.length?Math.max(...vs):null;}],
      ];
      for(const grouped of [false,true]){
        const partitions=groups(grouped);
        for(const [caseName,selection,reference,oracle] of definitions){
          const expected=partitions.map(g=>({...('category'in g?{category:g.category}:{}),value:oracle(g.rows)}));
          db.clearTrace();sql=[];
          const actual=grouped?db.table(parent).groupBy({by:['category'],select:{value:selection}}):[db.table(parent).aggregate({select:{value:selection}})];
          assert.deepEqual(actual,expected);assert.equal(db.exportTrace().queries.length,1);report.summary.rowstitchOracleRows+=actual.length;
          const orangeRows=ref?await ref.gp.aggregate({...grouped?{category:x=>x.category,orderBy:'category'}:{},value:reference}):undefined;
          const differences=[];
          if(orangeRows){assert.equal(sql.length,1);assert.equal(orangeRows.length,expected.length);for(let i=0;i<expected.length;i++){const diff=compare(orangeRows[i],expected[i]);if(diff.length){report.summary.referenceNormalizedRows++;differences.push({group:grouped?expected[i].category:'all',differences:diff});}else report.summary.referenceEqualRows++;}}
          fixture.cases.push({name:(grouped?'group / ':'root / ')+caseName,rows:actual.length,passed:true,...(ref?{referenceDifferences:differences,orangeSql:sql[0]}:{})});report.summary.queryScenarios++;
        }
        db.clearTrace();sql=[];
        const select={roots:agg.count(),a:agg.related(relation,agg.sum(child.col('amount'))),b:agg.related(paid,agg.sum(payment.col('amount')))};
        const expected=partitions.map(g=>({...('category'in g?{category:g.category}:{}),roots:g.rows.length,a:sum(nonnull(childrenOf(g.rows),'amount')),b:sum(paymentsOf(g.rows).map(p=>p.amount))}));
        const actual=grouped?db.table(parent).groupBy({by:['category'],select}):[db.table(parent).aggregate({select})];
        assert.deepEqual(actual,expected);assert.equal(db.exportTrace().queries.length,1);report.summary.rowstitchOracleRows+=actual.length;
        const observed=ref?await ref.gp.aggregate({...grouped?{category:x=>x.category,orderBy:'category'}:{},roots:x=>x.count(x=>x.id),a:x=>x.sum(x=>x.children.amount),b:x=>x.sum(x=>x.payments.amount)}):undefined;
        const divergences=[];
        if(observed){assert.equal(sql.length,1);assert.equal(observed.length,expected.length);for(let i=0;i<partitions.length;i++){
          const g=partitions[i],joined=[];
          for(const p of g.rows){const cs=childrenOf([p]),ms=paymentsOf([p]);for(const c of cs.length?cs:[null])for(const m of ms.length?ms:[null])joined.push({c,m});}
          const joinedExpected={...('category'in g?{category:g.category}:{}),roots:joined.length,a:sum(joined.flatMap(r=>r.c?.amount==null?[]:[r.c.amount])),b:sum(joined.flatMap(r=>r.m===null?[]:[r.m.amount]))};
          const repr=compare(observed[i],joinedExpected);
          const fields=Object.keys(expected[i]).filter(key=>!Object.is(expected[i][key],joinedExpected[key]));
          if(fields.length){report.summary.observedJoinMultiplicityRows++;divergences.push({group:grouped?g.category:'all',fields,independentPathResult:normalized(expected[i]),orangeObserved:normalized(observed[i]),joinedOracle:normalized(joinedExpected),representationDifferences:repr});}
          else if(repr.length)report.summary.referenceNormalizedRows++;else report.summary.referenceEqualRows++;
        }}
        fixture.cases.push({name:(grouped?'group / ':'root / ')+'two child collections with root count',rows:actual.length,passed:true,...(ref?{joinMultiplicityObservations:divergences,orangeSql:sql[0]}:{})});report.summary.queryScenarios++;
      }
      const expected=categories.filter(category=>parents.some(p=>p.category===category&&p.active)).map(category=>({category,approved:sum(nonnull(childrenOf(parents.filter(p=>p.category===category&&p.active)).filter(c=>c.approved),'amount'))}));
      db.clearTrace();
      assert.deepEqual(db.table(parent).groupBy({by:['category'],where:eq(parent.col('active'),true),select:{approved:agg.related(approved,agg.sum(child.col('amount')))}}),expected);
      assert.equal(db.exportTrace().queries.length,1);
      report.summary.rowstitchOracleRows+=expected.length;report.summary.queryScenarios++;fixture.cases.push({name:'root filter plus related domain',rows:expected.length,passed:true,reference:'Not compared: a related descriptor domain is a Rowstitch API contract.'});
      report.fixtures.push(fixture);
    }catch(error){fixtureFailure=error;throw error;}finally{
      const cleanup=[];for(const action of [async()=>await ref?.close(),()=>db?.close(),()=>raw.close(),()=>unlinkSync(file)])try{await action();}catch(error){cleanup.push(error);}
      if(cleanup.length){if(fixtureFailure)fixtureFailure.cleanupErrors=cleanup;else throw new AggregateError(cleanup,'Comparison fixture cleanup failed.');}
    }
  }
}catch(error){failure=error;throw error;}finally{
  orange?.off('query',listener);try{rmdirSync(folder);}catch(error){if(failure)(failure.cleanupErrors??=[]).push(error);else throw error;}
}
// The CI convenience count is only Rowstitch's oracle rows. Reference matches, normalizations and observations stay separate.
report.summary.passed=report.summary.rowstitchOracleRows;
report.summary.failed=0; // A failure throws above; no success report is produced.
const output=JSON.stringify(report,null,2)+'\n';if(options.output)writeFileSync(options.output,output);process.stdout.write(output);
