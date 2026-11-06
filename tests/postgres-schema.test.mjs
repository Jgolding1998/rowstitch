import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPostgresSchemaWork, inspectPostgresSchemaDetailsWork } from '../dist/core/postgres-schema.js';
import { snapshotPostgresResult } from '../dist/core/postgres-result.js';

const code = expected => error => error?.code === expected && !/SYNTHETIC_PRIVATE/.test(error.message);
const column = (name, extra = {}) => ({name, type: 'integer', nullable: false, primaryKeyOrder: 0, default: null, generated: false,
  typeOid: 23, identity: '', generation: extra.generated ? 's' : '', hasDefault: extra.default !== undefined && extra.default !== null, ...extra});
const fk = (extra = {}) => ({constraint: 'child_parent', constraintOid: 40001, width: 1, position: 1, column: 'tenant', targetSchema: 'sample', targetTable: 'parents', target: 'tenant_id', onDelete: 'cascade', onUpdate: 'restrict', enforced: true, validated: true, match: 'simple', deferrable: false, initiallyDeferred: false, deleteSetColumns: null, ...extra});
const index = (extra = {}) => ({name: 'child_pkey', columns: ['tenant', 'id'], unique: true, origin: 'p', partial: false,
  primary: (extra.origin ?? 'p') === 'p', valid: true, ready: true, live: true, immediate: true, ...extra});
const table = (extra = {}) => ({name: 'children', kind: 'r', columns: [column('id', {primaryKeyOrder: 2}), column('tenant', {primaryKeyOrder: 1}),
  column('status', {type: '"Types"."Status"', typeOid: 40000, nullable: true, default: "'new'::text"}), column('computed', {generated: true})],
  foreignKeys: [fk({width: 2}), fk({width: 2, position: 2, column: 'id', target: 'id'})],
  indexes: [index(), index({name: 'expression_idx', columns: [null, 'status'], unique: false, origin: 'c', partial: true})],
  totalColumnCount: extra.columns?.length ?? 4, ...extra});
const payload = (extra = {}) => ({schema: 'sample', exists: true, tables: [table()], conflicts: [], ...extra});
const raw = data => ({fields: [{name: '__rs_pg_schema', typeOid: 3802}], rows: [[JSON.stringify(data)]], command: 'SELECT', rowCount: 1n});
const step = (schema = 'sample') => inspectPostgresSchemaWork(schema).next().value;
const drive = (work, input) => {const request = work.next().value; return work.next(request.decode(input)).value;};
const decode = data => drive(inspectPostgresSchemaWork('sample'), raw(data));

test('inspection yields one bound, qualified, untraced metadata request and returns its decoded tables', () => {
  const work = inspectPostgresSchemaWork('sample'), request = work.next().value;
  assert.equal(request.metadata, true); assert.equal(request.operation, 'schema'); assert.equal(request.table, '');
  assert.equal(request.parameters[0], 'sample');
  assert.deepEqual(JSON.parse(request.parameters[1]), {all: true, tables: [], indexes: []}); assert.ok(Object.isFrozen(request.parameters));
  assert.match(request.sql, /"pg_catalog"\."pg_class"/); assert.match(request.sql, /\$1::"pg_catalog"\."text"/);
  assert.ok(!request.sql.includes('sample')); assert.ok(!request.sql.includes('pg_table_is_visible'));
  assert.ok(!request.sql.includes('sqlite_schema')); assert.equal(typeof request.decode, 'function');
  const rows = request.decode(raw(payload()));
  const completed = work.next(rows); assert.equal(completed.done, true); assert.equal(completed.value[0].name, 'children');
  assert.equal(work.next().done, true);
});

test('default namespace is public and unsupported namespace inputs fail before yielding SQL', () => {
  assert.equal(inspectPostgresSchemaWork().next().value.parameters[0], 'public');
  assert.equal(inspectPostgresSchemaWork('odd.name').next().value.parameters[0], 'odd.name');
  for (const schema of ['', 'x'.repeat(64), 'pg_catalog', 'pg_temp', 'information_schema', 1, null, {}]) {
    assert.throws(() => inspectPostgresSchemaWork(schema).next(), code('SCHEMA'));
  }
});

