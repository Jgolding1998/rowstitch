/**
 * Private native catalog and setting readers. Each is one fixed statement, so its metadata comes from one snapshot; that alone
 * is not a lasting guarantee against later DDL. These readers apply no policy: root's comparison decides what a snapshot means.
 * The SQL text is compiler-owned. Every relation, function, operator and cast is pg_catalog-qualified, and all names are bound.
 */
import type { AsyncOperationOptions, AsyncTransaction } from './async-session.js';
import { RowstitchError } from './errors.js';
import { snapshotPostgresPhysical, snapshotPostgresSettings, type PostgresPhysicalSnapshot, type PostgresSettings } from './postgres-physical.js';
import { decodePostgresRows, snapshotPostgresResult, type PostgresOutputField, type PostgresRawResult } from './postgres-result.js';
import { identifier, isTable, type AnyTable } from './schema.js';

type Owner = Pick<AsyncTransaction<PostgresRawResult>, 'all'>;

const invalid = (code: 'VALIDATION' | 'DATA' | 'SCHEMA', message: string): never => { throw new RowstitchError(code, message); };

const TEXT = '"pg_catalog"."text"', INT4 = '"pg_catalog"."int4"', INT8 = '"pg_catalog"."int8"', NAME = '"pg_catalog"."name"', JSONB = '"pg_catalog"."jsonb"', OID_ARRAY = '"pg_catalog"."oid"[]', INT2_ARRAY = '"pg_catalog"."int2"[]';
const EQ = 'OPERATOR("pg_catalog".=)', NE = 'OPERATOR("pg_catalog".<>)', GT = 'OPERATOR("pg_catalog".>)', LE = 'OPERATOR("pg_catalog".<=)';
const OBJECT = '"pg_catalog"."jsonb_build_object"', AGG = '"pg_catalog"."jsonb_agg"', SETTING = '"pg_catalog"."current_setting"', UNNEST = '"pg_catalog"."unnest"';
const setting = (name: string, cast: string): string => `${SETTING}('${name}'::${TEXT})::${cast}`;
/** A JSON array, also when nothing matched: a table can legally have no columns, or no indexes. */
const list = (query: string): string => `COALESCE((${query}), '[]'::${JSONB})`;

/** Index key and included entries by position, including a null name for each expression. indkey uses 0 for an expression, which matches no attribute. */
const indexNames = (condition: string): string => list(`SELECT ${AGG}(a."attname"::${TEXT} ORDER BY k."ordinality")
    FROM ${UNNEST}(i."indkey"::${INT2_ARRAY}) WITH ORDINALITY AS k("attnum", "ordinality")
    LEFT JOIN "pg_catalog"."pg_attribute" a ON a."attrelid" ${EQ} c."oid" AND a."attnum" ${EQ} k."attnum"
    WHERE k."ordinality" ${condition} i."indnkeyatts"`);

const CATALOG_ALIAS = '__rs_pg_catalog', SETTINGS_ALIAS = '__rs_pg_settings';
const CATALOG_SQL = `SELECT ${OBJECT}(
  'format', 'rowstitch-postgres-physical-v1'::${TEXT},
  'serverVersion', ${setting('server_version_num', INT4)},
  'schema', n."nspname"::${TEXT},
  'name', c."relname"::${TEXT},
  'oid', c."oid"::${INT8},
  'relation', ${OBJECT}(
    'kind', c."relkind"::${TEXT},
    'persistence', c."relpersistence"::${TEXT},
    'isPartition', c."relispartition",
    'hasDescendants', EXISTS (SELECT 1 FROM "pg_catalog"."pg_inherits" h WHERE h."inhparent" ${EQ} c."oid"),
    'hasAncestors', EXISTS (SELECT 1 FROM "pg_catalog"."pg_inherits" h WHERE h."inhrelid" ${EQ} c."oid"),
    'rowSecurity', c."relrowsecurity",
    'forceRowSecurity', c."relforcerowsecurity",
    'hasRules', EXISTS (SELECT 1 FROM "pg_catalog"."pg_rewrite" r WHERE r."ev_class" ${EQ} c."oid" AND r."rulename" ${NE} '_RETURN'::${NAME}),
    'userTriggers', (SELECT "pg_catalog"."count"(*) FROM "pg_catalog"."pg_trigger" g WHERE g."tgrelid" ${EQ} c."oid" AND NOT g."tgisinternal")
  ),
  'columns', ${list(`SELECT ${AGG}(${OBJECT}(
      'name', a."attname"::${TEXT},
      'position', a."attnum"::${INT4},
      'typeOid', a."atttypid"::${INT8},
      'typeModifier', a."atttypmod",
      'arrayDimensions', a."attndims"::${INT4},
      'notNull', a."attnotnull",
      'notNullValid', NOT EXISTS (SELECT 1 FROM "pg_catalog"."pg_constraint" k
        WHERE k."conrelid" ${EQ} c."oid" AND k."contype" ${EQ} 'n'::"pg_catalog"."char" AND NOT k."convalidated" AND a."attnum" ${EQ} ANY (k."conkey")),
      'hasDefault', a."atthasdef",
      'identity', a."attidentity"::${TEXT},
      'generated', a."attgenerated"::${TEXT},
      'collationOid', a."attcollation"::${INT8}
    ) ORDER BY a."attnum")
    FROM "pg_catalog"."pg_attribute" a
    WHERE a."attrelid" ${EQ} c."oid" AND a."attnum" ${GT} 0 AND NOT a."attisdropped"`)},
  'indexes', ${list(`SELECT ${AGG}(${OBJECT}(
      'oid', i."indexrelid"::${INT8},
      'primary', i."indisprimary",
      'unique', i."indisunique",
      'valid', i."indisvalid",
      'ready', i."indisready",
      'live', i."indislive",
      'immediate', i."indimmediate",
      'nullsNotDistinct', i."indnullsnotdistinct",
      'keyColumns', ${indexNames(LE)},
      'includedColumns', ${indexNames(GT)},
      'collationOids', ${list(`SELECT ${AGG}(o."collation"::${INT8} ORDER BY o."ordinality")
        FROM ${UNNEST}(i."indcollation"::${OID_ARRAY}) WITH ORDINALITY AS o("collation", "ordinality")`)},
      'hasExpressions', i."indexprs" IS NOT NULL,
      'partial', i."indpred" IS NOT NULL
    ) ORDER BY i."indexrelid")
    FROM "pg_catalog"."pg_index" i WHERE i."indrelid" ${EQ} c."oid"`)}
) AS "${CATALOG_ALIAS}"
FROM "pg_catalog"."pg_class" c
JOIN "pg_catalog"."pg_namespace" n ON n."oid" ${EQ} c."relnamespace"
WHERE n."nspname" ${EQ} $1::${NAME} AND c."relname" ${EQ} $2::${NAME}`;

