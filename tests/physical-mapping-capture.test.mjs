import test from 'node:test';
import assert from 'node:assert/strict';
import { Column, RowstitchError, column, defineTable } from '../dist/index.js';
import { tableModel, queryModel } from '../dist/core/query-model.js';
import { mappedTableModel, mappedCreateTableModel } from '../dist/core/model-mapping.js';

// These are capture/model tests. They deliberately do not open a database or claim SDK mapping works.
const code = expected => error => error instanceof RowstitchError && error.code === expected;
const key = () => column.integer().primaryKey();
const legacyModel = () => ({ name: 'logical_rows', columns: ['id', 'label'], primaryKey: ['id'] });
const storage = () => ({ table: 'Physical rows', schema: 'A.schema', columns: { id: 'row ID', label: 'display "label"' } });
const mappedInput = () => ({ ...legacyModel(), storage: storage() });
const definition = (name, primary = false, foreignKey) => ({
  name, kind: 'integer', nullable: false, primary, generated: false, unique: false, hasDefault: false,
  ...(foreignKey === undefined ? {} : { foreignKey }),
});
const ddl = foreignKey => ({
  table: { name: 'logical_children', columns: ['id', 'parentId'], primaryKey: ['id'] },
  definitions: [definition('id', true), definition('parentId', false, foreignKey)],
});
const privateMarker = 'FICTIONAL_CAPTURE_PRIVATE_MARKER';
const privateCode = expected => error => {
  assert.ok(error instanceof RowstitchError);
  assert.equal(error.code, expected);
  assert.equal(String(error).includes(privateMarker), false);
  assert.equal(JSON.stringify(error).includes(privateMarker), false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};

test('storedAs creates an immutable builder and every existing chain preserves storage', () => {
  const original = column.integer();
  const first = original.storedAs('first column');
  const second = first.storedAs('second column');
  assert.equal(original.config.storageName, undefined);
  assert.equal(first.config.storageName, 'first column');
  assert.equal(second.config.storageName, 'second column');
  assert.notEqual(first, original);
  assert.notEqual(second, first);
  assert.ok(Object.isFrozen(second) && Object.isFrozen(second.config));
  const parent = defineTable('capture_parent', { id: key().storedAs('parent key') });
  const chains = [
    column.integer().storedAs('persisted').nullable(),
    column.integer().storedAs('persisted').default(1),
    column.integer().storedAs('persisted').primaryKey(),
    column.integer().storedAs('persisted').primaryKey({ generated: true }),
    column.integer().storedAs('persisted').unique(),
    column.integer().storedAs('persisted').references(parent, 'id'),
    column.integer().nullable().references(parent, 'id', { onDelete: 'set null' }).storedAs('persisted'),
  ];
  for (const chain of chains) assert.equal(chain.config.storageName, 'persisted');
  assert.equal(chains[0].config.nullable, true);
  assert.equal(chains[1].config.defaultValue, 1);
  assert.equal(chains[2].config.primary, true);
  assert.equal(chains[3].config.generated, true);
  assert.equal(chains[4].config.unique, true);
  assert.equal(chains[5].config.foreignKey.table, parent);
  assert.throws(() => { second.config.storageName = 'changed'; }, TypeError);
});

test('storedAs authenticates its receiver before accessing forged or proxied config', () => {
  let reads = 0;
  const forged = Object.create(Column.prototype);
  Object.defineProperty(forged, 'config', { get() { reads++; throw new Error(privateMarker); } });
  assert.throws(() => forged.storedAs('valid'), privateCode('SCHEMA'));
  assert.throws(() => Column.prototype.storedAs.call(new Proxy(column.integer(), {
    get() { reads++; throw new Error(privateMarker); },
  }), 'valid'), privateCode('SCHEMA'));
  assert.equal(reads, 0);
});

test('Table captures default identities and explicit storage without changing logical references', () => {
  const originalColumns = { id: key(), label: column.text() };
  const legacy = defineTable('logical_rows', originalColumns);
  assert.equal(legacy.name, 'logical_rows');
  assert.equal(legacy.schemaPolicy, 'legacy');
  assert.deepEqual(legacy.storage, { table: 'logical_rows', columns: { id: 'id', label: 'label' } });
  assert.equal(Object.hasOwn(legacy.storage, 'schema'), false);

  const options = { version: 'version', storage: { table: 'Physical "rows"', schema: 'Tenant.Schema' }, schemaPolicy: 'subset' };
  const fields = { id: key().storedAs('row ID'), label: column.text().storedAs('__proto__'), version: column.integer().storedAs('revision no') };
  const table = defineTable('mapped_rows', fields, options);
  options.storage.table = 'changed'; options.storage.schema = 'changed'; options.schemaPolicy = 'exact'; options.version = 'id';
  fields.label = column.text().storedAs('changed');
  assert.equal(table.name, 'mapped_rows');
  assert.equal(table.version, 'version');
  assert.equal(table.schemaPolicy, 'subset');
  assert.deepEqual(table.storage, { table: 'Physical "rows"', schema: 'Tenant.Schema', columns: { id: 'row ID', label: '__proto__', version: 'revision no' } });
  assert.equal(table.col('label').name, 'label');
  assert.equal(table.col('label').table, table);
  assert.throws(() => table.col('__proto__'), code('SCHEMA'));
  for (const value of [table, table.columns, table.storage, table.storage.columns]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.isFrozen(options), false);
  assert.equal(Object.isFrozen(options.storage), false);
  assert.equal(Object.isFrozen(fields), false);
  assert.throws(() => { table.storage.columns.label = 'changed'; }, TypeError);
  assert.throws(() => { table.storage.schema = 'changed'; }, TypeError);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(defineTable('explicit_exact', { id: key() }, { schemaPolicy: 'exact' }).schemaPolicy, 'exact');
});

test('Table snapshots own option data without invoking getters or property-get traps', () => {
  let reads = 0;
  const accessor = () => ({ enumerable: true, get() { reads++; throw new Error(privateMarker); } });
  for (const path of ['storage', 'schemaPolicy', 'version']) {
    const options = {};
    Object.defineProperty(options, path, accessor());
    assert.throws(() => defineTable('accessor_options', { id: key() }, options), privateCode('SCHEMA'));
  }
  for (const field of ['table', 'schema']) {
    const target = {};
    Object.defineProperty(target, field, accessor());
    assert.throws(() => defineTable('accessor_storage', { id: key() }, { storage: target }), privateCode('SCHEMA'));
  }
  const source = { table: 'original table', schema: 'original schema' };
  const proxied = new Proxy(source, { get() { reads++; throw new Error(privateMarker); } });
  const options = new Proxy({ storage: proxied, schemaPolicy: 'subset' }, { get() { reads++; throw new Error(privateMarker); } });
  const table = defineTable('descriptor_capture', { id: key() }, options);
  source.table = 'changed';
  assert.equal(table.storage.table, 'original table');
  assert.equal(table.schemaPolicy, 'subset');
  assert.equal(reads, 0);
});

test('malformed storage/options fail with controlled errors without echoing supplied values', () => {
  const badOptions = [
    null, [], privateMarker, { schemaPolicy: privateMarker }, { extra: privateMarker },
    { storage: null }, { storage: [] }, { storage: { table: '' } }, { storage: { table: 7 } },
    { storage: { columns: { id: privateMarker } } }, { storage: { extra: privateMarker } },
    { [Symbol(privateMarker)]: true }, { storage: { [Symbol(privateMarker)]: true } },
  ];
  const nonenumerable = {};
  Object.defineProperty(nonenumerable, privateMarker, { value: 'unsupported' });
  badOptions.push(nonenumerable);
  for (const options of badOptions) assert.throws(() => defineTable('bad_options', { id: key() }, options), privateCode('SCHEMA'));
  const revoked = Proxy.revocable({ table: 'some table' }, {}); revoked.revoke();
  assert.throws(() => defineTable('revoked_options', { id: key() }, { storage: revoked.proxy }), privateCode('SCHEMA'));
  for (const thrown of [new Error(privateMarker), new RowstitchError('SCHEMA', privateMarker)]) {
    const hostile = new Proxy({}, { ownKeys() { throw thrown; } });
    assert.throws(() => defineTable('throwing_options', { id: key() }, { storage: hostile }), privateCode('SCHEMA'));
    const config = { ...column.integer().config, storageName: 'physical ID' };
    assert.throws(() => new Column(new Proxy(config, { ownKeys() { throw thrown; } })), privateCode('SCHEMA'));
  }
});

test('physical name validation is byte bounded without coercion or Unicode normalization', () => {
  let coercions = 0;
  const notText = { [Symbol.toPrimitive]() { coercions++; return 'looks valid'; } };
  for (const name of ['', 1, null, undefined, notText, '\0', 'a\0b', '\ud800', '\udc00', 'a'.repeat(4097), 'é'.repeat(2049)]) {
    assert.throws(() => column.text().storedAs(name), code('SCHEMA'));
  }
  assert.equal(coercions, 0);
  for (const name of ['a'.repeat(4096), 'é'.repeat(2048), '😀', 'é', 'e\u0301', '__proto__', 'constructor', '__rs_family_0', '__rs_rank', 'schema.table', '"s"."t"', 'x"; DROP TABLE anything;--']) {
    assert.equal(column.text().storedAs(name).config.storageName, name);
  }
  const table = defineTable('unicode_columns', { id: key(), composed: column.text().storedAs('é'), decomposed: column.text().storedAs('e\u0301') });
  assert.notEqual(table.storage.columns.composed, table.storage.columns.decomposed);
  assert.equal(column.text().storedAs('x'.repeat(64)).config.storageName.length, 64, 'generic capture does not impose PostgreSQL-only limits');
});

test('physical aliases do not weaken logical-name validation or reject native case distinctions early', () => {
  assert.throws(() => defineTable('duplicate_physical', { id: key().storedAs('same'), value: column.text().storedAs('same') }), code('SCHEMA'));
  const caseDistinct = defineTable('case_distinct', { id: key().storedAs('Case'), value: column.text().storedAs('case') });
  assert.equal(caseDistinct.storage.columns.id, 'Case');
  assert.equal(caseDistinct.storage.columns.value, 'case');
  // Backend registration must later reject the SQLite collision while accepting native quoted distinctions.
  for (const logical of ['bad name', '__rs_rank', 'constructor', 'sqlite_rows']) {
    assert.throws(() => defineTable(logical, { id: key() }, { storage: { table: 'safe physical' } }), code('SCHEMA'));
    assert.throws(() => defineTable('logical_validation', { id: key(), [logical]: column.text().storedAs('safe physical') }), code('SCHEMA'));
  }
});

test('legacy pure TableModel inputs gain a complete frozen identity map', () => {
  const source = legacyModel();
  const captured = tableModel(source);
  source.name = 'changed'; source.columns[0] = 'changed'; source.primaryKey[0] = 'changed';
  assert.deepEqual(captured.storage, { table: 'logical_rows', columns: { id: 'id', label: 'label' } });
  assert.equal(captured.name, 'logical_rows');
  assert.deepEqual(captured.columns, ['id', 'label']);
  for (const value of [captured, captured.columns, captured.primaryKey, captured.storage, captured.storage.columns]) assert.ok(Object.isFrozen(value));
  assert.equal(Object.hasOwn(captured.storage, 'schema'), false);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.columns), false);
});

