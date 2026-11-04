// One owned PostgreSQL fixture; common application values and complete-result contracts are reported separately.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const MAX = 9223372036854775807n, MIN = -9223372036854775808n, ABOVE = 9007199254740993n;
const parents = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }, { id: 3, name: 'Gamma' }, { id: 4, name: 'Empty' }];
const children = [
  { id: 11n, parent_id: 1n, score: 2, label: 'beta', active: true, wide: MAX, payload: { n: 1 } },
  { id: 12n, parent_id: 1n, score: 1, label: 'alpha', active: false, wide: MIN, payload: { n: 2 } },
  { id: 13n, parent_id: 1n, score: 1, label: 'tied', active: true, wide: ABOVE, payload: { n: 3 } },
  { id: 14n, parent_id: 1n, score: null, label: null, active: true, wide: -1n, payload: null },
  { id: 21n, parent_id: 2n, score: 3, label: 'gamma', active: true, wide: ABOVE - 1n, payload: { n: 4 } },
  { id: 22n, parent_id: 2n, score: 1, label: 'delta', active: false, wide: 0n, payload: { n: 5 } },
  { id: 31n, parent_id: 3n, score: null, label: 'nullscore', active: true, wide: 5n, payload: {} },
  { id: 99n, parent_id: null, score: 4, label: 'orphan', active: true, wide: 7n, payload: {} },
];
const profiles = [{ id: 101, parent_id: 1, note: 'one' }, { id: 102, parent_id: 2, note: 'two' }];
const notes = [{ id: 111, child_id: 11n, text: 'a' }, { id: 112, child_id: 11n, text: 'b' }, { id: 131, child_id: 13n, text: 'c' },
  { id: 211, child_id: 21n, text: 'd' }, { id: 311, child_id: 31n, text: 'e' }];
const wideParents = [{ id: MIN, name: 'Minimum' }, { id: ABOVE - 1n, name: 'Neighbor without child' }, { id: ABOVE, name: 'Above safe' }, { id: MAX, name: 'Maximum' }];
const wideChildren = [{ id: 1, parent_id: MAX, label: 'max leaf' }, { id: 2, parent_id: ABOVE, label: 'above leaf' }, { id: 3, parent_id: MIN, label: 'min leaf' }, { id: 4, parent_id: null, label: 'unattached' }];

function decimal(value) {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') { assert.ok(Number.isSafeInteger(value), 'Never normalize a rounded Number into an exact ID'); return String(value); }
  assert.ok(typeof value === 'string' && /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value), 'Expected a lossless integer representation');
  return value;
}
function representation(value) {
  if (typeof value === 'bigint') return { type: 'bigint', decimal: String(value) };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'function') return { type: 'function' };
  if (Array.isArray(value)) return value.map(representation);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, representation(child)]));
  return value;
}
// Diagnostic snapshots contain only this fictional fixture's declared columns/relations, never client metadata.
function declaredSnapshot(value, depth = 0, payload = false) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return { type: 'bigint', decimal: String(value) };
  if (typeof value === 'string') return value.length > 256 ? value.slice(0, 256) + '<truncated>' : value;
  if (value === undefined) return { type: 'undefined' };
  if (!value || typeof value !== 'object' || depth > 6) return { type: 'not-declared-data' };
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0) return { type: 'invalid-array' };
    return Array.from({ length: Math.min(length, 16) }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      return property && Object.hasOwn(property, 'value') ? declaredSnapshot(property.value, depth + 1, payload) : { type: 'accessor-or-missing' };
    });
  }
  const result = {};
  for (const name of payload ? ['n'] : ['id', 'parent_id', 'child_id', 'score', 'label', 'active', 'wide', 'payload', 'name', 'note', 'text', 'children', 'notes', 'echo', 'parent', 'profile']) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (property) result[name] = Object.hasOwn(property, 'value') ? declaredSnapshot(property.value, depth + 1, name === 'payload') : { type: 'accessor' };
  }
  return result;
}
const safeCode = error => ['RELATION_CARDINALITY', 'APP_RELATION_CARDINALITY', 'RESULT_LIMIT', 'QUERY', 'DATA', '42601', '42703', '42883'].includes(error?.code)
  ? error.code : error?.code === 'ERR_ASSERTION' ? 'ASSERTION_MISMATCH' : 'COMPARISON_ERROR';
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function expectedGraph(spec = {}, nullsFirst = true) {
  const roots = parents.slice(spec.rootOffset ?? 0, spec.rootLimit === undefined ? undefined : (spec.rootOffset ?? 0) + spec.rootLimit);
  return roots.map(parent => {
    let rows = children.filter(child => child.parent_id === BigInt(parent.id) && (!spec.active || child.active) && (!spec.wideFilter || child.wide > ABOVE - 1n));
    rows.sort(spec.nullableOrder ? (a, b) => a.score === b.score ? compareId(a, b) : a.score === null ? nullsFirst ? -1 : 1
      : b.score === null ? nullsFirst ? 1 : -1 : a.score - b.score : compareId);
    rows = rows.slice(spec.offset ?? 0, spec.limit === undefined ? undefined : (spec.offset ?? 0) + spec.limit);
    const result = spec.selected ? { name: parent.name } : { id: decimal(parent.id), name: parent.name };
    result.children = rows.map(row => spec.selected ? { label: row.label } : {
      id: decimal(row.id), parent_id: decimal(row.parent_id), score: row.score, label: row.label, active: row.active, wide: decimal(row.wide), payload: row.payload,
      ...(spec.nested ? { notes: notes.filter(note => note.child_id === row.id).slice(0, 1).map(note => ({ id: decimal(note.id), text: note.text })) } : {}),
    });
    if (spec.aliases) result.echo = result.children.map(row => ({ ...row }));
    return result;
  });
}
function applicationGraph(rows, spec = {}) {
  return rows.map(parent => {
    const result = spec.selected ? { name: parent.name } : { id: decimal(parent.id), name: parent.name };
    const child = row => spec.selected ? { label: row.label } : {
      id: decimal(row.id), parent_id: decimal(row.parent_id), score: row.score, label: row.label, active: row.active, wide: decimal(row.wide), payload: row.payload,
      ...(spec.nested ? { notes: row.notes.map(note => ({ id: decimal(note.id), text: note.text })) } : {}),
    };
    result.children = parent.children.map(child);
    if (spec.aliases) result.echo = parent.echo.map(child);
    return result;
  });
}

