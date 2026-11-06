/** Creation-only mapping plans over actual native metadata. No migrations, ALTER, replay or connection ownership. */
import { createHash } from 'node:crypto';
import { types, isDeepStrictEqual } from 'node:util';
import { fail } from './errors.js';
import { isTable, type AnyTable, type Columns, type Kind } from './schema.js';
import { mappedCreateTableModel, mappedTableModel } from './model-mapping.js';
import { queryModel, type CreateIndexModel, type CreateTableModel } from './query-model.js';
import { publicPlans, type PlannedSchema, type SchemaPlan, type SchemaTable, type Work } from './repository-core.js';
import { physicalTableKey, validateModelStorage, type PhysicalTableIdentity } from './physical-identity.js';
import { compilePostgresDDL, decodePostgresDDL } from './postgres-ddl.js';
import { inspectPostgresSchemaDetailsWork, type PostgresSchemaDetails, type PostgresSchemaTableDetails } from './postgres-schema.js';

const { isProxy } = types, entries = Map.prototype.entries;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const allowed: Readonly<Record<Kind, readonly number[]>> = Object.freeze({integer: [21, 23, 20], bigint: [21, 23, 20], real: [700, 701], text: [25, 1043], boolean: [16], json: [114, 3802]});
const literalCastOid = new Map([
  ['smallint', 21], ['int2', 21], ['integer', 23], ['int4', 23], ['bigint', 20], ['int8', 20],
  ['real', 700], ['float4', 700], ['double precision', 701], ['float8', 701], ['numeric', 1700],
  ['text', 25], ['character varying', 1043], ['varchar', 1043], ['boolean', 16], ['bool', 16], ['json', 114], ['jsonb', 3802],
]);
const integerUpperBound = new Map([[21, 2n ** 15n], [23, 2n ** 31n], [20, 2n ** 63n]]);
const numericLiteral = /^-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
const drift = (): never => fail('SCHEMA_DRIFT', 'Existing PostgreSQL objects do not meet the mapped creation contract. No destructive schema changes were made.');
const badRegistry = (): never => fail('SCHEMA', 'Register at most 100 genuine, consistently named mapped tables and their exact foreign-key targets.');
const foreignIndex = (table: AnyTable, column: string): string => 'rs_fk_' + createHash('sha256').update(table.storage.table + '\0' + table.storage.columns[column]).digest('hex').slice(0, 16);
const identity = (table: AnyTable, schema: string): PhysicalTableIdentity => validateModelStorage(mappedTableModel(table), schema, 'postgresql');
const keyOf = (value: PhysicalTableIdentity): string => physicalTableKey(value.schema, value.table, 'postgresql');

