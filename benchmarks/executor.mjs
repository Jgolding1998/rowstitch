// Public SDK regression comparison for the internal driver refactor, not a speed benchmark.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/index.js';

let baselineDir, output;
for (let i = 2; i < process.argv.length; i += 2) {
  const value = process.argv[i + 1];
  if (!value || !['--baseline-dir', '--output'].includes(process.argv[i])) throw new Error('Usage: node benchmarks/executor.mjs [--baseline-dir ROWSTITCH_080_PACKAGE] [--output FILE]');
  if (process.argv[i] === '--baseline-dir') baselineDir = resolve(value); else output = resolve(value);
}
const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { bigint: v.toString() } : v));
const failure = fn => { try { fn(); } catch (error) { return { code: error.code, message: error.message }; } throw new Error('Expected the operation to fail'); };

function exercise(api) {
  const { column, defineTable, openDatabase, eq, gt, asc, agg, hasMany, countRelated } = api;
  const owners = defineTable('driver_owners', { id: column.integer().primaryKey(), name: column.text(), region: column.text().nullable(), version: column.integer().default(0), settings: column.json().nullable() }, { version: 'version' });
  const items = defineTable('driver_items', { id: column.integer().primaryKey(), ownerId: column.integer().references(owners, 'id'), amount: column.bigint(), label: column.text() });
  const tables = [owners, items], relation = hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId') });
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-executor-comparison-')), file = join(directory, 'fixture.sqlite');
  let db, ro, original;
  const observations = [];
  const record = (name, value) => { observations.push({ name, value: plain(value) }); };
  try {
    db = openDatabase(file, { tables, traceValues: false, maxTraceEntries: 1000 });
    db.ensureSchema(); record('schema plan after creation', db.planSchema());
    assert.deepEqual(db.planSchema(), []);
    const before = db.exportTrace().queries.length;
    record('metadata is untraced', db.inspectSchema()); assert.equal(db.exportTrace().queries.length, before);
    record('insert defaults and JSON', db.table(owners).insertMany([{ id: 1, name: 'Ada', region: 'north', settings: { mode: 'demo' } }, { id: 2, name: 'Bo', region: 'north' }, { id: 3, name: 'Cy', region: null }]));
    const MAX = 2n ** 63n - 1n, marker = "SYNTHETIC_' OR 1=1 --\0bound";
    db.table(items).insertMany([{ id: 1, ownerId: 1, amount: MAX, label: marker }, { id: 2, ownerId: 1, amount: MAX, label: 'two' }, { id: 3, ownerId: 2, amount: -7n, label: 'three' }]);
    record('bound sentinel is exact', db.table(items).findFirst({ where: eq(items.col('label'), marker) }));
    assert.equal(db.table(items).findFirst({ where: eq(items.col('label'), marker) }).label, marker);
    const projection = { select: ['name'], include: { items: hasMany(items, { localKey: owners.col('id'), foreignKey: items.col('ownerId'), select: ['label'], orderBy: [asc(items.col('id'))], limit: 1 }) }, orderBy: [asc(owners.col('id'))] };
    record('batched projected relations', db.table(owners).findMany(projection));
    record('compiled values and SQL', db.table(items).compileSelect({ select: ['label'], where: eq(items.col('label'), marker), orderBy: [asc(items.col('id'))] }));
    record('filtered counts', db.table(owners).findMany({ select: ['name'], where: countRelated(relation, '>=', 2) }));
    const totals = { owners: agg.count(), items: agg.related(relation, agg.count()), total: agg.related(relation, agg.sum(items.col('amount'))) };
    const total = db.table(owners).aggregate({ select: totals });
    assert.deepEqual(total, { owners: 3, items: 3, total: 2n * MAX - 7n }); record('exact related root totals', total);
    record('related grouping and aliases', db.table(owners).groupBy({ by: ['region'], select: totals, orderBy: [{ field: 'total', direction: 'desc' }] }));
    record('unsafe write rejected', failure(() => db.table(owners).update({ name: 'wrong' }, { where: gt(owners.col('id'), 0), maxRows: 1 })));
    assert.deepEqual(db.table(owners).findMany({ select: ['name'] }).map(r => r.name), ['Ada', 'Bo', 'Cy']);
    record('guarded write result', db.table(owners).update({ name: 'Ada changed' }, { where: eq(owners.col('id'), 1), maxRows: 1 }));
    assert.equal(db.table(owners).findFirst({ where: eq(owners.col('id'), 1) }).version, 1);
    record('version update', db.table(owners).updateVersion({ id: 1 }, 1, { name: 'Ada versioned' }));
    record('stale version error', failure(() => db.table(owners).updateVersion({ id: 1 }, 1, { name: 'bad' })));
    db.transaction(tx => {
      tx.table(owners).update({ name: 'outer' }, { where: eq(owners.col('id'), 2) });
      assert.throws(() => tx.transaction(child => { child.table(owners).update({ name: 'inner' }, { where: eq(owners.col('id'), 2) }); throw new Error('synthetic child rollback'); }));
    });
    record('nested rollback preserves parent', db.table(owners).findFirst({ where: eq(owners.col('id'), 2) }));
    assert.equal(db.table(owners).findFirst({ where: eq(owners.col('id'), 2) }).name, 'outer');
    record('root rollback', failure(() => db.transaction(tx => { tx.table(owners).delete({ where: eq(owners.col('id'), 3) }); throw new api.RowstitchError('SYNTHETIC_CALLBACK', 'Synthetic rollback'); })));
    record('sync API rejects async callbacks', failure(() => db.transaction(async () => 1)));
    let escaped; db.transaction(tx => { escaped = tx.table(owners); });
    record('escaped handle is rejected', failure(() => escaped.count()));
    assert.ok(!JSON.stringify(db.exportTrace()).includes(marker));
    // Compare ordering, SQL, parameters, errors, row counts and transaction IDs. Exclude only clock measurements.
    record('trace preserves all non-clock fields', db.exportTrace().queries.map(({ durationMs, ...entry }) => entry));
    db.close();
    record('closed root is rejected', failure(() => db.table(owners).count()));
    ro = openDatabase(file, { tables, readOnly: true });
    record('durable rows after reopen', ro.table(owners).findMany());
    assert.equal(ro.table(owners).count(), 3);
    record('read-only writes are rejected', failure(() => ro.table(owners).insert({ id: 4, name: 'bad' })));
    record('read-only transaction result', ro.transaction(tx => tx.table(items).count()));
  } catch (error) { original = error; }
  const cleanupErrors = [];
  for (const handle of [ro, db]) { try { handle?.close(); } catch (error) { cleanupErrors.push(error); } }
  for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(file + suffix); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); } }
  try { rmdirSync(directory); } catch (error) { cleanupErrors.push(error); }
  if (original) throw original;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed');
  return observations;
}