test('actual type case, composite primary-key order, defaults and computed generated flags are preserved', () => {
  const result = decode(payload())[0];
  assert.deepEqual(result.columns, [
    {name: 'id', type: 'integer', nullable: false, primaryKey: true, primaryKeyOrder: 2, default: null, generated: false, hidden: false},
    {name: 'tenant', type: 'integer', nullable: false, primaryKey: true, primaryKeyOrder: 1, default: null, generated: false, hidden: false},
    {name: 'status', type: '"Types"."Status"', nullable: true, primaryKey: false, primaryKeyOrder: 0, default: "'new'::text", generated: false, hidden: false},
    {name: 'computed', type: 'integer', nullable: false, primaryKey: false, primaryKeyOrder: 0, default: null, generated: true, hidden: false},
  ]);
  assert.deepEqual(result.foreignKeys, [
    {column: 'tenant', table: 'parents', target: 'tenant_id', targetIdentity: {schema: 'sample', table: 'parents'}, constraint: 'child_parent', position: 1, width: 2, onDelete: 'cascade', onUpdate: 'restrict'},
    {column: 'id', table: 'parents', target: 'id', targetIdentity: {schema: 'sample', table: 'parents'}, constraint: 'child_parent', position: 2, width: 2, onDelete: 'cascade', onUpdate: 'restrict'},
  ]);
  assert.deepEqual(result.indexes, [{name: 'child_pkey', columns: ['tenant', 'id'], unique: true, origin: 'p', partial: false},
    {name: 'expression_idx', columns: [null, 'status'], unique: false, origin: 'c', partial: true}]);
});

test('cross-schema FK components are always quoted and escaped independently of search_path', () => {
  const source = table({foreignKeys: [fk({targetSchema: 'Other.Schema', targetTable: 'Odd"Table'})]});
  assert.equal(decode(payload({tables: [source]}))[0].foreignKeys[0].table, '"Other.Schema"."Odd""Table"');
  source.foreignKeys[0].targetSchema = 'outside'; source.foreignKeys[0].targetTable = 'parents';
  assert.equal(decode(payload({tables: [source]}))[0].foreignKeys[0].table, '"outside"."parents"');
});

test('empty scoped schemas and native zero-column tables are representable', () => {
  assert.deepEqual(decode(payload({tables: []})), []);
  assert.deepEqual(decode(payload({tables: [table({columns: [], foreignKeys: [], indexes: []})]})), [{name: 'children', identity: {schema: 'sample', table: 'children'}, coverage: {scope: 'all', columns: 'all', totalColumnCount: 0}, columns: [], foreignKeys: [], indexes: []}]);
});

test('all-column coverage requires an exact and bounded total column count', () => {
  assert.equal(decode(payload())[0].coverage.totalColumnCount, 4);
  for (const totalColumnCount of [undefined, -1, 3, 5, 4.5, '4']) {
    assert.throws(() => decode(payload({tables: [table({totalColumnCount})]})), code('DATA'));
  }
  assert.throws(() => decode(payload({tables: [table({totalColumnCount: 1601})]})), code('RESULT_LIMIT'));
});

test('private details preserve native kinds OIDs identity generation and actual DEFAULT presence without changing public columns', () => {
  const input = payload({tables: [table({kind: 'p', columns: [column('always_id', {identity: 'a'}), column('default_id', {identity: 'd'}),
    column('stored', {generated: true, generation: 's'}), column('virtual', {generated: true, generation: 'v'}), column('fallback', {default: '42'})], foreignKeys: [], indexes: []})]});
  const details = drive(inspectPostgresSchemaDetailsWork('sample'), raw(input));
  assert.equal(details.schema, 'sample'); assert.equal(details.exists, true); assert.equal(details.tables[0].kind, 'p');
  assert.deepEqual(details.tables[0].columns, [
    {name: 'always_id', typeOid: 23, identity: 'a', generation: '', hasDefault: false},
    {name: 'default_id', typeOid: 23, identity: 'd', generation: '', hasDefault: false},
    {name: 'stored', typeOid: 23, identity: '', generation: 's', hasDefault: false},
    {name: 'virtual', typeOid: 23, identity: '', generation: 'v', hasDefault: false},
    {name: 'fallback', typeOid: 23, identity: '', generation: '', hasDefault: true},
  ]);
  assert.deepEqual(decode(input), details.tables.map(item => item.table));
  assert.ok(!Object.hasOwn(decode(input)[0].columns[0], 'identity'));
  const missing = drive(inspectPostgresSchemaDetailsWork('sample'), raw(payload({exists: false, tables: []})));
  assert.equal(missing.exists, false); assert.deepEqual(missing.tables, []);
  assert.throws(() => decode(payload({exists: false})), code('DATA'));
});

