import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, eq, desc } from '../dist/index.js';
import { queryModel } from '../dist/core/query-model.js';
import { compileSqlite } from '../dist/core/sqlite-compiler.js';

const encodings = ['UTF-8', 'UTF-16le', 'UTF-16be'];
function fixture(t, { encoding = 'UTF-8', parentCollation = 'BINARY', childCollation = 'NOCASE', parentRows = [], childRows = [], noteRows = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-text-relations-'));
  const filename = join(directory, 'fictional.sqlite');
  const raw = new DatabaseSync(filename, { enableExtensions: false });
  let db;
  t.after(() => {
    try { db?.close(); } finally { try { raw.close(); } finally {
      const target = resolve(directory); assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('rowstitch-text-relations-'));
      rmSync(target, { recursive: true, force: true });
    } }
  });
  raw.exec("PRAGMA encoding='" + encoding + "'; PRAGMA foreign_keys=ON");
  raw.exec('CREATE TABLE parents(code TEXT NOT NULL COLLATE ' + parentCollation + ', label TEXT NOT NULL, PRIMARY KEY(code));'
    + 'CREATE TABLE children(id INTEGER NOT NULL, parentCode TEXT COLLATE ' + childCollation + ' REFERENCES parents(code) ON DELETE NO ACTION, label TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), payload TEXT CHECK(json_valid(payload)), PRIMARY KEY(id));'
    + 'CREATE TABLE notes(id INTEGER NOT NULL, childId INTEGER NOT NULL REFERENCES children(id) ON DELETE NO ACTION, label TEXT NOT NULL, PRIMARY KEY(id))');
  const parentInsert = raw.prepare('INSERT INTO parents VALUES(?,?)');
  for (const row of parentRows) parentInsert.run(row.code, row.label ?? row.code);
  const childInsert = raw.prepare('INSERT INTO children VALUES(?,?,?,?,?,?)');
  for (const row of childRows) childInsert.run(row.id, row.parentCode ?? null, row.label ?? 'Child ' + row.id, row.rank ?? 0, row.active === false ? 0 : 1, row.payload === undefined ? null : JSON.stringify(row.payload));
  const noteInsert = raw.prepare('INSERT INTO notes VALUES(?,?,?)');
  for (const row of noteRows) noteInsert.run(row.id, row.childId, row.label);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  const parents = defineTable('parents', { code: column.text().primaryKey(), label: column.text() });
  const children = defineTable('children', { id: column.integer().primaryKey(), parentCode: column.text().nullable().references(parents, 'code'), label: column.text(), rank: column.integer().default(0), active: column.boolean().default(true), payload: column.json().nullable() });
  const notes = defineTable('notes', { id: column.integer().primaryKey(), childId: column.integer().references(children, 'id'), label: column.text() });
  db = openDatabase(filename, { tables: [parents, children, notes], traceValues: true }); db.ensureSchema(); db.clearTrace();
  return { db, raw, parents, children, notes };
}
function selectQueries(db) { return db.exportTrace().queries.filter(query => query.operation === 'select'); }

test('text eager relations agree with native NOCASE/RTRIM/NUL matches in all encodings', t => {
  for (const encoding of encodings) for (const [collation, parent, child] of [['BINARY', 'A', 'A'], ['NOCASE', 'A', 'a'], ['RTRIM', 'key', 'key '], ['NOCASE', 'A\0X', 'a\0Y'], ['NOCASE', 'É😀', 'É😀']]) {
    const { db, raw, parents, children } = fixture(t, { encoding, parentCollation: collation, childCollation: collation, parentRows: [{ code: parent }], childRows: [{ id: 1, parentCode: child }] });
    assert.deepEqual(raw.prepare('SELECT id FROM children WHERE parentCode = ?').all(parent).map(row => row.id), [1]);
    assert.deepEqual(raw.prepare('SELECT code FROM parents WHERE code = ?').all(child).map(row => row.code), [parent]);
    for (const singular of [false, true]) {
      db.clearTrace();
      const relation = (singular ? hasOne : hasMany)(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['id'] });
      const actual = db.table(parents).findMany({ select: ['code'], include: { match: relation } });
      assert.deepEqual(actual, [{ code: parent, match: singular ? { id: 1 } : [{ id: 1 }] }]);
      assert.equal(selectQueries(db).length, 2); assert.equal(selectQueries(db)[1].rowCount, 1);
    }
    db.clearTrace();
    assert.deepEqual(db.table(children).findMany({ select: ['id'], include: { parent: belongsTo(parents, { localKey: children.col('parentCode'), foreignKey: parents.col('code'), select: ['code'] }) } }), [{ id: 1, parent: { code: parent } }]);
    assert.equal(selectQueries(db).length, 2);
  }
});

