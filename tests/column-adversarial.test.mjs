import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as orm from '../dist/index.js';
import { tableModel, predicateModel, predicateTruth, queryModel } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate } from '../dist/core/sqlite-compiler.js';

const { column, defineTable, openDatabase, eq, and, or, not, asc, isNull, inArray } = orm;
const coded = code => error => error instanceof orm.RowstitchError && error.code === code;
const modelError = error => error instanceof orm.RowstitchError && ['QUERY', 'SCHEMA'].includes(error.code);
const operations = [
  ['eqColumns', '=', value => value === 0], ['neColumns', '<>', value => value !== 0],
  ['gtColumns', '>', value => value > 0], ['gteColumns', '>=', value => value >= 0],
  ['ltColumns', '<', value => value < 0], ['lteColumns', '<=', value => value <= 0],
];
const ids = (repo, where) => repo.findMany({ where, select: ['id'], orderBy: [asc(repo.definition.col('id'))], limit: 1000 }).map(row => row.id);
const modelNode = (changes = {}) => ({ kind: 'column-compare', left: 'lhs', right: 'rhs', operator: '=', ...changes });
const plainModel = () => ({ name: 'column_cases', columns: ['id', 'lhs', 'rhs', 'title', 'flagL', 'flagR', 'jsonData'], primaryKey: ['id'], kinds: { id: 'integer', lhs: 'integer', rhs: 'bigint', title: 'text', flagL: 'boolean', flagR: 'boolean', jsonData: 'json' } });

