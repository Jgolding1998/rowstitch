import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  column, defineTable, openDatabase, openAsyncDatabase, eq, gt, gtColumns, and,
  contains, asc, desc, hasMany, belongsTo, some, countRelated, agg, RowstitchError,
} from '../dist/index.js';

const code = expected => error => error instanceof RowstitchError && error.code === expected;
const q = text => '"' + text.replaceAll('"', '""') + '"';
const key = () => column.integer().primaryKey();
const modes = [
  { name: 'sync SQLite', open: (file, options) => openDatabase(file, options) },
  { name: 'worker SQLite', open: (file, options) => openAsyncDatabase(file, options) },
];
const indexName = (table, physicalColumn) => 'rs_fk_' + createHash('sha256').update(table + '\0' + physicalColumn).digest('hex').slice(0, 16);
const secret = 'FICTIONAL_UNMAPPED_CUSTOMER_VALUE';

function ownedFiles(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-mapping-sdk-'));
  const handles = [], files = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.close();
    for (const file of files) for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  });
  return {
    file(name) { const file = join(directory, name + '.sqlite'); files.push(file); return file; },
    own(handle) { handles.push(handle); return handle; },
  };
}

function seed(file, callback) {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  try { callback(db); } finally { db.close(); }
}

async function rejects(call, expected) { await assert.rejects(async () => await call(), code(expected)); }