test('explicit pure storage is detached, complete, and still uses logical model columns', () => {
  const source = mappedInput();
  const captured = tableModel(source);
  source.storage.table = 'changed'; source.storage.schema = 'changed'; source.storage.columns.id = 'changed';
  assert.deepEqual(captured.storage, { table: 'Physical rows', schema: 'A.schema', columns: { id: 'row ID', label: 'display "label"' } });
  assert.deepEqual(captured.columns, ['id', 'label']);
  assert.deepEqual(captured.primaryKey, ['id']);
  const query = queryModel.select({ table: captured, columns: ['label'], orderBy: [], limit: 1, offset: 0 });
  assert.deepEqual(query.columns, ['label']);
  assert.deepEqual(query.table.storage, captured.storage);
  assert.throws(() => queryModel.select({ table: captured, columns: ['display "label"'], orderBy: [], limit: 1, offset: 0 }), code('SCHEMA'));
  const simpleAlias = tableModel({ ...legacyModel(), storage: { table: 'physical', columns: { id: 'physicalId', label: 'physicalLabel' } } });
  assert.throws(() => queryModel.select({ table: simpleAlias, columns: ['physicalLabel'], orderBy: [], limit: 1, offset: 0 }), code('QUERY'));
});

test('pure storage rejects partial/extra maps, duplicate physical columns and descriptor tricks', () => {
  for (const bad of [
    { table: 'physical', columns: { id: 'one' } },
    { table: 'physical', columns: { id: 'one', label: 'two', extra: 'three' } },
    { table: 'physical', columns: { id: 'same', label: 'same' } },
    { columns: { id: 'one', label: 'two' } },
    { table: 'physical', schema: null, columns: { id: 'one', label: 'two' } },
    { table: 'physical', columns: { id: 'one', label: null } },
    { ...storage(), [Symbol('extra')]: 'unsupported' },
    { ...storage(), columns: { ...storage().columns, [Symbol('extra')]: 'unsupported' } },
  ]) assert.throws(() => tableModel({ ...legacyModel(), storage: bad }), code('SCHEMA'));
  let reads = 0;
  const withAccessor = storage();
  Object.defineProperty(withAccessor.columns, 'id', { enumerable: true, get() { reads++; throw new Error(privateMarker); } });
  assert.throws(() => tableModel({ ...legacyModel(), storage: withAccessor }), privateCode('SCHEMA'));
  const nonenumerable = storage();
  Object.defineProperty(nonenumerable.columns, 'extra', { value: privateMarker });
  assert.throws(() => tableModel({ ...legacyModel(), storage: nonenumerable }), privateCode('SCHEMA'));
  assert.equal(reads, 0);
});

