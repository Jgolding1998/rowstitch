import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {inspectPostgresSchemaDetailsWork, inspectPostgresSchemaWork} from '../dist/core/postgres-schema.js';
import {planPostgresSchemaWork} from '../dist/core/postgres-schema-plan.js';
import {column, defineTable} from '../dist/core/schema.js';

const base = 'source.space', other = 'target.space', physicalParent = 'target';
const parent = defineTable('accounts', {id: column.integer().primaryKey().storedAs('account.id')}, {
  storage: {schema: other, table: physicalParent},
});
const child = defineTable('events', {
  id: column.integer().primaryKey().storedAs('event.id'),
  account: column.integer().references(parent, 'id', {onDelete: 'cascade'}).storedAs('account "key"'),
}, {storage: {table: 'events.raw'}, schemaPolicy: 'subset'});
const registry = (...tables) => new Map(tables.map(table => [table.name, table]));
const code = expected => error => error?.code === expected;
const indexName = 'rs_fk_' + createHash('sha256').update('events.raw\0account "key"').digest('hex').slice(0, 16);
const field = (name, options = {}) => ({
  name, type: 'bigint', nullable: false, primaryKeyOrder: 0, default: null, generated: false,
  typeOid: 20, identity: '', generation: '', hasDefault: false, ...options,
});
const index = (name, columns, primary = false) => ({
  name, columns, primary, unique: primary, origin: primary ? 'p' : 'c', partial: false,
  valid: true, ready: true, live: true, immediate: true,
});
const fk = (options = {}) => ({
  constraint: 'events_account', constraintOid: 1001, width: 1, position: 1, column: 'account "key"',
  targetSchema: other, targetTable: physicalParent, target: 'account.id', onDelete: 'cascade', onUpdate: 'no action',
  enforced: true, validated: true, match: 'simple', deferrable: false, initiallyDeferred: false, deleteSetColumns: null, ...options,
});
const table = (name, columns = [], foreignKeys = [], indexes = []) => ({name, kind: 'r', totalColumnCount: columns.length, columns, foreignKeys, indexes});
const physical = (foreignKeys = [fk()]) => ({
  [base]: [table('events.raw', [field('event.id', {primaryKeyOrder: 1}), field('account "key"')], foreignKeys,
    [index('same_pkey', ['event.id'], true), index(indexName, ['account "key"'])])],
  [other]: [table(physicalParent, [field('account.id', {primaryKeyOrder: 1})], [], [index('same_pkey', ['account.id'], true)])],
});
const raw = (schema, tables, extras = {}) => ({
  fields: [{name: '__rs_pg_schema', typeOid: 3802}],
  rows: [[JSON.stringify({schema, exists: true, tables, conflicts: [], ...extras})]], command: 'SELECT', rowCount: 1n,
});
function drive(work, tables = {}, response = raw) {
  const calls = [];
  let step = work.next();
  while (!step.done) {
    const request = step.value;
    assert.equal(request.metadata, true);
    const [schema, scope] = request.parameters;
    calls.push({schema, scope: JSON.parse(scope), sql: request.sql});
    step = work.next(request.decode(response(schema, tables[schema] ?? [])));
  }
  return {value: step.value, calls};
}

test('catalog batches exact physical names per namespace and distinguishes mapped and all coverage', () => {
  const mapped = drive(inspectPostgresSchemaWork(base, [child, parent], 'mapped'), physical());
  assert.deepEqual(mapped.calls.map(call => call.schema), [base, other]);
  assert.deepEqual(mapped.calls[0].scope, {
    all: false, tables: [{table: 'events.raw', columns: ['event.id', 'account "key"']}],
    indexes: [{name: indexName, table: 'events.raw'}],
  });
  assert.ok(mapped.calls.every(call => !call.sql.includes('events.raw') && !call.sql.includes('account "key"')));
  assert.deepEqual(mapped.value.map(result => [result.identity, result.coverage]), [
    [{schema: base, table: 'events.raw'}, {scope: 'mapped', columns: 'mapped-and-key', totalColumnCount: 2}],
    [{schema: other, table: physicalParent}, {scope: 'mapped', columns: 'mapped-and-key', totalColumnCount: 1}],
  ]);
  const all = drive(inspectPostgresSchemaWork(base, [child, parent]), {
    ...physical(), [other]: [...physical()[other], table('unregistered')],
  });
  assert.equal(all.value.length, 3);
  assert.ok(all.calls.every(call => call.scope.all));
  assert.ok(all.value.every(result => result.coverage.scope === 'all' && result.coverage.columns === 'all'));
  const empty = drive(inspectPostgresSchemaDetailsWork(base, [], 'mapped'));
  assert.equal(empty.value.scope, 'mapped');
  assert.deepEqual(empty.value.tables, []);
  assert.deepEqual(empty.value.namespaces, []);
  assert.equal(empty.value.exists, null);
  assert.deepEqual(empty.calls, []);
  assert.deepEqual(drive(planPostgresSchemaWork(registry(), base)), {value: [], calls: []});
});

