import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A controlled transport, not a database-engine proof. Compilation, native result decoding/provenance,
// shared Core, async-session bookkeeping, logical codecs and materialization are the actual implementations.
const build = process.env.ROWSTITCH_TEST_DIST ? pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST) + '/') : new URL('../dist/', import.meta.url);
const { column, defineTable, hasMany, agg } = await import(new URL('index.js', build));
const { openAsyncDatabaseWithDialect } = await import(new URL('core/async-database.js', build));
const { RepositoryCore } = await import(new URL('core/repository-core.js', build));
const { createPostgresDialect } = await import(new URL('core/postgres-dialect.js', build));
const { compilePostgres } = await import(new URL('core/postgres-compiler.js', build));
const { createNativeGraphResources, NATIVE_GRAPH_LIMITS } = await import(new URL('core/graph-resources.js', build));
const { isPostgresRawResult, snapshotPostgresResult } = await import(new URL('core/postgres-result.js', build));

const parents = defineTable('meter_parents', { id: column.integer().primaryKey(), code: column.text(), name: column.text() });
const children = defineTable('meter_children', { id: column.integer().primaryKey(), parentCode: column.text(), payload: column.json(), amount: column.bigint() });
const child = hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['payload'], limit: 1 });
const summaryDomain = hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode') });
const SUM = 18_446_744_073_709_551_614n; // Two physical int64 MAX amounts; included page returns just the first child.
const JSON_TEXT = '{"n":1}';
const options = { select: ['name'], include: { left: child, right: child }, aggregates: { total: agg.related(summaryDomain, agg.sum(children.col('amount'))) } };
const expectCode = code => error => { assert.equal(error?.code, code); assert.equal(error.cause, undefined); return true; };

// Hand ledger for the fixed two-root/two-alias fixture. No costs are read from the implementation.
// Root source: record32 + name42 + code48 + id38 + high80 + low80 + guard60 =380 per root.
// Projected source/copy: record32 + total(26 property +56 bigint) =114 per root.
// Child source: record32 + payload60 + parentCode60 + __rs_parent56 =208 per response.
// Each child JSON {n:1} adds66 at attach. Every detached child copy is record32 + payload96 =128.
const LEDGER = Object.freeze({
  source: 2 * 380 + 2 * 114 + 2 * (208 + 66),
  rootArray: 48, rootCopies: 2 * 74, aliases: 2 * (64 + 66), childCopies: 4 * 128, projectedCopies: 2 * 114,
  units: 2732,
  // Four nine-byte aliases, JSON7, key4, rank1, ordinal1 =49 per response.
  wire: 98,
});
assert.equal(LEDGER.source + LEDGER.rootArray + LEDGER.rootCopies + LEDGER.aliases + LEDGER.childCopies + LEDGER.projectedCopies, LEDGER.units);

const oid = kind => ({ integer: 23, bigint: 20, real: 701, text: 25, boolean: 16, json: 114 })[kind];
const response = (fields, rows) => snapshotPostgresResult({ command: 'SELECT', rowCount: BigInt(rows.length), fields, rows });
const countResponse = () => response([{ name: '__rs_pg_count', typeOid: 20 }], [['2']]);

