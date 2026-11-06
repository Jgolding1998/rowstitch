import { RowstitchError, fail } from './errors.js';
import { capturePhysicalName } from './physical-identity.js';

export type Parameter = string | number | bigint | null;
export type Kind = 'integer' | 'bigint' | 'real' | 'text' | 'boolean' | 'json';
type DeleteAction = 'cascade' | 'restrict' | 'set null' | 'no action';
export interface ForeignKey {
  table: AnyTable;
  column: string;
  onDelete: DeleteAction;
}
interface ColumnConfig {
  kind: Kind;
  nullable: boolean;
  primary: boolean;
  generated: boolean;
  unique: boolean;
  hasDefault: boolean;
  defaultValue?: Parameter;
  foreignKey?: ForeignKey;
  storageName?: string;
}

export function identifier(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)
      || /^(?:sqlite_|__rs_)/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    fail('SCHEMA', 'Identifiers must be simple names of 1 to 63 characters and cannot use reserved names.');
  }
  return '"' + name + '"';
}

export function plainRecord(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    fail('VALIDATION', 'Expected a plain record.');
  }
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value))
    .some(d => !('value' in d))) fail('VALIDATION', 'Record accessors and symbol keys are not supported.');
}

const MAX_JSON_CHARACTERS = 1_048_576;
function validateJson(value: unknown, code: 'VALIDATION' | 'DATA'): void {
  let nodes = 0;
  const active = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) fail(code, 'JSON exceeds its structure limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object') fail(code, 'JSON must contain only finite JSON values.');
    if (active.has(item)) fail(code, 'JSON cannot contain a cycle.');
    active.add(item);
    if (Array.isArray(item)) {
      if (item.length > 100_000) fail(code, 'JSON exceeds its structure limit.');
      if (![null, Array.prototype].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length
          || Object.getOwnPropertyNames(item).some(key => key !== 'length'
            && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
        fail(code, 'JSON arrays cannot have custom prototypes, properties or serialization hooks.');
      }
      for (let i = 0; i < item.length; i++) {
        const d = Object.getOwnPropertyDescriptor(item, String(i));
        if (!d || !('value' in d)) fail(code, 'JSON arrays cannot have holes or accessors.');
        visit(d.value, depth + 1);
      }
    } else {
      try { plainRecord(item); }
      catch (error) {
        if (code === 'DATA') fail('DATA', 'Stored JSON must contain only plain data.');
        throw error;
      }
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
    active.delete(item);
  }
  visit(value, 0);
}
function jsonText(value: unknown): string {
  validateJson(value, 'VALIDATION');
  const result = JSON.stringify(value);
  if (result.length > MAX_JSON_CHARACTERS) fail('VALIDATION', 'JSON exceeds one MiB of characters.');
  return result;
}

export function encode(config: Readonly<ColumnConfig>, value: unknown): Parameter {
  if (value === null) {
    if (!config.nullable) fail('VALIDATION', 'A non-null column cannot contain null.');
    return null;
  }
  switch (config.kind) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('VALIDATION', 'Integer values must be safe JavaScript integers. Use a bigint column for int64.');
      return value;
    case 'bigint':
      if (typeof value !== 'bigint' || value < -(2n ** 63n) || value > 2n ** 63n - 1n) fail('VALIDATION', 'Bigint values must fit a signed SQLite int64.');
      return value;
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('VALIDATION', 'Real values must be finite numbers.');
      return value;
    case 'text':
      if (typeof value !== 'string' || value.length > 1_048_576) fail('VALIDATION', 'Text must be a string of at most one MiB of characters.');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('VALIDATION', 'Boolean values must be true or false.');
      return value ? 1 : 0;
    case 'json': return jsonText(value);
  }
}

