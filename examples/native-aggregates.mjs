// Fictional in-memory example. Requires the optional @electric-sql/pglite@0.5.15 peer and npm run build.
import {column,defineTable,hasMany,agg,asc} from '../dist/index.js';
import {openPgliteDatabase} from '../dist/pglite.js';

const projects=defineTable('projects',{
  id:column.integer().primaryKey(),team:column.text(),budget:column.bigint(),
});
const tasks=defineTable('tasks',{
  id:column.integer().primaryKey(),projectId:column.integer().references(projects,'id'),minutes:column.integer().nullable(),
});
const projectTasks=hasMany(tasks,{localKey:projects.col('id'),foreignKey:tasks.col('projectId')});
const db=await openPgliteDatabase({tables:[projects,tasks]});
try{
  await db.ensureSchema();
  await db.table(projects).insertMany([
    {id:1,team:'Design',budget:9223372036854775807n},
    {id:2,team:'Design',budget:9223372036854775807n},
    {id:3,team:'Engineering',budget:500n},
  ]);
  await db.table(tasks).insertMany([
    {id:1,projectId:1,minutes:30},{id:2,projectId:1,minutes:60},{id:3,projectId:2,minutes:null},
  ]);
  const summaries={
    projects:agg.count(),budget:agg.sum(projects.col('budget')),
    tasks:agg.related(projectTasks,agg.count()),
    minutes:agg.related(projectTasks,agg.sum(tasks.col('minutes'))),
    averageMinutes:agg.related(projectTasks,agg.avg(tasks.col('minutes'))),
  };
  console.log('All projects. The budget total remains exact above the int64 range:');
  console.dir(await db.table(projects).aggregate({select:summaries}));
  console.log('One summary per team:');
  console.dir(await db.table(projects).groupBy({by:['team'],select:summaries}));
  console.log('Each project with its own task count and time:');
  console.dir(await db.table(projects).findMany({select:['id','team'],orderBy:[asc(projects.col('id'))],aggregates:{
    tasks:summaries.tasks,minutes:summaries.minutes,averageMinutes:summaries.averageMinutes,
  }}));
}finally{await db.close();}