test('private native details reject invalid OIDs flags and inconsistent default or generation facts', () => {
  for (const change of [p => {p.kind = 'i';}, p => {p.columns[0].typeOid = 0;}, p => {p.columns[0].typeOid = 1.5;},
    p => {p.columns[0].typeOid = 2 ** 32;}, p => {p.columns[0].identity = 'x';}, p => {p.columns[0].generation = 'x';},
    p => {p.columns[0].hasDefault = true;}, p => {p.columns[3].generation = '';}, p => {p.columns[3].identity = 'a';}]) {
    const input = table(); change(input); assert.throws(() => decode(payload({tables: [input]})), code('DATA'));
  }
});

test('private FK groups distinguish a composite constraint from independent single-column obligations', () => {
  const composite = payload(), singles = payload();
  Object.assign(singles.tables[0].foreignKeys[0], {width: 1});
  Object.assign(singles.tables[0].foreignKeys[1], {constraint: 'separate_fk', constraintOid: 40002, width: 1, position: 1});
  assert.deepEqual(decode(composite)[0].foreignKeys.map(key => [key.position, key.width]), [[1, 2], [2, 2]]);
  assert.deepEqual(decode(singles)[0].foreignKeys.map(key => [key.position, key.width]), [[1, 1], [1, 1]]);
  const grouped = drive(inspectPostgresSchemaDetailsWork('sample'), raw(composite)).tables[0].foreignKeys;
  assert.deepEqual(grouped, [{name: 'child_parent', oid: 40001, width: 2, columns: ['tenant', 'id'], table: 'parents', targetIdentity: {schema: 'sample', table: 'parents'}, targets: ['tenant_id', 'id'], onDelete: 'cascade', onUpdate: 'restrict', enforced: true, validated: true, match: 'simple', deferrable: false, initiallyDeferred: false, deleteSetColumns: null}]);
  const independent = drive(inspectPostgresSchemaDetailsWork('sample'), raw(singles)).tables[0].foreignKeys;
  assert.deepEqual(independent.map(key => key.columns), [['tenant'], ['id']]);
  assert.ok(Object.isFrozen(grouped)); assert.ok(Object.isFrozen(grouped[0].columns)); assert.ok(Object.isFrozen(grouped[0].targets));
});

test('private enforcement and index activity facts are preserved without inventing public UI fields', () => {
  const input = payload(); input.tables[0].foreignKeys.forEach(key => {key.enforced = false; key.validated = false;});
  input.tables[0].indexes[0].valid = false; input.tables[0].indexes[0].ready = false;
  const details = drive(inspectPostgresSchemaDetailsWork('sample'), raw(input)).tables[0];
  assert.equal(details.foreignKeys[0].enforced, false); assert.equal(details.foreignKeys[0].validated, false);
  assert.deepEqual(details.indexes[0], {name: 'child_pkey', primary: true, valid: false, ready: false, live: true, immediate: true});
  assert.ok(!Object.hasOwn(details.table.foreignKeys[0], 'enforced')); assert.ok(!Object.hasOwn(details.table.indexes[0], 'valid'));
  for (const change of [p => {p.foreignKeys[0].enforced = 'false';}, p => {p.foreignKeys[1].validated = false;}, p => {p.indexes[0].valid = 1;}, p => {p.indexes[0].primary = 'true';}]) {
    const table = input.tables[0] = structuredClone(payload().tables[0]); change(table); assert.throws(() => decode(input), code('DATA'));
  }
});

test('raw result requires exact SELECT command, JSONB alias, one field, one row and confirmed count', () => {
  for (const change of [r => {r.command = 'INSERT';}, r => {r.rowCount = null;}, r => {r.rowCount = 0n;}, r => {r.rowCount = 2n;}, r => {r.rowCount = 1;},
    r => {r.fields[0].typeOid = 114;}, r => {r.fields[0].name = 'schema';}, r => {r.fields = [];}, r => {r.rows = [];},
    r => {r.rows.push(r.rows[0]);}, r => {r.fields.push(r.fields[0]);}, r => {r.rows[0].push('extra');}, r => {r.rows[0][0] = null;}, r => {r.rows[0][0] = {};}]) {
    const result = raw(payload()); change(result); assert.throws(() => step().decode(result), code('DATA'));
  }
});

