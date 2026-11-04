/** Bounded native catalog inspection. Descriptive metadata, not a full PostgreSQL schema verifier or DDL planner. */
import { types } from 'node:util';
import { RowstitchError } from './errors.js';
import { identifier } from './schema.js';
import { isPostgresRawResult, snapshotPostgresResult, type PostgresRawResult } from './postgres-result.js';
import type { Rows, SchemaColumn, SchemaForeignKey, SchemaIndex, SchemaTable, Work } from './repository-core.js';

export interface PostgresSchemaColumnDetails {
  readonly name: string; readonly typeOid: number; readonly identity: '' | 'a' | 'd';
  readonly generation: '' | 's' | 'v'; readonly hasDefault: boolean;
}
export interface PostgresSchemaTableDetails {
  readonly table: SchemaTable; readonly kind: 'r' | 'p' | 'v' | 'm' | 'f';
  readonly columns: readonly PostgresSchemaColumnDetails[];
  readonly foreignKeys: readonly PostgresSchemaForeignKeyDetails[];
  readonly indexes: readonly PostgresSchemaIndexDetails[];
}
export interface PostgresSchemaForeignKeyDetails {
  readonly name: string; readonly columns: readonly string[]; readonly table: string; readonly targets: readonly string[];
  readonly onDelete: string; readonly onUpdate: string; readonly enforced: boolean; readonly validated: boolean;
}
export interface PostgresSchemaIndexDetails {
  readonly name: string; readonly primary: boolean; readonly valid: boolean; readonly ready: boolean;
  readonly live: boolean; readonly immediate: boolean;
}
/** Private planning facts. Existence, privileges and descriptive metadata are not execution authorization. */
export interface PostgresSchemaDetails {
  readonly schema: string; readonly exists: boolean; readonly tables: readonly PostgresSchemaTableDetails[];
}

const MAX_ITEMS = 100, MAX_JSON = 8_388_608, MAX_NODES = 500_000, MAX_DEPTH = 12;
const { isProxy } = types;
const { getPrototypeOf, ownKeys } = Reflect;
const { getOwnPropertyDescriptors, hasOwn } = Object;
const parseJson = JSON.parse;
const error = (limit = false): never => { throw new RowstitchError(limit ? 'RESULT_LIMIT' : 'DATA', limit
  ? 'PostgreSQL schema inspection exceeded its bounded metadata limits.'
  : 'PostgreSQL schema metadata did not match its inspection contract.'); };

