import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { column, defineTable, openDatabase, eq, hasMany, hasOne, RowstitchError } from '../dist/index.js';
import { queryModel } from '../dist/core/query-model.js';
import { compileSqlite } from '../dist/core/sqlite-compiler.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const parents = defineTable('correlation_parents', { code: column.text().primaryKey(), label: column.text() });
const children = defineTable('correlation_children', { id: column.integer().primaryKey(), parentCode: column.text().nullable(), shared: column.text(), payload: column.json() });
const leaves = defineTable('correlation_leaves', { id: column.integer().primaryKey(), shared: column.text(), label: column.text() });
function fixture(t, parentRows, childRows, leafRows = [], encoding = 'UTF-8') {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-correlation-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  const filename = join(directory, 'fictional.sqlite'); let raw; let db;
  t.after(() => { db?.close(); raw?.close(); unlinkSync(filename); rmdirSync(directory); });
  raw = new DatabaseSync(filename, { allowExtension: false, defensive: true }); raw.enableDefensive(true);
  assert.ok(['UTF-8', 'UTF-16le', 'UTF-16be'].includes(encoding));
  raw.exec("PRAGMA encoding='" + encoding + "'");
  raw.exec(`CREATE TABLE correlation_parents(code TEXT NOT NULL COLLATE BINARY, label TEXT NOT NULL, PRIMARY KEY(code));
    CREATE TABLE correlation_children(id INTEGER NOT NULL, parentCode TEXT COLLATE NOCASE, shared TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(id));
    CREATE TABLE correlation_leaves(id INTEGER NOT NULL, shared TEXT NOT NULL COLLATE NOCASE, label TEXT NOT NULL, PRIMARY KEY(id));`);
  const parentInsert = raw.prepare('INSERT INTO correlation_parents VALUES(?,?)');
  parentRows.forEach((code, index) => parentInsert.run(code, 'Parent ' + index));
  const childInsert = raw.prepare('INSERT INTO correlation_children VALUES(?,?,?,?)');
  childRows.forEach(row => childInsert.run(row.id, row.parentCode, row.shared ?? 'Group', JSON.stringify(row.payload ?? { ordinary: true })));
  const leafInsert = raw.prepare('INSERT INTO correlation_leaves VALUES(?,?,?)');
  leafRows.forEach(row => leafInsert.run(row.id, row.shared ?? 'group', row.label ?? 'Leaf'));
  db = openDatabase(filename, { tables: [parents, children, leaves], readOnly: true, traceValues: true });
  assert.deepEqual(db.planSchema(), []); db.clearTrace();
  return { db, raw, repo: db.table(parents) };
}
function reads(db) { return db.exportTrace().queries.filter(query => query.operation === 'select'); }
function variants(base, count) { return Array.from({ length: count }, (_, index) => [...base].map((letter, bit) => index & (1 << bit) ? letter.toUpperCase() : letter).join('')); }
function childRelation(options = {}) { return hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), ...options }); }

test('correlated hostile-looking text stays bound and internal ordinals never become public fields', t => {
  const phrase = "ordinary quoted ' ? -- code\0tail";
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
    const { db, raw, repo } = fixture(t, ['Alpha', 'alpha', phrase], [{ id: 1, parentCode: 'ALPHA', payload: { __rs_parent: 'ordinary JSON member', nested: ['original'] } }, { id: 2, parentCode: phrase, payload: { __rs_parent: 'another JSON member' } }], [], encoding);
    const expected = raw.prepare('SELECT code,label FROM correlation_parents ORDER BY code').all().map(parent => ({ label: parent.label, matches: raw.prepare('SELECT payload FROM correlation_children WHERE parentCode = ? ORDER BY id').all(parent.code).map(row => ({ payload: JSON.parse(row.payload) })) }));
    const actual = repo.findMany({ select: ['label'], include: { matches: childRelation({ select: ['payload'] }) } });
    assert.deepEqual(actual, expected);
    for (const row of actual) {
      assert.deepEqual(Object.keys(row), ['label', 'matches']);
      row.matches.forEach(child => assert.deepEqual(Object.keys(child), ['payload']));
    }
    actual[0].matches[0].payload.nested[0] = 'changed';
    assert.equal(actual[1].matches[0].payload.nested[0], 'original');
    const query = reads(db).find(row => row.table === children.name);
    assert.ok(query.sql.startsWith('WITH ')); assert.ok(!query.sql.includes(phrase));
    assert.deepEqual(query.parameters.slice(0, 3), raw.prepare('SELECT code FROM correlation_parents ORDER BY code').all().map(row => row.code));
    assert.equal(raw.prepare('SELECT count(*) AS n FROM correlation_children').get().n, 2);
  }
});

