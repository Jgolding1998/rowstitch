import {column, defineTable} from '../../src/core/schema.js';
import {mappedCreateTableModel} from '../../src/core/model-mapping.js';
import {compilePostgresDDL, postgresDefaultLiteral, decodePostgresDDL} from '../../src/core/postgres-ddl.js';
import {planPostgresSchemaWork, ensurePostgresSchemaWork} from '../../src/core/postgres-schema-plan.js';
import type {PlannedSchema, SchemaPlan, SchemaTable, Work} from '../../src/core/repository-core.js';
const table = defineTable('ddl_type_rows', {id: column.integer().primaryKey()});
const registered: ReadonlyMap<string, typeof table> = new Map([[table.name, table]]);
const sql: string = compilePostgresDDL(mappedCreateTableModel(table));
const plan: Work<PlannedSchema[]> = planPostgresSchemaWork(registered);
const ensured: Work<{plans: SchemaPlan[]; schema: SchemaTable[]}> = ensurePostgresSchemaWork(registered);
const rows: Record<string, unknown>[] = decodePostgresDDL({});
void [sql, plan, ensured, rows, postgresDefaultLiteral('boolean', 1, false)];
// @ts-expect-error No arbitrary SQL input is accepted by the DDL compiler.
compilePostgresDDL('DROP TABLE hidden');
// @ts-expect-error PostgreSQL scalar kinds have a closed contract.
postgresDefaultLiteral('numeric', '1', false);
// @ts-expect-error Nullable is a boolean policy, not a truthy setting.
postgresDefaultLiteral('integer', 1, 1);
// @ts-expect-error Default values are already encoded immutable scalars, not logical JSON objects.
postgresDefaultLiteral('json', {x: 1}, false);
// @ts-expect-error Planning needs an authenticated table registry, not string names.
planPostgresSchemaWork(new Map([['name', 'table']]));
// @ts-expect-error Ensure exposes Work for an owning transaction, not an automatically committed Promise.
ensurePostgresSchemaWork(registered).then(() => {});
// @ts-expect-error A creation model is preserved only on internal plans, not returned public SchemaPlan objects.
declare const publicPlan: SchemaPlan; publicPlan.model;
