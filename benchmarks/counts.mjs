// Fixed relation-count correctness and query-plan fixtures, not a speed ranking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert(['--entry', '--reference-dir', '--output'].includes(args[index]) && args[index + 1], 'Use [--entry BUILT_INDEX] [--reference-dir DIRECTORY] [--output FILE]');
  options[args[index].slice(2)] = path.resolve(args[index + 1]);
}
const entry = options.entry ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const api = await import(pathToFileURL(entry).href);
const ownPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '../package.json'), 'utf8'));
const { column, defineTable, openDatabase, hasMany, hasOne, belongsTo, countRelated, some, eq, isNull, and, not, asc } = api;
const scoreSets = [[], [1], [0], [null], [1, null], [1, 0], [0, null], [1, 1], [1, 0, null]];
const parents = scoreSets.map((scores, index) => ({ id: index + 1, scores }));
const children = [], grandchildren = [];
const nodes = [
  { id: 1, parent_id: null, score: null }, { id: 2, parent_id: 1, score: 1 }, { id: 3, parent_id: 1, score: 1 },
  { id: 4, parent_id: 2, score: null }, { id: 5, parent_id: 2, score: 0 }, { id: 6, parent_id: 3, score: 1 },
  { id: 7, parent_id: 99, score: 1 }, { id: 8, parent_id: 8, score: 1 },
];
for (const parent of parents) for (const score of parent.scores) {
  const child = { id: children.length + 1, parent_id: parent.id, score, label: score === 1 ? 'repeat' : score === 0 ? "' OR 1=1 --" : null };
  children.push(child);
  // Repeated descendants must not multiply the number of counted child rows.
  if (score === 1) for (let index = 0; index < 2; index++) grandchildren.push({ id: grandchildren.length + 1, child_id: child.id, flag: 1 });
}
for (const parent_id of [null, 999]) children.push({ id: children.length + 1, parent_id, score: 1, label: 'orphan' });
const tables = {
  parents: defineTable('parents', { id: column.integer().primaryKey() }),
  children: defineTable('children', { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), score: column.integer().nullable(), label: column.text().nullable() }),
  grandchildren: defineTable('grandchildren', { id: column.integer().primaryKey(), child_id: column.integer().nullable(), flag: column.integer().nullable() }),
  nodes: defineTable('nodes', { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), score: column.integer().nullable() }),
  nocase_parents: defineTable('nocase_parents', { id: column.text().primaryKey() }),
  binary_children: defineTable('binary_children', { id: column.integer().primaryKey(), parent_id: column.text().nullable() }),
  binary_parents: defineTable('binary_parents', { id: column.text().primaryKey() }),
  nocase_children: defineTable('nocase_children', { id: column.integer().primaryKey(), parent_id: column.text().nullable() }),
  bench_parents: defineTable('bench_parents', { id: column.integer().primaryKey() }),
  bench_children: defineTable('bench_children', { id: column.integer().primaryKey(), parent_id: column.integer(), score: column.integer().nullable() }),
};
const report = {
  format: 'rowstitch-relation-count-comparison', version: 1,
  environment: { node: process.version, nodeSQLite: process.versions.sqlite, rowstitch: ownPackage.version },
  fixture: { parentScoreSets: scoreSets, selfRows: nodes, indexedParents: 5000, indexedChildren: 20000 },
  cases: [], contractDifferences: [],
  limitations: [
    'Fixed SQLite correctness, actual statement counts and query plans only; no timing or general superiority claim.',
    'COUNT(*) can scan a complete matching range; EXISTS can stop after the first match. One SELECT is not a speed guarantee.',
    'Native statement calls are observed through forwarding wrappers, restored when the runner finishes.',
    'Count predicates count matching rows, including duplicates for a singular descriptor; they do not load or validate a singular result.',
    'This does not test aggregate projections, grouping, DISTINCT, composite relationships or non-SQLite engines.',
  ],
};
let orangeMap;
if (options['reference-dir']) {
  const require = createRequire(path.join(options['reference-dir'], 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(options['reference-dir'], 'node_modules/orange-orm/package.json'), 'utf8'));
  assert.equal(pkg.version, '5.5.1', 'Use the pinned orange-orm@5.5.1 reference.');
  const { default: orange } = await import(pathToFileURL(require.resolve('orange-orm')).href);
  report.environment.orange = pkg.version;
  report.environment.orangeEntry = 'Published npm CommonJS source export, explicitly resolved and dynamically imported';
  orangeMap = orange.map(x => ({
    parents: x.table('parents').map(({ column: c }) => ({ id: c('id').numeric().primary() })),
    children: x.table('children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').numeric(), score: c('score').numeric(), label: c('label').string() })),
    grandchildren: x.table('grandchildren').map(({ column: c }) => ({ id: c('id').numeric().primary(), childId: c('child_id').numeric(), flag: c('flag').numeric() })),
    nodes: x.table('nodes').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').numeric(), score: c('score').numeric() })),
    nocase_parents: x.table('nocase_parents').map(({ column: c }) => ({ id: c('id').string().primary() })),
    binary_children: x.table('binary_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').string() })),
    binary_parents: x.table('binary_parents').map(({ column: c }) => ({ id: c('id').string().primary() })),
    nocase_children: x.table('nocase_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').string() })),
    bench_parents: x.table('bench_parents').map(({ column: c }) => ({ id: c('id').numeric().primary() })),
    bench_children: x.table('bench_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').numeric(), score: c('score').numeric() })),
  })).map(x => ({
    parents: x.parents.map(({ hasMany }) => ({ children: hasMany(x.children).by('parentId') })),
    children: x.children.map(({ hasMany }) => ({ grandchildren: hasMany(x.grandchildren).by('childId') })),
    nodes: x.nodes.map(({ hasMany }) => ({ children: hasMany(x.nodes).by('parentId') })),
    nocase_parents: x.nocase_parents.map(({ hasMany }) => ({ children: hasMany(x.binary_children).by('parentId') })),
    binary_parents: x.binary_parents.map(({ hasMany }) => ({ children: hasMany(x.nocase_children).by('parentId') })),
    bench_parents: x.bench_parents.map(({ hasMany }) => ({ children: hasMany(x.bench_children).by('parentId') })),
  }));
} else report.limitations.push('Orange was not loaded. Pass --reference-dir for the pinned released-package comparison.');