test('explicit mappings can plan when the unused factory default namespace is missing', () => {
  const response = (schema, tables) => raw(schema, tables, {exists: schema !== base});
  const actual = {[other]: physical()[other]};
  const mapped = drive(inspectPostgresSchemaDetailsWork(base, [parent], 'mapped'), actual, response);
  assert.deepEqual(mapped.calls.map(call => call.schema), [other]);
  assert.equal(mapped.value.exists, null);
  assert.deepEqual(mapped.value.namespaces, [{schema: other, exists: true}]);
  const plan = drive(planPostgresSchemaWork(registry(parent), base), actual, response);
  assert.deepEqual(plan.calls.map(call => call.schema), [other]);
  assert.deepEqual(plan.value, []);
  const all = drive(inspectPostgresSchemaDetailsWork(base, [parent]), actual, response);
  assert.deepEqual(all.calls.map(call => call.schema), [base, other]);
  assert.equal(all.value.exists, false);
  assert.deepEqual(all.value.namespaces, [{schema: base, exists: false}, {schema: other, exists: true}]);
});

test('mapped catalog accepts unmapped primary components without exposing their default expressions', () => {
  const work = inspectPostgresSchemaWork(base, [child], 'mapped');
  const step = work.next().value;
  const extraKey = field('unmapped key', {primaryKeyOrder: 2});
  const result = physical()[base][0];
  result.columns.push(extraKey);
  result.totalColumnCount = 107;
  const inspected = step.decode(raw(base, [result]))[0].details.tables[0].table;
  assert.equal(inspected.columns.at(-1).primaryKeyOrder, 2);
  assert.equal(inspected.coverage.totalColumnCount, 107);
  assert.equal(inspected.columns.length, 3);
  assert.throws(() => step.decode(raw(base, [{...result, totalColumnCount: 2}])), code('DATA'));
  extraKey.default = "'fictional'::text";
  extraKey.hasDefault = true;
  assert.throws(() => step.decode(raw(base, [result])), code('DATA'));
  assert.throws(() => step.decode(raw(base, [table('unrequested')])), code('DATA'));
});

test('foreign targets with colliding display names retain distinct structured identities', () => {
  const display = '"target.space"."target"';
  const literal = fk({constraintOid: 1002, targetSchema: base, targetTable: display});
  const work = inspectPostgresSchemaWork(base, [child], 'mapped');
  const actual = drive(work, physical([fk(), literal])).value[0].foreignKeys;
  assert.equal(actual[0].table, actual[1].table);
  assert.deepEqual(actual.map(key => key.targetIdentity), [{schema: other, table: physicalParent}, {schema: base, table: display}]);
  assert.deepEqual(drive(planPostgresSchemaWork(registry(child, parent), base), physical()).value, []);
  assert.throws(() => drive(planPostgresSchemaWork(registry(child, parent), base), physical([literal])), code('SCHEMA_DRIFT'));
});

test('mapped planning uses physical index names and plans only table/index creation across schemas', () => {
  const plans = drive(planPostgresSchemaWork(registry(child, parent), base)).value;
  assert.deepEqual(plans.map(plan => [plan.table, plan.action]), [
    ['accounts', 'create-table'], ['events', 'create-table'], ['events', 'create-index'],
  ]);
  assert.match(plans[0].sql, /^CREATE TABLE "target\.space"\."target"/);
  assert.ok(plans[1].sql.includes('REFERENCES "target.space"."target" ("account.id") ON DELETE CASCADE'));
  assert.equal(plans[2].sql, 'CREATE INDEX "' + indexName + '" ON "source.space"."events.raw" ("account ""key""")');
  const missing = (schema, tables) => raw(schema, tables, {exists: schema !== other});
  assert.throws(() => drive(planPostgresSchemaWork(registry(child, parent), base), {}, missing), code('SCHEMA'));
  const conflict = (schema, tables) => raw(schema, tables, {conflicts: schema === base ? [indexName] : []});
  assert.throws(() => drive(planPostgresSchemaWork(registry(child, parent), base), {}, conflict), code('SCHEMA_DRIFT'));
});

