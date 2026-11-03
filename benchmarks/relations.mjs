// Fixed relation correctness and query-plan fixtures, not a speed ranking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert(['--entry', '--reference-dir', '--output'].includes(args[index]) && args[index + 1], 'Use [--entry BUILT_INDEX] [--reference-dir DIRECTORY] [--output FILE]');
  options[args[index].slice(2)] = path.resolve(args[index + 1]);
}
const entry = options.entry ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const api = await import(pathToFileURL(entry).href);
const ownPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '../package.json'), 'utf8'));
const { column, defineTable, openDatabase, hasMany, some, none, every, eq, gt, isNull, and, not, asc } = api;
const sets = [[], [1], [0], [null], [1, null], [1, 0], [0, null], [1, 1], [1, 0, null]];
const ids = test => sets.flatMap((values, index) => test(values) ? [index + 1] : []);
const tables = {
  parents: defineTable('parents', { id: column.integer().primaryKey(), title: column.text().nullable() }),
  children: defineTable('children', { id: column.integer().primaryKey(), parent_id: column.integer().nullable(), score: column.integer().nullable(), label: column.text().nullable() }),
  grandchildren: defineTable('grandchildren', { id: column.integer().primaryKey(), child_id: column.integer().nullable(), flag: column.integer().nullable() }),
  nocase_parents: defineTable('nocase_parents', { id: column.text().primaryKey() }),
  binary_children: defineTable('binary_children', { id: column.integer().primaryKey(), parent_id: column.text().nullable() }),
  binary_parents: defineTable('binary_parents', { id: column.text().primaryKey() }),
  nocase_children: defineTable('nocase_children', { id: column.integer().primaryKey(), parent_id: column.text().nullable() }),
  bench_parents: defineTable('bench_parents', { id: column.integer().primaryKey() }),
  bench_children: defineTable('bench_children', { id: column.integer().primaryKey(), parent_id: column.integer(), score: column.integer().nullable() }),
};
const report = {
  format: 'rowstitch-relation-comparison', version: 1,
  environment: { node: process.version, nodeSQLite: process.versions.sqlite, rowstitch: ownPackage.version },
  fixture: { parentScoreSets: sets, indexedParents: 5000, indexedChildren: 20000 },
  cases: [], contractDifferences: [],
  limitations: [
    'Fixed SQLite correctness, actual statement counts and query plans only; no latency or general superiority claim.',
    'Native statement calls are observed through forwarding wrappers, restored when the runner finishes.',
    'Strict vacuous every is compared with an equivalent Orange none(violation OR NULL), separately from native Orange all.',
    'Differing parent/foreign-column collations are measured as contract differences, not upstream defects.',
    'Only single-column relationships are exercised; this is not composite-key, multi-engine or full Orange parity.',
  ],
};
let orange, orangeMap;
if (options['reference-dir']) {
  const require = createRequire(path.join(options['reference-dir'], 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(options['reference-dir'], 'node_modules/orange-orm/package.json'), 'utf8'));
  assert.equal(pkg.version, '5.5.1', 'Use the pinned orange-orm@5.5.1 reference.');
  orange = (await import(pathToFileURL(require.resolve('orange-orm')).href)).default;
  report.environment.orange = pkg.version;
  report.environment.orangeEntry = 'Published npm CommonJS source export, explicitly resolved and dynamically imported';
  orangeMap = orange.map(x => ({
    parents: x.table('parents').map(({ column: c }) => ({ id: c('id').numeric().primary(), title: c('title').string() })),
    children: x.table('children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').numeric(), score: c('score').numeric(), label: c('label').string() })),
    grandchildren: x.table('grandchildren').map(({ column: c }) => ({ id: c('id').numeric().primary(), childId: c('child_id').numeric(), flag: c('flag').numeric() })),
    nocase_parents: x.table('nocase_parents').map(({ column: c }) => ({ id: c('id').string().primary() })),
    binary_children: x.table('binary_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').string() })),
    binary_parents: x.table('binary_parents').map(({ column: c }) => ({ id: c('id').string().primary() })),
    nocase_children: x.table('nocase_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').string() })),
    bench_parents: x.table('bench_parents').map(({ column: c }) => ({ id: c('id').numeric().primary() })),
    bench_children: x.table('bench_children').map(({ column: c }) => ({ id: c('id').numeric().primary(), parentId: c('parent_id').numeric(), score: c('score').numeric() })),
  })).map(x => ({
    parents: x.parents.map(({ hasMany }) => ({ children: hasMany(x.children).by('parentId') })),
    children: x.children.map(({ hasMany }) => ({ grandchildren: hasMany(x.grandchildren).by('childId') })),
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
const selectCommands = () => commands.filter(command => /^\s*(?:SELECT|WITH)\b/i.test(command.sql));
async function check(tool, name, action, expectedSelects = 1) {
  commands = []; recording = true;
  let result, error;
  try { result = await action(); assert.equal(selectCommands().length, expectedSelects, 'Unexpected SELECT statement count.'); }
  catch (caught) { error = caught.message; }
  finally { recording = false; }
  report.cases.push({ tool, name, status: error ? 'fail' : 'pass', ...(error ? { error } : result), selectQueries: selectCommands().length, commands });
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-relations-'));
const raw = new DatabaseSync(path.join(directory, 'fictional.sqlite'), { enableExtensions: false });
let own, reference;
try {
  raw.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER, score INTEGER, label TEXT);
    CREATE TABLE grandchildren(id INTEGER PRIMARY KEY, child_id INTEGER, flag INTEGER);
    CREATE TABLE nocase_parents(id TEXT COLLATE NOCASE PRIMARY KEY);
    CREATE TABLE binary_children(id INTEGER PRIMARY KEY, parent_id TEXT COLLATE BINARY);
    CREATE TABLE binary_parents(id TEXT COLLATE BINARY PRIMARY KEY);
    CREATE TABLE nocase_children(id INTEGER PRIMARY KEY, parent_id TEXT COLLATE NOCASE);
    CREATE TABLE bench_parents(id INTEGER PRIMARY KEY);
    CREATE TABLE bench_children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, score INTEGER);
    CREATE INDEX bench_child_parent_score ON bench_children(parent_id, score);`);
  let childId = 0;
  for (const [index, values] of sets.entries()) {
    raw.prepare('INSERT INTO parents VALUES (?,?)').run(index + 1, `Sample ${index + 1}`);
    for (const score of values) {
      const id = ++childId;
      raw.prepare('INSERT INTO children VALUES (?,?,?,?)').run(id, index + 1, score, score === 1 ? "' OR 1=1 --" : 'ordinary');
      // Only false children have a flagged descendant, catching cross-child correlation.
      if (score === 0) raw.prepare('INSERT INTO grandchildren VALUES (?,?,?)').run(id, id, 1);
    }
  }
  raw.prepare('INSERT INTO children VALUES (?,?,?,?)').run(++childId, null, 1, 'unrelated');
  for (const name of ['nocase_parents', 'binary_parents']) raw.prepare(`INSERT INTO ${name} VALUES (?)`).run('Sample');
  for (const name of ['binary_children', 'nocase_children']) raw.prepare(`INSERT INTO ${name} VALUES (?,?)`).run(1, 'sample');
  raw.exec('BEGIN');
  try {
    const insertParent = raw.prepare('INSERT INTO bench_parents VALUES (?)'), insertChild = raw.prepare('INSERT INTO bench_children VALUES (?,?,?)');
    for (let id = 1; id <= 5000; id++) {
      insertParent.run(id);
      for (let j = 0; j < 4; j++) insertChild.run((id - 1) * 4 + j + 1, id, id % 3 === 0 ? 1 : id % 3 === 1 ? 0 : j % 2 ? 1 : null);
    }
    raw.exec('COMMIT');
  } catch (error) { raw.exec('ROLLBACK'); throw error; }
  own = openDatabase(path.join(directory, 'fictional.sqlite'), { tables: Object.values(tables) });
  reference = orangeMap?.sqlite(path.join(directory, 'fictional.sqlite'), { size: 1, min: 1 });
  if (reference) {
    report.environment.orangeSQLite = String((await reference.query('SELECT sqlite_version() AS v'))[0].v);
    assert.equal(report.environment.orangeSQLite, process.versions.sqlite, 'The comparison expects the same actual Node SQLite engine.');
  }
  const { parents: p, children: c, grandchildren: g } = tables;
  const rel = hasMany(c, { localKey: p.col('id'), foreignKey: c.col('parent_id') });
  const descendants = hasMany(g, { localKey: c.col('id'), foreignKey: g.col('child_id') });
  const filtered = hasMany(c, { localKey: p.col('id'), foreignKey: c.col('parent_id'), where: not(isNull(c.col('score'))) });
  const positive = eq(c.col('score'), 1), nullScore = isNull(c.col('score'));
  const sub = 'SELECT 1 FROM children c WHERE c.parent_id=p.id';
  const shared = [
    ['exists', some(rel), x => x.children.exists(), ids(v => v.length > 0), `EXISTS (${sub})`, []],
    ['some score=1', some(rel, positive), x => x.children.any(c => c.score.eq(1)), ids(v => v.includes(1)), `EXISTS (${sub} AND c.score=?)`, [1]],
    ['none score=1', none(rel, positive), x => x.children.none(c => c.score.eq(1)), ids(v => !v.includes(1)), `NOT EXISTS (${sub} AND c.score=?)`, [1]],
    ['none exists', none(rel), x => x.children.exists().not(), ids(v => v.length === 0), `NOT EXISTS (${sub})`, []],
    ['every strict score=1', every(rel, positive), x => x.children.none(c => c.score.ne(1).or(c.score.eq(null))), ids(v => v.every(x => x === 1)), `NOT EXISTS (${sub} AND (c.score=?) IS NOT TRUE)`, [1]],
    ['some IS NULL', some(rel, nullScore), x => x.children.any(c => c.score.eq(null)), ids(v => v.includes(null)), `EXISTS (${sub} AND c.score IS NULL)`, []],
    ['every IS NULL', every(rel, nullScore), x => x.children.none(c => c.score.ne(null)), ids(v => v.every(x => x === null)), `NOT EXISTS (${sub} AND c.score IS NOT NULL)`, []],
    ['none IS NULL', none(rel, nullScore), x => x.children.none(c => c.score.eq(null)), ids(v => !v.includes(null)), `NOT EXISTS (${sub} AND c.score IS NULL)`, []],
    ['NOT some score=1', not(some(rel, positive)), x => x.children.any(c => c.score.eq(1)).not(), ids(v => !v.includes(1)), `NOT EXISTS (${sub} AND c.score=?)`, [1]],
    ['nested same-child scope', some(rel, and(positive, some(descendants, eq(g.col('flag'), 1)))), x => x.children.any(c => c.score.eq(1).and(c.grandchildren.any(g => g.flag.eq(1)))), [], `EXISTS (${sub} AND c.score=? AND EXISTS (SELECT 1 FROM grandchildren g WHERE g.child_id=c.id AND g.flag=?))`, [1, 1]],
    ['nested some', some(rel, some(descendants, eq(g.col('flag'), 1))), x => x.children.any(c => c.grandchildren.any(g => g.flag.eq(1))), ids(v => v.includes(0)), `EXISTS (${sub} AND EXISTS (SELECT 1 FROM grandchildren g WHERE g.child_id=c.id AND g.flag=?))`, [1]],
    ['nested none', none(rel, some(descendants, eq(g.col('flag'), 1))), x => x.children.none(c => c.grandchildren.any(g => g.flag.eq(1))), ids(v => !v.includes(0)), `NOT EXISTS (${sub} AND EXISTS (SELECT 1 FROM grandchildren g WHERE g.child_id=c.id AND g.flag=?))`, [1]],
    ['quoted literal', some(rel, eq(c.col('label'), "' OR 1=1 --")), x => x.children.any(c => c.label.eq("' OR 1=1 --")), ids(v => v.includes(1)), `EXISTS (${sub} AND c.label=?)`, ["' OR 1=1 --"]],
    ['mixed outer filter', and(gt(p.col('id'), 4), none(rel, positive)), x => x.id.gt(4).and(x.children.none(c => c.score.eq(1))), [7], `p.id>? AND NOT EXISTS (${sub} AND c.score=?)`, [4, 1]],
    ['filtered domain every', every(filtered, positive), x => x.children.none(c => c.score.ne(null).and(c.score.ne(1).or(c.score.eq(null)))), ids(v => v.filter(x => x !== null).every(x => x === 1)), `NOT EXISTS (${sub} AND c.score IS NOT NULL AND (c.score=?) IS NOT TRUE)`, [1]],
  ];
  for (const [name, predicate, orangeWhere, expected, sql, parameters] of shared) {
    await check('raw node:sqlite + JS oracle', name, () => {
      const actual = raw.prepare('SELECT id FROM parents p WHERE ' + sql + ' ORDER BY p.id').all(...parameters).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
    await check('rowstitch', name, () => {
      const actual = own.table(p).findMany({ where: predicate, orderBy: [asc(p.col('id'))], select: ['id'] }).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
    if (reference) await check('orange-orm@5.5.1', name, async () => {
      const actual = (await reference.parents.getMany({ where: orangeWhere, orderBy: 'id', id: true })).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
  }
  if (reference) {
    await check('orange-orm@5.5.1', 'native all differs from strict every', async () => {
      const actual = (await reference.parents.getMany({ where: x => x.children.all(c => c.score.eq(1)), orderBy: 'id' })).map(x => x.id);
      const expected = ids(v => v.includes(1) && !v.includes(0)); assert.deepEqual(actual, expected);
      report.contractDifferences.push({ name: 'all/every empty and NULL behavior', orangeAllIds: actual, rowstitchStrictEveryIds: ids(v => v.every(x => x === 1)), note: 'Orange all excludes empty sets and accepts [true,NULL]; strict every accepts empty sets and rejects [true,NULL]. Both are tested against their stated contract.' });
      return { expectedIds: expected, actualIds: actual };
    });
    await check('orange-orm@5.5.1', 'filtered relation count (reference case; shared coverage in counts.mjs)', async () => {
      const actual = (await reference.parents.getMany({ where: x => x.children.count(c => c.score.eq(1)).eq(1), orderBy: 'id' })).map(x => x.id);
      const expected = ids(v => v.filter(x => x === 1).length === 1); assert.deepEqual(actual, expected);
      return { expectedIds: expected, actualIds: actual };
    });
  }
  for (const [parentName, childName, expected, orangeExpected] of [['nocase_parents', 'binary_children', [], ['Sample']], ['binary_parents', 'nocase_children', ['Sample'], []]]) {
    const parent = tables[parentName], child = tables[childName];
    const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parent_id') });
    await check('raw node:sqlite', parentName + ' foreign-left collation', () => {
      const actual = raw.prepare(`SELECT id FROM ${parentName} p WHERE EXISTS (SELECT 1 FROM ${childName} c WHERE c.parent_id=p.id)`).all().map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
    await check('rowstitch', parentName + ' filter collation', () => {
      const actual = own.table(parent).findMany({ where: some(relation) }).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    });
    await check('rowstitch', parentName + ' eager collation agrees with filter', () => {
      const actual = own.table(parent).findMany({ include: { children: relation } }).filter(x => x.children.length > 0).map(x => x.id);
      assert.deepEqual(actual, expected); return { expectedIds: expected, actualIds: actual };
    }, 2);
    if (reference) await check('orange-orm@5.5.1', parentName + ' parent-left collation', async () => {
      const actual = (await reference[parentName].getMany({ where: x => x.children.exists() })).map(x => x.id);
      assert.deepEqual(actual, orangeExpected);
      report.contractDifferences.push({ name: parentName + ' equality operand order', rowstitchIds: expected, orangeIds: actual, note: 'Rowstitch uses the foreign-column collation consistently with its eager loader; Orange quantifiers use the parent-column collation.' });
      return { expectedIds: orangeExpected, actualIds: actual };
    });
  }
  const parent = tables.bench_parents, child = tables.bench_children;
  const relation = hasMany(child, { localKey: parent.col('id'), foreignKey: child.col('parent_id') });
  const positiveChild = eq(child.col('score'), 1);
  const indexed = [
    ['some', some(relation, positiveChild), x => x.children.any(c => c.score.eq(1)), id => id % 3 !== 1, 'EXISTS', 'c.score=?'],
    ['none', none(relation, positiveChild), x => x.children.none(c => c.score.eq(1)), id => id % 3 === 1, 'NOT EXISTS', 'c.score=?'],
    ['every strict', every(relation, positiveChild), x => x.children.none(c => c.score.ne(1).or(c.score.eq(null))), id => id % 3 === 0, 'NOT EXISTS', '(c.score=?) IS NOT TRUE'],
  ];
  for (const [name, predicate, orangeWhere, matches, quantifier, condition] of indexed) {
    const expected = Array.from({ length: 5000 }, (_, index) => index + 1).filter(matches);
    const queryOptions = { where: predicate, select: ['id'], orderBy: [asc(parent.col('id'))], limit: 10000 };
    const compiled = own.table(parent).compileSelect(queryOptions);
    function verifyIndex(sql, parameters) {
      const plan = raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(x => x.detail);
      assert(plan.some(detail => /SEARCH .* USING COVERING INDEX bench_child_parent_score/.test(detail)), 'Missing indexed child lookup.'); return plan;
    }
    await check('raw node:sqlite + JS oracle', 'indexed ' + name, () => {
      const sql = `SELECT p.id FROM bench_parents p WHERE ${quantifier} (SELECT 1 FROM bench_children c WHERE c.parent_id=p.id AND ${condition}) ORDER BY p.id LIMIT ? OFFSET ?`;
      const actual = raw.prepare(sql).all(1, 10000, 0).map(x => x.id); assert.deepEqual(actual, expected);
      return { matchingParents: actual.length, plan: verifyIndex(sql, [1, 10000, 0]) };
    });
    await check('rowstitch', 'indexed ' + name, () => {
      const actual = own.table(parent).findMany(queryOptions).map(x => x.id); assert.deepEqual(actual, expected);
      return { matchingParents: actual.length, plan: verifyIndex(compiled.sql, compiled.parameters) };
    });
    if (reference) await check('orange-orm@5.5.1', 'indexed ' + name, async () => {
      const actual = (await reference.bench_parents.getMany({ where: orangeWhere, orderBy: 'id', limit: 10000, offset: 0, id: true })).map(x => x.id); assert.deepEqual(actual, expected);
      const query = selectCommands()[0]; assert(query, 'Expected an observed Orange SELECT.');
      return { matchingParents: actual.length, plan: verifyIndex(query.sql, query.parameters) };
    });
  }
} finally {
  try { await reference?.close(); }
  finally {
    try { own?.close(); }
    finally {
      raw.close(); DatabaseSync.prototype.prepare = originalPrepare;
      const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir());
      assert(target.startsWith(temporaryRoot + path.sep) && path.basename(target).startsWith('rowstitch-relations-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length, contractDifferences: report.contractDifferences.length };
const text = JSON.stringify(report, null, 2) + '\n';
if (options.output) fs.writeFileSync(options.output, text);
process.stdout.write(text);
if (report.summary.failed) process.exitCode = 1;