export function decode(config: Readonly<ColumnConfig>, value: unknown): unknown {
  if (value === null) {
    if (!config.nullable) fail('DATA', 'Stored null does not match the declared non-null column.');
    return null;
  }
  switch (config.kind) {
    case 'integer': {
      if (typeof value !== 'bigint' || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('DATA', 'A stored integer cannot be represented safely. Map it as bigint.');
      return Number(value);
    }
    case 'bigint':
      if (typeof value !== 'bigint') fail('DATA', 'Stored data does not match a bigint column.');
      return value;
    case 'real':
      if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('DATA', 'Stored data does not match a finite real column.');
      return value;
    case 'text':
      if (typeof value !== 'string') fail('DATA', 'Stored data does not match a text column.');
      return value;
    case 'boolean':
      if (value !== 0n && value !== 1n) fail('DATA', 'Stored data does not match a boolean column.');
      return value === 1n;
    case 'json':
      if (typeof value !== 'string') fail('DATA', 'Stored data does not match a JSON column.');
      if (value.length > MAX_JSON_CHARACTERS) fail('DATA', 'Stored JSON exceeds one MiB of characters.');
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return fail('DATA', 'Stored JSON is invalid.'); }
      validateJson(parsed, 'DATA');
      return parsed;
  }
}

export class Column<T, Optional extends boolean = false, Primary extends boolean = false, K extends Kind = Kind> {
  declare readonly _value: T;
  declare readonly _optional: Optional;
  declare readonly _primary: Primary;
  declare readonly _kind: K;
  readonly config: Readonly<ColumnConfig>;
  /** Copies plain data once; caller objects are neither frozen nor read through accessors. */
  constructor(config: ColumnConfig) {
    this.config = columnConfig(config);
    columnDefinitions.add(this);
    Object.freeze(this);
  }
  nullable(): Column<T | null, true, Primary, K> {
    genuineColumn(this);
    if (this.config.primary) fail('SCHEMA', 'Primary keys cannot be nullable.');
    return new Column({ ...this.config, nullable: true });
  }
  default(value: T): Column<T, true, Primary, K> {
    genuineColumn(this);
    return new Column({ ...this.config, hasDefault: true, defaultValue: encode(this.config, value) });
  }
  primaryKey(): Column<T, Optional, true, K>;
  primaryKey(options: { generated: true }): Column<T, true, true, K>;
  primaryKey(options?: { generated: true }): Column<T, boolean, true, K> {
    genuineColumn(this);
    if (this.config.nullable || this.config.kind === 'json' || this.config.kind === 'real' || this.config.kind === 'boolean') fail('SCHEMA', 'Primary keys must be non-null integer, bigint or text columns.');
    if (options?.generated && !['integer', 'bigint'].includes(this.config.kind)) fail('SCHEMA', 'Generated keys require an integer column.');
    return new Column({ ...this.config, primary: true, generated: options?.generated === true });
  }
  unique(): Column<T, Optional, Primary, K> {
    genuineColumn(this);
    return new Column({ ...this.config, unique: true });
  }
  storedAs(name: string): Column<T, Optional, Primary, K> {
    genuineColumn(this);
    return new Column({ ...this.config, storageName: capturePhysicalName(name) });
  }
  references<U extends AnyTable, RefKey extends keyof U['columns'] & string>(table: U, key: RefKey, options: { onDelete?: DeleteAction } = {}): Column<T, Optional, Primary, K> {
    genuineColumn(this);
    // The constructor snapshot performs the target, kind and delete-action checks once.
    return new Column({ ...this.config, foreignKey: { table, column: key, onDelete: options.onDelete ?? 'no action' } });
  }
}

const columnDefinitions = new WeakSet<object>();
/** Internal authenticity check; prototype forgeries and Proxy wrappers are not column definitions. */
export function isColumn(value: unknown): value is Column<unknown, boolean, boolean> {
  return value !== null && typeof value === 'object' && columnDefinitions.has(value);
}
function genuineColumn(value: unknown): void {
  if (!isColumn(value)) fail('SCHEMA', 'Column builders require a genuine column definition.');
}
const columnKinds: readonly string[] = ['integer', 'bigint', 'real', 'text', 'boolean', 'json'];
const deleteActionNames: readonly string[] = ['cascade', 'restrict', 'set null', 'no action'];
const columnFlags = ['nullable', 'primary', 'generated', 'unique', 'hasDefault'] as const;
/**
 * Copies own data properties once without invoking accessors. A Proxy record is not detected:
 * its descriptor traps may run once, and only the validated values captured here are kept.
 * Nothing re-reads the caller's object afterwards, so later mutation cannot affect the column.
 */