function mappedTable() {
  return defineTable('column_cases', {
    id: column.integer().primaryKey(), actual: column.integer().nullable(), planned: column.integer().nullable(),
    bigL: column.bigint().nullable(), bigR: column.bigint().nullable(), realL: column.real().nullable(), realR: column.real().nullable(),
    titleL: column.text().nullable(), titleR: column.text().nullable(), flagL: column.boolean().nullable(), flagR: column.boolean().nullable(),
    jsonString: column.json().default('ordinary fictional words'), jsonNumber: column.json().default(3),
    label: column.text().default('ordinary row'), version: column.integer().default(0),
  }, { version: 'version' });
}
function memory(t, options = {}) {
  const records = mappedTable();
  const db = openDatabase(':memory:', { tables: [records], ...options });
  db.ensureSchema(); t.after(() => db.close());
  return { records, db, repo: db.table(records) };
}
function temporaryDirectory() {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-column-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  return directory;
}
// Independent numeric oracle: exact binary64 rational, never Number(bigint).
function rational(value) {
  if (typeof value === 'bigint') return [value, 1n];
  assert.ok(Number.isFinite(value));
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false), exponent = Number((bits >> 52n) & 0x7ffn), fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent ? (1n << 52n) | fraction : fraction, power = exponent ? exponent - 1023 - 52 : -1074;
  const signed = bits >> 63n ? -mantissa : mantissa;
  return power >= 0 ? [signed << BigInt(power), 1n] : [signed, 1n << BigInt(-power)];
}
function numericOrder(left, right) {
  if (left === null || right === null) return null;
  const [ln, ld] = rational(left), [rn, rd] = rational(right), difference = ln * rd - rn * ld;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

test('six named column helpers compile real zero-binding predicates without changing old value helpers', t => {
  const { records, repo } = memory(t);
  for (const [name, token] of operations) {
    assert.equal(typeof orm[name], 'function', name);
    const predicate = orm[name](records.col('actual'), records.col('planned'));
    const output = repo.compileSelect({ where: predicate, select: ['id'], limit: 7, offset: 2 });
    assert.ok(output.sql.includes('"actual" ' + token + ' "planned"'));
    assert.ok(!output.sql.includes('CAST('));
    assert.deepEqual(output.parameters, [7, 2]);
  }
  assert.throws(() => eq(records.col('actual'), records.col('planned')), coded('VALIDATION'));
});

test('all nine numeric codec pairs agree with an exact rational oracle at int64 and binary64 boundaries', t => {
  const max = 2n ** 63n - 1n, min = -(2n ** 63n);
  const domains = {
    integer: [null, -Number.MAX_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER],
    bigint: [null, min, min + 1n, -(2n ** 53n) - 1n, -1n, 0n, 1n, 2n ** 53n + 1n, max - 1n, max],
    real: [null, -1e100, -(2 ** 63), -(2 ** 53), -1.5, -0, Number.MIN_VALUE, 0.1, 1, 1.5, 2 ** 53, 2 ** 63, 1e100],
  };
  let fixtureRows = 0;
  for (const [leftKind, leftValues] of Object.entries(domains)) for (const [rightKind, rightValues] of Object.entries(domains)) {
    const records = defineTable('numeric_columns', { id: column.integer().primaryKey(), lhs: column[leftKind]().nullable(), rhs: column[rightKind]().nullable() });
    const db = openDatabase(':memory:', { tables: [records] }); t.after(() => db.close()); db.ensureSchema();
    const rows = []; for (const lhs of leftValues) for (const rhs of rightValues) rows.push({ id: rows.length + 1, lhs, rhs });
    fixtureRows += rows.length;
    const repo = db.table(records); repo.insertMany(rows);
    for (const [name, , matches] of operations) {
      const predicate = orm[name](records.col('lhs'), records.col('rhs'));
      const expected = rows.filter(row => { const order = numericOrder(row.lhs, row.rhs); return order !== null && matches(order); }).map(row => row.id);
      const inverse = rows.filter(row => { const order = numericOrder(row.lhs, row.rhs); return order !== null && !matches(order); }).map(row => row.id);
      assert.deepEqual(ids(repo, predicate), expected, leftKind + '/' + rightKind + '/' + name);
      assert.deepEqual(ids(repo, not(predicate)), inverse);
      assert.equal(repo.count(predicate), expected.length);
    }
  }
  assert.equal(fixtureRows, 841);
});

test('boolean equality is three-valued and ordering/cross-domain/JSON operands are rejected', t => {
  const { records, repo, db } = memory(t);
  const rows = [
    { id: 1, flagL: true, flagR: true }, { id: 2, flagL: true, flagR: false },
    { id: 3, flagL: false, flagR: false }, { id: 4, flagL: null, flagR: null }, { id: 5, flagL: null, flagR: true },
  ]; repo.insertMany(rows);
  assert.deepEqual(ids(repo, orm.eqColumns(records.col('flagL'), records.col('flagR'))), [1, 3]);
  assert.deepEqual(ids(repo, orm.neColumns(records.col('flagL'), records.col('flagR'))), [2]);
  assert.deepEqual(ids(repo, not(orm.eqColumns(records.col('flagL'), records.col('flagR')))), [2]);
  for (const [name] of operations.slice(2)) assert.throws(() => orm[name](records.col('flagL'), records.col('flagR')), coded('QUERY'));
  db.clearTrace();
  for (const [name] of operations) for (const [left, right] of [['titleL', 'actual'], ['flagL', 'actual'], ['jsonString', 'titleL'], ['jsonNumber', 'actual'], ['jsonString', 'jsonNumber']]) {
    assert.throws(() => orm[name](new orm.ColumnRef(records, left), new orm.ColumnRef(records, right)), coded('QUERY'));
    assert.throws(() => orm[name](records.col(right), records.col(left)), coded('QUERY'));
  }
  assert.deepEqual(db.exportTrace().queries, []);
});

test('NULL composition remains unknown and a zero-binding condition can narrow ordinary reads', t => {
  const { records, repo } = memory(t);
  repo.insertMany([{ id: 1, actual: 1, planned: 1 }, { id: 2, actual: 2, planned: 1 }, { id: 3, actual: null, planned: null }, { id: 4, actual: 1, planned: null }]);
  const comparison = orm.eqColumns(records.col('actual'), records.col('planned'));
  assert.deepEqual(ids(repo, comparison), [1]);
  assert.deepEqual(ids(repo, not(comparison)), [2]);
  assert.deepEqual(ids(repo, or(comparison, isNull(records.col('actual')))), [1, 3]);
  assert.deepEqual(ids(repo, and(not(comparison), eq(records.col('id'), 2))), [2]);
  assert.deepEqual(repo.findMany({ select: ['label'], where: comparison }), [{ label: 'ordinary row' }]);
});

test('self comparisons, distinct duplicate refs and foreign query scopes reject before SQL', t => {
  const { records, repo, db } = memory(t);
  const duplicate = mappedTable();
  for (const [name, operator] of operations) {
    const same = records.col('actual');
    assert.throws(() => orm[name](same, same), coded('QUERY'));
    assert.throws(() => orm[name](new orm.ColumnRef(records, 'actual'), records.col('actual')), coded('QUERY'));
    assert.throws(() => orm[name](records.col('actual'), duplicate.col('planned')), coded('QUERY'));
    const wrongScope = orm[name](duplicate.col('actual'), duplicate.col('planned'));
    db.clearTrace();
    assert.throws(() => repo.findMany({ where: wrongScope }), coded('QUERY'));
    assert.deepEqual(db.exportTrace().queries, []);
    assert.throws(() => compileSqlitePredicate(tableModel(plainModel()), modelNode({ left: 'lhs', right: 'lhs', operator })), coded('QUERY'));
  }
});

test('forged, inherited, Proxy and revoked references fail before their getters or traps execute', t => {
  const { records, db } = memory(t);
  const genuine = records.col('actual'), other = records.col('planned');
  for (const [name] of operations) {
    let calls = 0;
    const forged = Object.create(orm.ColumnRef.prototype, { table: { get() { calls++; return records; } }, name: { get() { calls++; return 'actual'; } } });
    const wrapper = new Proxy(genuine, { get(object, key, receiver) { calls++; return Reflect.get(object, key, receiver); }, getPrototypeOf(object) { calls++; return Reflect.getPrototypeOf(object); } });
    const revoked = Proxy.revocable(genuine, {}); revoked.revoke();
    for (const candidate of [forged, wrapper, revoked.proxy, Object.create(genuine), null, {}, 'actual']) {
      assert.throws(() => orm[name](candidate, other), coded('QUERY'));
      assert.throws(() => orm[name](other, candidate), coded('QUERY'));
    }
    assert.equal(calls, 0);
  }
  assert.equal(db.table(records).count(), 0);
});

test('new model leaves require complete kind metadata while old value plans still work without it', () => {
  const legacy = plainModel(); delete legacy.kinds;
  const oldTable = tableModel(legacy);
  assert.deepEqual(compileSqlitePredicate(oldTable, { kind: 'compare', column: 'lhs', operator: '=', values: [3] }).parameters, [3]);
  assert.throws(() => compileSqlitePredicate(oldTable, modelNode()), coded('QUERY'));
  for (const kinds of [null, [], {}, { lhs: 'integer', rhs: 'bigint' }, { ...plainModel().kinds, extra: 'text' }, { ...plainModel().kinds, rhs: 'INTEGER' }, { ...plainModel().kinds, rhs: undefined }, { ...plainModel().kinds, rhs: 'numeric' }]) {
    assert.throws(() => tableModel({ ...plainModel(), kinds }), coded('SCHEMA'));
  }
  const table = tableModel(plainModel());
  for (const [operator, left, right] of [['>', 'flagL', 'flagR'], ['=', 'jsonData', 'title'], ['=', 'title', 'lhs']]) {
    assert.throws(() => compileSqlitePredicate(table, modelNode({ left, right, operator })), coded('QUERY'));
  }
});

test('metadata, enum and operand accessors or conversion objects are rejected without execution', () => {
  let calls = 0;
  const primitive = { toString() { calls++; return '='; }, [Symbol.toPrimitive]() { calls++; return 'integer'; } };
  const kindGetter = { ...plainModel().kinds }; Object.defineProperty(kindGetter, 'lhs', { get() { calls++; return 'integer'; } });
  const tableGetter = plainModel(); Object.defineProperty(tableGetter, 'kinds', { get() { calls++; return plainModel().kinds; } });
  const hidden = { ...plainModel().kinds }; Object.defineProperty(hidden, 'raw', { value: 'ordinary unsupported text', enumerable: false });
  for (const raw of [tableGetter, { ...plainModel(), kinds: kindGetter }, { ...plainModel(), kinds: hidden }, { ...plainModel(), kinds: { ...plainModel().kinds, lhs: primitive } }, { ...plainModel(), kinds: { ...plainModel().kinds, [Symbol('extra')]: 'text' } }]) assert.throws(() => tableModel(raw), coded('SCHEMA'));
  const table = tableModel(plainModel());
  const leftGetter = modelNode(); Object.defineProperty(leftGetter, 'left', { get() { calls++; return 'lhs'; } });
  for (const raw of [leftGetter, modelNode({ left: primitive }), modelNode({ right: primitive }), modelNode({ operator: primitive }), modelNode({ operator: ['='] })]) assert.throws(() => compileSqlitePredicate(table, raw), modelError);
  assert.equal(calls, 0);
});

test('metadata and predicate descriptors are captured once and normalized snapshots are detached and frozen', () => {
  let reads = 0;
  const kinds = new Proxy(plainModel().kinds, { get(object, key, receiver) { reads++; return key === 'lhs' ? 'json' : Reflect.get(object, key, receiver); } });
  const raw = { ...plainModel(), kinds };
  const table = tableModel(raw);
  const node = new Proxy(modelNode({ operator: '>' }), { get(object, key, receiver) { reads++; return key === 'operator' ? '= 1 OR 1=1 --' : Reflect.get(object, key, receiver); } });
  assert.deepEqual(compileSqlitePredicate(table, node), { sql: '"lhs" > "rhs"', parameters: [], truth: null });
  assert.equal(reads, 0);
  const source = plainModel(), normalized = tableModel(source);
  source.kinds.lhs = 'json'; source.columns[1] = 'changed';
  const original = modelNode(); const predicate = predicateModel(normalized, original); original.right = 'id';
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.kinds) && Object.isFrozen(predicate));
  assert.equal(normalized.kinds.lhs, 'integer');
  assert.equal(compileSqlitePredicate(normalized, predicate).sql, '"lhs" = "rhs"');
  assert.throws(() => { normalized.kinds.lhs = 'json'; }, TypeError);
});

