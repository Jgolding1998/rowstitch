// A correctness/query-count comparison, not a cross-engine speed contest.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, eq, asc, hasMany, belongsTo } from '../dist/index.js';

const args = process.argv.slice(2);
let referenceDir, output;
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1] || !['--reference-dir', '--output'].includes(args[i])) throw new Error('Usage: node benchmarks/compare.mjs [--reference-dir DIRECTORY] [--output FILE]');
  if (args[i] === '--reference-dir') referenceDir = path.resolve(args[i + 1]);
  else output = path.resolve(args[i + 1]);
}
const ownPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const parentCount = 40, childrenPerParent = 3;
const authors = defineTable('authors', {
  id: column.integer().primaryKey(), name: column.text(),
  version: column.integer().default(0), preferences: column.json().nullable(),
}, { version: 'version' });
const posts = defineTable('posts', {
  id: column.integer().primaryKey(),
  authorId: column.integer().references(authors, 'id'), title: column.text(),
});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-comparison-'));
const report = {
  format: 'rowstitch-comparison', version: 1,
  environment: { node: process.version, platform: process.platform, architecture: process.arch, rowstitch: ownPackage.version, nodeSQLite: process.versions.sqlite },
  fixture: { parentsWithChildren: parentCount, emptyParents: 1, childrenPerParent, journalMode: 'DELETE', synchronous: 'FULL' },
  cases: [],
  limitations: [
    'Fixed SQLite correctness and query-count cases only; no latency, throughput or universal-superiority claim.',
    'SQLite versions are queried from each backend. Orange selects its SQLite backend by runtime; Kysely uses the pinned native driver here.',
    'Kysely and raw SQLite use explicit application batching and version predicates; they are not Active Record relation mappers.',
    'Orange supports many more databases/runtimes than Rowstitch. Passing this fixture is not feature parity or a complete security audit.',
  ],
};

function seed(file) {
  const schema = openDatabase(file, { tables: [authors, posts] });
  schema.ensureSchema(); schema.close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN');
  try {
    const a = raw.prepare('INSERT INTO authors(id,name,version,preferences) VALUES(?,?,0,?)');
    const p = raw.prepare('INSERT INTO posts(id,authorId,title) VALUES(?,?,?)');
    for (let id = 1; id <= parentCount + 1; id++) {
      a.run(id, `SampleAuthor${id}`, JSON.stringify({ theme: 'light', tags: ['sample'] }));
      if (id > parentCount) continue;
      for (let child = 1; child <= childrenPerParent; child++) p.run(id * 100 + child, id, `SamplePost${id}-${child}`);
    }
    raw.exec('COMMIT');
  } catch (error) { raw.exec('ROLLBACK'); raw.close(); throw error; }
  return raw;
}

async function check(tool, name, fn) {
  try { report.cases.push({ tool, name, status: 'pass', ...await fn() }); }
  catch (error) { report.cases.push({ tool, name, status: 'fail', error: error.message }); }
}

function verifyGraph(rows, limit) {
  assert.equal(rows.length, parentCount + 1);
  for (let id = 1; id <= parentCount; id++) {
    assert.equal(rows[id - 1].id, id);
    assert.deepEqual(rows[id - 1].posts.map(p => p.id), Array.from({ length: limit ?? childrenPerParent }, (_, n) => id * 100 + n + 1));
  }
  assert.equal(rows[parentCount].posts.length, 0);
}

function verifyReferences(rows) {
  assert.equal(rows.length, parentCount * childrenPerParent);
  for (const row of rows) {
    assert.ok(row.author);
    assert.equal(row.author.id, row.authorId);
    assert.equal(row.author.name, `SampleAuthor${row.authorId}`);
  }
}

function recentSelects(db, before) {
  const ids = new Set(before.map(q => q.id));
  return db.exportTrace().queries.filter(q => !ids.has(q.id) && q.operation === 'select').length;
}