function registry(input: ReadonlyMap<string, AnyTable>, schema: string): Map<string, AnyTable> {
  let captured: [unknown, unknown][];
  try {
    if (!input || typeof input !== 'object' || isProxy(input)) return badRegistry();
    if (mapSize.call(input) > 100) return badRegistry();
    captured = Array.from(entries.call(input));
  } catch { return badRegistry(); }
  if (captured.length > 100) return badRegistry();
  const result = new Map<string, AnyTable>(), names = new Set<string>(), physical = new Set<string>();
  for (const [name, table] of captured) {
    if (typeof name !== 'string' || !isTable(table) || name !== table.name || names.has(name.toLowerCase())) return badRegistry();
    const key = keyOf(identity(table, schema));
    if (physical.has(key)) return badRegistry();
    physical.add(key); names.add(name.toLowerCase()); result.set(name, table);
  }
  for (const table of result.values()) for (const column of Object.values(table.columns as Columns)) {
    const key = column.config.foreignKey;
    if (key && result.get(key.table.name) !== key.table) return badRegistry();
  }
  return result;
}
/** Only closed literal defaults are comparable. No SQL expression is evaluated by the planner. */
function defaultMatches(expression: string | null, kind: Kind, expected: unknown, typeOid: number, type: string): boolean {
  if (expression === null) return expected === null;
  let value = expression.trim();
  // Leave casts with type modifiers, nested casts and other SQL expressions to the drift path.
  const cast = /::(?:(?:"pg_catalog"|pg_catalog)\.)?(?:"([a-z][a-z0-9]*)"|([a-z][a-z0-9]*(?: [a-z]+)*))$/.exec(value);
  const castOid = cast ? literalCastOid.get(cast[1] ?? cast[2]!) : undefined;
  if (cast) {
    const unboundedNumeric = castOid === 1700 && (kind === 'integer' || kind === 'bigint' || kind === 'real');
    if (castOid === undefined || !allowed[kind].includes(castOid) && !unboundedNumeric) return false;
    value = value.slice(0, cast.index).trim();
  }
  let scalar: string;
  if (/^E'(?:[^']|'')*'$/.test(value)) {
    const body = value.slice(2, -1).replaceAll("''", "'"); let decoded = '';
    for (let index = 0; index < body.length; index++) {
      if (body[index] !== '\\') decoded += body[index];
      else { if (body[++index] !== '\\') return false; decoded += '\\'; }
    }
    scalar = decoded;
  } else if (/^'(?:[^']|'')*'$/.test(value)) scalar = value.slice(1, -1).replaceAll("''", "'");
  else if (kind === 'boolean' && /^(?:true|false)$/i.test(value)) scalar = value.toLowerCase();
  else {
    if (kind === 'text' || kind === 'json') return false;
    if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1);
    if (!numericLiteral.test(value)) return false;
    scalar = value;
  }
  try {
    if (kind === 'text') {
      if (scalar !== expected) return false;
      // format_type emits this spelling for a built-in varchar with an explicit length.
      const width = typeOid === 1043 ? /^character varying\((\d+)\)$/.exec(type) : null;
      return !width || scalar.length <= Number(width[1]) || Array.from(scalar).length <= Number(width[1]);
    }
    if (kind === 'boolean') return scalar === (expected === 1 ? 'true' : expected === 0 ? 'false' : undefined);
    if (kind === 'integer' || kind === 'bigint') {
      if (!/^-?\d{1,19}$/.test(scalar)) return false;
      const integer = BigInt(scalar), targetMax = integerUpperBound.get(typeOid)!;
      const castMax = castOid === undefined ? undefined : integerUpperBound.get(castOid);
      return integer === BigInt(expected as number | bigint) && integer >= -targetMax && integer < targetMax
        && (castMax === undefined || integer >= -castMax && integer < castMax);
    }
    if (kind === 'real') {
      if (!numericLiteral.test(scalar)) return false;
      const real = Number(scalar);
      if (real === 0 && !/^-?0+(?:\.0*)?(?:[eE][+-]?\d+)?$/.test(scalar)) return false;
      return Number.isFinite(real) && Object.is(real, expected) && (typeOid !== 700 && castOid !== 700 || Object.is(Math.fround(real), real));
    }
    return typeof expected === 'string' && isDeepStrictEqual(JSON.parse(scalar), JSON.parse(expected));
  } catch { return false; }
}
function compatible(table: AnyTable, actual: PostgresSchemaTableDetails, schema: string): void {
  if (actual.kind !== 'r' && actual.kind !== 'p' || keyOf(actual.identity) !== keyOf(identity(table, schema))) return drift();
  const explicit = table.schemaPolicy !== 'legacy', exact = table.schemaPolicy === 'exact';
  const definitions = Object.entries(table.columns as Columns), physical = (logical: string): string => table.storage.columns[logical];
  if (exact && actual.table.columns.length !== definitions.length) return drift();
  const expectedPrimary = definitions.filter(([, column]) => column.config.primary).map(([name]) => physical(name));
  const actualPrimary = actual.table.columns.filter(column => column.primaryKey).sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder).map(column => column.name);
  if (JSON.stringify(expectedPrimary) !== JSON.stringify(actualPrimary)) return drift();
  const active = (name: string, primary = false): boolean => actual.indexes.some(index => index.name === name && (!primary || index.primary)
    && index.valid && index.ready && index.live && index.immediate);
  if (!actual.table.indexes.some(index => index.unique && !index.partial && JSON.stringify(index.columns) === JSON.stringify(expectedPrimary) && active(index.name, true))) return drift();
  const expectedUnique = definitions.filter(([, column]) => column.config.unique).map(([logical]) => physical(logical));
  if (exact && actual.table.indexes.some(index => index.unique && index.origin !== 'p' && (index.partial || index.columns.length !== 1 || !expectedUnique.includes(index.columns[0]!)))) return drift();
  if (exact && actual.foreignKeys.length !== definitions.filter(([, column]) => column.config.foreignKey).length) return drift();
  for (const [logical, column] of definitions) {
    const name = physical(logical), config = column.config, found = actual.table.columns.find(column => column.name === name), native = actual.columns.find(column => column.name === name);
    if (!found || !native || !allowed[config.kind].includes(native.typeOid) || found.nullable !== config.nullable || native.generation !== '') return drift();
    if (config.generated) {
      if (!native.identity && (!native.hasDefault || explicit) || config.hasDefault) return drift();
    } else {
      const implicitNull = config.nullable && config.hasDefault && config.defaultValue === null;
      if (native.identity !== '' || native.hasDefault !== config.hasDefault && !implicitNull) return drift();
      if (explicit && config.hasDefault && !defaultMatches(found.default, config.kind, config.defaultValue, native.typeOid, found.type)) return drift();
    }
    if (config.unique && !actual.table.indexes.some(index => index.unique && !index.partial && index.columns.length === 1 && index.columns[0] === name && active(index.name))) return drift();
    const key = config.foreignKey;
    if (key) {
      const targetIdentity = identity(key.table, schema), targetColumn = key.table.storage.columns[key.column];
      if (!actual.foreignKeys.some(found => found.width === 1 && found.columns.length === 1 && found.columns[0] === name
        && keyOf(found.targetIdentity) === keyOf(targetIdentity) && found.targets.length === 1 && found.targets[0] === targetColumn
        && found.onDelete === key.onDelete && found.onUpdate === 'no action' && found.enforced && found.validated
        && (!explicit || found.match === 'simple' && !found.deferrable && !found.initiallyDeferred && found.deleteSetColumns === null))) return drift();
    }
  }
}
function plan(tables: Map<string, AnyTable>, actual: PostgresSchemaDetails, schema: string): PlannedSchema[] {
  if (actual.namespaces.some(namespace => !namespace.exists)) fail('SCHEMA', 'Create the selected PostgreSQL namespace before ensuring mapped tables.');
  if (actual.conflicts.length) return drift();
  const found = new Map(actual.tables.map(table => [keyOf(table.identity), table]));
  const mappedIdentities = new Set([...tables.values()].map(table => keyOf(identity(table, schema))));
  for (const table of tables.values()) {
    const existing = found.get(keyOf(identity(table, schema)));
    if (existing) compatible(table, existing, schema);
  }
  const ordered: AnyTable[] = [], state = new Map<AnyTable, 'visiting' | 'done'>();
  const visit = (table: AnyTable): void => {
    if (found.has(keyOf(identity(table, schema))) || state.get(table) === 'done') return;
    if (state.get(table) === 'visiting') fail('SCHEMA', 'Creation-only PostgreSQL plans cannot resolve a cycle of new foreign-key tables.');
    state.set(table, 'visiting');
    for (const column of Object.values(table.columns as Columns)) if (column.config.foreignKey) visit(column.config.foreignKey.table);
    state.set(table, 'done'); ordered.push(table);
  };
  for (const table of tables.values()) visit(table);
  const plans: PlannedSchema[] = [];
  const add = (table: AnyTable, action: SchemaPlan['action'], model: CreateTableModel | CreateIndexModel): void => { plans.push({table: table.name, action, model, sql: compilePostgresDDL(model, schema)}); };
  for (const table of ordered) add(table, 'create-table', mappedCreateTableModel(table));
  const names = new Map<string, {table: PhysicalTableIdentity; index: PostgresSchemaTableDetails['table']['indexes'][number]}>();
  for (const table of actual.tables) for (const index of table.table.indexes) {
    const key = physicalTableKey(table.identity.schema, index.name, 'postgresql');
    if (names.has(key)) return drift();
    names.set(key, {table: table.identity, index});
  }
  const planned = new Set<string>();
  for (const table of tables.values()) for (const [column, definition] of Object.entries(table.columns as Columns)) {
    if (!definition.config.foreignKey) continue;
    const name = foreignIndex(table, column), target = identity(table, schema), key = physicalTableKey(target.schema, name, 'postgresql'), existing = names.get(key);
    if (found.has(key) || mappedIdentities.has(key) || planned.has(key)) return drift();
    if (existing) {
      const index = existing.index;
      const facts = found.get(keyOf(identity(table, schema)))?.indexes.find(index => index.name === name);
      if (keyOf(existing.table) !== keyOf(target) || index.unique || index.partial || index.columns.length !== 1 || index.columns[0] !== table.storage.columns[column]
        || !facts || !facts.valid || !facts.ready || !facts.live || !facts.immediate) return drift();
    } else {
      add(table, 'create-index', queryModel.createIndex({table: mappedTableModel(table), name, columns: [column]}));
      planned.add(key);
    }
  }
  return plans;
}

