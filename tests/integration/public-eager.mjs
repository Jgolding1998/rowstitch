// Actual public native eager reads. Fictional fixtures; independent expected graphs; no driver replacement.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const code = expected => error => error?.code === expected;
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const names = (value, expected) => assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected].sort());
const reads = db => db.exportTrace().queries.filter(entry => entry.operation === 'select');
const clone = value => structuredClone(value);

/**
 * SDK and factories must be imported from the same real build/package. PostgreSQL admin.query returns positional
 * raw-text rows on the caller's already verified disposable server. This helper owns only its random schema and
 * handles. It never starts a server, installs a peer, changes a feature flag or closes the caller's admin.
 * PGlite is the actual fresh-memory, private-worker public factory. External storage/collation/transport controls
 * need a separate fixture and are explicitly not claimed as fresh-worker coverage here.
 */
export async function runPublicEagerCases({ engine, sdk, openPostgresDatabase, openPgliteDatabase, postgresOptions, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite');
  const postgres = engine === 'postgresql', factory = postgres ? openPostgresDatabase : openPgliteDatabase;
  assert.equal(typeof factory, 'function');
  if (postgres) {
    assert.equal(typeof admin?.query, 'function');
    assert.equal(postgresOptions?.connectionString, undefined);
    for (const key of ['host', 'user', 'database']) assert.equal(typeof postgresOptions?.[key], 'string');
  }
  const { column, defineTable, hasMany, hasOne, belongsTo, eq, gt, gte, inArray, and, or, not,
    asc, desc, contains, startsWith, endsWith, some, none, every, countRelated, agg } = sdk;
  const schema = postgres ? 'rs_eager_' + randomBytes(6).toString('hex') : 'public';
  const databases = new Set(), cases = [], cleanup = { openedDatabases: 0, closedDatabases: 0, schemaDropped: !postgres };
  const report = { engine, cases, cleanup, limits: [
    'Exact fictional public graph values and explicit bounds; no latency, snapshot, full Orange parity or arbitrary-payload claim.',
    'Plain graph reads use multiple requests; this corpus does not assert a cross-request snapshot or two-connection isolation.',
    'Fresh public PGlite cannot externally mutate storage or create custom collations. Native collation equivalence, malformed wire/rank/OID metadata and transport loss require separate controls.',
    'The separate wide-capacity export uses the explicitly labelled caller-owned worker adapter for PGlite, rather than its fresh public factory.',
  ] };
  const query = async (sql, values = []) => {
    try { return await admin.query(sql, values); }
    catch { throw new Error('Owned eager fixture administration failed.'); }
  };
  const check = async (name, body) => { await body(); cases.push(name); };
  const noIo = async (name, body, expected = 'QUERY') => check(name, async () => {
    db.clearTrace();
    if (expected === null) await body();
    else await assert.rejects(Promise.resolve().then(body), code(expected));
    assert.deepEqual(db.exportTrace().queries, [], 'Invalid eager input must refuse before root I/O.');
  });
  const insert = async (table, values) => {
    for (let i = 0; i < values.length; i += 1000) await db.table(table).insertMany(values.slice(i, i + 1000));
  };
  const parents = defineTable('eager_parents', {
    id: column.integer().primaryKey(), name: column.text(), groupKey: column.text().nullable(), active: column.boolean(),
    secret: column.text().default('FICTIONAL_HIDDEN_PARENT'), payload: column.json().default({ source: 'parent' }),
  });
  const children = defineTable('eager_children', {
    id: column.integer().primaryKey(), parentId: column.integer().nullable(), title: column.text(), score: column.integer().nullable(),
    active: column.boolean().nullable(), exact: column.bigint(), ratio: column.real(), payload: column.json(), note: column.text().nullable(),
    secret: column.text().default('FICTIONAL_HIDDEN_CHILD'),
  });
  const profiles = defineTable('eager_profiles', {
    id: column.integer().primaryKey(), parentId: column.integer().nullable(), bio: column.text(), active: column.boolean(), avatarId: column.integer().nullable(),
  });
  const avatars = defineTable('eager_avatars', { id: column.integer().primaryKey(), caption: column.text() });
  const notes = defineTable('eager_notes', { id: column.integer().primaryKey(), childId: column.integer(), approved: column.boolean().nullable() });
  const nodes = defineTable('eager_nodes', { id: column.integer().primaryKey(), parentId: column.integer().nullable(), label: column.text() });
  const numeric = defineTable('eager_numeric', {
    id: column.integer().primaryKey(), integerKey: column.integer().nullable(), bigKey: column.bigint().nullable(), label: column.text(),
  });
  const numericTargets = defineTable('eager_numeric_targets', {
    id: column.integer().primaryKey(), integerKey: column.integer().nullable(), bigKey: column.bigint().nullable(), label: column.text(),
  });
  const textRoots = defineTable('eager_text_roots', { id: column.integer().primaryKey(), key: column.text().nullable(), label: column.text() });
  const textTargets = defineTable('eager_text_targets', {
    id: column.integer().primaryKey(), key: column.text().nullable(), label: column.text(), payload: column.json(),
  });
  const batchRoots = defineTable('eager_batch_roots', { id: column.integer().primaryKey(), label: column.text() });
  const batchTargets = defineTable('eager_batch_targets', { id: column.integer().primaryKey(), rootId: column.integer(), label: column.text() });
  const batchLeaves = defineTable('eager_batch_leaves', { id: column.integer().primaryKey(), targetId: column.integer(), label: column.text() });
  const capacityRoots = defineTable('eager_capacity_roots', { id: column.integer().primaryKey(), shared: column.text() });
  const capacityTargets = defineTable('eager_capacity_targets', {
    id: column.integer().primaryKey(), rootId: column.integer(), shared: column.text(), label: column.text(),
  });
  const tables = [parents, children, profiles, avatars, notes, nodes, numeric, numericTargets, textRoots, textTargets,
    batchRoots, batchTargets, batchLeaves, capacityRoots, capacityTargets];
  const childDomain = hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId') });
  const childPage = options => hasMany(children, { localKey: parents.col('id'), foreignKey: children.col('parentId'), ...options });
  const profile = options => hasOne(profiles, { localKey: parents.col('id'), foreignKey: profiles.col('parentId'), ...options });
  const parent = options => belongsTo(parents, { localKey: children.col('parentId'), foreignKey: parents.col('id'), ...options });
  const rootRows = [
    { id: 1, name: 'Avery', groupKey: 'shared', active: true, secret: 'FICTIONAL_HIDDEN_PARENT', payload: { source: 'parent' } },
    { id: 2, name: 'Briar', groupKey: 'shared', active: false, secret: 'FICTIONAL_HIDDEN_PARENT', payload: { source: 'parent' } },
    { id: 3, name: 'Casey', groupKey: null, active: true, secret: 'FICTIONAL_HIDDEN_PARENT', payload: { source: 'parent' } },
    { id: 4, name: 'Devon', groupKey: 'missing', active: true, secret: 'FICTIONAL_HIDDEN_PARENT', payload: { source: 'parent' } },
  ];
  const childRows = [
    ...Array.from({ length: 105 }, (_, index) => ({ id: index + 1, parentId: 1, title: index === 104 ? 'Leaf %_\\105' : 'Leaf ' + (index + 1),
      score: index < 2 ? null : index < 4 ? 7 : index, active: index % 3 === 0 ? null : index % 3 === 1,
      exact: index === 0 ? -9223372036854775808n : 9223372036854775807n, ratio: index === 0 ? -0 : index + .25,
      payload: { nested: { position: index }, list: [true, null, index] }, note: index % 2 ? 'note' : null, secret: 'FICTIONAL_HIDDEN_CHILD' })),
    ...[201, 202, 203].map((id, index) => ({ id, parentId: 2, title: 'Other ' + (index + 1), score: index === 0 ? null : 5,
      active: index === 0 ? true : index === 1 ? false : null, exact: 9007199254740993n + BigInt(index), ratio: index + .5,
      payload: { nested: { position: id }, list: [] }, note: null, secret: 'FICTIONAL_HIDDEN_CHILD' })),
    { id: 301, parentId: null, title: 'Null reference', score: 1, active: true, exact: 1n, ratio: 1,
      payload: { orphan: true }, note: null, secret: 'FICTIONAL_HIDDEN_CHILD' },
    { id: 302, parentId: 999, title: 'Missing reference', score: 1, active: true, exact: 2n, ratio: 2,
      payload: { orphan: true }, note: null, secret: 'FICTIONAL_HIDDEN_CHILD' },
  ];
  // Hand oracle: filtering and stable primary-key tie breaks are independent of the SQL/compiler implementation.
  const pageOracle = (id, { filter = () => true, direction, limit = 100, offset = 0, selected } = {}) => {
    const rows = childRows.filter(row => row.parentId === id && filter(row));
    rows.sort((left, right) => {
      if (!direction) return left.id - right.id;
      if (left.score === null || right.score === null) return left.score === right.score ? left.id - right.id
        : left.score === null ? direction === 'asc' ? -1 : 1 : direction === 'asc' ? 1 : -1;
      return (direction === 'asc' ? left.score - right.score : right.score - left.score) || left.id - right.id;
    });
    return rows.slice(offset, offset + limit).map(row => selected ? Object.fromEntries(selected.map(field => [field, clone(row[field])])) : clone(row));
  };
  let db, schemaCreated = false, failed = false;
  try {
    if (postgres) { await query('CREATE SCHEMA ' + quote(schema)); schemaCreated = true; await query('REVOKE ALL ON SCHEMA ' + quote(schema) + ' FROM PUBLIC'); }
    db = await factory({ ...(postgres ? postgresOptions : {}), schema, tables, traceValues: false, maxTraceEntries: 1000 });
    databases.add(db); cleanup.openedDatabases++; await db.ensureSchema();
    await insert(parents, rootRows); await insert(children, childRows);
    await insert(profiles, [{ id: 11, parentId: 1, bio: 'Gardener', active: true, avatarId: 9 },
      { id: 31, parentId: 3, bio: 'Excluded', active: false, avatarId: null }]);
    await insert(avatars, [{ id: 9, caption: 'Fictional moon icon' }]);
    await insert(notes, [{ id: 1, childId: 1, approved: true }, { id: 2, childId: 2, approved: false },
      { id: 3, childId: 3, approved: null }, { id: 4, childId: 4, approved: true }, { id: 5, childId: 4, approved: true }]);
    const p = db.table(parents), c = db.table(children);
    const rootOptions = { select: ['name'], orderBy: [asc(parents.col('id'))] };
    await check('default hasMany page is 100 per parent and preserves every full scalar field', async () => {
      assert.deepEqual(await p.findMany({ ...rootOptions, include: { leaves: childPage({}) } }),
        rootRows.map(row => ({ name: row.name, leaves: pageOracle(row.id) })));
    });
    for (const direction of ['asc', 'desc']) await check('per-parent ' + direction + ' NULL ordering, tied scores, PK tie-break, offset and hidden child keys', async () => {
      const relation = childPage({ orderBy: [direction === 'asc' ? asc(children.col('score')) : desc(children.col('score'))], limit: 3, offset: 1, select: ['title', 'score'] });
      assert.deepEqual(await p.findMany({ ...rootOptions, include: { leaves: relation } }),
        rootRows.map(row => ({ name: row.name, leaves: pageOracle(row.id, { direction, limit: 3, offset: 1, selected: ['title', 'score'] }) })));
    });
    await check('relation filter runs before its per-parent page and root order/page/findFirst remain independent', async () => {
      const relation = childPage({ where: eq(children.col('active'), true), orderBy: [desc(children.col('id'))], limit: 2, offset: 1, select: ['id'] });
      const oracle = id => childRows.filter(row => row.parentId === id && row.active === true).sort((a, b) => b.id - a.id).slice(1, 3).map(row => ({ id: row.id }));
      assert.deepEqual(await p.findMany({ ...rootOptions, orderBy: [desc(parents.col('id'))], limit: 2, offset: 1, include: { leaves: relation } }),
        [rootRows[2], rootRows[1]].map(row => ({ name: row.name, leaves: oracle(row.id) })));
      assert.deepEqual(await p.findFirst({ ...rootOptions, where: eq(parents.col('id'), 1), offset: 0, include: { leaves: relation } }), { name: 'Avery', leaves: oracle(1) });
    });
    await check('child limit0 and empty/root-limit0/findFirst-missing skip child I/O', async () => {
      db.clearTrace(); assert.deepEqual(await p.findMany({ ...rootOptions, include: { leaves: childPage({ limit: 0 }) } }), rootRows.map(row => ({ name: row.name, leaves: [] })));
      assert.equal(reads(db).length, 1);
      for (const options of [{ where: eq(parents.col('id'), -1) }, { limit: 0 }]) {
        db.clearTrace(); assert.deepEqual(await p.findMany({ ...options, include: { leaves: childPage({}) } }), []); assert.equal(reads(db).length, 1);
      }
      db.clearTrace(); assert.equal(await p.findFirst({ where: eq(parents.col('id'), -1), include: { leaves: childPage({}) } }), null); assert.equal(reads(db).length, 1);
    });
    await check('maximum documented child offset returns empty pages without changing root rows', async () => {
      assert.deepEqual(await p.findMany({ ...rootOptions, include: { leaves: childPage({ limit: 1000, offset: 1_000_000_000, select: ['title'] }) } }),
        rootRows.map(row => ({ name: row.name, leaves: [] })));
    });
    await check('hasOne preserves root rows for present, absent and filtered references', async () => {
      assert.deepEqual(await p.findMany({ ...rootOptions, include: { profile: profile({ where: eq(profiles.col('active'), true), orderBy: [desc(profiles.col('id'))], select: ['bio'] }) } }),
        [{ name: 'Avery', profile: { bio: 'Gardener' } }, { name: 'Briar', profile: null }, { name: 'Casey', profile: null }, { name: 'Devon', profile: null }]);
    });
    await check('belongsTo handles present, NULL, missing and filtered references with object-or-null', async () => {
      const options = { select: ['title'], where: inArray(children.col('id'), [1, 201, 301, 302]), orderBy: [asc(children.col('id'))],
        include: { owner: parent({ where: eq(parents.col('active'), true), select: ['name'] }) } };
      assert.deepEqual(await c.findMany(options), [{ title: 'Leaf 1', owner: { name: 'Avery' } }, { title: 'Other 1', owner: null },
        { title: 'Null reference', owner: null }, { title: 'Missing reference', owner: null }]);
    });
    await check('singular ambiguity survives identical projected values and ordering; filtering can resolve it', async () => {
      await insert(profiles, [{ id: 12, parentId: 1, bio: 'Gardener', active: false, avatarId: 9 }]);
      try {
        await assert.rejects(p.findMany({ ...rootOptions, include: { profile: profile({ orderBy: [desc(profiles.col('id'))], select: ['bio'] }) } }), code('RELATION_CARDINALITY'));
        assert.deepEqual(await p.findFirst({ select: ['name'], where: eq(parents.col('id'), 1), include: { profile: profile({ where: eq(profiles.col('active'), true), select: ['bio'] }) } }), { name: 'Avery', profile: { bio: 'Gardener' } });
        const ambiguous = belongsTo(parents, { localKey: children.col('title'), foreignKey: parents.col('groupKey'), select: ['active'] });
        await c.insert({ ...childRows[0], id: 303, title: 'shared' });
        try { await assert.rejects(c.findMany({ where: eq(children.col('id'), 303), include: { owner: ambiguous } }), code('RELATION_CARDINALITY')); }
        finally { await c.delete({ where: eq(children.col('id'), 303), maxRows: 1 }); }
      } finally { await db.table(profiles).delete({ where: eq(profiles.col('id'), 12), maxRows: 1 }); }
      assert.equal(await p.count(), 4);
    });
    await check('four mixed relation levels retain hidden keys and permit an empty fourth-level include', async () => {
      const avatar = belongsTo(avatars, { localKey: profiles.col('avatarId'), foreignKey: avatars.col('id'), select: ['caption'], include: {} });
      const prof = profile({ select: ['bio'], include: { avatar } });
      const owner = parent({ select: ['name'], include: { profile: prof } });
      const leaves = childPage({ limit: 2, select: ['title'], include: { owner } });
      const rows = await p.findMany({ ...rootOptions, where: eq(parents.col('id'), 1), include: { leaves } });
      assert.deepEqual(rows, [{ name: 'Avery', leaves: ['Leaf 1', 'Leaf 2'].map(title => ({ title, owner: { name: 'Avery', profile: { bio: 'Gardener', avatar: { caption: 'Fictional moon icon' } } } })) }]);
      names(rows[0], ['name', 'leaves']); names(rows[0].leaves[0], ['title', 'owner']);
      names(rows[0].leaves[0].owner, ['name', 'profile']); names(rows[0].leaves[0].owner.profile.avatar, ['caption']);
    });
    const selfChain = depth => {
      let include = {};
      for (let level = 0; level < depth; level++) include = { next: hasOne(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('id'), select: ['label'], include }) };
      return include;
    };
    await insert(nodes, [{ id: 1, parentId: null, label: 'Seed' }, { id: 2, parentId: 1, label: 'Branch' }, { id: 3, parentId: 2, label: 'Bud' }]);
    await check('bounded self-relations support four levels and independent nested source keys', async () => {
      let expected = { label: 'Seed' }; for (let level = 0; level < 4; level++) expected = { label: 'Seed', next: expected };
      assert.deepEqual(await db.table(nodes).findFirst({ where: eq(nodes.col('id'), 1), select: ['label'], include: selfChain(4) }), expected);
      const downstream = hasMany(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('parentId'), select: ['label'], include: {
        downstream: hasMany(nodes, { localKey: nodes.col('id'), foreignKey: nodes.col('parentId'), select: ['label'] }),
      } });
      assert.deepEqual(await db.table(nodes).findFirst({ where: eq(nodes.col('id'), 1), select: ['label'], include: { downstream } }), { label: 'Seed', downstream: [{ label: 'Branch', downstream: [{ label: 'Bud' }] }] });
    });
    await check('eight aliases return independent complete pages and objects', async () => {
      const include = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['alias' + i, childPage({ limit: 2, select: ['title', 'payload'] })]));
      const rows = await p.findMany({ where: eq(parents.col('id'), 1), select: ['name'], include });
      const expected = { name: 'Avery', ...Object.fromEntries(Object.keys(include).map(alias => [alias, pageOracle(1, { limit: 2, selected: ['title', 'payload'] })])) };
      assert.deepEqual(rows, [expected]); assert.notEqual(rows[0].alias0, rows[0].alias1); assert.notEqual(rows[0].alias0[0], rows[0].alias1[0]);
      rows[0].alias0[0].payload.list.push('changed'); rows[0].alias0.push({ title: 'local' });
      assert.deepEqual(rows[0].alias1, expected.alias1);
    });
    await check('shared singular targets and root/child JSON are detached across aliases, parents and later calls', async () => {
      const owner = parent({ select: ['name', 'payload'] });
      const rows = await c.findMany({ where: inArray(children.col('id'), [1, 2]), select: ['title', 'payload'], include: { left: owner, right: owner } });
      const expected = [1, 2].map(id => ({ title: 'Leaf ' + id, payload: clone(childRows[id - 1].payload), left: { name: 'Avery', payload: { source: 'parent' } }, right: { name: 'Avery', payload: { source: 'parent' } } }));
      assert.deepEqual(rows, expected); assert.notEqual(rows[0].left, rows[1].left); assert.notEqual(rows[0].left.payload, rows[0].right.payload);
      rows[0].left.payload.source = 'local'; rows[0].payload.list.push('local');
      assert.deepEqual(rows[1], expected[1]); assert.deepEqual(rows[0].right, expected[0].right);
      assert.deepEqual(await p.findFirst({ where: eq(parents.col('id'), 1), select: ['payload'] }), { payload: { source: 'parent' } });
    });
    const noteDomain = hasMany(notes, { localKey: children.col('id'), foreignKey: notes.col('childId') });
    await check('child scalar/text/logical filters preserve literal wildcard characters and filter before pagination', async () => {
      const title = children.col('title');
      const where = and(gt(children.col('id'), 0), startsWith(title, 'Leaf '), contains(title, '1'), not(endsWith(title, '11')));
      const leaves = childPage({ where, select: ['title'], orderBy: [asc(children.col('id'))], limit: 1000 });
      const expected = childRows.filter(row => row.parentId === 1 && row.title.startsWith('Leaf ') && row.title.includes('1') && !row.title.endsWith('11')).map(row => ({ title: row.title }));
      assert.deepEqual(await p.findFirst({ where: eq(parents.col('id'), 1), select: ['name'], include: { leaves } }), { name: 'Avery', leaves: expected });
      const literal = childPage({ where: and(startsWith(title, 'Leaf %_'), contains(title, '%_'), endsWith(title, '\\105')), select: ['title'] });
      assert.deepEqual(await p.findFirst({ where: eq(parents.col('id'), 1), select: ['name'], include: { leaves: literal } }), { name: 'Avery', leaves: [{ title: 'Leaf %_\\105' }] });
    });
    for (const [label, where, ids] of [
      ['some', some(noteDomain, eq(notes.col('approved'), true)), [1, 4]],
      ['none', none(noteDomain), [5, 6]],
      ['every', every(noteDomain, eq(notes.col('approved'), true)), [1, 4, 5, 6]],
      ['countRelated', countRelated(noteDomain, '=', 2, eq(notes.col('approved'), true)), [4]],
      ['nested logic', or(and(some(noteDomain), every(noteDomain, eq(notes.col('approved'), true))), countRelated(noteDomain, '=', 0)), [1, 4, 5, 6]],
    ]) await check('batched child WHERE supports scoped ' + label + ' and SQL NULL/empty semantics', async () => {
      const leaves = childPage({ where: and(inArray(children.col('id'), [1, 2, 3, 4, 5, 6]), where), select: ['id'], orderBy: [desc(children.col('id'))], limit: 1000 });
      assert.deepEqual(await p.findFirst({ where: eq(parents.col('id'), 1), select: ['name'], include: { leaves } }), { name: 'Avery', leaves: [...ids].reverse().map(id => ({ id })) });
    });
    await check('root predicate domains and projected summaries are independent of eager page filters and limits', async () => {
      const leaves = childPage({ where: eq(children.col('active'), false), limit: 1, select: ['id'] });
      const actual = await p.findMany({ select: ['name'], where: some(childDomain, eq(children.col('active'), true)), orderBy: [asc(parents.col('id'))],
        aggregates: { total: agg.related(childDomain, agg.count()), exact: agg.related(childDomain, agg.sum(children.col('exact'))) }, include: { leaves } });
      assert.deepEqual(actual, [1, 2].map(id => ({ name: rootRows[id - 1].name,
        total: childRows.filter(row => row.parentId === id).length,
        exact: childRows.filter(row => row.parentId === id).reduce((sum, row) => sum + row.exact, 0n),
        leaves: childRows.filter(row => row.parentId === id && row.active === false).slice(0, 1).map(row => ({ id: row.id })) })));
      assert.ok(actual[0].exact > 9223372036854775807n, 'Projected exact sums must exceed int64 in this include fixture.');
      const hiddenAlias = await p.findFirst({ where: eq(parents.col('id'), 1), select: ['name'],
        aggregates: { id: agg.related(childDomain, agg.count()) }, include: { leaves: childPage({ limit: 1, select: ['title'] }) } });
      assert.deepEqual(hiddenAlias, { name: 'Avery', id: 105, leaves: [{ title: 'Leaf 1' }] });
    });
    await check('call-time capture includes mutable nested include records and caller selections', async () => {
      const selected = ['name'], childSelected = ['title'], childOrdering = [asc(children.col('id'))];
      const nested = { owner: parent({ select: ['name'] }) };
      const leaves = childPage({ limit: 1, select: childSelected, orderBy: childOrdering, include: nested });
      childSelected[0] = 'secret'; childOrdering[0] = desc(children.col('id'));
      const include = { leaves }, options = { where: eq(parents.col('id'), 1), select: selected, include };
      const pending = p.findMany(options); selected[0] = 'secret'; delete include.leaves; delete nested.owner;
      assert.deepEqual(await pending, [{ name: 'Avery', leaves: [{ title: 'Leaf 1', owner: { name: 'Avery' } }] }]);
    });
    await noIo('every singular pagination spelling rejects before root I/O', async () => {
      for (const helper of [hasOne, belongsTo]) for (const extra of [{ limit: 0 }, { limit: 1 }, { limit: undefined }, { offset: 0 }, { offset: 1 }, { offset: undefined }]) {
        assert.throws(() => helper(profiles, { localKey: parents.col('id'), foreignKey: profiles.col('parentId'), ...extra }), code('QUERY'));
      }
    }, null);
    await noIo('forged relation descriptors reject before root I/O', () => p.findMany({ include: { profile: { table: profiles, options: {} } } }));
    await noIo('depth5 rejects the complete tree before root I/O', () => db.table(nodes).findMany({ include: selfChain(5) }));
    await noIo('nine include aliases reject before root I/O', () => p.findMany({ include: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['alias' + i, childPage({})])) }));
    await noIo('wrong source table keys reject before root I/O', () => p.findMany({ include: { leaves: hasMany(children, { localKey: profiles.col('id'), foreignKey: children.col('parentId') }) } }));
    await noIo('incompatible key kinds reject before root I/O', () => p.findMany({ include: { leaves: childPage({ localKey: parents.col('name') }) } }));
    await noIo('alias/physical-column collisions reject before root I/O', () => p.findMany({ select: ['id'], include: { name: childPage({}) } }));
    await noIo('aggregate/include alias collisions reject before root I/O', () => p.findMany({ include: { total: childPage({}) }, aggregates: { TOTAL: agg.related(childDomain, agg.count()) } }));
    await noIo('unregistered genuine relation targets reject before root I/O', () => {
      const missing = defineTable('eager_unregistered', { id: column.integer().primaryKey(), rootId: column.integer() });
      return p.findMany({ include: { missing: hasMany(missing, { localKey: parents.col('id'), foreignKey: missing.col('rootId') }) } });
    }, 'SCHEMA');
    await noIo('invalid child selections and wrong-scope predicates reject before root I/O', async () => {
      for (const select of [[], ['title', 'title'], ['missing']]) assert.throws(() => childPage({ select }), code('QUERY'));
      return p.findMany({ include: { leaves: childPage({ where: eq(profiles.col('id'), 1) }) } });
    });
    for (const [label, where] of [['NUL text', eq(children.col('title'), 'fictional\0marker')],
      ['lone surrogate', eq(children.col('title'), '\ud800')], ['jsonb-invalid NUL', eq(children.col('payload'), { value: '\0' })]]) {
      await noIo('known native ' + label + ' relation filter preflights for empty roots and limit0', async () => {
        for (const root of [{ where: eq(parents.col('id'), -1) }, { limit: 0 }]) {
          await assert.rejects(p.findMany({ ...root, include: { leaves: childPage({ where }) } }), code('VALIDATION'));
          assert.deepEqual(db.exportTrace().queries, []);
        }
      }, null);
    }
    await insert(numeric, [
      { id: 1, integerKey: 7, bigKey: 7n, label: 'seven' }, { id: 2, integerKey: -8, bigKey: -8n, label: 'negative' },
      { id: 3, integerKey: null, bigKey: null, label: 'NULL' }, { id: 4, integerKey: 9, bigKey: 9007199254740992n, label: 'missing' },
      ...[-9223372036854775808n, 9007199254740992n, 9007199254740993n, 9223372036854775806n, 9223372036854775807n].map((bigKey, i) => ({ id: i + 10, integerKey: null, bigKey, label: 'exact' + i })),
    ]);
    await insert(numericTargets, [
      { id: 1, integerKey: 7, bigKey: 7n, label: 'seven' }, { id: 2, integerKey: -8, bigKey: -8n, label: 'negative' },
      ...[-9223372036854775808n, 9007199254740993n, 9223372036854775806n, 9223372036854775807n].map((bigKey, i) => ({ id: i + 10, integerKey: null, bigKey, label: 'target' + i })),
    ]);
    for (const source of ['integerKey', 'bigKey']) for (const target of ['integerKey', 'bigKey']) await check('lossless ' + source + ' to ' + target + ' relation keys retain NULL and missing-key behavior', async () => {
      const relation = hasMany(numericTargets, { localKey: numeric.col(source), foreignKey: numericTargets.col(target), select: ['label'] });
      assert.deepEqual(await db.table(numeric).findMany({ where: inArray(numeric.col('id'), [1, 2, 3, 4]), select: ['label'], orderBy: [asc(numeric.col('id'))], include: { targets: relation } }),
        [{ label: 'seven', targets: [{ label: 'seven' }] }, { label: 'negative', targets: [{ label: 'negative' }] }, { label: 'NULL', targets: [] }, { label: 'missing', targets: [] }]);
    });
    await check('int64 extrema and adjacent beyond-safe integers are never rounded into the same relation key', async () => {
      const relation = belongsTo(numericTargets, { localKey: numeric.col('bigKey'), foreignKey: numericTargets.col('bigKey'), select: ['label'] });
      assert.deepEqual(await db.table(numeric).findMany({ where: gte(numeric.col('id'), 10), select: ['label', 'bigKey'], orderBy: [asc(numeric.col('id'))], include: { target: relation } }),
        [-9223372036854775808n, 9007199254740992n, 9007199254740993n, 9223372036854775806n, 9223372036854775807n].map((bigKey, i) => ({ label: 'exact' + i, bigKey, target: i === 1 ? null : { label: 'target' + (i === 0 ? 0 : i - 1) } })));
    });
    const hostileJson = JSON.parse('{"__proto__":{"fictional":true},"constructor":{"count":1},"nested":{"list":[1,2]}}');
    await insert(textRoots, [{ id: 1, key: '', label: 'empty' }, { id: 2, key: 'shared', label: 'left' }, { id: 3, key: 'shared', label: 'right' },
      { id: 4, key: null, label: 'NULL' }, { id: 5, key: 'missing', label: 'missing' }, { id: 6, key: 'é', label: 'unicode' }]);
    await insert(textTargets, [{ id: 1, key: '', label: 'empty target', payload: hostileJson }, { id: 2, key: 'shared', label: 'shared target', payload: hostileJson },
      { id: 3, key: null, label: 'NULL orphan', payload: {} }, { id: 4, key: 'é', label: 'unicode target', payload: hostileJson }]);
    await check('text ordinals distinguish empty/NULL/missing/native Unicode keys and detach repeated source-key copies', async () => {
      const relation = hasMany(textTargets, { localKey: textRoots.col('key'), foreignKey: textTargets.col('key'), select: ['label', 'payload'] });
      const actual = await db.table(textRoots).findMany({ select: ['label'], orderBy: [asc(textRoots.col('id'))], include: { left: relation, right: relation } });
      const labels = ['empty target', 'shared target', 'shared target', null, null, 'unicode target'];
      const expected = ['empty', 'left', 'right', 'NULL', 'missing', 'unicode'].map((label, i) => ({ label,
        left: labels[i] === null ? [] : [{ label: labels[i], payload: clone(hostileJson) }], right: labels[i] === null ? [] : [{ label: labels[i], payload: clone(hostileJson) }] }));
      assert.deepEqual(actual, expected); assert.equal(Object.getPrototypeOf(actual[1].left[0].payload), Object.prototype);
      assert.ok(Object.hasOwn(actual[1].left[0].payload, '__proto__')); assert.equal(Object.prototype.fictional, undefined);
      actual[1].left[0].payload.nested.list.push(9); actual[1].left.push({ label: 'local' });
      assert.deepEqual(actual[2], expected[2]); assert.deepEqual(actual[1].right, expected[1].right);
    });
    await check('NULL-only source keys skip target I/O for all three relation kinds', async () => {
      for (const helper of [hasMany, hasOne, belongsTo]) {
        db.clearTrace(); const target = helper(textTargets, { localKey: textRoots.col('key'), foreignKey: textTargets.col('key'), select: ['label'] });
        assert.deepEqual(await db.table(textRoots).findFirst({ where: eq(textRoots.col('id'), 4), select: ['label'], include: { target } }),
          { label: 'NULL', target: helper === hasMany ? [] : null });
        assert.equal(reads(db).length, 1);
      }
    });
    await insert(textRoots, Array.from({ length: 801 }, (_, i) => ({ id: i + 1000, key: 'batch_key_' + i, label: 'text_root_' + i })));
    await insert(textTargets, Array.from({ length: 801 }, (_, i) => ({ id: i + 1000, key: 'batch_key_' + i, label: 'text_target_' + i, payload: {} })));
    for (const count of [400, 401, 801]) await check(count + ' text keys preserve parent ordinals across400-key chunks', async () => {
      const target = hasMany(textTargets, { localKey: textRoots.col('key'), foreignKey: textTargets.col('key'), select: ['label'] });
      db.clearTrace();
      assert.deepEqual(await db.table(textRoots).findMany({ where: gte(textRoots.col('id'), 1000), select: ['label'], limit: count, orderBy: [asc(textRoots.col('id'))], include: { target } }),
        Array.from({ length: count }, (_, i) => ({ label: 'text_root_' + i, target: [{ label: 'text_target_' + i }] })));
      assert.equal(reads(db).length, 1 + Math.ceil(count / 400));
    });
    await insert(batchRoots, Array.from({ length: 801 }, (_, i) => ({ id: i + 1, label: 'root_' + (i + 1) })));
    await insert(batchTargets, Array.from({ length: 801 }, (_, i) => ({ id: i + 1, rootId: i + 1, label: 'target_' + (i + 1) })));
    await insert(batchLeaves, Array.from({ length: 801 }, (_, i) => ({ id: i + 1, targetId: i + 1, label: 'leaf_' + (i + 1) })));
    for (const count of [399, 400, 401, 801]) await check(count + ' unique keys use exact 400-key chunks with no missing or duplicate graph values', async () => {
      const relation = hasMany(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId'), select: ['label'] });
      db.clearTrace(); const rows = await db.table(batchRoots).findMany({ select: ['label'], limit: count, orderBy: [asc(batchRoots.col('id'))], include: { targets: relation } });
      assert.deepEqual(rows, Array.from({ length: count }, (_, i) => ({ label: 'root_' + (i + 1), targets: [{ label: 'target_' + (i + 1) }] })));
      assert.equal(reads(db).length, 1 + Math.ceil(count / 400));
    });
    await check('both singular kinds batch 801 keys and preserve every projected result', async () => {
      for (const helper of [hasOne, belongsTo]) {
        db.clearTrace(); const target = helper(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId'), select: ['label'] });
        assert.deepEqual(await db.table(batchRoots).findMany({ select: ['label'], limit: 801, include: { target } }), Array.from({ length: 801 }, (_, i) => ({ label: 'root_' + (i + 1), target: { label: 'target_' + (i + 1) } })));
        assert.equal(reads(db).length, 4);
      }
    });
    for (const [helper, label] of [[hasOne, 'hasOne'], [belongsTo, 'belongsTo']]) for (const ambiguousKey of [401, 801]) await check(label + ' ambiguity at key' + ambiguousKey + ' rejects the entire promise and leaves session healthy', async () => {
      await insert(batchTargets, [{ id: 9999, rootId: ambiguousKey, label: 'target_' + ambiguousKey }]);
      try {
        const target = helper(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId'), select: ['label'], orderBy: [desc(batchTargets.col('id'))] });
        let exposed = false; db.clearTrace();
        const pending = db.table(batchRoots).findMany({ select: ['label'], limit: 801, include: { target } }).then(value => { exposed = true; return value; });
        await assert.rejects(pending, code('RELATION_CARDINALITY')); assert.equal(exposed, false); assert.equal(reads(db).length, 4);
        assert.equal(await db.table(batchRoots).count(), 801);
      } finally { await db.table(batchTargets).delete({ where: eq(batchTargets.col('id'), 9999), maxRows: 1 }); }
    });
    await check('later nested ambiguity exposes no earlier loaded graph or descendants after the refusal', async () => {
      await insert(batchLeaves, [{ id: 9999, targetId: 801, label: 'leaf_801' }]);
      try {
        const leaf = hasOne(batchLeaves, { localKey: batchTargets.col('id'), foreignKey: batchLeaves.col('targetId'), select: ['label'], include: {
          avatar: belongsTo(avatars, { localKey: batchLeaves.col('id'), foreignKey: avatars.col('id'), select: ['caption'] }),
        } });
        const targets = hasMany(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId'), select: ['label'], include: { leaf } });
        let exposed = false; db.clearTrace(); const pending = db.table(batchRoots).findMany({ select: ['label'], limit: 801, include: { targets } }).then(value => { exposed = true; return value; });
        await assert.rejects(pending, code('RELATION_CARDINALITY')); assert.equal(exposed, false); assert.equal(reads(db).length, 7);
        assert.equal(await db.table(batchRoots).count(), 801);
      } finally { await db.table(batchLeaves).delete({ where: eq(batchLeaves.col('id'), 9999), maxRows: 1 }); }
    });
    await check('caught acknowledged cardinality refusal preserves explicit transaction health and its write commits', async () => {
      await insert(profiles, [{ id: 12, parentId: 1, bio: 'duplicate', active: false, avatarId: null }]);
      try {
        await db.transaction(async tx => {
          await tx.table(nodes).insert({ id: 99, parentId: null, label: 'Committed after local refusal' });
          await assert.rejects(tx.table(parents).findMany({ include: { profile: profile({}) } }), code('RELATION_CARDINALITY'));
          assert.equal(await tx.table(nodes).count(), 4);
        });
        assert.deepEqual(await db.table(nodes).findFirst({ where: eq(nodes.col('id'), 99), select: ['label'] }), { label: 'Committed after local refusal' });
      } finally {
        await db.table(profiles).delete({ where: eq(profiles.col('id'), 12), maxRows: 1 });
        await db.table(nodes).delete({ where: eq(nodes.col('id'), 99), maxRows: 1 });
      }
    });
    await check('physical 10403 binding boundary executes with 400 keys plus10000 predicate values plus3 page bounds', async () => {
      const target = hasMany(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId'), select: ['label'],
        where: inArray(batchTargets.col('id'), Array.from({ length: 10000 }, (_, i) => i + 1)) });
      assert.deepEqual(await db.table(batchRoots).findMany({ select: ['label'], limit: 400, include: { target } }),
        Array.from({ length: 400 }, (_, i) => ({ label: 'root_' + (i + 1), target: [{ label: 'target_' + (i + 1) }] })));
    });
    await check('correlated text mode also executes10403 bindings without adding ordinal parameters', async () => {
      const target = hasMany(textTargets, { localKey: textRoots.col('key'), foreignKey: textTargets.col('key'), select: ['label'],
        where: inArray(textTargets.col('id'), Array.from({ length: 10000 }, (_, i) => i + 1000)) });
      assert.deepEqual(await db.table(textRoots).findMany({ where: gte(textRoots.col('id'), 1000), select: ['label'], limit: 400, include: { target } }),
        Array.from({ length: 400 }, (_, i) => ({ label: 'text_root_' + i, target: [{ label: 'text_target_' + i }] })));
    });
    await insert(capacityRoots, Array.from({ length: 101 }, (_, i) => ({ id: i + 1, shared: i === 100 ? 'single' : 'same' })));
    await insert(capacityTargets, Array.from({ length: 10001 }, (_, i) => ({ id: i + 1, rootId: Math.floor(i / 1000) + 1, shared: i === 10000 ? 'single' : 'same', label: 'capacity_' + (i + 1) })));
    const capacityMany = hasMany(capacityTargets, { localKey: capacityRoots.col('id'), foreignKey: capacityTargets.col('rootId'), limit: 1000, select: ['id', 'label'] });
    await check('exact10000 fetched related rows succeed with every per-parent value checked', async () => {
      const actual = await db.table(capacityRoots).findMany({ where: inArray(capacityRoots.col('id'), Array.from({ length: 10 }, (_, i) => i + 1)), select: ['id'], include: { targets: capacityMany } });
      assert.deepEqual(actual, Array.from({ length: 10 }, (_, root) => ({ id: root + 1, targets: Array.from({ length: 1000 }, (_, i) => ({ id: root * 1000 + i + 1, label: 'capacity_' + (root * 1000 + i + 1) })) })));
      assert.equal(await db.table(capacityRoots).count(), 101);
    });
    await check('the10001st fetched related row is validated then refuses without exposing a partial graph', async () => {
      let exposed = false;
      const pending = db.table(capacityRoots).findMany({ where: inArray(capacityRoots.col('id'), Array.from({ length: 11 }, (_, i) => i + 1)), select: ['id'], include: { targets: capacityMany } }).then(rows => { exposed = true; return rows; });
      await assert.rejects(pending, code('RESULT_LIMIT')); assert.equal(exposed, false); assert.equal(await db.table(capacityRoots).count(), 101);
    });
    const shared = hasMany(capacityTargets, { localKey: capacityRoots.col('shared'), foreignKey: capacityTargets.col('shared'),
      where: or(inArray(capacityTargets.col('id'), Array.from({ length: 100 }, (_, i) => i + 1)), eq(capacityTargets.col('id'), 10001)), select: ['id'], limit: 100 });
    await check('exact10000 returned copies succeed when100 roots share only100 fetched target rows', async () => {
      const actual = await db.table(capacityRoots).findMany({ select: ['id'], limit: 100, include: { targets: shared } });
      assert.deepEqual(actual, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, targets: Array.from({ length: 100 }, (_, j) => ({ id: j + 1 })) })));
      assert.notEqual(actual[0].targets, actual[1].targets); assert.notEqual(actual[0].targets[0], actual[1].targets[0]);
    });
    await check('exact10001 returned copies refuse independently of the101 fetched rows and preserve transaction health', async () => {
      await db.transaction(async tx => {
        await assert.rejects(tx.table(capacityRoots).findMany({ select: ['id'], limit: 101, include: { targets: shared } }), code('RESULT_LIMIT'));
        assert.equal(await tx.table(capacityRoots).count(), 101);
      });
      assert.equal(await db.table(capacityTargets).count(), 10001);
    });
    await check('two aliases charge every returned copy: exact10000 succeeds and the next root refuses', async () => {
      const half = hasMany(capacityTargets, { localKey: capacityRoots.col('shared'), foreignKey: capacityTargets.col('shared'), select: ['id'], limit: 50 });
      const actual = await db.table(capacityRoots).findMany({ select: ['id'], limit: 100, include: { left: half, right: half } });
      assert.deepEqual(actual, Array.from({ length: 100 }, (_, i) => ({ id: i + 1,
        left: Array.from({ length: 50 }, (_, j) => ({ id: j + 1 })), right: Array.from({ length: 50 }, (_, j) => ({ id: j + 1 })) })));
      await assert.rejects(db.table(capacityRoots).findMany({ select: ['id'], limit: 101, include: { left: half, right: half } }), code('RESULT_LIMIT'));
      assert.equal(await db.table(capacityRoots).count(), 101);
    });
    if (postgres) await check('later-chunk malformed physical integer refuses DATA without partial values or poisoning the acknowledged session', async () => {
      await query('UPDATE ' + quote(schema) + '."eager_batch_targets" SET "rootId"=$1::"pg_catalog"."int8" WHERE "id"=$2::"pg_catalog"."int8"', ['801', '801']);
      // Keep the valid correlation key; corrupt a different mapped integer so the row remains in the last batch.
      await query('UPDATE ' + quote(schema) + '."eager_batch_targets" SET "id"=$1::"pg_catalog"."int8" WHERE "rootId"=$2::"pg_catalog"."int8"', ['9007199254740992', '801']);
      try {
        const targets = hasMany(batchTargets, { localKey: batchRoots.col('id'), foreignKey: batchTargets.col('rootId') });
        let exposed = false; const pending = db.table(batchRoots).findMany({ limit: 801, include: { targets } }).then(rows => { exposed = true; return rows; });
        await assert.rejects(pending, code('DATA')); assert.equal(exposed, false); assert.equal(await db.table(batchRoots).count(), 801);
        await db.transaction(async tx => {
          await assert.rejects(tx.table(batchRoots).findMany({ limit: 801, include: { targets } }), code('DATA'));
          assert.equal(await tx.table(batchRoots).count(), 801);
        });
      } finally {
        await query('UPDATE ' + quote(schema) + '."eager_batch_targets" SET "id"=$1::"pg_catalog"."int8" WHERE "rootId"=$2::"pg_catalog"."int8"', ['801', '801']);
      }
    });
    await check('default trace values remain redacted and no generated graph fields escape public results', async () => {
      const marker = "FICTIONAL_EAGER_' OR 1=1 --";
      await db.table(textRoots).insert({ id: 99, key: marker, label: 'redaction control' });
      db.clearTrace(); assert.deepEqual(await db.table(textRoots).findFirst({ where: eq(textRoots.col('id'), 99), select: ['label'], include: {
        targets: hasMany(textTargets, { localKey: textRoots.col('key'), foreignKey: textTargets.col('key'), select: ['label'] }),
      } }), { label: 'redaction control', targets: [] });
      assert.ok(!JSON.stringify(db.exportTrace()).includes(marker)); assert.equal(await p.count(), 4);
    });
    return report;
  } catch (error) { failed = true; throw error; }
  finally {
    const errors = [];
    for (const database of databases) try { await database.close(); cleanup.closedDatabases++; } catch { errors.push('close'); }
    if (postgres && schemaCreated) try { await query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); cleanup.schemaDropped = true; } catch { errors.push('schema'); }
    if (!failed) { assert.equal(cleanup.openedDatabases, cleanup.closedDatabases); if (errors.length) throw new Error('Owned eager fixture cleanup failed.'); }
  }
}