test('forged column leaves cannot introduce raw fragments or unsupported comparison syntax', () => {
  const table = tableModel(plainModel());
  for (const operator of ['IS', 'IS NOT', 'IN', 'BETWEEN', 'LIKE', '= ? OR 1=1 --', '', null, false]) assert.throws(() => compileSqlitePredicate(table, modelNode({ operator })), coded('QUERY'));
  for (const key of ['sql', 'raw', 'values', 'parameters', 'leftKind', 'rightKind', 'table', 'collate', 'path', 'driver']) assert.throws(() => compileSqlitePredicate(table, modelNode({ [key]: [] })), coded('QUERY'));
  for (const left of ['lhs" OR 1=1 --', 'other.lhs', 'missing', '__proto__', 'lhs\0']) assert.throws(() => compileSqlitePredicate(table, modelNode({ left })), modelError);
  const hidden = modelNode(); Object.defineProperty(hidden, 'raw', { value: '1=1', enumerable: false });
  assert.throws(() => compileSqlitePredicate(table, hidden), coded('QUERY'));
  assert.throws(() => compileSqlitePredicate(table, { ...modelNode(), [Symbol('fragment')]: '1=1' }), coded('QUERY'));
});

test('zero-bind leaves retain truth, binding order and existing node/depth/parameter budgets', () => {
  const table = tableModel(plainModel());
  const leaf = modelNode({ operator: '<' });
  const normalized = predicateModel(table, leaf);
  assert.equal(predicateTruth(normalized), null);
  assert.equal(compileSqlitePredicate(table, { kind: 'logic', operator: 'AND', children: Array(99).fill(leaf) }).parameters.length, 0);
  assert.throws(() => compileSqlitePredicate(table, { kind: 'logic', operator: 'AND', children: Array(100).fill(leaf) }), coded('QUERY'));
  let depth = leaf; for (let i = 0; i < 16; i++) depth = { kind: 'not', child: depth };
  assert.ok(compileSqlitePredicate(table, depth).sql.startsWith('NOT'));
  assert.throws(() => compileSqlitePredicate(table, { kind: 'not', child: depth }), coded('QUERY'));
  const values = Array.from({ length: 10000 }, (_, index) => index);
  const where = { kind: 'logic', operator: 'AND', children: [{ kind: 'compare', column: 'id', operator: 'IN', values }, leaf] };
  assert.deepEqual(compileSqlitePredicate(table, where).parameters, values);
  assert.throws(() => compileSqlitePredicate(table, { ...where, children: [{ kind: 'compare', column: 'id', operator: 'IN', values: [...values, 10000] }, leaf] }), coded('QUERY'));
  assert.deepEqual(compileSqlite(queryModel.count({ table, where: leaf })).parameters, []);
  assert.deepEqual(compileSqlite(queryModel.update({ table, where: leaf, assignments: [{ column: 'title', value: 'ordinary replacement' }] })).parameters, ['ordinary replacement']);
  assert.deepEqual(compileSqlite(queryModel.delete({ table, where: leaf })).parameters, []);
});

