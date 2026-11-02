import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as orm from '../dist/index.js';
import { queryModel, tableModel, predicateModel } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate } from '../dist/core/sqlite-compiler.js';
import { Predicate, ManyRelation } from '../dist/core/predicates.js';

const { column, defineTable, openDatabase, eq, and, or, not, isNull, inArray, asc } = orm;
const coded = code => error => error instanceof orm.RowstitchError && error.code === code;
const modelTable = () => tableModel({ name: 'literal_records', columns: ['id', 'label', 'rank'], primaryKey: ['id'] });
const modelText = (changes = {}) => ({ kind: 'text-match', column: 'label', mode: 'contains', case: 'sensitive', literal: 'M3_SYNTHETIC_739', ...changes });
const asciiLower = text => text.replace(/[A-Z]/g, character => character.toLowerCase());
const ids = (repo, where) => repo.findMany({ where, select: ['id'], orderBy: [asc(repo.definition.col('id'))] }).map(row => row.id);
const helpers = () => [['contains', orm.contains, 'includes'], ['startsWith', orm.startsWith, 'startsWith'], ['endsWith', orm.endsWith, 'endsWith']];

function memory(t, options = {}) {
  const records = defineTable('literal_records', {
    id: column.integer().primaryKey(), label: column.text().nullable(), rank: column.integer().default(0),
    amount: column.bigint().nullable(), score: column.real().nullable(), flag: column.boolean().default(false),
    metadata: column.json().default({ fictional: true }), version: column.integer().default(0),
  }, { version: 'version' });
  const db = openDatabase(':memory:', { tables: [records], maxTraceEntries: 1000, ...options });
  db.ensureSchema(); t.after(() => db.close());
  return { db, records, repo: db.table(records) };
}

test('all four literal expression helpers are exported as usable functions', () => {
  for (const name of ['contains', 'startsWith', 'endsWith', 'between']) assert.equal(typeof orm[name], 'function', name);
});

test('literal search and NOT agree with an independent string oracle, including NULL and NUL', t => {
  const { records, repo } = memory(t);
  const values = [null, '', 'Alpha %_! tail', 'alpha %_! TAIL', 'before\0AFTER', '%_!', "quote'\" ? \\ [x]", '🧵æ tail', 'Æ É', 'é ß', 'a\u0301', 'á', 'no match'];
  repo.insertMany(values.map((label, index) => ({ id: index + 1, label })));
  const needles = ['Alpha', 'alpha', '%_!', '\0', 'AFTER', 'tail', "'\" ?", '\\', '[x]', '🧵æ', 'æ', 'é', 'a\u0301'];
  for (const [name, helper, method] of helpers()) {
    for (const mode of ['sensitive', 'ascii-insensitive']) {
      for (const needle of needles) {
        const search = mode === 'sensitive' ? needle : asciiLower(needle);
        const truth = values.map(value => value === null ? null : (mode === 'sensitive' ? value : asciiLower(value))[method](search));
        const predicate = helper(records.col('label'), needle, { case: mode });
        assert.deepEqual(ids(repo, predicate), truth.flatMap((value, index) => value === true ? [index + 1] : []), name + '/' + mode + '/' + JSON.stringify(needle));
        assert.deepEqual(ids(repo, not(predicate)), truth.flatMap((value, index) => value === false ? [index + 1] : []));
        assert.equal(repo.count(predicate), truth.filter(value => value === true).length);
      }
    }
  }
  assert.deepEqual(ids(repo, or(isNull(records.col('label')), orm.contains(records.col('label'), 'tail'))), [1, 3, 8]);
  assert.deepEqual(ids(repo, and(not(isNull(records.col('label'))), not(orm.endsWith(records.col('label'), 'tail')))), [2, 4, 5, 6, 7, 9, 10, 11, 12, 13]);
});