/**
 * Wide sentinel proof, using actual public native PostgreSQL or a separately labelled borrowed real-worker handle.
 * The caller proves ownership and supplies openDatabase({tables,schema,traceValues}) plus raw-text admin.query.
 * The adapter path is necessary because the fresh public PGlite factory cannot accept externally populated storage.
 * No implementation/SQL compiler copy: all eager reads use the supplied public repository API.
 */
export async function runPublicEagerCapacityCases({ engine, sdk, openDatabase, admin }) {
  assert.ok(engine === 'postgresql' || engine === 'pglite-worker-adapter');
  assert.equal(typeof openDatabase, 'function'); assert.equal(typeof admin?.query, 'function');
  const { column, defineTable, hasMany, inArray, asc } = sdk;
  const schema = 'rs_eager_wide_' + randomBytes(6).toString('hex'), namespace = quote(schema);
  const roots = defineTable('eager_wide_roots', { id: column.integer().primaryKey() });
  const columns = { id: column.integer().primaryKey(), rootId: column.integer() };
  for (let i = 0; i < 98; i++) columns['value' + String(i).padStart(2, '0')] = column.integer();
  const targets = defineTable('eager_wide_targets', columns), fields = Object.keys(columns);
  const cases = [], cleanup = { openedHandles: 0, closedHandles: 0, schemaDropped: false };
  const report = { engine, cases, cleanup, scope: 'Exactly100 mapped fields and10000/10001 returned related rows; short numeric storage, no arbitrary-byte-size claim.' };
  const query = async (sql, values = []) => { try { return await admin.query(sql, values); } catch { throw new Error('Owned wide eager fixture administration failed.'); } };
  let db, created = false;
  try {
    await query('CREATE SCHEMA ' + namespace); created = true; await query('REVOKE ALL ON SCHEMA ' + namespace + ' FROM PUBLIC');
    await query('CREATE TABLE ' + namespace + '."eager_wide_roots"("id" int8 NOT NULL PRIMARY KEY)');
    await query('CREATE TABLE ' + namespace + '."eager_wide_targets"(' + fields.map(field => quote(field) + ' int8 NOT NULL' + (field === 'id' ? ' PRIMARY KEY' : '')).join(',') + ')');
    await query('INSERT INTO ' + namespace + '."eager_wide_roots" SELECT g FROM "pg_catalog"."generate_series"($1::"pg_catalog"."int8",$2::"pg_catalog"."int8") AS g', ['1', '11']);
    await query('INSERT INTO ' + namespace + '."eager_wide_targets" SELECT g,((g OPERATOR("pg_catalog".-) $3::"pg_catalog"."int8") OPERATOR("pg_catalog"./) $4::"pg_catalog"."int8") OPERATOR("pg_catalog".+) $3::"pg_catalog"."int8",'
      + Array.from({ length: 98 }, (_, i) => '(g OPERATOR("pg_catalog".+) \'' + (i + 1) + '\'::"pg_catalog"."int8")').join(',')
      + ' FROM "pg_catalog"."generate_series"($1::"pg_catalog"."int8",$2::"pg_catalog"."int8") AS g', ['1', '10001', '1', '1000']);
    db = await openDatabase({ schema, tables: [roots, targets], traceValues: false }); cleanup.openedHandles++;
    const relation = hasMany(targets, { localKey: roots.col('id'), foreignKey: targets.col('rootId'), limit: 1000 });
    const options = count => ({ select: ['id'], orderBy: [asc(roots.col('id'))], where: inArray(roots.col('id'), Array.from({ length: count }, (_, i) => i + 1)), include: { targets: relation } });
    const rows = await db.table(roots).findMany(options(10)); assert.equal(rows.length, 10);
    for (let root = 0; root < 10; root++) {
      assert.equal(rows[root].id, root + 1); names(rows[root], ['id', 'targets']); assert.equal(rows[root].targets.length, 1000);
      for (let index = 0; index < 1000; index++) {
        const id = root * 1000 + index + 1, row = rows[root].targets[index]; names(row, fields);
        assert.equal(row.id, id); assert.equal(row.rootId, root + 1);
        for (let field = 0; field < 98; field++) assert.equal(row['value' + String(field).padStart(2, '0')], id + field + 1);
      }
    }
    cases.push('10000 fetched rows times100 mapped fields pass unchanged ordinary1M cell boundary with every value checked');
    let exposed = false; await assert.rejects(db.table(roots).findMany(options(11)).then(value => { exposed = true; return value; }), code('RESULT_LIMIT'));
    assert.equal(exposed, false); assert.equal(await db.table(roots).count(), 11);
    cases.push('10001st sentinel row crosses mapped1M cell boundary and yields RESULT_LIMIT after complete decoder validation');
    // The malformed sentinel must win DATA over the shared fetched-row limit. This physically mutates only our fixture.
    await query('UPDATE ' + namespace + '."eager_wide_targets" SET "value97"=$1::"pg_catalog"."int8" WHERE "id"=$2::"pg_catalog"."int8"', ['9007199254740992', '10001']);
    await assert.rejects(db.table(roots).findMany(options(11)), code('DATA')); assert.equal(await db.table(roots).count(), 11);
    cases.push('malformed physical integer on10001st wide sentinel is decoded and refuses DATA before shared RESULT_LIMIT');
    return report;
  } finally {
    try { if (db) { await db.close(); cleanup.closedHandles++; } }
    finally { if (created) { await query('DROP SCHEMA ' + namespace + ' CASCADE'); cleanup.schemaDropped = true; } }
  }
}