function dataSnapshot(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null);
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('SCHEMA', 'Column configuration must be a plain data record.');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !allowed.includes(key) || !descriptor || !('value' in descriptor)) fail('SCHEMA', 'Column configuration contains an unsupported field or accessor.');
      if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
    }
  } catch { fail('SCHEMA', 'Column configuration must be a plain data record.'); } // Includes caller-thrown trap errors.
  if (required.some(key => !Object.hasOwn(snapshot, key))) fail('SCHEMA', 'Column configuration is missing a required field.');
  return snapshot;
}
/** Defaults are stored already encoded, exactly as the column codec produces them. */
function encodedDefault(kind: Kind, nullable: boolean, value: unknown): Parameter {
  if (value === null) {
    if (!nullable) fail('SCHEMA', 'A non-null column cannot default to NULL.');
    return null;
  }
  const valid = kind === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
    : kind === 'bigint' ? typeof value === 'bigint' && value >= -(2n ** 63n) && value <= 2n ** 63n - 1n
    : kind === 'real' ? typeof value === 'number' && Number.isFinite(value)
    : kind === 'boolean' ? value === 0 || value === 1
    : typeof value === 'string' && value.length <= MAX_JSON_CHARACTERS;
  if (!valid) fail('SCHEMA', 'A column default must be an encoded value of the column kind.');
  if (kind === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(value as string); validateJson(parsed, 'VALIDATION'); }
    catch { fail('SCHEMA', 'A JSON column default must be valid bounded JSON text.'); }
  }
  return value as Parameter;
}
function columnConfig(input: unknown): Readonly<ColumnConfig> {
  const value = dataSnapshot(input, ['kind', ...columnFlags, 'defaultValue', 'foreignKey', 'storageName'], ['kind', ...columnFlags]);
  if (typeof value.kind !== 'string' || !columnKinds.includes(value.kind) || columnFlags.some(flag => typeof value[flag] !== 'boolean')) fail('SCHEMA', 'Column kinds and flags must use supported values.');
  const config: ColumnConfig = { kind: value.kind as Kind, nullable: value.nullable as boolean, primary: value.primary as boolean,
    generated: value.generated as boolean, unique: value.unique as boolean, hasDefault: value.hasDefault as boolean };
  if (Object.hasOwn(value, 'storageName')) config.storageName = capturePhysicalName(value.storageName);
  if (config.primary && (config.nullable || !['integer', 'bigint', 'text'].includes(config.kind))) fail('SCHEMA', 'Primary keys must be non-null integer, bigint or text columns.');
  if (config.generated && (!config.primary || !['integer', 'bigint'].includes(config.kind))) fail('SCHEMA', 'Generated keys require an integer primary key column.');
  if (config.hasDefault) {
    if (!Object.hasOwn(value, 'defaultValue')) fail('SCHEMA', 'A default flag needs its encoded default value.');
    config.defaultValue = encodedDefault(config.kind, config.nullable, value.defaultValue);
  } else if (Object.hasOwn(value, 'defaultValue')) fail('SCHEMA', 'A default value needs its hasDefault flag.');
  if (Object.hasOwn(value, 'foreignKey')) {
    const fk = dataSnapshot(value.foreignKey, ['table', 'column', 'onDelete'], ['table', 'column', 'onDelete']);
    const table = fk.table, key = fk.column, action = fk.onDelete;
    if (!isTable(table)) fail('SCHEMA', 'Foreign keys require a genuine mapped table.');
    const target = typeof key === 'string' && Object.hasOwn(table.columns, key) ? (table.columns as Columns)[key] : undefined;
    if (!target || !['integer', 'bigint', 'text'].includes(config.kind)
      || sqlType(target.config) !== sqlType(config) || !(target.config.primary || target.config.unique)) fail('SCHEMA', 'Foreign keys must reference a compatible primary or unique column.');
    if (Object.values(table.columns as Columns).filter(c => c.config.primary).length > 1 && !target.config.unique) fail('SCHEMA', 'A single-column foreign key cannot target part of a composite primary key.');
    if (typeof action !== 'string' || !deleteActionNames.includes(action) || action === 'set null' && !config.nullable) fail('SCHEMA', 'This foreign-key delete action is invalid for the column.');
    config.foreignKey = Object.freeze({ table, column: key as string, onDelete: action as DeleteAction });
  }
  return Object.freeze(config);
}

