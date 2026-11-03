import test from 'node:test';
import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, Column, RowstitchError, hasMany, some, eq } from '../dist/index.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const base = Object.freeze({ kind: 'integer', nullable: false, primary: false, generated: false, unique: false, hasDefault: false });
const ColumnPrototype = Object.getPrototypeOf(column.integer());
function counter() {
  const calls = { count: 0 };
  const handler = new Proxy({}, { get: (_, trap) => (...args) => { calls.count++; return Reflect[trap](...args); } });
  return { calls, handler };
}
const key = () => column.integer().primaryKey();

test('a prototype-forged Column is rejected by Table before its config getter runs', () => {
  let reads = 0;
  const forged = Object.create(ColumnPrototype);
  Object.defineProperty(forged, 'config', { get() { reads++; return reads > 3 ? { ...base, kind: 'json' } : base; } });
  assert.ok(forged instanceof Column, 'the forgery passes instanceof, which is why branding is needed');
  assert.throws(() => defineTable('forged_columns', { id: key(), parentId: forged }), coded('SCHEMA'));
  assert.equal(reads, 0);
});

test('Proxy and revoked Proxy wrappers around genuine columns are rejected without running traps', () => {
  const { calls, handler } = counter();
  const proxied = new Proxy(column.integer(), handler);
  assert.throws(() => defineTable('proxied_columns', { id: key(), value: proxied }), coded('SCHEMA'));
  assert.equal(calls.count, 0);
  const { proxy, revoke } = Proxy.revocable(column.text(), {});
  revoke();
  assert.throws(() => defineTable('revoked_columns', { id: key(), value: proxy }), coded('SCHEMA'));
});

test('Column builder methods refuse a forged receiver before reading it', () => {
  let reads = 0;
  const forged = Object.create(ColumnPrototype);
  Object.defineProperty(forged, 'config', { get() { reads++; return base; } });
  const target = defineTable('builder_targets', { id: key() });
  for (const call of [() => forged.nullable(), () => forged.default(1), () => forged.primaryKey(), () => forged.unique(), () => forged.references(target, 'id'),
    () => Column.prototype.nullable.call(new Proxy(column.integer(), {}))]) assert.throws(call, coded('SCHEMA'));
  assert.equal(reads, 0);
});

test('a subclass accessor cannot replace the constructor snapshot', () => {
  let reads = 0;
  class Shadow extends Column { get config() { reads++; return { ...base, kind: 'json' }; } }
  const value = new Shadow({ ...base });
  assert.equal(value.config.kind, 'integer');
  const table = defineTable('shadow_columns', { id: key(), value });
  assert.equal(table.columns.value.config.kind, 'integer');
  assert.equal(reads, 0);
});

