// Native encoded-parameter limits through actual public factories; no smaller injected cap or replacement driver.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

const MiB = 1024 * 1024, CAP = 16 * MiB;
const MESSAGE = 'The PostgreSQL parameter data exceeds its byte limit.';
const marker = 'FICTIONAL_PARAMETER_BUDGET_VALUE_';
const chunk = marker + 'x'.repeat(MiB - marker.length);
const parts = bytes => [...Array(Math.floor(bytes / MiB)).fill(chunk), ...(bytes % MiB ? [chunk.slice(0, bytes % MiB)] : [])];
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const reads = db => db.exportTrace().queries.filter(query => query.operation === 'select');
const safeRefusal = error => {
  assert.equal(error?.code, 'QUERY'); assert.equal(error.message, MESSAGE); assert.equal(error.cause, undefined);
  assert.ok(!inspect(error, { showHidden: true, depth: 8 }).includes(marker)); return true;
};

/** SDK and factories come from one build or installed package. Admin, for PostgreSQL only, is the caller's
 * positional transport to its already verified disposable fixture. This helper owns one fresh random schema and
 * one public handle, never the caller's admin/server. PGlite uses its actual fresh private-worker public factory.
 */
export async function runPublicParameterBudgetCases({ engine, sdk, openPostgresDatabase, openPgliteDatabase, postgresOptions, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite');
  const postgres = engine === 'postgresql', factory = postgres ? openPostgresDatabase : openPgliteDatabase;
  assert.equal(typeof factory, 'function');
  if (postgres) {
    assert.equal(typeof admin?.query, 'function'); assert.equal(postgresOptions?.connectionString, undefined);
    for (const name of ['host', 'user', 'database']) assert.equal(typeof postgresOptions?.[name], 'string');
  }
  const { column, defineTable, hasMany, hasOne, belongsTo, inArray, eq, asc } = sdk;
  const schema = postgres ? 'rs_parameter_' + randomBytes(6).toString('hex') : 'public';
  const roots = defineTable('parameter_roots', { id: column.integer().primaryKey(), key: column.text(), label: column.text() });
  const leaves = defineTable('parameter_leaves', { id: column.integer().primaryKey(), rootId: column.integer(), key: column.text(), label: column.text() });
  const markers = defineTable('parameter_markers', { id: column.integer().primaryKey(), label: column.text() });
  const keys = ['A' + chunk.slice(1), 'B' + chunk.slice(1)], cases = [];
  const cleanup = { openedDatabases: 0, closedDatabases: 0, schemaDropped: !postgres };
  const report = { engine, cases, cleanup, payloadLimitBytes: CAP, limits: [
    'The budget counts UTF8 parameter payloads per compiled statement, including actual relation keys and numeric bounds; it is not a protocol, heap or total-transaction byte limit.',
    'Exact-boundary requests run on the actual engine. Known child filters refuse during planning; oversized combinations with actual source keys can refuse only after the root read.',
    'Fixtures are fictional; public tracing keeps values redacted. No arbitrary user dataset, timing or universal security claim.',
  ] };
  const query = async sql => { try { return await admin.query(sql); } catch { throw new Error('Owned parameter fixture administration failed.'); } };
  const redacted = db => assert.ok(!JSON.stringify(db.exportTrace()).includes(marker));
  let db, created = false, failed = false;
  try {
    if (postgres) { await query('CREATE SCHEMA ' + quote(schema)); created = true; await query('REVOKE ALL ON SCHEMA ' + quote(schema) + ' FROM PUBLIC'); }
    db = await factory({ ...(postgres ? postgresOptions : {}), schema, tables: [roots, leaves, markers], traceValues: false, maxTraceEntries: 1000 });
    cleanup.openedDatabases++; await db.ensureSchema();
    await db.table(roots).insertMany([{ id: 1, key: keys[0], label: 'root-one' }, { id: 2, key: keys[1], label: 'root-two' }]);
    await db.table(leaves).insertMany([{ id: 1, rootId: 1, key: keys[0], label: 'leaf-one' }, { id: 2, rootId: 2, key: keys[1], label: 'leaf-two' }]);
    const rootRows = db.table(roots);

    // Sixteen encoded strings plus "1" and "0" are exactly16MiB. No row matches their fictional large values.
    db.clearTrace();
    assert.deepEqual(await rootRows.findMany({ select: ['id'], where: inArray(roots.col('label'), parts(CAP - 2)), limit: 1, offset: 0 }), []);
    assert.equal(reads(db).length, 1); redacted(db);
    db.clearTrace();
    await assert.rejects(Promise.resolve().then(() => rootRows.findMany({ select: ['id'], where: inArray(roots.col('label'), parts(CAP - 1)), limit: 1, offset: 0 })), safeRefusal);
    assert.deepEqual(db.exportTrace().queries, []); assert.equal(await rootRows.count(), 2); redacted(db);
    cases.push({ name: 'exact16MiB root request executes; one extra parameter payload byte refuses before root I/O',
      acceptedParameterBytes: CAP, rejectedParameterBytes: CAP + 1, acceptedSelects: 1, rejectedSelects: 0, healthyRootCount: 2 });

    assert.equal(await rootRows.count(eq(roots.col('id'), 999)), 0);
    const oversized = inArray(leaves.col('label'), parts(CAP + 1));
    const relation = (factory, options = {}) => factory(leaves, { localKey: roots.col('id'), foreignKey: leaves.col('rootId'), ...options });
    let refusedVariants = 0;
    for (const make of [hasMany, hasOne, belongsTo]) for (const options of [{ limit: 0 }, { where: eq(roots.col('id'), 999) }]) {
      db.clearTrace();
      await assert.rejects(Promise.resolve().then(() => rootRows.findMany({ ...options, include: { leaf: relation(make, { where: oversized }) } })), safeRefusal);
      assert.deepEqual(db.exportTrace().queries, []); refusedVariants++; redacted(db);
    }
    const nestedLeaf = relation(hasMany, { where: oversized });
    const owner = belongsTo(roots, { localKey: leaves.col('rootId'), foreignKey: roots.col('id'), include: { leaf: nestedLeaf } });
    db.clearTrace();
    await assert.rejects(Promise.resolve().then(() => rootRows.findMany({ limit: 0, include: { leaf: relation(hasMany, { limit: 0, include: { owner } }) } })), safeRefusal);
    assert.deepEqual(db.exportTrace().queries, []); refusedVariants++; redacted(db);
    cases.push({ name: 'known oversized filters refuse before any root request across relation kinds, root limit0, empty roots and a deep zero-limit child',
      refusedVariants, selectsBeforeRefusal: 0, rejectedCode: 'QUERY' });

    const textRelation = excess => hasMany(leaves, { localKey: roots.col('key'), foreignKey: leaves.col('key'), select: ['label'], limit: 2,
      where: inArray(leaves.col('label'), parts(14 * MiB - 7 + excess)) });
    const graphOptions = leaf => ({ select: ['id'], orderBy: [asc(roots.col('id'))], limit: 2, include: { leaf } });
    // Two actual one-MiB keys +14MiB−7 filter bytes +"0","2","10001" =16MiB in the child request.
    db.clearTrace();
    assert.deepEqual(await rootRows.findMany(graphOptions(textRelation(0))), [{ id: 1, leaf: [] }, { id: 2, leaf: [] }]);
    assert.equal(reads(db).length, 2); redacted(db);
    let fulfilled = false;
    await db.transaction(async tx => {
      db.clearTrace();
      const query = Promise.resolve().then(() => tx.table(roots).findMany(graphOptions(textRelation(1))))
        .then(value => { fulfilled = true; return value; });
      await assert.rejects(query, safeRefusal); assert.equal(fulfilled, false);
      assert.equal(reads(db).length, 1, 'Actual source keys are known after the root read; the oversized child must never be sent.'); redacted(db);
      await tx.table(markers).insert({ id: 1, label: 'Committed after local parameter refusal' });
      assert.equal(await tx.table(roots).count(), 2);
    });
    assert.deepEqual(await db.table(markers).findMany({ select: ['label'] }), [{ label: 'Committed after local parameter refusal' }]);
    const small = hasMany(leaves, { localKey: roots.col('key'), foreignKey: leaves.col('key'), select: ['label'], limit: 2 });
    assert.deepEqual(await rootRows.findMany(graphOptions(small)), [{ id: 1, leaf: [{ label: 'leaf-one' }] }, { id: 2, leaf: [{ label: 'leaf-two' }] }]); redacted(db);
    cases.push({ name: 'actual source keys share the child payload budget with filters and generated bounds; caught local refusal leaves the transaction and later graphs healthy',
      acceptedChildParameterBytes: CAP, rejectedChildParameterBytes: CAP + 1, acceptedGraphSelects: 2, rejectedGraphSelects: 1,
      partialGraphExposed: fulfilled, committedMarker: true, laterSmallGraphPassed: true });
    return report;
  } catch (error) { failed = true; throw error; }
  finally {
    const errors = [];
    if (db) try { await db.close(); cleanup.closedDatabases++; } catch { errors.push('close'); }
    if (postgres && created) try { await query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); cleanup.schemaDropped = true; } catch { errors.push('schema'); }
    if (!failed) { assert.equal(cleanup.openedDatabases, cleanup.closedDatabases); if (errors.length) throw new Error('Owned parameter fixture cleanup failed.'); }
  }
}