test('subset requires mapped defaults and scalar FK behavior while exact also requires complete column coverage', () => {
  const mapping = policy => defineTable('examples', {
    id: column.integer().primaryKey().storedAs('physical key'),
    note: column.text().storedAs('physical note').default("A\\B's"),
  }, {storage: {table: 'example.raw'}, schemaPolicy: policy});
  const note = field('physical note', {type: 'text', typeOid: 25, default: "E'A\\\\B''s'::text", hasDefault: true});
  const found = table('example.raw', [field('physical key', {primaryKeyOrder: 1}), note], [], [index('example_pkey', ['physical key'], true)]);
  assert.deepEqual(drive(planPostgresSchemaWork(registry(mapping('subset')), base), {[base]: [found]}).value, []);
  const exact = drive(planPostgresSchemaWork(registry(mapping('exact')), base), {[base]: [found]});
  assert.equal(exact.calls[0].scope.tables[0].columns, null);
  assert.deepEqual(exact.value, []);
  found.columns.push(field('unmapped'));
  found.totalColumnCount++;
  assert.throws(() => drive(planPostgresSchemaWork(registry(mapping('exact')), base), {[base]: [found]}), code('SCHEMA_DRIFT'));
  found.columns.pop();
  found.totalColumnCount--;
  for (const expression of ["'different'::text", "lower('a'::text)"]) {
    note.default = expression;
    assert.throws(() => drive(planPostgresSchemaWork(registry(mapping('subset')), base), {[base]: [found]}), code('SCHEMA_DRIFT'));
  }
  const deferred = fk({deferrable: true, initiallyDeferred: true});
  assert.throws(() => drive(planPostgresSchemaWork(registry(child, parent), base), physical([deferred])), code('SCHEMA_DRIFT'));
});

test('the all-scope table limit applies across namespaces', () => {
  const tables = {
    [base]: Array.from({length: 60}, (_, index) => table('first_' + index)),
    [other]: Array.from({length: 41}, (_, index) => table('other_' + index)),
  };
  assert.throws(() => drive(inspectPostgresSchemaWork(base, [parent]), tables), code('RESULT_LIMIT'));
});

test('catalog inspection applies its UTF-8 byte budget across namespaces before parsing excess replies', () => {
  const limit = 8_388_608;
  const mappings = Array.from({length: 5}, (_, i) => defineTable('mapping_' + i,
    {id: column.integer().primaryKey()}, {storage: {schema: 'namespace_' + i}}));
  const expression = "'" + 'é'.repeat(8_000) + "'::text";
  const description = table('wide_defaults', Array.from({length: 100}, (_, i) =>
    field('field_' + i, {type: 'text', typeOid: 25, default: expression, hasDefault: true})));
  const work = inspectPostgresSchemaWork(base, mappings);
  let step = work.next(), totalBytes = 0, totalCodeUnits = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(step.done, false);
    const reply = raw(step.value.parameters[0], [description]);
    const wire = reply.rows[0][0];
    totalBytes += Buffer.byteLength(wire, 'utf8');
    totalCodeUnits += wire.length;
    assert.ok(totalBytes < limit);
    step = work.next(step.value.decode(reply));
  }
  assert.equal(step.done, false);
  const excess = raw(step.value.parameters[0], [description]);
  const wire = excess.rows[0][0];
  assert.ok(totalCodeUnits + wire.length < limit);
  assert.ok(totalBytes + Buffer.byteLength(wire, 'utf8') > limit);
  assert.throws(() => step.value.decode(excess), code('RESULT_LIMIT'));
  excess.rows[0][0] = '!' + wire.slice(1);
  assert.throws(() => step.value.decode(excess), code('RESULT_LIMIT'));
  const fresh = inspectPostgresSchemaWork(base).next().value;
  assert.doesNotThrow(() => fresh.decode(raw(base, [description])));
});