test('distinct equivalent source keys each get their own filtered, ordered page and hidden projections', t => {
  for (const encoding of encodings) {
    const { db, raw, parents, children } = fixture(t, { encoding, parentRows: [{ code: 'A', label: 'First' }, { code: 'a', label: 'Second' }], childRows: [{ id: 1, parentCode: 'a', rank: 5, label: 'Low' }, { id: 2, parentCode: 'A', rank: 8, label: 'High' }, { id: 3, parentCode: 'a', rank: 2, active: false }] });
    const expected = raw.prepare('SELECT code,label FROM parents ORDER BY code').all().map(parent => ({ label: parent.label, matches: raw.prepare('SELECT label FROM children WHERE parentCode = ? AND active = 1 ORDER BY rank DESC,id LIMIT 1 OFFSET 1').all(parent.code).map(row => ({ ...row })) }));
    const actual = db.table(parents).findMany({ select: ['label'], include: { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), where: eq(children.col('active'), true), orderBy: [desc(children.col('rank'))], select: ['label'], limit: 1, offset: 1 }) } });
    assert.deepEqual(actual, expected); assert.deepEqual(actual.map(row => row.matches), [[{ label: 'Low' }], [{ label: 'Low' }]]);
    assert.equal(selectQueries(db).length, 2);
    assert.deepEqual(selectQueries(db)[1].parameters.slice(0, 6), ['A', 'a', 1, 1, 2, 10001]);
  }
});

test('one target can match several roots without sharing JSON, aliases or nested output', t => {
  const { db, parents, children, notes } = fixture(t, { parentRows: [{ code: 'A' }, { code: 'a' }], childRows: [{ id: 1, parentCode: 'a', payload: { value: 'Original' } }], noteRows: [{ id: 1, childId: 1, label: 'Original note' }] });
  const relation = hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['payload'], include: { notes: hasMany(notes, { localKey: children.col('id'), foreignKey: notes.col('childId'), select: ['label'] }) } });
  const rows = db.table(parents).findMany({ select: ['code'], include: { left: relation, right: relation } });
  assert.equal(rows[0].left.length, 1); assert.equal(rows[1].left.length, 1);
  rows[0].left[0].payload.value = 'Changed'; rows[0].left[0].notes[0].label = 'Changed note';
  assert.equal(rows[1].left[0].payload.value, 'Original'); assert.equal(rows[0].right[0].payload.value, 'Original');
  assert.equal(rows[1].left[0].notes[0].label, 'Original note'); assert.equal(rows[0].right[0].notes[0].label, 'Original note');
});

