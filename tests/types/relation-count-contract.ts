import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, countRelated, eq, some, type Predicate, type RelationCountOperator } from '../../dist/index.js';
const projects = defineTable('count_projects', { id: column.integer().primaryKey(), title: column.text() });
const tasks = defineTable('count_tasks', { id: column.integer().primaryKey(), projectId: column.integer().nullable(), done: column.boolean().nullable() });
const db = openDatabase(':memory:', { tables: [projects, tasks] });
const relation = hasMany(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') });
const operator: RelationCountOperator = '>=';
const where: Predicate = countRelated(relation, operator, 3, eq(tasks.col('done'), true));
const rows = db.table(projects).findMany({ where, select: ['title'] });
const title: string = rows[0].title;
const total: number = db.table(projects).count(where);
some(relation, countRelated(belongsTo(projects, { localKey: tasks.col('projectId'), foreignKey: projects.col('id') }), '=', 1));
countRelated(hasOne(tasks, { localKey: projects.col('id'), foreignKey: tasks.col('projectId') }), '>', 1);
// @ts-expect-error Comparison operator is required.
countRelated(relation);
// @ts-expect-error Threshold is required.
countRelated(relation, '=');
// @ts-expect-error SQL fragments are not supported operators.
countRelated(relation, '>= 0 OR 1=1', 3);
// @ts-expect-error The inequality spelling is <>, not !=.
countRelated(relation, '!=', 3);
// @ts-expect-error Thresholds are safe integer numbers, not strings.
countRelated(relation, '>=', '3');
// @ts-expect-error Bigint thresholds are not this API's representation.
countRelated(relation, '>=', 3n);
// @ts-expect-error A mapped table is not a relationship descriptor.
countRelated(tasks, '>=', 3);
// @ts-expect-error Predicates are structured values, not functions.
countRelated(relation, '>=', 3, () => true);
// @ts-expect-error Bound tests preserve the child's scalar type.
countRelated(relation, '>=', 3, eq(tasks.col('done'), 'yes'));
// @ts-expect-error The helper returns a filter, not a numeric count projection.
const projectedCount: number = countRelated(relation, '>=', 3);
// @ts-expect-error Count filtering does not add related rows to the result.
const impliedTasks = rows[0].tasks;
// @ts-expect-error Projections still omit unselected root fields.
const omittedId = rows[0].id;
void title; void total; db.close();
