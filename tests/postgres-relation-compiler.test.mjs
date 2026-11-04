import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePostgres } from '../dist/core/postgres-compiler.js';
import { queryModel, tableModel } from '../dist/core/query-model.js';
import { createPostgresDialect } from '../dist/core/postgres-dialect.js';

const mapped = (kind = 'bigint') => tableModel({ name: 'eager_children', columns: ['id', 'parentId', 'label', 'doc'], primaryKey: ['id'],
  kinds: { id: 'integer', parentId: kind, label: 'text', doc: 'json' }, nullable: { id: false, parentId: true, label: true, doc: true } });
const relation = (overrides = {}) => queryModel.relation({ table: mapped(), columns: ['id', 'parentId', 'label'], partitionBy: 'parentId',
  keys: [1], orderBy: [{ column: 'id', direction: 'ASC' }], offset: 0, limit: 2, readLimit: 101, ...overrides });
const code = (...codes) => error => codes.includes(error?.code) && !error.message.includes('PRIVATE_KEY_VALUE') && !error.cause;

test('native relation binding accepts either exact integer source representation for either numeric target kind', () => {
  for (const kind of ['integer', 'bigint']) {
    const keys = [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, -(2n ** 63n), 2n ** 63n - 1n];
    const q = compilePostgres(relation({ table: mapped(kind), keys }));
    assert.deepEqual(q.parameters, keys.map(String).concat(['0', '2', '101']));
    assert.deepEqual(q.relation.keys, keys.map(BigInt));
    assert.equal(q.relation.partitionBy, 'parentId');
    assert.equal(q.relation.correlateKeys, false);
    assert.equal(q.command, 'SELECT');
    assert.equal(q.count, undefined); assert.equal(q.aggregate, undefined);
    assert.ok(Object.isFrozen(q.relation) && Object.isFrozen(q.relation.keys) && Object.isFrozen(q.relation.outputs));
    assert.match(q.sql, /OPERATOR\("pg_catalog"\.=\) ANY \(ARRAY\[/);
    assert.ok(!q.sql.includes(String(2n ** 63n - 1n)));
  }
});

test('text windows carry a separate int8 ordinal for each source key without ordinal bindings', () => {
  const keys = ['PRIVATE_KEY_VALUE\'\"\\%_', 'é', 'e\u0301'];
  const q = compilePostgres(relation({ table: mapped('text'), keys, correlateKeys: true }));
  assert.deepEqual(q.parameters, [...keys, '0', '2', '101']);
  assert.deepEqual(q.relation.keys, keys);
  assert.equal(q.parameters.length, keys.length + 3);
  assert.match(q.sql, /PARTITION BY "__rs_pg_keys"\."__rs_ordinal"/);
  assert.match(q.sql, /'2'::"pg_catalog"\."int8"/);
  assert.match(q.sql, /"__rs_pg_root"\."parentId" OPERATOR\("pg_catalog"\.=\) "__rs_pg_keys"\."__rs_key"/);
  assert.ok(!q.sql.includes('PRIVATE_KEY_VALUE') && !q.sql.includes('COLLATE'));
});

test('page bounds and rank comparisons stay qualified bindings even at zero and the maximum offset', () => {
  const q = compilePostgres(relation({ offset: 1_000_000_000, limit: 0, readLimit: 10001 }));
  assert.deepEqual(q.parameters.slice(-3), ['1000000000', '1000000000', '10001']);
  assert.match(q.sql, /"pg_catalog"\."row_number"\(\) OVER/);
  assert.match(q.sql, /OPERATOR\("pg_catalog"\.>\)/);
  assert.match(q.sql, /OPERATOR\("pg_catalog"\.<=\)/);
  assert.deepEqual(q.relation.outputs.map(x => x.property), ['id', 'parentId', 'label']);
  assert.equal(q.relation.readLimit, 10001);
});

test('native relation scopes retain schema/ONLY policy, ordering and hidden partition fields', () => {
  const q = compilePostgres(relation({ columns: ['label', 'parentId', 'doc'], orderBy: [{ column: 'label', direction: 'DESC' }, { column: 'doc', direction: 'ASC' }] }), { schema: 'eager_space', only: true });
  assert.match(q.sql, /FROM ONLY "eager_space"\."eager_children" AS "__rs_pg_root"/);
  assert.match(q.sql, /"label" DESC NULLS LAST/);
  assert.match(q.sql, /"doc"::"pg_catalog"\."jsonb" ASC NULLS FIRST/);
  assert.match(q.sql, /ORDER BY "__rs_pg_window"\."__rs_pg_1" ASC, "__rs_pg_window"\."__rs_pg_3" ASC LIMIT/);
  assert.deepEqual(q.outputs, q.relation.outputs);
  assert.ok(!q.outputs.some(x => x.property === '__rs_parent' || x.property === '__rs_rank'));
});

test('relation predicate bindings follow key bindings and share the actual 10403 physical boundary', () => {
  const values = Array.from({ length: 10000 }, (_, i) => i);
  const keys = Array.from({ length: 400 }, (_, i) => i + 1);
  const q = compilePostgres(relation({ keys, where: { kind: 'compare', column: 'id', operator: 'IN', values } }));
  assert.equal(q.parameters.length, 10403);
  assert.deepEqual(q.parameters.slice(0, 400), keys.map(String));
  assert.deepEqual(q.parameters.slice(400, 10400), values.map(String));
  assert.deepEqual(q.parameters.slice(-3), ['0', '2', '101']);
  assert.match(q.sql, /LIMIT \$10403::"pg_catalog"\."int8"$/);
  assert.throws(() => compilePostgres(relation({ keys: [...keys, 401] })), code('QUERY'));
  assert.throws(() => compilePostgres(relation({ where: { kind: 'compare', column: 'id', operator: 'IN', values: [...values, 10000] } })), code('QUERY'));
});

test('text parent ordinals do not consume the caller predicate or physical binding budget', () => {
  const keys = Array.from({ length: 400 }, (_, i) => 'p' + i);
  const q = compilePostgres(relation({ table: mapped('text'), keys, correlateKeys: true,
    where: { kind: 'compare', column: 'id', operator: 'IN', values: Array.from({ length: 10000 }, (_, i) => i) } }));
  assert.equal(q.parameters.length, 10403);
  assert.match(q.sql, /'399'::"pg_catalog"\."int8"/);
});

test('the UTF8 key budget also reserves space for generated parameters in the total request budget', () => {
  const size = 1_048_576;
  const keys = Array.from({ length: 16 }, (_, i) => String.fromCharCode(65 + i).repeat(size));
  // Generated offset/end/read-limit are '0', '2', '101': five more UTF-8 payload bytes.
  const exact = [...keys.slice(0, -1), keys.at(-1).slice(0, -5)];
  const compiled = compilePostgres(relation({ table: mapped('text'), keys: exact, correlateKeys: true }));
  assert.equal(compiled.parameters.length, 19);
  assert.equal(compiled.parameters.reduce((bytes, value) => bytes + Buffer.byteLength(value ?? '', 'utf8'), 0), 16 * size);
  assert.throws(() => compilePostgres(relation({ table: mapped('text'), keys, correlateKeys: true })), code('QUERY'));
  assert.throws(() => compilePostgres(relation({ table: mapped('text'), keys: [...keys, 'x'], correlateKeys: true })), code('RESULT_LIMIT'));
  assert.throws(() => compilePostgres(relation({ table: mapped('text'), keys: Array(6).fill('€'.repeat(size)), correlateKeys: true })), code('RESULT_LIMIT'));
});

test('unsupported partition modes and non-lossless source keys never become implicit SQL coercions', () => {
  for (const kind of ['real', 'boolean', 'json', 'text']) assert.throws(() => compilePostgres(relation({ table: mapped(kind) })), code('QUERY'));
  for (const key of [1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 63n, -(2n ** 63n) - 1n, 'PRIVATE_KEY_VALUE'])
    assert.throws(() => compilePostgres(relation({ keys: [key] })), code('VALIDATION', 'QUERY'));
  for (const key of ['PRIVATE_KEY_VALUE\0', '\ud800', '\udfff', 'x'.repeat(1_048_577)])
    assert.throws(() => compilePostgres(relation({ table: mapped('text'), keys: [key], correlateKeys: true })), code('VALIDATION', 'QUERY'));
});

test('the native dialect supports eager reads and decodes their closed relation framing', () => {
  const dialect = createPostgresDialect();
  assert.equal(dialect.supportsIncludes, true);
  const compiled = dialect.compile(relation());
  const raw = { command: 'SELECT', rowCount: 1n, fields: [
    { name: '__rs_pg_0', typeOid: 23 }, { name: '__rs_pg_1', typeOid: 20 },
    { name: '__rs_pg_2', typeOid: 25 }, { name: '__rs_pg_3', typeOid: 20 },
  ], rows: [['2', '1', null, '1']] };
  assert.deepEqual(compiled.decode(raw), [{ id: 2n, parentId: 1n, label: null }]);
});
