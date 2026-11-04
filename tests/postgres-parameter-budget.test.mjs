import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.env.ROWSTITCH_TEST_DIST
  ? pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST) + '/') : new URL('../dist/', import.meta.url);
const { compilePostgres } = await import(new URL('core/postgres-compiler.js', dist));
const { queryModel, tableModel } = await import(new URL('core/query-model.js', dist));
const { RepositoryCore } = await import(new URL('core/repository-core.js', dist));
const { createPostgresDialect } = await import(new URL('core/postgres-dialect.js', dist));
const { column, defineTable } = await import(new URL('core/schema.js', dist));
const { hasMany, hasOne, belongsTo, inArray, eq } = await import(new URL('core/predicates.js', dist));

const MiB = 1024 * 1024, CAP = 16 * MiB;
const MESSAGE = 'The PostgreSQL parameter data exceeds its byte limit.';
const marker = 'FICTIONAL_PARAMETER_BUDGET_VALUE_';
const ascii = marker + 'x'.repeat(MiB - marker.length);
const parts = bytes => [...Array(Math.floor(bytes / MiB)).fill(ascii), ...(bytes % MiB ? [ascii.slice(0, bytes % MiB)] : [])];
const encoder = new TextEncoder();
const wireBytes = parameters => parameters.reduce((sum, value) => sum + (value === null ? 0 : encoder.encode(value).length), 0);
const refused = error => {
  assert.equal(error?.code, 'QUERY'); assert.equal(error.message, MESSAGE); assert.equal(error.cause, undefined);
  assert.ok(!inspect(error, { showHidden: true, depth: 8 }).includes(marker));
  return true;
};
const mapped = tableModel({ name: 'parameter_rows', columns: ['id', 'label'], primaryKey: ['id'],
  kinds: { id: 'integer', label: 'text' }, nullable: { id: false, label: false } });
const where = values => ({ kind: 'compare', column: 'label', operator: 'IN', values });
const selection = (values, extra = {}) => queryModel.select({ table: mapped, columns: ['id'], where: where(values), orderBy: [], limit: 10, offset: 0, ...extra });

test('root SELECT counts both generated page bindings at the exact UTF8 payload boundary', () => {
  // "10" and "0" consume three bytes in addition to the sixteen user values.
  const values = parts(CAP - 3), compiled = compilePostgres(selection(values));
  assert.equal(compiled.parameters.length, 18); assert.deepEqual(compiled.parameters.slice(-2), ['10', '0']);
  assert.equal(wireBytes(compiled.parameters), CAP);
  assert.throws(() => compilePostgres(selection(parts(CAP - 2))), refused);
  assert.ok(!compiled.sql.includes(marker));
});

test('multibyte and supplementary text is charged as UTF8 rather than UTF16 code units', () => {
  const accented = 'é'.repeat(MiB / 2), supplementary = '🧵'.repeat(MiB / 4);
  const values = [...Array(7).fill(accented), ...Array(8).fill(supplementary), ascii.slice(0, MiB - 3)];
  const compiled = compilePostgres(selection(values));
  assert.equal(wireBytes(compiled.parameters), CAP);
  assert.ok(compiled.parameters.reduce((sum, value) => sum + value.length, 0) < CAP);
  assert.throws(() => compilePostgres(selection([...values.slice(0, -1), values.at(-1) + 'x'])), refused);
  // Each value still obeys the existing one-MiB UTF16 scalar limit, but its UTF8 representation is twice as wide.
  assert.throws(() => compilePostgres(selection(Array(8).fill('🧵'.repeat(MiB / 2)))), refused);
});

test('INSERT counts canonical JSON, numeric and boolean spellings while SQL NULL contributes no payload bytes', () => {
  const texts = Array.from({ length: 16 }, (_, index) => 'text' + index);
  const kinds = { id: 'integer', exact: 'bigint', ratio: 'real', enabled: 'boolean', optional: 'text', doc: 'json',
    ...Object.fromEntries(texts.map(name => [name, 'text'])) };
  const table = tableModel({ name: 'parameter_insert', columns: Object.keys(kinds), primaryKey: ['id'], kinds,
    nullable: Object.fromEntries(Object.keys(kinds).map(name => [name, name === 'optional'])) });
  const document = JSON.stringify({ note: 'é🧵' });
  const fixed = [Number.MAX_SAFE_INTEGER, -(2n ** 63n), -0, 0, null, document];
  const fixedWire = [String(fixed[0]), String(fixed[1]), '-0', 'false', null, document];
  const fixedBytes = wireBytes(fixedWire), textValues = parts(CAP - fixedBytes);
  assert.equal(textValues.length, 16);
  const model = values => queryModel.insert({ table, columns: table.columns, values });
  const compiled = compilePostgres(model([...fixed, ...textValues]));
  assert.deepEqual(compiled.parameters.slice(0, fixed.length), fixedWire); assert.equal(wireBytes(compiled.parameters), CAP);
  const larger = [...fixed]; larger[5] = JSON.stringify({ note: 'é🧵x' });
  assert.throws(() => compilePostgres(model([...larger, ...textValues])), refused);
});