const actual = exercise(current);
const report = { format: 'rowstitch-executor-comparison', version: 1, environment: { node: process.version, sqlite: process.versions.sqlite, rowstitch: own.version },
  scope: 'Public synchronous SQLite behavior after internal executor extraction; no async or nonblocking performance claim.', scenarios: actual.map(x => x.name), summary: { localScenarios: actual.length, baselineEqualScenarios: 0, passed: actual.length, failed: 0 } };
if (baselineDir) {
  const manifest = JSON.parse(readFileSync(new URL('executor-baseline.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.8.0'); assert.equal(manifest.package, 'rowstitch');
  const actualFiles = [];
  function verify(directory, prefix = '') {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name), relative = prefix + name, stat = lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), 'The baseline must contain ordinary release files');
      if (stat.isDirectory()) verify(full, relative + '/');
      else {
        assert.ok(stat.isFile() && Object.hasOwn(manifest.files, relative), 'Unexpected baseline entry');
        assert.equal(createHash('sha256').update(readFileSync(full)).digest('hex'), manifest.files[relative], 'Baseline file differs from the pinned release: ' + relative);
        actualFiles.push(relative);
      }
    }
  }
  verify(baselineDir);
  assert.deepEqual(actualFiles.sort(), Object.keys(manifest.files).sort(), 'Incomplete baseline distribution');
  const metadata = JSON.parse(readFileSync(join(baselineDir, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'rowstitch'); assert.equal(metadata.version, '0.8.0', 'Use the pinned released 0.8.0 baseline');
  const baseline = await import(pathToFileURL(join(baselineDir, 'dist/index.js')).href);
  const previous = exercise(baseline);
  assert.deepEqual(actual, previous, 'The refactor changed a synchronous observable result or non-clock trace field');
  report.environment.baseline = metadata.version; report.environment.baselineTarballSha256 = manifest.tarballSha256;
  report.summary.baselineEqualScenarios = actual.length;
}
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