function make<T, K extends Kind>(kind: K): Column<T, false, false, K> {
  return new Column({ kind, nullable: false, primary: false, generated: false, unique: false, hasDefault: false });
}
export const column = Object.freeze({
  integer: () => make<number, 'integer'>('integer'), bigint: () => make<bigint, 'bigint'>('bigint'),
  real: () => make<number, 'real'>('real'), text: () => make<string, 'text'>('text'),
  boolean: () => make<boolean, 'boolean'>('boolean'), json: <T = unknown>() => make<T, 'json'>('json'),
});

export type Columns = Record<string, Column<any, boolean, boolean>>;
export type Value<C> = C extends Column<infer T, boolean, boolean> ? T : never;
export type Row<T extends AnyTable> = { [K in keyof T['columns']]: Value<T['columns'][K]> };
type OptionalKeys<C extends Columns> = { [K in keyof C]: C[K] extends Column<any, true, boolean> ? K : never }[keyof C];
export type InsertRow<T extends AnyTable> = { [K in Exclude<keyof T['columns'], OptionalKeys<T['columns']>>]: Value<T['columns'][K]> }
  & { [K in OptionalKeys<T['columns']>]?: Value<T['columns'][K]> };
export type KeyNames<T extends AnyTable> = { [K in keyof T['columns']]: T['columns'][K] extends Column<any, boolean, true> ? K : never }[keyof T['columns']];
export type KeyRow<T extends AnyTable> = Pick<Row<T>, KeyNames<T>>;
export type UpdateRow<T extends AnyTable> = Partial<Omit<Row<T>, KeyNames<T> | NonNullable<T['version']>>>;

