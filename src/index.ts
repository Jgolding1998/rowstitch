export { RowstitchError, ConflictError } from './core/errors.js';
export { column, defineTable, Table, Column, ColumnRef } from './core/schema.js';
export type { AnyTable, Row, InsertRow, UpdateRow, KeyRow, Parameter } from './core/schema.js';
export { agg } from './core/aggregates.js';
export type { AggregateSelector, AggregateSelection, AggregateResult, AggregateOptions, GroupKey, GroupOrder, GroupOptions, GroupResult } from './core/aggregates.js';
export { eq, ne, gt, gte, lt, lte, eqColumns, neColumns, gtColumns, gteColumns, ltColumns, lteColumns, inArray, isNull, contains, startsWith, endsWith, between, and, or, not, asc, desc, hasMany, hasOne, belongsTo, some, none, every, countRelated } from './core/predicates.js';
export type { Predicate, Ordering, FindOptions, Includes, ManyRelation, SingularRelation, FilterRelation, CompiledQuery, WithIncludes, SelectedRow, Selection, RelationOptions, SingularOptions, TextMatchOptions, RelationCountOperator } from './core/predicates.js';
export { openDatabase, Database, Repository } from './core/database.js';
export type { DatabaseOptions, WriteOptions, TraceEntry, TraceDocument, SchemaTable, SchemaColumn, SchemaForeignKey, SchemaIndex, SchemaPlan, QueryPlan } from './core/database.js';
