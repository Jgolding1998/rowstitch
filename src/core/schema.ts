import { fail } from './errors.js';

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

function jsonText(value: unknown): string {
  let nodes = 0;
  const active = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) fail('VALIDATION', 'JSON exceeds its structure limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object') fail('VALIDATION', 'JSON must contain only finite JSON values.');
    if (active.has(item)) fail('VALIDATION', 'JSON cannot contain a cycle.');
    active.add(item);
    if (Array.isArray(item)) {
      if (item.length > 100_000) fail('VALIDATION', 'JSON exceeds its structure limit.');
      if (![null, Array.prototype].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length
          || Object.getOwnPropertyNames(item).some(key => key !== 'length'
            && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
        fail('VALIDATION', 'JSON arrays cannot have custom prototypes, properties or serialization hooks.');
      }
      for (let i = 0; i < item.length; i++) {
        const d = Object.getOwnPropertyDescriptor(item, String(i));
        if (!d || !('value' in d)) fail('VALIDATION', 'JSON arrays cannot have holes or accessors.');
        visit(d.value, depth + 1);
      }
    } else {
      plainRecord(item);
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
    active.delete(item);
  }
  visit(value, 0);
  const result = JSON.stringify(value);
  if (result.length > 1_048_576) fail('VALIDATION', 'JSON exceeds one MiB of characters.');
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
      try { return JSON.parse(value); } catch { return fail('DATA', 'Stored JSON is invalid.'); }
  }
}

export class Column<T, Optional extends boolean = false, Primary extends boolean = false> {
  declare readonly _value: T;
  declare readonly _optional: Optional;
  declare readonly _primary: Primary;
  readonly config: Readonly<ColumnConfig>;
  constructor(config: ColumnConfig) {
    this.config = Object.freeze(config);
    Object.freeze(this);
  }
  nullable(): Column<T | null, true, Primary> {
    if (this.config.primary) fail('SCHEMA', 'Primary keys cannot be nullable.');
    return new Column({ ...this.config, nullable: true });
  }
  default(value: T): Column<T, true, Primary> {
    return new Column({ ...this.config, hasDefault: true, defaultValue: encode(this.config, value) });
  }
  primaryKey(): Column<T, Optional, true>;
  primaryKey(options: { generated: true }): Column<T, true, true>;
  primaryKey(options?: { generated: true }): Column<T, boolean, true> {
    if (this.config.nullable || this.config.kind === 'json' || this.config.kind === 'real' || this.config.kind === 'boolean') fail('SCHEMA', 'Primary keys must be non-null integer, bigint or text columns.');
    if (options?.generated && !['integer', 'bigint'].includes(this.config.kind)) fail('SCHEMA', 'Generated keys require an integer column.');
    return new Column({ ...this.config, primary: true, generated: options?.generated === true });
  }
  unique(): Column<T, Optional, Primary> {
    return new Column({ ...this.config, unique: true });
  }
  references<U extends AnyTable, K extends keyof U['columns'] & string>(table: U, key: K, options: { onDelete?: DeleteAction } = {}): Column<T, Optional, Primary> {
    const target = table.columns[key];
    if (!target || !['integer', 'bigint', 'text'].includes(this.config.kind)
      || sqlType(target.config) !== sqlType(this.config) || !(target.config.primary || target.config.unique)) fail('SCHEMA', 'Foreign keys must reference a compatible primary or unique column.');
    if (Object.values(table.columns as Columns).filter(c => c.config.primary).length > 1 && !target.config.unique) fail('SCHEMA', 'A single-column foreign key cannot target part of a composite primary key.');
    const action = options.onDelete ?? 'no action';
    if (!['cascade', 'restrict', 'set null', 'no action'].includes(action) || action === 'set null' && !this.config.nullable) fail('SCHEMA', 'This foreign-key delete action is invalid for the column.');
    return new Column({ ...this.config, foreignKey: Object.freeze({ table, column: key, onDelete: action }) });
  }
}

function make<T>(kind: Kind): Column<T> {
  return new Column({ kind, nullable: false, primary: false, generated: false, unique: false, hasDefault: false });
}
export const column = Object.freeze({
  integer: () => make<number>('integer'), bigint: () => make<bigint>('bigint'),
  real: () => make<number>('real'), text: () => make<string>('text'),
  boolean: () => make<boolean>('boolean'), json: <T = unknown>() => make<T>('json'),
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

export class ColumnRef<T = unknown> {
  declare readonly _value: T;
  constructor(public readonly table: AnyTable, public readonly name: string) { Object.freeze(this); }
}
export class Table<C extends Columns = Columns, V extends keyof C & string | undefined = undefined> {
  readonly columns: C;
  readonly version: V | undefined;
  constructor(public readonly name: string, columns: C, options: { version?: V } = {}) {
    identifier(name);
    plainRecord(columns);
    const entries = Object.entries(columns);
    if (!entries.length || entries.length > 100) fail('SCHEMA', 'A table must have 1 to 100 columns.');
    const names = new Set<string>();
    for (const [key, value] of entries) {
      identifier(key);
      if (names.has(key.toLowerCase()) || !(value instanceof Column)) fail('SCHEMA', 'Columns must be uniquely named column definitions.');
      names.add(key.toLowerCase());
    }
    const primary = entries.filter(([, c]) => c.config.primary);
    if (!primary.length) fail('SCHEMA', 'Every mapped table needs an explicit primary key.');
    if (primary.length > 1 && primary.some(([, c]) => c.config.generated)) fail('SCHEMA', 'A composite primary key cannot be generated.');
    if (options.version !== undefined) {
      const v = columns[options.version];
      if (!v || v.config.kind !== 'integer' || v.config.nullable || v.config.primary) fail('SCHEMA', 'The version column must be a non-null non-key integer.');
      this.version = options.version;
    }
    this.columns = Object.freeze({ ...columns });
    Object.freeze(this);
  }
  col<K extends keyof C & string>(key: K): ColumnRef<Value<C[K]>> {
    if (!Object.hasOwn(this.columns, key)) fail('SCHEMA', 'The mapped column does not exist.');
    return new ColumnRef(this, key);
  }
}
export type AnyTable = Table<any, any>;
export function defineTable<C extends Columns, V extends keyof C & string | undefined = undefined>(name: string, columns: C, options?: { version?: V }): Table<C, V> {
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