async function runRowstitch() {
  const file = path.join(temporary, 'rowstitch.db');
  const raw = seed(file);
  const db = openDatabase(file, { tables: [authors, posts], maxTraceEntries: 1000 });
  const second = openDatabase(file, { tables: [authors, posts] });
  const repo = db.table(authors);
  try {
    await check('rowstitch', 'Bound injection text returns no rows', () => assert.equal(repo.findMany({ where: eq(authors.col('name'), "' OR 1=1 --") }).length, 0));
    for (const limit of [undefined, 2]) await check('rowstitch', limit ? 'Per-parent child limit' : 'Batched graph with empty parent', () => {
      const before = db.exportTrace().queries;
      const rows = repo.findMany({ orderBy: [asc(authors.col('id'))], include: { posts: hasMany(posts, {
        localKey: authors.col('id'), foreignKey: posts.col('authorId'), orderBy: [asc(posts.col('id'))], ...(limit ? { limit } : {}),
      }) } });
      verifyGraph(rows, limit);
      const selectQueries = recentSelects(db, before);
      assert.ok(selectQueries <= 3, `Unexpected SELECT count ${selectQueries}`);
      return { parentRows: rows.length, returnedChildRows: rows.reduce((n, r) => n + r.posts.length, 0), selectQueries };
    });
    await check('rowstitch', 'Posts include their referenced author', () => {
      const before = db.exportTrace().queries;
      const rows = db.table(posts).findMany({ orderBy: [asc(posts.col('id'))], include: {
        author: belongsTo(authors, { localKey: posts.col('authorId'), foreignKey: authors.col('id') }),
      } });
      verifyReferences(rows);
      return { postRows: rows.length, selectQueries: recentSelects(db, before), note: 'Current implementation batches singular relations separately from the root read.' };
    });
    await check('rowstitch', 'Selected names exclude unrelated application fields', () => {
      const rows = repo.findMany({ select: ['name'], orderBy: [asc(authors.col('id'))] });
      assert.equal(rows.length, parentCount + 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['name']);
      return { returnedFields: Object.keys(rows[0]).sort(), note: 'Rowstitch returns only requested fields; join keys stay internal when needed.' };
    });
    await check('rowstitch', 'Real insert rolls back after transaction failure', () => {
      assert.throws(() => db.transaction(tx => { tx.table(authors).insert({ id: 500, name: 'RollbackSample' }); throw new Error('synthetic rollback'); }), /synthetic rollback/);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM authors WHERE id=500').get().n, 0);
    });
    await check('rowstitch', 'Independent stale update preserves winning write', () => {
      const a = repo.findFirst({ where: eq(authors.col('id'), 1) });
      const b = second.table(authors).findFirst({ where: eq(authors.col('id'), 1) });
      repo.updateVersion({ id: a.id }, a.version, { name: 'SampleWinner' });
      assert.throws(() => second.table(authors).updateVersion({ id: b.id }, b.version, { name: 'SampleLoser' }));
      assert.equal(raw.prepare('SELECT name FROM authors WHERE id=1').get().name, 'SampleWinner');
    });
    await check('rowstitch', 'Real JSON update tolerates reordered equivalent stored keys', () => {
      const row = repo.findFirst({ where: eq(authors.col('id'), 2) });
      raw.prepare('UPDATE authors SET preferences=? WHERE id=2').run(JSON.stringify({ tags: ['sample'], theme: 'light' }));
      const before = new Set(db.exportTrace().queries.map(q => q.id));
      repo.updateVersion({ id: 2 }, row.version, { preferences: { ...row.preferences, theme: 'dark' } });
      assert.equal(JSON.parse(raw.prepare('SELECT preferences FROM authors WHERE id=2').get().preferences).theme, 'dark');
      assert.ok(db.exportTrace().queries.some(q => !before.has(q.id) && q.operation === 'update'));
    });
    await check('rowstitch', 'Schema introspection includes both tables', () => {
      const text = JSON.stringify(db.inspectSchema()); assert.ok(text.includes('authors') && text.includes('posts'));
    });
  } finally { second.close(); db.close(); raw.close(); }
}