test('singular cardinality checks count all collation matches for each source key', t => {
  for (const encoding of encodings) {
    const { db, parents, children } = fixture(t, { encoding, parentCollation: 'NOCASE', parentRows: [{ code: 'Aa' }], childRows: [{ id: 1, parentCode: 'AA' }, { id: 2, parentCode: 'aa' }] });
    for (const make of [hasOne, belongsTo]) assert.throws(() => db.table(parents).findMany({ include: { ambiguous: make(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode') }) } }), error => error.code === 'RELATION_CARDINALITY');
  }
});

test('ordinal correlation crosses the 400-key boundary with one relation query per batch', t => {
  const parentRows = Array.from({ length: 405 }, (_, index) => ({ code: 'Key' + String(index).padStart(4, '0') }));
  const childRows = parentRows.map((row, index) => ({ id: index + 1, parentCode: row.code.toLowerCase() }));
  const { db, parents, children } = fixture(t, { parentCollation: 'NOCASE', parentRows, childRows });
  const rows = db.table(parents).findMany({ include: { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['id'], limit: 1 }) } });
  assert.equal(rows.length, 405); rows.forEach((row, index) => assert.deepEqual(row.matches, [{ id: index + 1 }]));
  assert.equal(selectQueries(db).length, 3); assert.equal(selectQueries(db).filter(query => query.sql.startsWith('WITH ')).length, 2);
});

test('NULL and empty roots or zero child limit do not query correlated targets', t => {
  const { db, parents, children } = fixture(t, { parentRows: [{ code: 'A' }], childRows: [{ id: 1, parentCode: null }] });
  assert.deepEqual(db.table(children).findMany({ select: ['id'], include: { parent: belongsTo(parents, { localKey: children.col('parentCode'), foreignKey: parents.col('code') }) } }), [{ id: 1, parent: null }]);
  assert.equal(selectQueries(db).length, 1); db.clearTrace();
  assert.deepEqual(db.table(parents).findMany({ where: eq(parents.col('code'), 'Missing'), include: { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode') }) } }), []);
  assert.equal(selectQueries(db).length, 1); db.clearTrace();
  assert.deepEqual(db.table(parents).findMany({ select: ['code'], include: { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), limit: 0 }) } }), [{ code: 'A', matches: [] }]);
  assert.equal(selectQueries(db).length, 1);
});

test('numeric-looking text keys retain native text affinity rather than matching prefixes', t => {
  const codes = ['01', '1', '1.0', '1e0', '1suffix'];
  const { db, parents, children } = fixture(t, { childCollation: 'BINARY', parentRows: codes.map(code => ({ code })), childRows: [{ id: 1, parentCode: '1' }] });
  const rows = db.table(parents).findMany({ select: ['code'], include: { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['id'] }) } });
  assert.deepEqual(rows, codes.map(code => ({ code, matches: code === '1' ? [{ id: 1 }] : [] })));
});

test('correlated matches count toward bounded graph work and returned copies', t => {
  const base = 'abcdefg';
  const parentRows = Array.from({ length: 101 }, (_, index) => ({ code: [...base].map((letter, bit) => index & (1 << bit) ? letter.toUpperCase() : letter).join('') }));
  const { db, parents, children } = fixture(t, { parentRows, childRows: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, parentCode: base })) });
  const include = { matches: hasMany(children, { localKey: parents.col('code'), foreignKey: children.col('parentCode'), select: ['id'], limit: 100 }) };
  const atLimit = db.table(parents).findMany({ limit: 100, include });
  assert.equal(atLimit.reduce((sum, row) => sum + row.matches.length, 0), 10000);
  assert.throws(() => db.table(parents).findMany({ limit: 101, include }), error => error.code === 'RESULT_LIMIT');
});

test('correlated relation models validate flags, metadata, keys and binding order', () => {
  const table = { name: 'children', columns: ['id', 'parentCode', 'label'], primaryKey: ['id'], kinds: { id: 'integer', parentCode: 'text', label: 'text' } };
  const input = { table, columns: ['id', 'parentCode'], partitionBy: 'parentCode', keys: ['A', 'a'], correlateKeys: true, where: { kind: 'compare', column: 'label', operator: '=', values: ["Fictional ' OR 1=1 --"] }, orderBy: [{ column: 'id', direction: 'DESC' }], offset: 1, limit: 2, readLimit: 7 };
  const compiled = compileSqlite(queryModel.relation(input));
  assert.deepEqual(compiled.parameters, ['A', 'a', "Fictional ' OR 1=1 --", 1, 3, 7]);
  assert(!compiled.sql.includes('Fictional')); assert(compiled.sql.includes('ON "parentCode" = "__rs_keys"."__rs_key"'));
  assert(compiled.sql.includes('PARTITION BY "__rs_keys"."__rs_ordinal"')); assert(compiled.sql.includes('AS "__rs_parent"'));
  for (const correlateKeys of ['true', 1, null, {}]) assert.throws(() => queryModel.relation({ ...input, correlateKeys }), error => error.code === 'QUERY');
  for (const [change, code] of [[{ table: { ...table, kinds: undefined } }, 'SCHEMA'], [{ keys: ['A', 1] }, 'QUERY'], [{ table: { ...table, kinds: { ...table.kinds, parentCode: 'json' } } }, 'QUERY'], [{ parentOrdinal: 'id' }, 'QUERY']]) assert.throws(() => queryModel.relation({ ...input, ...change }), error => error.code === code);
  let calls = 0; const getter = { ...input }; Object.defineProperty(getter, 'correlateKeys', { get() { calls++; return true; }, enumerable: true });
  assert.throws(() => queryModel.relation(getter), error => error.code === 'QUERY'); assert.equal(calls, 0);
  const numeric = compileSqlite(queryModel.relation({ table: { name: 'numeric_rows', columns: ['id', 'fk'], primaryKey: ['id'], kinds: { id: 'integer', fk: 'integer' } }, columns: ['id', 'fk'], partitionBy: 'fk', keys: [1, 2], orderBy: [], offset: 0, limit: 2, readLimit: 101 }));
  assert(!numeric.sql.startsWith('WITH ')); assert.deepEqual(numeric.parameters, [1, 2, 0, 2, 101]);
});