test('mapping descriptor trap errors never escape as caller-controlled errors', () => {
  for (const thrown of [new Error(privateMarker), new RowstitchError('SCHEMA', privateMarker)]) {
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
      const hostile = target => new Proxy(target, { [trap]() { throw thrown; } });
      assert.throws(() => tableModel({ ...legacyModel(), storage: hostile(storage()) }), privateCode('SCHEMA'));
      assert.throws(() => tableModel({ ...legacyModel(), storage: { ...storage(), columns: hostile(storage().columns) } }), privateCode('SCHEMA'));
      assert.throws(() => tableModel({ ...legacyModel(), columns: hostile(['id', 'label']) }), privateCode('SCHEMA'));
    }
  }
  const revoked = Proxy.revocable(storage(), {}); revoked.revoke();
  assert.throws(() => tableModel({ ...legacyModel(), storage: revoked.proxy }), privateCode('SCHEMA'));
});

test('genuine table mapping caches stable logical identities and detached complete storage', () => {
  const table = defineTable('cache_identity', { id: key().storedAs('physical ID'), label: column.text().storedAs('__proto__') }, { storage: { table: 'physical.table', schema: 'S' } });
  const first = mappedTableModel(table), second = mappedTableModel(table);
  assert.equal(first, second);
  assert.deepEqual(first.columns, ['id', 'label']);
  assert.deepEqual(first.storage, table.storage);
  assert.notEqual(first.storage, table.storage);
  assert.ok(Object.isFrozen(first.storage) && Object.isFrozen(first.storage.columns));
  assert.throws(() => mappedTableModel(Object.create(Object.getPrototypeOf(table))), code('SCHEMA'));
});

