import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, hasMany, countRelated, eq, isNull } from 'rowstitch';

const projects = defineTable('projects', { id: column.integer().primaryKey(), name: column.text() });
const tasks = defineTable('tasks', {
  id: column.integer().primaryKey(), projectId: column.integer().references(projects, 'id'), done: column.boolean().nullable(),
});
const db = openDatabase(':memory:', { tables: [projects, tasks] });
try {
  db.ensureSchema();
  const repo = db.table(projects);
  repo.insertMany([
    { id: 1, name: 'Playground repairs' }, { id: 2, name: 'Book exchange' },
    { id: 3, name: 'Garden cleanup' }, { id: 4, name: 'Weekend picnic' },
  ]);
  db.table(tasks).insertMany([
    { id: 1, projectId: 1, done: false }, { id: 2, projectId: 1, done: false }, { id: 3, projectId: 1, done: true },
    { id: 4, projectId: 2, done: true }, { id: 5, projectId: 3, done: null },
  ]);
  const projectTasks = hasMany(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') });
  const names = where => repo.findMany({ where, select: ['name'] }).map(project => project.name);
  assert.deepEqual(names(countRelated(projectTasks, '>=', 2, eq(tasks.col('done'), false))), ['Playground repairs']);
  assert.deepEqual(names(countRelated(projectTasks, '=', 0)), ['Weekend picnic']);
  assert.deepEqual(names(countRelated(projectTasks, '=', 1, isNull(tasks.col('done')))), ['Garden cleanup']);
  // COUNT(*) includes a task with unknown status unless a test excludes it.
  assert.deepEqual(names(countRelated(projectTasks, '=', 1)), ['Book exchange', 'Garden cleanup']);
  console.log('Projects with at least two unfinished tasks:', names(countRelated(projectTasks, '>=', 2, eq(tasks.col('done'), false))));
} finally { db.close(); }