test('direct Column construction stays usable and is checked like builder columns', () => {
  const parents = defineTable('direct_parents', { id: new Column({ ...base, primary: true, generated: true }), label: new Column({ ...base, kind: 'text', hasDefault: true, defaultValue: "it's" }) });
  const children = defineTable('direct_children', {
    id: new Column({ ...base, kind: 'bigint', primary: true }),
    parentId: new Column({ ...base, nullable: true, foreignKey: { table: parents, column: 'id', onDelete: 'set null' } }),
    flag: new Column({ ...base, kind: 'boolean', hasDefault: true, defaultValue: 1 }),
    data: new Column({ ...base, kind: 'json', nullable: true, hasDefault: true, defaultValue: '{"a":[1,2]}' }),
    ratio: new Column({ ...base, kind: 'real', hasDefault: true, defaultValue: 0.5 }),
  });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  db.ensureSchema();
  const parent = db.table(parents).insert({});
  assert.deepEqual(parent, { id: 1, label: "it's" });
  const child = db.table(children).insert({ id: 2n ** 62n, parentId: parent.id });
  assert.deepEqual(child, { id: 2n ** 62n, parentId: 1, flag: true, data: { a: [1, 2] }, ratio: 0.5 });
  assert.deepEqual(db.table(parents).findMany({ where: some(hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') }), eq(children.col('flag'), true)) }), [parent]);
  db.table(parents).delete({ where: eq(parents.col('id'), 1) });
  assert.equal(db.table(children).findFirst()?.parentId, null);
  assert.deepEqual(db.planSchema(), []);
  db.close();
});

test('constructor input is snapshotted once without freezing or reading accessors from caller objects', () => {
  const parents = defineTable('snapshot_parents', { id: key() });
  const foreignKey = { table: parents, column: 'id', onDelete: 'cascade' };
  const input = { ...base, foreignKey };
  const value = new Column(input);
  input.kind = 'json'; input.nullable = true; foreignKey.column = 'missing'; foreignKey.onDelete = 'set null';
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(foreignKey), false);
  assert.equal(value.config.kind, 'integer');
  assert.equal(value.config.nullable, false);
  assert.deepEqual({ ...value.config.foreignKey }, { table: parents, column: 'id', onDelete: 'cascade' });
  assert.ok(Object.isFrozen(value.config) && Object.isFrozen(value.config.foreignKey));
  assert.notEqual(value.config, input);

  let reads = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'kind', { enumerable: true, get() { reads++; return 'integer'; } });
  assert.throws(() => new Column(accessor), coded('SCHEMA'));
  const nestedAccessor = { table: parents, column: 'id' };
  Object.defineProperty(nestedAccessor, 'onDelete', { enumerable: true, get() { reads++; return 'cascade'; } });
  assert.throws(() => new Column({ ...base, foreignKey: nestedAccessor }), coded('SCHEMA'));
  assert.equal(reads, 0);

  // Configuration proxies are not detected (no host-independent check exists). Their descriptor
  // traps may run once; the column keeps only the validated captured values, never using get traps.
  let getTraps = 0;
  const target = { ...base };
  const proxied = new Proxy(target, { get(t, k, r) { getTraps++; return Reflect.get(t, k, r); } });
  const fromProxy = new Column(proxied);
  target.kind = 'json'; target.nullable = true;
  assert.deepEqual({ ...fromProxy.config }, base);
  assert.ok(Object.isFrozen(fromProxy.config)); assert.notEqual(fromProxy.config, proxied);
  const fkTarget = { table: parents, column: 'id', onDelete: 'cascade' };
  const viaFkProxy = new Column({ ...base, foreignKey: new Proxy(fkTarget, { get(t, k, r) { getTraps++; return Reflect.get(t, k, r); } }) });
  fkTarget.column = 'missing';
  assert.deepEqual({ ...viaFkProxy.config.foreignKey }, { table: parents, column: 'id', onDelete: 'cascade' });
  assert.equal(getTraps, 0, 'property get traps are not used to read configuration');
  // A descriptor trap that lies about an accessor is still refused, without calling the getter.
  let lyingGetter = 0;
  const lying = new Proxy({ ...base }, { getOwnPropertyDescriptor(t, k) { return k === 'kind' ? { configurable: true, enumerable: true, get() { lyingGetter++; return 'integer'; } } : Reflect.getOwnPropertyDescriptor(t, k); } });
  assert.throws(() => new Column(lying), coded('SCHEMA'));
  assert.equal(lyingGetter, 0);
  const { proxy, revoke } = Proxy.revocable({ ...base }, {}); revoke();
  assert.throws(() => new Column(proxy), coded('SCHEMA'));
  const revokedForeignKey = Proxy.revocable({ table: parents, column: 'id', onDelete: 'cascade' }, {}); revokedForeignKey.revoke();
  assert.throws(() => new Column({ ...base, foreignKey: revokedForeignKey.proxy }), coded('SCHEMA'));
});

test('mutating the outer config after it was captured cannot install a getter that runs', () => {
  const parent = defineTable('mutation_parent', { id: key() });
  const config = { ...column.integer().config };
  let accessorCalls = 0;
  config.foreignKey = new Proxy({ table: parent, column: 'id', onDelete: 'no action' }, {
    ownKeys(target) {
      Object.defineProperty(config, 'kind', { enumerable: true, configurable: true, get() { accessorCalls++; return 'json'; } });
      Object.defineProperty(config, 'nullable', { enumerable: true, configurable: true, get() { accessorCalls++; return true; } });
      return Reflect.ownKeys(target);
    },
  });
  const value = new Column(config);
  assert.equal(accessorCalls, 0);
  assert.equal(value.config.kind, 'integer');
  assert.equal(value.config.nullable, false);
  assert.equal(value.config.foreignKey.table, parent);
  assert.equal(defineTable('mutation_child', { id: key(), parentId: value }).columns.parentId.config.kind, 'integer');
});

test('column and table definition never clone caller or table graphs', () => {
  const original = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = (...args) => { clones++; return original(...args); };
  try {
    let previous;
    for (let index = 0; index < 5; index++) {
      const fields = { id: key() };
      if (previous) for (let ref = 0; ref < 5; ref++) fields['ref' + ref] = column.integer().nullable().references(previous, 'id', { onDelete: 'set null' }).unique();
      previous = defineTable('graph_' + index, fields);
    }
    new Column({ ...base, foreignKey: { table: previous, column: 'id', onDelete: 'cascade' } });
  } finally { globalThis.structuredClone = original; }
  assert.equal(clones, 0);
});

test('a table freezes the column values it validated, never a second read of the record', () => {
  const genuine = column.integer();
  const forged = Object.create(ColumnPrototype);
  let gets = 0;
  const record = new Proxy({ id: key(), value: genuine }, { get(t, k, r) { gets++; return k === 'value' && gets > 2 ? forged : Reflect.get(t, k, r); } });
  const table = defineTable('stable_columns', record);
  assert.equal(table.columns.value, genuine);
  assert.ok(Object.isFrozen(table.columns));
  const { proxy, revoke } = Proxy.revocable({ id: key() }, {}); revoke();
  assert.throws(() => defineTable('revoked_record', proxy), coded('VALIDATION'));
  assert.throws(() => defineTable('extra_version', { id: key(), version: column.integer() }, { version: 'missing' }), coded('SCHEMA'));
  assert.equal(defineTable('versioned_columns', { id: key(), version: column.integer().default(1) }, { version: 'version' }).version, 'version');
});

test('malformed direct configuration is refused with SCHEMA', () => {
  const parents = defineTable('malformed_parents', { id: key(), code: column.text().unique(), label: column.text() });
  const composite = defineTable('malformed_composite', { a: key(), b: key() });
  const fakeTable = Object.create(Object.getPrototypeOf(parents));
  class Config { constructor() { Object.assign(this, base); } }
  const bad = [
    null, 1, 'integer', [], new Config(), { ...base, extra: true }, { ...base, [Symbol('x')]: true }, { ...base, kind: 'uuid' },
    { ...base, nullable: 'false' }, { kind: 'integer' }, { ...base, primary: true, nullable: true }, { ...base, kind: 'json', primary: true },
    { ...base, generated: true }, { ...base, kind: 'text', primary: true, generated: true },
    { ...base, defaultValue: 1 }, { ...base, hasDefault: true }, { ...base, hasDefault: true, defaultValue: null },
    { ...base, hasDefault: true, defaultValue: '1' }, { ...base, hasDefault: true, defaultValue: 2 ** 53 }, { ...base, kind: 'bigint', hasDefault: true, defaultValue: 2n ** 63n },
    { ...base, kind: 'real', hasDefault: true, defaultValue: Number.NaN }, { ...base, kind: 'boolean', hasDefault: true, defaultValue: 2 },
    { ...base, kind: 'boolean', hasDefault: true, defaultValue: true }, { ...base, kind: 'json', hasDefault: true, defaultValue: '{bad' },
    { ...base, kind: 'json', hasDefault: true, defaultValue: '[' .repeat(70) + ']'.repeat(70) }, { ...base, kind: 'text', hasDefault: true, defaultValue: 'x'.repeat(1_048_577) },
    { ...base, foreignKey: { table: fakeTable, column: 'id', onDelete: 'cascade' } }, { ...base, foreignKey: { table: parents, column: 'missing', onDelete: 'cascade' } },
    { ...base, foreignKey: { table: parents, column: 'label', onDelete: 'cascade' } }, { ...base, foreignKey: { table: parents, column: 'code', onDelete: 'cascade' } },
    { ...base, foreignKey: { table: parents, column: 'id', onDelete: 'set null' } }, { ...base, foreignKey: { table: parents, column: 'id', onDelete: 'drop' } },
    { ...base, foreignKey: { table: parents, column: 'id' } }, { ...base, foreignKey: { table: parents, column: 'id', onDelete: 'cascade', extra: 1 } },
    { ...base, foreignKey: { table: composite, column: 'a', onDelete: 'cascade' } }, { ...base, kind: 'real', foreignKey: { table: parents, column: 'id', onDelete: 'cascade' } },
  ];
  for (const [index, input] of bad.entries()) assert.throws(() => new Column(input), coded('SCHEMA'), 'case ' + index);
  assert.equal(new Column({ ...base, foreignKey: undefined }).config.foreignKey, undefined);
  assert.equal(Object.hasOwn(new Column({ ...base, foreignKey: undefined }).config, 'foreignKey'), false);
});

test('existing builder contracts and error codes are unchanged', () => {
  const parents = defineTable('builder_parents', { id: key(), code: column.text().unique() });
  assert.throws(() => column.integer().primaryKey().nullable(), coded('SCHEMA'));
  assert.throws(() => column.json().primaryKey(), coded('SCHEMA'));
  assert.throws(() => column.text().primaryKey({ generated: true }), coded('SCHEMA'));
  assert.throws(() => column.integer().default('1'), coded('VALIDATION'));
  assert.throws(() => column.integer().default(null), coded('VALIDATION'));
  assert.throws(() => column.json().default({ toJSON() { return 1; } }), coded('VALIDATION'));
  assert.throws(() => column.integer().references(parents, 'code'), coded('SCHEMA'));
  assert.throws(() => column.integer().references(parents, 'id', { onDelete: 'set null' }), coded('SCHEMA'));
  const nullableDefault = column.integer().nullable().default(null);
  assert.deepEqual({ ...nullableDefault.config }, { ...base, nullable: true, hasDefault: true, defaultValue: null });
  const json = column.json().default({ list: [1, 'two'] });
  assert.equal(json.config.defaultValue, '{"list":[1,"two"]}');
  const chained = column.text().nullable().references(parents, 'code', { onDelete: 'set null' }).unique();
  assert.deepEqual({ ...chained.config.foreignKey }, { table: parents, column: 'code', onDelete: 'set null' });
  assert.equal(chained.config.unique, true);
  assert.equal(column.bigint().default(-(2n ** 63n)).config.defaultValue, -(2n ** 63n));
  assert.equal(column.boolean().default(false).config.defaultValue, 0);
  const generated = column.integer().primaryKey({ generated: true });
  assert.equal(generated.config.generated, true);
  assert.ok(Object.isFrozen(generated) && Object.isFrozen(generated.config));
});
