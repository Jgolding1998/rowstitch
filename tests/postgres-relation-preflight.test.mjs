import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryCore } from '../dist/core/repository-core.js';
import { createPostgresDialect } from '../dist/core/postgres-dialect.js';
import { column, defineTable } from '../dist/core/schema.js';
import { belongsTo, hasMany, hasOne, eq, contains } from '../dist/core/predicates.js';

const parents = defineTable('preflight_parents', { id: column.integer().primaryKey(), code: column.text() });
const children = defineTable('preflight_children', { id: column.integer().primaryKey(), parentId: column.bigint(), label: column.text(), doc: column.json() });
const context = (native = true) => {
  const preflights = [], requests = [], dialect = createPostgresDialect();
  const tables = new Map([parents, children].map(table => [table.name, table]));
  const ctx = { check() {}, writeCheck() {}, tables, mapped(table) { assert.equal(tables.get(table.name), table); },
    ...(native ? { dialect: { ...dialect, supportsIncludes: true,
      preflightRelation(model) { preflights.push(model); dialect.preflightRelation(model); },
      compile(model) { requests.push(model.kind); return dialect.compile(model); } } } : {}) };
  return { core: new RepositoryCore(ctx, parents), preflights, requests };
};
const childRelation = (factory, options = {}) => factory(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), ...options });
const refused = error => error?.code === 'VALIDATION' && !error.message.includes('PRIVATE_FILTER') && !error.cause;

test('known native child wire refusals occur during planning for every include kind and root limit zero', () => {
  const filters = [eq(children.col('label'), 'PRIVATE_FILTER\0'), contains(children.col('label'), 'PRIVATE_FILTER\0'), eq(children.col('doc'), { value: 'PRIVATE_FILTER\0' })];
  for (const factory of [hasMany, hasOne, belongsTo]) for (const where of filters) {
    const { core, requests, preflights } = context();
    assert.throws(() => core.selectPlan({ limit: 0, include: { rows: childRelation(factory, { where }) } }), refused);
    assert.equal(requests.length, 0, 'root request was compiled before child wire refusal');
    assert.equal(preflights.length, 1);
  }
});

test('a deeply nested child filter is preflighted even under zero child limits', () => {
  const { core, requests } = context();
  const leaf = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: eq(children.col('label'), 'PRIVATE_FILTER\0') });
  const owner = belongsTo(parents, { localKey: children.col('parentId'), foreignKey: parents.col('id'), include: { leaf } });
  const rows = childRelation(hasMany, { limit: 0, include: { owner } });
  assert.throws(() => core.selectPlan({ include: { rows } }), refused);
  assert.equal(requests.length, 0);
});

test('valid native preflight keys are placeholders; an empty root emits no child request', () => {
  const { core, preflights, requests } = context();
  const work = core.findMany({ include: { rows: childRelation(hasMany, { select: ['label'], where: eq(children.col('label'), 'valid 🌲') }) } });
  assert.equal(preflights.length, 1);
  assert.deepEqual(preflights[0].keys, [0n]);
  assert.ok(preflights[0].columns.includes('parentId'));
  assert.equal(requests.length, 0);
  const first = work.next();
  assert.equal(first.done, false);
  assert.deepEqual(requests, ['select']);
  assert.deepEqual(work.next([]), { done: true, value: [] });
  assert.deepEqual(requests, ['select']);
});

test('the optional native preflight hook does not change SQLite acceptance of stored NUL text', () => {
  const { core } = context(false);
  assert.doesNotThrow(() => core.selectPlan({ limit: 0, include: { rows: childRelation(hasMany, { where: eq(children.col('label'), 'PRIVATE_FILTER\0') }) } }));
});

test('populated nested loading compiles actual requests without repeating captured whole-tree native preflight', () => {
  const { core, preflights, requests } = context();
  const owner = belongsTo(parents, { localKey: children.col('parentId'), foreignKey: parents.col('id') });
  const work = core.findMany({ include: { rows: childRelation(hasMany, { include: { owner } }) } });
  assert.equal(preflights.length, 2);
  const decode = (step, oids, rows) => step.value.decode({ command: 'SELECT', rowCount: BigInt(rows.length), rows,
    fields: oids.map((typeOid, i) => ({ name: '__rs_pg_' + i, typeOid })) });
  const rootStep = work.next();
  assert.equal(rootStep.done, false);
  const childStep = work.next(decode(rootStep, [23, 25], [['1', 'one']]));
  assert.equal(childStep.done, false);
  const ownerStep = work.next(decode(childStep, [23, 20, 25, 114, 20], [['3', '1', 'child', '{}', '1']]));
  assert.equal(ownerStep.done, false);
  const result = work.next(decode(ownerStep, [23, 25, 20], [['1', 'one', '1']]));
  assert.deepEqual(result, { done: true, value: [{ id: 1, code: 'one', rows: [
    { id: 3, parentId: 1n, label: 'child', doc: {}, owner: { id: 1, code: 'one' } },
  ] }] });
  assert.equal(preflights.length, 2, 'load-time descendant validation recompiled already captured native preflights');
  assert.deepEqual(requests, ['select', 'relation', 'relation']);
});