async function runRaw() {
  const db = seed(path.join(temporary, 'raw.db'));
  try {
    await check('raw node:sqlite', 'Bound injection text returns no rows', () => assert.equal(db.prepare('SELECT id FROM authors WHERE name=?').all("' OR 1=1 --").length, 0));
    for (const limit of [undefined, 2]) await check('raw node:sqlite', limit ? 'Per-parent child limit' : 'Batched graph with empty parent', () => {
      const parents = db.prepare('SELECT * FROM authors ORDER BY id').all();
      const ids = parents.map(a => a.id), binds = ids.map(() => '?').join(',');
      const sql = limit
        ? `SELECT id,authorId,title FROM (SELECT *,row_number() OVER(PARTITION BY authorId ORDER BY id) AS rn FROM posts WHERE authorId IN (${binds})) WHERE rn<=? ORDER BY id`
        : `SELECT * FROM posts WHERE authorId IN (${binds}) ORDER BY id`;
      const children = db.prepare(sql).all(...ids, ...(limit ? [limit] : []));
      const rows = parents.map(a => ({ ...a, posts: children.filter(p => p.authorId === a.id) }));
      verifyGraph(rows, limit);
      return { parentRows: rows.length, returnedChildRows: children.length, selectQueries: 2, note: 'Explicit application SQL and grouping recipe.' };
    });
    await check('raw node:sqlite', 'Posts include their referenced author', () => {
      const rows = db.prepare('SELECT p.id,p.authorId,p.title,a.id AS author_id,a.name AS author_name FROM posts p LEFT JOIN authors a ON a.id=p.authorId ORDER BY p.id').all()
        .map(row => ({ id: row.id, authorId: row.authorId, title: row.title, author: row.author_id === null ? null : { id: row.author_id, name: row.author_name } }));
      verifyReferences(rows);
      return { postRows: rows.length, selectQueries: 1, note: 'Explicit application LEFT JOIN recipe.' };
    });
    await check('raw node:sqlite', 'Selected names exclude unrelated application fields', () => {
      const rows = db.prepare('SELECT name FROM authors ORDER BY id').all();
      assert.equal(rows.length, parentCount + 1); assert.deepEqual(Object.keys(rows[0]).sort(), ['name']);
      return { returnedFields: Object.keys(rows[0]).sort() };
    });
    await check('raw node:sqlite', 'Real insert rolls back after transaction failure', () => {
      db.exec('BEGIN');
      try { db.prepare('INSERT INTO authors(id,name,version) VALUES(500,?,0)').run('RollbackSample'); throw new Error('synthetic rollback'); }
      catch { db.exec('ROLLBACK'); }
      assert.equal(db.prepare('SELECT count(*) AS n FROM authors WHERE id=500').get().n, 0);
    });
  } finally { db.close(); }
}

function loadReference(name, expected) {
  const require = createRequire(path.join(referenceDir, 'package.json'));
  const entry = require.resolve(name);
  let directory = path.dirname(entry), pkg;
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) { const candidate = JSON.parse(fs.readFileSync(file, 'utf8')); if (candidate.name === name) { pkg = candidate; break; } }
    directory = path.dirname(directory);
  }
  assert.equal(pkg?.version, expected, `Reference ${name} must be exactly ${expected}`);
  return import(pathToFileURL(entry).href);
}