test('real existing UTF-16 files avoid unaligned byte matches and preserve suffix NULL/NOT semantics', t => {
  const tempRoot = resolve(tmpdir());
  const fixtures = mkdtempSync(join(tempRoot, 'rowstitch-literal-'));
  assert.ok(resolve(fixtures).startsWith(tempRoot + sep));
  t.after(() => rmdirSync(fixtures));
  const values = ['\u6101\u0100', '\u0100\u6101', 'BEFORE\0AFTER', '', '🧵æ suffix', null, '100%_! literal'];
  for (const [name, pragma] of [['utf8', "PRAGMA encoding='UTF-8'"], ['utf16le', "PRAGMA encoding='UTF-16le'"], ['utf16be', "PRAGMA encoding='UTF-16be'"]]) {
    const filename = join(fixtures, name + '.sqlite');
    let native; let db;
    try {
      native = new DatabaseSync(filename, { allowExtension: false, defensive: true }); native.enableDefensive(true);
      native.exec(pragma);
      native.exec('CREATE TABLE expression_encoding (id INTEGER NOT NULL, label TEXT, PRIMARY KEY (id))');
      const insert = native.prepare('INSERT INTO expression_encoding VALUES (?, ?)');
      values.forEach((value, index) => insert.run(index + 1, value));
      native.close(); native = undefined;
      const mapped = defineTable('expression_encoding', { id: column.integer().primaryKey(), label: column.text().nullable() });
      db = openDatabase(filename, { tables: [mapped], readOnly: true });
      const repo = db.table(mapped);
      for (const [, helper, method] of helpers()) {
        for (const mode of ['sensitive', 'ascii-insensitive']) {
          for (const needle of ['a', 'AFTER', 'after', '\0', '🧵æ', 'suffix', '%_!']) {
            const search = mode === 'sensitive' ? needle : asciiLower(needle);
            const truth = values.map(value => value === null ? null : (mode === 'sensitive' ? value : asciiLower(value))[method](search));
            const predicate = helper(mapped.col('label'), needle, { case: mode });
            assert.deepEqual(ids(repo, predicate), truth.flatMap((value, index) => value === true ? [index + 1] : []), name + '/' + method + '/' + mode + '/' + JSON.stringify(needle));
            assert.deepEqual(ids(repo, not(predicate)), truth.flatMap((value, index) => value === false ? [index + 1] : []));
          }
        }
      }
    } finally { db?.close(); native?.close(); unlinkSync(filename); }
  }
});

test('new literal needles reject unsupported and malformed data without converting caller objects', t => {
  const { records, repo, db } = memory(t);
  const invalid = ['', null, undefined, false, 3, 3n, [], {}, new String('boxed'), '\uD800', '\uDC00', 'x\uD800y', '\uDC00\uD800', 'x'.repeat(4097)];
  let conversions = 0;
  const object = { toString() { conversions++; return 'M3_COERCED_SECRET'; }, valueOf() { conversions++; return 'x'; } };
  invalid.push(object);
  db.clearTrace();
  for (const [, helper] of helpers()) for (const value of invalid) assert.throws(() => helper(records.col('label'), value), coded('QUERY'));
  assert.equal(conversions, 0);
  assert.deepEqual(db.exportTrace().queries, []);
  for (const [, helper] of helpers()) {
    assert.ok(repo.compileSelect({ where: helper(records.col('label'), 'x'.repeat(4096)) }).parameters.includes('x'.repeat(4096)));
    assert.ok(repo.compileSelect({ where: helper(records.col('label'), 'x'.repeat(4094) + '🧵') }).parameters.includes('x'.repeat(4094) + '🧵'));
  }
  // Existing storage/equality accepts data that the new convenience search deliberately does not.
  repo.insert({ id: 1, label: '' });
  assert.deepEqual(ids(repo, eq(records.col('label'), '')), [1]);
});

test('text codec validation rejects JSON, wrong refs and same-named foreign table identities', t => {
  const { records, repo, db } = memory(t);
  const duplicate = defineTable('literal_records', { id: column.integer().primaryKey(), label: column.text().nullable() });
  let conversions = 0;
  const malformedName = { toString() { conversions++; return 'label'; }, [Symbol.toPrimitive]() { conversions++; return 'label'; } };
  for (const [, helper] of helpers()) {
    const invalidRefs = [() => records.col('rank'), () => records.col('amount'), () => records.col('score'), () => records.col('flag'), () => records.col('metadata'), () => null, () => ({}), () => 'label', () => new orm.ColumnRef(records, 'missing'), () => new orm.ColumnRef(null, 'label'), () => new orm.ColumnRef({}, 'label'), () => new orm.ColumnRef({ columns: { label: null } }, 'label'), () => new orm.ColumnRef(records, malformedName), () => new orm.ColumnRef(records, Symbol('label'))];
    for (const makeRef of invalidRefs) {
      assert.throws(() => helper(makeRef(), 'x'), coded('QUERY'));
    }
    assert.throws(() => repo.compileSelect({ where: helper(duplicate.col('label'), 'x') }), coded('QUERY'));
  }
  assert.equal(conversions, 0);
  assert.equal(db.table(records).count(), 0);
});

