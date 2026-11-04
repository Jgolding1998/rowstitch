/** Private, bounded catalog snapshots and a deliberately narrow physical mapping policy. */
import { RowstitchError } from './errors.js';
import { identifier, isTable, type AnyTable, type Columns, type Table } from './schema.js';
export interface PostgresPhysicalColumn {
  readonly name: string;
  readonly position: number;
  readonly typeOid: number;
  readonly typeModifier: number;
  readonly arrayDimensions: number;
  readonly notNull: boolean;
  readonly notNullValid: boolean;
  readonly hasDefault: boolean;
  readonly identity: '' | 'a' | 'd';
  readonly generated: '' | 's' | 'v';
  readonly collationOid: number;
}
export interface PostgresPhysicalIndex {
  readonly oid: number;
  readonly primary: boolean;
  readonly unique: boolean;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly live: boolean;
  readonly immediate: boolean;
  readonly nullsNotDistinct: boolean;
  readonly keyColumns: readonly (string | null)[];
  readonly includedColumns: readonly (string | null)[];
  readonly collationOids: readonly number[];
  readonly hasExpressions: boolean;
  readonly partial: boolean;
}
export interface PostgresPhysicalSnapshot {
  readonly format: 'rowstitch-postgres-physical-v1';
  readonly serverVersion: number;
  readonly schema: string;
  readonly name: string;
  readonly oid: number;
  readonly relation: {
    readonly kind: string;
    readonly persistence: string;
    readonly isPartition: boolean;
    readonly hasDescendants: boolean;
    readonly hasAncestors: boolean;
    readonly rowSecurity: boolean;
    readonly forceRowSecurity: boolean;
    readonly hasRules: boolean;
    readonly userTriggers: number;
  };
  readonly columns: readonly PostgresPhysicalColumn[];
  readonly indexes: readonly PostgresPhysicalIndex[];
}
export interface PostgresSettings {
  readonly serverVersion: number;
  readonly clientEncoding: string;
  readonly serverEncoding: string;
  readonly extraFloatDigits: number;
  readonly replicationRole: string;
  readonly searchPath: string;
}

export type PostgresPhysicalReason = 'MISSING' | 'SERVER_VERSION' | 'RELATION_IDENTITY' | 'RELATION_KIND'
  | 'RELATION_PERSISTENCE' | 'INHERITANCE' | 'ROW_SECURITY' | 'REWRITE_RULES' | 'USER_TRIGGERS'
  | 'COLUMN_SET' | 'COLUMN_TYPE' | 'COLUMN_NULLABILITY' | 'COLUMN_NOT_NULL_INVALID' | 'COLUMN_GENERATED'
  | 'COLUMN_IDENTITY' | 'COLUMN_DEFAULT' | 'PRIMARY_KEY' | 'KEY_COLLATION' | 'UNIQUE';
export type PostgresSettingsReason = 'SERVER_VERSION' | 'ENCODING' | 'FLOAT_PRECISION' | 'REPLICATION_ROLE' | 'SEARCH_PATH';

