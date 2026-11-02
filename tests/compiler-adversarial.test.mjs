import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { queryModel, tableModel, predicateModel, orderingModel, predicateTruth } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate, compileSqliteOrder } from '../dist/core/sqlite-compiler.js';
import { RowstitchError } from '../dist/core/errors.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const modelError = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA', 'UNSAFE_WRITE'].includes(error.code);
const table = () => tableModel({ name: 'records', columns: ['id', 'tenantId', 'name', 'enabled', 'version'], primaryKey: ['id'], version: 'version' });
const compare = (column, value, operator = '=') => ({ kind: 'compare', column, operator, values: [value] });
const select = (changes = {}) => queryModel.select({ table: table(), columns: ['name'], orderBy: [{ column: 'id', direction: 'ASC' }], limit: 25, offset: 3, ...changes });
const definition = (name, kind, changes = {}) => ({ name, kind, nullable: false, primary: name === 'id', generated: false, unique: false, hasDefault: false, ...changes });

test('the internal compiler imports and compiles without SQLite or IO module dependencies', () => {
  const modelURL = new URL('../dist/core/query-model.js', import.meta.url).href;
  const compilerURL = new URL('../dist/core/sqlite-compiler.js', import.meta.url).href;
  const script = `
    import { registerHooks, isBuiltin } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (isBuiltin(specifier)) throw new Error('Unexpected compiler dependency: ' + specifier);
      return next(specifier, context);
    } });
    const m = await import(${JSON.stringify(modelURL)});
    const c = await import(${JSON.stringify(compilerURL)});
    const table = m.tableModel({ name: 'records', columns: ['id', 'name'], primaryKey: ['id'] });
    const result = c.compileSqlite(m.queryModel.select({ table, columns: ['name'], where: { kind: 'compare', column: 'id', operator: '=', values: [7] }, orderBy: [], limit: 1, offset: 0 }));
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.parameters, [7, 1, 0]);
  assert.ok(result.sql.startsWith('SELECT'));
});

test('SQL-looking text, question marks, NUL and Unicode remain exact bound values', () => {
  const values = [
    "M2_VALUE_839'); DROP TABLE records; --", 'M2_VALUE_839 ? ?1 :named $named',
    'M2_VALUE_839 "quoted" \\ backslash', 'M2_VALUE_839\0after-null',
    'M2_VALUE_839 🧵 café Ελληνικά 日本語', 'M2_VALUE_839\r\n-- comment /* not syntax */',
  ];
  for (const value of values) {
    const output = compileSqlite(select({ where: compare('name', value) }));
    assert.deepEqual(output.parameters, [value, 25, 3]);
    assert.ok(!output.sql.includes('M2_VALUE_839'));
    assert.ok(!output.sql.includes('\0'));
    assert.equal((output.sql.match(/\?/g) ?? []).length, output.parameters.length);
  }
});

test('nested filters and NULL IN semantics preserve placeholder ordering and truth', () => {
  const t = table();
  const input = { kind: 'logic', operator: 'AND', children: [
    compare('tenantId', 71),
    { kind: 'logic', operator: 'OR', children: [
      { kind: 'compare', column: 'name', operator: 'IN', values: [null, 'first ? value', "second ' value", null] },
      { kind: 'not', child: compare('enabled', 1, '<>') },
    ] },
    compare('version', 4, '>='),
  ] };
  const predicate = predicateModel(t, input);
  const compiled = compileSqlitePredicate(t, predicate);
  assert.deepEqual(compiled.parameters, [71, 'first ? value', "second ' value", 1, 4]);
  assert.ok(compiled.sql.includes('IS NULL'));
  assert.equal(compiled.truth, null);
  assert.deepEqual(compileSqlite(select({ where: predicate })).parameters, [...compiled.parameters, 25, 3]);
  assert.deepEqual(compileSqlite(queryModel.count({ table: t, where: predicate })).parameters, compiled.parameters);
  assert.deepEqual(compileSqlitePredicate(t, compare('name', null)).parameters, []);
  assert.ok(compileSqlitePredicate(t, compare('name', null, '<>')).sql.includes('IS NOT NULL'));
  const empty = predicateModel(t, { kind: 'compare', column: 'name', operator: 'IN', values: [] });
  assert.equal(predicateTruth(empty), false);
  assert.deepEqual(compileSqlitePredicate(t, empty), { sql: '0', parameters: [], truth: false });
  assert.equal(predicateTruth(predicateModel(t, { kind: 'logic', operator: 'AND', children: [] })), true);
});

test('insert, guarded version updates and deletes bind values in semantic order', () => {
  const t = table();
  const where = { kind: 'logic', operator: 'AND', children: [compare('id', 41), compare('version', 7)] };
  const inserted = compileSqlite(queryModel.insert({ table: t, columns: ['name', 'enabled', 'tenantId'], values: ['M2_INSERT_839', 1, 71] }));
  assert.deepEqual(inserted.parameters, ['M2_INSERT_839', 1, 71]);
  assert.ok(!inserted.sql.includes('M2_INSERT_839'));
  const updated = compileSqlite(queryModel.update({ table: t, assignments: [{ column: 'name', value: 'M2_UPDATE_839' }, { column: 'enabled', value: 0 }], where }));
  assert.deepEqual(updated.parameters, ['M2_UPDATE_839', 0, 41, 7]);
  assert.match(updated.sql, /"version"\s*=\s*"version"\s*\+\s*1/);
  assert.ok(!updated.sql.includes('M2_UPDATE_839'));
  assert.deepEqual(compileSqlite(queryModel.delete({ table: t, where })).parameters, [41, 7]);
  const defaults = compileSqlite(queryModel.insert({ table: t, columns: [], values: [] }));
  assert.ok(defaults.sql.includes('DEFAULT VALUES'));
  assert.deepEqual(defaults.parameters, []);
});

test('relation windows bind keys, filter values, rank bounds and read limit in that order', () => {
  const output = compileSqlite(queryModel.relation({
    table: table(), columns: ['tenantId', 'name'], partitionBy: 'tenantId', keys: [11n, 12n],
    where: { kind: 'logic', operator: 'AND', children: [compare('enabled', 1), compare('name', 'M2_RELATION_839')] },
    orderBy: [{ column: 'id', direction: 'DESC' }], offset: 2, limit: 3, readLimit: 21,
  }));
  assert.deepEqual(output.parameters, [11n, 12n, 1, 'M2_RELATION_839', 2, 5, 21]);
  assert.ok(output.sql.includes('ROW_NUMBER() OVER'));
  assert.ok(output.sql.includes('PARTITION BY "tenantId"'));
  assert.ok(!output.sql.includes('M2_RELATION_839'));
  assert.equal((output.sql.match(/\?/g) ?? []).length, output.parameters.length);
});

test('EXPLAIN wraps only a validated SELECT and preserves its bound values', () => {
  const source = select({ where: compare('name', 'M2_EXPLAIN_839') });
  const plain = compileSqlite(source);
  assert.deepEqual(compileSqlite(queryModel.explain({ query: source })), { sql: 'EXPLAIN QUERY PLAN ' + plain.sql, parameters: plain.parameters });
  for (const query of [queryModel.count({ table: table() }), queryModel.delete({ table: table(), where: compare('id', 1) }), { kind: 'raw', sql: 'SELECT 1' }]) {
    assert.throws(() => queryModel.explain({ query }), coded('QUERY'));
  }
  const cycle = { kind: 'explain' }; cycle.query = cycle;
  assert.throws(() => compileSqlite(cycle), coded('QUERY'));
  let nested = source;
  for (let i = 0; i < 12_000; i++) nested = { kind: 'explain', query: nested };
  assert.throws(() => compileSqlite(nested), coded('QUERY'));
});

test('identifiers cannot smuggle syntax or invoke conversion methods', () => {
  for (const name of ['records; DROP TABLE records', 'name"', 'a.b', 'two words', '🧵', '', 'x'.repeat(64), '__proto__', 'constructor', 'sqlite_schema', '__rs_rank']) {
    assert.throws(() => tableModel({ name, columns: ['id'], primaryKey: ['id'] }), coded('SCHEMA'));
  }
  let conversions = 0;
  const name = { toString() { conversions++; return 'records'; } };
  assert.throws(() => tableModel({ name, columns: ['id'], primaryKey: ['id'] }), coded('SCHEMA'));
  assert.equal(conversions, 0);
  for (const columns of [['id', 'id'], ['id', 'ID'], [], Array.from({ length: 101 }, (_, i) => 'c' + i)]) {
    assert.throws(() => tableModel({ name: 'records', columns, primaryKey: ['id'] }), coded('SCHEMA'));
  }
  assert.throws(() => tableModel({ name: 'records', columns: ['id'], primaryKey: ['missing'] }), coded('SCHEMA'));
  assert.throws(() => tableModel({ name: 'records', columns: ['id'], primaryKey: [] }), coded('SCHEMA'));
  assert.throws(() => tableModel({ name: 'records', columns: ['id'], primaryKey: ['id'], version: 'id' }), coded('SCHEMA'));
});

test('plain forged nodes cannot add raw SQL fragments, unknown options or wrong column paths', () => {
  const base = select();
  for (const key of ['sql', 'raw', 'text', 'parameters', 'dialect', 'driver', 'execute']) {
    assert.throws(() => compileSqlite({ ...base, [key]: 'M2_RAW_839' }), coded('QUERY'));
  }
  for (const model of [null, [], { kind: 'raw', sql: 'DROP TABLE records' }, { ...base, kind: 'drop' }, { ...base, columns: ['name AS secret'] }, { ...base, columns: ['missing'] }, { ...base, columns: [] }]) {
    assert.throws(() => compileSqlite(model), modelError);
  }
  for (const where of [{ kind: 'raw', sql: '1=1' }, { kind: 'compare', column: 'name', operator: '= ? OR 1=1 --', values: ['x'] }, { kind: 'compare', column: 'missing', operator: '=', values: [1] }]) {
    assert.throws(() => compileSqlite({ ...base, where }), modelError);
  }
});

test('all operator and kind enums reject object coercion before invoking it', () => {
  let calls = 0;
  const operator = { toString() { calls++; return calls === 1 ? '=' : '= ? OR 1=1 --'; } };
  assert.throws(() => compileSqlitePredicate(table(), { kind: 'compare', column: 'id', operator, values: [1] }), coded('QUERY'));
  assert.equal(calls, 0);
  const kind = { toString() { calls++; return 'select'; } };
  assert.throws(() => compileSqlite({ ...select(), kind }), coded('QUERY'));
  assert.equal(calls, 0);
  const action = { toString() { calls++; return 'commit'; } };
  assert.throws(() => queryModel.transaction({ action }), coded('QUERY'));
  assert.equal(calls, 0);
  for (const operator of [['='], { value: '=' }]) {
    assert.throws(() => predicateModel(table(), { kind: 'compare', column: 'id', operator, values: [1] }), coded('QUERY'));
  }
});

test('non-enumerable array hooks and index accessors are rejected without running them', () => {
  for (const location of ['values', 'columns']) {
    let calls = 0;
    const array = location === 'values' ? ['Synthetic'] : ['name'];
    Object.defineProperty(array, 'map', { enumerable: false, get() { calls++; return Array.prototype.map; } });
    assert.throws(() => queryModel.insert({ table: table(), columns: location === 'columns' ? array : ['name'], values: location === 'values' ? array : ['Synthetic'] }), modelError);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const values = [1];
  Object.defineProperty(values, '0', { get() { calls++; return 1; } });
  assert.throws(() => queryModel.insert({ table: table(), columns: ['name'], values }), coded('QUERY'));
  assert.equal(calls, 0);
});

test('record accessors, inherited model state and sparse arrays fail as data rather than execute', () => {
  let reads = 0;
  const raw = { ...select() };
  Object.defineProperty(raw, 'where', { enumerable: true, get() { reads++; return compare('id', 1); } });
  assert.throws(() => compileSqlite(raw), coded('QUERY'));
  assert.equal(reads, 0);
  assert.throws(() => compileSqlite(Object.create(select())), coded('QUERY'));
  assert.throws(() => queryModel.insert({ table: table(), columns: ['name'], values: Array(1) }), coded('QUERY'));
  assert.throws(() => orderingModel(table(), Array(1)), coded('QUERY'));
  assert.throws(() => tableModel({ name: 'records', columns: Array(1), primaryKey: ['id'] }), coded('SCHEMA'));
  const values = ['Synthetic']; Object.setPrototypeOf(values, null);
  const result = compileSqlite(queryModel.insert({ table: table(), columns: ['name'], values }));
  assert.deepEqual(result.parameters, ['Synthetic']);
});

test('descriptor snapshots prevent changing Proxy reads from injecting operators or columns', () => {
  // Proxy traps can execute during descriptor introspection; this is a consistency regression, not a JS sandbox claim.
  const target = { kind: 'compare', column: 'id', operator: '=', values: [1] };
  for (const honestReads of [1, 2, 3]) {
    let reads = 0;
    const flipping = new Proxy(target, { get(object, key, receiver) {
      if (key === 'operator') return ++reads <= honestReads ? '=' : '= 1 OR 1=1 --';
      return Reflect.get(object, key, receiver);
    } });
    assert.deepEqual(compileSqlitePredicate(table(), flipping), { sql: '"id" = ?', parameters: [1], truth: null });
    assert.equal(reads, 0, 'normalization must use captured data descriptors rather than caller property gets');
  }
  let columns = 0;
  const columnFlip = new Proxy(target, { get(object, key, receiver) {
    if (key === 'column') return ++columns === 1 ? 'id' : 'name';
    return Reflect.get(object, key, receiver);
  } });
  assert.equal(compileSqlitePredicate(table(), columnFlip).sql, '"id" = ?');
  assert.equal(columns, 0);
});

test('forged mutation predicates cannot change from a checked filter into unrestricted SQL', () => {
  let reads = 0;
  const where = new Proxy(compare('id', 41), { get(object, key, receiver) {
    if (key === 'operator') return ++reads <= 2 ? '=' : '= 1 OR 1=1 --';
    return Reflect.get(object, key, receiver);
  } });
  const compiled = compileSqlite({ kind: 'update', table: table(), assignments: [{ column: 'name', value: 'M2_PROXY_839' }], where });
  assert.deepEqual(compiled.parameters, ['M2_PROXY_839', 41]);
  assert.ok(!compiled.sql.includes('OR 1=1') && !compiled.sql.includes('--'));
  assert.ok(compiled.sql.includes('WHERE "id" = ?'));
  assert.equal(reads, 0);
});

test('non-finite numbers, unsupported scalar values and overflowing int64 values are rejected', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, true, {}, [], new Date(), Symbol('not data'), 2n ** 63n, -(2n ** 63n) - 1n, () => 'not data']) {
    assert.throws(() => queryModel.insert({ table: table(), columns: ['name'], values: [value] }), coded('QUERY'));
    assert.throws(() => compileSqlitePredicate(table(), compare('name', value)), coded('QUERY'));
  }
  for (const value of [-(2n ** 63n), 2n ** 63n - 1n, -0, 1e100]) {
    const compiled = compileSqlite(queryModel.insert({ table: table(), columns: ['name'], values: [value] }));
    assert.equal(typeof compiled.parameters[0], typeof value);
    assert.ok(Object.is(compiled.parameters[0], value));
  }
  const boundary = 'x'.repeat(1_048_576);
  assert.equal(compileSqlite(queryModel.insert({ table: table(), columns: ['name'], values: [boundary] })).parameters[0], boundary);
  assert.throws(() => queryModel.insert({ table: table(), columns: ['name'], values: [boundary + 'x'] }), coded('QUERY'));
});

test('predicate node, depth and parameter limits reject before producing oversized SQL', () => {
  const t = table();
  const makeDepth = count => { let p = compare('id', 1); for (let i = 0; i < count; i++) p = { kind: 'not', child: p }; return p; };
  assert.ok(compileSqlitePredicate(t, makeDepth(16)).sql.startsWith('NOT'));
  assert.throws(() => compileSqlitePredicate(t, makeDepth(17)), coded('QUERY'));
  const leaf = compare('id', 1);
  assert.equal(compileSqlitePredicate(t, { kind: 'logic', operator: 'AND', children: Array(99).fill(leaf) }).parameters.length, 99);
  assert.throws(() => compileSqlitePredicate(t, { kind: 'logic', operator: 'AND', children: Array(100).fill(leaf) }), coded('QUERY'));
  const tenThousand = { kind: 'compare', column: 'id', operator: 'IN', values: Array.from({ length: 10000 }, (_, i) => i) };
  assert.equal(compileSqlitePredicate(t, tenThousand).parameters.length, 10000);
  assert.throws(() => compileSqlitePredicate(t, { ...tenThousand, values: Array(10001).fill(1) }), coded('QUERY'));
  assert.throws(() => compileSqlitePredicate(t, { kind: 'logic', operator: 'AND', children: [{ ...tenThousand, values: Array(6000).fill(1) }, { ...tenThousand, values: Array(4001).fill(2) }] }), coded('QUERY'));
  const cyclic = { kind: 'not' }; cyclic.child = cyclic;
  assert.throws(() => compileSqlitePredicate(t, cyclic), coded('QUERY'));
  const repeated = { kind: 'logic', operator: 'OR', children: [compare('name', 'A'), compare('name', 'B')] };
  assert.deepEqual(compileSqlitePredicate(t, { kind: 'logic', operator: 'AND', children: [repeated, repeated] }).parameters, ['A', 'B', 'A', 'B']);
});

test('query bounds and shape checks preserve valid zero limits and refuse invalid windows', () => {
  const compiled = compileSqlite(select({ limit: 0, offset: 1_000_000_000 }));
  assert.deepEqual(compiled.parameters, [0, 1_000_000_000]);
  for (const limit of [-1, 10001, 1.5, NaN, Infinity, '1']) assert.throws(() => select({ limit }), coded('QUERY'));
  for (const offset of [-1, 1_000_000_001, 0.5, NaN, Infinity, '0']) assert.throws(() => select({ offset }), coded('QUERY'));
  const relation = { table: table(), columns: ['tenantId', 'name'], partitionBy: 'tenantId', keys: [1], orderBy: [], offset: 0, limit: 1, readLimit: 10 };
  for (const patch of [{ keys: [] }, { keys: [null] }, { keys: Array(401).fill(1) }, { limit: 1001 }, { limit: -1 }, { readLimit: 0 }, { readLimit: 10002 }, { offset: -1 }, { columns: ['name'] }, { partitionBy: 'missing' }]) {
    assert.throws(() => queryModel.relation({ ...relation, ...patch }), modelError);
  }
});

test('meaningless mutation filters and protected assignments cannot bypass guarded write defaults', () => {
  const t = table();
  const truth = { kind: 'logic', operator: 'AND', children: [] };
  const falsehood = { kind: 'compare', column: 'id', operator: 'IN', values: [] };
  for (const where of [undefined, truth, { kind: 'not', child: falsehood }, { kind: 'logic', operator: 'OR', children: [truth, compare('id', 1)] }]) {
    assert.throws(() => queryModel.update({ table: t, assignments: [{ column: 'name', value: 'Synthetic' }], where }), coded('UNSAFE_WRITE'));
    assert.throws(() => queryModel.delete({ table: t, where }), coded('UNSAFE_WRITE'));
  }
  assert.ok(compileSqlite(queryModel.delete({ table: t, where: falsehood })).sql.includes('WHERE 0'));
  for (const assignments of [[], [{ column: 'id', value: 3 }], [{ column: 'version', value: 8 }], [{ column: 'missing', value: 1 }], [{ column: 'name', value: 'A' }, { column: 'name', value: 'B' }]]) {
    assert.throws(() => queryModel.update({ table: t, assignments, where: compare('id', 1) }), coded('QUERY'));
  }
});

test('normalization snapshots caller data and compiled parameter arrays are fresh', () => {
  const original = { name: 'records', columns: ['id', 'name'], primaryKey: ['id'] };
  const normalized = tableModel(original);
  const values = ['Original']; const fields = ['name'];
  const planned = queryModel.insert({ table: normalized, columns: fields, values });
  original.name = 'changed'; original.columns.push('secret'); fields[0] = 'id'; values[0] = 'Changed';
  const first = compileSqlite(planned);
  assert.ok(first.sql.includes('"records"') && first.sql.includes('"name"'));
  assert.deepEqual(first.parameters, ['Original']);
  first.parameters[0] = 'Caller mutation';
  assert.deepEqual(compileSqlite(planned).parameters, ['Original']);
  assert.ok(Object.isFrozen(planned) && Object.isFrozen(planned.table) && Object.isFrozen(planned.columns) && Object.isFrozen(planned.values));
  assert.throws(() => planned.values.push('No mutation'), TypeError);
});

test('ordering tokens are constrained independently of SQL-looking direction or columns', () => {
  assert.equal(compileSqliteOrder(table(), orderingModel(table(), [{ column: 'name', direction: 'DESC' }])), ' ORDER BY "name" DESC');
  for (const order of [[{ column: 'missing', direction: 'ASC' }], [{ column: 'name', direction: 'DESC; DROP TABLE records' }], [{ column: 'name', direction: ['ASC'] }]]) {
    assert.throws(() => compileSqliteOrder(table(), order), modelError);
  }
});

test('DDL defaults are safely quoted literals, the explicit SQLite exception to DML binding', () => {
  const t = tableModel({ name: 'defaults', columns: ['id', 'name'], primaryKey: ['id'] });
  const value = "O'Malley ? 🧵'); DROP TABLE synthetic_victim; --";
  const planned = queryModel.createTable({ table: t, definitions: [definition('id', 'integer'), definition('name', 'text', { hasDefault: true, defaultValue: value })] });
  const compiled = compileSqlite(planned);
  assert.deepEqual(compiled.parameters, []);
  assert.ok(compiled.sql.includes("DEFAULT '" + value.replaceAll("'", "''") + "'"));
  let quoted = false, outsideSemicolons = 0;
  for (let i = 0; i < compiled.sql.length; i++) {
    if (compiled.sql[i] === "'") {
      if (quoted && compiled.sql[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && compiled.sql[i] === ';') outsideSemicolons++;
  }
  assert.equal(quoted, false);
  assert.equal(outsideSemicolons, 0);
});

test('DDL definitions, names, flags and foreign key actions reject executable or malformed input', () => {
  const t = tableModel({ name: 'refs', columns: ['id', 'ownerId'], primaryKey: ['id'] });
  const input = changes => ({ table: t, definitions: [definition('id', 'integer'), definition('ownerId', 'integer', changes)] });
  for (const patch of [{ kind: 'raw INTEGER; DROP TABLE refs' }, { nullable: 'false' }, { primary: true }, { generated: true }, { hasDefault: true, defaultValue: Infinity }, { hasDefault: true, defaultValue: null }, { foreignKey: { table: 'records; DROP', column: 'id', onDelete: 'cascade' } }, { foreignKey: { table: 'records', column: 'id', onDelete: 'CASCADE); DROP TABLE refs; --' } }, { foreignKey: { table: 'records', column: 'id', onDelete: 'set null' } }]) {
    assert.throws(() => queryModel.createTable(input(patch)), modelError);
  }
  let calls = 0;
  const onDelete = { toString() { calls++; return 'no action'; }, toUpperCase() { calls++; return 'NO ACTION); DROP TABLE synthetic_victim; --'; } };
  assert.throws(() => compileSqlite(queryModel.createTable(input({ foreignKey: { table: 'records', column: 'id', onDelete } }))), coded('SCHEMA'));
  assert.equal(calls, 0);
  const kind = { toString() { calls++; return 'integer'; } };
  assert.throws(() => queryModel.createTable(input({ kind })), coded('SCHEMA'));
  assert.equal(calls, 0);
  for (const name of ['idx; DROP TABLE refs', '__proto__', 'x'.repeat(64)]) assert.throws(() => queryModel.createIndex({ table: t, name, columns: ['ownerId'] }), coded('SCHEMA'));
});

test('DDL NUL defaults fail before producing SQL while DML NUL remains a valid parameter', () => {
  const t = tableModel({ name: 'defaults', columns: ['id', 'name'], primaryKey: ['id'] });
  assert.throws(() => queryModel.createTable({ table: t, definitions: [definition('id', 'integer'), definition('name', 'text', { hasDefault: true, defaultValue: 'before\0after' })] }), coded('SCHEMA'));
  const compiled = compileSqlite(queryModel.insert({ table: t, columns: ['name'], values: ['before\0after'] }));
  assert.deepEqual(compiled.parameters, ['before\0after']);
  assert.ok(!compiled.sql.includes('\0'));
});

test('transaction controls only compile recognized actions and validated names', () => {
  for (const [action, sql] of [['begin', 'BEGIN'], ['begin-immediate', 'BEGIN IMMEDIATE'], ['commit', 'COMMIT'], ['rollback', 'ROLLBACK']]) {
    assert.deepEqual(compileSqlite(queryModel.transaction({ action })), { sql, parameters: [] });
  }
  for (const action of ['savepoint', 'release', 'rollback-to']) {
    const compiled = compileSqlite(queryModel.transaction({ action, name: 'rs_sp_1' }));
    assert.ok(compiled.sql.endsWith('"rs_sp_1"'));
    assert.deepEqual(compiled.parameters, []);
    assert.throws(() => queryModel.transaction({ action, name: 'sp"; DROP TABLE records; --' }), coded('SCHEMA'));
    assert.throws(() => queryModel.transaction({ action }), coded('SCHEMA'));
  }
  assert.throws(() => queryModel.transaction({ action: 'commit', name: 'unused' }), coded('QUERY'));
  assert.throws(() => queryModel.transaction({ action: 'DROP TABLE records' }), coded('QUERY'));
});