async function fixture(t, { units = LEDGER.units, wireBytes = LEDGER.wire, roots, projected = true, instrument } = {}) {
  const rootRows = roots ?? [{ id: 1, code: 'same', name: 'A' }, { id: 2, code: 'same', name: 'B' }];
  const compiled = new Map(), calls = [], controls = [], meters = [], wires = [];
  const base = createPostgresDialect({ schema: 'meter_fixture' });
  let active = false, closed = false;
  const dialect = {
    ...base,
    createGraphResources() {
      const meter = createNativeGraphResources({ units, wireBytes });
      const index = meters.length; meters.push(meter);
      return instrument ? instrument(meter, index) : meter;
    },
    relatedWireBytes(rows) { const bytes = base.relatedWireBytes(rows); wires.push(bytes); return bytes; },
    compile(model) {
      const plan = compilePostgres(model, { schema: 'meter_fixture' });
      const query = base.compile(model); compiled.set(query.sql, { model, plan }); return query;
    },
  };
  const executor = {
    async all(sql, parameters) {
      const entry = compiled.get(sql); assert.ok(entry, 'Only actual compiled fixture requests are accepted');
      const { model, plan } = entry; calls.push({ model, parameters: [...parameters] });
      if (plan.count) return countResponse();
      if (plan.relation) {
        const p = plan.relation;
        assert.equal(p.correlateKeys, true);
        assert.deepEqual(p.outputs.map(field => field.property), ['payload', 'parentCode']);
        const fields = p.outputs.map(field => ({ name: field.alias, typeOid: oid(field.kind) }));
        fields.push({ name: '__rs_pg_2', typeOid: 20 }, { name: '__rs_pg_3', typeOid: 20 });
        return response(fields, [[JSON_TEXT, p.keys[0], '1', '0']]);
      }
      assert.equal(model.kind, 'select');
      if (plan.aggregate) {
        assert.equal(projected, true); assert.equal(plan.aggregate.mode, 'projected');
        assert.deepEqual(plan.aggregate.fields.map(field => field.kind), ['mapped', 'mapped', 'mapped', 'integer-sum', 'guard']);
        assert.deepEqual(plan.aggregate.fields.filter(field => field.kind === 'mapped').map(field => field.target), ['name', 'code', 'id']);
        assert.equal(plan.aggregate.fields[3].high, '__rs_ragg_hi_0');
        assert.equal(plan.aggregate.fields[3].low, '__rs_ragg_lo_0');
        assert.equal(plan.aggregate.fields[4].target, '__rs_ragg_bad');
        const fields = plan.aggregate.fields.map(field => ({ name: field.alias, typeOid: field.kind === 'mapped'
          ? field.canonical && field.storageKind === 'integer' ? 20 : oid(field.storageKind) : field.kind === 'integer-sum' ? 1700 : 23 }));
        return response(fields, rootRows.map(row => [row.name, row.code, String(row.id), String(SUM), '0']));
      }
      return response(plan.outputs.map(field => ({ name: field.alias, typeOid: oid(field.kind) })), rootRows.map(row => plan.outputs.map(field => String(row[field.property]))));
    },
    async exec(sql) { controls.push(sql); if (sql.startsWith('BEGIN')) active = true; else if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false; },
    async inTransaction() { return active; }, async close() { closed = true; },
  };
  const db = await openAsyncDatabaseWithDialect(executor, { tables: [parents, children] }, {
    dialect, sessionDialect: 'postgresql', isResult: isPostgresRawResult, inspectSchema: function* () { return []; },
  });
  t.after(() => db.close());
  return { db, dialect, calls, controls, meters, wires, get closed() { return closed; } };
}
const expected = () => ['A', 'B'].map(name => ({ name, left: [{ payload: { n: 1 } }], right: [{ payload: { n: 1 } }], total: SUM }));

