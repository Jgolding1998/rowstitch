// Exact row/cell capacity regression on fictional caller-owned native fixtures. No installs or server ownership here.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const quote=name=>'"'+name.replaceAll('"','""')+'"';
const ROWS=10_000, ORDINARY_CELLS=1_000_000, AGGREGATE_CELLS=1_330_000;

/**
 * The caller proves fixture ownership and supplies this build's SDK/factory plus positional raw-text admin.query.
 * PostgreSQL uses its real public factory and a separate connection. 'pglite-worker-adapter' uses a caller-owned real
 * worker executor and borrowed public AsyncDatabase handle; it is deliberately distinct from the fresh-memory public
 * PGlite factory. Closing that borrowed logical handle must leave the physical worker alive until namespace cleanup.
 * This runner owns only its random namespace and opened logical handle. It never opens/closes the physical admin.
 */
export async function runAggregateCapacityCases({engine,sdk,openDatabase,admin}) {
  assert.ok(['postgresql','pglite-worker-adapter'].includes(engine));
  assert.equal(typeof openDatabase,'function');assert.equal(typeof admin?.query,'function');
  const {column,defineTable,agg,hasMany,asc}=sdk;
  const schema='rs_aggregate_capacity_'+randomBytes(6).toString('hex'),namespace=quote(schema);
  const columns={id:column.integer().primaryKey()};
  for(let i=0;i<99;i++)columns['c'+String(i).padStart(3,'0')]=column.integer();
  const roots=defineTable('capacity_roots',columns);
  const child=defineTable('capacity_children',{id:column.integer().primaryKey(),rootId:column.integer().references(roots,'id'),label:column.text().nullable()});
  const relation=hasMany(child,{localKey:roots.col('id'),foreignKey:child.col('rootId')});
  const fields=Object.keys(columns),cases=[],cleanup={schemaDropped:false,openedHandles:0,closedHandles:0};
  const report={engine,cases,cleanup,ordinaryMappedCellBudget:ORDINARY_CELLS,maxRawCells:AGGREGATE_CELLS,
    scope:'Fixed 100-column,10000-row scalar/projected read boundaries with short numeric/text/NULL values; not a performance or arbitrary-payload claim.'};
  const query=(sql,parameters=[])=>admin.query(sql,parameters);
  let created=false,db;
  try {
    await query('CREATE SCHEMA '+namespace);created=true;
    await query('REVOKE ALL ON SCHEMA '+namespace+' FROM PUBLIC');
    await query('CREATE TABLE '+namespace+'.capacity_roots('+fields.map(name=>quote(name)+' int4 NOT NULL'+(name==='id'?' PRIMARY KEY':'')).join(',')+')');
    await query('CREATE TABLE '+namespace+'.capacity_children(id int4 NOT NULL PRIMARY KEY,"rootId" int4 NOT NULL REFERENCES '+namespace+'.capacity_roots(id),label text)');
    await query('INSERT INTO '+namespace+'.capacity_roots SELECT g::int4,'+Array(99).fill('0::int4').join(',')
      +' FROM pg_catalog.generate_series($1::int4,$2::int4) AS g',['1',String(ROWS)]);
    db=await openDatabase({tables:[roots,child],schema,traceValues:false});cleanup.openedHandles++;
    const repo=db.table(roots),one={count00:agg.related(relation,agg.count())};
    const counts=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['count'+String(i).padStart(2,'0'),agg.related(relation,agg.count())]));
    const minima=n=>Object.fromEntries(Array.from({length:n},(_,i)=>['min'+String(i).padStart(2,'0'),agg.related(relation,agg.min(child.col('id')))]));
    const textMaxima=Object.fromEntries(Array.from({length:32},(_,i)=>['max'+String(i).padStart(2,'0'),agg.related(relation,agg.max(child.col('label')))]));
    const specifications=[
      {name:'ordinary 100 mapped columns at unchanged 1M-cell boundary',select:fields,rawFields:100,rawCells:ORDINARY_CELLS},
      {name:'99 selected columns plus one related count and guard exceed old raw cap',select:fields.slice(0,99),aggregates:one,rawFields:101,rawCells:1_010_000},
      {name:'100 selected columns plus32 related counts and guard reach exact maximum',select:fields,aggregates:counts(32),rawFields:133,rawCells:AGGREGATE_CELLS},
      {name:'99 selected columns plus two nullable integer MIN fields cross mapped codec batch boundary',select:fields.slice(0,99),aggregates:minima(2),rawFields:102,rawCells:1_020_000},
      {name:'100 selected columns plus32 nullable integer MIN fields require bounded mapped batches',select:fields,aggregates:minima(32),rawFields:133,rawCells:AGGREGATE_CELLS},
      {name:'100 selected columns plus32 nullable text MAX fields require bounded mapped batches',select:fields,aggregates:textMaxima,rawFields:133,rawCells:AGGREGATE_CELLS},
      {name:'100 selected columns plus16 counts and16 nullable MIN fields preserve mixed values',select:fields,aggregates:{...counts(16),...minima(16)},rawFields:133,rawCells:AGGREGATE_CELLS},
    ];
    for(const spec of specifications) {
      const options={select:spec.select,orderBy:[asc(roots.col('id'))],limit:ROWS,...(spec.aggregates?{aggregates:spec.aggregates}:{})};
      const compiled=repo.compileSelect(options);
      // LIMIT0 describes exact native physical fields without duplicating the large result payload.
      const description=await query('SELECT * FROM ('+compiled.sql+') AS "__rs_capacity_fields" LIMIT 0',compiled.parameters);
      assert.equal(description.fields.length,spec.rawFields);assert.equal(description.rows.length,0);
      const rows=await repo.findMany(options),expected=[...spec.select,...Object.keys(spec.aggregates??{})];
      assert.equal(rows.length,ROWS,'The test must not silently lower the public page size');
      for(let i=0;i<ROWS;i++) {
        const row=rows[i];assert.equal(Object.keys(row).length,expected.length);assert.equal(row.id,i+1);
        for(const field of expected){assert.ok(Object.hasOwn(row,field));const emptyAggregate=Object.hasOwn(spec.aggregates??{},field)&&!field.startsWith('count');
          assert.equal(row[field],field==='id'?i+1:emptyAggregate?null:0);}
      }
      assert.equal(spec.rawFields*rows.length,spec.rawCells);
      assert.equal(await repo.count(),ROWS,'A successful capacity read must leave its connection usable');
      cases.push({name:spec.name,rows:rows.length,logicalFields:expected.length,rawFields:spec.rawFields,rawCells:spec.rawCells,nextCount:ROWS});
    }
    await query('INSERT INTO '+namespace+'.capacity_children SELECT (g OPERATOR(pg_catalog.+) $3::int4),g::int4,pg_catalog.concat($4::text,g::text)'
      +' FROM pg_catalog.generate_series($1::int4,$2::int4) AS g',['1',String(ROWS),'100000','leaf_']);
    const populated=Object.fromEntries(Array.from({length:32},(_,i)=>[(i%2===0?'leafMin':'leafMax')+String(i).padStart(2,'0'),
      agg.related(relation,i%2===0?agg.min(child.col('id')):agg.max(child.col('label')))]));
    const options={select:fields,orderBy:[asc(roots.col('id'))],limit:ROWS,aggregates:populated};
    const compiled=repo.compileSelect(options);
    const description=await query('SELECT * FROM ('+compiled.sql+') AS "__rs_capacity_fields" LIMIT 0',compiled.parameters);
    assert.equal(description.fields.length,133);assert.equal(description.rows.length,0);
    const rows=await repo.findMany(options),aliases=Object.keys(populated);
    assert.equal(rows.length,ROWS,'The nonempty-domain test must not silently lower the public page size');
    for(let i=0;i<ROWS;i++) {
      const row=rows[i];assert.equal(Object.keys(row).length,132);
      for(const field of fields){assert.ok(Object.hasOwn(row,field));assert.equal(row[field],field==='id'?i+1:0);}
      for(let j=0;j<aliases.length;j++){assert.ok(Object.hasOwn(row,aliases[j]));assert.equal(row[aliases[j]],j%2===0?100_000+i+1:'leaf_'+(i+1));}
    }
    assert.equal(133*rows.length,AGGREGATE_CELLS);
    assert.equal(await repo.count(),ROWS,'The populated-domain capacity read must leave its connection usable');
    cases.push({name:'100 selected columns plus32 alternating integer MIN/text MAX fields preserve every nonempty-domain value',
      rows:rows.length,logicalFields:132,rawFields:133,rawCells:AGGREGATE_CELLS,statsDomainRows:ROWS,nextCount:ROWS});
    return report;
  } finally {
    try{if(db){await db.close();cleanup.closedHandles++;}}
    finally{if(created){await query('DROP SCHEMA '+namespace+' CASCADE');
      assert.deepEqual((await query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname::pg_catalog.text OPERATOR(pg_catalog.=) $1::pg_catalog.text',[schema])).rows,[]);
      cleanup.schemaDropped=true;}}
  }
}