test('raw wire and JSON schema mismatches fail without disclosing supplied text', () => {
  for (const value of ['not JSON SYNTHETIC_PRIVATE', '\ud800', '"SYNTHETIC_PRIVATE\0"', 'null', '[]', '{}']) {
    const result = raw(payload()); result.rows[0][0] = value; assert.throws(() => step().decode(result), code('DATA'));
  }
  for (const data of [payload({schema: 'outside'}), {...payload(), extra: 'SYNTHETIC_PRIVATE'}, payload({tables: {}})]) assert.throws(() => decode(data), code('DATA'));
});

test('duplicate table, column and index names are refused, while distinct quoted names remain distinct', () => {
  for (const change of [p => {p.tables.push(structuredClone(p.tables[0]));}, p => {p.tables[0].columns.push(column('id'));}, p => {p.tables[0].indexes.push(index());}]) {
    const data = payload(); change(data); assert.throws(() => decode(data), code('DATA'));
  }
  assert.equal(decode(payload({tables: [table({name: 'Case'}), table({name: 'case'})]})).length, 2);
});

test('primary-key ordinals are bounded, contiguous, unique and non-null', () => {
  for (const change of [p => {p.columns[0].primaryKeyOrder = 1;}, p => {p.columns[0].primaryKeyOrder = 3;}, p => {p.columns[0].primaryKeyOrder = -1;},
    p => {p.columns[0].primaryKeyOrder = 1.5;}, p => {p.columns[0].primaryKeyOrder = 101;}, p => {p.columns[0].nullable = true;}]) {
    const data = table(); change(data); assert.throws(() => decode(payload({tables: [data]})), code('DATA'));
  }
});

test('foreign-key ordinals, local columns and group metadata are validated without flattening genuine distinct constraints', () => {
  for (const change of [p => {p.foreignKeys.push(fk());}, p => {p.foreignKeys[0].position = 3;}, p => {p.foreignKeys[1].column = 'tenant';},
    p => {p.foreignKeys[0].column = 'missing';}, p => {p.foreignKeys[0].onDelete = 'invented';}, p => {p.foreignKeys[1].onUpdate = 'cascade';},
    p => {p.foreignKeys[1].targetSchema = 'outside';}, p => {p.foreignKeys[1].position = null;}]) {
    const data = table(); change(data); assert.throws(() => decode(payload({tables: [data]})), code('DATA'));
  }
  const data = table({foreignKeys: [fk(), fk({constraint: 'duplicate_declared_fk', constraintOid: 40002})]});
  assert.equal(decode(payload({tables: [data]}))[0].foreignKeys.length, 2);
  for (const action of ['no action', 'restrict', 'cascade', 'set null', 'set default']) {
    const data = table({foreignKeys: [fk({onDelete: action, onUpdate: action})]});
    assert.equal(decode(payload({tables: [data]}))[0].foreignKeys[0].onDelete, action);
  }
});

test('index expression slots and repeated keys remain positional; invalid origins, columns and flags fail', () => {
  const data = table({indexes: [index({name: 'repeated', columns: [null, 'id', 'id'], unique: false, origin: 'c'})]});
  assert.deepEqual(decode(payload({tables: [data]}))[0].indexes[0].columns, [null, 'id', 'id']);
  for (const change of [p => {p.indexes[0].columns = [];}, p => {p.indexes[0].columns[0] = 'missing';}, p => {p.indexes[0].origin = 'f';},
    p => {p.indexes[0].unique = false;}, p => {p.indexes[0].partial = 1;}, p => {p.indexes[0].columns[0] = 1;}]) {
    const data = table(); change(data); assert.throws(() => decode(payload({tables: [data]})), code('DATA'));
  }
});

