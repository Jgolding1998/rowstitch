import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {column, defineTable} from '../dist/core/schema.js';
import {planPostgresSchemaWork, ensurePostgresSchemaWork} from '../dist/core/postgres-schema-plan.js';

const code = expected => error => error?.code === expected;
const oid = {integer: 20, bigint: 20, real: 701, text: 25, boolean: 16, json: 3802};
const fkIndex = (table, name) => 'rs_fk_' + createHash('sha256').update(table.name + '\0' + name).digest('hex').slice(0, 16);
const parent = defineTable('plan_parent', {id: column.integer().primaryKey(), label: column.text().unique()});
const child = defineTable('plan_child', {id: column.integer().primaryKey(), parent_id: column.integer().references(parent, 'id', {onDelete: 'cascade'})});
const registry = () => new Map([[child.name, child], [parent.name, parent]]);
const activity = (primary = false) => ({primary, valid: true, ready: true, live: true, immediate: true});
function physical(table, schema = 'sample') {
  const fields = Object.entries(table.columns), primary = fields.filter(([, c]) => c.config.primary).map(([name]) => name);
  const columns = fields.map(([name, {config: c}]) => ({name, type: 'native type', nullable: c.nullable, primaryKeyOrder: primary.indexOf(name) + 1,
    default: c.hasDefault && c.defaultValue !== null ? 'fictional_default' : null, generated: false, typeOid: oid[c.kind], identity: c.generated ? 'd' : '', generation: '', hasDefault: c.hasDefault && c.defaultValue !== null}));
  const foreignKeys = fields.filter(([, c]) => c.config.foreignKey).map(([name, {config: c}]) => ({constraint: 'fk_' + name, position: 1, column: name, targetSchema: schema,
    targetTable: c.foreignKey.table.name, target: c.foreignKey.column, onDelete: c.foreignKey.onDelete, onUpdate: 'no action', enforced: true, validated: true}));
  const indexes = [{name: table.name + '_pkey', columns: primary, unique: true, origin: 'p', partial: false, ...activity(true)}];
  for (const [name, {config: c}] of fields) {
    if (c.unique) indexes.push({name: table.name + '_' + name + '_unique', columns: [name], unique: true, origin: 'u', partial: false, ...activity()});
    if (c.foreignKey) indexes.push({name: fkIndex(table, name), columns: [name], unique: false, origin: 'c', partial: false, ...activity()});
  }
  return {name: table.name, kind: 'r', columns, foreignKeys, indexes};
}
const snapshot = (tables = [], extra = {}) => ({schema: 'sample', exists: true, tables, ...extra});
const response = data => ({fields: [{name: '__rs_pg_schema', typeOid: 3802}], rows: [[JSON.stringify(data)]], command: 'SELECT', rowCount: 1n});
function drive(work, snapshots, onStep) {
  const calls = []; let state = work.next();
  while (!state.done) {
    const step = state.value; calls.push(step); onStep?.(step, calls.length);
    const raw = step.metadata ? response(snapshots.shift()) : {fields: [], rows: [], command: 'CREATE', rowCount: null};
    assert.equal(typeof step.decode, 'function'); state = work.next(step.decode(raw));
  }
  return {value: state.value, calls};
}

test('planning is read-only and orders new parents before children regardless of registration order', () => {
  const result = drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot()]);
  assert.deepEqual(result.value.map(p => [p.table, p.action]), [['plan_parent', 'create-table'], ['plan_child', 'create-table'], ['plan_child', 'create-index']]);
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].metadata, true);
  assert.ok(result.value.every(p => p.model && p.sql.startsWith('CREATE ')));
  assert.ok(result.value[2].sql.includes('"' + fkIndex(child, 'parent_id') + '"'));
});

test('ensure yields typed creation steps then re-inspects before returning actual schema and public plans', () => {
  const result = drive(ensurePostgresSchemaWork(registry(), 'sample'), [snapshot(), snapshot([physical(parent), physical(child)])]);
  assert.equal(result.calls.length, 5); assert.equal(result.calls[0].metadata, true); assert.equal(result.calls.at(-1).metadata, true);
  for (const step of result.calls.slice(1, -1)) {assert.equal(step.control, true); assert.equal(step.operation, 'schema'); assert.equal(step.metadata, undefined); assert.deepEqual(step.parameters, []);}
  assert.deepEqual(result.value.plans.map(p => Object.keys(p).sort()), new Array(3).fill(['action', 'sql', 'table']));
  assert.deepEqual(result.value.schema.map(table => table.name), [parent.name, child.name]);
});

test('idempotent ensure still observes and validates a fresh schema inside its caller transaction', () => {
  const actual = snapshot([physical(parent), physical(child)]);
  const result = drive(ensurePostgresSchemaWork(registry(), 'sample'), [actual, actual]);
  assert.deepEqual(result.value.plans, []); assert.equal(result.calls.length, 2); assert.ok(result.calls.every(s => s.metadata));
});