for (const mode of modes) {
  test(mode.name + ': mapped CRUD/defaults/version/FK/indexes retain logical results and redacted traces', async t => {
    const files = ownedFiles(t);
    const parents = defineTable('sdk_parents', {
      id: column.integer().primaryKey({ generated: true }).storedAs('from'),
      title: column.text().storedAs('__proto__'),
      version: column.integer().default(1).storedAs('revision no'),
    }, { version: 'version', storage: { table: 'Parent."rows', schema: 'main' } });
    const children = defineTable('sdk_children', {
      id: key().storedAs('Child.ID'),
      ownerId: column.integer().storedAs('Owner Ref').references(parents, 'id', { onDelete: 'cascade' }),
      amount: column.integer().storedAs('__rs_rank'),
      label: column.text().default('fallback').storedAs('__rs_family_0'),
    }, { storage: { table: '__rs_keys' } });
    const db = files.own(await mode.open(files.file('crud'), { tables: [parents, children] }));
    await db.ensureSchema();
    assert.deepEqual(await db.planSchema(), []);
    const parent = await db.table(parents).insert({ title: secret });
    assert.deepEqual(parent, { id: 1, title: secret, version: 1 });
    assert.deepEqual(await db.table(children).insert({ id: 10, ownerId: 1, amount: 2 }), { id: 10, ownerId: 1, amount: 2, label: 'fallback' });
    await rejects(() => db.table(children).insert({ id: 11, ownerId: 999, amount: 3 }), 'CONSTRAINT');
    assert.deepEqual(await db.table(parents).updateVersion({ id: 1 }, 1, { title: 'Changed' }), { id: 1, title: 'Changed', version: 2 });
    await rejects(() => db.table(parents).updateVersion({ id: 1 }, 1, { title: 'stale value' }), 'CONFLICT');
    assert.deepEqual(await db.table(children).update({ amount: 4, label: 'Edited' }, { where: eq(children.col('id'), 10) }), [{ id: 10, ownerId: 1, amount: 4, label: 'Edited' }]);
    const rows = await db.table(children).findMany({ select: ['label'], include: {
      owner: belongsTo(parents, { localKey: children.col('ownerId'), foreignKey: parents.col('id'), select: ['title'] }),
    } });
    assert.deepEqual(rows, [{ label: 'Edited', owner: { title: 'Changed' } }]);
    assert.deepEqual(await db.table(children).aggregate({ select: { n: agg.count(), total: agg.sum(children.col('amount')) } }), { n: 1, total: 4n });
    const schema = await db.inspectSchema({ scope: 'mapped' });
    const actualChild = schema.find(table => table.identity?.table === '__rs_keys');
    assert.deepEqual(actualChild.identity, { schema: 'main', table: '__rs_keys' });
    assert.ok(actualChild.indexes.some(index => index.name === indexName('__rs_keys', 'Owner Ref') && index.columns[0] === 'Owner Ref'));
    assert.deepEqual(actualChild.foreignKeys.map(f => [f.column, f.targetIdentity, f.target, f.width]), [
      ['Owner Ref', { schema: 'main', table: 'Parent."rows' }, 'from', 1],
    ]);
    const trace = await db.exportTrace();
    assert.equal(JSON.stringify(trace).includes(secret), false, 'bound row data must not appear in default traces');
    assert.ok(trace.queries.some(query => query.operation === 'insert' && query.table === parents.name));
    assert.ok(trace.queries.some(query => query.operation === 'update' && query.table === children.name));
    assert.deepEqual(await db.table(parents).delete({ where: eq(parents.col('id'), 1) }), [{ id: 1, title: 'Changed', version: 2 }]);
    assert.deepEqual(await db.table(children).findMany(), []);
  });

  test(mode.name + ': main/temp ownership survives nested filters, window includes and multi-hop aggregates', async t => {
    const files = ownedFiles(t);
    const owners = defineTable('sdk_owners', {
      id: key().storedAs('Owner.ID'), bucket: column.text().storedAs('__rs_family_0'),
      lhs: column.integer().storedAs('left'), rhs: column.integer().storedAs('right'),
    }, { storage: { table: '__rs_keys', schema: 'main' } });
    const children = defineTable('sdk_items', {
      id: key().storedAs('Child.ID'), owner: column.integer().storedAs('Parent.ID'), amount: column.integer().storedAs('__rs_rank'),
    }, { storage: { table: '__rs_keys', schema: 'temp' } });
    const leaves = defineTable('sdk_leaves', {
      id: key().storedAs('Leaf.ID'), child: column.integer().storedAs('Item.ID'), value: column.integer().storedAs('__rs_input_bad'),
    }, { storage: { table: 'leaf."table', schema: 'main' } });
    const db = files.own(await mode.open(files.file('relations'), { tables: [owners, children, leaves] }));
    await db.ensureSchema();
    await db.table(owners).insertMany([
      { id: 1, bucket: 'north', lhs: 5, rhs: 3 }, { id: 2, bucket: 'north', lhs: 1, rhs: 3 }, { id: 3, bucket: 'south', lhs: 5, rhs: 3 },
    ]);
    await db.table(children).insertMany([{ id: 10, owner: 1, amount: 2 }, { id: 11, owner: 1, amount: 3 }, { id: 12, owner: 2, amount: 5 }]);
    await db.table(leaves).insertMany([{ id: 100, child: 10, value: 7 }, { id: 101, child: 11, value: 11 }, { id: 102, child: 12, value: 13 }]);
    const items = hasMany(children, { localKey: owners.col('id'), foreignKey: children.col('owner'), where: gt(children.col('amount'), 1) });
    const values = hasMany(leaves, { localKey: children.col('id'), foreignKey: leaves.col('child'), where: gt(leaves.col('value'), 8) });
    const where = and(gtColumns(owners.col('lhs'), owners.col('rhs')), contains(owners.col('bucket'), 'orth'),
      some(items, some(values, gt(leaves.col('value'), 10))));
    assert.deepEqual(await db.table(owners).findMany({ select: ['id'], where }), [{ id: 1 }]);
    assert.equal(await db.table(owners).count(countRelated(items, '>=', 2)), 1);
    const total = agg.related(items, agg.related(values, agg.sum(leaves.col('value'))));
    const n = agg.related(items, agg.related(values, agg.count()));
    assert.deepEqual(await db.table(owners).aggregate({ select: { total, n } }), { total: 24n, n: 2 });
    assert.deepEqual(await db.table(owners).groupBy({ by: ['bucket'], select: { roots: agg.count(), total, n }, orderBy: [{ field: 'bucket', direction: 'asc' }] }), [
      { bucket: 'north', roots: 2, total: 24n, n: 2 }, { bucket: 'south', roots: 1, total: null, n: 0 },
    ]);
    const projected = await db.table(owners).findMany({ select: ['bucket'], orderBy: [asc(owners.col('id'))], aggregates: { total, n }, include: {
      items: hasMany(children, { localKey: owners.col('id'), foreignKey: children.col('owner'), select: ['amount'], orderBy: [desc(children.col('amount'))], limit: 1,
        include: { values: hasMany(leaves, { localKey: children.col('id'), foreignKey: leaves.col('child'), select: ['value'], orderBy: [desc(leaves.col('value'))], limit: 1 }) } }),
    } });
    assert.deepEqual(projected, [
      { bucket: 'north', total: 11n, n: 1, items: [{ amount: 3, values: [{ value: 11 }] }] },
      { bucket: 'north', total: 13n, n: 1, items: [{ amount: 5, values: [{ value: 13 }] }] },
      { bucket: 'south', total: null, n: 0, items: [] },
    ]);
    const identities = (await db.inspectSchema({ scope: 'mapped' })).map(table => table.identity);
    assert.ok(identities.some(id => id.schema === 'main' && id.table === '__rs_keys'));
    assert.ok(identities.some(id => id.schema === 'temp' && id.table === '__rs_keys'));
    assert.deepEqual(await db.planSchema(), []);
  });

  test(mode.name + ': temp foreign keys and schema-local hashes do not affect main tables with the same basename', async t => {
    const files = ownedFiles(t);
    const main = defineTable('sdk_main_parent', { id: key().storedAs('Parent.ID') }, { storage: { table: 'same parent', schema: 'main' } });
    const parent = defineTable('sdk_temp_parent', { id: key().storedAs('Parent.ID') }, { storage: { table: 'same parent', schema: 'temp' } });
    const child = defineTable('sdk_temp_child', { id: key(), parentId: column.integer().storedAs('parent ref').references(parent, 'id', { onDelete: 'cascade' }) }, { storage: { table: 'temp child', schema: 'temp' } });
    const db = files.own(await mode.open(files.file('temp-fk'), { tables: [main, parent, child] }));
    await db.ensureSchema();
    await db.table(main).insert({ id: 8 });
    await db.table(parent).insert({ id: 7 });
    await db.table(child).insert({ id: 1, parentId: 7 });
    await rejects(() => db.table(child).insert({ id: 2, parentId: 8 }), 'CONSTRAINT');
    const actual = (await db.inspectSchema({ scope: 'mapped' })).find(table => table.identity?.table === 'temp child');
    assert.deepEqual(actual.foreignKeys[0].targetIdentity, { schema: 'temp', table: 'same parent' });
    assert.ok(actual.indexes.some(index => index.name === indexName('temp child', 'parent ref')));
    await db.table(parent).delete({ where: eq(parent.col('id'), 7) });
    assert.deepEqual(await db.table(child).findMany(), []);
    assert.deepEqual(await db.table(main).findMany(), [{ id: 8 }]);
  });

  test(mode.name + ': text-key windows preserve collation and helper-shaped physical values', async t => {
    const files = ownedFiles(t), file = files.file('text-window');
    seed(file, db => {
      db.exec('CREATE TABLE "Text owners" ("owner key" TEXT NOT NULL PRIMARY KEY,"label value" TEXT NOT NULL);'
        + 'CREATE TABLE "__rs_keys" ("__rs_parent" INTEGER PRIMARY KEY,"__rs_key" TEXT COLLATE NOCASE NOT NULL,"__rs_rank" INTEGER NOT NULL,"__rs_family_0" TEXT NOT NULL)');
      db.prepare('INSERT INTO "Text owners" VALUES (?, ?)').run('A', 'Owner');
      db.prepare('INSERT INTO "__rs_keys" VALUES (?, ?, ?, ?)').run(1, 'a', 900, 'first');
      db.prepare('INSERT INTO "__rs_keys" VALUES (?, ?, ?, ?)').run(2, 'A', 800, 'second');
    });
    const owner = defineTable('sdk_text_owner', { id: column.text().primaryKey().storedAs('owner key'), label: column.text().storedAs('label value') }, { storage: { table: 'Text owners' } });
    const child = defineTable('sdk_text_item', {
      id: key().storedAs('__rs_parent'), owner: column.text().storedAs('__rs_key'),
      rank: column.integer().storedAs('__rs_rank'), family: column.text().storedAs('__rs_family_0'),
    }, { storage: { table: '__rs_keys' } });
    const db = files.own(await mode.open(file, { tables: [owner, child] }));
    assert.deepEqual(await db.planSchema(), []);
    assert.deepEqual(await db.table(owner).findMany({ select: ['label'], include: {
      items: hasMany(child, { localKey: owner.col('id'), foreignKey: child.col('owner'), select: ['rank', 'family'], where: gt(child.col('rank'), 700), orderBy: [asc(child.col('id'))], limit: 1 }),
    } }), [{ label: 'Owner', items: [{ rank: 900, family: 'first' }] }]);
  });

  test(mode.name + ': an existing legacy scalar index keeps its released name', async t => {
    const files = ownedFiles(t), file = files.file('legacy-index');
    // Fixed 0.12 preimage: legacy_children + U+0000 + parentId. This fixture must not be renamed.
    const released = 'rs_fk_187b105c70df4edf';
    seed(file, db => db.exec('CREATE TABLE legacy_parents (id INTEGER PRIMARY KEY);'
      + 'CREATE TABLE legacy_children (id INTEGER PRIMARY KEY,parentId INTEGER NOT NULL REFERENCES legacy_parents(id));'
      + 'CREATE INDEX ' + released + ' ON legacy_children(parentId)'));
    const parent = defineTable('legacy_parents', { id: key() });
    const child = defineTable('legacy_children', { id: key(), parentId: column.integer().references(parent, 'id') });
    const db = files.own(await mode.open(file, { tables: [parent, child] }));
    assert.deepEqual(await db.planSchema(), []);
    assert.deepEqual(await db.ensureSchema(), []);
    const actual = (await db.inspectSchema({ scope: 'mapped' })).find(table => table.name === 'legacy_children');
    assert.deepEqual(actual.indexes.filter(index => index.origin === 'c').map(index => index.name), [released]);
  });

  for (const unrelated of ['many', 'wide', 'huge-default']) {
    test(mode.name + ': mapped inspection ignores unrelated ' + unrelated + ' catalog payloads', async t => {
      const files = ownedFiles(t), file = files.file('unrelated-' + unrelated);
      seed(file, db => {
        db.exec('CREATE TABLE "Mapped table" ("row ID" INTEGER PRIMARY KEY, "label value" TEXT NOT NULL)');
        db.prepare('INSERT INTO "Mapped table" VALUES (?, ?)').run(7, 'visible');
        if (unrelated === 'many') for (let i = 0; i < 105; i++) db.exec('CREATE TABLE ' + q('unrelated' + i) + ' (id INTEGER)');
        if (unrelated === 'wide') db.exec('CREATE TABLE unrelated_wide (' + Array.from({ length: 101 }, (_, i) => q('x' + i) + ' TEXT').join(',') + ')');
        if (unrelated === 'huge-default') db.exec("CREATE TABLE unrelated_default (id INTEGER, detail TEXT DEFAULT '" + 'x'.repeat(1_100_000) + "')");
      });
      const table = defineTable('sdk_existing', { id: key().storedAs('row ID'), label: column.text().storedAs('label value') }, { storage: { table: 'Mapped table' } });
      const db = files.own(await mode.open(file, { tables: [table] }));
      assert.deepEqual(await db.table(table).findMany(), [{ id: 7, label: 'visible' }]);
      assert.deepEqual(await db.planSchema(), []);
      const mapped = await db.inspectSchema({ scope: 'mapped' });
      assert.equal(mapped.length, 1);
      assert.equal(mapped[0].coverage.scope, 'mapped');
      assert.deepEqual(mapped[0].identity, { schema: 'main', table: 'Mapped table' });
      if (unrelated === 'many') await rejects(() => db.inspectSchema(), 'RESULT_LIMIT');
      if (unrelated === 'wide') await rejects(() => db.inspectSchema(), 'SCHEMA');
    });
  }

  test(mode.name + ': a wide subset excludes unmapped values/defaults and preserves extra required-column engine errors', async t => {
    const files = ownedFiles(t), file = files.file('wide-subset');
    seed(file, db => {
      const extras = ['"required extra" TEXT NOT NULL', '"large default" TEXT DEFAULT ' + "'" + 'x'.repeat(1_100_000) + "'"];
      for (let i = 0; i < 140; i++) extras.push(q('extra' + i) + ' TEXT');
      db.exec('CREATE TABLE "Wide existing" ("row ID" INTEGER PRIMARY KEY, "visible label" TEXT NOT NULL,' + extras.join(',') + ')');
      db.prepare('INSERT INTO "Wide existing" ("row ID", "visible label", "required extra") VALUES (?, ?, ?)').run(1, 'Visible', secret);
    });
    const table = defineTable('sdk_wide_subset', { id: key().storedAs('row ID'), label: column.text().storedAs('visible label') }, { storage: { table: 'Wide existing' }, schemaPolicy: 'subset' });
    const db = files.own(await mode.open(file, { tables: [table] }));
    assert.deepEqual(await db.planSchema(), []);
    assert.deepEqual(await db.table(table).findMany(), [{ id: 1, label: 'Visible' }]);
    assert.deepEqual(await db.table(table).update({ label: 'Changed' }, { where: eq(table.col('id'), 1) }), [{ id: 1, label: 'Changed' }]);
    const schema = await db.inspectSchema({ scope: 'mapped' });
    assert.deepEqual(schema[0].columns.map(column => column.name), ['row ID', 'visible label']);
    assert.equal(JSON.stringify(schema).includes(secret), false);
    assert.equal(JSON.stringify(schema).includes('x'.repeat(1000)), false, 'unmapped default payload is not returned');
    await rejects(() => db.table(table).insert({ id: 2, label: 'Requires extra field' }), 'CONSTRAINT');
    assert.deepEqual(await db.table(table).delete({ where: eq(table.col('id'), 1) }), [{ id: 1, label: 'Changed' }]);
    assert.deepEqual(await db.table(table).findMany(), []);
  });

  test(mode.name + ': exact/legacy reject extra columns while subset still rejects mapped drift', async t => {
    const files = ownedFiles(t);
    for (const policy of ['legacy', 'exact', 'subset']) {
      const file = files.file('policy-' + policy);
      seed(file, db => db.exec('CREATE TABLE "Existing" ("row ID" INTEGER PRIMARY KEY, "label value" TEXT NOT NULL, "unmapped" TEXT)'));
      const table = defineTable('sdk_policy_' + policy, { id: key().storedAs('row ID'), label: column.text().storedAs('label value') }, { storage: { table: 'Existing' }, schemaPolicy: policy });
      const db = files.own(await mode.open(file, { tables: [table] }));
      if (policy === 'subset') assert.deepEqual(await db.planSchema(), []);
      else await rejects(() => db.planSchema(), 'SCHEMA_DRIFT');
    }
    const driftFile = files.file('mapped-drift');
    seed(driftFile, db => db.exec('CREATE TABLE "Existing" ("row ID" INTEGER PRIMARY KEY, "label value" INTEGER NOT NULL, extra TEXT)'));
    const drift = defineTable('sdk_subset_drift', { id: key().storedAs('row ID'), label: column.text().storedAs('label value') }, { storage: { table: 'Existing' }, schemaPolicy: 'subset' });
    const db = files.own(await mode.open(driftFile, { tables: [drift] }));
    await rejects(() => db.planSchema(), 'SCHEMA_DRIFT');
  });

  test(mode.name + ': a component of an actual compound FK cannot satisfy a declared scalar FK', async t => {
    const files = ownedFiles(t), file = files.file('compound-fk');
    seed(file, db => db.exec('CREATE TABLE "Parent" (a INTEGER NOT NULL UNIQUE,b INTEGER NOT NULL,PRIMARY KEY(a,b));'
      + 'CREATE TABLE "Child" (id INTEGER PRIMARY KEY,"local a" INTEGER NOT NULL,"local b" INTEGER NOT NULL,FOREIGN KEY("local a","local b") REFERENCES "Parent"(a,b))'));
    const parent = defineTable('sdk_compound_parent', { a: key().unique(), b: key() }, { storage: { table: 'Parent' } });
    const child = defineTable('sdk_scalar_child', { id: key(), parentA: column.integer().storedAs('local a').references(parent, 'a') }, { storage: { table: 'Child' }, schemaPolicy: 'subset' });
    const db = files.own(await mode.open(file, { tables: [parent, child] }));
    const actual = (await db.inspectSchema({ scope: 'mapped' })).find(table => table.identity.table === 'Child');
    assert.deepEqual(actual.foreignKeys.map(foreign => foreign.width), [2, 2]);
    assert.deepEqual(actual.foreignKeys.map(foreign => foreign.position), [1, 2]);
    await rejects(() => db.planSchema(), 'SCHEMA_DRIFT');
  });

  test(mode.name + ': case collisions, unsupported namespaces and cross-schema FKs fail before opening a file', async t => {
    const files = ownedFiles(t);
    const caseColumns = defineTable('sdk_case_columns', { id: key().storedAs('Case'), value: column.text().storedAs('case') });
    const one = defineTable('sdk_case_table_a', { id: key() }, { storage: { table: 'Same' } });
    const two = defineTable('sdk_case_table_b', { id: key() }, { storage: { table: 'same', schema: 'main' } });
    const unknown = defineTable('sdk_unknown_schema', { id: key() }, { storage: { schema: 'attached' } });
    const parent = defineTable('sdk_cross_parent', { id: key() });
    const child = defineTable('sdk_cross_child', { id: key(), parent: column.integer().references(parent, 'id') }, { storage: { schema: 'temp' } });
    for (const [name, tables] of [['columns', [caseColumns]], ['tables', [one, two]], ['namespace', [unknown]], ['fk', [parent, child]]]) {
      const file = files.file('rejected-' + name);
      await rejects(() => mode.open(file, { tables }), 'SCHEMA');
      assert.equal(existsSync(file), false, 'validation must finish before creating the SQLite file');
    }
  });
}