// Every relation and catalog function is qualified. Only the selected namespace is bound; no caller SQL is accepted.
// LIMIT 101 is deliberate: a 101st item is returned and rejected, never silently omitted as a complete schema.
const CATALOG = `WITH relations AS (
  SELECT c.oid, c.relname, c.relkind::"pg_catalog"."text" AS kind
  FROM "pg_catalog"."pg_class" c
  JOIN "pg_catalog"."pg_namespace" n ON n.oid OPERATOR("pg_catalog".=) c.relnamespace
  WHERE n.nspname::"pg_catalog"."text" OPERATOR("pg_catalog".=) $1::"pg_catalog"."text"
    AND c.relkind OPERATOR("pg_catalog".=) ANY (ARRAY['r','p','v','m','f']::"pg_catalog"."char"[])
    AND "pg_catalog"."has_schema_privilege"(n.oid, 'USAGE')
    AND ("pg_catalog"."pg_has_role"(c.relowner, 'USAGE')
      OR "pg_catalog"."has_table_privilege"(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR "pg_catalog"."has_any_column_privilege"(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  ORDER BY c.relname::"pg_catalog"."text" COLLATE "pg_catalog"."C", c.oid
  LIMIT 101
), described AS (
  SELECT r.relname::"pg_catalog"."text" AS name,
    "pg_catalog"."jsonb_build_object"(
      'name', r.relname::"pg_catalog"."text", 'kind', r.kind,
      'columns', (
        SELECT COALESCE("pg_catalog"."jsonb_agg"(a.payload ORDER BY a.attnum), '[]'::"pg_catalog"."jsonb")
        FROM (
          SELECT a.attnum, "pg_catalog"."jsonb_build_object"(
            'name', a.attname::"pg_catalog"."text",
            'type', "pg_catalog"."format_type"(a.atttypid, a.atttypmod),
            'nullable', NOT (a.attnotnull OR (
              WITH RECURSIVE bases AS (
                SELECT t.oid, t.typbasetype, t.typnotnull
                UNION
                SELECT parent.oid, parent.typbasetype, parent.typnotnull
                FROM "pg_catalog"."pg_type" parent
                JOIN bases child ON parent.oid OPERATOR("pg_catalog".=) child.typbasetype
              ) SELECT "pg_catalog"."bool_or"(b.typnotnull) FROM bases b
            )),
            'primaryKeyOrder', COALESCE((
              SELECT "pg_catalog"."array_position"(p.conkey, a.attnum)
              FROM "pg_catalog"."pg_constraint" p
              WHERE p.conrelid OPERATOR("pg_catalog".=) r.oid AND p.contype OPERATOR("pg_catalog".=) 'p'
            ), 0),
            'default', CASE WHEN a.attgenerated OPERATOR("pg_catalog".=) ''
              THEN "pg_catalog"."pg_get_expr"(d.adbin, d.adrelid) ELSE NULL END,
            'generated', a.attgenerated OPERATOR("pg_catalog".=) ANY (ARRAY['s','v']::"pg_catalog"."char"[]),
            'typeOid', a.atttypid::"pg_catalog"."int8", 'identity', a.attidentity::"pg_catalog"."text",
            'generation', a.attgenerated::"pg_catalog"."text",
            'hasDefault', a.attgenerated OPERATOR("pg_catalog".=) '' AND d.oid IS NOT NULL
          ) AS payload
          FROM "pg_catalog"."pg_attribute" a
          JOIN "pg_catalog"."pg_type" t ON t.oid OPERATOR("pg_catalog".=) a.atttypid
          LEFT JOIN "pg_catalog"."pg_attrdef" d ON d.adrelid OPERATOR("pg_catalog".=) r.oid AND d.adnum OPERATOR("pg_catalog".=) a.attnum
          WHERE a.attrelid OPERATOR("pg_catalog".=) r.oid AND a.attnum OPERATOR("pg_catalog".>) 0 AND NOT a.attisdropped
          ORDER BY a.attnum LIMIT 101
        ) a
      ),
      'foreignKeys', (
        SELECT COALESCE("pg_catalog"."jsonb_agg"(f.payload ORDER BY f.constraint_name COLLATE "pg_catalog"."C", f.constraint_oid, f.position), '[]'::"pg_catalog"."jsonb")
        FROM (
          SELECT fk.conname::"pg_catalog"."text" AS constraint_name, fk.oid AS constraint_oid, k.position,
            "pg_catalog"."jsonb_build_object"(
              'constraint', fk.conname::"pg_catalog"."text", 'position', k.position,
              'column', local_column.attname::"pg_catalog"."text",
              'targetSchema', target_namespace.nspname::"pg_catalog"."text", 'targetTable', target_relation.relname::"pg_catalog"."text",
              'target', target_column.attname::"pg_catalog"."text",
              'enforced', fk.conenforced, 'validated', fk.convalidated,
              'onDelete', CASE WHEN fk.confdeltype OPERATOR("pg_catalog".=) 'a' THEN 'no action' WHEN fk.confdeltype OPERATOR("pg_catalog".=) 'r' THEN 'restrict' WHEN fk.confdeltype OPERATOR("pg_catalog".=) 'c' THEN 'cascade' WHEN fk.confdeltype OPERATOR("pg_catalog".=) 'n' THEN 'set null' WHEN fk.confdeltype OPERATOR("pg_catalog".=) 'd' THEN 'set default' ELSE NULL END,
              'onUpdate', CASE WHEN fk.confupdtype OPERATOR("pg_catalog".=) 'a' THEN 'no action' WHEN fk.confupdtype OPERATOR("pg_catalog".=) 'r' THEN 'restrict' WHEN fk.confupdtype OPERATOR("pg_catalog".=) 'c' THEN 'cascade' WHEN fk.confupdtype OPERATOR("pg_catalog".=) 'n' THEN 'set null' WHEN fk.confupdtype OPERATOR("pg_catalog".=) 'd' THEN 'set default' ELSE NULL END
            ) AS payload
          FROM "pg_catalog"."pg_constraint" fk
          JOIN "pg_catalog"."pg_class" target_relation ON target_relation.oid OPERATOR("pg_catalog".=) fk.confrelid
          JOIN "pg_catalog"."pg_namespace" target_namespace ON target_namespace.oid OPERATOR("pg_catalog".=) target_relation.relnamespace
          CROSS JOIN LATERAL "pg_catalog"."unnest"(fk.conkey) WITH ORDINALITY AS k(attnum, position)
          JOIN "pg_catalog"."pg_attribute" local_column ON local_column.attrelid OPERATOR("pg_catalog".=) r.oid AND local_column.attnum OPERATOR("pg_catalog".=) k.attnum
          JOIN "pg_catalog"."pg_attribute" target_column ON target_column.attrelid OPERATOR("pg_catalog".=) fk.confrelid AND target_column.attnum OPERATOR("pg_catalog".=) fk.confkey[k.position::"pg_catalog"."int4"]
          WHERE fk.conrelid OPERATOR("pg_catalog".=) r.oid AND fk.contype OPERATOR("pg_catalog".=) 'f'
            AND NOT EXISTS (
              SELECT 1 FROM "pg_catalog"."pg_constraint" parent_fk
              WHERE parent_fk.oid OPERATOR("pg_catalog".=) fk.conparentid AND parent_fk.conrelid OPERATOR("pg_catalog".=) fk.conrelid
            )
          ORDER BY fk.conname::"pg_catalog"."text" COLLATE "pg_catalog"."C", fk.oid, k.position LIMIT 101
        ) f
      ),
      'indexes', (
        SELECT COALESCE("pg_catalog"."jsonb_agg"(i.payload ORDER BY i.index_name COLLATE "pg_catalog"."C", i.index_oid), '[]'::"pg_catalog"."jsonb")
        FROM (
          SELECT ic.relname::"pg_catalog"."text" AS index_name, i.indexrelid AS index_oid,
            "pg_catalog"."jsonb_build_object"(
              'name', ic.relname::"pg_catalog"."text", 'unique', i.indisunique,
              'primary', i.indisprimary, 'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive, 'immediate', i.indimmediate,
              'origin', CASE WHEN EXISTS (
                SELECT 1 FROM "pg_catalog"."pg_constraint" p
                WHERE p.conrelid OPERATOR("pg_catalog".=) r.oid AND p.conindid OPERATOR("pg_catalog".=) i.indexrelid AND p.contype OPERATOR("pg_catalog".=) 'p'
              ) THEN 'p' WHEN EXISTS (
                SELECT 1 FROM "pg_catalog"."pg_constraint" u
                WHERE u.conrelid OPERATOR("pg_catalog".=) r.oid AND u.conindid OPERATOR("pg_catalog".=) i.indexrelid AND u.contype OPERATOR("pg_catalog".=) 'u'
              ) THEN 'u' ELSE 'c' END,
              'partial', i.indpred IS NOT NULL,
              'columns', (
                SELECT COALESCE("pg_catalog"."jsonb_agg"(a.attname::"pg_catalog"."text" ORDER BY key.position), '[]'::"pg_catalog"."jsonb")
                FROM "pg_catalog"."unnest"(i.indkey::"pg_catalog"."int2"[]) WITH ORDINALITY AS key(attnum, position)
                LEFT JOIN "pg_catalog"."pg_attribute" a ON a.attrelid OPERATOR("pg_catalog".=) r.oid AND a.attnum OPERATOR("pg_catalog".=) key.attnum
                WHERE key.position OPERATOR("pg_catalog".<=) i.indnkeyatts
              )
            ) AS payload
          FROM "pg_catalog"."pg_index" i
          JOIN "pg_catalog"."pg_class" ic ON ic.oid OPERATOR("pg_catalog".=) i.indexrelid
          WHERE i.indrelid OPERATOR("pg_catalog".=) r.oid
          ORDER BY ic.relname::"pg_catalog"."text" COLLATE "pg_catalog"."C", i.indexrelid LIMIT 101
        ) i
      )
    ) AS payload
  FROM relations r
)
SELECT "pg_catalog"."jsonb_build_object"('schema', $1::"pg_catalog"."text",
  'exists', EXISTS (SELECT 1 FROM "pg_catalog"."pg_namespace" n WHERE n.nspname::"pg_catalog"."text" OPERATOR("pg_catalog".=) $1::"pg_catalog"."text"), 'tables',
  COALESCE("pg_catalog"."jsonb_agg"(d.payload ORDER BY d.name COLLATE "pg_catalog"."C"), '[]'::"pg_catalog"."jsonb")) AS "__rs_pg_schema"
FROM described d`;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![null, Object.prototype].includes(getPrototypeOf(value))) return error();
  const descriptors = getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  if (ownKeys(descriptors).length !== keys.length) return error();
  for (const key of keys) {
    const descriptor = hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return error();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum = MAX_ITEMS, limit = true): unknown[] {
  if (!value || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) return error();
  const prototype = getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return error();
  const descriptors = getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return error();
  if (length > maximum) return error(limit);
  if (ownKeys(descriptors).length !== length + 1) return error();
  return Array.from({ length }, (_, i) => {
    const key = String(i), descriptor = hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return error();
    return descriptor.value;
  });
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) return error();
  if (value.length > maximum) return error(true);
  return value;
}
const name = (value: unknown): string => text(value, 63);
function flag(value: unknown): boolean { if (typeof value !== 'boolean') return error(); return value; }
function ordinal(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX_ITEMS) return error();
  return value;
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) error(true);
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) boundedJson(child, depth + 1, budget);
}
function rawSnapshot(value: unknown): PostgresRawResult {
  if (isPostgresRawResult(value)) return snapshotPostgresResult(value);
  const input = record(value, ['fields', 'rows', 'command', 'rowCount']);
  const fields = list(input.fields, 1, false).map(item => record(item, ['name', 'typeOid']));
  return snapshotPostgresResult({ fields, rows: list(input.rows, 1, false).map(row => list(row, 1, false)), command: input.command, rowCount: input.rowCount });
}
function decodeSchema(value: unknown, schema: string): Rows {
  try {
    const raw = rawSnapshot(value);
    if (raw.command !== 'SELECT' || raw.rowCount !== 1n || raw.rows.length !== 1 || raw.fields.length !== 1
      || raw.fields[0]!.name !== '__rs_pg_schema' || raw.fields[0]!.typeOid !== 3802) return error();
    const wire = raw.rows[0]![0];
    if (typeof wire !== 'string' || wire.includes('\0') || /[\uD800-\uDFFF]/u.test(wire)) return error();
    if (wire.length > MAX_JSON) return error(true);
    const parsed: unknown = parseJson(wire); boundedJson(parsed);
    const payload = record(parsed, ['schema', 'exists', 'tables']);
    if (payload.schema !== schema) return error();
    const exists = flag(payload.exists);
    const tableNames = new Set<string>();
    const tables: PostgresSchemaTableDetails[] = list(payload.tables).map(input => {
      const table = record(input, ['name', 'kind', 'columns', 'foreignKeys', 'indexes']);
      const tableName = name(table.name);
      if (!['r', 'p', 'v', 'm', 'f'].includes(table.kind as string)) return error();
      if (tableNames.has(tableName)) return error(); tableNames.add(tableName);
      const columnNames = new Set<string>(), primaryPositions = new Set<number>();
      const columnDetails: PostgresSchemaColumnDetails[] = [];
      const columns: SchemaColumn[] = list(table.columns).map(input => {
        const column = record(input, ['name', 'type', 'nullable', 'primaryKeyOrder', 'default', 'generated', 'typeOid', 'identity', 'generation', 'hasDefault']);
        const columnName = name(column.name), order = ordinal(column.primaryKeyOrder, true);
        if (columnNames.has(columnName) || order > 0 && primaryPositions.has(order)) return error();
        columnNames.add(columnName); if (order > 0) primaryPositions.add(order);
        const generated = flag(column.generated), nullable = flag(column.nullable);
        const expression = column.default === null ? null : text(column.default, 16_384);
        const hasDefault = flag(column.hasDefault);
        if (typeof column.typeOid !== 'number' || !Number.isSafeInteger(column.typeOid) || column.typeOid < 1 || column.typeOid > 0xffff_ffff
          || !['', 'a', 'd'].includes(column.identity as string) || !['', 's', 'v'].includes(column.generation as string)
          || generated !== (column.generation !== '') || generated && column.identity !== ''
          || generated && expression !== null || hasDefault !== (expression !== null) || order > 0 && nullable) return error();
        columnDetails.push(Object.freeze({ name: columnName, typeOid: column.typeOid, identity: column.identity as '' | 'a' | 'd',
          generation: column.generation as '' | 's' | 'v', hasDefault }));
        return { name: columnName, type: text(column.type, 1024), nullable, primaryKey: order > 0,
          primaryKeyOrder: order, default: expression, generated, hidden: false };
      });
      for (let position = 1; position <= primaryPositions.size; position++) if (!primaryPositions.has(position)) return error();
      const constraints = new Map<string, { positions: Set<number>; columns: Set<string>; pairs: Map<number, { column: string; target: string }>; target: string; onDelete: string; onUpdate: string; enforced: boolean; validated: boolean }>();
      const actions = new Set(['no action', 'restrict', 'cascade', 'set null', 'set default']);
      const foreignKeys: SchemaForeignKey[] = list(table.foreignKeys).map(input => {
        const fk = record(input, ['constraint', 'position', 'column', 'targetSchema', 'targetTable', 'target', 'onDelete', 'onUpdate', 'enforced', 'validated']);
        const constraintName = name(fk.constraint), position = ordinal(fk.position), column = name(fk.column);
        const targetSchema = name(fk.targetSchema), targetTable = name(fk.targetTable), target = name(fk.target);
        const enforced = flag(fk.enforced), validated = flag(fk.validated);
        if (!columnNames.has(column) || typeof fk.onDelete !== 'string' || !actions.has(fk.onDelete)
          || typeof fk.onUpdate !== 'string' || !actions.has(fk.onUpdate)) return error();
        const qualified = targetSchema === schema ? targetTable : '"' + targetSchema.replaceAll('"', '""') + '"."' + targetTable.replaceAll('"', '""') + '"';
        let constraint = constraints.get(constraintName);
        if (constraint && (constraint.positions.has(position) || constraint.columns.has(column) || constraint.target !== qualified
          || constraint.onDelete !== fk.onDelete || constraint.onUpdate !== fk.onUpdate || constraint.enforced !== enforced || constraint.validated !== validated)) return error();
        if (!constraint) { constraint = { positions: new Set(), columns: new Set(), pairs: new Map(), target: qualified, onDelete: fk.onDelete, onUpdate: fk.onUpdate, enforced, validated }; constraints.set(constraintName, constraint); }
        constraint.positions.add(position); constraint.columns.add(column); constraint.pairs.set(position, { column, target });
        return { column, table: qualified, target, onDelete: fk.onDelete, onUpdate: fk.onUpdate };
      });
      for (const constraint of constraints.values()) for (let position = 1; position <= constraint.positions.size; position++) if (!constraint.positions.has(position)) return error();
      const foreignDetails: PostgresSchemaForeignKeyDetails[] = [...constraints].map(([name, constraint]) => {
        const pairs = [...constraint.pairs].sort(([left], [right]) => left - right).map(([, pair]) => pair);
        return Object.freeze({ name, columns: Object.freeze(pairs.map(pair => pair.column)), table: constraint.target,
          targets: Object.freeze(pairs.map(pair => pair.target)), onDelete: constraint.onDelete, onUpdate: constraint.onUpdate,
          enforced: constraint.enforced, validated: constraint.validated });
      });
      const indexNames = new Set<string>();
      const indexDetails: PostgresSchemaIndexDetails[] = [];
      const indexes: SchemaIndex[] = list(table.indexes).map(input => {
        const index = record(input, ['name', 'columns', 'unique', 'origin', 'partial', 'primary', 'valid', 'ready', 'live', 'immediate']), indexName = name(index.name);
        if (indexNames.has(indexName) || !['p', 'u', 'c'].includes(index.origin as string)) return error(); indexNames.add(indexName);
        const unique = flag(index.unique), keys = list(index.columns).map(value => { if (value === null) return null; const key = name(value); if (!columnNames.has(key)) return error(); return key; });
        if (keys.length === 0 || index.origin !== 'c' && !unique) return error();
        indexDetails.push(Object.freeze({name: indexName, primary: flag(index.primary), valid: flag(index.valid), ready: flag(index.ready), live: flag(index.live), immediate: flag(index.immediate)}));
        return { name: indexName, columns: keys, unique, origin: index.origin as string, partial: flag(index.partial) };
      });
      return Object.freeze({ table: { name: tableName, columns, foreignKeys, indexes },
        kind: table.kind as PostgresSchemaTableDetails['kind'], columns: Object.freeze(columnDetails), foreignKeys: Object.freeze(foreignDetails), indexes: Object.freeze(indexDetails) });
    });
    if (!exists && tables.length) return error();
    return [{ details: Object.freeze({ schema, exists, tables: Object.freeze(tables) }) }];
  } catch (cause) { if (cause instanceof RowstitchError && cause.code === 'RESULT_LIMIT') throw cause; return error(); }
}