test('mixed literal, column and version filters preserve exact public binding order', t => {
  const { records, repo } = memory(t);
  const where = and(eq(records.col('id'), 7), orm.endsWith(records.col('titleL'), 'ordinary suffix'), orm.gtColumns(records.col('actual'), records.col('planned')), eq(records.col('version'), 2));
  const compiled = repo.compileSelect({ where, limit: 5, offset: 3 });
  assert.deepEqual(compiled.parameters, [7, 'ordinary suffix', 'ordinary suffix', 'ordinary suffix', 2, 5, 3]);
  assert.equal((compiled.sql.match(/\?/g) ?? []).length, compiled.parameters.length);
  assert.ok(!compiled.sql.includes('ordinary suffix'));
});

test('zero-bind writes preserve atomic affected-row/version guards and persisted state', () => {
  const directory = temporaryDirectory(), filename = join(directory, 'fictional.sqlite');
  const records = mappedTable(); let db;
  try {
    db = openDatabase(filename, { tables: [records], traceValues: true }); db.ensureSchema(); const repo = db.table(records);
    repo.insertMany([{ id: 1, actual: 3, planned: 2, label: 'first row' }, { id: 2, actual: 4, planned: 4, label: 'second row' }, { id: 3, actual: 1, planned: 8, label: 'third row' }, { id: 4, actual: null, planned: 5, label: 'null row' }]);
    const narrow = orm.gtColumns(records.col('actual'), records.col('planned')), broad = orm.gteColumns(records.col('actual'), records.col('planned'));
    assert.throws(() => repo.update({ label: 'unwanted change' }, { where: broad, maxRows: 1 }), coded('AFFECTED_ROWS'));
    assert.throws(() => repo.delete({ where: broad, maxRows: 1 }), coded('AFFECTED_ROWS'));
    assert.throws(() => repo.update({ label: 'unwanted change' }, { where: narrow, maxRows: 0 }), coded('AFFECTED_ROWS'));
    let reads = 0;
    const options = new Proxy({ where: narrow, maxRows: 1 }, { get(object, key, receiver) { if (key === 'where') return ++reads === 1 ? narrow : broad; return Reflect.get(object, key, receiver); } });
    db.clearTrace();
    assert.deepEqual(repo.update({ label: 'updated row' }, options).map(row => [row.id, row.version]), [[1, 1]]);
    assert.equal(reads, 1);
    const events = db.exportTrace().queries;
    assert.deepEqual(events.find(event => event.sql.startsWith('SELECT count')).parameters, []);
    assert.deepEqual(events.find(event => event.operation === 'update').parameters, ['updated row']);
    assert.throws(() => repo.updateVersion({ id: 1 }, 0, { label: 'stale change' }), coded('CONFLICT'));
    assert.deepEqual(repo.update({ label: 'stale change' }, { where: and(narrow, eq(records.col('version'), 0)), maxRows: 1 }), []);
    assert.equal(repo.findFirst({ where: eq(records.col('id'), 2) }).version, 0);
    db.close(); db = openDatabase(filename, { tables: [records], readOnly: true });
    assert.deepEqual(db.table(records).findMany({ select: ['id', 'label', 'version'] }), [{ id: 1, label: 'updated row', version: 1 }, { id: 2, label: 'second row', version: 0 }, { id: 3, label: 'third row', version: 0 }, { id: 4, label: 'null row', version: 0 }]);
    assert.throws(() => db.table(records).delete({ where: narrow, maxRows: 1 }), coded('READ_ONLY'));
  } finally { db?.close(); unlinkSync(filename); rmdirSync(directory); }
});