export type ColumnKind<C> = C extends Column<any, boolean, boolean, infer K> ? K : Kind;
const columnReferences = new WeakSet<object>();
const tableDefinitions = new WeakSet<object>();
export function isTable(value: unknown): value is AnyTable {
  return value !== null && typeof value === 'object' && tableDefinitions.has(value);
}
/** Internal authenticity check; prototype forgeries and Proxy wrappers are not references. */
export function isColumnRef(value: unknown): value is ColumnRef {
  return value !== null && typeof value === 'object' && columnReferences.has(value);
}
export class ColumnRef<T = unknown, K extends Kind = Kind> {
  declare readonly _value: T;
  declare readonly _kind: K;
  constructor(public readonly table: AnyTable, public readonly name: string) {
    if (typeof name !== 'string' || !isTable(table) || !Object.hasOwn(table.columns, name)) fail('QUERY', 'A column reference needs a mapped table and column name.');
    columnReferences.add(this); Object.freeze(this);
  }
}
/** Reads a column record once and returns only authenticated, uniquely named column definitions. */
function columnEntries(columns: unknown): [string, Column<any, boolean, boolean>][] {
  let entries: [string, unknown][];
  try {
    plainRecord(columns);
    entries = Object.entries(columns as object);
  } catch (error) {
    if (error instanceof RowstitchError) throw error;
    return fail('VALIDATION', 'Expected a plain record.'); // e.g. a revoked Proxy
  }
  if (!entries.length || entries.length > 100) fail('SCHEMA', 'A table must have 1 to 100 columns.');
  const names = new Set<string>();
  for (const [key, value] of entries) {
    identifier(key);
    if (names.has(key.toLowerCase()) || !isColumn(value)) fail('SCHEMA', 'Columns must be uniquely named column definitions.');
    names.add(key.toLowerCase());
  }
  return entries as [string, Column<any, boolean, boolean>][];
}
export type SchemaPolicy = 'legacy' | 'exact' | 'subset';
export interface TableStorage {
  readonly table: string;
  readonly schema?: string;
  readonly columns: Readonly<Record<string, string>>;
}
export interface TableOptions<V extends string | undefined = undefined> {
  version?: V;
  storage?: { table?: string; schema?: string };
  schemaPolicy?: SchemaPolicy;
}
export class Table<C extends Columns = Columns, V extends keyof C & string | undefined = undefined> {
  readonly columns: C;
  readonly version: V | undefined;
  readonly storage: TableStorage;
  readonly schemaPolicy: SchemaPolicy;
  constructor(public readonly name: string, columns: C, options: TableOptions<V> = {}) {
    identifier(name);
    const entries = columnEntries(columns);
    let captured: Record<string, unknown>, storage: Record<string, unknown>;
    try {
      captured = dataSnapshot(options, ['version', 'storage', 'schemaPolicy'], []);
      storage = captured.storage === undefined ? {} : dataSnapshot(captured.storage, ['table', 'schema'], []);
    } catch { fail('SCHEMA', 'Table options must contain supported plain data.'); }
    const policy = captured.schemaPolicy ?? 'legacy';
    if (policy !== 'legacy' && policy !== 'exact' && policy !== 'subset') fail('SCHEMA', 'The schema policy is unsupported.');
    const physicalColumns = Object.fromEntries(entries.map(([key, column]) => [key, column.config.storageName ?? key]));
    if (new Set(Object.values(physicalColumns)).size !== entries.length) fail('SCHEMA', 'Mapped physical column names must be distinct.');
    this.storage = Object.freeze({ table: storage.table === undefined ? name : capturePhysicalName(storage.table),
      ...(storage.schema === undefined ? {} : { schema: capturePhysicalName(storage.schema) }), columns: Object.freeze(physicalColumns) });
    this.schemaPolicy = policy;
    const primary = entries.filter(([, c]) => c.config.primary);
    if (!primary.length) fail('SCHEMA', 'Every mapped table needs an explicit primary key.');
    if (primary.length > 1 && primary.some(([, c]) => c.config.generated)) fail('SCHEMA', 'A composite primary key cannot be generated.');
    const version = captured.version;
    if (version !== undefined) {
      const v = entries.find(([key]) => key === version)?.[1];
      if (!v || v.config.kind !== 'integer' || v.config.nullable || v.config.primary) fail('SCHEMA', 'The version column must be a non-null non-key integer.');
      this.version = version as V;
    }
    // Freeze the validated values, not a second read of a caller-controlled record.
    this.columns = Object.freeze(Object.fromEntries(entries)) as C;
    tableDefinitions.add(this); Object.freeze(this);
  }
  col<K extends keyof C & string>(key: K): ColumnRef<Value<C[K]>, ColumnKind<C[K]>> {
    if (!isTable(this) || typeof key !== 'string' || !Object.hasOwn(this.columns, key)) fail('SCHEMA', 'The mapped column does not exist.');
    return new ColumnRef(this, key);
  }
}
export type AnyTable = Table<any, any>;
export function defineTable<C extends Columns, V extends keyof C & string | undefined = undefined>(name: string, columns: C, options?: TableOptions<V>): Table<C, V> {
  return new Table(name, columns, options);
}
export function sqlType(c: Readonly<ColumnConfig>): string {
  return c.kind === 'text' || c.kind === 'json' ? 'TEXT' : c.kind === 'real' ? 'REAL' : 'INTEGER';
}
export function literal(value: Parameter): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  return String(value);
}