test('legacy pure FK targets normalize to structured physical identities', () => {
  const legacy = queryModel.createTable(ddl({ table: 'legacy_parents', column: 'id', onDelete: 'cascade' }));
  assert.deepEqual(legacy.definitions[1].foreignKey, { target: { table: 'legacy_parents', column: 'id' }, onDelete: 'cascade' });
  assert.equal(Object.hasOwn(legacy.definitions[1].foreignKey, 'table'), false);
  assert.ok(Object.isFrozen(legacy.definitions[1].foreignKey) && Object.isFrozen(legacy.definitions[1].foreignKey.target));
  const target = { schema: 's', table: '"s"."t"', column: 'parent ID' };
  const source = ddl({ target, onDelete: 'no action' });
  const normalized = queryModel.createTable(source);
  target.schema = 'changed'; target.table = 'changed'; target.column = 'changed';
  assert.deepEqual(normalized.definitions[1].foreignKey, { target: { schema: 's', table: '"s"."t"', column: 'parent ID' }, onDelete: 'no action' });
  for (const foreignKey of [
    { target: { table: 'p', column: 'id' }, table: 'p', onDelete: 'no action' },
    { target: { table: 'p' }, onDelete: 'no action' },
    { target: { schema: 's', table: 'p', column: 'id', extra: privateMarker }, onDelete: 'no action' },
    { target: 's.p', onDelete: 'no action' },
  ]) assert.throws(() => queryModel.createTable(ddl(foreignKey)), privateCode('SCHEMA'));
});

test('mapped DDL resolves target aliases and leaves an omitted target schema unresolved', () => {
  const parent = defineTable('logical_parent', { id: key().storedAs('parent ID') }, { storage: { table: 'physical parent', schema: 'Parent.Space' } });
  const child = defineTable('logical_child', { id: key(), parentId: column.integer().storedAs('owner ID').references(parent, 'id') }, { storage: { table: 'physical child', schema: 'Child.Space' } });
  const model = mappedCreateTableModel(child);
  assert.equal(model.definitions[1].name, 'parentId');
  assert.equal(model.table.storage.columns.parentId, 'owner ID');
  assert.deepEqual(model.definitions[1].foreignKey, { target: { schema: 'Parent.Space', table: 'physical parent', column: 'parent ID' }, onDelete: 'no action' });
  const defaultParent = defineTable('default_parent', { id: key().storedAs('target ID') }, { storage: { table: 'default physical' } });
  const explicitChild = defineTable('explicit_child', { id: key(), parentId: column.integer().references(defaultParent, 'id') }, { storage: { schema: 'owner explicit' } });
  const target = mappedCreateTableModel(explicitChild).definitions[1].foreignKey.target;
  assert.deepEqual(target, { table: 'default physical', column: 'target ID' });
  assert.equal(Object.hasOwn(target, 'schema'), false, 'target default does not inherit the owner explicit schema');
});