test('literal options reject accessors, unknown own fields, unsafe enums and nonplain shapes', t => {
  const { records } = memory(t);
  let calls = 0;
  const accessor = {}; Object.defineProperty(accessor, 'case', { get() { calls++; return 'sensitive'; } });
  const hidden = {}; Object.defineProperty(hidden, 'raw', { value: 'OR 1=1', enumerable: false });
  const symbol = { [Symbol('raw')]: 'not data' };
  const converted = { toString() { calls++; return 'sensitive'; } };
  for (const [, helper] of helpers()) {
    for (const options of [null, [], 'sensitive', Object.create({ case: 'sensitive' }), accessor, hidden, symbol, { raw: 'OR 1=1' }, { case: 'SENSITIVE' }, { case: 'unicode-insensitive' }, { case: "sensitive'); DROP TABLE literal_records; --" }, { case: converted }]) {
      assert.throws(() => helper(records.col('label'), 'x', options), coded('QUERY'));
    }
  }
  assert.equal(calls, 0);
});

test('literal options and forged model Proxies normalize captured descriptors rather than changing gets', t => {
  const { records, repo } = memory(t);
  repo.insertMany([{ id: 1, label: 'Alpha' }, { id: 2, label: 'alpha' }]);
  let optionsGets = 0;
  const options = new Proxy({ case: 'sensitive' }, { get(object, key, receiver) { if (key === 'case') { optionsGets++; return 'ascii-insensitive'; } return Reflect.get(object, key, receiver); } });
  assert.deepEqual(ids(repo, orm.contains(records.col('label'), 'A', options)), [1]);
  assert.equal(optionsGets, 0);
  let modelGets = 0;
  const original = modelText({ mode: 'ends-with', literal: 'M3_BOUND_739' });
  const proxy = new Proxy(original, { get(object, key, receiver) { if (key === 'literal' || key === 'mode' || key === 'case') { modelGets++; return "'); DROP TABLE literal_records; --"; } return Reflect.get(object, key, receiver); } });
  const output = compileSqlitePredicate(modelTable(), proxy);
  assert.deepEqual(output.parameters, ['M3_BOUND_739', 'M3_BOUND_739', 'M3_BOUND_739']);
  assert.ok(!output.sql.includes('M3_BOUND_739') && !output.sql.includes('DROP'));
  assert.equal(modelGets, 0);
});

test('forged literal model leaves cannot add SQL, bypass shape validation or execute getters', () => {
  const table = modelTable();
  let calls = 0;
  const getter = { ...modelText() }; Object.defineProperty(getter, 'literal', { get() { calls++; return 'x'; } });
  const object = { toString() { calls++; return 'contains'; } };
  const hidden = { ...modelText() }; Object.defineProperty(hidden, 'sql', { value: 'OR 1=1', enumerable: false });
  const missingCase = modelText(); delete missingCase.case;
  const invalid = [getter, hidden, missingCase, modelText({ case: undefined }), modelText({ raw: 'OR 1=1' }), modelText({ column: 'missing' }), modelText({ column: 'label); DROP TABLE literal_records' }), modelText({ mode: object }), modelText({ mode: 'LIKE' }), modelText({ case: object }), modelText({ literal: object }), modelText({ literal: '' }), modelText({ literal: '\uD800' }), modelText({ literal: 'x'.repeat(4097) })];
  for (const node of invalid) assert.throws(() => compileSqlitePredicate(table, node), error => error instanceof orm.RowstitchError && ['QUERY', 'SCHEMA'].includes(error.code));
  assert.equal(calls, 0);
  const source = modelText(); const normalized = predicateModel(table, source); source.literal = 'MUTATED';
  assert.ok(Object.isFrozen(normalized));
  assert.deepEqual(compileSqlitePredicate(table, normalized).parameters, ['M3_SYNTHETIC_739']);
});

