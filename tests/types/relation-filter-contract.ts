import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, some, none, every, eq, and, type Predicate } from '../../dist/index.js';
const projects = defineTable('projects', { id: column.integer().primaryKey(), name: column.text() });
const tasks = defineTable('tasks', { id: column.integer().primaryKey(), projectId: column.integer().nullable(), done: column.boolean() });
const db = openDatabase(':memory:', { tables: [projects, tasks] });
const relation = hasMany(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') });
const predicate: Predicate = and(some(relation), none(relation, eq(tasks.col('done'), false)), every(relation, eq(tasks.col('done'), true)));
const rows = db.table(projects).findMany({ where: predicate, select: ['name'] });
const name: string = rows[0].name;
const count: number = db.table(projects).count(predicate);
some(hasOne(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') }));
none(belongsTo(projects, { localKey: tasks.col('projectId'), foreignKey: projects.col('id') }));
// @ts-expect-error Every needs an explicit test, unlike an existence check.
every(relation);
// @ts-expect-error A mapped table is not a relationship descriptor.
some(tasks);
// @ts-expect-error A column reference is not a relationship descriptor.
none(tasks.col('id'));
// @ts-expect-error A filter is a structured predicate, not executable callback code.
some(relation, () => true);
// @ts-expect-error Boolean values are not predicates.
every(relation, true);
// @ts-expect-error Encoded predicate values retain column type checking.
some(relation, eq(tasks.col('done'), 'true'));
// @ts-expect-error Filtering by a relation does not return unselected columns.
const hiddenId = rows[0].id;
// @ts-expect-error A relation filter does not implicitly eager-load the related rows.
const hiddenTasks = rows[0].tasks;
// @ts-expect-error Count results are numbers, not rows.
const wrongCount: string = count;
void name;
db.close();