async function runReferences() {
  const [{ default: orange }, { default: Better }, { Kysely, SqliteDialect, sql }] = await Promise.all([
    loadReference('orange-orm', '5.5.1'), loadReference('better-sqlite3', '12.6.2'), loadReference('kysely', '0.29.8'),
  ]);
  const versionDb = new Better(':memory:');
  try { report.environment.kyselySQLite = versionDb.prepare('SELECT sqlite_version() AS v').get().v; }
  finally { versionDb.close(); }
  Object.assign(report.environment, { orange: '5.5.1', kysely: '0.29.8', betterSqlite3: '12.6.2' });
  const map = orange.map(x => ({
    authors: x.table('authors').map(({ column: c }) => ({ id: c('id').numeric().primary(), name: c('name').string().notNull(), version: c('version').numeric().notNull(), preferences: c('preferences').json() })),
    posts: x.table('posts').map(({ column: c }) => ({ id: c('id').numeric().primary(), authorId: c('authorId').numeric(), title: c('title').string() })),
  })).map(x => ({
    authors: x.authors.map(({ hasMany: many }) => ({ posts: many(x.posts).by('authorId') })),
    posts: x.posts.map(({ references }) => ({ author: references(x.authors).by('authorId') })),
  }));
  const file = path.join(temporary, 'orange.db'), raw = seed(file);
  const db = map.sqlite(file, { size: 1, min: 1 }), second = map.sqlite(file, { size: 1, min: 1 });
  let selects = 0, updates = 0;
  const listener = e => { if (/^\s*select\b/i.test(e.sql)) selects++; if (/^\s*update\b/i.test(e.sql)) updates++; };
  orange.on('query', listener);
  try {
    report.environment.orangeSQLite = String((await db.query('SELECT sqlite_version() AS version'))[0].version);
    report.environment.orangeEntry = 'Published npm CommonJS source export, dynamically imported after explicit resolution';
    await db.query('PRAGMA foreign_keys=ON'); await second.query('PRAGMA foreign_keys=ON');
    await check('orange-orm@5.5.1', 'Bound injection text returns no rows', async () => assert.equal((await db.authors.getMany({ where: x => x.name.eq("' OR 1=1 --") })).length, 0));
    for (const limit of [undefined, 2]) await check('orange-orm@5.5.1', limit ? 'Per-parent child limit' : 'Batched graph with empty parent', async () => {
      selects = 0;
      const rows = await db.authors.getMany({ orderBy: 'id', posts: { orderBy: 'id', ...(limit ? { limit } : {}) } });
      verifyGraph(rows, limit); assert.ok(selects <= 3, `Unexpected SELECT count ${selects}`);
      return { parentRows: rows.length, returnedChildRows: rows.reduce((n, r) => n + r.posts.length, 0), selectQueries: selects };
    });
    await check('orange-orm@5.5.1', 'Posts include their referenced author', async () => {
      selects = 0;
      const rows = await db.posts.getMany({ orderBy: 'id', author: true });
      verifyReferences(rows);
      return { postRows: rows.length, selectQueries: selects };
    });
    await check('orange-orm@5.5.1', 'Selected names exclude unrelated application fields', async () => {
      const rows = await db.authors.getMany({ name: true, orderBy: 'id' });
      assert.equal(rows.length, parentCount + 1); assert.equal(typeof rows[0].name, 'string');
      assert.ok(!Object.hasOwn(rows[0], 'preferences') && !Object.hasOwn(rows[0], 'version'));
      return { returnedFields: Object.keys(rows[0]).sort(), note: 'Orange retains primary keys for Active Record identity. This is its contract, not a projection defect.' };
    });
    await check('orange-orm@5.5.1', 'Real insert rolls back after transaction failure', async () => {
      await assert.rejects(db.transaction(async tx => { await tx.authors.insert({ id: 500, name: 'RollbackSample', version: 0 }); throw new Error('synthetic rollback'); }), /synthetic rollback/);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM authors WHERE id=500').get().n, 0);
    });
    await check('orange-orm@5.5.1', 'Independent stale update preserves winning write', async () => {
      const a = await db.authors.getById(1), b = await second.authors.getById(1);
      a.name = 'SampleWinner'; await a.saveChanges(); b.name = 'SampleLoser'; await assert.rejects(b.saveChanges());
      assert.equal(raw.prepare('SELECT name FROM authors WHERE id=1').get().name, 'SampleWinner');
    });
    await check('orange-orm@5.5.1', 'Real JSON update tolerates reordered equivalent stored keys', async () => {
      const row = await db.authors.getById(2);
      raw.prepare('UPDATE authors SET preferences=? WHERE id=2').run(JSON.stringify({ tags: ['sample'], theme: 'light' }));
      updates = 0; row.preferences.theme = 'dark'; await row.saveChanges();
      assert.equal(JSON.parse(raw.prepare('SELECT preferences FROM authors WHERE id=2').get().preferences).theme, 'dark'); assert.ok(updates > 0);
    });
  } finally { orange.off('query', listener); await db.close(); await second.close(); raw.close(); }

  const kfile = path.join(temporary, 'kysely.db'), kraw = seed(kfile);
  const native = new Better(kfile); native.pragma('foreign_keys=ON');
  let kselects = 0;
  const kdb = new Kysely({ dialect: new SqliteDialect({ database: native }), log(e) { if (e.level === 'query' && /^\s*select\b/i.test(e.query.sql)) kselects++; } });
  try {
    await check('kysely@0.29.8', 'Bound injection text returns no rows', async () => assert.equal((await kdb.selectFrom('authors').selectAll().where('name', '=', "' OR 1=1 --").execute()).length, 0));
    for (const limit of [undefined, 2]) await check('kysely@0.29.8', limit ? 'Per-parent child limit' : 'Batched graph with empty parent', async () => {
      kselects = 0;
      const parents = await kdb.selectFrom('authors').selectAll().orderBy('id').execute();
      let q = kdb.selectFrom('posts').selectAll().where('authorId', 'in', parents.map(a => a.id));
      const children = limit
        ? await kdb.selectFrom(q.select(sql`row_number() over(partition by "authorId" order by "id")`.as('rn')).as('ranked')).select(['id', 'authorId', 'title']).where('rn', '<=', limit).orderBy('id').execute()
        : await q.orderBy('id').execute();
      const rows = parents.map(a => ({ ...a, posts: children.filter(p => p.authorId === a.id) }));
      verifyGraph(rows, limit); assert.equal(kselects, 2);
      return { parentRows: rows.length, returnedChildRows: children.length, selectQueries: kselects, note: 'Explicit application batching/window recipe.' };
    });
    await check('kysely@0.29.8', 'Posts include their referenced author', async () => {
      kselects = 0;
      const fetched = await kdb.selectFrom('posts as p').leftJoin('authors as a', 'a.id', 'p.authorId')
        .select(['p.id', 'p.authorId', 'p.title', 'a.id as author_id', 'a.name as author_name']).orderBy('p.id').execute();
      const rows = fetched.map(row => ({ id: row.id, authorId: row.authorId, title: row.title, author: row.author_id === null ? null : { id: row.author_id, name: row.author_name } }));
      verifyReferences(rows); assert.equal(kselects, 1);
      return { postRows: rows.length, selectQueries: kselects, note: 'Explicit application LEFT JOIN recipe.' };
    });
    await check('kysely@0.29.8', 'Selected names exclude unrelated application fields', async () => {
      const rows = await kdb.selectFrom('authors').select('name').orderBy('id').execute();
      assert.equal(rows.length, parentCount + 1); assert.deepEqual(Object.keys(rows[0]).sort(), ['name']);
      return { returnedFields: Object.keys(rows[0]).sort() };
    });
    await check('kysely@0.29.8', 'Real insert rolls back after transaction failure', async () => {
      await assert.rejects(kdb.transaction().execute(async tx => { await tx.insertInto('authors').values({ id: 500, name: 'RollbackSample', version: 0 }).execute(); throw new Error('synthetic rollback'); }), /synthetic rollback/);
      assert.equal(kraw.prepare('SELECT count(*) AS n FROM authors WHERE id=500').get().n, 0);
    });
    await check('kysely@0.29.8', 'Independent stale update preserves winning write', async () => {
      const a = await kdb.updateTable('authors').set({ name: 'SampleWinner', version: 1 }).where('id', '=', 1).where('version', '=', 0).executeTakeFirst();
      const b = await kdb.updateTable('authors').set({ name: 'SampleLoser', version: 1 }).where('id', '=', 1).where('version', '=', 0).executeTakeFirst();
      assert.equal(a.numUpdatedRows, 1n); assert.equal(b.numUpdatedRows, 0n); assert.equal(kraw.prepare('SELECT name FROM authors WHERE id=1').get().name, 'SampleWinner');
      return { note: 'Explicit application version predicate and affected-row check.' };
    });
    await check('kysely@0.29.8', 'Schema introspection includes both tables', async () => assert.deepEqual((await kdb.introspection.getTables()).map(t => t.name).sort(), ['authors', 'posts']));
  } finally { await kdb.destroy(); kraw.close(); }
}

try {
  await runRowstitch(); await runRaw();
  if (referenceDir) await runReferences();
  else report.limitations.push('External references were not loaded. Pass --reference-dir to compare the pinned released packages.');
  report.summary = { passed: report.cases.filter(c => c.status === 'pass').length, failed: report.cases.filter(c => c.status === 'fail').length };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(output, text);
  process.stdout.write(text);
  if (report.summary.failed) process.exitCode = 1;
} finally {
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rowstitch-comparison-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