test('literal data remains bound and duplicated suffix parameters retain nested query ordering', t => {
  const { records, repo } = memory(t);
  const needle = "M3_PRIVATE_739 %_! ' ? -- \0 🧵";
  const where = and(eq(records.col('rank'), 7), orm.between(records.col('amount'), 10n, 20n), orm.endsWith(records.col('label'), needle, { case: 'ascii-insensitive' }));
  const query = repo.compileSelect({ select: ['id'], where, limit: 3, offset: 2 });
  assert.deepEqual(query.parameters, [7, 10n, 20n, needle, needle, needle, 3, 2]);
  assert.ok(!query.sql.includes('M3_PRIVATE_739') && !query.sql.includes(needle));
  assert.equal((query.sql.match(/\?/g) ?? []).length, query.parameters.length);
  assert.ok(!query.sql.includes(' LIKE ') && !query.sql.includes(' GLOB '));
  const plan = queryModel.select({ table: modelTable(), columns: ['id'], where: modelText({ literal: needle }), orderBy: [], limit: 1, offset: 0 });
  const first = compileSqlite(plan); first.parameters[0] = 'caller mutation';
  assert.equal(compileSqlite(plan).parameters[0], needle);
});

test('actual emitted suffix bindings obey the aggregate ten-thousand predicate bind cap', t => {
  const { records, repo, db } = memory(t);
  const expression = count => and(inArray(records.col('id'), Array.from({ length: count }, (_, index) => index)), ...Array.from({ length: 9 }, () => orm.endsWith(records.col('label'), 'suffix')));
  const accepted = repo.compileSelect({ where: expression(9973) });
  assert.equal(accepted.parameters.length, 10002); // exactly 10,000 predicate binds, followed by LIMIT/OFFSET
  assert.deepEqual(accepted.parameters.slice(-29), [...Array(27).fill('suffix'), 1000, 0]);
  db.clearTrace();
  assert.throws(() => repo.findMany({ where: expression(9974) }), coded('QUERY'));
  assert.deepEqual(db.exportTrace().queries, []);
});

test('BETWEEN lowering preserves the existing predicate node and depth budgets', t => {
  const { records, repo } = memory(t);
  const range = () => orm.between(records.col('rank'), 1, 2);
  assert.ok(repo.compileSelect({ where: and(...Array.from({ length: 33 }, range)) }).sql.includes('WHERE'));
  assert.throws(() => repo.compileSelect({ where: and(...Array.from({ length: 34 }, range)) }), coded('QUERY'));
  let valid = range(); for (let index = 0; index < 15; index++) valid = not(valid);
  assert.ok(repo.compileSelect({ where: valid }).sql.includes('WHERE'));
  assert.throws(() => repo.compileSelect({ where: not(valid) }), coded('QUERY'));
});

test('guarded writes are atomic and one captured literal expression drives count and mutation', t => {
  const { records, repo, db } = memory(t, { traceValues: true });
  repo.insertMany([{ id: 1, label: 'first-tail' }, { id: 2, label: 'second-tail' }, { id: 3, label: 'other' }, { id: 4, label: null }]);
  const suffix = orm.endsWith(records.col('label'), 'tail');
  assert.throws(() => repo.update({ label: 'bad' }, { where: suffix, maxRows: 1 }), coded('AFFECTED_ROWS'));
  assert.deepEqual(ids(repo, suffix), [1, 2]);
  assert.throws(() => repo.delete({ where: suffix, maxRows: 1 }), coded('AFFECTED_ROWS'));
  assert.equal(repo.count(), 4);
  const narrow = and(eq(records.col('id'), 1), suffix);
  let whereReads = 0;
  const options = new Proxy({ where: narrow, maxRows: 1 }, { get(object, key, receiver) { if (key === 'where') return ++whereReads === 1 ? narrow : suffix; return Reflect.get(object, key, receiver); } });
  db.clearTrace();
  assert.deepEqual(repo.update({ label: 'changed' }, options).map(row => [row.id, row.version]), [[1, 1]]);
  assert.equal(whereReads, 1);
  const trace = db.exportTrace().queries;
  assert.deepEqual(trace.find(query => query.sql.startsWith('SELECT count')).parameters, [1, 'tail', 'tail', 'tail']);
  assert.deepEqual(trace.find(query => query.operation === 'update').parameters, ['changed', 1, 'tail', 'tail', 'tail']);
  assert.equal(repo.findFirst({ where: eq(records.col('id'), 2) }).label, 'second-tail');
  assert.deepEqual(repo.delete({ where: and(suffix, orm.between(records.col('rank'), 0, 0)), maxRows: 1 }).map(row => row.id), [2]);
  assert.equal(repo.count(), 3);
});