test('correct child column filters remain batched and projected while parent scope is rejected', t => {
  const parents = defineTable('column_parents', { id: column.integer().primaryKey(), threshold: column.integer(), title: column.text() });
  const children = defineTable('column_children', { id: column.integer().primaryKey(), parentId: column.integer(), actual: column.integer().nullable(), planned: column.integer().nullable(), label: column.text() });
  const db = openDatabase(':memory:', { tables: [parents, children] }); t.after(() => db.close()); db.ensureSchema();
  db.table(parents).insertMany([{ id: 1, threshold: 0, title: 'First' }, { id: 2, threshold: 0, title: 'Second' }]);
  db.table(children).insertMany([{ id: 1, parentId: 1, actual: 2, planned: 1, label: 'included' }, { id: 2, parentId: 1, actual: 1, planned: 2, label: 'excluded' }, { id: 3, parentId: 2, actual: null, planned: null, label: 'unknown' }]);
  db.clearTrace();
  const matching = orm.gtColumns(children.col('actual'), children.col('planned'));
  const rows = db.table(parents).findMany({ select: ['title'], include: { matches: orm.hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: matching, select: ['label'] }) } });
  assert.deepEqual(rows, [{ title: 'First', matches: [{ label: 'included' }] }, { title: 'Second', matches: [] }]);
  assert.equal(db.exportTrace().queries.filter(event => event.operation === 'select').length, 2);
  db.clearTrace();
  assert.throws(() => orm.hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: orm.gtColumns(parents.col('id'), parents.col('threshold')) }), coded('QUERY'));
  assert.throws(() => db.table(parents).findMany({ where: matching }), coded('QUERY'));
  assert.deepEqual(db.exportTrace().queries, []);
});