let recording = false, commands = [];
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  for (const method of ['all', 'get', 'run']) {
    const original = statement[method];
    statement[method] = function (...parameters) {
      if (recording) commands.push({ sql, parameters });
      return original.apply(this, parameters);
    };
  }
  return statement;
};
const selects = () => commands.filter(command => /^\s*SELECT\b/i.test(command.sql));
async function check(tool, name, action) {
  commands = []; recording = true;
  let result, error;
  try { result = await action(); assert.equal(selects().length, 1, 'Expected one SELECT.'); }
  catch (caught) { error = caught.message; }
  finally { recording = false; }
  report.cases.push({ tool, name, status: error ? 'fail' : 'pass', ...(error ? { error } : result), selectQueries: selects().length, commands });
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-counts-'));
const filename = path.join(folder, 'fictional.sqlite');
const raw = new DatabaseSync(filename, { enableExtensions: false });
let own, reference;
try {
  raw.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY);
    CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER, score INTEGER, label TEXT);
    CREATE TABLE grandchildren(id INTEGER PRIMARY KEY, child_id INTEGER, flag INTEGER);
    CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent_id INTEGER, score INTEGER);
    CREATE INDEX child_parent_score ON children(parent_id, score);
    CREATE INDEX grandchild_parent_flag ON grandchildren(child_id, flag);
    CREATE INDEX node_parent_score ON nodes(parent_id, score);
    CREATE TABLE nocase_parents(id TEXT COLLATE NOCASE PRIMARY KEY);
    CREATE TABLE binary_children(id INTEGER PRIMARY KEY, parent_id TEXT COLLATE BINARY);
    CREATE TABLE binary_parents(id TEXT COLLATE BINARY PRIMARY KEY);
    CREATE TABLE nocase_children(id INTEGER PRIMARY KEY, parent_id TEXT COLLATE NOCASE);
    CREATE TABLE bench_parents(id INTEGER PRIMARY KEY);
    CREATE TABLE bench_children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, score INTEGER);
    CREATE INDEX bench_child_parent_score ON bench_children(parent_id, score);`);
  for (const row of parents) raw.prepare('INSERT INTO parents VALUES (?)').run(row.id);
  for (const row of children) raw.prepare('INSERT INTO children VALUES (?,?,?,?)').run(row.id, row.parent_id, row.score, row.label);
  for (const row of grandchildren) raw.prepare('INSERT INTO grandchildren VALUES (?,?,?)').run(row.id, row.child_id, row.flag);
  for (const row of nodes) raw.prepare('INSERT INTO nodes VALUES (?,?,?)').run(row.id, row.parent_id, row.score);
  for (const name of ['nocase_parents', 'binary_parents']) raw.prepare(`INSERT INTO ${name} VALUES (?)`).run('Sample');
  for (const name of ['binary_children', 'nocase_children']) raw.prepare(`INSERT INTO ${name} VALUES (?,?)`).run(1, 'sample');
  raw.exec('BEGIN');
  try {
    const insertParent = raw.prepare('INSERT INTO bench_parents VALUES (?)'), insertChild = raw.prepare('INSERT INTO bench_children VALUES (?,?,?)');
    for (let id = 1; id <= 5000; id++) {
      insertParent.run(id);
      for (let index = 0; index < 4; index++) insertChild.run((id - 1) * 4 + index + 1, id, id % 3 === 0 ? 1 : id % 3 === 1 ? 0 : index % 2 ? 1 : null);
    }
    raw.exec('COMMIT');
  } catch (error) { raw.exec('ROLLBACK'); throw error; }
  own = openDatabase(filename, { tables: Object.values(tables) });
  reference = orangeMap?.sqlite(filename, { size: 1, min: 1 });
  if (reference) {
    report.environment.orangeSQLite = String((await reference.query('SELECT sqlite_version() AS v'))[0].v);
    assert.equal(report.environment.orangeSQLite, process.versions.sqlite, 'The comparison expects the same actual Node SQLite engine.');
  }
  const { parents: p, children: c, grandchildren: g, nodes: n } = tables;
  const relation = hasMany(c, { localKey: p.col('id'), foreignKey: c.col('parent_id') });
  const descendants = hasMany(g, { localKey: c.col('id'), foreignKey: g.col('child_id') });
  const self = hasMany(n, { localKey: n.col('id'), foreignKey: n.col('parent_id') });
  const domain = hasMany(c, { localKey: p.col('id'), foreignKey: c.col('parent_id'), where: not(isNull(c.col('score'))) });
  async function compare(name, table, predicate, orangeWhere, expected, sql, parameters = [], extra = {}) {
    await check('raw node:sqlite + JS oracle', name, () => {
      const actual = raw.prepare(sql).all(...parameters).map(x => x.id); assert.deepEqual(actual, expected);
      return { expectedIds: expected, actualIds: actual };
    });
    await check('rowstitch', name, () => {
      const definition = tables[table], actual = own.table(definition).findMany({ where: predicate, select: ['id'], orderBy: [asc(definition.col('id'))] }).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual, ...extra };
    });
    if (reference && orangeWhere) await check('orange-orm@5.5.1', name, async () => {
      const actual = (await reference[table].getMany({ where: orangeWhere, orderBy: 'id', id: true })).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
  }
  const operators = { '=': ['eq', (a, b) => a === b], '<>': ['ne', (a, b) => a !== b], '>': ['gt', (a, b) => a > b], '>=': ['ge', (a, b) => a >= b], '<': ['lt', (a, b) => a < b], '<=': ['le', (a, b) => a <= b] };
  for (const [operator, [method, matches]] of Object.entries(operators)) for (const threshold of [0, 1, 2, 3, 4, Number.MAX_SAFE_INTEGER]) {
    const expected = parents.filter(x => matches(x.scores.length, threshold)).map(x => x.id);
    await compare(`all rows ${operator} ${threshold}`, 'parents', countRelated(relation, operator, threshold), x => x.children.count()[method](threshold), expected,
      `SELECT id FROM parents p WHERE (SELECT COUNT(*) FROM children c WHERE c.parent_id=p.id) ${operator} ? ORDER BY id`, [threshold]);
  }
  const predicates = [
    ['positive', relation, eq(c.col('score'), 1), x => x.score.eq(1), row => row.score === 1, 'c.score=?', [1]],
    ['NULL', relation, isNull(c.col('score')), x => x.score.eq(null), row => row.score === null, 'c.score IS NULL', []],
    ['nonNULL domain AND repeated label', domain, eq(c.col('label'), 'repeat'), x => x.score.ne(null).and(x.label.eq('repeat')), row => row.score !== null && row.label === 'repeat', 'c.score IS NOT NULL AND c.label=?', ['repeat']],
    ['bound quote', relation, eq(c.col('label'), "' OR 1=1 --"), x => x.label.eq("' OR 1=1 --"), row => row.label === "' OR 1=1 --", 'c.label=?', ["' OR 1=1 --"]],
    ['nested count', relation, countRelated(descendants, '>=', 2, eq(g.col('flag'), 1)), x => x.grandchildren.count(g => g.flag.eq(1)).ge(2), row => grandchildren.filter(g => g.child_id === row.id && g.flag === 1).length >= 2, '(SELECT COUNT(*) FROM grandchildren g WHERE g.child_id=c.id AND g.flag=?)>=?', [1, 2]],
    ['nested some', relation, some(descendants, eq(g.col('flag'), 1)), x => x.grandchildren.any(g => g.flag.eq(1)), row => grandchildren.some(g => g.child_id === row.id && g.flag === 1), 'EXISTS (SELECT 1 FROM grandchildren g WHERE g.child_id=c.id AND g.flag=?)', [1]],
  ];
  for (const [name, rel, predicate, orangePredicate, matches, sql, parameters] of predicates) for (const threshold of [0, 1, 2]) {
    const expected = parents.filter(p => children.filter(c => c.parent_id === p.id && matches(c)).length === threshold).map(x => x.id);
    await compare(`${name} count = ${threshold}`, 'parents', countRelated(rel, '=', threshold, predicate), x => x.children.count(orangePredicate).eq(threshold), expected,
      `SELECT id FROM parents p WHERE (SELECT COUNT(*) FROM children c WHERE c.parent_id=p.id AND (${sql}))=? ORDER BY id`, [...parameters, threshold]);
  }
  const selfCount = id => nodes.filter(x => x.parent_id === id).length;
  for (const threshold of [0, 1, 2]) {
    await compare(`self count = ${threshold}`, 'nodes', countRelated(self, '=', threshold), x => x.children.count().eq(threshold), nodes.filter(x => selfCount(x.id) === threshold).map(x => x.id),
      'SELECT id FROM nodes n WHERE (SELECT COUNT(*) FROM nodes c WHERE c.parent_id=n.id)=? ORDER BY id', [threshold]);
    const expected = nodes.filter(x => nodes.filter(c => c.parent_id === x.id && selfCount(c.id) >= 1).length === threshold).map(x => x.id);
    await compare(`nested self count = ${threshold}`, 'nodes', countRelated(self, '=', threshold, countRelated(self, '>=', 1)), x => x.children.count(c => c.children.count().ge(1)).eq(threshold), expected,
      'SELECT id FROM nodes n WHERE (SELECT COUNT(*) FROM nodes c WHERE c.parent_id=n.id AND (SELECT COUNT(*) FROM nodes g WHERE g.parent_id=c.id)>=?)=? ORDER BY id', [1, threshold]);
  }
  await compare('count under some', 'parents', some(relation, countRelated(descendants, '>=', 2)), x => x.children.any(c => c.grandchildren.count().ge(2)), parents.filter(p => p.scores.includes(1)).map(x => x.id),
    'SELECT id FROM parents p WHERE EXISTS (SELECT 1 FROM children c WHERE c.parent_id=p.id AND (SELECT COUNT(*) FROM grandchildren g WHERE g.child_id=c.id)>=?) ORDER BY id', [2]);
  await compare('two independent count scopes', 'parents', and(countRelated(relation, '>=', 1, eq(c.col('score'), 1)), countRelated(relation, '=', 1, isNull(c.col('score')))), x => x.children.count(c => c.score.eq(1)).ge(1).and(x.children.count(c => c.score.eq(null)).eq(1)), parents.filter(p => p.scores.includes(1) && p.scores.filter(x => x === null).length === 1).map(x => x.id),
    'SELECT id FROM parents p WHERE (SELECT COUNT(*) FROM children c WHERE c.parent_id=p.id AND c.score=?)>=? AND (SELECT COUNT(*) FROM children d WHERE d.parent_id=p.id AND d.score IS NULL)=? ORDER BY id', [1, 1, 1]);
  await compare('NOT count comparison', 'parents', not(countRelated(relation, '=', 1)), x => x.children.count().eq(1).not(), parents.filter(p => p.scores.length !== 1).map(x => x.id),
    'SELECT id FROM parents p WHERE NOT ((SELECT COUNT(*) FROM children c WHERE c.parent_id=p.id)=?) ORDER BY id', [1]);
  await compare('hasOne counts rows without cardinality assertion', 'parents', countRelated(hasOne(c, { localKey: p.col('id'), foreignKey: c.col('parent_id') }), '=', 2), undefined, parents.filter(p => p.scores.length === 2).map(x => x.id),
    'SELECT id FROM parents p WHERE (SELECT COUNT(*) FROM children c WHERE c.parent_id=p.id)=? ORDER BY id', [2], { referenceScope: 'Rowstitch descriptor behavior; Orange singular count is not part of this comparison.' });
  await compare('belongsTo count distinguishes orphan and NULL foreign keys', 'children', countRelated(belongsTo(p, { localKey: c.col('parent_id'), foreignKey: p.col('id') }), '=', 0), undefined, children.filter(c => !parents.some(p => p.id === c.parent_id)).map(x => x.id),
    'SELECT id FROM children c WHERE (SELECT COUNT(*) FROM parents p WHERE p.id=c.parent_id)=? ORDER BY id', [0], { referenceScope: 'Rowstitch descriptor behavior; Orange singular count is not part of this comparison.' });
  for (const [parentName, childName, expected, orangeExpected] of [['nocase_parents', 'binary_children', [], ['Sample']], ['binary_parents', 'nocase_children', ['Sample'], []]]) {
    const parent = tables[parentName], child = tables[childName], rel = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parent_id') });
    await compare(parentName + ' foreign-left count', parentName, countRelated(rel, '=', 1), undefined, expected,
      `SELECT id FROM ${parentName} p WHERE (SELECT COUNT(*) FROM ${childName} c WHERE c.parent_id=p.id)=? ORDER BY id`, [1]);
    if (reference) await check('orange-orm@5.5.1', parentName + ' parent-left count', async () => {
      const actual = (await reference[parentName].getMany({ where: x => x.children.count().eq(1) })).map(x => x.id);
      assert.deepEqual(actual, orangeExpected);
      report.contractDifferences.push({ name: parentName + ' equality operand order', rowstitchIds: expected, orangeIds: actual, note: 'Foreign-column-left vs parent-column-left collation; the difference is documented, not an upstream defect.' });
      return { expectedIds: orangeExpected, actualIds: actual };
    });
  }
  const parent = tables.bench_parents, child = tables.bench_children, rel = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parent_id') });
  const indexed = [
    ['all rows >= 3', countRelated(rel, '>=', 3), x => x.children.count().ge(3), () => true, '', [3]],
    ['positive rows >= 3', countRelated(rel, '>=', 3, eq(child.col('score'), 1)), x => x.children.count(c => c.score.eq(1)).ge(3), id => id % 3 === 0, ' AND c.score=?', [1, 3]],
    ['NULL rows >= 2', countRelated(rel, '>=', 2, isNull(child.col('score'))), x => x.children.count(c => c.score.eq(null)).ge(2), id => id % 3 === 2, ' AND c.score IS NULL', [2]],
  ];
  function verifyIndex(sql, parameters) {
    const plan = raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(x => x.detail);
    assert(plan.some(detail => /SEARCH .* USING COVERING INDEX bench_child_parent_score/.test(detail)), 'Missing indexed child lookup.'); return plan;
  }
  for (const [name, predicate, orangeWhere, matches, suffix, parameters] of indexed) {
    const expected = Array.from({ length: 5000 }, (_, index) => index + 1).filter(matches);
    await check('raw node:sqlite + JS oracle', 'indexed ' + name, () => {
      const sql = `SELECT id FROM bench_parents p WHERE (SELECT COUNT(*) FROM bench_children c WHERE c.parent_id=p.id${suffix})>=? ORDER BY id LIMIT ? OFFSET ?`;
      const bound = [...parameters, 10000, 0], actual = raw.prepare(sql).all(...bound).map(x => x.id); assert.deepEqual(actual, expected);
      return { matchingParents: actual.length, plan: verifyIndex(sql, bound) };
    });
    await check('rowstitch', 'indexed ' + name, () => {
      const queryOptions = { where: predicate, select: ['id'], orderBy: [asc(parent.col('id'))], limit: 10000 };
      const compiled = own.table(parent).compileSelect(queryOptions), actual = own.table(parent).findMany(queryOptions).map(x => x.id); assert.deepEqual(actual, expected);
      return { matchingParents: actual.length, plan: verifyIndex(compiled.sql, compiled.parameters) };
    });
    if (reference) await check('orange-orm@5.5.1', 'indexed ' + name, async () => {
      const actual = (await reference.bench_parents.getMany({ where: orangeWhere, orderBy: 'id', id: true, limit: 10000, offset: 0 })).map(x => x.id); assert.deepEqual(actual, expected);
      const query = selects()[0]; assert(query, 'Expected an observed Orange SELECT.');
      return { matchingParents: actual.length, plan: verifyIndex(query.sql, query.parameters) };
    });
  }
} finally {
  try { await reference?.close(); }
  finally {
    try { own?.close(); }
    finally {
      try { raw.close(); }
      finally {
        DatabaseSync.prototype.prepare = originalPrepare;
        const target = path.resolve(folder);
        assert(path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('rowstitch-counts-'));
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }
}
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length, contractDifferences: report.contractDifferences.length };
const text = JSON.stringify(report, null, 2) + '\n';
if (options.output) fs.writeFileSync(options.output, text);
process.stdout.write(text);
if (report.summary.failed) process.exitCode = 1;