test('correlation flags and key arrays are captured safely without configurable ordinal or getter execution', () => {
  const table = { name: 'correlation_children', columns: ['id', 'parentCode'], primaryKey: ['id'], kinds: { id: 'integer', parentCode: 'text' } };
  const input = { table, columns: ['id', 'parentCode'], partitionBy: 'parentCode', keys: ["ordinary ' ? -- row", 'Other'], correlateKeys: true, orderBy: [], offset: 0, limit: 1, readLimit: 3 };
  let calls = 0;
  const proxy = new Proxy(input, { get(object, key, receiver) { calls++; return key === 'correlateKeys' ? false : Reflect.get(object, key, receiver); } });
  const output = compileSqlite(queryModel.relation(proxy));
  assert.equal(calls, 0); assert.ok(output.sql.startsWith('WITH '));
  assert.deepEqual(output.parameters, [...input.keys, 0, 1, 3]);
  assert.ok(!output.sql.includes(input.keys[0]));
  const getter = { ...input }; Object.defineProperty(getter, 'correlateKeys', { get() { calls++; return true; } });
  const keys = [...input.keys]; Object.defineProperty(keys, 'map', { get() { calls++; return Array.prototype.map; }, enumerable: false });
  for (const bad of [getter, { ...input, keys }, { ...input, keys: Array(401).fill('ordinary') }, { ...input, keys: ['ordinary', 2n] }, { ...input, correlateKeys: new Boolean(true) }, { ...input, __rs_parent: 'id' }, { ...input, parentOrdinal: 0 }]) {
    assert.throws(() => queryModel.relation(bad), coded('QUERY'));
  }
  assert.equal(calls, 0);
});

test('equivalent keys crossing a second batch cannot evade the expanded result budget', t => {
  const base = 'abcdefghi';
  const { db, repo } = fixture(t, variants(base, 405), Array.from({ length: 25 }, (_, index) => ({ id: index + 1, parentCode: base })));
  const include = { matches: childRelation({ select: ['id'], limit: 25 }) };
  const accepted = repo.findMany({ select: ['code'], limit: 400, include });
  assert.equal(accepted.reduce((sum, row) => sum + row.matches.length, 0), 10000);
  db.clearTrace();
  assert.throws(() => repo.findMany({ select: ['code'], limit: 405, include }), coded('RESULT_LIMIT'));
  const queries = reads(db);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries.slice(1).map(query => query.rowCount), [10000, 1]);
});

test('late-batch singular ambiguity rejects before nested queries and filtering can resolve it', t => {
  const codes = [...Array.from({ length: 400 }, (_, index) => 'parent' + String(index).padStart(4, '0')), 'z ambiguous'];
  const { db, repo } = fixture(t, codes, [{ id: 1, parentCode: 'z ambiguous' }, { id: 2, parentCode: 'Z AMBIGUOUS' }], [{ id: 1 }]);
  const nested = hasMany(leaves, { localKey: children.col('shared'), foreignKey: leaves.col('shared'), select: ['label'] });
  const relation = options => hasOne(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['id'], include: { leaves: nested }, ...options });
  assert.throws(() => repo.findMany({ limit: 401, select: ['code'], include: { match: relation({}) } }), coded('RELATION_CARDINALITY'));
  assert.equal(reads(db).length, 3);
  assert.equal(reads(db).filter(query => query.table === leaves.name).length, 0);
  db.clearTrace();
  const rows = repo.findMany({ limit: 401, select: ['code'], include: { match: relation({ where: eq(children.col('id'), 1) }) } });
  assert.equal(rows.filter(row => row.match !== null).length, 1);
  assert.deepEqual(rows.at(-1), { code: 'z ambiguous', match: { id: 1, leaves: [{ label: 'Leaf' }] } });
  assert.equal(reads(db).length, 4);
});

test('nested collation matches retain the separate returned-copy budget after physical-key deduplication', t => {
  const { db, repo } = fixture(t, variants('abcdef', 50), [{ id: 1, parentCode: 'abcdef' }, { id: 2, parentCode: 'ABCDEF' }], Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })));
  const nested = hasMany(leaves, { localKey: children.col('shared'), foreignKey: leaves.col('shared'), select: ['id'], limit: 100 });
  const include = { matches: childRelation({ select: ['id'], include: { leaves: nested }, limit: 2 }) };
  const accepted = repo.findMany({ select: ['code'], limit: 49, include });
  assert.equal(accepted.length, 49); assert.equal(accepted[0].matches[0].leaves.length, 100);
  db.clearTrace();
  assert.throws(() => repo.findMany({ select: ['code'], limit: 50, include }), coded('RESULT_LIMIT'));
  assert.equal(reads(db).length, 3);
  assert.deepEqual(reads(db).slice(1).map(query => query.rowCount), [100, 100]);
});