test('default trace, errors and EXPLAIN do not reveal new secret needles or bounds', t => {
  const { records, repo, db } = memory(t);
  const fixtureText = "fictional trace phrase ' ? -- \0";
  repo.insert({ id: 1, label: fixtureText }); db.clearTrace();
  const where = or(orm.contains(records.col('label'), fixtureText), orm.endsWith(records.col('label'), fixtureText), orm.between(records.col('label'), fixtureText, fixtureText + 'z'));
  assert.deepEqual(ids(repo, where), [1]);
  repo.explain({ where });
  const trace = db.exportTrace();
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes('fictional trace phrase'));
  assert.ok(trace.queries.flatMap(query => query.parameters).every(value => value === '[redacted]'));
  assert.ok(trace.queries.every(query => !query.sql.includes('fictional trace phrase')));
  let error; try { orm.contains(records.col('label'), { toString() { return fixtureText; } }); } catch (caught) { error = caught; }
  assert.ok(coded('QUERY')(error));
  assert.ok(!error.message.includes('fictional trace phrase'));
});

test('relation where uses literal filters without exposing hidden projection fields or multiplying queries', t => {
  const parents = defineTable('literal_parents', { id: column.integer().primaryKey(), title: column.text() });
  const children = defineTable('literal_children', { id: column.integer().primaryKey(), parentId: column.integer(), label: column.text().nullable(), secret: column.text() });
  const db = openDatabase(':memory:', { tables: [parents, children] }); t.after(() => db.close()); db.ensureSchema();
  db.table(parents).insertMany([{ id: 1, title: 'First' }, { id: 2, title: 'Second' }]);
  db.table(children).insertMany([{ id: 1, parentId: 1, label: 'prefix\0tail', secret: 'FICTIONAL_HIDDEN' }, { id: 2, parentId: 1, label: 'other', secret: 'FICTIONAL_HIDDEN' }, { id: 3, parentId: 2, label: 'tail', secret: 'FICTIONAL_HIDDEN' }]);
  db.clearTrace();
  const rows = db.table(parents).findMany({ select: ['title'], include: { matches: orm.hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: orm.endsWith(children.col('label'), 'tail'), select: ['label'] }) } });
  assert.deepEqual(rows, [{ title: 'First', matches: [{ label: 'prefix\0tail' }] }, { title: 'Second', matches: [{ label: 'tail' }] }]);
  assert.equal(db.exportTrace().queries.filter(query => query.operation === 'select').length, 2);
});

test('BETWEEN is inclusive, typed and exact at int64 boundaries while NULL and NOT retain SQL semantics', t => {
  const { records, repo } = memory(t);
  const max = 2n ** 63n - 1n;
  repo.insertMany([{ id: 1, label: 'a', rank: 1, amount: max - 1n, score: -0.5 }, { id: 2, label: 'b', rank: 2, amount: max, score: 0.5 }, { id: 3, label: null, rank: 3, amount: null, score: null }, { id: 4, label: 'c', rank: 4, amount: -(2n ** 63n), score: 1.5 }]);
  assert.deepEqual(ids(repo, orm.between(records.col('amount'), max - 1n, max)), [1, 2]);
  assert.deepEqual(ids(repo, orm.between(records.col('amount'), max, max)), [2]);
  assert.deepEqual(ids(repo, orm.between(records.col('amount'), max, max - 1n)), []);
  assert.deepEqual(ids(repo, not(orm.between(records.col('amount'), max, max - 1n))), [1, 2, 4]);
  assert.deepEqual(ids(repo, orm.between(records.col('score'), -0.5, 0.5)), [1, 2]);
  assert.deepEqual(ids(repo, orm.between(records.col('rank'), 1, 2)), [1, 2]);
  assert.deepEqual(ids(repo, orm.between(records.col('label'), 'a', 'b')), [1, 2]);
  assert.deepEqual(ids(repo, not(orm.between(records.col('label'), 'z', 'a'))), [1, 2, 4]);
  for (const ref of [records.col('flag'), records.col('metadata')]) assert.throws(() => orm.between(ref, 0, 1), coded('QUERY'));
  for (const values of [[null, 1], [0, null], [undefined, 1], [0, undefined]]) assert.throws(() => orm.between(records.col('rank'), ...values), coded('QUERY'));
  for (const values of [[NaN, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2], ['0', '1']]) assert.throws(() => orm.between(records.col('rank'), ...values), coded('VALIDATION'));
  assert.throws(() => orm.between(records.col('amount'), 0n, 2n ** 63n), coded('VALIDATION'));
  assert.throws(() => orm.between(records.col('rank'), records.col('rank'), 3), coded('VALIDATION'));
});

