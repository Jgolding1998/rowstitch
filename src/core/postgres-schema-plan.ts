/** Creation-only mapping plans over actual native metadata. No migrations, ALTER, replay or connection ownership. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { fail } from './errors.js';
import { isTable, type AnyTable, type Columns, type Kind } from './schema.js';
import { mappedCreateTableModel, mappedTableModel } from './model-mapping.js';
import { queryModel, type CreateIndexModel, type CreateTableModel } from './query-model.js';
import { publicPlans, type PlannedSchema, type SchemaPlan, type SchemaTable, type Work } from './repository-core.js';
import { compilePostgresDDL, decodePostgresDDL } from './postgres-ddl.js';
import { inspectPostgresSchemaDetailsWork, type PostgresSchemaDetails, type PostgresSchemaTableDetails } from './postgres-schema.js';

const { isProxy } = types, entries = Map.prototype.entries;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const allowed: Readonly<Record<Kind, readonly number[]>> = Object.freeze({integer: [21, 23, 20], bigint: [21, 23, 20], real: [700, 701], text: [25, 1043], boolean: [16], json: [114, 3802]});
const drift = (): never => fail('SCHEMA_DRIFT', 'Existing PostgreSQL objects do not meet the mapped creation contract. No destructive schema changes were made.');
const badRegistry = (): never => fail('SCHEMA', 'Register at most 100 genuine, consistently named mapped tables and their exact foreign-key targets.');
const foreignIndex = (table: AnyTable, column: string): string => 'rs_fk_' + createHash('sha256').update(table.name + '\0' + column).digest('hex').slice(0, 16);

function registry(input: ReadonlyMap<string, AnyTable>): Map<string, AnyTable> {
  let captured: [unknown, unknown][];
  try {
    if (!input || typeof input !== 'object' || isProxy(input)) return badRegistry();
    if (mapSize.call(input) > 100) return badRegistry();
    captured = Array.from(entries.call(input));
  } catch { return badRegistry(); }
  if (captured.length > 100) return badRegistry();
  const result = new Map<string, AnyTable>(), names = new Set<string>();
  for (const [name, table] of captured) {
    if (typeof name !== 'string' || !isTable(table) || name !== table.name || names.has(name.toLowerCase())) return badRegistry();
    names.add(name.toLowerCase()); result.set(name, table);
  }
  for (const table of result.values()) for (const column of Object.values(table.columns as Columns)) {
    const key = column.config.foreignKey;
    if (key && result.get(key.table.name) !== key.table) return badRegistry();
  }
  return result;
}
function compatible(table: AnyTable, actual: PostgresSchemaTableDetails): void {
  if (actual.kind !== 'r' && actual.kind !== 'p') return drift();
  const expectedPrimary = Object.entries(table.columns as Columns).filter(([, column]) => column.config.primary).map(([name]) => name);
  const actualPrimary = actual.table.columns.filter(column => column.primaryKey).sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder).map(column => column.name);
  if (JSON.stringify(expectedPrimary) !== JSON.stringify(actualPrimary)) return drift();
  const active = (name: string, primary = false): boolean => actual.indexes.some(index => index.name === name && (!primary || index.primary)
    && index.valid && index.ready && index.live && index.immediate);
  if (!actual.table.indexes.some(index => index.unique && !index.partial && JSON.stringify(index.columns) === JSON.stringify(expectedPrimary) && active(index.name, true))) return drift();
  for (const [name, column] of Object.entries(table.columns as Columns)) {
    const config = column.config, found = actual.table.columns.find(column => column.name === name), native = actual.columns.find(column => column.name === name);
    if (!found || !native || !allowed[config.kind].includes(native.typeOid) || found.nullable !== config.nullable || native.generation !== '') return drift();
    if (config.generated) {
      if (!native.identity && !native.hasDefault || config.hasDefault) return drift();
    } else {
      // PostgreSQL removes an ordinary DEFAULT NULL attrdef; nullable implicit NULL is its exact normalized case.
      const implicitNull = config.nullable && config.hasDefault && config.defaultValue === null;
      if (native.identity !== '' || native.hasDefault !== config.hasDefault && !implicitNull) return drift();
    }
    if (config.unique && !actual.table.indexes.some(index => index.unique && !index.partial && index.columns.length === 1 && index.columns[0] === name && active(index.name))) return drift();
    const key = config.foreignKey;
    if (key && !actual.foreignKeys.some(found => found.columns.length === 1 && found.columns[0] === name && found.table === key.table.name
      && found.targets.length === 1 && found.targets[0] === key.column && found.onDelete === key.onDelete && found.onUpdate === 'no action' && found.enforced && found.validated)) return drift();
  }
}
function plan(tables: Map<string, AnyTable>, actual: PostgresSchemaDetails, schema: string): PlannedSchema[] {
  if (!actual.exists) fail('SCHEMA', 'Create the selected PostgreSQL namespace before ensuring mapped tables.');
  const found = new Map(actual.tables.map(table => [table.table.name, table]));
  for (const table of tables.values()) {
    const existing = found.get(table.name);
    if (existing) compatible(table, existing);
  }
  const ordered: AnyTable[] = [], state = new Map<AnyTable, 'visiting' | 'done'>();
  const visit = (table: AnyTable): void => {
    if (found.has(table.name) || state.get(table) === 'done') return;
    if (state.get(table) === 'visiting') fail('SCHEMA', 'Creation-only PostgreSQL plans cannot resolve a cycle of new foreign-key tables.');
    state.set(table, 'visiting');
    for (const column of Object.values(table.columns as Columns)) if (column.config.foreignKey) visit(column.config.foreignKey.table);
    state.set(table, 'done'); ordered.push(table);
  };
  for (const table of tables.values()) visit(table);
  const plans: PlannedSchema[] = [];
  const add = (table: AnyTable, action: SchemaPlan['action'], model: CreateTableModel | CreateIndexModel): void => { plans.push({table: table.name, action, model, sql: compilePostgresDDL(model, schema)}); };
  for (const table of ordered) add(table, 'create-table', mappedCreateTableModel(table));
  const names = new Map<string, {table: string; index: PostgresSchemaTableDetails['table']['indexes'][number]}>();
  for (const table of actual.tables) for (const index of table.table.indexes) {
    if (names.has(index.name)) return drift();
    names.set(index.name, {table: table.table.name, index});
  }
  const planned = new Set<string>();
  for (const table of tables.values()) for (const [column, definition] of Object.entries(table.columns as Columns)) {
    if (!definition.config.foreignKey) continue;
    const name = foreignIndex(table, column), existing = names.get(name);
    if (found.has(name) || tables.has(name) || planned.has(name)) return drift();
    if (existing) {
      const index = existing.index;
      const facts = found.get(table.name)?.indexes.find(index => index.name === name);
      if (existing.table !== table.name || index.unique || index.partial || index.columns.length !== 1 || index.columns[0] !== column
        || !facts || !facts.valid || !facts.ready || !facts.live || !facts.immediate) return drift();
    } else {
      add(table, 'create-index', queryModel.createIndex({table: mappedTableModel(table), name, columns: [column]}));
      planned.add(name);
    }
  }
  return plans;
}

/** Read-only catalog work plus captured typed plans; never executes the returned CREATE SQL. */
export function* planPostgresSchemaWork(tables: ReadonlyMap<string, AnyTable>, schema = 'public'): Work<PlannedSchema[]> {
  const captured = registry(tables), actual = yield* inspectPostgresSchemaDetailsWork(schema);
  return plan(captured, actual, schema);
}

/** Must be driven inside the owning caller's SERIALIZABLE transaction. All validation happens before its COMMIT. */
export function* ensurePostgresSchemaWork(tables: ReadonlyMap<string, AnyTable>, schema = 'public'): Work<{plans: SchemaPlan[]; schema: SchemaTable[]}> {
  const captured = registry(tables), before = yield* inspectPostgresSchemaDetailsWork(schema), plans = plan(captured, before, schema);
  for (const creation of plans) yield {sql: creation.sql, parameters: [], operation: 'schema', table: creation.table, control: true, decode: decodePostgresDDL};
  const after = yield* inspectPostgresSchemaDetailsWork(schema);
  if (plan(captured, after, schema).length) return drift();
  return {plans: publicPlans(plans), schema: after.tables.map(table => table.table)};
}