test('limit+1 metadata is refused for each collection, never returned as a truncated complete schema', () => {
  const samples = [payload({tables: Array.from({length: 101}, (_, i) => table({name: 't' + i}))}),
    payload({tables: [table({columns: Array.from({length: 101}, (_, i) => column('c' + i))})]}),
    payload({tables: [table({foreignKeys: Array.from({length: 101}, (_, i) => fk({constraint: 'fk' + i}))})]}),
    payload({tables: [table({indexes: Array.from({length: 101}, (_, i) => index({name: 'idx' + i}))})]}),
    payload({tables: [table({indexes: [index({columns: new Array(101).fill('id')})]})]})];
  for (const data of samples) assert.throws(() => decode(data), code('RESULT_LIMIT'));
  assert.equal(decode(payload({tables: Array.from({length: 100}, (_, i) => table({name: 't' + i}))})).length, 100);
});

test('names, type text and default expressions have explicit finite bounds and safe string types', () => {
  for (const change of [p => {p.name = 'x'.repeat(64);}, p => {p.columns[0].type = 'x'.repeat(1025);}, p => {p.columns[0].default = 'x'.repeat(16_385);}]) {
    const data = table(); change(data); assert.throws(() => decode(payload({tables: [data]})), code('RESULT_LIMIT'));
  }
  for (const change of [p => {p.name = '';}, p => {p.name = '\ud800';}, p => {p.columns[0].type = null;}, p => {p.columns[0].nullable = 1;},
    p => {p.columns[0].default = 1;}, p => {p.columns[3].default = '42';}, p => {p.columns[0].generated = 'false';}]) {
    const data = table(); change(data); assert.throws(() => decode(payload({tables: [data]})), code('DATA'));
  }
});

test('oversized or deeply nested JSON blobs fail at the global budget before typed traversal', () => {
  const oversized = raw(payload()); oversized.rows[0][0] = ' '.repeat(8_388_609);
  assert.throws(() => step().decode(oversized), code('RESULT_LIMIT'));
  let nested = 0; for (let i = 0; i < 15; i++) nested = [nested];
  assert.throws(() => decode({...payload(), nested}), code('RESULT_LIMIT'));
});

test('data accessors and Proxies in raw structures are refused without invoking supplied code', () => {
  let calls = 0;
  const accessor = {get() {calls++; throw new Error('SYNTHETIC_PRIVATE');}, enumerable: true};
  for (const change of [r => Object.defineProperty(r, 'rows', accessor), r => Object.defineProperty(r.fields[0], 'typeOid', accessor), r => Object.defineProperty(r.rows[0], '0', accessor)]) {
    const result = raw(payload()); change(result); assert.throws(() => step().decode(result), code('DATA'));
  }
  const proxy = value => new Proxy(value, {get() {calls++; throw new Error('SYNTHETIC_PRIVATE');}, getPrototypeOf() {calls++; throw new Error('SYNTHETIC_PRIVATE');}, ownKeys() {calls++; throw new Error('SYNTHETIC_PRIVATE');}});
  for (const change of [r => proxy(r), r => {r.fields = proxy(r.fields); return r;}, r => {r.fields[0] = proxy(r.fields[0]); return r;}, r => {r.rows = proxy(r.rows); return r;}, r => {r.rows[0] = proxy(r.rows[0]); return r;}]) assert.throws(() => step().decode(change(raw(payload()))), code('DATA'));
  assert.equal(calls, 0);
});

test('snapshots and caller input stay unchanged, and returned metadata is detached from raw rows', () => {
  const input = raw(payload()), before = structuredClone(input);
  const snapshot = snapshotPostgresResult(input), decoded = drive(inspectPostgresSchemaWork('sample'), snapshot);
  assert.deepEqual(input, before); decoded[0].name = 'caller edit';
  assert.deepEqual(input, before); assert.ok(Object.isFrozen(snapshot.rows[0]));
  assert.equal(drive(inspectPostgresSchemaWork('sample'), snapshot)[0].name, 'children');
});

test('unknown metadata fields are refused rather than interpreted as supported catalog guarantees', () => {
  for (const change of [p => {p.tables[0].roles = [];}, p => {p.tables[0].columns[0].identity = true;}, p => {p.tables[0].indexes[0].opclass = 'unknown';}, p => {p.tables[0].foreignKeys[0].temporallyVerified = true;}]) {
    const data = payload(); change(data); assert.throws(() => decode(data), code('DATA'));
  }
});