test('Core exactly charges roots, hidden keys, two aliases, detached JSON and a projected sum beyond int64', async t => {
  const f = await fixture(t), result = await f.db.table(parents).findMany(options);
  assert.deepEqual(result, expected()); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.wires, [49, 49]); assert.equal(f.meters.length, 1);
  assert.equal(f.calls[1].parameters.filter(value => value === 'same').length, 1, 'shared parent key is queried once per alias');
  assert.equal(f.calls[2].parameters.filter(value => value === 'same').length, 1);
  assert.ok(result[0].total > 9223372036854775807n);
  assert.notEqual(result[0].left, result[1].left); assert.notEqual(result[0].left, result[0].right);
  assert.notEqual(result[0].left[0].payload, result[1].left[0].payload);
  result[0].left[0].payload.n = 9;
  assert.equal(result[1].left[0].payload.n, 1); assert.equal(result[0].right[0].payload.n, 1);
});
test('one unit below the independent whole-Core ledger rejects without a partial graph', async t => {
  const f = await fixture(t, { units: LEDGER.units - 1 });
  await assert.rejects(f.db.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
  assert.equal(f.calls.length, 3); assert.deepEqual(f.wires, [49, 49]);
});
test('Core reserves a JSON copy before structuredClone and permits exactly the first copy at its boundary', async t => {
  const beforeFirst = LEDGER.source + LEDGER.rootArray + 74 + 64;
  const tooSmall = await fixture(t, { units: beforeFirst + 128 - 1 });
  const exactFirst = await fixture(t, { units: beforeFirst + 128 });
  const original = globalThis.structuredClone; let clones = 0;
  globalThis.structuredClone = (...args) => { clones++; return original(...args); };
  try {
    await assert.rejects(tooSmall.db.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
    assert.equal(clones, 0, 'first rejected copy must never reach structuredClone');
    await assert.rejects(exactFirst.db.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
    assert.equal(clones, 1, 'one reserved copy succeeds; the next alias is refused before a second clone');
  } finally { globalThis.structuredClone = original; }
});
test('cumulative two-alias wire failure precedes shared logical JSON decoding of the second response', async t => {
  const f = await fixture(t, { units: NATIVE_GRAPH_LIMITS.units, wireBytes: LEDGER.wire - 1 });
  const original = JSON.parse; let parses = 0;
  JSON.parse = function (value, ...rest) { if (value === JSON_TEXT) parses++; return original.call(this, value, ...rest); };
  try {
    await assert.rejects(f.db.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
    assert.equal(parses, 3, 'native validation parses both responses; shared Core only decodes the first');
    assert.deepEqual(f.wires, [49, 49]);
  } finally { JSON.parse = original; }
});
test('real 400-key batching shares one cumulative wire ledger across both child responses', async t => {
  const roots = Array.from({ length: 401 }, (_, i) => ({ id: i + 1, code: 'p' + String(i).padStart(3, '0'), name: 'N' + i }));
  const query = { select: ['name'], limit: 401, include: { left: child } };
  const pass = await fixture(t, { roots, projected: false, units: NATIVE_GRAPH_LIMITS.units });
  const rows = await pass.db.table(parents).findMany(query);
  assert.equal(rows.length, 401); assert.equal(rows[0].left.length, 1); assert.equal(rows[400].left.length, 1);
  assert.equal(rows[1].left.length, 0); assert.deepEqual(pass.wires, [49, 49]);
  assert.deepEqual(pass.calls.slice(1).map(call => call.model.keys.length), [400, 1]);
  const fail = await fixture(t, { roots, projected: false, units: NATIVE_GRAPH_LIMITS.units, wireBytes: LEDGER.wire - 1 });
  const original = JSON.parse; let parses = 0;
  JSON.parse = function (value, ...rest) { if (value === JSON_TEXT) parses++; return original.call(this, value, ...rest); };
  try {
    await assert.rejects(fail.db.table(parents).findMany(query), expectCode('RESULT_LIMIT'));
    assert.equal(parses, 3); assert.equal(fail.calls.length, 3);
  } finally { JSON.parse = original; }
});
test('Core source admission happens before child logical JSON parse and later graph requests', async t => {
  const f = await fixture(t, { units: 1 });
  const original = JSON.parse; let parses = 0;
  JSON.parse = function (value, ...rest) { if (value === JSON_TEXT) parses++; return original.call(this, value, ...rest); };
  try {
    await assert.rejects(f.db.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
    assert.equal(parses, 0); assert.equal(f.calls.length, 1); assert.deepEqual(f.wires, []);
  } finally { JSON.parse = original; }
});
test('each sequential and concurrent public graph call receives an independent exact-limit meter', async t => {
  const f = await fixture(t), repo = f.db.table(parents);
  const result = await Promise.all([repo.findMany(options), repo.findMany(options)]);
  assert.deepEqual(result, [expected(), expected()]);
  assert.equal(f.meters.length, 2); assert.equal(new Set(f.meters).size, 2);
  assert.deepEqual(await repo.findMany(options), expected());
  assert.equal(f.meters.length, 3); assert.equal(new Set(f.meters).size, 3);
  assert.equal(f.calls.length, 9);
});
test('local graph limits leave idle counts healthy and a caught transaction can still COMMIT', async t => {
  const f = await fixture(t, { units: LEDGER.units - 1 }), repo = f.db.table(parents);
  await assert.rejects(repo.findMany(options), expectCode('RESULT_LIMIT'));
  assert.equal(await repo.count(), 2);
  await f.db.transaction(async tx => {
    await assert.rejects(tx.table(parents).findMany(options), expectCode('RESULT_LIMIT'));
    assert.equal(await tx.table(parents).count(), 2);
  });
  assert.deepEqual(f.controls, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT']);
  assert.equal(await repo.count(), 2);
});
test('native no-include and ordinary SQLite planning create no graph meter', async t => {
  const f = await fixture(t, { units: 0, wireBytes: 0, projected: false });
  assert.deepEqual(await f.db.table(parents).findMany({ select: ['name'] }), [{ name: 'A' }, { name: 'B' }]);
  assert.equal(f.meters.length, 0);
  const tables = new Map([[parents.name, parents], [children.name, children]]);
  const core = new RepositoryCore({ check() {}, writeCheck() {}, mapped(table) { assert.equal(tables.get(table.name), table); }, tables }, parents);
  const work = core.findMany({ select: ['name'], include: { left: child } });
  assert.equal(work.next().value.operation, 'select');
});
test('invalid class-Proxy and array includes reject before ownKeys on SQLite and native planning', async t => {
  const f = await fixture(t), tables = new Map([[parents.name, parents], [children.name, children]]);
  const core = new RepositoryCore({ check() {}, writeCheck() {}, mapped() {}, tables }, parents);
  class InvalidInclude {}
  for (const native of [false, true]) {
    let ownKeys = 0;
    const include = new Proxy(new InvalidInclude(), { ownKeys() { ownKeys++; throw new Error('FICTIONAL_UNEXPECTED_INCLUDE_TRAP'); } });
    if (native) await assert.rejects(f.db.table(parents).findMany({ include }), expectCode('VALIDATION'));
    else assert.throws(() => core.findMany({ include }), expectCode('VALIDATION'));
    assert.equal(ownKeys, 0);
    if (native) await assert.rejects(f.db.table(parents).findMany({ include: [] }), expectCode('VALIDATION'));
    else assert.throws(() => core.findMany({ include: [] }), expectCode('VALIDATION'));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.meters.length, 0);
});
