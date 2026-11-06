import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const qualified = (schema, table) => quote(schema) + '.' + quote(table);
const code = expected => error => error?.code === expected;
const marker = "FICTIONAL_MAPPING_' OR 1=1 --";
const hidden = 'FICTIONAL_UNMAPPED_NATIVE_VALUE';
const indexName = (table, column) => 'rs_fk_' + createHash('sha256').update(table + '\0' + column).digest('hex').slice(0, 16);

/**
 * Supply the SDK and factories from the same compiled consumer. PostgreSQL admin must be the caller's
 * positional raw-text connection to the same disposable server as postgresOptions. The caller owns
 * that server and connection. This runner owns its randomly named schemas and SDK handles.
 */
export async function runPublicPhysicalMappingCases({ engine, sdk, openPostgresDatabase, openPgliteDatabase, postgresOptions, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite');
  const postgres = engine === 'postgresql', factory = postgres ? openPostgresDatabase : openPgliteDatabase;
  assert.equal(typeof factory, 'function');
  if (postgres) {
    assert.equal(typeof admin?.query, 'function');
    assert.equal(postgresOptions?.connectionString, undefined);
    for (const field of ['host', 'user', 'database']) assert.equal(typeof postgresOptions?.[field], 'string');
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(postgresOptions.host), 'Use the caller-owned loopback fixture');
  }
  const { column, defineTable, eq, gt, gtColumns, and, contains, asc, desc, hasMany, belongsTo, some, countRelated, agg } = sdk;
  const token = randomBytes(6).toString('hex');
  const schema = postgres ? 'rs map "primary".\\,' + token : 'public';
  const otherSchema = postgres ? 'rs map "target".\\,' + token : 'public';
  const databases = new Set(), schemas = [];
  const cleanup = { openedDatabases: 0, closedDatabases: 0, createdSchemas: 0, droppedSchemas: 0 };
  const cases = [];
  const query = (sql, values = []) => admin.query(sql, values);
  const options = orm => postgres ? { ...postgresOptions, ...orm } : orm;
  const open = async (tables, extra = {}) => {
    const db = await factory(options({ tables, schema, traceValues: false, ...extra }));
    databases.add(db); cleanup.openedDatabases++;
    return db;
  };
  const close = async db => { await db.close(); if (databases.delete(db)) cleanup.closedDatabases++; };
  const createSchema = async name => {
    await query('CREATE SCHEMA ' + quote(name)); schemas.push(name); cleanup.createdSchemas++;
    await query('REVOKE ALL ON SCHEMA ' + quote(name) + ' FROM PUBLIC');
  };
  const readRow = async (sql, values = []) => (await query(sql, values)).rows[0];
  const tableAt = (schemaRows, namespace, table) => {
    const matches = schemaRows.filter(row => row.identity?.schema === namespace && row.identity?.table === table);
    assert.equal(matches.length, 1, 'Structured identity must resolve exactly one physical table');
    return matches[0];
  };
  const key = () => column.integer().primaryKey();
  const secureError = expected => error => {
    assert.equal(error?.code, expected);
    const serialized = String(error) + JSON.stringify(error);
    assert.equal(serialized.includes(marker) || serialized.includes(hidden), false);
    assert.equal(error.cause, undefined);
    return true;
  };

  const parentName = '__rs_family_0', childName = 'child."rows', leafName = '__rs_pa_0';
  const longColumn = 'é'.repeat(31) + 'x'; // 63 UTF-8 bytes.
  const titleDefault = "Fictional owner's \\ default";
  const parents = defineTable('mapped_native_parents', {
    id: column.integer().primaryKey({ generated: true }).storedAs('Owner.ID'),
    title: column.text().unique().default(titleDefault).storedAs('__proto__'),
    high: column.integer().storedAs('Case'), low: column.integer().storedAs('case'),
    version: column.integer().default(1).storedAs('revision no'),
  }, { version: 'version', storage: { table: parentName }, schemaPolicy: 'exact' });
  const children = defineTable('mapped_native_children', {
    id: key().storedAs('Child.ID'),
    parentId: column.integer().storedAs('Parent Ref').references(parents, 'id', { onDelete: 'cascade' }),
    score: column.integer().storedAs('__rs_pg_0'), label: column.text().storedAs('__rs_family_0'),
  }, { storage: { table: childName, schema: otherSchema }, schemaPolicy: 'exact' });
  const leaves = defineTable('mapped_native_leaves', {
    id: key().storedAs('Leaf.ID'),
    childId: column.integer().storedAs('Child Ref').references(children, 'id', { onDelete: 'cascade' }),
    value: column.integer().storedAs(longColumn),
  }, { storage: { table: leafName }, schemaPolicy: 'subset' });
  const caseTwin = defineTable('mapped_native_case_twin', { id: key().storedAs('Case') }, { storage: { table: parentName.toUpperCase() } });
  const decoy = postgres ? defineTable('mapped_native_decoy', { id: key().storedAs('Owner.ID') },
    { storage: { table: parentName, schema: otherSchema } }) : undefined;

  let failure;
  try {
    if (postgres) { await createSchema(schema); await createSchema(otherSchema); }
    const tables = [leaves, children, parents, caseTwin, ...(decoy ? [decoy] : [])];
    const db = await open(tables);
    assert.deepEqual(await db.inspectSchema({ scope: 'mapped' }), []);
    const plans = await db.planSchema();
    const creates = plans.filter(plan => plan.action === 'create-table').map(plan => plan.table);
    assert.ok(creates.indexOf(parents.name) < creates.indexOf(children.name));
    assert.ok(creates.indexOf(children.name) < creates.indexOf(leaves.name));
    assert.equal(creates.length, tables.length);
    assert.deepEqual(await db.inspectSchema({ scope: 'mapped' }), []);
    await db.ensureSchema();
    assert.deepEqual(await db.ensureSchema(), []);
    const physical = await db.inspectSchema({ scope: 'mapped' });
    assert.equal(physical.length, tables.length);
    assert.ok(physical.every(table => table.coverage.scope === 'mapped'));
    const parentFacts = tableAt(physical, schema, parentName);
    assert.deepEqual(parentFacts.columns.map(field => field.name), ['Owner.ID', '__proto__', 'Case', 'case', 'revision no']);
    const childFacts = tableAt(physical, otherSchema, childName);
    assert.deepEqual(childFacts.foreignKeys.map(fk => [fk.column, fk.targetIdentity, fk.target, fk.width]), [
      ['Parent Ref', { schema, table: parentName }, 'Owner.ID', 1],
    ]);
    assert.ok(childFacts.indexes.some(index => index.name === indexName(childName, 'Parent Ref') && index.columns[0] === 'Parent Ref'));
    assert.ok(tableAt(physical, schema, leafName).columns.some(field => field.name === longColumn));
    tableAt(physical, schema, parentName.toUpperCase());
    if (postgres) tableAt(physical, otherSchema, parentName);
    const whole = await db.inspectSchema();
    assert.equal(whole.length, physical.length);
    assert.ok(whole.every(table => table.coverage.scope === 'all'));
    for (const table of physical) tableAt(whole, table.identity.schema, table.identity.table);
    cases.push('creation is parent-first and idempotent, with exact quoted case, 63-byte UTF-8 names and structured FK catalog identities');

    const parentRows = db.table(parents), childRows = db.table(children), leafRows = db.table(leaves);
    assert.deepEqual(await parentRows.insert({ high: 5, low: 3 }), { id: 1, title: titleDefault, high: 5, low: 3, version: 1 });
    assert.deepEqual(await parentRows.insert({ title: marker, high: 1, low: 3 }), { id: 2, title: marker, high: 1, low: 3, version: 1 });
    assert.deepEqual(await db.table(caseTwin).insert({ id: 91 }), { id: 91 });
    if (decoy) assert.deepEqual(await db.table(decoy).insert({ id: 99 }), { id: 99 });
    await assert.rejects(childRows.insert({ id: 19, parentId: 99, score: 2, label: marker }), secureError('CONSTRAINT'));
    await childRows.insertMany([
      { id: 10, parentId: 1, score: 2, label: 'a' }, { id: 11, parentId: 1, score: 3, label: 'b' },
      { id: 12, parentId: 2, score: 5, label: 'c' },
    ]);
    await leafRows.insertMany([{ id: 30, childId: 10, value: 7 }, { id: 31, childId: 11, value: 11 }, { id: 32, childId: 12, value: 13 }]);
    await assert.rejects(parentRows.update({ title: 'Guard refusal' }, { where: gt(parents.col('id'), 0), maxRows: 1 }), code('AFFECTED_ROWS'));
    assert.deepEqual(await parentRows.findMany({ select: ['id', 'version'], orderBy: [asc(parents.col('id'))] }), [{ id: 1, version: 1 }, { id: 2, version: 1 }]);
    assert.deepEqual(await parentRows.updateVersion({ id: 1 }, 1, { title: 'Changed' }), { id: 1, title: 'Changed', high: 5, low: 3, version: 2 });
    await assert.rejects(parentRows.updateVersion({ id: 1 }, 1, { title: marker }), secureError('CONFLICT'));
    assert.deepEqual(await childRows.update({ label: 'edited' }, { where: eq(children.col('id'), 11), maxRows: 1 }), [{ id: 11, parentId: 1, score: 3, label: 'edited' }]);
    cases.push('mapped insert, guarded update, version conflict and real FK failures preserve logical values and exact target schema');

    const childrenFor = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), where: gt(children.col('score'), 1) });
    const leavesFor = hasMany(leaves, { localKey: children.col('id'), foreignKey: leaves.col('childId'), where: gt(leaves.col('value'), 8) });
    const nested = and(gtColumns(parents.col('high'), parents.col('low')), contains(parents.col('title'), 'hang'), some(childrenFor, some(leavesFor, gt(leaves.col('value'), 10))));
    assert.deepEqual(await parentRows.findMany({ select: ['id'], where: nested }), [{ id: 1 }]);
    assert.equal(await parentRows.count(countRelated(childrenFor, '>=', 2)), 1);
    await assert.rejects(parentRows.delete({ where: some(childrenFor), maxRows: 2 }), code('UNSAFE_WRITE'));
    assert.equal(await parentRows.count(), 2);
    const childWithOwner = await childRows.findMany({ select: ['label'], where: eq(children.col('id'), 11), include: {
      owner: belongsTo(parents, { localKey: children.col('parentId'), foreignKey: parents.col('id'), select: ['title'] }),
    } });
    assert.deepEqual(childWithOwner, [{ label: 'edited', owner: { title: 'Changed' } }]);
    const total = agg.related(childrenFor, agg.related(leavesFor, agg.sum(leaves.col('value'))));
    const count = agg.related(childrenFor, agg.related(leavesFor, agg.count()));
    assert.deepEqual(await parentRows.aggregate({ select: { total, count } }), { total: 24n, count: 2 });
    assert.deepEqual(await parentRows.groupBy({ by: ['low'], select: { total, count } }), [{ low: 3, total: 24n, count: 2 }]);
    const projected = await parentRows.findMany({ select: ['title'], orderBy: [asc(parents.col('id'))], aggregates: { total, count }, include: {
      children: hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), select: ['label', 'score'], orderBy: [desc(children.col('score'))], limit: 1,
        include: { leaves: hasMany(leaves, { localKey: children.col('id'), foreignKey: leaves.col('childId'), select: ['value'], limit: 1 }) } }),
    } });
    assert.deepEqual(projected, [
      { title: 'Changed', total: 11n, count: 1, children: [{ label: 'edited', score: 3, leaves: [{ value: 11 }] }] },
      { title: marker, total: 13n, count: 1, children: [{ label: 'c', score: 5, leaves: [{ value: 13 }] }] },
    ]);
    const trace = db.exportTrace();
    assert.equal(trace.version, 2);
    assert.equal(trace.dialect, 'postgresql');
    assert.deepEqual(trace.inspection, { scope: 'all', registeredTables: tables.length, omittedTables: 0 });
    assert.deepEqual(trace.mapping.tables.find(entry => entry.logical === children.name).physical, { schema: otherSchema, table: childName });
    assert.deepEqual(trace.schema.find(entry => entry.identity.table === childName).foreignKeys[0].targetIdentity, { schema, table: parentName });
    assert.equal(JSON.stringify(trace).includes(marker), false);
    assert.ok(trace.queries.some(entry => entry.operation === 'update' && entry.table === parents.name));
    assert.deepEqual(await parentRows.delete({ where: eq(parents.col('id'), 1), maxRows: 1 }), [{ id: 1, title: 'Changed', high: 5, low: 3, version: 2 }]);
    assert.deepEqual(await childRows.findMany({ select: ['id'] }), [{ id: 12 }]);
    assert.deepEqual(await leafRows.findMany({ select: ['id'] }), [{ id: 32 }]);
    if (decoy) assert.deepEqual(await db.table(decoy).findMany(), [{ id: 99 }]);
    cases.push('mapped nested filters, guarded relations, eager windows, aggregates, hidden keys, redaction and cascades match hand-written results');
    await close(db);

    const tooLong = defineTable('mapped_native_long_refusal', { id: key().storedAs('é'.repeat(32)) });
    await assert.rejects(factory(options({ tables: [tooLong], schema })), code('SCHEMA'));
    const duplicate = defineTable('mapped_native_duplicate', { id: key() }, { storage: { table: parentName, schema } });
    await assert.rejects(factory(options({ tables: [parents, duplicate], schema })), code('SCHEMA'));
    const missing = defineTable('mapped_native_missing_namespace', { id: key() }, { storage: { schema: 'rs_absent_' + token } });
    const missingDb = await open([missing]);
    await assert.rejects(missingDb.ensureSchema(), code('SCHEMA'));
    assert.deepEqual(await missingDb.inspectSchema({ scope: 'mapped' }), []);
    await close(missingDb);
    if (postgres) {
      const explicit = defineTable('mapped_native_explicit_only', { id: key() },
        { storage: { schema: otherSchema, table: 'Explicit only' } });
      const unusedDefault = 'rs_unused_' + token;
      const explicitDb = await open([explicit], { schema: unusedDefault });
      assert.equal((await explicitDb.ensureSchema()).length, 1);
      assert.deepEqual(await explicitDb.table(explicit).insert({ id: 7 }), { id: 7 });
      tableAt(await explicitDb.inspectSchema({ scope: 'mapped' }), otherSchema, 'Explicit only');
      assert.deepEqual(await readRow('SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1)', [unusedDefault]), ['f']);
      await close(explicitDb);
    }
    cases.push('invalid and duplicate mappings refuse, required namespaces must exist, and explicitly mapped tables do not require an unused default');

    if (postgres) {
      const scope = 'rs map "wide".\\,' + token;
      await createSchema(scope);
      const wide = qualified(scope, 'Wide, "row".\\table');
      const extras = Array.from({ length: 103 }, (_, index) => quote('extra ' + index) + ' text');
      await query('CREATE TABLE ' + wide + ' ("row ID" bigint PRIMARY KEY,"visible label" text NOT NULL,"required extra" text NOT NULL, '
        + '"huge default" text DEFAULT ' + "'" + 'x'.repeat(24_000) + "'," + extras.join(',') + ')');
      await query('INSERT INTO ' + wide + ' ("row ID","visible label","required extra") VALUES ($1,$2,$3)', [1, 'Visible', hidden]);
      const wideMap = defineTable('mapped_native_wide', { id: key().storedAs('row ID'), label: column.text().storedAs('visible label') },
        { storage: { table: 'Wide, "row".\\table' }, schemaPolicy: 'subset' });
      const wideDb = await open([wideMap], { schema: scope });
      assert.deepEqual(await wideDb.planSchema(), []);
      const mapped = await wideDb.inspectSchema({ scope: 'mapped' });
      const mappedTable = tableAt(mapped, scope, 'Wide, "row".\\table');
      assert.deepEqual(mappedTable.coverage, { scope: 'mapped', columns: 'mapped-and-key', totalColumnCount: 4 + extras.length });
      assert.deepEqual(mappedTable.columns.map(field => field.name), ['row ID', 'visible label']);
      assert.equal(JSON.stringify(mapped).includes('x'.repeat(1000)), false);
      assert.deepEqual(await wideDb.table(wideMap).findMany(), [{ id: 1, label: 'Visible' }]);
      assert.deepEqual(await wideDb.table(wideMap).update({ label: 'Updated' }, { where: eq(wideMap.col('id'), 1) }), [{ id: 1, label: 'Updated' }]);
      await assert.rejects(wideDb.table(wideMap).insert({ id: 2, label: marker }), secureError('CONSTRAINT'));
      assert.deepEqual(await wideDb.table(wideMap).delete({ where: eq(wideMap.col('id'), 1) }), [{ id: 1, label: 'Updated' }]);
      assert.equal(JSON.stringify(wideDb.exportTrace()).includes(hidden), false);
      await close(wideDb);
      cases.push('wide subset retrieves only mapped and critical facts, omits huge defaults and preserves the engine effect of unmapped required fields');

      const scoped = 'rs map "scope".\\,' + token;
      await createSchema(scoped);
      const small = qualified(scoped, 'Visible, "row".\\table');
      await query('CREATE TABLE ' + small + ' ("row ID" bigint PRIMARY KEY,"visible label" text NOT NULL)');
      await query('INSERT INTO ' + small + ' VALUES ($1,$2)', [7, 'Mapped']);
      await query('CREATE TABLE ' + qualified(scoped, 'unrelated wide') + ' (' + extras.join(',') + ')');
      await query('CREATE TABLE ' + qualified(scoped, 'unrelated default') + " (x text DEFAULT '" + 'z'.repeat(24_000) + "')");
      await query(Array.from({ length: 105 }, (_, index) => 'CREATE TABLE ' + qualified(scoped, 'unrelated ' + index) + ' (id bigint)').join('; '));
      const smallMap = defineTable('mapped_native_scoped', { id: key().storedAs('row ID'), label: column.text().storedAs('visible label') },
        { storage: { table: 'Visible, "row".\\table' }, schemaPolicy: 'exact' });
      const scopedDb = await open([smallMap], { schema: scoped });
      assert.deepEqual(await scopedDb.table(smallMap).findMany(), [{ id: 7, label: 'Mapped' }]);
      assert.deepEqual(await scopedDb.ensureSchema(), []);
      assert.equal((await scopedDb.inspectSchema({ scope: 'mapped' })).length, 1);
      await assert.rejects(scopedDb.inspectSchema(), code('RESULT_LIMIT'));
      assert.equal(await scopedDb.table(smallMap).count(), 1);
      await close(scopedDb);
      cases.push('mapped open and ensure succeed amid over 100 unrelated relations, a wide relation and a large unrelated default while whole inspection stays bounded');

      const narrowName = 'Narrow existing', narrow = qualified(schema, narrowName);
      await query('CREATE TABLE ' + narrow + ' ("row ID" bigint PRIMARY KEY,"visible label" text NOT NULL DEFAULT \'Visible\', "private extra" text NOT NULL DEFAULT \'FICTIONAL_UNMAPPED_NATIVE_VALUE\')');
      for (const policy of ['legacy', 'subset', 'exact']) {
        const mapping = defineTable('mapped_native_policy_' + policy, {
          id: key().storedAs('row ID'), label: column.text().default('Visible').storedAs('visible label'),
        }, { storage: { table: narrowName }, schemaPolicy: policy });
        const policyDb = await open([mapping]);
        if (policy === 'exact') await assert.rejects(policyDb.planSchema(), code('SCHEMA_DRIFT'));
        else assert.deepEqual(await policyDb.planSchema(), []);
        if (policy === 'subset') {
          assert.deepEqual(await policyDb.table(mapping).insert({ id: 1 }), { id: 1, label: 'Visible' });
          assert.deepEqual(await readRow('SELECT "private extra" FROM ' + narrow + ' WHERE "row ID"=$1', [1]), [hidden]);
          assert.equal(JSON.stringify(policyDb.exportTrace()).includes(hidden), false);
        }
        await close(policyDb);
      }
      const wrongDefault = defineTable('mapped_native_default_drift', {
        id: key().storedAs('row ID'), label: column.text().default('Wrong default').storedAs('visible label'),
      }, { storage: { table: narrowName }, schemaPolicy: 'subset' });
      const wrongName = defineTable('mapped_native_name_drift', { id: key().storedAs('row ID'), label: column.text().storedAs('missing label') },
        { storage: { table: narrowName }, schemaPolicy: 'subset' });
      const driftDb = await open([wrongDefault]);
      await assert.rejects(driftDb.planSchema(), code('SCHEMA_DRIFT'));
      await close(driftDb);
      const badNameDb = await open([wrongName]);
      await assert.rejects(badNameDb.planSchema(), code('SCHEMA_DRIFT'));
      await assert.rejects(badNameDb.table(wrongName).findMany(), secureError('DATABASE_ERROR'));
      await assert.rejects(badNameDb.table(wrongName).insert({ id: 2, label: marker }), secureError('DATABASE_ERROR'));
      assert.deepEqual(await readRow('SELECT count(*) FROM ' + narrow), ['1']);
      await close(badNameDb);
      cases.push('legacy and subset accept extra columns, exact refuses them, subset catches default drift, and missing physical fields fail reads and writes safely');

      const targetName = 'target', literalName = qualified(otherSchema, targetName), referenceName = 'identity ref';
      const realTarget = qualified(otherSchema, targetName), literalTarget = qualified(schema, literalName), references = qualified(schema, referenceName);
      await query('CREATE TABLE ' + realTarget + ' ("target ID" bigint PRIMARY KEY)');
      await query('CREATE TABLE ' + literalTarget + ' ("target ID" bigint PRIMARY KEY)');
      await query('CREATE TABLE ' + references + ' ("row ID" bigint PRIMARY KEY,"target Ref" bigint NOT NULL REFERENCES ' + literalTarget + '("target ID"))');
      await query('INSERT INTO ' + realTarget + ' VALUES ($1)', [42]);
      await query('INSERT INTO ' + literalTarget + ' VALUES ($1)', [41]);
      const real = defineTable('mapped_native_real_target', { id: key().storedAs('target ID') }, { storage: { table: targetName, schema: otherSchema } });
      const literal = defineTable('mapped_native_literal_target', { id: key().storedAs('target ID') }, { storage: { table: literalName } });
      const ref = (name, target) => defineTable(name, {
        id: key().storedAs('row ID'), targetId: column.integer().storedAs('target Ref').references(target, 'id'),
      }, { storage: { table: referenceName }, schemaPolicy: 'exact' });
      const badRef = ref('mapped_native_wrong_reference', real), correctRef = ref('mapped_native_correct_reference', literal);
      const wrongDb = await open([badRef, real]);
      const observedFk = tableAt(await wrongDb.inspectSchema({ scope: 'mapped' }), schema, referenceName).foreignKeys[0];
      assert.equal(observedFk.table, literalName);
      assert.deepEqual(observedFk.targetIdentity, { schema, table: literalName });
      await assert.rejects(wrongDb.ensureSchema(), code('SCHEMA_DRIFT'));
      await close(wrongDb);
      const correctDb = await open([correctRef, literal]);
      await correctDb.ensureSchema();
      assert.deepEqual(await correctDb.planSchema(), []);
      assert.deepEqual(await correctDb.table(correctRef).insert({ id: 1, targetId: 41 }), { id: 1, targetId: 41 });
      await assert.rejects(correctDb.table(correctRef).insert({ id: 2, targetId: 42 }), code('CONSTRAINT'));
      await close(correctDb);
      cases.push('a quoted literal qualified-looking FK target cannot impersonate the real cross-schema table with the same display string');

      const compoundParentName = 'compound target', compoundChildName = 'compound child';
      const compoundParent = qualified(schema, compoundParentName), compoundChild = qualified(schema, compoundChildName);
      await query('CREATE TABLE ' + compoundParent + ' ("part a" bigint NOT NULL UNIQUE,"part b" bigint NOT NULL, PRIMARY KEY ("part a","part b"))');
      await query('CREATE TABLE ' + compoundChild + ' (id bigint PRIMARY KEY,"local a" bigint NOT NULL,"local b" bigint NOT NULL, FOREIGN KEY("local a","local b") REFERENCES ' + compoundParent + '("part a","part b"))');
      const pair = defineTable('mapped_native_compound_target', { a: key().unique().storedAs('part a'), b: key().storedAs('part b') }, { storage: { table: compoundParentName } });
      const scalar = defineTable('mapped_native_scalar_child', { id: key(), a: column.integer().storedAs('local a').references(pair, 'a') },
        { storage: { table: compoundChildName }, schemaPolicy: 'subset' });
      const compoundDb = await open([pair, scalar]);
      const components = tableAt(await compoundDb.inspectSchema({ scope: 'mapped' }), schema, compoundChildName).foreignKeys;
      assert.deepEqual(components.map(fk => [fk.column, fk.target, fk.position, fk.width]), [['local a', 'part a', 1, 2], ['local b', 'part b', 2, 2]]);
      await assert.rejects(compoundDb.planSchema(), code('SCHEMA_DRIFT'));
      await close(compoundDb);
      cases.push('a complete catalog compound FK remains distinguishable from a declared scalar FK on one component');
    }
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  for (const db of databases) {
    try { await close(db); } catch { cleanupErrors.push('SDK handle'); }
  }
  for (const name of schemas.reverse()) {
    try { await query('DROP SCHEMA ' + quote(name) + ' CASCADE'); cleanup.droppedSchemas++; }
    catch { cleanupErrors.push('owned namespace'); }
  }
  if (cleanupErrors.length) throw new Error((failure ? String(failure.message) + '. ' : '') + 'Mapped fixture cleanup failed for ' + cleanupErrors.join(', ') + '.');
  if (failure) throw failure;
  return { engine, cases, cleanup, limits: postgres ? ['Dedicated PostgreSQL with caller-owned fixture setup.']
    : ['Fresh public PGlite worker in public. Existing-catalog, cross-schema and raw DDL controls require the separate PostgreSQL fixture.'] };
}