/** Read-only catalog work plus captured typed plans; never executes the returned CREATE SQL. */
export function* planPostgresSchemaWork(tables: ReadonlyMap<string, AnyTable>, schema = 'public'): Work<PlannedSchema[]> {
  const captured = registry(tables, schema), actual = yield* inspectPostgresSchemaDetailsWork(schema, Object.freeze([...captured.values()]), 'mapped');
  return plan(captured, actual, schema);
}

/** Must be driven inside the owning caller's SERIALIZABLE transaction. All validation happens before its COMMIT. */
export function* ensurePostgresSchemaWork(tables: ReadonlyMap<string, AnyTable>, schema = 'public'): Work<{plans: SchemaPlan[]; schema: SchemaTable[]}> {
  const captured = registry(tables, schema), before = yield* inspectPostgresSchemaDetailsWork(schema, Object.freeze([...captured.values()]), 'mapped'), plans = plan(captured, before, schema);
  for (const creation of plans) yield {sql: creation.sql, parameters: [], operation: 'schema', table: creation.table, control: true, decode: decodePostgresDDL};
  const after = yield* inspectPostgresSchemaDetailsWork(schema, Object.freeze([...captured.values()]), 'mapped');
  if (plan(captured, after, schema).length) return drift();
  return {plans: publicPlans(plans), schema: after.tables.map(table => table.table)};
}
