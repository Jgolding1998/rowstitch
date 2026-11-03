// Two deterministic fictional fixtures. Independently authored oracle and pinned tool comparison.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const options={},args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){
  assert(['--entry','--reference-dir','--output'].includes(args[i])&&args[i+1],'Use [--entry BUILT_INDEX] [--reference-dir DIRECTORY] [--output FILE]');
  options[args[i].slice(2)]=resolve(args[i+1]);
}
const entry=options.entry??fileURLToPath(new URL('../dist/index.js',import.meta.url));
const ownPackage=JSON.parse(readFileSync(join(dirname(entry),'../package.json'),'utf8'));
let orange;
if(options['reference-dir']){
  const require=createRequire(join(options['reference-dir'],'package.json'));
  const orangeEntry=require.resolve('orange-orm');
  assert.equal(JSON.parse(readFileSync(join(dirname(orangeEntry),'../package.json'),'utf8')).version,'5.5.1');
  ({default:orange}=await import(pathToFileURL(orangeEntry)));
}
const { agg, column, defineTable, hasMany, openDatabase } = await import(pathToFileURL(entry));
const folder = mkdtempSync(join(tmpdir(),'rowstitch-projected-compare-'));
const report = { format:'rowstitch-projected-aggregate-comparison',version:1,environment:{node:process.version,rowstitch:ownPackage.version},reference:orange?'orange-orm@5.5.1':null,
  scope:'Per-row related aggregates on two fixed SQLite fixtures; checks count parent results, not independently authored test cases. No speed or general superiority ranking.',
  limitations:['Empty NULL/zero/NaN results are reported separately. Numeric fixture totals stay within the safe integer range for the shared comparison.',
    'The independent runtime tests cover exact large integers, invalid storage, collation and domain filters separately.',
    'Root/group related aggregates, other engines, DISTINCT, HAVING and per-selector filters are outside this comparison.',
    ...(!orange?['Orange was not loaded. Pass --reference-dir to compare its pinned release.']:[])],
  fixtures:[], summary:{equalContractChecks:0,documentedDifferences:0,rowstitchOracleChecks:0,unexpectedFailures:0} };
