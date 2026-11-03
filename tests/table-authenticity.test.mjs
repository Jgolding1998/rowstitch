import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Table, ColumnRef, Repository, RowstitchError, column, defineTable, openDatabase,
  hasMany, hasOne, belongsTo, some, every, eq } from '../dist/index.js';
import { mappedTableModel, mappedCreateTableModel } from '../dist/core/model-mapping.js';

const coded = code => error => error instanceof RowstitchError && error.code === code;
const rejectedMapping = error => error instanceof RowstitchError && ['QUERY', 'SCHEMA'].includes(error.code);

test('a forged table cannot cache a different physical target than the registered name', () => {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'rowstitch-table-identity-'));
  assert.ok(resolve(directory).startsWith(root + sep));
  const file = join(directory, 'fictional.sqlite');
  const raw = new DatabaseSync(file, { allowExtension: false, defensive: true });
  let attackDb, db;
  try {
    raw.exec('CREATE TABLE visible_parents(id INTEGER PRIMARY KEY); CREATE TABLE visible_children(id INTEGER PRIMARY KEY,parentId INTEGER);'
      + 'CREATE TABLE hidden_children(id INTEGER PRIMARY KEY,parentId INTEGER); INSERT INTO visible_parents VALUES(1); INSERT INTO hidden_children VALUES(1,1);');
    const parents = defineTable('visible_parents', { id: column.integer().primaryKey() });
    const children = defineTable('visible_children', { id: column.integer().primaryKey(), parentId: column.integer() });
    let hidden = false, reads = 0;
    const fake = Object.create(Object.getPrototypeOf(children));
    Object.defineProperties(fake, {
      name: { get() { reads++; return hidden ? 'hidden_children' : 'visible_children'; } },
      columns: { value: children.columns },
    });
    // Previously this flow registered one name, cached another during hasMany,
    // then passed the later exact-object registration check and read hidden rows.
    assert.throws(() => {
      attackDb = openDatabase(file, { tables: [parents, fake], readOnly: true });
      hidden = true;
      const relation = hasMany(fake, { localKey: parents.col('id'), foreignKey: new ColumnRef(fake, 'parentId') });
      hidden = false;
      attackDb.table(parents).findMany({ where: some(relation) });
    }, coded('SCHEMA'));
    assert.equal(reads, 0, 'reject the forged mapping before any name accessor is called');
    hidden = true;
    assert.throws(() => mappedTableModel(fake), coded('SCHEMA'));
    assert.equal(reads, 0);
    db = openDatabase(file, { tables: [parents, children], readOnly: true });
    const relation = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') });
    assert.deepEqual(db.table(parents).findMany({ where: some(relation) }), []);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM hidden_children').get().n, 1);
  } finally {
    attackDb?.close(); db?.close(); raw.close(); unlinkSync(file); rmdirSync(directory);
  }
});

test('forged, wrapped and revoked tables fail every mapping entry point without invoking accessors', () => {
  const real = defineTable('authentic_rows', { id: column.integer().primaryKey(), parentId: column.integer() });
  const db = openDatabase(':memory:', { tables: [real] });
  try {
    db.ensureSchema(); db.clearTrace();
    let calls = 0;
    const fake = Object.create(Object.getPrototypeOf(real));
    for (const key of ['name', 'columns', 'version']) Object.defineProperty(fake, key, { get() { calls++; return real[key]; } });
    const wrapped = new Proxy(real, { get(target, key, receiver) { calls++; return Reflect.get(target, key, receiver); } });
    const revoked = Proxy.revocable(real, {}); revoked.revoke();
    const options = { localKey: real.col('id'), foreignKey: real.col('parentId') };
    const Relation = hasMany(real, options).constructor;
    for (const candidate of [fake, wrapped, revoked.proxy]) {
      const entryPoints = [
        () => openDatabase(':memory:', { tables: [candidate] }),
        () => db.table(candidate),
        () => new Repository(db, candidate).findMany(),
        () => new ColumnRef(candidate, 'id'),
        () => Table.prototype.col.call(candidate, 'id'),
        () => column.integer().references(candidate, 'id'),
        () => mappedTableModel(candidate),
        () => mappedCreateTableModel(candidate),
        () => hasMany(candidate, options),
        () => hasOne(candidate, options),
        () => belongsTo(candidate, options),
        () => some(new Relation(candidate, options)),
      ];
      for (const run of entryPoints) assert.throws(run, rejectedMapping);
    }
    assert.equal(calls, 0);
    assert.equal(db.exportTrace().queries.length, 0);
  } finally { db.close(); }
});

test('direct Table and ColumnRef constructors retain ordinary mapped reads and relationships', () => {
  const teams = new Table('direct_teams', { id: column.integer().primaryKey(), name: column.text() });
  const tasks = new Table('direct_tasks', {
    id: column.integer().primaryKey(), teamId: column.integer().references(teams, 'id'), done: column.boolean(),
  });
  const db = openDatabase(':memory:', { tables: [teams, tasks] });
  try {
    db.ensureSchema();
    db.table(teams).insertMany([{ id: 1, name: 'Atlas' }, { id: 2, name: 'Harbor' }]);
    db.table(tasks).insert({ id: 1, teamId: 1, done: true });
    const relation = hasMany(tasks, { localKey: new ColumnRef(teams, 'id'), foreignKey: new ColumnRef(tasks, 'teamId') });
    assert.deepEqual(db.table(teams).findMany({ select: ['name'], where: some(relation) }), [{ name: 'Atlas' }]);
    assert.equal(db.table(teams).count(every(relation, eq(new ColumnRef(tasks, 'done'), true))), 2);
    assert.deepEqual(db.table(teams).findMany({ select: ['name'], include: { tasks: relation } }), [
      { name: 'Atlas', tasks: [{ id: 1, teamId: 1, done: true }] }, { name: 'Harbor', tasks: [] },
    ]);
  } finally { db.close(); }
});
