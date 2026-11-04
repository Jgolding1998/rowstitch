// Default native graph budgets through actual public factories, without smaller injected limits.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const quote = name => '"' + name.replaceAll('"', '""') + '"';
const reads = db => db.exportTrace().queries.filter(entry => entry.operation === 'select');
const WIRE_LIMIT = 32 * 1024 * 1024, ACCOUNTING_LIMIT = 256 * 1024 * 1024;
const GRAPH_LIMIT_MESSAGE = 'The native eager graph exceeds its resource budget. Narrow the selected fields or page limits.';

/**
 * Supply the SDK/factories from one actual build or installed package. PostgreSQL admin.query must be the caller's
 * positional raw-text transport on its already verified disposable server. The helper owns only a random schema
 * and opened handle. It does not install clients, change limits/feature flags, start servers or close caller admin.
 * PGlite uses its real fresh private-worker public factory, including fixture inserts through the public API.
 */
export async function runPublicEagerResourceCases({ engine, sdk, openPostgresDatabase, openPgliteDatabase, postgresOptions, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite');
  const postgres = engine === 'postgresql', factory = postgres ? openPostgresDatabase : openPgliteDatabase;
  assert.equal(typeof factory, 'function');
  if (postgres) {
    assert.equal(typeof admin?.query, 'function'); assert.equal(postgresOptions?.connectionString, undefined);
    for (const key of ['host', 'user', 'database']) assert.equal(typeof postgresOptions?.[key], 'string');
  }
  const { column, defineTable, hasMany, eq, asc } = sdk;
  const schema = postgres ? 'rs_eager_resources_' + randomBytes(6).toString('hex') : 'public';
  const wireRoots = defineTable('resource_wire_roots', { id: column.integer().primaryKey(), groupKey: column.text() });
  const wireTargets = defineTable('resource_wire_targets', { id: column.integer().primaryKey(), groupKey: column.text(), payload: column.text() });
  const jsonRoots = defineTable('resource_json_roots', { id: column.integer().primaryKey(), groupKey: column.text() });
  const jsonTargets = defineTable('resource_json_targets', { id: column.integer().primaryKey(), groupKey: column.text(), payload: column.json() });
  const markers = defineTable('resource_commit_markers', { id: column.integer().primaryKey(), label: column.text() });
  const cases = [], cleanup = { openedDatabases: 0, closedDatabases: 0, schemaDropped: !postgres };
  const report = { engine, cases, cleanup, defaultPolicies: { cumulativeRelatedWireBytes: WIRE_LIMIT, graphAccountingUnits: ACCOUNTING_LIMIT }, limits: [
    'These controls use default public-factory graph policies, with no injected smaller limits or replacement executor.',
    'Graph accounting units describe admitted representations and copy work, not measured heap bytes or prevention of prior driver/JSON parsing allocation.',
    'The structuredClone observer is confined to one awaited graph query and restored exactly; its emergency guard must never activate.',
    'Resource refusal, redaction and transaction recovery are tested; two-connection isolation, custom collation and transport loss require separate controls.',
  ] };
  const query = async (sql, values = []) => {
    try { return await admin.query(sql, values); }
    catch { throw new Error('Owned eager resource fixture administration failed.'); }
  };
  const safeLimit = (error, privateMarkers) => {
    assert.equal(error?.code, 'RESULT_LIMIT'); assert.equal(error.message, GRAPH_LIMIT_MESSAGE); assert.equal(error.cause, undefined);
    const rendered = String(error.message) + String(error.stack) + JSON.stringify(error);
    for (const marker of privateMarkers) assert.ok(!rendered.includes(marker), 'A local graph refusal must not retain fictional source values.');
    return true;
  };
  let db, created = false, failed = false;
  const insert = async (table, rows) => {
    for (let index = 0; index < rows.length; index += 1000) await db.table(table).insertMany(rows.slice(index, index + 1000));
  };
  try {
    if (postgres) { await query('CREATE SCHEMA ' + quote(schema)); created = true; await query('REVOKE ALL ON SCHEMA ' + quote(schema) + ' FROM PUBLIC'); }
    db = await factory({ ...(postgres ? postgresOptions : {}), schema, tables: [wireRoots, wireTargets, jsonRoots, jsonTargets, markers], traceValues: false, maxTraceEntries: 1000 });
    cleanup.openedDatabases++; await db.ensureSchema();

    const wireMarker = 'FICTIONAL_WIRE_RESOURCE_MARKER_';
    const payloadBytes = 5 * 1024, textPayload = wireMarker + 'x'.repeat(payloadBytes - wireMarker.length);
    assert.equal(Buffer.byteLength(textPayload, 'utf8'), payloadBytes); assert.equal(textPayload.length, payloadBytes);
    await insert(wireRoots, [{ id: 1, groupKey: 'g' }, { id: 2, groupKey: 'g' }]);
    await insert(wireTargets, Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, groupKey: 'g', payload: textPayload })));
    const wireRelation = hasMany(wireTargets, { localKey: wireRoots.col('groupKey'), foreignKey: wireTargets.col('groupKey'), select: ['payload'], limit: 1000 });
    const aliases = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['page' + i, wireRelation]));
    // Two equal source keys deduplicate into one text key/ordinal. Child fields are payload + hidden groupKey,
    // followed by native rank + parent ordinal. The unselected target PK orders the page but is not returned.
    const rankBytes = Array.from({ length: 1000 }, (_, i) => String(i + 1).length).reduce((sum, n) => sum + n, 0);
    const physicalFieldBytes = [0, 1, 2, 3].reduce((sum, i) => sum + Buffer.byteLength('__rs_pg_' + i, 'utf8'), 0);
    const wirePerResponse = 1000 * (payloadBytes + 1 + 1) + rankBytes + physicalFieldBytes;
    assert.equal(rankBytes, 2893); assert.equal(physicalFieldBytes, 36); assert.equal(wirePerResponse, 5_124_929);
    assert.ok(wirePerResponse < 16 * 1024 * 1024, 'A single child response must fit its independent profile limit.');
    assert.ok(6 * wirePerResponse < WIRE_LIMIT); assert.ok(7 * wirePerResponse > WIRE_LIMIT);
    // All six admitted aliases retain only 6000 source rows before materialization; even a conservative11KiB
    // per canonical text source row stays below the separate256MiB accounting policy.
    assert.ok(6000 * 11 * 1024 < ACCOUNTING_LIMIT);
    db.clearTrace(); let wireFulfilled = false;
    const overWire = db.table(wireRoots).findMany({ select: ['id'], orderBy: [asc(wireRoots.col('id'))], include: aliases })
      .then(value => { wireFulfilled = true; return value; });
    await assert.rejects(overWire, error => safeLimit(error, [wireMarker]));
    assert.equal(wireFulfilled, false, 'No prefix of the graph may escape the rejected promise.');
    assert.equal(reads(db).length, 8, 'One root plus the seventh child response must stop before alias eight.');
    assert.ok(!JSON.stringify(db.exportTrace()).includes(wireMarker));
    assert.equal(await db.table(wireRoots).count(), 2); assert.equal(await db.table(wireTargets).count(), 1000);
    // A later small graph must get a new meter and preserve exact public output, including detached copies.
    const smallWire = hasMany(wireTargets, { localKey: wireRoots.col('groupKey'), foreignKey: wireTargets.col('groupKey'), select: ['payload'], limit: 1 });
    const recovered = await db.table(wireRoots).findMany({ select: ['id'], orderBy: [asc(wireRoots.col('id'))], include: { leaf: smallWire } });
    assert.deepEqual(recovered, [{ id: 1, leaf: [{ payload: textPayload }] }, { id: 2, leaf: [{ payload: textPayload }] }]);
    assert.notEqual(recovered[0].leaf, recovered[1].leaf); assert.notEqual(recovered[0].leaf[0], recovered[1].leaf[0]);
    cases.push({ name: 'default cumulative32MiB wire policy stops the seventh individually valid alias response before copy materialization',
      childRowsPerResponse: 1000, childWireBytesPerResponse: wirePerResponse, priorAdmittedRelatedRows: 6000,
      expectedSelects: 8, observedSelectsBeforeRecovery: 8, rejectedCode: 'RESULT_LIMIT', nextRootCount: 2, nextTargetCount: 1000, laterSmallGraphPassed: true });

    const jsonMarker = "FICTIONAL_JSON_RESOURCE_'_KEY";
    const nullArray = Array(10_000).fill(null);
    await insert(jsonRoots, Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, groupKey: jsonMarker })));
    await insert(jsonTargets, [{ id: 1, groupKey: jsonMarker, payload: nullArray }, { id: 2, groupKey: jsonMarker, payload: nullArray }]);
    const jsonRelation = hasMany(jsonTargets, { localKey: jsonRoots.col('groupKey'), foreignKey: jsonTargets.col('groupKey'), select: ['payload'], limit: 2 });
    const jsonOptions = { select: ['id'], limit: 2000, orderBy: [asc(jsonRoots.col('id'))], include: { left: jsonRelation, right: jsonRelation } };
    const potentialCopies = 2000 * 2 * 2;
    assert.equal(potentialCopies, 8000); assert.ok(potentialCopies < 10000);
    // Independent policy arithmetic: array32 +10000 entries×(entry8 +null16). Cached once per decoded JSON,
    // then charged before each selected output occurrence; its tiny JSON spelling alone cannot bound copying.
    const jsonStructuralUnits = 32 + 10_000 * (8 + 16);
    assert.equal(jsonStructuralUnits, 240032); assert.ok(jsonStructuralUnits * potentialCopies > ACCOUNTING_LIMIT);
    assert.ok(4 * Buffer.byteLength(JSON.stringify(nullArray), 'utf8') < WIRE_LIMIT);
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    assert.ok(originalDescriptor && Object.hasOwn(originalDescriptor, 'value') && typeof originalDescriptor.value === 'function');
    const originalClone = originalDescriptor.value, cloneGuard = 2000;
    let clones = 0, guardTriggered = false, jsonFulfilled = false;
    await db.transaction(async tx => {
      db.clearTrace();
      Object.defineProperty(globalThis, 'structuredClone', { ...originalDescriptor, value: function (...args) {
        clones++;
        if (clones > cloneGuard) { guardTriggered = true; throw new Error('Unexpected eager resource clone guard.'); }
        return Reflect.apply(originalClone, this, args);
      } });
      try {
        const overCopies = tx.table(jsonRoots).findMany(jsonOptions).then(value => { jsonFulfilled = true; return value; });
        await assert.rejects(overCopies, error => safeLimit(error, [jsonMarker]));
      } finally { Object.defineProperty(globalThis, 'structuredClone', originalDescriptor); }
      assert.equal(guardTriggered, false, 'The emergency observer guard must never substitute for the product budget.');
      assert.ok(clones > 0 && clones < cloneGuard, 'The default accounting policy must refuse during bounded JSON materialization.');
      assert.equal(jsonFulfilled, false);
      assert.equal(reads(db).length, 3, 'One root and two tiny alias fetches finish before output accounting refuses.');
      assert.ok(!JSON.stringify(db.exportTrace()).includes(jsonMarker));
      // This is a caught acknowledged local limit, not a statement/transport failure: the same transaction can write.
      await tx.table(markers).insert({ id: 1, label: 'Committed after acknowledged graph resource refusal' });
      assert.equal(await tx.table(jsonRoots).count(), 2000);
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'structuredClone'), originalDescriptor);
    assert.equal(await db.table(jsonRoots).count(), 2000); assert.equal(await db.table(jsonTargets).count(), 2);
    assert.deepEqual(await db.table(markers).findFirst({ where: eq(markers.col('id'), 1), select: ['label'] }),
      { label: 'Committed after acknowledged graph resource refusal' });
    const recoveredJson = await db.table(jsonRoots).findFirst({ where: eq(jsonRoots.col('id'), 1), select: ['id'], include: {
      leaf: hasMany(jsonTargets, { localKey: jsonRoots.col('groupKey'), foreignKey: jsonTargets.col('groupKey'), select: ['payload'], limit: 1 }),
    } });
    assert.deepEqual(recoveredJson, { id: 1, leaf: [{ payload: nullArray }] });
    assert.equal(recoveredJson.leaf[0].payload.length, 10000); assert.ok(recoveredJson.leaf[0].payload.every(value => value === null));
    cases.push({ name: 'default256MiB accounting policy rejects small-node JSON copy amplification below fetched/copy/wire limits and preserves transaction commit',
      parents: 2000, fetchedRows: 4, potentialReturnedCopies: potentialCopies, jsonArrayNodes: 10001,
      cachedStructuralUnitsPerArray: jsonStructuralUnits, observedClones: clones, emergencyCloneGuard: cloneGuard, guardTriggered,
      expectedSelects: 3, observedSelectsBeforeRecovery: 3, rejectedCode: 'RESULT_LIMIT', committedMarker: true, laterSmallGraphPassed: true });
    return report;
  } catch (error) { failed = true; throw error; }
  finally {
    const errors = [];
    if (db) try { await db.close(); cleanup.closedDatabases++; } catch { errors.push('close'); }
    if (postgres && created) try { await query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); cleanup.schemaDropped = true; } catch { errors.push('schema'); }
    if (!failed) { assert.equal(cleanup.openedDatabases, cleanup.closedDatabases); if (errors.length) throw new Error('Owned eager resource fixture cleanup failed.'); }
  }
}
