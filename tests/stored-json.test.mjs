import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { column, defineTable, openDatabase, eq, hasMany, RowstitchError } from '../dist/index.js';
import { decode } from '../dist/core/schema.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const maxCharacters = 1_048_576;
const records = defineTable('records', { id: column.integer().primaryKey(), body: column.json() });
const checked = defineTable('checked_records', { id: column.integer().primaryKey(), body: column.json() });
const nullable = defineTable('nullable_records', { id: column.integer().primaryKey(), body: column.json().nullable() });
const parents = defineTable('parents', { id: column.integer().primaryKey(), label: column.text() });
const children = defineTable('children', { id: column.integer().primaryKey(), parentId: column.integer(), body: column.json() });
const grandchildren = defineTable('grandchildren', { id: column.integer().primaryKey(), childId: column.integer(), label: column.text() });
const models = [records, checked, nullable, parents, children, grandchildren];

function fixture(t, rows = {}) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-stored-json-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  const filename = join(directory, 'fictional.sqlite'); let native; let db;
  t.after(() => { native?.close(); db?.close(); unlinkSync(filename); rmdirSync(directory); });
  native = new DatabaseSync(filename, { allowExtension: false, defensive: true }); native.enableDefensive(true);
  native.exec(`CREATE TABLE records(id INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id));
    CREATE TABLE checked_records(id INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(id));
    CREATE TABLE nullable_records(id INTEGER NOT NULL, body TEXT, PRIMARY KEY(id));
    CREATE TABLE parents(id INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY(id));
    CREATE TABLE children(id INTEGER NOT NULL, parentId INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id));
    CREATE TABLE grandchildren(id INTEGER NOT NULL, childId INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY(id));`);
  for (const [name, values] of Object.entries(rows)) {
    assert.ok(models.some(model => model.name === name));
    if (values.length) {
      const statement = native.prepare('INSERT INTO "' + name + '" VALUES (' + values[0].map(() => '?').join(',') + ')');
      for (const row of values) statement.run(...row);
    }
  }
  native.close(); native = undefined;
  db = openDatabase(filename, { tables: models, readOnly: true });
  assert.deepEqual(db.planSchema(), []);
  return { db, repo: db.table(records), checkedRepo: db.table(checked) };
}
function read(repo, id) { return repo.findFirst({ where: eq(repo.definition.col('id'), id) }); }
function selections(db) { return db.exportTrace().queries.filter(query => query.operation === 'select'); }
function nested(depth) { return '['.repeat(depth) + '0' + ']'.repeat(depth); }

test('stored valid JSON cannot introduce non-finite numbers even when SQLite json_valid accepts it', t => {
  const { db, checkedRepo } = fixture(t, { checked_records: [[1, '{"measurement":1e400}'], [2, '{"measurement":-1e400}'], [3, '[0,1e400]']] });
  for (const id of [1, 2, 3]) {
    db.clearTrace();
    assert.throws(() => read(checkedRepo, id), coded('DATA'));
    assert.equal(selections(db).length, 1);
  }
  assert.equal(checkedRepo.count(), 3);
});

test('stored JSON checks its raw character limit before parsing and accepts the exact boundary', t => {
  const valid = JSON.stringify('x'.repeat(maxCharacters - 2));
  const invalid = JSON.stringify('x'.repeat(maxCharacters - 1));
  assert.equal(valid.length, maxCharacters); assert.equal(invalid.length, maxCharacters + 1);
  const { repo } = fixture(t, { records: [[1, valid], [2, invalid]] });
  assert.equal(read(repo, 1).body.length, maxCharacters - 2);
  const parse = JSON.parse; let calls = 0;
  try {
    JSON.parse = function (...args) { calls++; return Reflect.apply(parse, this, args); };
    assert.throws(() => read(repo, 2), coded('DATA'));
  } finally { JSON.parse = parse; }
  assert.equal(calls, 0, 'Do not parse stored JSON already known to exceed the data bound.');
});

test('stored depth limits reject before materialization can overflow and leave the connection usable', t => {
  const { repo, db } = fixture(t, { records: [[1, nested(64)], [2, nested(65)], [3, nested(5000)]] });
  let value = read(repo, 1).body, depth = 0; while (Array.isArray(value)) { depth++; value = value[0]; }
  assert.equal(depth, 64); assert.equal(value, 0);
  for (const id of [2, 3]) {
    db.clearTrace();
    assert.throws(() => read(repo, id), coded('DATA'));
    assert.equal(selections(db).length, 1);
  }
  assert.equal(repo.count(), 3);
});