const physical = new WeakSet<object>(), settings = new WeakSet<object>();
const MAX_COLUMNS = 512, MAX_INDEXES = 512;
const nativeOid = Object.freeze({ integer:20, bigint:20, real:701, text:25, boolean:16, json:3802 });
const bad = (): never => { throw new Error('Invalid private snapshot.'); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![null,Object.prototype].includes(Object.getPrototypeOf(value))) return bad();
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return bad();
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !('value' in d) || !d.enumerable) return bad();
    result[key] = d.value;
  }
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || ![null,Array.prototype].includes(Object.getPrototypeOf(value)) || value.length > max) return bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return bad();
  return Array.from({ length:value.length }, (_,i) => {
    const d = descriptors[String(i)];
    if (!d || !('value' in d) || !d.enumerable) return bad();
    return d.value;
  });
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && value.length === 0
      || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) return bad();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return bad();
  return value;
}
const oid = (value: unknown, zero = false): number => integer(value, zero ? 0 : 1, 0xffff_ffff);
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : bad(); }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return bad();
  return value as T;
}
function captureColumn(value: unknown): PostgresPhysicalColumn {
  const r = record(value,['name','position','typeOid','typeModifier','arrayDimensions','notNull','notNullValid','hasDefault','identity','generated','collationOid']);
  return Object.freeze({ name:text(r.name), position:integer(r.position,1,32767), typeOid:oid(r.typeOid),
    typeModifier:integer(r.typeModifier,-0x8000_0000,0x7fff_ffff), arrayDimensions:integer(r.arrayDimensions,0,32767),
    notNull:bool(r.notNull), notNullValid:bool(r.notNullValid), hasDefault:bool(r.hasDefault),
    identity:choice(r.identity,['','a','d'] as const), generated:choice(r.generated,['','s','v'] as const), collationOid:oid(r.collationOid,true) });
}
function captureIndex(value: unknown): PostgresPhysicalIndex {
  const r = record(value,['oid','primary','unique','valid','ready','live','immediate','nullsNotDistinct','keyColumns','includedColumns','collationOids','hasExpressions','partial']);
  const columns = (v:unknown) => Object.freeze(array(v,MAX_COLUMNS).map(name => name === null ? null : text(name)));
  const keyColumns = columns(r.keyColumns), includedColumns = columns(r.includedColumns);
  const collationOids = Object.freeze(array(r.collationOids,MAX_COLUMNS).map(value => oid(value,true)));
  if (keyColumns.length === 0 || keyColumns.length !== collationOids.length) return bad();
  return Object.freeze({ oid:oid(r.oid), primary:bool(r.primary), unique:bool(r.unique), valid:bool(r.valid),
    ready:bool(r.ready), live:bool(r.live), immediate:bool(r.immediate), nullsNotDistinct:bool(r.nullsNotDistinct),
    keyColumns, includedColumns, collationOids, hasExpressions:bool(r.hasExpressions), partial:bool(r.partial) });
}
/** Detached shape capture only. A snapshot identity never proves that a database was queried. */
export function snapshotPostgresPhysical(input: unknown): PostgresPhysicalSnapshot {
  try {
    const r = record(input,['format','serverVersion','schema','name','oid','relation','columns','indexes']);
    if (r.format !== 'rowstitch-postgres-physical-v1') return bad();
    const relation = record(r.relation,['kind','persistence','isPartition','hasDescendants','hasAncestors','rowSecurity','forceRowSecurity','hasRules','userTriggers']);
    const columns = Object.freeze(array(r.columns,MAX_COLUMNS).map(captureColumn));
    const indexes = Object.freeze(array(r.indexes,MAX_INDEXES).map(captureIndex));
    if (new Set(columns.map(c => c.name)).size !== columns.length
        || columns.some((c,i) => i > 0 && c.position <= columns[i-1]!.position)
        || indexes.some((index,i) => i > 0 && index.oid <= indexes[i-1]!.oid)) return bad();
    const result: PostgresPhysicalSnapshot = Object.freeze({ format:'rowstitch-postgres-physical-v1',
      serverVersion:integer(r.serverVersion,1,99_999_999), schema:text(r.schema), name:text(r.name), oid:oid(r.oid),
      relation:Object.freeze({ kind:text(relation.kind,1), persistence:text(relation.persistence,1),
        isPartition:bool(relation.isPartition), hasDescendants:bool(relation.hasDescendants), hasAncestors:bool(relation.hasAncestors),
        rowSecurity:bool(relation.rowSecurity), forceRowSecurity:bool(relation.forceRowSecurity), hasRules:bool(relation.hasRules),
        userTriggers:integer(relation.userTriggers,0,1_000_000) }), columns,indexes });
    physical.add(result);
    return result;
  } catch { throw new RowstitchError('SCHEMA','Invalid PostgreSQL physical snapshot.'); }
}
export function snapshotPostgresSettings(input: unknown): PostgresSettings {
  try {
    const r = record(input,['serverVersion','clientEncoding','serverEncoding','extraFloatDigits','replicationRole','searchPath']);
    const result = Object.freeze({ serverVersion:integer(r.serverVersion,1,99_999_999), clientEncoding:text(r.clientEncoding,63),
      serverEncoding:text(r.serverEncoding,63), extraFloatDigits:integer(r.extraFloatDigits,-0x8000_0000,0x7fff_ffff),
      replicationRole:text(r.replicationRole,63), searchPath:text(r.searchPath,8192,true) });
    settings.add(result);
    return result;
  } catch { throw new RowstitchError('DATA','Invalid PostgreSQL settings snapshot.'); }
}
function requirePhysical(value: PostgresPhysicalSnapshot): void {
  if (!value || typeof value !== 'object' || !physical.has(value)) throw new RowstitchError('SCHEMA','Capture a PostgreSQL physical snapshot.');
}
export function postgresPhysicalFingerprint(value: PostgresPhysicalSnapshot): string {
  requirePhysical(value);
  return JSON.stringify(value);
}
const validIndex = (index:PostgresPhysicalIndex): boolean => index.unique && index.valid && index.ready && index.live
  && index.immediate && !index.partial && !index.hasExpressions && index.keyColumns.every(c => c !== null);

