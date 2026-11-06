import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bounded SQLite comparison on owned fictional data with pinned reference packages.
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(['--entry', '--reference-dir', '--output'].includes(key) && process.argv[index + 1] && !options[key],
    'Use --entry BUILT_INDEX --reference-dir PINNED_REFERENCE_ROOT --output NEW_REPORT');
  options[key] = resolve(process.argv[index + 1]);
}
const entry = options['--entry'] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const reference = options['--reference-dir'], output = options['--output'];
assert.ok(entry && reference && output && basename(entry) === 'index.js');
assert.equal(existsSync(output), false, 'Choose a new report path');
const manifest = directory => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(item => item.isFile() && item.name.endsWith('.js'))
  .map(item => join(item.parentPath, item.name)).sort()
  .map(file => [file.slice(directory.length + 1).replaceAll('\\', '/'), hash(readFileSync(file))]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dist = dirname(entry), before = manifest(dist);
const versions = { 'orange-orm': '5.5.1', kysely: '0.29.8', 'better-sqlite3': '12.6.2' };
for (const [name, version] of Object.entries(versions)) {
  assert.equal(JSON.parse(readFileSync(join(reference, 'node_modules', name, 'package.json'), 'utf8')).version, version);
}
const nativeBindingSha256 = hash(readFileSync(join(reference, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')));
const binaryProofPath = join(reference, 'native-verification.json');
if (existsSync(binaryProofPath)) {
  const binaryProof = JSON.parse(readFileSync(binaryProofPath, 'utf8'));
  assert.equal(process.versions.modules, binaryProof.node_abi, 'Use the Node ABI matching the verified prebuild');
  assert.equal(nativeBindingSha256, binaryProof.binary_sha256);
}
const require = createRequire(join(reference, 'package.json'));
const sdk = await import(pathToFileURL(entry).href);
const orange = (await import(pathToFileURL(require.resolve('orange-orm')).href)).default;
const { Kysely, SqliteDialect, sql } = await import(pathToFileURL(require.resolve('kysely')).href);
const BetterSQLite = require('better-sqlite3');
assert.equal(typeof sdk.column.integer().storedAs, 'function', 'Build the mapped Rowstitch candidate first');

const folder = mkdtempSync(join(tmpdir(), 'rowstitch-mapped-compare-')), files = [];
const makeFile = name => { const file = join(folder, name + '.sqlite'); files.push(file); return file; };
const report = {
  format: 'rowstitch-mapped-sqlite-comparison-v1',
  environment: { node: process.version, abi: process.versions.modules, platform: process.platform, architecture: process.arch,
    rowstitch: JSON.parse(readFileSync(join(dist, '../package.json'), 'utf8')).version,
    ...versions, nativeBindingSha256 },
  compiled: { files: Object.keys(before).length, treeSha256: hash(JSON.stringify(before)), indexSha256: before['index.js'] },
  engines: {}, fixture: { authors: 4, posts: 4, journal: 'DELETE', synchronous: 'FULL', unmodeledAuthorColumn: true },
  cases: [], boundaries: [], cleanup: { removed: false },
  limits: [
    'Each API uses a separately seeded owned database and the same handwritten expected rows. Native response fields are recorded separately from application projection.',
    'Rowstitch and Orange use their observed SQLite engines. Kysely uses the separately verified better-sqlite3 binding.',
    'Placement and identifier observations apply to the particular pinned API call and SQLite backend. No performance, cross-provider or feature-parity inference.',
  ],
};
const marker = "Fictional Casey' OR 1=1 --", privateNote = 'FICTIONAL_UNMAPPED_NOTE';
const authors = 'stored_authors', posts = 'stored_posts';
const original = [
  { id: 1, name: 'Avery', score: 10 }, { id: 2, name: 'Blair %_', score: 25 },
  { id: 3, name: marker, score: 35 }, { id: 4, name: 'Drew', score: 40 },
];
const children = [[10, 1, 'A1'], [20, 2, 'B1'], [21, 2, 'B2'], [30, 3, 'C1']];
const added = { id: 5, name: 'Elliot', score: 16 }, updated = { id: 2, name: 'Changed', score: 31 };
const qi = value => '"' + value.replaceAll('"', '""') + '"';
const names = row => Object.keys(row).sort();
const author = ({ id, name, score }) => ({ id, name, score });
const project = rows => rows.map(row => ({ name: row.name }));
const physicalId = 'row id', physicalTitle = 'select';
const weird = [ ['literal-dot', 'literal.dot', 'Dotted'], ['embedded-quote', 'embedded"quote', 'Quoted'] ];

function fixture(file) {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE stored_authors(author_pk INTEGER PRIMARY KEY,display_name TEXT NOT NULL,rank_score INTEGER NOT NULL,
        private_note TEXT NOT NULL DEFAULT '${privateNote}');
      CREATE TABLE stored_posts(post_pk INTEGER PRIMARY KEY,author_fk INTEGER NOT NULL REFERENCES stored_authors(author_pk) ON DELETE CASCADE,post_title TEXT NOT NULL);`);
    const insert = db.prepare('INSERT INTO stored_authors(author_pk,display_name,rank_score) VALUES (?,?,?)');
    for (const row of original) insert.run(row.id, row.name, row.score);
    const insertChild = db.prepare('INSERT INTO stored_posts VALUES (?,?,?)');
    for (const row of children) insertChild.run(...row);
    for (const [, table, title] of weird) {
      db.exec('CREATE TABLE ' + qi(table) + ' (' + qi(physicalId) + ' INTEGER PRIMARY KEY,' + qi(physicalTitle) + ' TEXT NOT NULL)');
      db.prepare('INSERT INTO ' + qi(table) + ' VALUES (?,?)').run(1, title);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

const orangeMapping = table => orange.map(x => ({ rows: x.table(table).map(({ column: c }) => ({
  id: c(physicalId).numeric().primary(), title: c(physicalTitle).string().notNull(),
})) }));
const orangeMap = orange.map(x => ({
  authors: x.table(authors).map(({ column: c }) => ({ id: c('author_pk').numeric().primary(), name: c('display_name').string().notNull(), score: c('rank_score').numeric().notNull() })),
  posts: x.table(posts).map(({ column: c }) => ({ id: c('post_pk').numeric().primary(), authorId: c('author_fk').numeric().notNull(), title: c('post_title').string().notNull() })),
})).map(x => ({ authors: x.authors.map(({ hasMany }) => ({ posts: hasMany(x.posts).by('authorId') })) }));

const rsAuthors = sdk.defineTable('authors', {
  id: sdk.column.integer().primaryKey().storedAs('author_pk'), name: sdk.column.text().storedAs('display_name'), score: sdk.column.integer().storedAs('rank_score'),
}, { storage: { schema: 'main', table: authors }, schemaPolicy: 'subset' });
const rsPosts = sdk.defineTable('posts', {
  id: sdk.column.integer().primaryKey().storedAs('post_pk'),
  authorId: sdk.column.integer().storedAs('author_fk').references(rsAuthors, 'id', { onDelete: 'cascade' }),
  title: sdk.column.text().storedAs('post_title'),
}, { storage: { table: posts } });
const rsWeird = weird.map(([key, table]) => [key, sdk.defineTable('rs_' + key.replace('-', '_'), {
  id: sdk.column.integer().primaryKey().storedAs(physicalId), title: sdk.column.text().storedAs(physicalTitle),
}, { storage: { schema: 'main', table } })]);

function openRowstitch(file, raw) {
  const db = sdk.openDatabase(file, { tables: [rsAuthors, rsPosts, ...rsWeird.map(([, table]) => table)] });
  const rows = db.table(rsAuthors);
  return {
    close: () => db.close(), version: raw.prepare('SELECT sqlite_version() AS version').get().version,
    filter: () => rows.findMany({ select: ['name'], where: sdk.gte(rsAuthors.col('score'), 20), orderBy: [sdk.asc(rsAuthors.col('id'))] }),
    literal: () => rows.findMany({ where: sdk.eq(rsAuthors.col('name'), marker) }),
    graph: () => rows.findMany({ select: ['name'], where: sdk.gte(rsAuthors.col('score'), 20), orderBy: [sdk.asc(rsAuthors.col('id'))], include: {
      posts: sdk.hasMany(rsPosts, { localKey: rsAuthors.col('id'), foreignKey: rsPosts.col('authorId'), select: ['title'], orderBy: [sdk.asc(rsPosts.col('id'))] }),
    } }),
    insert: row => rows.insert(row), update: row => rows.update({ name: row.name, score: row.score }, { where: sdk.eq(rsAuthors.col('id'), row.id), maxRows: 1 })[0],
    remove: id => rows.delete({ where: sdk.eq(rsAuthors.col('id'), id), maxRows: 1 }),
    placement: () => rows.findMany({ select: ['name'], where: sdk.eq(rsAuthors.col('id'), 3) }),
    boundaries: rsWeird.map(([key, table]) => [key, () => db.table(table).findFirst({ where: sdk.eq(table.col('id'), 1) })]),
    plan: () => db.planSchema().map(({ table, action }) => ({ table, action })),
  };
}

async function openOrange(file) {
  const db = orangeMap.sqlite(file, { size: 1, min: 1 });
  let version;
  try { version = String((await db.query('SELECT sqlite_version() AS version'))[0].version); await db.query('PRAGMA foreign_keys=ON'); }
  catch (error) { await db.close(); throw error; }
  const withTable = async (table, callback) => {
    const other = orangeMapping(table).sqlite(file, { size: 1, min: 1 });
    try { return await callback(other.rows); } finally { await other.close(); }
  };
  return {
    close: () => db.close(), version,
    filter: () => db.authors.getMany({ name: true, where: x => x.score.greaterThanOrEqual(20), orderBy: 'id' }),
    literal: () => db.authors.getMany({ where: x => x.name.eq(marker) }),
    graph: () => db.authors.getMany({ name: true, where: x => x.score.greaterThanOrEqual(20), orderBy: 'id', posts: { title: true, orderBy: 'id' } }),
    insert: row => db.authors.insert(row),
    async update(row) { const record = await db.authors.getById(row.id); record.name = row.name; record.score = row.score; await record.saveChanges(); return record; },
    async remove(id) { await (await db.authors.getById(id)).delete(); },
    placement: () => {
      const map = orange.map(x => ({ authors: x.table('main.' + authors).map(({ column: c }) => ({ id: c('author_pk').numeric().primary(), name: c('display_name').string() })) }));
      const placed = map.sqlite(file, { size: 1, min: 1 });
      return placed.authors.getMany({ name: true, where: x => x.id.eq(3) }).finally(() => placed.close());
    },
    boundaries: weird.map(([key, table]) => [key, () => withTable(table, rows => rows.getById(1))]),
  };
}

function openKysely(file) {
  const driver = new BetterSQLite(file);
  driver.pragma('foreign_keys = ON');
  const version = driver.prepare('SELECT sqlite_version() AS version').get().version;
  const db = new Kysely({ dialect: new SqliteDialect({ database: driver }) });
  const select = ['author_pk as id', 'display_name as name', 'rank_score as score'];
  return {
    close: () => db.destroy(), version,
    filter: () => db.selectFrom(authors).select('display_name as name').where('rank_score', '>=', 20).orderBy('author_pk').execute(),
    literal: () => db.selectFrom(authors).select(select).where('display_name', '=', marker).execute(),
    async graph() {
      const joined = await db.selectFrom(authors + ' as a').leftJoin(posts + ' as p', 'p.author_fk', 'a.author_pk')
        .select(['a.author_pk as rootKey', 'a.display_name as name', 'p.post_pk as childKey', 'p.post_title as title'])
        .where('a.rank_score', '>=', 20).orderBy('a.author_pk').orderBy('p.post_pk').execute();
      const grouped = new Map();
      for (const row of joined) {
        if (!grouped.has(row.rootKey)) grouped.set(row.rootKey, { name: row.name, posts: [] });
        if (row.childKey !== null) grouped.get(row.rootKey).posts.push({ title: row.title });
      }
      return [...grouped.values()];
    },
    insert: row => db.insertInto(authors).values({ author_pk: row.id, display_name: row.name, rank_score: row.score }).returning(select).executeTakeFirstOrThrow(),
    update: row => db.updateTable(authors).set({ display_name: row.name, rank_score: row.score }).where('author_pk', '=', row.id).returning(select).executeTakeFirstOrThrow(),
    remove: id => db.deleteFrom(authors).where('author_pk', '=', id).executeTakeFirstOrThrow(),
    placement: () => db.withSchema('main').selectFrom(authors).select('display_name as name').where('author_pk', '=', 3).execute(),
    boundaries: weird.map(([key, table]) => [key, () => db.selectFrom(sql.id('main', table).as('sample'))
      .select([sql.id('sample', physicalId).as('id'), sql.id('sample', physicalTitle).as('title')]).where(sql.id('sample', physicalId), '=', 1).executeTakeFirstOrThrow()]),
  };
}

const expectedFilter = [{ name: 'Blair %_' }, { name: marker }, { name: 'Drew' }];
const expectedGraph = [
  { name: 'Blair %_', posts: [{ title: 'B1' }, { title: 'B2' }] }, { name: marker, posts: [{ title: 'C1' }] }, { name: 'Drew', posts: [] },
];
const concise = error => String(error?.message ?? error).replaceAll(folder, '<fixture>').slice(0, 250);
async function check(tool, name, fn) {
  try { report.cases.push({ tool, name, status: 'pass', ...await fn() }); }
  catch (error) { report.cases.push({ tool, name, status: 'fail', code: error?.code, error: concise(error) }); }
}
async function observe(tool, name, fn, expected, required = false) {
  const observation = { tool, name };
  try {
    observation.actual = await fn();
    try { assert.deepEqual(observation.actual, expected); observation.status = 'matched'; }
    catch { observation.status = 'different-result'; }
  } catch (error) { observation.status = 'refused'; observation.code = error?.code; observation.error = concise(error); }
  report.boundaries.push(observation);
  if (required && observation.status !== 'matched') report.cases.push({ tool, name, status: 'fail', error: 'Expected boundary recipe to work' });
}

for (const [tool, factory] of [['rowstitch', openRowstitch], ['orange-orm', openOrange], ['kysely', openKysely]]) {
  let raw, api;
  try {
    const file = makeFile(tool);
    raw = fixture(file);
    api = await factory(file, raw);
    report.engines[tool] = api.version;
    const stored = id => raw.prepare('SELECT author_pk AS id,display_name AS name,rank_score AS score,private_note FROM stored_authors WHERE author_pk=?').get(id);
    await check(tool, 'logical filter and projection', async () => {
      const rows = await api.filter();
      assert.deepEqual(project(rows), expectedFilter);
      const keys = rows.map(names);
      if (tool !== 'orange-orm') assert.ok(keys.every(fields => fields.join(',') === 'name'));
      assert.equal(JSON.stringify(rows).includes(privateNote), false);
      return { rows: project(rows), returnedKeys: keys };
    });
    await check(tool, 'bound text and exact lookup', async () => {
      const rows = await api.literal();
      assert.deepEqual(rows.map(author), [original[2]]);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM stored_authors').get().n, 4);
      return { rows: rows.map(author), returnedKeys: rows.map(names) };
    });
    await check(tool, 'one selected relation with an empty parent', async () => {
      const rows = await api.graph();
      const mapped = rows.map(row => ({ name: row.name, posts: row.posts.map(post => ({ title: post.title })) }));
      assert.deepEqual(mapped, expectedGraph);
      assert.equal(JSON.stringify(rows).includes(privateNote), false);
      return { rows: mapped, returnedKeys: rows.map(row => ({ root: names(row), children: row.posts.map(names) })),
        ...(tool === 'kysely' ? { recipe: 'Explicit LEFT JOIN, logical SELECT aliases and application grouping by root key' } : {}) };
    });
    await check(tool, 'mapped insert with an unmapped server default', async () => {
      const inserted = await api.insert({ ...added });
      assert.deepEqual(author(inserted), added);
      const actual = stored(added.id);
      assert.deepEqual(author(actual), added);
      assert.equal(actual.private_note, privateNote);
      assert.equal(JSON.stringify(inserted).includes(privateNote), false);
      return { row: author(inserted), returnedKeys: names(inserted), physicalDefaultPreserved: true };
    });
    await check(tool, 'mapped filtered update', async () => {
      const changed = await api.update({ ...updated });
      assert.deepEqual(author(changed), updated);
      assert.deepEqual(author(stored(updated.id)), updated);
      assert.deepEqual(author(stored(3)), original[2]);
      assert.equal(stored(updated.id).private_note, privateNote);
      return { row: author(changed), returnedKeys: names(changed) };
    });
    await check(tool, 'mapped delete and actual FK cascade', async () => {
      await api.remove(1);
      assert.equal(stored(1), undefined);
      assert.deepEqual(raw.prepare('SELECT post_pk AS id FROM stored_posts ORDER BY post_pk').all().map(row => row.id), [20, 21, 30]);
      assert.deepEqual(raw.prepare('SELECT author_pk AS id FROM stored_authors ORDER BY author_pk').all().map(row => row.id), [2, 3, 4, 5]);
      return { remainingAuthorIds: [2, 3, 4, 5], remainingPostIds: [20, 21, 30] };
    });
    await observe(tool, 'explicit main namespace API attempt', async () => project(await api.placement()), [{ name: marker }], tool !== 'orange-orm');
    for (const [name, get] of api.boundaries) {
      const expectedTitle = weird.find(([key]) => key === name)[2];
      await observe(tool, name, async () => { const row = await get(); return { id: row.id, title: row.title }; }, { id: 1, title: expectedTitle }, tool !== 'orange-orm');
    }
    if (tool === 'rowstitch') {
      await check(tool, 'existing subset planning and identifier refusal', async () => {
        assert.deepEqual(api.plan(), [{ table: 'posts', action: 'create-index' }]);
        assert.throws(() => sdk.defineTable('bad logical key', { id: sdk.column.integer().primaryKey() }), { code: 'SCHEMA' });
        assert.throws(() => sdk.column.text().storedAs('invalid\0physical'), { code: 'SCHEMA' });
        return { actions: api.plan(), invalidLogicalName: 'SCHEMA', invalidPhysicalNul: 'SCHEMA' };
      });
    }
  } catch (error) { report.cases.push({ tool, name: 'fixture or setup', status: 'fail', error: concise(error) }); }
  finally {
    try { await api?.close(); } catch (error) { report.cases.push({ tool, name: 'close', status: 'fail', error: concise(error) }); }
    try { raw?.close(); } catch (error) { report.cases.push({ tool, name: 'raw fixture close', status: 'fail', error: concise(error) }); }
  }
}

try {
  for (const file of files) for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmdirSync(folder);
  report.cleanup.removed = true;
} catch (error) { report.cases.push({ tool: 'fixture', name: 'cleanup', status: 'fail', error: concise(error) }); }
report.compiled.unchanged = JSON.stringify(before) === JSON.stringify(manifest(dist));
if (!report.compiled.unchanged) report.cases.push({ tool: 'fixture', name: 'compiled input stability', status: 'fail' });
report.summary = { passed: report.cases.filter(row => row.status === 'pass').length, failed: report.cases.filter(row => row.status === 'fail').length,
  boundaryObservations: report.boundaries.length };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(report.summary) + '\n');
if (report.summary.failed) process.exitCode = 1;