test('registered table maps are captured before the catalog await', () => {
  const registered = registry(), work = planPostgresSchemaWork(registered, 'sample');
  const first = work.next().value; registered.clear();
  const completed = work.next(first.decode(response(snapshot())));
  assert.equal(completed.done, true); assert.equal(completed.value.filter(p => p.action === 'create-table').length, 2);
});

test('invalid registries and unregistered targets are refused before any query can be yielded', () => {
  for (const input of [new Map([['wrong', parent]]), new Map([[parent.name, {...parent}]]), new Map([[child.name, child]]), {}, new Proxy(registry(), {})]) {
    assert.throws(() => planPostgresSchemaWork(input, 'sample').next(), code('SCHEMA'));
  }
  const many = new Map(Array.from({length: 101}, (_, i) => {const table = defineTable('mapped_' + i, {id: column.integer().primaryKey()}); return [table.name, table];}));
  assert.throws(() => planPostgresSchemaWork(many, 'sample').next(), code('SCHEMA'));
});

test('missing namespaces fail clearly and do not invent CREATE SCHEMA plans', () => {
  assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([], {exists: false})]), code('SCHEMA'));
});

test('native compatible scalar OID alternatives are accepted without ALTER', () => {
  const table = defineTable('type_rows', {id: column.integer().primaryKey(), exact: column.bigint(), ratio: column.real(), label: column.text(), enabled: column.boolean(), data: column.json()});
  for (const changed of [[21, 23, 700, 1043, 16, 114], [23, 20, 701, 25, 16, 3802], [20, 21, 700, 1043, 16, 114]]) {
    const found = physical(table); found.columns.forEach((c, i) => {c.typeOid = changed[i];});
    assert.deepEqual(drive(planPostgresSchemaWork(new Map([[table.name, table]]), 'sample'), [snapshot([found])]).value, []);
  }
});

test('mapped type, nullability, primary-key, computed and default-presence drift is non-destructive', () => {
  const table = defineTable('drift_rows', {id: column.integer().primaryKey(), value: column.text().default('mapped')});
  for (const change of [p => {p.columns[1].typeOid = 20;}, p => {p.columns[1].nullable = true;}, p => {p.columns[1].default = null; p.columns[1].hasDefault = false;},
    p => {p.columns[1].generated = true; p.columns[1].generation = 's'; p.columns[1].default = null; p.columns[1].hasDefault = false;}, p => {p.kind = 'v';}]) {
    const found = physical(table); change(found);
    assert.throws(() => drive(planPostgresSchemaWork(new Map([[table.name, table]]), 'sample'), [snapshot([found])]), code('SCHEMA_DRIFT'));
  }
  const composite = defineTable('composite_key', {a: column.integer().primaryKey(), b: column.integer().primaryKey()});
  const found = physical(composite); found.columns[0].primaryKeyOrder = 2; found.columns[1].primaryKeyOrder = 1;
  assert.throws(() => drive(planPostgresSchemaWork(new Map([[composite.name, composite]]), 'sample'), [snapshot([found])]), code('SCHEMA_DRIFT'));
  const required = defineTable('required_value', {id: column.integer().primaryKey(), value: column.integer()}), computed = physical(required);
  computed.columns[1].generated = true; computed.columns[1].generation = 's';
  assert.throws(() => drive(planPostgresSchemaWork(new Map([[required.name, required]]), 'sample'), [snapshot([computed])]), code('SCHEMA_DRIFT'));
});

test('generated keys accept native identity modes or a real default without asserting sequence equivalence', () => {
  const table = defineTable('generated_key', {id: column.integer().primaryKey({generated: true})}), registered = new Map([[table.name, table]]);
  for (const identity of ['a', 'd']) {const found = physical(table); found.columns[0].identity = identity; assert.deepEqual(drive(planPostgresSchemaWork(registered, 'sample'), [snapshot([found])]).value, []);}
  const serial = physical(table); serial.columns[0].identity = ''; serial.columns[0].hasDefault = true; serial.columns[0].default = "nextval('fictional_sequence'::regclass)";
  assert.deepEqual(drive(planPostgresSchemaWork(registered, 'sample'), [snapshot([serial])]).value, []);
  const missing = physical(table); missing.columns[0].identity = '';
  assert.throws(() => drive(planPostgresSchemaWork(registered, 'sample'), [snapshot([missing])]), code('SCHEMA_DRIFT'));
});