test('UPDATE combines assignment and WHERE payloads in a single statement budget', () => {
  const names = Array.from({ length: 16 }, (_, index) => 'text' + index);
  const table = tableModel({ name: 'parameter_update', columns: ['id', ...names], primaryKey: ['id'],
    kinds: { id: 'integer', ...Object.fromEntries(names.map(name => [name, 'text'])) },
    nullable: Object.fromEntries(['id', ...names].map(name => [name, false])) });
  const assignments = parts(CAP - 1).map((value, index) => ({ column: names[index], value }));
  const model = id => queryModel.update({ table, assignments, where: { kind: 'compare', column: 'id', operator: '=', values: [id] } });
  const compiled = compilePostgres(model(1)); assert.equal(compiled.command, 'UPDATE');
  assert.equal(wireBytes(compiled.parameters), CAP); assert.equal(compiled.parameters.at(-1), '1');
  assert.throws(() => compilePostgres(model(10)), refused);
});

test('root aggregate predicates share the byte budget without an invented page allowance', () => {
  const model = values => queryModel.aggregate({ table: mapped, select: [{ alias: 'total', operation: 'count' }], where: where(values) });
  const compiled = compilePostgres(model(parts(CAP))); assert.equal(compiled.aggregate.mode, 'aggregate');
  assert.equal(compiled.parameters.length, 16); assert.equal(wireBytes(compiled.parameters), CAP);
  assert.throws(() => compilePostgres(model(parts(CAP + 1))), refused);
});

const roots = defineTable('parameter_roots', { id: column.integer().primaryKey(), key: column.text() });
const leaves = defineTable('parameter_leaves', { id: column.integer().primaryKey(), rootId: column.integer(), key: column.text(), label: column.text() });
function context(native = true) {
  const dialect = createPostgresDialect(), requests = [], tables = new Map([roots, leaves].map(table => [table.name, table]));
  const ctx = { check() {}, writeCheck() {}, tables, mapped(table) { assert.equal(tables.get(table.name), table); },
    ...(native ? { dialect: { ...dialect, compile(model) { const query = dialect.compile(model); requests.push(model.kind); return query; } } } : {}) };
  return { core: new RepositoryCore(ctx, roots), requests };
}
const relation = (factory, options = {}) => factory(leaves, { localKey: roots.col('id'), foreignKey: leaves.col('rootId'), ...options });

test('oversized child filters refuse before root compilation for every include kind, zero limit and empty-root predicate', () => {
  const oversized = inArray(leaves.col('label'), parts(CAP + 1));
  for (const factory of [hasMany, hasOne, belongsTo]) for (const options of [{ limit: 0 }, { where: eq(roots.col('id'), 999) }]) {
    const { core, requests } = context();
    assert.throws(() => core.findMany({ ...options, include: { leaf: relation(factory, { where: oversized }) } }), refused);
    assert.deepEqual(requests, [], 'A known oversized child predicate must refuse before a root request can be compiled.');
  }
});

test('deep child filters are preflighted beneath zero child limits, without imposing the native cap on SQLite planning', () => {
  const oversized = inArray(leaves.col('label'), parts(CAP + 1));
  const leaf = relation(hasMany, { where: oversized });
  const owner = belongsTo(roots, { localKey: leaves.col('rootId'), foreignKey: roots.col('id'), include: { leaf } });
  const include = { leaf: relation(hasMany, { limit: 0, include: { owner } }) };
  const { core, requests } = context(); assert.throws(() => core.findMany({ limit: 0, include }), refused); assert.deepEqual(requests, []);
  assert.doesNotThrow(() => context(false).core.selectPlan({ limit: 0, include }));
});

test('actual decoded source keys, child filters and all three relation bounds share one byte budget', () => {
  // Two distinct one-MiB source keys, fourteen filter values, then "0", "2", "10001" (seven bytes).
  const keys = ['A' + ascii.slice(1), 'B' + ascii.slice(1)];
  const run = excess => {
    const { core, requests } = context();
    const leaf = hasMany(leaves, { localKey: roots.col('key'), foreignKey: leaves.col('key'), select: ['label'], limit: 2,
      where: inArray(leaves.col('label'), parts(14 * MiB - 7 + excess)) });
    const work = core.findMany({ select: ['id'], limit: 2, include: { leaf } });
    assert.deepEqual(requests, [], 'Planning uses placeholder source keys and must not pretend to know actual root values.');
    const root = work.next(); assert.equal(root.done, false);
    const storage = root.value.decode({ command: 'SELECT', rowCount: 2n,
      fields: [{ name: '__rs_pg_0', typeOid: 23 }, { name: '__rs_pg_1', typeOid: 25 }], rows: [['1', keys[0]], ['2', keys[1]]] });
    if (excess) { assert.throws(() => work.next(storage), refused); assert.deepEqual(requests, ['select']); return; }
    const child = work.next(storage); assert.equal(child.done, false);
    assert.deepEqual(child.value.parameters.slice(0, 2), keys); assert.deepEqual(child.value.parameters.slice(-3), ['0', '2', '10001']);
    assert.equal(wireBytes(child.value.parameters), CAP); assert.deepEqual(requests, ['select', 'relation']);
    const empty = child.value.decode({ command: 'SELECT', rowCount: 0n, rows: [], fields: [25, 25, 20, 20].map((typeOid, index) => ({ name: '__rs_pg_' + index, typeOid })) });
    assert.deepEqual(work.next(empty), { done: true, value: [{ id: 1, leaf: [] }, { id: 2, leaf: [] }] });
  };
  run(0); run(1);
});