/** Structural subset only: does not verify mapped FKs, CHECK/default expressions, roles or opclasses. */
export function comparePostgresPhysical(table: AnyTable, schema: string, value: PostgresPhysicalSnapshot | null): PostgresPhysicalReason | null {
  if (!isTable(table)) throw new RowstitchError('SCHEMA','A physical comparison requires a genuine mapped table.');
  const mapped = table as Table<Columns,string | undefined>;
  identifier(schema);
  if (/^(?:pg_|information_schema$)/i.test(schema)) throw new RowstitchError('SCHEMA','Unsupported PostgreSQL application schema.');
  if (value === null) return 'MISSING';
  requirePhysical(value);
  if (Math.floor(value.serverVersion/10_000) !== 18) return 'SERVER_VERSION';
  if (value.schema !== schema || value.name !== table.name) return 'RELATION_IDENTITY';
  const r = value.relation;
  if (r.kind !== 'r' || r.isPartition) return 'RELATION_KIND';
  if (r.persistence !== 'p') return 'RELATION_PERSISTENCE';
  if (r.hasDescendants || r.hasAncestors) return 'INHERITANCE';
  if (r.rowSecurity || r.forceRowSecurity) return 'ROW_SECURITY';
  if (r.hasRules) return 'REWRITE_RULES';
  if (r.userTriggers > 0) return 'USER_TRIGGERS';
  const names = Object.keys(mapped.columns), columns = new Map(value.columns.map(c => [c.name,c]));
  if (columns.size !== names.length || names.some(name => !columns.has(name))) return 'COLUMN_SET';
  for (const name of names) {
    const expected = mapped.columns[name]!.config, actual = columns.get(name)!;
    if (actual.typeOid !== nativeOid[expected.kind] || actual.typeModifier !== -1 || actual.arrayDimensions !== 0) return 'COLUMN_TYPE';
    if (actual.notNull !== !expected.nullable) return 'COLUMN_NULLABILITY';
    if (!actual.notNullValid) return 'COLUMN_NOT_NULL_INVALID';
    if (actual.generated !== '') return 'COLUMN_GENERATED';
    if (expected.generated ? actual.identity === '' && !actual.hasDefault : actual.identity !== '') return 'COLUMN_IDENTITY';
    if (expected.hasDefault && !actual.hasDefault) return 'COLUMN_DEFAULT';
  }
  const keys = names.filter(name => mapped.columns[name]!.config.primary), primary = value.indexes.filter(i => i.primary);
  if (primary.length !== 1) return 'PRIMARY_KEY';
  const index = primary[0]!;
  if (!validIndex(index) || index.includedColumns.length !== 0 || index.keyColumns.length !== keys.length
      || new Set(index.keyColumns).size !== keys.length || keys.some(key => !index.keyColumns.includes(key))) return 'PRIMARY_KEY';
  if (keys.some(key => mapped.columns[key]!.config.kind === 'text'
      && (columns.get(key)!.collationOid !== 100 || index.collationOids[index.keyColumns.indexOf(key)] !== 100))) return 'KEY_COLLATION';
  for (const name of names) {
    const config = mapped.columns[name]!.config;
    if (config.unique && !value.indexes.some(i => validIndex(i) && i.keyColumns.length === 1 && i.keyColumns[0] === name
        && (!config.nullable || !i.nullsNotDistinct))) return 'UNIQUE';
  }
  return null;
}
export function comparePostgresSettings(value: PostgresSettings, searchPath?: string): PostgresSettingsReason | null {
  if (!value || typeof value !== 'object' || !settings.has(value)) throw new RowstitchError('DATA','Capture PostgreSQL settings.');
  if (Math.floor(value.serverVersion/10_000) !== 18) return 'SERVER_VERSION';
  if (value.clientEncoding !== 'UTF8' || value.serverEncoding !== 'UTF8') return 'ENCODING';
  if (value.extraFloatDigits < 1 || value.extraFloatDigits > 3) return 'FLOAT_PRECISION';
  if (value.replicationRole !== 'origin') return 'REPLICATION_ROLE';
  if (searchPath !== undefined && value.searchPath !== searchPath) return 'SEARCH_PATH';
  return null;
}