/**
 * Metadata visible through namespace USAGE and owner/table/column privileges; independent of search_path.
 * All columns of admitted relations are described. Cross-schema FK targets are quoted display names.
 * Current SchemaTable cannot describe identity, generation expressions, CHECK/role policies, index INCLUDE/validity
 * or all FK enforcement details. This inspection must not authorize automatic DDL or prove those features absent.
 */
export function* inspectPostgresSchemaDetailsWork(schema = 'public'): Work<PostgresSchemaDetails> {
  identifier(schema);
  if (/^(?:pg_|information_schema$)/i.test(schema)) throw new RowstitchError('SCHEMA', 'Inspect a supported user namespace.');
  const rows = yield { sql: CATALOG, parameters: Object.freeze([schema]), metadata: true, operation: 'schema', table: '',
    decode: (value: unknown) => decodeSchema(value, schema) };
  if (rows.length !== 1 || !rows[0]?.details || typeof rows[0].details !== 'object') return error();
  return rows[0].details as PostgresSchemaDetails;
}

/** Existing public schema shape; private identity/OID/kind/default facts never become invented public fields. */
export function* inspectPostgresSchemaWork(schema = 'public'): Work<SchemaTable[]> {
  const details = yield* inspectPostgresSchemaDetailsWork(schema);
  return details.tables.map(table => table.table);
}
