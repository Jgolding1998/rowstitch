import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, hasMany, some, none, every, eq, and } from 'rowstitch';

const projects = defineTable('projects', {
  id: column.integer().primaryKey(), name: column.text(),
});
const tasks = defineTable('tasks', {
  id: column.integer().primaryKey(), projectId: column.integer().references(projects, 'id'),
  done: column.boolean().nullable(),
});
const db = openDatabase(':memory:', { tables: [projects, tasks] });
try {
  db.ensureSchema();
  const repo = db.table(projects);
  repo.insertMany([
    { id: 1, name: 'Community garden' }, { id: 2, name: 'Book swap' },
    { id: 3, name: 'Weekend walk' }, { id: 4, name: 'Craft afternoon' },
  ]);
  db.table(tasks).insertMany([
    { id: 1, projectId: 1, done: true }, { id: 2, projectId: 1, done: false },
    { id: 3, projectId: 2, done: true }, { id: 4, projectId: 4, done: null },
  ]);
  const projectTasks = hasMany(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') });
  const names = where => repo.findMany({ where, select: ['name'] }).map(project => project.name);
  assert.deepEqual(names(some(projectTasks, eq(tasks.col('done'), false))), ['Community garden']);
  assert.deepEqual(names(none(projectTasks)), ['Weekend walk']);

  // Empty projects pass every. Unknown (NULL) task status does not pass.
  const allDone = every(projectTasks, eq(tasks.col('done'), true));
  assert.deepEqual(names(allDone), ['Book swap', 'Weekend walk']);
  assert.deepEqual(names(and(some(projectTasks), allDone)), ['Book swap']);

  // These filters run in SQL without fetching the task list first.
  db.clearTrace();
  console.log('Projects with unfinished tasks:', names(some(projectTasks, eq(tasks.col('done'), false))));
  assert.equal(db.exportTrace().queries.filter(query => query.operation === 'select').length, 1);
} finally {
  db.close();
}