const SETTINGS_SQL = `SELECT ${OBJECT}(
  'serverVersion', ${setting('server_version_num', INT4)},
  'clientEncoding', ${setting('client_encoding', TEXT)},
  'serverEncoding', ${setting('server_encoding', TEXT)},
  'extraFloatDigits', ${setting('extra_float_digits', INT4)},
  'replicationRole', ${setting('session_replication_role', TEXT)},
  'searchPath', ${setting('search_path', TEXT)}
) AS "${SETTINGS_ALIAS}"`;

const output = (alias: string): readonly PostgresOutputField[] => Object.freeze([Object.freeze({ alias, property: 'value', kind: 'json', nullable: false })]);
const CATALOG_OUTPUT = output(CATALOG_ALIAS), SETTINGS_OUTPUT = output(SETTINGS_ALIAS);

function requireOwner(owner: Owner): void {
  if (owner === null || typeof owner !== 'object' || typeof owner.all !== 'function') invalid('VALIDATION', 'A PostgreSQL catalog read requires a session or transaction handle.');
}
/** The field contract is checked even when nothing matched. A row count that disagrees with the rows is not a usable answer. */
function decoded(value: unknown, outputs: readonly PostgresOutputField[]): unknown[] {
  const raw = snapshotPostgresResult(value);
  if (raw.command !== 'SELECT' || raw.rowCount !== BigInt(raw.rows.length)) invalid('DATA', 'PostgreSQL returned an unexpected command or row count for this catalog statement.');
  return decodePostgresRows(raw, outputs).map(row => row.value);
}

/**
 * Reads the one named relation, of any kind, or null if there is none. All arguments are captured before any await, and the statement is
 * issued in this same turn. One statement means that nothing is left unfinished between steps once it settles.
 */
export async function readPostgresPhysical(owner: Owner, table: AnyTable, schema = 'public', options?: AsyncOperationOptions): Promise<PostgresPhysicalSnapshot | null> {
  requireOwner(owner);
  if (!isTable(table)) return invalid('SCHEMA', 'A PostgreSQL catalog read requires a genuine mapped table.');
  identifier(schema);
  // The same namespaces that root plans refuse, so a snapshot can never describe a table that no plan may use.
  if (/^(?:pg_|information_schema$)/i.test(schema)) return invalid('SCHEMA', 'System and temporary PostgreSQL schemas are not supported by root plans.');
  const parameters = Object.freeze([schema, table.name]);
  const rows = decoded(await owner.all(CATALOG_SQL, parameters, options), CATALOG_OUTPUT);
  if (rows.length > 1) return invalid('SCHEMA', 'More than one PostgreSQL relation matched this qualified name.');
  return rows.length === 0 ? null : snapshotPostgresPhysical(rows[0]);
}

/** Reads the current session values of the fixed settings. It never changes one. */
export async function readPostgresSettings(owner: Owner, options?: AsyncOperationOptions): Promise<PostgresSettings> {
  requireOwner(owner);
  const rows = decoded(await owner.all(SETTINGS_SQL, Object.freeze([]), options), SETTINGS_OUTPUT);
  if (rows.length !== 1) return invalid('DATA', 'PostgreSQL did not return exactly one row of session settings.');
  return snapshotPostgresSettings(rows[0]);
}