test('default trace and EXPLAIN retain schema SQL without capturing compared row values', t => {
  const { records, repo, db } = memory(t);
  const fixturePhrase = 'these fictional words are row contents for a privacy check';
  repo.insert({ id: 1, actual: 3, planned: 1, label: fixturePhrase }); db.clearTrace();
  const where = orm.gtColumns(records.col('actual'), records.col('planned'));
  assert.equal(repo.findFirst({ where }).label, fixturePhrase);
  assert.ok(repo.explain({ where }).length > 0);
  repo.update({ label: fixturePhrase + ' changed' }, { where, maxRows: 1 });
  const exported = db.exportTrace(), serialized = JSON.stringify(exported);
  assert.ok(!serialized.includes(fixturePhrase));
  assert.ok(exported.queries.flatMap(event => event.parameters).every(value => value === '[redacted]'));
  assert.ok(exported.queries.every(event => !Object.hasOwn(event, 'rows') && !Object.hasOwn(event, 'kinds')));
});

test('existing UTF-8 and UTF-16 text columns retain ordinary left-collation precedence and NULL behavior', () => {
  const directory = temporaryDirectory();
  const rows = [
    [1, 'A', 'a', 'a ', 'a'], [2, 'a', 'A', 'b', 'b '], [3, null, null, null, null], [4, null, 'b', null, ''],
    [5, 'æ', 'Æ', 'é', 'e\u0301'], [6, 'prefix\0left', 'prefix\0else', 'unchanged ', 'unchanged'],
    [7, '🧵', '\uFFFD', '🧵', '\uFFFD'], [8, "' ? --", 'punctuation', '', ''],
    [9, '1', '2', 'a  ', 'a'], [10, 'before\0AFTER', 'before\0after', 'prefix\0left ', 'prefix\0left'],
  ];
  try {
    for (const [label, pragma, encoding] of [['utf8', "PRAGMA encoding='UTF-8'", 'UTF-8'], ['utf16le', "PRAGMA encoding='UTF-16le'", 'UTF-16le'], ['utf16be', "PRAGMA encoding='UTF-16be'", 'UTF-16be']]) {
      const filename = join(directory, label + '.sqlite'); let native; let db;
      try {
        native = new DatabaseSync(filename, { allowExtension: false, defensive: true }); native.enableDefensive(true);
        native.exec(pragma);
        native.exec('CREATE TABLE comparison_text (id INTEGER NOT NULL, lhs TEXT COLLATE NOCASE, rhs TEXT COLLATE BINARY, trimValue TEXT COLLATE RTRIM, plainValue TEXT COLLATE BINARY, PRIMARY KEY (id))');
        const insert = native.prepare('INSERT INTO comparison_text VALUES (?, ?, ?, ?, ?)'); rows.forEach(row => insert.run(...row));
        assert.equal(native.prepare('PRAGMA encoding').get().encoding, encoding);
        const expected = [];
        for (const [left, right] of [['lhs', 'rhs'], ['rhs', 'lhs'], ['trimValue', 'plainValue'], ['plainValue', 'trimValue']]) for (const [name, token] of operations) {
          const expression = '"' + left + '" ' + token + ' "' + right + '"';
          expected.push({ name, left, right,
            positive: native.prepare('SELECT id FROM comparison_text WHERE ' + expression + ' ORDER BY id').all().map(row => row.id),
            negative: native.prepare('SELECT id FROM comparison_text WHERE NOT (' + expression + ') ORDER BY id').all().map(row => row.id) });
        }
        native.close(); native = undefined;
        const records = defineTable('comparison_text', { id: column.integer().primaryKey(), lhs: column.text().nullable(), rhs: column.text().nullable(), trimValue: column.text().nullable(), plainValue: column.text().nullable() });
        db = openDatabase(filename, { tables: [records], readOnly: true }); const repo = db.table(records);
        // Existing schema inspection does not certify matching declared collations.
        assert.deepEqual(db.planSchema(), []);
        for (const fixture of expected) {
          const predicate = orm[fixture.name](records.col(fixture.left), records.col(fixture.right));
          assert.deepEqual(ids(repo, predicate), fixture.positive, label + '/' + fixture.name + '/' + fixture.left);
          assert.deepEqual(ids(repo, not(predicate)), fixture.negative);
        }
        assert.ok(ids(repo, orm.eqColumns(records.col('lhs'), records.col('rhs'))).includes(1));
        assert.ok(!ids(repo, orm.eqColumns(records.col('rhs'), records.col('lhs'))).includes(1));
        assert.ok(ids(repo, orm.eqColumns(records.col('trimValue'), records.col('plainValue'))).includes(1));
        assert.ok(!ids(repo, orm.eqColumns(records.col('plainValue'), records.col('trimValue'))).includes(1));
      } finally { db?.close(); native?.close(); unlinkSync(filename); }
    }
  } finally { rmdirSync(directory); }
});