/**
 * Caller owns the disposable local PG server, admin transport and peer resolution. This helper only owns its random
 * schemas and four handles (including a second Orange mapping control). admin.query returns positional raw-text rows. pg MUST be Orange's isolated comparison
 * peer, not the runtime PGlite0.5.15 peer tree. Versions are checked by the caller from actual package metadata.
 * No connection string or credential enters the returned report. This is syntax-ready until actually executed.
 */
export async function runPublicEagerComparisonCases({ sdk, openPostgresDatabase, postgresOptions, admin, orange, kysely, pg, versions }) {
  assert.deepEqual(versions, { orange: '5.5.1', kysely: '0.29.8', pg: '8.23.1' });
  assert.equal(typeof admin?.query, 'function'); assert.equal(typeof openPostgresDatabase, 'function');
  if (postgresOptions?.connectionString !== undefined) throw new Error('Eager comparison requires explicit local connection fields.');
  assert.equal(postgresOptions?.ssl, false);
  for (const key of ['host', 'user', 'database']) assert.equal(typeof postgresOptions[key], 'string');
  const token = randomBytes(6).toString('hex'), schemas = ['rowstitch', 'orange', 'kysely'].map(name => 'rs_eager_' + name + '_' + token);
  const numericParser = pg.types.getTypeParser(1700, 'text'), created = [], handles = [], tools = [], cases = [];
  const cleanup = { openedHandles: 0, closedHandles: 0, schemasDropped: 0, queryListenerRemoved: false, numericParserRestored: false };
  const report = { format: 'rowstitch-public-postgres-eager-comparison', versions, cases, cleanup, apiSources: [
    'orange-orm@5.5.1 README.md: Table mapping, Fetching rows, Relation filters and Logging; src/map2.d.ts: FetchStrategy/OrderBy/TableClient',
    'kysely@0.29.8 dist/query-builder/over-builder.d.ts and aggregate-function-builder.d.ts; dist/helpers/postgres.d.ts documents JSON helper and dialect parsing limitations',
  ], limits: [
    'One deterministic fictional dataset on the same PostgreSQL server, using separate equivalent schemas. No speed, AI-cost, full-parity or universal ranking claim.',
    'Common application projections explicitly convert only lossless integer representations to decimal strings. Original representations, selected extra fields and missing/null singular values are reported separately.',
    'Kysely is used through explicit caller-authored batch/window, LEFT JOIN, grouping/cardinality and detached-copy recipes; these are not claimed automatic ORM features.',
    'Native NULL ordering, primary-key retention, singular ambiguity and object identity may intentionally differ. Application-value matching does not imply complete result-contract equality.',
    'SELECT counts come from each tool actual query-event/trace/log mechanism, include this caller recipe work and count attempts. They are not timings or a concurrency/snapshot guarantee.',
    'The 400/200 parent batching boundaries, four-level depth, graph budgets, writes and other engines are covered separately, not by this small graph corpus.',
  ] };
  const native = (sql, values = []) => admin.query(sql, values);
  const settings = '-c extra_float_digits=3 -c client_encoding=UTF8 -c statement_timeout=5000 -c lock_timeout=2000';
  let orangeSelects = 0, kyselySelects = 0, listening = false, lastSnapshot;
  const observed = value => { lastSnapshot = declaredSnapshot(value); return value; };
  const listener = event => { if (typeof event?.sql === 'string' && /^\s*(?:select|with)\b/i.test(event.sql)) orangeSelects++; };
  async function observe(tool, fn) {
    const before = tool.count();
    lastSnapshot = undefined;
    try { return { tool: tool.name, status: 'pass', ...await fn(), attemptedSelectStatements: tool.count() - before, countSource: tool.countSource }; }
    catch (error) { return { tool: tool.name, status: 'fail', code: safeCode(error), detail: 'The fixed eager comparison did not meet its stated oracle.', observedDeclaredFields: lastSnapshot, attemptedSelectStatements: tool.count() - before, countSource: tool.countSource }; }
  }
  async function record(name, fn) {
    const observations = [];
    for (const tool of tools) observations.push(await observe(tool, () => fn(tool)));
    const status = observations.some(item => item.status === 'fail') ? 'fail' : observations.some(item => item.status === 'difference') ? 'difference' : 'pass';
    cases.push({ name, status, observations });
  }
  try {
    const server = (await native("SELECT current_setting('server_version'),current_setting('server_encoding')")).rows;
    assert.equal(server.length, 1); assert.equal(server[0][1], 'UTF8'); assert.match(server[0][0], /^18\.6(?:\s|$)/);
    report.server = { version: server[0][0], encoding: server[0][1] };
    for (const schema of schemas) {
      await native('CREATE SCHEMA ' + quote(schema)); created.push(schema);
      await native('REVOKE ALL ON SCHEMA ' + quote(schema) + ' FROM PUBLIC');
      const definitions = { parents: 'id int4 PRIMARY KEY,name text NOT NULL',
        children: 'id int8 PRIMARY KEY,parent_id int8,score int4,label text,active bool NOT NULL,wide int8 NOT NULL,payload jsonb',
        profiles: 'id int4 PRIMARY KEY,parent_id int4,note text NOT NULL', notes: 'id int4 PRIMARY KEY,child_id int8 NOT NULL,text text NOT NULL',
        wide_parents: 'id int8 PRIMARY KEY,name text NOT NULL', wide_children: 'id int4 PRIMARY KEY,parent_id int8,label text NOT NULL' };
      for (const [table, definition] of Object.entries(definitions)) await native('CREATE TABLE ' + quote(schema) + '.' + quote(table) + '(' + definition + ')');
      for (const [table, rows] of [['parents', parents], ['children', children], ['profiles', profiles], ['notes', notes], ['wide_parents', wideParents], ['wide_children', wideChildren]]) {
        for (const row of rows) {
          const keys = Object.keys(row), values = keys.map(key => row[key] === null ? null : key === 'payload' ? JSON.stringify(row[key]) : String(row[key]));
          await native('INSERT INTO ' + quote(schema) + '.' + quote(table) + '(' + keys.map(quote).join(',') + ') VALUES(' + values.map((_, i) => '$' + (i + 1)).join(',') + ')', values);
        }
      }
      assert.deepEqual((await native('SELECT id::text,parent_id::text,wide::text FROM ' + quote(schema) + '.children WHERE id IN (11,12,13,21) ORDER BY id')).rows,
        [['11', '1', String(MAX)], ['12', '1', String(MIN)], ['13', '1', String(ABOVE)], ['21', '2', String(ABOVE - 1n)]]);
    }
    report.nativeControls = { schemasWithIdenticalExactInt64Readback: 3, parentRows: 4, childRows: 8, emptyParentId: '4', nullableOrphanChildId: '99' };
    const { column, defineTable, hasMany, hasOne, belongsTo, asc, eq, gt, and } = sdk;
    const rt = defineTable('parents', { id: column.integer().primaryKey(), name: column.text() });
    const ct = defineTable('children', { id: column.bigint().primaryKey(), parent_id: column.bigint().nullable(), score: column.integer().nullable(), label: column.text().nullable(), active: column.boolean(), wide: column.bigint(), payload: column.json().nullable() });
    const pt = defineTable('profiles', { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), note: column.text() });
    const nt = defineTable('notes', { id: column.integer().primaryKey(), child_id: column.bigint(), text: column.text() });
    const wt = defineTable('wide_parents', { id: column.bigint().primaryKey(), name: column.text() });
    const kt = defineTable('wide_children', { id: column.integer().primaryKey(), parent_id: column.bigint().nullable(), label: column.text() });
    const rowDb = await openPostgresDatabase({ ...postgresOptions, tables: [rt, ct, pt, nt, wt, kt], schema: schemas[0], statementTimeoutMs: 5000, lockTimeoutMs: 2000 });
    handles.push(() => rowDb.close()); cleanup.openedHandles++;
    tools.push({ name: 'rowstitch', count: () => rowDb.exportTrace().queries.filter(query => query.operation === 'select').length, countSource: 'public exportTrace operation=select',
      graph(spec = {}) {
        const conditions = [...(spec.active ? [eq(ct.col('active'), true)] : []), ...(spec.wideFilter ? [gt(ct.col('wide'), ABOVE - 1n)] : [])];
        const relation = hasMany(ct, { localKey: rt.col('id'), foreignKey: ct.col('parent_id'),
          orderBy: spec.nullableOrder ? [asc(ct.col('score')), asc(ct.col('id'))] : [asc(ct.col('id'))],
          ...(conditions.length ? { where: and(...conditions) } : {}), ...(spec.selected ? { select: ['label'] } : {}),
          ...(spec.limit === undefined ? {} : { limit: spec.limit }), ...(spec.offset === undefined ? {} : { offset: spec.offset }),
          ...(spec.nested ? { include: { notes: hasMany(nt, { localKey: ct.col('id'), foreignKey: nt.col('child_id'), select: ['id', 'text'], orderBy: [asc(nt.col('id'))], limit: 1 }) } } : {}),
        });
        return rowDb.table(rt).findMany({ orderBy: [asc(rt.col('id'))], ...(spec.selected ? { select: ['name'] } : {}), include: { children: relation, ...(spec.aliases ? { echo: relation } : {}) },
          ...(spec.rootLimit === undefined ? {} : { limit: spec.rootLimit }), ...(spec.rootOffset === undefined ? {} : { offset: spec.rootOffset }) });
      },
      references: () => rowDb.table(ct).findMany({ select: ['id', 'parent_id'], orderBy: [asc(ct.col('id'))], include: { parent: belongsTo(rt, { localKey: ct.col('parent_id'), foreignKey: rt.col('id'), select: ['id', 'name'] }) } }),
      profiles: () => rowDb.table(rt).findMany({ select: ['id', 'name'], orderBy: [asc(rt.col('id'))], include: { profile: hasOne(pt, { localKey: rt.col('id'), foreignKey: pt.col('parent_id'), select: ['id', 'note'] }) } }),
      wide: () => rowDb.table(wt).findMany({ orderBy: [asc(wt.col('id'))], include: { children: hasMany(kt, { localKey: wt.col('id'), foreignKey: kt.col('parent_id'), orderBy: [asc(kt.col('id'))] }) } }),
    });
    const map = orange.map(x => ({
      parents: x.table('parents').map(({ column: c }) => ({ id: c('id').numeric().primary(), name: c('name').string().notNull() })),
      // Baseline attachment uses consistent safe logical key codecs. The physical FK is still int8; its fixture values are1..3.
      children: x.table('children').map(({ column: c }) => ({ id: c('id').bigint().primary(), parent_id: c('parent_id').numeric(), score: c('score').numeric(), label: c('label').string(), active: c('active').boolean().notNull(), wide: c('wide').bigint().notNull(), payload: c('payload').json() })),
      profiles: x.table('profiles').map(({ column: c }) => ({ id: c('id').numeric().primary(), parent_id: c('parent_id').numeric(), note: c('note').string().notNull() })),
      notes: x.table('notes').map(({ column: c }) => ({ id: c('id').numeric().primary(), child_id: c('child_id').bigint().notNull(), text: c('text').string().notNull() })),
      wide_parents: x.table('wide_parents').map(({ column: c }) => ({ id: c('id').bigint().primary(), name: c('name').string().notNull() })),
      wide_children: x.table('wide_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parent_id: c('parent_id').bigint(), label: c('label').string().notNull() })),
    })).map(x => ({ parents: x.parents.map(({ hasMany: many, hasOne: one }) => ({ children: many(x.children).by('parent_id'), echo: many(x.children).by('parent_id'), profile: one(x.profiles).by('parent_id') })),
      children: x.children.map(({ references, hasMany: many }) => ({ parent: references(x.parents).by('parent_id'), notes: many(x.notes).by('child_id') })),
      wide_parents: x.wide_parents.map(({ hasMany: many }) => ({ children: many(x.wide_children).by('parent_id') })),
    }));
    const uri = new URL('postgres://localhost'); uri.hostname = postgresOptions.host; uri.port = String(postgresOptions.port ?? 5432); uri.username = postgresOptions.user;
    uri.password = postgresOptions.password ?? ''; uri.pathname = '/' + postgresOptions.database;
    uri.searchParams.set('sslmode', 'disable'); uri.searchParams.set('search_path', schemas[1]); uri.searchParams.set('options', settings);
    const orangeDb = map.postgres(uri.href, { size: 1, min: 0 }); handles.push(() => orangeDb.close()); cleanup.openedHandles++;
    // A separate documented mapping/client preserves the original mixed Number/string key experiment, rather than
    // silently removing that contract difference or contaminating every otherwise ordinary hasMany comparison.
    const mixedMap = orange.map(x => ({
      parents: x.table('parents').map(({ column: c }) => ({ id: c('id').numeric().primary(), name: c('name').string().notNull() })),
      children: x.table('children').map(({ column: c }) => ({ id: c('id').bigint().primary(), parent_id: c('parent_id').bigint(), score: c('score').numeric(), label: c('label').string(), active: c('active').boolean().notNull(), wide: c('wide').bigint().notNull(), payload: c('payload').json() })),
    })).map(x => ({ parents: x.parents.map(({ hasMany: many }) => ({ children: many(x.children).by('parent_id') })) }));
    const mixedDb = mixedMap.postgres(uri.href, { size: 1, min: 0 }); handles.push(() => mixedDb.close()); cleanup.openedHandles++;
    await orangeDb.parents.count(); await mixedDb.parents.count(); pg.types.setTypeParser(1700, 'text', numericParser);
    orange.on('query', listener); listening = true;
    tools.push({ name: 'orange-orm@5.5.1', count: () => orangeSelects, countSource: 'documented orange query event; SELECT/WITH SQL prefix only',
      graph(spec = {}) {
        const relation = { orderBy: spec.nullableOrder ? ['score', 'id'] : 'id', ...(spec.selected ? { label: true } : {}),
          ...(spec.active ? { where: x => x.active.eq(true) } : spec.wideFilter ? { where: x => x.wide.greaterThan(String(ABOVE - 1n)) } : {}),
          ...(spec.limit === undefined ? {} : { limit: spec.limit }), ...(spec.offset === undefined ? {} : { offset: spec.offset }),
          ...(spec.nested ? { notes: { id: true, text: true, orderBy: 'id', limit: 1 } } : {}),
        };
        const db = spec.wideFilter ? mixedDb : orangeDb;
        return db.parents.getMany({ orderBy: 'id', ...(spec.selected ? { name: true } : {}), children: relation, ...(spec.aliases ? { echo: relation } : {}),
          ...(spec.rootLimit === undefined ? {} : { limit: spec.rootLimit }), ...(spec.rootOffset === undefined ? {} : { offset: spec.rootOffset }) });
      },
      consistentKeyRecipe: () => orangeDb.parents.getMany({ orderBy: 'id', children: { orderBy: 'id', where: x => x.wide.greaterThan(String(ABOVE - 1n)) } }),
      async mixedKeyRepresentations() {
        const root = (await mixedDb.parents.getMany({ id: true, orderBy: 'id', limit: 1 }))[0];
        const child = (await mixedDb.children.getMany({ id: true, parent_id: true, orderBy: 'id', limit: 1 }))[0];
        return { rootId: { type: typeof root.id, decimal: decimal(root.id) }, foreignKey: { type: typeof child.parent_id, decimal: decimal(child.parent_id) } };
      },
      references: () => orangeDb.children.getMany({ id: true, parent_id: true, orderBy: 'id', parent: { id: true, name: true } }),
      profiles: () => orangeDb.parents.getMany({ id: true, name: true, orderBy: 'id', profile: { id: true, note: true } }),
      wide: () => orangeDb.wide_parents.getMany({ orderBy: 'id', children: { orderBy: 'id' } }),
    });
    const pool = new pg.Pool({ ...postgresOptions, max: 1, options: settings + ' -c search_path=' + schemas[2] });
    let kdb;
    try { kdb = new kysely.Kysely({ dialect: new kysely.PostgresDialect({ pool }), log(event) { if (event.level === 'query' && /^\s*(?:select|with)\b/i.test(event.query.sql)) kyselySelects++; } }); }
    catch (error) { await pool.end(); throw error; }
    handles.push(() => kdb.destroy()); cleanup.openedHandles++;
    async function kGraph(spec = {}) {
      let rootQuery = kdb.selectFrom('parents').select(['id', 'name']).orderBy('id');
      if (spec.rootLimit !== undefined) rootQuery = rootQuery.limit(spec.rootLimit);
      if (spec.rootOffset !== undefined) rootQuery = rootQuery.offset(spec.rootOffset);
      const roots = await rootQuery.execute(), ids = roots.map(row => String(row.id));
      if (!ids.length) return [];
      let childQuery = kdb.selectFrom('children').select(spec.selected ? ['id', 'parent_id', 'label'] : ['id', 'parent_id', 'score', 'label', 'active', 'wide', 'payload']).where('parent_id', 'in', ids);
      if (spec.active) childQuery = childQuery.where('active', '=', true);
      if (spec.wideFilter) childQuery = childQuery.where('wide', '>', String(ABOVE - 1n));
      const ranked = childQuery.select(eb => eb.fn.agg('row_number', []).over(window => spec.nullableOrder
        ? window.partitionBy('parent_id').orderBy('score', order => order.asc().nullsFirst()).orderBy('id')
        : window.partitionBy('parent_id').orderBy('id')).as('__rank'));
      let page = kdb.selectFrom(ranked.as('ranked')).selectAll().where('__rank', '>', spec.offset ?? 0);
      if (spec.limit !== undefined) page = page.where('__rank', '<=', (spec.offset ?? 0) + spec.limit);
      const fetched = await page.orderBy('parent_id').orderBy('__rank').execute();
      let fetchedNotes = [];
      if (spec.nested && fetched.length) {
        const rankedNotes = kdb.selectFrom('notes').select(['id', 'child_id', 'text']).where('child_id', 'in', fetched.map(row => row.id))
          .select(eb => eb.fn.agg('row_number', []).over(window => window.partitionBy('child_id').orderBy('id')).as('__rank'));
        fetchedNotes = await kdb.selectFrom(rankedNotes.as('ranked_notes')).select(['id', 'child_id', 'text']).where('__rank', '<=', 1).orderBy('child_id').orderBy('id').execute();
      }
      return roots.map(root => {
        const rows = fetched.filter(row => String(row.parent_id) === String(root.id)).map(row => {
          const { __rank, ...data } = row;
          return spec.selected ? { label: row.label } : { ...data, ...(spec.nested ? { notes: fetchedNotes.filter(note => String(note.child_id) === String(row.id)).map(({ id, text }) => ({ id, text })) } : {}) };
        });
        return { ...(spec.selected ? { name: root.name } : root), children: structuredClone(rows), ...(spec.aliases ? { echo: structuredClone(rows) } : {}) };
      });
    }
    tools.push({ name: 'kysely@0.29.8', count: () => kyselySelects, countSource: 'documented Kysely query log; SELECT/WITH SQL prefix only', recipe: 'explicit batched window queries, key grouping, selected-field removal and structuredClone', graph: kGraph,
      async references() {
        const rows = await kdb.selectFrom('children as c').leftJoin('parents as p', 'p.id', 'c.parent_id').select(['c.id', 'c.parent_id', 'p.id as parent_key', 'p.name as parent_name']).orderBy('c.id').execute();
        return rows.map(({ id, parent_id, parent_key, parent_name }) => ({ id, parent_id, parent: parent_key === null ? null : { id: parent_key, name: parent_name } }));
      },
      async profiles() {
        const roots = await kdb.selectFrom('parents').select(['id', 'name']).orderBy('id').execute();
        const related = await kdb.selectFrom('profiles').selectAll().where('parent_id', 'in', roots.map(row => row.id)).orderBy('id').execute();
        return roots.map(root => {
          const matches = related.filter(row => row.parent_id === root.id);
          if (matches.length > 1) throw Object.assign(new Error('Application singular cardinality guard'), { code: 'APP_RELATION_CARDINALITY' });
          return { ...root, profile: matches.length ? { id: matches[0].id, note: matches[0].note } : null };
        });
      },
      async wide() {
        const roots = await kdb.selectFrom('wide_parents').selectAll().orderBy('id').execute();
        const related = await kdb.selectFrom('wide_children').selectAll().where('parent_id', 'in', roots.map(row => row.id)).orderBy('id').execute();
        return roots.map(root => ({ ...root, children: related.filter(row => row.parent_id === root.id) }));
      },
    });

    for (const [name, spec] of [
      ['hasMany preserves empty parents and excludes the NULL-key orphan', {}],
      ['relation scope filters children without filtering their parents', { active: true }],
      ['selected fields separate common values from retained identity keys', { selected: true }],
      ['per-parent offset and limit apply independently', { offset: 1, limit: 2 }],
      ['root page retains each selected parent own child page', { rootOffset: 1, rootLimit: 2, limit: 1 }],
      ['NULL placement is disclosed and tied scores use explicit primary-key ordering', { nullableOrder: true }],
      ['nested mapped hasMany has a separate first-note page for each child', { nested: true }],
      ['integer roots correlate with bigint foreign keys and exact neighboring int64 filters', { wideFilter: true }],
    ]) {
      await record(name, async tool => {
        const raw = observed(await tool.graph(spec)), actual = applicationGraph(raw, spec), wanted = expectedGraph(spec);
        if (spec.wideFilter && tool.name === 'orange-orm@5.5.1') {
          assert.deepEqual(actual, parents.map(parent => ({ id: decimal(parent.id), name: parent.name, children: [] })));
          const keyRepresentations = await tool.mixedKeyRepresentations();
          assert.deepEqual(keyRepresentations, { rootId: { type: 'number', decimal: '1' }, foreignKey: { type: 'string', decimal: '1' } });
          const recipe = await tool.consistentKeyRecipe(); assert.deepEqual(applicationGraph(recipe, spec), wanted);
          return { status: 'difference', applicationMatched: false, applicationValues: actual, representation: representation(raw), keyRepresentations,
            recipeMatchedApplication: applicationGraph(recipe, spec), recipeRepresentation: representation(recipe),
            contractDifference: 'The pinned unpaginated mapped hasMany attaches no children with a numeric-decoded parent key and bigint/string-decoded foreign key. A separately executed consistent numeric-key mapping matches these safe1..3 foreign-key values. That recipe is not suitable for arbitrary int64 keys; the separate bigint-to-bigint extrema case preserves their exact representation.' };
        }
        if (spec.nullableOrder && tool.name === 'orange-orm@5.5.1') {
          assert.deepEqual(actual, expectedGraph(spec, false));
          return { status: 'difference', applicationMatched: false, applicationValues: actual, representation: representation(raw), contractDifference: 'Pinned mapped OrderBy accepts column/ASC/DESC, retaining native PostgreSQL ASC NULLS LAST. Rowstitch ASC uses NULLS FIRST; the Kysely recipe states nullsFirst explicitly. No post-sort conceals the difference.' };
        }
        assert.deepEqual(actual, wanted);
        const fields = spec.selected ? { root: Object.keys(raw[0]).sort(), child: Object.keys(raw[0].children[0]).sort() } : undefined;
        if (spec.selected && tool.name === 'orange-orm@5.5.1') {
          assert.ok(fields.root.includes('id'));
          return { status: 'difference', applicationMatched: true, applicationValues: actual, representation: representation(raw), selectedFields: fields,
            contractDifference: 'The common projection intentionally reads name/label only. Pinned Orange retains primary keys for row identity; complete output objects are not declared equal.' };
        }
        return { applicationMatched: true, applicationValues: actual, representation: representation(raw), ...(fields ? { selectedFields: fields } : {}), ...(tool.recipe ? { recipe: tool.recipe } : {}) };
      });
    }
    await record('belongsTo includes matching parents and discloses missing versus NULL reference fields', async tool => {
      const raw = observed(await tool.references());
      const actual = raw.map(row => ({ id: decimal(row.id), parent_id: row.parent_id === null ? null : decimal(row.parent_id), parent: row.parent == null ? null : { id: decimal(row.parent.id), name: row.parent.name } }));
      assert.deepEqual(actual, children.map(child => ({ id: decimal(child.id), parent_id: child.parent_id === null ? null : decimal(child.parent_id), parent: child.parent_id === null ? null : { id: decimal(child.parent_id), name: parents.find(parent => BigInt(parent.id) === child.parent_id).name } })));
      const missing = raw.filter(row => row.parent == null).map(row => ({ id: decimal(row.id), ownProperty: Object.hasOwn(row, 'parent'), valueType: row.parent === null ? 'null' : 'undefined' }));
      return { status: missing.some(item => item.valueType !== 'null' || !item.ownProperty) ? 'difference' : 'pass', applicationMatched: true, applicationValues: actual, representation: representation(raw), singularMissingRepresentation: missing,
        normalization: 'Only application absence is mapped to null; original own-property/null/undefined distinctions above remain part of the contract observation.' };
    });
    await record('hasOne returns its matching profile and discloses missing-profile representation', async tool => {
      const raw = observed(await tool.profiles()), actual = raw.map(row => ({ id: decimal(row.id), name: row.name, profile: row.profile == null ? null : { id: decimal(row.profile.id), note: row.profile.note } }));
      assert.deepEqual(actual, parents.map(parent => ({ id: decimal(parent.id), name: parent.name, profile: profiles.some(profile => profile.parent_id === parent.id) ? { id: decimal(profiles.find(profile => profile.parent_id === parent.id).id), note: profiles.find(profile => profile.parent_id === parent.id).note } : null })));
      const missing = raw.filter(row => row.profile == null).map(row => ({ id: decimal(row.id), ownProperty: Object.hasOwn(row, 'profile'), valueType: row.profile === null ? 'null' : 'undefined' }));
      return { status: missing.some(item => item.valueType !== 'null' || !item.ownProperty) ? 'difference' : 'pass', applicationMatched: true, applicationValues: actual, representation: representation(raw), singularMissingRepresentation: missing };
    });
    await record('int64 primary/foreign keys retain extrema and distinguish neighbors beyond 2^53', async tool => {
      const raw = observed(await tool.wide()), actual = raw.map(parent => ({ id: decimal(parent.id), name: parent.name, children: parent.children.map(child => ({ id: decimal(child.id), parent_id: decimal(child.parent_id), label: child.label })) }));
      const wanted = wideParents.map(parent => ({ id: decimal(parent.id), name: parent.name, children: wideChildren.filter(child => child.parent_id === parent.id).map(child => ({ id: decimal(child.id), parent_id: decimal(child.parent_id), label: child.label })) }));
      assert.deepEqual(actual, wanted);
      return { applicationMatched: true, applicationValues: actual, representation: representation(raw), normalization: 'Lossless bigint/string/safe Number IDs become decimal strings; unsafe Numbers are rejected, never repaired.' };
    });
    // Deliberately untrusted singular mapping: no UNIQUE(parent_id), so every tool sees the same ambiguous data.
    for (const schema of schemas) {
      await native('INSERT INTO ' + quote(schema) + '.profiles(id,parent_id,note) VALUES($1,$2,$3)', ['103', '1', 'second match']);
      assert.deepEqual((await native('SELECT count(*)::text FROM ' + quote(schema) + '.profiles WHERE parent_id=1')).rows, [['2']]);
    }
    await record('singular ambiguity distinguishes built-in refusal from reference behavior and caller guard', async tool => {
      if (tool.name === 'rowstitch' || tool.name === 'kysely@0.29.8') {
        const code = tool.name === 'rowstitch' ? 'RELATION_CARDINALITY' : 'APP_RELATION_CARDINALITY';
        await assert.rejects(tool.profiles(), error => error?.code === code);
        return { applicationMatched: null, outcome: 'refused ambiguous singular graph', code, contract: tool.name === 'rowstitch' ? 'built-in singular cardinality contract' : 'explicit caller grouping/cardinality guard, not a Kysely ORM feature' };
      }
      const raw = observed(await tool.profiles());
      assert.ok(raw.every(row => ['1', '2', '3', '4'].includes(decimal(row.id))));
      assert.ok(raw.every(row => row.profile == null || ['101', '102', '103'].includes(decimal(row.profile.id))));
      return { status: 'difference', applicationMatched: null, outcome: 'returned a graph from an ambiguous mapped hasOne', representation: representation(raw),
        contractDifference: 'This observation retains the exact pinned result; no arbitrary profile is normalized into a unique match or labeled a strict-cardinality success.' };
    });
    await record('two aliases disclose JSON/object identity and the Kysely detached-copy recipe', async tool => {
      const spec = { aliases: true }, raw = observed(await tool.graph(spec)), actual = applicationGraph(raw, spec), before = representation(raw);
      assert.deepEqual(actual, expectedGraph(spec));
      const distinctArrays = raw[0].children !== raw[0].echo, distinctObjects = raw[0].children[0] !== raw[0].echo[0];
      const distinctJson = raw[0].children[0].payload !== raw[0].echo[0].payload;
      raw[0].children[0].payload.n = 999;
      const echoUnaffected = raw[0].echo[0].payload.n === 1;
      if (tool.name !== 'orange-orm@5.5.1') assert.ok(distinctArrays && distinctObjects && distinctJson && echoUnaffected);
      return { status: distinctArrays && distinctObjects && distinctJson && echoUnaffected ? 'pass' : 'difference', applicationMatched: true, representationBeforeMutation: before,
        identity: { distinctArrays, distinctObjects, distinctJson, echoUnaffected }, recipe: tool.recipe ?? null,
        contract: 'Returned identity/mutation behavior is measured separately from matching initial values; Kysely detachment is explicit application structuredClone work.' };
    });
  } catch (error) {
    cases.push({ name: 'owned fixture setup', status: 'fail', observations: [{ tool: 'fixture', status: 'fail', code: safeCode(error), detail: 'The owned eager comparison setup did not complete.' }] });
  } finally {
    let failed = false;
    if (listening) { try { orange.off('query', listener); cleanup.queryListenerRemoved = true; } catch { failed = true; } }
    else cleanup.queryListenerRemoved = true;
    for (const close of [...handles].reverse()) { try { await close(); cleanup.closedHandles++; } catch { failed = true; } }
    for (const schema of [...created].reverse()) {
      try { await native('DROP SCHEMA ' + quote(schema) + ' CASCADE'); assert.deepEqual((await native('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1::text', [schema])).rows, []); cleanup.schemasDropped++; }
      catch { failed = true; }
    }
    try { pg.types.setTypeParser(1700, 'text', numericParser); cleanup.numericParserRestored = pg.types.getTypeParser(1700, 'text') === numericParser; if (!cleanup.numericParserRestored) failed = true; } catch { failed = true; }
    if (failed) throw new Error('Owned eager comparison cleanup did not complete.');
  }
  const observations = cases.flatMap(item => item.observations);
  report.contractDifferences = cases.flatMap(item => item.observations.filter(observation => observation.status === 'difference').map(observation => ({
    case: item.name, tool: observation.tool, applicationMatched: observation.applicationMatched,
    detail: observation.contractDifference ?? observation.normalization ?? 'The recorded complete result representation or identity differs; common values are assessed separately.',
  })));
  report.recipeRequirements = [
    { tool: 'rowstitch', recipe: 'Built-in mapped graph loader, singular cardinality refusal and detached output copies.' },
    { tool: 'orange-orm@5.5.1', recipe: 'Documented mapped fetching strategies with consistent safe logical key codecs for the common fixture; a second client explicitly tests mixed numeric/bigint key attachment. Identity keys and native NULL placement are retained as contract observations.' },
    { tool: 'kysely@0.29.8', recipe: 'Caller constructs root/child window pages, binds keys, groups results, maps nullable LEFT JOINs, checks singular counts, removes helper/hidden fields and explicitly clones alias values. No automatic relations are inferred.' },
  ];
  report.summary = { cases: cases.length, observations: observations.length, pass: observations.filter(item => item.status === 'pass').length,
    difference: observations.filter(item => item.status === 'difference').length, fail: observations.filter(item => item.status === 'fail').length, unsupported: observations.filter(item => item.status === 'unsupported').length };
  return report;
}
