// Fictional native graph example. Uses fresh in-memory PGlite when run directly.
// Requires npm run build and the optional @electric-sql/pglite@0.5.15 peer.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {column,defineTable,hasMany,hasOne,belongsTo,agg,asc,desc,eq} from 'rowstitch';
import {openPgliteDatabase} from 'rowstitch/pglite';

const authors=defineTable('example_authors',{
  id:column.integer().primaryKey(),name:column.text(),internalNote:column.text(),
});
const profiles=defineTable('example_profiles',{
  id:column.integer().primaryKey(),authorId:column.integer().unique().references(authors,'id'),bio:column.text(),
});
const posts=defineTable('example_posts',{
  id:column.integer().primaryKey(),authorId:column.integer().references(authors,'id'),title:column.text(),published:column.boolean(),
});
export const nativeEagerExampleTables=[authors,profiles,posts];

// A caller can pass openPostgresDatabase and options for a disposable, already-created schema.
// This example creates these three tables and inserts fixed IDs; use an empty fixture database.
export async function runNativeEagerExample({open=openPgliteDatabase,options={}}={}){
  const db=await open({...options,tables:nativeEagerExampleTables});
  try{
    await db.ensureSchema();
    await db.transaction(async tx=>{
      await tx.table(authors).insertMany([
        {id:1,name:'Avery',internalNote:'Fictional label A'},
        {id:2,name:'Robin',internalNote:'Fictional label B'},
      ]);
      await tx.table(profiles).insert({id:1,authorId:1,bio:'Writes about small gardens.'});
      await tx.table(posts).insertMany([
        {id:1,authorId:1,title:'The first seedlings',published:true},
        {id:2,authorId:1,title:'A windowsill garden',published:true},
        {id:3,authorId:1,title:'Unfinished draft',published:false},
      ]);
    });
    const publishedPosts=hasMany(posts,{
      localKey:authors.col('id'),foreignKey:posts.col('authorId'),where:eq(posts.col('published'),true),
    });
    db.clearTrace();
    // The explicit writable transaction gives the root, summary and children SERIALIZABLE isolation.
    const rows=await db.transaction(async tx=>await tx.table(authors).findMany({
      select:['name'],orderBy:[asc(authors.col('id'))],
      aggregates:{publishedCount:agg.related(publishedPosts,agg.count())},
      include:{
        profile:hasOne(profiles,{
          localKey:authors.col('id'),foreignKey:profiles.col('authorId'),select:['bio'],
        }),
        latest:hasMany(posts,{
          localKey:authors.col('id'),foreignKey:posts.col('authorId'),where:eq(posts.col('published'),true),
          orderBy:[desc(posts.col('id'))],limit:1,select:['title'],
          include:{author:belongsTo(authors,{
            localKey:posts.col('authorId'),foreignKey:authors.col('id'),select:['name'],
          })},
        }),
      },
    }));
    assert.deepEqual(rows,[
      {name:'Avery',publishedCount:2,profile:{bio:'Writes about small gardens.'},latest:[
        {title:'A windowsill garden',author:{name:'Avery'}},
      ]},
      {name:'Robin',publishedCount:0,profile:null,latest:[]},
    ]);
    const selects=db.exportTrace().queries.filter(query=>query.operation==='select').length;
    assert.equal(selects,4); // Root+summary, profiles, latest posts and nested authors.
    return {rows,selects};
  }finally{await db.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const result=await runNativeEagerExample();
  console.dir(result.rows,{depth:null});
  console.log(`${result.selects} SELECTs. The count covers all published posts; latest is a page of one.`);
}