test('compiled declarations preserve non-distributive NoInfer domains for actual consumers', () => {
  const directory = temporaryDirectory(), sourcePath = join(directory, 'consumer.mts'), configPath = join(directory, 'tsconfig.json');
  const sdk = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  let specifier = relative(directory, sdk).replaceAll('\\', '/'); if (!specifier.startsWith('.')) specifier = './' + specifier;
  const names = operations.map(([name]) => name);
  const source = [
    `import { column, defineTable, ColumnRef, ${names.join(', ')} } from ${JSON.stringify(specifier)};`,
    "const records = defineTable('consumer_types', { id:column.integer().primaryKey(), i:column.integer(), r:column.real().nullable(), b:column.bigint(), iOther:column.integer(), rOther:column.real(), bOther:column.bigint(), text:column.text(), maybe:column.text().nullable(), flag:column.boolean(), otherFlag:column.boolean().nullable(), jsonText:column.json<string>(), jsonNumber:column.json<number>() });",
  ];
  for (const name of names) for (const left of ['i', 'r', 'b']) for (const right of ['i', 'r', 'b']) source.push(`${name}(records.col('${left}'), records.col('${right}Other'));`);
  for (const name of names) {
    source.push(`${name}(records.col('text'), records.col('maybe'));`);
    for (const [left, right] of [['text', 'i'], ['i', 'text'], ['flag', 'i'], ['jsonText', 'text'], ['jsonNumber', 'i']]) source.push('// @ts-expect-error RHS cannot widen or bypass codec domains.', `${name}(records.col('${left}'), records.col('${right}'));`);
  }
  source.push("eqColumns(records.col('flag'), records.col('otherFlag'));", "neColumns(records.col('flag'), records.col('otherFlag'));");
  for (const name of names.slice(2)) source.push('// @ts-expect-error Ordered boolean columns are not numeric.', `${name}(records.col('flag'), records.col('otherFlag'));`);
  source.push("declare const numericUnion: ColumnRef<number | null, 'integer' | 'real'>;", "declare const mixedUnion: ColumnRef<string | number, 'text' | 'integer'>;", 'declare const widened: ColumnRef<number>;');
  for (const name of names) source.push(`${name}(numericUnion, records.col('b'));`, '// @ts-expect-error An uncertain mixed-domain LHS requires narrowing.', `${name}(mixedUnion, records.col('text'));`, '// @ts-expect-error A widened codec is not proof of a numeric domain.', `${name}(widened, records.col('i'));`);
  try {
    writeFileSync(sourcePath, source.join('\n') + '\n');
    writeFileSync(configPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, exactOptionalPropertyTypes: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, types: [] }, files: ['./consumer.mts'] }));
    const compiler = fileURLToPath(new URL('../node_modules/typescript/lib/tsc.js', import.meta.url));
    const child = spawnSync(process.execPath, [compiler, '-p', configPath], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  } finally { unlinkSync(sourcePath); unlinkSync(configPath); rmdirSync(directory); }
});

test('pure metadata and column compilation needs no SQLite connection or Node builtin dependency', () => {
  const models = new URL('../dist/core/query-model.js', import.meta.url).href, compiler = new URL('../dist/core/sqlite-compiler.js', import.meta.url).href;
  const script = `import {registerHooks,isBuiltin} from 'node:module';
    registerHooks({resolve(specifier,context,next){if(isBuiltin(specifier))throw new Error('Unexpected builtin dependency');return next(specifier,context);}});
    const m=await import(${JSON.stringify(models)}), c=await import(${JSON.stringify(compiler)});
    const table=m.tableModel({name:'columns',columns:['id','lhs','rhs'],primaryKey:['id'],kinds:{id:'integer',lhs:'bigint',rhs:'real'}});
    const output=c.compileSqlite(m.queryModel.select({table,columns:['id'],where:{kind:'column-compare',left:'lhs',right:'rhs',operator:'>'},orderBy:[],limit:3,offset:0}));
    process.stdout.write(JSON.stringify(output));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.parameters, [3, 0]);
  assert.ok(result.sql.includes('"lhs" > "rhs"'));
});