test('prototype-forged references cannot run volatile table/name getters through any scalar helper', t => {
  const { records, db } = memory(t);
  const consumers = [
    ref => eq(ref, 'not-an-integer'), ref => orm.ne(ref, 'x'), ref => orm.gt(ref, 'a'),
    ref => orm.gte(ref, 'a'), ref => orm.lt(ref, 'z'), ref => orm.lte(ref, 'z'),
    ref => inArray(ref, ['a', 'z']), ref => isNull(ref), ref => orm.between(ref, 'a', 'z'),
    ...helpers().map(([, helper]) => ref => helper(ref, 'literal')),
  ];
  db.clearTrace();
  for (const flipAfter of [1, 2, 3, 4, 5, 6, 8, 10]) {
    for (const consume of consumers) {
      let tableReads = 0, nameReads = 0;
      const forged = Object.create(orm.ColumnRef.prototype, {
        table: { enumerable: true, get() { tableReads++; return records; } },
        name: { enumerable: true, get() { return ++nameReads <= flipAfter ? 'label' : 'rank'; } },
      });
      assert.throws(() => consume(forged), coded('QUERY'));
      assert.equal(tableReads, 0, 'prototype shape must not authenticate a reference');
      assert.equal(nameReads, 0, 'the codec and selected column must not be chosen by a volatile getter');
    }
  }
  const frozenForgery = Object.freeze(Object.create(orm.ColumnRef.prototype, { table: { value: records }, name: { value: 'label' } }));
  for (const consume of consumers) assert.throws(() => consume(frozenForgery), coded('QUERY'));
  assert.deepEqual(db.exportTrace().queries, []);
});

test('Proxy and inherited wrappers of genuine references fail without invoking property or prototype traps', t => {
  const { records, repo, db } = memory(t);
  const genuine = records.col('label');
  const consumers = [ref => eq(ref, 'a'), ref => orm.between(ref, 'a', 'z'), ref => orm.contains(ref, 'a'),
    ref => repo.compileSelect({ orderBy: [asc(ref)] }), ref => repo.compileSelect({ orderBy: [orm.desc(ref)] })];
  db.clearTrace();
  for (const consume of consumers) {
    let traps = 0;
    const wrapper = new Proxy(genuine, {
      get(object, key, receiver) { traps++; return Reflect.get(object, key, receiver); },
      getPrototypeOf(object) { traps++; return Reflect.getPrototypeOf(object); },
      getOwnPropertyDescriptor(object, key) { traps++; return Reflect.getOwnPropertyDescriptor(object, key); },
    });
    assert.throws(() => consume(wrapper), coded('QUERY'));
    assert.equal(traps, 0);
    assert.throws(() => consume(Object.create(genuine)), coded('QUERY'));
    const revoked = Proxy.revocable(genuine, {}); revoked.revoke();
    assert.throws(() => consume(revoked.proxy), coded('QUERY'));
  }
  assert.deepEqual(db.exportTrace().queries, []);
});

