// Actual public factories, supplied by the source-hashed engine harness. Fictional data and owned resources only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const code = expected => error => error?.code === expected;
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const qualified = (schema, table) => quote(schema) + '.' + quote(table);

/**
 * sdk and both factory functions must come from the SAME compiled source tree, not an executor/test replacement.
 * PostgreSQL needs direct-field postgresOptions accepted by its public factory and a caller-owned administrative
 * transport with query(sql, parameters) returning positional raw-text rows. It must target the SAME disposable
 * database; the harness verifies its Docker/fixture ownership before calling. This runner owns only its newly
 * created random schema/LOGIN and ORM handles; it neither creates Docker resources nor closes the caller's admin.
 *
 * PGlite uses its real fresh in-memory public factory. Its current API cannot consume externally prepared tables,
 * roles or an admin connection, so the PostgreSQL-specific principal/trigger/partition cases are reported separately.
 */
export async function runPublicApiCases({ engine, sdk, openPostgresDatabase, openPgliteDatabase, postgresOptions, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite');
  const postgres = engine === 'postgresql';
  const factory = postgres ? openPostgresDatabase : openPgliteDatabase;
  assert.equal(typeof factory, 'function');
  const { column, defineTable, eq, asc, not, startsWith, endsWith, contains, between, inArray,
    hasMany, some, none, every, countRelated, agg } = sdk;
  const token = randomBytes(6).toString('hex');
  const schema = postgres ? 'rs_public_' + token : 'public';
  const role = 'rs_public_role_' + token, applicationName = 'rs-public-rls-' + token;
  let password, schemaCreated = false, roleCreated = false, failed = false;
  const databases = new Set(), cases = [];
  const cleanup = { openedDatabases: 0, closedDatabases: 0, schemaDropped: !postgres, roleDropped: !postgres };
  const report = { engine, cases, postgresRole: null, cleanup,
    limits: postgres ? ['Dedicated owned clients; no pool, external-user or uncertain-COMMIT claim.']
      : ['Fresh private in-memory public PGlite factory; external-admin RLS, trigger and partition setup is unavailable and is not claimed here.'] };
  if (postgres) {
    assert.equal(typeof admin?.query, 'function');
    assert.ok(postgresOptions && postgresOptions.connectionString === undefined, 'The restricted-login case requires an explicit direct-field target.');
    for (const key of ['host', 'user', 'database']) assert.equal(typeof postgresOptions[key], 'string');
  }
  const options = orm => postgres ? { ...postgresOptions, ...orm } : orm;
  const own = async promise => { const db = await promise; databases.add(db); cleanup.openedDatabases++; return db; };
  const close = async db => { await db.close(); if (databases.delete(db)) cleanup.closedDatabases++; };
  const query = (sql, values = []) => admin.query(sql, values);
  const countNative = async sql => BigInt((await query(sql)).rows[0][0]);

  const parents = defineTable('api_parents', {
    id: column.integer().primaryKey({ generated: true }), name: column.text().default('Sample'),
    exact: column.bigint().default(9223372036854775807n), ratio: column.real().default(-0),
    active: column.boolean().default(true), payload: column.json().default({ items: [true, null, 1] }),
    note: column.text().nullable().default(null), version: column.integer().default(1),
  }, { version: 'version' });
  const children = defineTable('api_children', { id: column.integer().primaryKey({ generated: true }),
    parent_id: column.integer().references(parents, 'id', { onDelete: 'cascade' }), label: column.text() });
  const filterRoots = defineTable('api_filter_roots', { id: column.integer().primaryKey(),
    label: column.text().nullable(), score: column.integer().nullable() });
  const filterLeaves = defineTable('api_filter_leaves', { id: column.integer().primaryKey(),
    root_id: column.integer().nullable().references(filterRoots, 'id'),
    approved: column.boolean().nullable(), visible: column.boolean() });

  try {
    if (postgres) {
      await query('CREATE SCHEMA ' + quote(schema)); schemaCreated = true;
      await query('REVOKE ALL ON SCHEMA ' + quote(schema) + ' FROM PUBLIC');
    }
    const tables = [children, parents, filterLeaves, filterRoots], input = options({ tables, schema, readOnly: false, traceValues: false });
    // Call the actual factory directly: a wrapper must not do the capture being tested on the factory's behalf.
    const opening = factory(input);
    tables.length = 0; input.schema = 'pg_catalog'; input.readOnly = true; input.traceValues = true;
    const db = await own(opening), parentRows = db.table(parents), childRows = db.table(children);
    const originalSchema = await db.inspectSchema();
    assert.ok(!originalSchema.some(table => table.name === parents.name || table.name === children.name));
    const planned = await db.planSchema();
    const createdTables = planned.filter(plan => plan.action === 'create-table').map(plan => plan.table);
    assert.deepEqual(createdTables.filter(name => name === parents.name || name === children.name), [parents.name, children.name]);
    assert.ok(createdTables.indexOf(filterRoots.name) < createdTables.indexOf(filterLeaves.name));
    assert.ok(planned.every(plan => Object.keys(plan).sort().join(',') === 'action,sql,table'));
    assert.deepEqual(await db.inspectSchema(), originalSchema, 'Planning must leave the observed native schema unchanged.');
    const ensured = await db.ensureSchema();
    assert.equal(ensured.length, planned.length); assert.deepEqual(await db.ensureSchema(), []);
    assert.deepEqual((await db.inspectSchema()).filter(table => table.name === parents.name || table.name === children.name).map(table => table.name).sort(), [children.name, parents.name].sort());
    cases.push('public open captures ORM options/tables before await; plan is read-only and ensure is parent-first and idempotent');

    const first = await parentRows.insert({});
    assert.equal(first.id, 1); assert.equal(first.name, 'Sample'); assert.equal(first.exact, 9223372036854775807n);
    assert.ok(Object.is(first.ratio, -0)); assert.equal(first.active, true); assert.equal(first.note, null);
    assert.deepEqual(first.payload, { items: [true, null, 1] }); assert.equal(first.version, 1);
    const marker = "SYNTHETIC_' OR 1=1--";
    const data = { name: marker, exact: -9223372036854775808n, ratio: 0.1, payload: { captured: 'first' } };
    const inserted = parentRows.insert(data); data.name = 'later'; data.payload.captured = 'later';
    const second = await inserted;
    assert.equal(second.name, marker); assert.equal(second.exact, -9223372036854775808n); assert.deepEqual(second.payload, { captured: 'first' });
    assert.equal(second.ratio, 0.1);
    cases.push('actual public insert returns all scalar/default values and captures mutable input before queueing');

    const compiled = parentRows.compileSelect({ where: eq(parents.col('active'), true), select: ['id', 'name'], limit: 1 });
    assert.deepEqual(Object.keys(compiled).sort(), ['parameters', 'sql']); compiled.parameters.push('caller edit');
    const selected = await parentRows.findMany({ where: eq(parents.col('active'), true), select: ['id', 'name'], orderBy: [asc(parents.col('id'))], limit: 1 });
    assert.deepEqual(selected, [{ id: first.id, name: first.name }]); assert.equal(await parentRows.count(eq(parents.col('active'), true)), 2);
    await assert.rejects(parentRows.update({ note: 'too many' }, { where: eq(parents.col('active'), true), maxRows: 1 }), code('AFFECTED_ROWS'));
    assert.deepEqual((await parentRows.findMany({ orderBy: [asc(parents.col('id'))] })).map(row => row.note), [null, null]);
    const versioned = await parentRows.updateVersion({ id: second.id }, 1, { name: 'Changed' }); assert.equal(versioned.version, 2);
    await assert.rejects(parentRows.updateVersion({ id: second.id }, 1, { name: 'Stale' }), code('CONFLICT'));
    assert.equal((await parentRows.delete({ where: eq(parents.col('id'), second.id), maxRows: 1 })).length, 1);
    cases.push('public selection/count/compile and guarded CRUD/version updates preserve native stored results');

    const original = new Error('Fictional callback failure');
    await assert.rejects(db.transaction(async tx => { await tx.table(parents).insert({ name: 'rolled back' }); throw original; }), error => error === original);
    assert.equal(await parentRows.count(eq(parents.col('name'), 'rolled back')), 0);
    let committedId;
    await db.transaction(async tx => {
      const outer = await tx.table(parents).insert({ name: 'outer', active: false }); committedId = outer.id;
      await assert.rejects(tx.transaction(child => child.table(parents).insert({ id: outer.id, name: 'duplicate' })), code('CONSTRAINT'));
      await tx.table(parents).insert({ name: 'after child', active: false });
    });
    assert.equal(await parentRows.count(eq(parents.col('id'), committedId)), 1);
    assert.equal(await parentRows.count(eq(parents.col('name'), 'after child')), 1);
    cases.push('actual public rollback preserves callback identity and failed nested savepoint recovers for parent commit');

    await childRows.insert({ parent_id: first.id, label: 'Sample child' });
    await assert.rejects(childRows.insert({ parent_id: 999999, label: 'missing parent' }), code('CONSTRAINT'));
    assert.equal(await childRows.count(), 1);
    await parentRows.delete({ where: eq(parents.col('id'), first.id), maxRows: 1 }); assert.equal(await childRows.count(), 0);
    cases.push('public FK rejection rolls back and actual parent deletion cascades');

    const trace = db.exportTrace();
    assert.ok(!JSON.stringify(trace).includes(marker), 'Captured traceValues:false must keep bound marker data redacted.');
    assert.ok(trace.queries.some(entry => entry.operation === 'insert'));
    assert.ok(!trace.queries.some(entry => entry.sql.includes('"pg_catalog"."pg_class"')), 'Native schema metadata must stay untraced.');
    assert.equal(trace.version, 1);
    cases.push('actual public trace stays v1, redacts captured bound values and excludes catalog metadata');

    const filterRows = db.table(filterRoots);
    await filterRows.insertMany([
      { id: 1, label: 'Alpha%_Tail', score: 1 }, { id: 2, label: 'alpha%_tail', score: 2 },
      { id: 3, label: 'AlphaXYTail', score: 3 }, { id: 4, label: 'Écho%_Tail', score: null },
      { id: 5, label: null, score: 5 }, { id: 6, label: '', score: 6 },
      { id: 7, label: 'ALPHA%_TAIL', score: 7 }, { id: 8, label: 'slash\\%_', score: 8 },
    ]);
    await db.table(filterLeaves).insertMany([
      { id: 11, root_id: 1, approved: true, visible: true }, { id: 12, root_id: 1, approved: true, visible: true },
      { id: 21, root_id: 2, approved: true, visible: true }, { id: 22, root_id: 2, approved: false, visible: true },
      { id: 31, root_id: 3, approved: null, visible: true }, { id: 51, root_id: 5, approved: false, visible: true },
      { id: 61, root_id: 6, approved: false, visible: false }, { id: 81, root_id: 8, approved: true, visible: false },
      { id: 99, root_id: null, approved: true, visible: true },
    ]);
    if (postgres) {
      assert.equal(await countNative('SELECT count(*)::text FROM ' + qualified(schema, filterRoots.name)), 8n);
      assert.equal(await countNative('SELECT count(*)::text FROM ' + qualified(schema, filterLeaves.name)), 9n);
    }
    const expectIds = async (name, where, expected) => {
      const actual = await filterRows.findMany({ where, select: ['id'], orderBy: [asc(filterRoots.col('id'))] });
      assert.deepEqual(actual.map(row => row.id), expected, engine + ': ' + name);
    };
    // Handwritten expected IDs deliberately distinguish literal percent/underscore/backslash from SQL wildcards.
    const label = filterRoots.col('label'), insensitive = { case: 'ascii-insensitive' };
    for (const [name, predicate, expected] of [
      ['contains literal %_', contains(label, '%_'), [1, 2, 4, 7, 8]],
      ['startsWith sensitive default', startsWith(label, 'Alpha%_'), [1]],
      ['startsWith ASCII fold', startsWith(label, 'Alpha%_', insensitive), [1, 2, 7]],
      ['endsWith sensitive default', endsWith(label, '%_Tail'), [1, 4]],
      ['endsWith ASCII fold', endsWith(label, '%_Tail', insensitive), [1, 2, 4, 7]],
      ['contains sensitive default', contains(label, 'ALPHA'), [7]],
      ['contains ASCII fold', contains(label, 'ALPHA', insensitive), [1, 2, 3, 7]],
      ['ASCII fold preserves non-ASCII case', startsWith(label, 'é', insensitive), []],
      ['non-ASCII exact prefix', startsWith(label, 'É'), [4]],
      ['backslash is a literal prefix', startsWith(label, 'slash\\'), [8]],
      ['backslash/percent/underscore are a literal suffix', endsWith(label, '\\%_'), [8]],
    ]) await expectIds(name, predicate, expected);
    cases.push('actual native startsWith/endsWith/contains treat wildcard characters literally and apply sensitive or ASCII-only case contracts');

    const score = filterRoots.col('score');
    for (const [name, predicate, expected] of [
      ['between includes both bounds and excludes SQL NULL', between(score, 2, 5), [2, 3, 5]],
      ['between text uses declared native comparison', between(label, 'Alpha', 'Alphaz'), [1, 3]],
      ['empty IN is false even for nullable rows', inArray(score, []), []],
      ['nonnull IN selects exact values', inArray(score, [2, 5]), [2, 5]],
      ['NULL-only IN is explicit null membership', inArray(score, [null]), [4]],
      ['mixed IN includes explicit NULL membership', inArray(score, [null, 2, 5]), [2, 4, 5]],
      ['duplicate IN values do not duplicate root rows', inArray(score, [null, 2, 2]), [2, 4]],
      ['NOT empty IN includes SQL NULL', not(inArray(score, [])), [1, 2, 3, 4, 5, 6, 7, 8]],
      ['NOT nonnull IN preserves SQL UNKNOWN for a NULL column', not(inArray(score, [2])), [1, 3, 5, 6, 7, 8]],
      ['text NULL/empty membership is distinct', inArray(label, [null, '']), [5, 6]],
      ['text IN is case-sensitive', inArray(label, ['alpha%_tail']), [2]],
    ]) await expectIds(name, predicate, expected);
    cases.push('actual native between is inclusive; inArray has empty-list, exact nonnull and explicit NULL-membership semantics');

    const leaves = hasMany(filterLeaves, { localKey: filterRoots.col('id'), foreignKey: filterLeaves.col('root_id') });
    const visibleLeaves = hasMany(filterLeaves, { localKey: filterRoots.col('id'), foreignKey: filterLeaves.col('root_id'), where: eq(filterLeaves.col('visible'), true) });
    const approved = eq(filterLeaves.col('approved'), true);
    for (const [name, predicate, expected] of [
      ['some existence', some(leaves), [1, 2, 3, 5, 6, 8]],
      ['none existence excludes orphan NULL key', none(leaves), [4, 7]],
      ['some matching rows', some(leaves, approved), [1, 2, 8]],
      ['none matching includes NULL-only related test', none(leaves, approved), [3, 4, 5, 6, 7]],
      ['every is vacuously true but NULL is a counterexample', every(leaves, approved), [1, 4, 7, 8]],
      ['none NOT differs from every for a NULL test', none(leaves, not(approved)), [1, 3, 4, 7, 8]],
      ['domain-filtered some', some(visibleLeaves), [1, 2, 3, 5]],
      ['domain-filtered every has empty filtered domains', every(visibleLeaves, approved), [1, 4, 6, 7, 8]],
      ['related count equality', countRelated(leaves, '=', 2), [1, 2]],
      ['related count inequality', countRelated(leaves, '<>', 1), [1, 2, 4, 7]],
      ['related count greater', countRelated(leaves, '>', 1), [1, 2]],
      ['related count greater or equal counts NULL-valued rows', countRelated(leaves, '>=', 1), [1, 2, 3, 5, 6, 8]],
      ['related count less includes empty relations', countRelated(leaves, '<', 1), [4, 7]],
      ['related count less or equal', countRelated(leaves, '<=', 1), [3, 4, 5, 6, 7, 8]],
      ['related count predicate filters', countRelated(leaves, '=', 2, approved), [1]],
      ['related domain and predicate combine', countRelated(visibleLeaves, '>=', 1, approved), [1, 2]],
      ['filtered empty domains count zero', countRelated(visibleLeaves, '=', 0), [4, 6, 7, 8]],
    ]) await expectIds(name, predicate, expected);
    cases.push('actual native some/none/every/countRelated obey NULL/empty/domain semantics, all count operators and NULL foreign-key nonmatches');

    db.clearTrace();
    const beforeUnsupported = db.exportTrace(), aggregate = { select: { n: agg.count() } }, group = { by: ['score'], ...aggregate };
    assert.deepEqual(Object.keys(filterRows.compileAggregate(aggregate)).sort(), ['parameters', 'sql']);
    assert.deepEqual(Object.keys(filterRows.compileGroupBy(group)).sort(), ['parameters', 'sql']);
    await assert.rejects(filterRows.findMany({ include: { leaves } }), code('QUERY'));
    await assert.rejects(filterRows.explain(), code('QUERY'));
    await assert.rejects(filterRows.explainAggregate(aggregate), code('QUERY'));
    await assert.rejects(filterRows.explainGroupBy(group), code('QUERY'));
    for (const match of [contains, startsWith, endsWith]) assert.throws(() => match(label, ''), code('QUERY'));
    assert.deepEqual(db.exportTrace().queries, beforeUnsupported.queries, 'Unsupported public native methods must not emit any SQL/control trace entry.');
    assert.deepEqual(await filterRows.aggregate(aggregate), { n: 8 });
    assert.deepEqual(await filterRows.groupBy(group), [null, 1, 2, 3, 5, 6, 7, 8].map(score => ({ score, n: 1 })));
    assert.equal(await filterRows.count(), 8, 'Refusals must leave the actual public connection usable.');
    cases.push('native summary compilation is pure; COUNT and nullable grouping execute; eager includes/explains and empty text literals refuse before SQL');
    await close(db);

    if (postgres) {
      const triggerTable = defineTable('api_trigger_rows', { id: column.integer().primaryKey(), value: column.text() });
      const triggerName = qualified(schema, triggerTable.name), functionName = qualified(schema, 'transform_or_suppress');
      await query('CREATE TABLE ' + triggerName + '(id bigint PRIMARY KEY,value text NOT NULL)');
      await query('CREATE FUNCTION ' + functionName + `() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN IF NEW.value = 'suppress' THEN RETURN NULL; END IF; NEW.value := NEW.value || ':stored'; RETURN NEW; END $fn$`);
      await query('CREATE TRIGGER transform_or_suppress BEFORE INSERT OR UPDATE ON ' + triggerName + ' FOR EACH ROW EXECUTE FUNCTION ' + functionName + '()');
      const triggered = await own(factory(options({ schema, tables: [triggerTable] })));
      assert.deepEqual(await triggered.ensureSchema(), [], 'Trusted native trigger must not be refused as strict mapped roots.');
      const repository = triggered.table(triggerTable);
      assert.deepEqual(await repository.insert({ id: 1, value: 'ok' }), { id: 1, value: 'ok:stored' });
      assert.equal((await query('SELECT value FROM ' + triggerName + ' WHERE id=1')).rows[0][0], 'ok:stored');
      assert.deepEqual(await repository.update({ value: 'changed' }, { where: eq(triggerTable.col('id'), 1), maxRows: 1 }), [{ id: 1, value: 'changed:stored' }]);
      await assert.rejects(repository.insert({ id: 2, value: 'suppress' }), code('DATA'));
      await assert.rejects(repository.update({ value: 'suppress' }, { where: eq(triggerTable.col('id'), 1), maxRows: 1 }), code('AFFECTED_ROWS'));
      assert.equal(await countNative('SELECT count(*)::text FROM ' + triggerName + ' WHERE id=2'), 0n);
      assert.equal((await query('SELECT value FROM ' + triggerName + ' WHERE id=1')).rows[0][0], 'changed:stored');
      await close(triggered);
      cases.push('PostgreSQL trigger rewrites reach public RETURNING; suppressed insert/update reject and preserve actual stored rows');

      const partitioned = defineTable('api_partitioned', { id: column.integer().primaryKey(), bucket: column.integer().primaryKey(), label: column.text() });
      const partitionName = qualified(schema, partitioned.name), low = qualified(schema, 'api_partition_low'), high = qualified(schema, 'api_partition_high');
      await query('CREATE TABLE ' + partitionName + '(id bigint NOT NULL,bucket bigint NOT NULL,label text NOT NULL,PRIMARY KEY(id,bucket)) PARTITION BY RANGE(bucket)');
      await query('CREATE TABLE ' + low + ' PARTITION OF ' + partitionName + ' FOR VALUES FROM (MINVALUE) TO (10)');
      await query('CREATE TABLE ' + high + ' PARTITION OF ' + partitionName + ' FOR VALUES FROM (10) TO (MAXVALUE)');
      const partitionDb = await own(factory(options({ schema, tables: [partitioned] })));
      assert.deepEqual(await partitionDb.ensureSchema(), []);
      const partitionRows = partitionDb.table(partitioned);
      await partitionRows.insert({ id: 1, bucket: 1, label: 'low' }); await partitionRows.insert({ id: 2, bucket: 11, label: 'high' });
      assert.equal(await partitionRows.count(), 2); assert.equal(await countNative('SELECT count(*)::text FROM ' + low), 1n); assert.equal(await countNative('SELECT count(*)::text FROM ' + high), 1n);
      assert.equal((await partitionRows.update({ label: 'changed' }, { where: eq(partitioned.col('id'), 1), maxRows: 1 }))[0].label, 'changed');
      assert.equal((await partitionRows.delete({ where: eq(partitioned.col('id'), 2), maxRows: 1 })).length, 1);
      assert.equal(await countNative('SELECT count(*)::text FROM ' + high), 0n);
      await close(partitionDb);
      cases.push('PostgreSQL partitioned parent public CRUD includes real routed child rows and compatible composite keys');

      password = randomBytes(32).toString('base64url'); assert.match(password, /^[A-Za-z0-9_-]+$/);
      await query('CREATE ROLE ' + quote(role) + " LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'"); roleCreated = true;
      const rlsRows = defineTable('api_rls_rows', { id: column.integer().primaryKey(), tenant: column.text(), value: column.text(),
        observed_login: column.text().default(''), observed_role: column.text().default('') });
      const rlsName = qualified(schema, rlsRows.name), principal = qualified(schema, 'capture_principal');
      await query('CREATE TABLE ' + rlsName + "(id bigint PRIMARY KEY,tenant text NOT NULL,value text NOT NULL,observed_login text NOT NULL DEFAULT '',observed_role text NOT NULL DEFAULT '')");
      await query('INSERT INTO ' + rlsName + "(id,tenant,value) VALUES(1,$1,'own'),(2,'other_tenant','hidden')", [role]);
      await query('CREATE FUNCTION ' + principal + `() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN NEW.observed_login := SESSION_USER; NEW.observed_role := CURRENT_USER; RETURN NEW; END $fn$`);
      await query('CREATE TRIGGER capture_principal BEFORE INSERT OR UPDATE ON ' + rlsName + ' FOR EACH ROW EXECUTE FUNCTION ' + principal + '()');
      await query('ALTER TABLE ' + rlsName + ' ENABLE ROW LEVEL SECURITY'); await query('ALTER TABLE ' + rlsName + ' FORCE ROW LEVEL SECURITY');
      await query('CREATE POLICY restricted_tenant ON ' + rlsName + ' TO ' + quote(role) + ' USING(tenant OPERATOR(pg_catalog.=) CURRENT_USER::pg_catalog.text) WITH CHECK(tenant OPERATOR(pg_catalog.=) CURRENT_USER::pg_catalog.text)');
      await query('GRANT USAGE ON SCHEMA ' + quote(schema) + ' TO ' + quote(role));
      await query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + rlsName + ' TO ' + quote(role));
      await query('GRANT EXECUTE ON FUNCTION ' + principal + '() TO ' + quote(role));
      const privileges = (await query('SELECT rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_catalog.pg_roles WHERE rolname=$1', [role])).rows;
      assert.deepEqual(privileges, [['f', 'f', 'f', 'f', 'f', 'f']]);
      const restricted = await own(factory(options({ user: role, password, applicationName, schema, tables: [rlsRows] })));
      const sessions = (await query('SELECT a.usename,r.rolsuper,r.rolbypassrls FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.rolname=a.usename WHERE a.application_name=$1', [applicationName])).rows;
      assert.deepEqual(sessions, [[role, 'f', 'f']], 'The actual public connection must use the restricted LOGIN, not an owner/bypass connection.');
      const ownRows = restricted.table(rlsRows);
      assert.deepEqual((await ownRows.findMany({ orderBy: [asc(rlsRows.col('id'))] })).map(row => row.id), [1]); assert.equal(await ownRows.count(), 1);
      const observed = await ownRows.insert({ id: 3, tenant: role, value: 'inserted' });
      assert.equal(observed.observed_login, role); assert.equal(observed.observed_role, role, 'SECURITY INVOKER must see the real restricted login.');
      assert.deepEqual(await ownRows.update({ value: 'cannot see' }, { where: eq(rlsRows.col('id'), 2), maxRows: 1 }), []);
      assert.deepEqual(await ownRows.delete({ where: eq(rlsRows.col('id'), 2), maxRows: 1 }), []);
      await assert.rejects(ownRows.insert({ id: 4, tenant: 'other_tenant', value: 'forbidden' }), code('DATABASE_ERROR'));
      await assert.rejects(ownRows.update({ tenant: 'other_tenant' }, { where: eq(rlsRows.col('id'), 1), maxRows: 1 }), code('DATABASE_ERROR'));
      assert.equal((await query('SELECT value FROM ' + rlsName + ' WHERE id=2')).rows[0][0], 'hidden');
      assert.equal((await query('SELECT tenant FROM ' + rlsName + ' WHERE id=1')).rows[0][0], role);
      report.postgresRole = { actualRestrictedLogin: true, superuser: false, bypassRls: false, sessionUserAndCurrentUserVerified: true };
      cases.push('PostgreSQL RLS is checked through an actual non-superuser LOGIN, with session/current-user oracles and hidden-row/with-check effects');

      await assert.rejects(restricted.transaction(async tx => {
        await tx.table(rlsRows).insert({ id: 5, tenant: role, value: 'rollback marker' });
        await tx.table(rlsRows).insert({ id: 6, tenant: 'other_tenant', value: 'forbidden' });
      }), code('DATABASE_ERROR'));
      assert.equal(await countNative('SELECT count(*)::text FROM ' + rlsName + ' WHERE id IN(4,5,6)'), 0n);
      assert.equal((await ownRows.insert({ id: 7, tenant: role, value: 'recovered' })).observed_login, role);
      await close(restricted);
      cases.push('actual RLS rejection rolls back earlier public transaction work and the dedicated restricted connection recovers');
    }
    return report;
  } catch (error) { failed = true; throw error; }
  finally {
    const errors = [];
    for (const db of [...databases]) try { await close(db); } catch (error) { errors.push(error); }
    if (postgres && schemaCreated) try { await query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); cleanup.schemaDropped = true; } catch (error) { errors.push(error); }
    if (postgres && roleCreated) try { await query('DROP ROLE ' + quote(role)); cleanup.roleDropped = true; } catch (error) { errors.push(error); }
    // A role was never needed/created if an earlier case failed.
    if (!roleCreated) cleanup.roleDropped = true;
    password = undefined;
    if (!failed && errors.length) throw new AggregateError(errors, 'Owned public API fixture cleanup failed.');
    if (!failed) assert.equal(cleanup.openedDatabases, cleanup.closedDatabases);
  }
}