test('nullable DEFAULT NULL normalization and existing default-value limits remain explicit', () => {
  const table = defineTable('null_default', {id: column.integer().primaryKey(), value: column.text().nullable().default(null)});
  assert.deepEqual(drive(planPostgresSchemaWork(new Map([[table.name, table]]), 'sample'), [snapshot([physical(table)])]).value, []);
  const other = defineTable('presence_only', {id: column.integer().primaryKey(), value: column.integer().default(1)}), found = physical(other);
  found.columns[1].default = '999';
  assert.deepEqual(drive(planPostgresSchemaWork(new Map([[other.name, other]]), 'sample'), [snapshot([found])]).value, [], 'Presence is checked; this is deliberately not default-value equivalence.');
});

test('trusted extra native columns and constraints remain intact but mapped unique obligations are required', () => {
  const found = physical(parent); found.columns.push({name: 'native_extra', type: 'text', nullable: true, primaryKeyOrder: 0, default: null, generated: false, typeOid: 25, identity: '', generation: '', hasDefault: false});
  found.indexes.push({name: 'native_extra_unique', columns: ['native_extra'], unique: true, origin: 'c', partial: true, ...activity(), valid: false, ready: false});
  assert.deepEqual(drive(planPostgresSchemaWork(new Map([[parent.name, parent]]), 'sample'), [snapshot([found])]).value, []);
  found.indexes = found.indexes.filter(i => i.columns[0] !== 'label');
  assert.throws(() => drive(planPostgresSchemaWork(new Map([[parent.name, parent]]), 'sample'), [snapshot([found])]), code('SCHEMA_DRIFT'));
});

test('a flattened component of a composite foreign key cannot satisfy a standalone mapped obligation', () => {
  const found = physical(child); found.columns.push({name: 'scope', type: 'integer', nullable: true, primaryKeyOrder: 0, default: null, generated: false, typeOid: 23, identity: '', generation: '', hasDefault: false});
  found.foreignKeys.push({...found.foreignKeys[0], position: 2, column: 'scope', target: 'scope'});
  assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([physical(parent), found])]), code('SCHEMA_DRIFT'));
});

test('missing foreign-key actions and conflicting named index shapes fail instead of being altered', () => {
  for (const change of [p => {p.foreignKeys = [];}, p => {p.foreignKeys[0].onDelete = 'no action';}, p => {p.indexes.at(-1).unique = true;},
    p => {p.indexes.at(-1).partial = true;}, p => {p.indexes.at(-1).columns = ['id'];}]) {
    const found = physical(child); change(found);
    assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([physical(parent), found])]), code('SCHEMA_DRIFT'));
  }
  const unrelated = physical(parent); unrelated.indexes.push({name: fkIndex(child, 'parent_id'), columns: ['id'], unique: false, origin: 'c', partial: false, ...activity()});
  const found = physical(child); found.indexes.pop();
  assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([unrelated, found])]), code('SCHEMA_DRIFT'));
});

test('missing canonical FK indexes become creation plans, not ALTER or silent IF NOT EXISTS', () => {
  const found = physical(child); found.indexes.pop();
  const result = drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([physical(parent), found])]);
  assert.equal(result.value.length, 1); assert.equal(result.value[0].action, 'create-index');
  assert.ok(!result.value[0].sql.includes('IF NOT EXISTS')); assert.ok(!result.value[0].sql.includes('ALTER'));
});

test('an acknowledged but unobserved creation fails final validation before caller commit', () => {
  assert.throws(() => drive(ensurePostgresSchemaWork(new Map([[parent.name, parent]]), 'sample'), [snapshot(), snapshot()]), code('SCHEMA_DRIFT'));
});

test('inactive PK, unique and required FK indexes cannot satisfy mapped obligations', () => {
  for (const flag of ['valid', 'ready', 'live', 'immediate']) {
    for (const indexPosition of [0, 1]) {
      const found = physical(parent); found.indexes[indexPosition][flag] = false;
      assert.throws(() => drive(planPostgresSchemaWork(new Map([[parent.name, parent]]), 'sample'), [snapshot([found])]), code('SCHEMA_DRIFT'));
    }
    const found = physical(child); found.indexes.at(-1)[flag] = false;
    assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([physical(parent), found])]), code('SCHEMA_DRIFT'));
  }
  const found = physical(parent); found.indexes[0].primary = false;
  assert.throws(() => drive(planPostgresSchemaWork(new Map([[parent.name, parent]]), 'sample'), [snapshot([found])]), code('SCHEMA_DRIFT'));
});

test('unenforced or unvalidated FK groups refuse drift without modifying old data', () => {
  for (const flag of ['enforced', 'validated']) {
    const found = physical(child); found.foreignKeys[0][flag] = false;
    assert.throws(() => drive(planPostgresSchemaWork(registry(), 'sample'), [snapshot([physical(parent), found])]), code('SCHEMA_DRIFT'));
  }
});