test('forged references cannot survive predicate, ordering, relation or mutation lowering', t => {
  const { records, repo, db } = memory(t);
  repo.insert({ id: 1, label: 'kept', rank: 7 });
  let reads = 0;
  const forged = Object.create(orm.ColumnRef.prototype, { table: { get() { reads++; return records; } }, name: { get() { reads++; return 'label'; } } });
  const comparison = new Predicate({ kind: 'comparison', ref: forged, operator: '=', values: ['kept'] });
  const literal = new Predicate({ kind: 'text-match', ref: forged, mode: 'contains', case: 'sensitive', literal: 'kept' });
  const actions = [
    () => repo.compileSelect({ where: comparison }), () => repo.findMany({ where: literal }),
    () => repo.findMany({ orderBy: [{ ref: forged, direction: 'ASC' }] }),
    () => repo.update({ label: 'changed' }, { where: comparison, maxRows: 100 }),
    () => repo.delete({ where: comparison, maxRows: 100 }),
    ...['hasMany', 'hasOne', 'belongsTo'].flatMap(name => [
      () => orm[name](records, { localKey: forged, foreignKey: records.col('id') }),
      () => orm[name](records, { localKey: records.col('id'), foreignKey: forged }),
    ]),
    () => repo.findMany({ include: { forgedRelation: new ManyRelation(records, { localKey: forged, foreignKey: records.col('id') }) } }),
  ];
  for (const action of actions) {
    db.clearTrace();
    assert.throws(action, coded('QUERY'));
    assert.equal(reads, 0);
    assert.deepEqual(db.exportTrace().queries, [], 'invalid references must fail before COUNT/SELECT/BEGIN/mutation');
  }
  assert.equal(repo.count(), 1);
  assert.deepEqual(repo.findFirst({ select: ['label', 'rank', 'version'] }), { label: 'kept', rank: 7, version: 0 });
});

test('genuine direct constructor references preserve codecs, ranges, relations and query-table identity', t => {
  const { records, repo, db } = memory(t);
  repo.insertMany([{ id: 1, label: 'apple', rank: 2 }, { id: 2, label: 'zebra', rank: 3 }]);
  const label = new orm.ColumnRef(records, 'label'), rank = new orm.ColumnRef(records, 'rank');
  assert.deepEqual(ids(repo, eq(label, 'apple')), [1]);
  assert.deepEqual(ids(repo, orm.between(label, 'a', 'b')), [1]);
  assert.deepEqual(ids(repo, orm.between(rank, 2, 3)), [1, 2]);
  assert.deepEqual(ids(repo, orm.contains(label, 'ppl')), [1]);
  assert.deepEqual(repo.findMany({ select: ['id'], orderBy: [orm.desc(rank)] }).map(row => row.id), [2, 1]);
  assert.throws(() => eq(rank, 'not-an-integer'), coded('VALIDATION'));
  const related = repo.findFirst({ where: eq(records.col('id'), 1), select: ['label'], include: { same: orm.hasOne(records, { localKey: new orm.ColumnRef(records, 'id'), foreignKey: new orm.ColumnRef(records, 'id'), select: ['label'] }) } });
  assert.deepEqual(related, { label: 'apple', same: { label: 'apple' } });
  let conversions = 0;
  const badName = { [Symbol.toPrimitive]() { conversions++; return 'label'; }, toString() { conversions++; return 'label'; } };
  for (const consume of [ref => eq(ref, 'x'), ref => orm.between(ref, 'a', 'z'), ref => repo.compileSelect({ orderBy: [asc(ref)] })]) {
    assert.throws(() => consume(new orm.ColumnRef(records, badName)), coded('QUERY'));
  }
  for (const malformed of [badName, Symbol('label'), null, undefined, 3, {}]) {
    assert.throws(() => records.col(malformed), coded('SCHEMA'));
  }
  assert.equal(conversions, 0);
  const duplicate = defineTable('literal_records', { id: column.integer().primaryKey(), label: column.text() });
  db.clearTrace();
  assert.throws(() => repo.compileSelect({ where: eq(new orm.ColumnRef(duplicate, 'label'), 'apple') }), coded('QUERY'));
  assert.throws(() => repo.compileSelect({ where: orm.between(new orm.ColumnRef(duplicate, 'label'), 'a', 'z') }), coded('QUERY'));
  assert.deepEqual(db.exportTrace().queries, []);
});