const normalize = value => JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():typeof v==='number'&&!Number.isFinite(v)?String(v):v));
let statements=[];
const listener = e => { if(/^\s*SELECT\b/i.test(e.sql)) statements.push(e.sql); };
orange?.on('query',listener);
try {
  for(const [fixtureName,numberOfParents,seed] of [['small',9,37],['uneven',23,191]]){
    const file=join(folder,fixtureName+'.sqlite');
    const raw=new DatabaseSync(file,{enableExtensions:false});
    let rowstitch,reference;
    try {
      raw.exec('CREATE TABLE cp(id INTEGER NOT NULL PRIMARY KEY,label TEXT NOT NULL); CREATE TABLE cc(id INTEGER NOT NULL PRIMARY KEY,parentId INTEGER,amount INTEGER,score REAL); CREATE TABLE cl(id INTEGER NOT NULL PRIMARY KEY,childId INTEGER NOT NULL,score REAL); CREATE TABLE cm(id INTEGER NOT NULL PRIMARY KEY,parentId INTEGER NOT NULL,amount INTEGER NOT NULL);');
      const parents=Array.from({length:numberOfParents},(_,i)=>({id:i+1,label:'Sample '+(i+1)}));
      const children=[],lines=[],payments=[];
      for(const p of parents){
        for(let i=0;i<(p.id*seed)%8;i++){
          const c={id:children.length+1,parentId:p.id,amount:p.id%5===0||i%4===0?null:(p.id*13+i*7)%99-40,score:p.id%5===0||i%4===0?null:i+.5};children.push(c);
          for(let j=0;j<c.id%4;j++)lines.push({id:lines.length+1,childId:c.id,score:j===0&&c.id%3===0?null:c.id+j+.25});
        }
        for(let i=0;i<p.id%4;i++)payments.push({id:payments.length+1,parentId:p.id,amount:i+3});
      }
      for(const p of parents)raw.prepare('INSERT INTO cp VALUES(?,?)').run(p.id,p.label);
      for(const c of children)raw.prepare('INSERT INTO cc VALUES(?,?,?,?)').run(c.id,c.parentId,c.amount,c.score);
      for(const l of lines)raw.prepare('INSERT INTO cl VALUES(?,?,?)').run(l.id,l.childId,l.score);
      for(const p of payments)raw.prepare('INSERT INTO cm VALUES(?,?,?)').run(p.id,p.parentId,p.amount);
      const parent=defineTable('cp',{id:column.integer().primaryKey(),label:column.text()});
      const child=defineTable('cc',{id:column.integer().primaryKey(),parentId:column.integer().nullable(),amount:column.integer().nullable(),score:column.real().nullable()});
      const line=defineTable('cl',{id:column.integer().primaryKey(),childId:column.integer(),score:column.real().nullable()});
      const payment=defineTable('cm',{id:column.integer().primaryKey(),parentId:column.integer(),amount:column.integer()});
      rowstitch=openDatabase(file,{tables:[parent,child,line,payment],readOnly:true});
      const childrenRel=hasMany(child,{localKey:parent.col('id'),foreignKey:child.col('parentId')});
      const linesRel=hasMany(line,{localKey:child.col('id'),foreignKey:line.col('childId')});
      const paymentsRel=hasMany(payment,{localKey:parent.col('id'),foreignKey:payment.col('parentId')});
      const map=orange?orange.map(x=>({
        cp:x.table('cp').map(({column})=>({id:column('id').numeric().primary(),label:column('label').string()})),
        cc:x.table('cc').map(({column})=>({id:column('id').numeric().primary(),parentId:column('parentId').numeric(),amount:column('amount').numeric(),score:column('score').numeric()})),
        cl:x.table('cl').map(({column})=>({id:column('id').numeric().primary(),childId:column('childId').numeric(),score:column('score').numeric()})),
        cm:x.table('cm').map(({column})=>({id:column('id').numeric().primary(),parentId:column('parentId').numeric(),amount:column('amount').numeric()})),
      })).map(x=>({cp:x.cp.map(v=>({children:v.hasMany(x.cc).by('parentId'),payments:v.hasMany(x.cm).by('parentId')})),cc:x.cc.map(v=>({lines:v.hasMany(x.cl).by('childId')}))})):undefined;
      reference=map?.sqlite(file,{size:1,min:1});
      const fixture={name:fixtureName,parents:parents.length,children:children.length,lines:lines.length,payments:payments.length,
        sqlite:{raw:String(raw.prepare('SELECT sqlite_version() AS v').get().v),...(reference?{orange:String((await reference.query('SELECT sqlite_version() AS v'))[0].v)}:{})},cases:[]};
      const allChildren=p=>children.filter(c=>c.parentId===p.id);
      const allLines=p=>allChildren(p).flatMap(c=>lines.filter(l=>l.childId===c.id));
      const nonnull=(rows,key)=>rows.flatMap(r=>r[key]===null?[]:[r[key]]);
      const count=rows=>rows.length;
      const sum=values=>values.length?values.reduce((a,b)=>a+BigInt(b),0n):null;
      const avg=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
      const min=values=>values.length?Math.min(...values):null;
      const max=values=>values.length?Math.max(...values):null;
      const definitions=[
        ['count children',agg.related(childrenRel,agg.count()),x=>x.count(x=>x.children.id),p=>count(allChildren(p)),'emptyCount'],
        ['count nonnull',agg.related(childrenRel,agg.count(child.col('amount'))),x=>x.count(x=>x.children.amount),p=>count(nonnull(allChildren(p),'amount')),'emptyCount'],
        ['sum integers',agg.related(childrenRel,agg.sum(child.col('amount'))),x=>x.sum(x=>x.children.amount),p=>sum(nonnull(allChildren(p),'amount')),'zeroSum'],
        ['average leaves',agg.related(childrenRel,agg.avg(child.col('score'))),x=>x.avg(x=>x.children.score),p=>avg(nonnull(allChildren(p),'score')),'zeroAverage'],
        ['minimum',agg.related(childrenRel,agg.min(child.col('score'))),x=>x.min(x=>x.children.score),p=>min(nonnull(allChildren(p),'score')),'nullExtreme'],
        ['maximum',agg.related(childrenRel,agg.max(child.col('score'))),x=>x.max(x=>x.children.score),p=>max(nonnull(allChildren(p),'score')),'nullExtreme'],
        ['nested count',agg.related(childrenRel,agg.related(linesRel,agg.count())),x=>x.count(x=>x.children.lines.id),p=>count(allLines(p)),'emptyCount'],
        ['nested average',agg.related(childrenRel,agg.related(linesRel,agg.avg(line.col('score')))),x=>x.avg(x=>x.children.lines.score),p=>avg(nonnull(allLines(p),'score')),'zeroAverage'],
      ];
      for(const [name,selector,orangeSelector,oracle,contract] of definitions){
        rowstitch.clearTrace();statements=[];
        const got=rowstitch.table(parent).findMany({select:['id'],aggregates:{value:selector}});
        const expected=parents.map(p=>({id:p.id,value:oracle(p)}));
        assert.deepEqual(got,expected,fixtureName+' / '+name+' against JS oracle');
        const actualOrange=reference?await reference.cp.getMany({orderBy:'id',value:orangeSelector}):undefined;
        if(actualOrange)assert.equal(actualOrange.length,parents.length);
        const differences=[];let equal=0;
        for(let i=0;actualOrange&&i<parents.length;i++){
          const actual=actualOrange[i].value, wanted=expected[i].value;
          assert.equal(actualOrange[i].id,parents[i].id);
          if((typeof wanted==='bigint'&&typeof actual==='number'&&Number.isSafeInteger(actual)&&BigInt(actual)===wanted)||Object.is(actual,wanted))equal++;
          else if((contract==='emptyCount'&&wanted===0&&Number.isNaN(actual))
            ||((contract==='zeroSum'||contract==='zeroAverage')&&wanted===null&&actual===0)
            ||(contract==='nullExtreme'&&wanted===null&&Number.isNaN(actual)))differences.push({parent:parents[i].id,rowstitch:normalize(wanted),orange:normalize(actual),kind:contract});
          else assert.fail(fixtureName+' / '+name+' unexpected Orange outcome: '+JSON.stringify(normalize({id:parents[i].id,actual,wanted})));
        }
        assert.equal(rowstitch.exportTrace().queries.length,1);
        if(reference)assert.equal(statements.length,1);
        fixture.cases.push({name,passed:true,equalContract:equal,differences,selects:{rowstitch:1,...(reference?{orange:1}:{})},...(reference?{orangeSql:statements[0]}:{})});
        report.summary.equalContractChecks+=equal;report.summary.documentedDifferences+=differences.length;report.summary.rowstitchOracleChecks+=parents.length;
      }
      // Equal-contract fan-out check: only parents with both child collections and non-NULL totals.
      rowstitch.clearTrace();statements=[];
      const both=rowstitch.table(parent).findMany({select:['id'],aggregates:{a:agg.related(childrenRel,agg.sum(child.col('amount'))),b:agg.related(paymentsRel,agg.sum(payment.col('amount')))}});
      const orangeBoth=reference?await reference.cp.getMany({orderBy:'id',a:x=>x.sum(x=>x.children.amount),b:x=>x.sum(x=>x.payments.amount)}):undefined;
      for(let i=0;i<parents.length;i++){
        const p=parents[i], a=sum(nonnull(allChildren(p),'amount')), b=sum(payments.filter(c=>c.parentId===p.id).map(c=>c.amount));
        assert.deepEqual(both[i],{id:p.id,a,b});
        if(orangeBoth){assert.equal(orangeBoth[i].a,a===null?0:Number(a));assert.equal(orangeBoth[i].b,b===null?0:Number(b));report.summary.equalContractChecks++;}
        report.summary.rowstitchOracleChecks++;
      }
      assert.equal(rowstitch.exportTrace().queries.length,1);
      if(reference)assert.equal(statements.length,1);
      fixture.cases.push({name:'independent child totals; deliberate null/zero normalization',passed:true,selects:{rowstitch:1,...(reference?{orange:1}:{})},...(reference?{orangeSql:statements[0]}:{})});
      report.fixtures.push(fixture);
    } finally {
      try{await reference?.close();}finally{
        try{rowstitch?.close();}finally{raw.close();unlinkSync(file);}
      }
    }
  }
} finally {orange?.off('query',listener);rmdirSync(folder);}
report.summary.passed=report.summary.rowstitchOracleChecks+report.summary.equalContractChecks;
report.summary.failed=report.summary.unexpectedFailures;
report.summary.contractDifferences=report.summary.documentedDifferences;
const text=JSON.stringify(report,null,2)+'\n';
if(options.output)writeFileSync(options.output,text);
process.stdout.write(text);