test('stored JSON node count accepts one hundred thousand total nodes and rejects the next', t => {
  const valid = '[' + Array(99_999).fill('0').join(',') + ']';
  const invalid = '[' + Array(100_000).fill('0').join(',') + ']';
  const { repo } = fixture(t, { records: [[1, valid], [2, invalid]] });
  assert.equal(read(repo, 1).body.length, 99_999);
  assert.throws(() => read(repo, 2), coded('DATA'));
});

test('root projection does not decode unselected JSON and failed decode performs no follow-up queries', t => {
  const { repo, db } = fixture(t, { records: [[1, '{"ordinary":1e400}'], [2, '{"valid":true}']] });
  db.clearTrace();
  assert.deepEqual(repo.findMany({ select: ['id'] }), [{ id: 1 }, { id: 2 }]);
  assert.equal(selections(db).length, 1);
  db.clearTrace();
  assert.throws(() => repo.findMany(), coded('DATA'));
  assert.equal(selections(db).length, 1);
  assert.deepEqual(read(repo, 2).body, { valid: true });
});

test('child JSON fails before deeper relation queries while a projection can omit the invalid field', t => {
  const { db } = fixture(t, { parents: [[1, 'Parent']], children: [[1, 1, '{"ordinary":1e400}']], grandchildren: [[1, 1, 'Leaf']] });
  const leaves = hasMany(grandchildren, { localKey: children.col('id'), foreignKey: grandchildren.col('childId'), select: ['label'] });
  const parentRepo = db.table(parents);
  db.clearTrace();
  assert.throws(() => parentRepo.findMany({ select: ['label'], include: { children: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), select: ['body'], include: { leaves } }) } }), coded('DATA'));
  assert.equal(selections(db).length, 2);
  db.clearTrace();
  assert.deepEqual(parentRepo.findMany({ select: ['label'], include: { children: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), select: ['id'], include: { leaves } }) } }), [{ label: 'Parent', children: [{ id: 1, leaves: [{ label: 'Leaf' }] }] }]);
  assert.equal(selections(db).length, 3);
});

test('JSON literal null remains valid data and SQL NULL still follows column nullability', t => {
  const body = { nested: [false, null, { message: 'ordinary words 🧵', nul: '\0' }] };
  const { db, repo } = fixture(t, { records: [[1, 'null'], [2, 'false'], [3, '0'], [4, JSON.stringify(body)]], nullable_records: [[1, null], [2, 'null']] });
  assert.equal(read(repo, 1).body, null);
  assert.equal(read(repo, 2).body, false);
  assert.equal(read(repo, 3).body, 0);
  assert.deepEqual(read(repo, 4).body, body);
  assert.equal(read(db.table(nullable), 1).body, null);
  assert.equal(read(db.table(nullable), 2).body, null);
  assert.throws(() => decode(column.json().config, null), coded('DATA'));
  assert.equal(decode(column.json().nullable().config, null), null);
});

test('shared JSON validation keeps existing write errors and valid boundary values unchanged', t => {
  const db = openDatabase(':memory:', { tables: [records] }); t.after(() => db.close()); db.ensureSchema();
  const repo = db.table(records);
  const invalid = [{ value: Infinity }, { value: -Infinity }, JSON.parse(nested(65)), Array(100_000).fill(0), 'x'.repeat(maxCharacters - 1)];
  for (const body of invalid) assert.throws(() => repo.insert({ id: 1, body }), coded('VALIDATION'));
  assert.equal(repo.count(), 0);
  assert.deepEqual(repo.insert({ id: 1, body: { value: Number.MAX_VALUE, nested: [null, true] } }).body, { value: Number.MAX_VALUE, nested: [null, true] });
  assert.equal(repo.insert({ id: 2, body: 'x'.repeat(maxCharacters - 2) }).body.length, maxCharacters - 2);
  assert.throws(() => repo.insert({ id: 3, body: null }), coded('VALIDATION'));
});

test('malformed stored JSON and wrong storage classes produce private generic DATA errors', t => {
  const fixturePhrase = 'ordinary fictional row contents';
  const { repo, db } = fixture(t, { records: [[1, '{"' + fixturePhrase + '":'], [2, Buffer.from(fixturePhrase)]] });
  for (const id of [1, 2]) {
    db.clearTrace(); let failure;
    try { read(repo, id); } catch (error) { failure = error; }
    assert.ok(coded('DATA')(failure));
    assert.ok(!failure.message.includes(fixturePhrase));
    const document = db.exportTrace();
    assert.equal(document.queries.length, 1);
    assert.ok(!JSON.stringify(document).includes(fixturePhrase));
    assert.equal(repo.count(), 2);
  }
});
