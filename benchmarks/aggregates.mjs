// Fixed aggregate contracts and generated statements. This is not a speed ranking.
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
const { column, defineTable, openDatabase, agg, eq, lt, lte, gt, hasMany, countRelated } = await import(pathToFileURL(entry).href);
const ownPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '../package.json'), 'utf8'));
const samples = [
  { id: 1, category: 'A', qty: 2, amount: 1.5, label: 'Zulu', exact: 9007199254740993n },
  { id: 2, category: 'A', qty: null, amount: null, label: 'Alpha', exact: 9007199254740995n },
  { id: 3, category: 'B', qty: 3, amount: 2.5, label: null, exact: null },
  { id: 4, category: 'B', qty: -1, amount: -1, label: "' OR 1=1 --", exact: 0n },
  { id: 5, category: null, qty: null, amount: null, label: null, exact: null },
  { id: 6, category: null, qty: 1, amount: 0.5, label: null, exact: 5n },
];
const max = (1n << 63n) - 1n;
const exactRows = [
  ['above', max], ['above', max], ['cancel', max], ['cancel', max], ['cancel', -max], ['cancel', -max], ['cancel', -1n],
  ['carry', 4294967295n], ['carry', 1n], ['negative', -4294967296n], ['zero', 0n], ['null', null],
].map(([category, amount], index) => ({ id: index + 1, category, amount }));
const tables = {
  samples: defineTable('samples', { id: column.integer().primaryKey(), category: column.text().nullable(), qty: column.integer().nullable(), amount: column.real().nullable(), label: column.text().nullable(), exact: column.bigint().nullable() }),
  children: defineTable('children', { id: column.integer().primaryKey(), sample_id: column.integer() }),
  exact_sums: defineTable('exact_sums', { id: column.integer().primaryKey(), category: column.text(), amount: column.bigint().nullable() }),
  collated: defineTable('collated', { id: column.integer().primaryKey(), label: column.text() }),
  stored_real: defineTable('stored_real', { id: column.integer().primaryKey(), amount: column.real() }),
  real_overflow: defineTable('real_overflow', { id: column.integer().primaryKey(), amount: column.real() }),
  invalid: defineTable('invalid', { id: column.integer().primaryKey(), category: column.text(), amount: column.integer() }),
};
const report = {
  format: 'rowstitch-root-aggregate-comparison', version: 1,
  environment: { node: process.version, nodeSQLite: process.versions.sqlite, rowstitch: ownPackage.version },
  fixture: { samples, exactRows, storedRealRows: 1025, storedRealValue: Number.MAX_SAFE_INTEGER }, cases: [], contractDifferences: [],
  limitations: [
    'Fixed SQLite correctness and observed statement counts only; no timing, universal superiority or full Orange compatibility claim.',
    'Orange 5.5.1 observations cover its published CommonJS node:sqlite path on the recorded runtime, not other versions or drivers.',
    'Shared safe numeric fixtures normalize documented return representations for comparison; native results are also recorded.',
    'Raw SQLite uses explicit application-written SQL, including a working split-SUM alternative. It is not an intentionally weaker baseline.',
    'Integer split partials retain SQLite int64 limits. Real SUM and all AVG results are approximate; this fixture does not claim unbounded arithmetic.',
    'A group page with no rows carries no data guard. No assertion about unreturned data is made for an empty page.',
    'Related aggregate projections, HAVING, DISTINCT, per-selector filters and non-SQLite engines are outside this milestone.',
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
    samples: x.table('samples').map(({ column: c }) => ({ id: c('id').numeric().primary(), category: c('category').string(), qty: c('qty').numeric(), amount: c('amount').numeric(), label: c('label').string(), exact: c('exact').bigint() })),
    children: x.table('children').map(({ column: c }) => ({ id: c('id').numeric().primary(), sampleId: c('sample_id').numeric() })),
    exact_sums: x.table('exact_sums').map(({ column: c }) => ({ id: c('id').numeric().primary(), category: c('category').string(), amount: c('amount').bigint() })),
    collated: x.table('collated').map(({ column: c }) => ({ id: c('id').numeric().primary(), label: c('label').string() })),
    stored_real: x.table('stored_real').map(({ column: c }) => ({ id: c('id').numeric().primary(), amount: c('amount').numeric() })),
    real_overflow: x.table('real_overflow').map(({ column: c }) => ({ id: c('id').numeric().primary(), amount: c('amount').numeric() })),
  })).map(x => ({ samples: x.samples.map(({ hasMany }) => ({ children: hasMany(x.children).by('sampleId') })) }));
} else report.limitations.push('Orange was not loaded. Use --reference-dir for the pinned released-package observations.');

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
  try { result = await action(); assert.equal(selects().length, 1, 'Expected one executed SELECT.'); }
  catch (caught) { error = caught.message; }
  finally { recording = false; }
  report.cases.push({ tool, name, status: error ? 'fail' : 'pass', ...(error ? { error } : result), selectQueries: selects().length, commands });
}
const plain = rows => rows.map(row => ({ ...row }));
const numeric = row => ({ rows: Number(row.rows), present: Number(row.present), total: row.total === null ? null : BigInt(row.total),
  mean: row.mean, low: row.low === null ? null : Number(row.low), high: row.high === null ? null : Number(row.high) });
const oracle = rows => {
  const values = rows.flatMap(row => row.qty === null ? [] : [row.qty]);
  return { rows: rows.length, present: values.length, total: values.length ? values.reduce((total, value) => total + BigInt(value), 0n) : null,
    mean: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    low: values.length ? Math.min(...values) : null, high: values.length ? Math.max(...values) : null };
};
const compareKey = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
const numericSql = 'COUNT(id) AS rows,COUNT(qty) AS present,SUM(qty) AS total,AVG(qty) AS mean,MIN(qty) AS low,MAX(qty) AS high';
const s = tables.samples;
const ownNumeric = { rows: agg.count(), present: agg.count(s.col('qty')), total: agg.sum(s.col('qty')), mean: agg.avg(s.col('qty')), low: agg.min(s.col('qty')), high: agg.max(s.col('qty')) };
const orangeNumeric = { rows: x => x.count(x => x.id), present: x => x.count(x => x.qty), total: x => x.sum(x => x.qty), mean: x => x.avg(x => x.qty), low: x => x.min(x => x.qty), high: x => x.max(x => x.qty) };
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-aggregates-'));
const filename = path.join(folder, 'fictional.sqlite'), raw = new DatabaseSync(filename, { enableExtensions: false });
const rawRows = (sql, parameters = []) => { const statement = raw.prepare(sql); statement.setReadBigInts(true); return plain(statement.all(...parameters)); };
let own, reference;
try {
  raw.exec(`CREATE TABLE samples(id INTEGER PRIMARY KEY, category TEXT, qty INTEGER, amount REAL, label TEXT, exact INTEGER);
    CREATE TABLE children(id INTEGER PRIMARY KEY, sample_id INTEGER NOT NULL);
    CREATE INDEX child_sample ON children(sample_id);
    CREATE INDEX sample_category ON samples(category);
    CREATE TABLE exact_sums(id INTEGER PRIMARY KEY, category TEXT NOT NULL, amount INTEGER);
    CREATE TABLE collated(id INTEGER PRIMARY KEY, label TEXT COLLATE NOCASE NOT NULL);
    CREATE TABLE stored_real(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);
    CREATE TABLE real_overflow(id INTEGER PRIMARY KEY, amount REAL NOT NULL);
    CREATE TABLE invalid(id INTEGER PRIMARY KEY, category TEXT NOT NULL, amount INTEGER);`);
  for (const row of samples) raw.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run(row.id, row.category, row.qty, row.amount, row.label, row.exact);
  for (const [index, sample] of [1, 1, 1, 3, 3, 6].entries()) raw.prepare('INSERT INTO children VALUES (?,?)').run(index + 1, sample);
  for (const row of exactRows) raw.prepare('INSERT INTO exact_sums VALUES (?,?,?)').run(row.id, row.category, row.amount);
  for (const [index, label] of ['Z', 'a', 'A', 'b'].entries()) raw.prepare('INSERT INTO collated VALUES (?,?)').run(index + 1, label);
  raw.exec('BEGIN');
  for (let index = 0; index < 1025; index++) raw.prepare('INSERT INTO stored_real VALUES (?,?)').run(index + 1, BigInt(Number.MAX_SAFE_INTEGER));
  raw.exec('COMMIT');
  for (const [index, amount] of [1e308, 1e308, -1e308].entries()) raw.prepare('INSERT INTO real_overflow VALUES (?,?)').run(index + 1, amount);
  raw.exec("INSERT INTO invalid VALUES (1,'a',1),(2,'z','bad')");
  own = openDatabase(filename, { tables: Object.values(tables) });
  reference = orangeMap?.sqlite(filename, { size: 1, min: 1 });
  if (reference) {
    report.environment.orangeSQLite = String((await reference.query('SELECT sqlite_version() AS v'))[0].v);
    assert.equal(report.environment.orangeSQLite, process.versions.sqlite, 'The comparison expects the same actual Node SQLite engine.');
  }
  const relation = hasMany(tables.children, { localKey: s.col('id'), foreignKey: tables.children.col('sample_id') });
  const domains = [
    ['all rows', undefined, undefined, () => true, '', []],
    ['filtered rows', lte(s.col('id'), 4), x => x.id.le(4), row => row.id <= 4, ' WHERE id<=?', [4]],
    ['positive values', gt(s.col('qty'), 0), x => x.qty.gt(0), row => row.qty !== null && row.qty > 0, ' WHERE qty>?', [0]],
    ['bound quote', eq(s.col('label'), "' OR 1=1 --"), x => x.label.eq("' OR 1=1 --"), row => row.id === 4, ' WHERE label=?', ["' OR 1=1 --"]],
    ['related count does not multiply root rows', countRelated(relation, '>=', 2), x => x.children.count().ge(2), row => row.id === 1 || row.id === 3,
      ' WHERE (SELECT COUNT(*) FROM children c WHERE c.sample_id=samples.id)>=?', [2]],
  ];
  for (const [name, where, orangeWhere, keep, suffix, parameters] of domains) {
    const expected = oracle(samples.filter(keep));
    await check('raw node:sqlite + JS oracle', name, () => {
      const actual = rawRows('SELECT ' + numericSql + ' FROM samples' + suffix, parameters)[0];
      assert.deepEqual(numeric(actual), expected); return { expected, actual };
    });
    await check('rowstitch', name, () => {
      const actual = own.table(s).aggregate({ select: ownNumeric, ...(where ? { where } : {}) });
      assert.deepEqual(actual, expected); return { expected, actual };
    });
    if (reference) await check('orange-orm@5.5.1', name, async () => {
      const actual = { ...(await reference.samples.aggregate({ ...orangeNumeric, ...(orangeWhere ? { where: orangeWhere } : {}) }))[0] };
      assert.deepEqual(numeric(actual), expected); return { expected, actual };
    });
  }
  const groups = [...new Set(samples.map(row => row.category))].map(category => ({ category, ...oracle(samples.filter(row => row.category === category)) }));
  for (const [name, sort, limit, offset] of [['group including NULL key', 'key', 100, 0], ['aggregate ordering and page', 'total', 1, 1]]) {
    const expected = [...groups].sort((a, b) => (sort === 'total' ? compareKey(b.total, a.total) : 0) || compareKey(a.category, b.category)).slice(offset, offset + limit);
    const orderBy = sort === 'total' ? [{ field: 'total', direction: 'desc' }] : [];
    await check('rowstitch', name, () => { const actual = own.table(s).groupBy({ by: ['category'], select: ownNumeric, orderBy, limit, offset }); assert.deepEqual(actual, expected); return { expected, actual }; });
    await check('raw node:sqlite + JS oracle', name, () => {
      const actual = rawRows('SELECT category,' + numericSql + ' FROM samples GROUP BY category ORDER BY ' + (sort === 'total' ? 'total DESC,' : '') + 'category LIMIT ? OFFSET ?', [limit, offset]);
      assert.deepEqual(actual.map(row => ({ category: row.category, ...numeric(row) })), expected); return { expected, actual };
    });
    if (reference) await check('orange-orm@5.5.1', name, async () => {
      const actual = plain(await reference.samples.aggregate({ category: x => x.category, ...orangeNumeric, orderBy: sort === 'total' ? ['total desc', 'category'] : 'category', limit, offset }));
      assert.deepEqual(actual.map(row => ({ category: row.category, ...numeric(row) })), expected); return { expected, actual };
    });
  }
  for (const [name, where, orangeWhere, sql, parameters, keep] of [
    ['empty root', lt(s.col('id'), 0), x => x.id.lt(0), 'id<?', [0], () => false],
    ['all-NULL root', eq(s.col('id'), 5), x => x.id.eq(5), 'id=?', [5], row => row.id === 5],
  ]) {
    const expected = oracle(samples.filter(keep));
    await check('rowstitch', name, () => { const actual = own.table(s).aggregate({ select: ownNumeric, where }); assert.deepEqual(actual, expected); return { expected, actual }; });
    await check('raw node:sqlite + JS oracle', name, () => { const actual = rawRows('SELECT ' + numericSql + ' FROM samples WHERE ' + sql, parameters)[0]; assert.deepEqual(numeric(actual), expected); return { expected, actual }; });
    if (reference) await check('orange-orm@5.5.1', name + ' native contract', async () => {
      const actual = { ...(await reference.samples.aggregate({ ...orangeNumeric, where: orangeWhere }))[0] };
      assert.deepEqual(actual, { rows: expected.rows, present: 0, total: 0, mean: 0, low: NaN, high: NaN });
      report.contractDifferences.push({ name, rowstitch: expected, orange: actual, note: 'SUM/AVG zero follows Orange COALESCE; empty MIN/MAX NaN is observed in this pinned aggregate decoder only.' });
      return { actual };
    });
  }
  await check('rowstitch', 'empty groups', () => { const actual = own.table(s).groupBy({ by: ['category'], select: ownNumeric, where: lt(s.col('id'), 0) }); assert.deepEqual(actual, []); return { actual }; });
  await check('raw node:sqlite', 'empty groups', () => { const actual = rawRows('SELECT category,COUNT(*) FROM samples WHERE id<0 GROUP BY category'); assert.deepEqual(actual, []); return { actual }; });
  if (reference) await check('orange-orm@5.5.1', 'empty groups', async () => { const actual = await reference.samples.aggregate({ category: x => x.category, ...orangeNumeric, where: x => x.id.lt(0) }); assert.deepEqual(actual, []); return { actual }; });

  const collated = tables.collated;
  await check('rowstitch', 'NOCASE text extrema', () => { const actual = own.table(collated).aggregate({ select: { low: agg.min(collated.col('label')), high: agg.max(collated.col('label')) } }); assert.deepEqual(actual, { low: 'a', high: 'Z' }); return { actual }; });
  await check('raw node:sqlite', 'NOCASE text extrema', () => { const actual = rawRows('SELECT MIN(label) AS low,MAX(label) AS high FROM collated')[0]; assert.deepEqual(actual, { low: 'a', high: 'Z' }); return { actual }; });
  if (reference) await check('orange-orm@5.5.1', 'NOCASE text extrema native decoding', async () => {
    const actual = { ...(await reference.collated.aggregate({ low: x => x.min(x => x.label), high: x => x.max(x => x.label) }))[0] };
    assert.deepEqual(actual, { low: NaN, high: NaN });
    report.contractDifferences.push({ name: 'text extrema decoding', rowstitch: { low: 'a', high: 'Z' }, orange: actual, note: 'Pinned aggregate-path observation; no statement about all Orange text APIs or other drivers.' }); return { actual };
  });
  const collatedCounts = [{ label: 'a', rows: 2 }, { label: 'b', rows: 1 }, { label: 'z', rows: 1 }];
  const folded = rows => rows.map(row => ({ label: row.label.toLowerCase(), rows: Number(row.rows) }));
  await check('rowstitch', 'NOCASE grouping and ordering', () => { const actual = own.table(collated).groupBy({ by: ['label'], select: { rows: agg.count() } }); assert.deepEqual(folded(actual), collatedCounts); return { actual }; });
  await check('raw node:sqlite', 'NOCASE grouping and ordering', () => { const actual = rawRows('SELECT label,COUNT(*) AS rows FROM collated GROUP BY label ORDER BY label'); assert.deepEqual(folded(actual), collatedCounts); return { actual }; });
  if (reference) await check('orange-orm@5.5.1', 'NOCASE grouping and ordering', async () => { const actual = plain(await reference.collated.aggregate({ label: x => x.label, rows: x => x.count(x => x.id), orderBy: 'label' })); assert.deepEqual(folded(actual), collatedCounts); return { actual }; });

  for (const [name, id, expected] of [['large bigint', 1, 9007199254740993n], ['small bigint', 6, 5n]]) {
    await check('rowstitch', name + ' ordinary read', () => { const actual = own.table(s).findFirst({ where: eq(s.col('id'), id), select: ['exact'] }); assert.deepEqual(actual, { exact: expected }); return { actual }; });
    await check('raw node:sqlite', name + ' ordinary read', () => { const actual = rawRows('SELECT exact FROM samples WHERE id=?', [id])[0]; assert.deepEqual(actual, { exact: expected }); return { actual }; });
    if (reference) await check('orange-orm@5.5.1', name + ' ordinary read', async () => {
      const actual = { ...(await reference.samples.getMany({ where: x => x.id.eq(id), exact: true }))[0] };
      assert.equal(BigInt(actual.exact), expected); return { actual, note: 'The normal bigint read succeeds; aggregate observations must not be generalized to this path.' };
    });
    await check('rowstitch', name + ' minimum', () => { const actual = own.table(s).aggregate({ select: { low: agg.min(s.col('exact')) }, where: eq(s.col('id'), id) }); assert.deepEqual(actual, { low: expected }); return { actual }; });
    await check('raw node:sqlite', name + ' minimum', () => { const actual = rawRows('SELECT MIN(exact) AS low FROM samples WHERE id=?', [id])[0]; assert.deepEqual(actual, { low: expected }); return { actual }; });
    if (reference) await check('orange-orm@5.5.1', name + ' minimum native decoding', async () => {
      if (id === 1) {
        await assert.rejects(() => reference.samples.aggregate({ low: x => x.min(x => x.exact), where: x => x.id.eq(id) }), error => error?.code === 'ERR_OUT_OF_RANGE');
        report.contractDifferences.push({ name: 'large bigint minimum on node:sqlite aggregate path', rowstitch: expected, orangeError: 'ERR_OUT_OF_RANGE', note: 'The same value was read successfully through Orange getMany above. Other drivers and versions are untested.' });
        return { expectedError: 'ERR_OUT_OF_RANGE' };
      }
      const actual = { ...(await reference.samples.aggregate({ low: x => x.min(x => x.exact), where: x => x.id.eq(id) }))[0] };
      assert.deepEqual(actual, { low: Number(expected) }); return { actual };
    });
  }
  const approximateMean = Number(9007199254740993n);
  await check('rowstitch', 'bigint average explicit approximation', () => {
    const actual = own.table(s).aggregate({ select: { mean: agg.avg(s.col('exact'), { approximate: true }) }, where: eq(s.col('id'), 1) });
    assert.deepEqual(actual, { mean: approximateMean }); return { exactInput: 9007199254740993n, actual, note: 'The approximate result cannot represent the original odd integer exactly.' };
  });
  await check('raw node:sqlite', 'bigint average approximation', () => {
    const actual = rawRows('SELECT AVG(exact) AS mean FROM samples WHERE id=?', [1])[0]; assert.deepEqual(actual, { mean: approximateMean }); return { actual };
  });
  if (reference) await check('orange-orm@5.5.1', 'bigint average approximation succeeds', async () => {
    const actual = { ...(await reference.samples.aggregate({ mean: x => x.avg(x => x.exact), where: x => x.id.eq(1) }))[0] };
    assert.deepEqual(actual, { mean: approximateMean }); return { actual, note: 'This large-input AVG succeeds; the MIN decoding observation does not describe all bigint aggregates.' };
  });
  const aliasExpected = [{ category: 'B', qty: 3n }, { category: 'A', qty: 2n }, { category: null, qty: 1n }];
  await check('rowstitch', 'alias matching a non-group column', () => {
    const actual = own.table(s).groupBy({ by: ['category'], select: { qty: agg.sum(s.col('qty')) }, where: gt(s.col('qty'), 0), orderBy: [{ field: 'qty', direction: 'desc' }] });
    assert.deepEqual(actual, aliasExpected); return { actual };
  });
  await check('raw node:sqlite', 'alias matching a non-group column', () => {
    const actual = rawRows('SELECT samples.category,SUM(samples.qty) AS qty FROM samples WHERE samples.qty>? GROUP BY samples.category ORDER BY 2 DESC,1', [0]);
    assert.deepEqual(actual, aliasExpected); return { actual };
  });
  if (reference) await check('orange-orm@5.5.1', 'alias matching a non-group column', async () => {
    const actual = plain(await reference.samples.aggregate({ category: x => x.category, qty: x => x.sum(x => x.qty), where: x => x.qty.gt(0), orderBy: ['qty desc', 'category'] }));
    assert.deepEqual(actual.map(row => ({ category: row.category, qty: BigInt(row.qty) })), aliasExpected); return { actual };
  });
  const exact = tables.exact_sums, exactSum = rows => { const values = rows.flatMap(row => row.amount === null ? [] : [row.amount]); return values.length ? values.reduce((total, value) => total + value, 0n) : null; };
  const split = 'SUM(amount >> 32) AS high,SUM(amount & 4294967295) AS low';
  const combine = row => row.high === null ? null : row.high * 4294967296n + row.low;
  for (const [name, category] of [['beyond int64', 'above'], ['intermediate cancellation', 'cancel'], ['low-word carry', 'carry'], ['all-NULL exact sum', 'null']]) {
    const expected = exactSum(exactRows.filter(row => row.category === category));
    await check('rowstitch', name, () => { const actual = own.table(exact).aggregate({ select: { total: agg.sum(exact.col('amount')) }, where: eq(exact.col('category'), category) }); assert.deepEqual(actual, { total: expected }); return { expected, actual }; });
    await check('raw node:sqlite split recipe + JS oracle', name, () => { const partials = rawRows('SELECT ' + split + ' FROM exact_sums WHERE category=?', [category])[0], actual = combine(partials); assert.equal(actual, expected); return { expected, actual, partials }; });
  }
  const exactGroups = [...new Set(exactRows.map(row => row.category))].map(category => ({ category, total: exactSum(exactRows.filter(row => row.category === category)) }));
  for (const direction of ['asc', 'desc']) {
    const expected = [...exactGroups].sort((a, b) => (direction === 'asc' ? compareKey(a.total, b.total) : compareKey(b.total, a.total)) || compareKey(a.category, b.category));
    await check('rowstitch', 'exact grouped sum order ' + direction, () => { const actual = own.table(exact).groupBy({ by: ['category'], select: { total: agg.sum(exact.col('amount')) }, orderBy: [{ field: 'total', direction }] }); assert.deepEqual(actual, expected); return { expected, actual }; });
    await check('raw node:sqlite split recipe + JS oracle', 'exact grouped sum order ' + direction, () => {
      const sql = 'SELECT category,(SUM(amount >> 32)+(SUM(amount & 4294967295) >> 32)) AS high,(SUM(amount & 4294967295) & 4294967295) AS low FROM exact_sums GROUP BY category ORDER BY high ' + direction.toUpperCase() + ',low ' + direction.toUpperCase() + ',category';
      const actual = rawRows(sql).map(row => ({ category: row.category, total: combine(row) })); assert.deepEqual(actual, expected); return { expected, actual };
    });
  }
  for (const category of ['above', 'cancel']) {
    await check('raw node:sqlite native SUM', category + ' engine overflow', () => { assert.throws(() => rawRows('SELECT SUM(amount) FROM exact_sums WHERE category=?', [category]), /integer overflow/i); return { expectedError: 'integer overflow', note: 'Same native engine limit as Orange; raw split recipe passes above.' }; });
    if (reference) await check('orange-orm@5.5.1 native SUM', category + ' engine overflow', async () => { await assert.rejects(() => reference.exact_sums.aggregate({ total: x => x.sum(x => x.amount), where: x => x.category.eq(category) }), /integer overflow/i); return { expectedError: 'integer overflow', note: 'SQLite native SUM behavior, not an Orange-specific defect.' }; });
  }
  const realExpected = Number.MAX_SAFE_INTEGER * 1025;
  const near = actual => { assert(Number.isFinite(actual)); assert(Math.abs(actual - realExpected) / realExpected < 1e-12); };
  await check('rowstitch', 'mapped real sum over INTEGER storage', () => { const actual = own.table(tables.stored_real).aggregate({ select: { total: agg.sum(tables.stored_real.col('amount')) } }); near(actual.total); return { approximateExpected: realExpected, actual }; });
  await check('raw node:sqlite explicit REAL cast', 'mapped real sum over INTEGER storage', () => { const actual = rawRows('SELECT SUM(CAST(amount AS REAL)) AS total FROM stored_real')[0]; near(actual.total); return { approximateExpected: realExpected, actual }; });
  await check('raw node:sqlite native SUM', 'INTEGER storage engine overflow', () => { assert.throws(() => rawRows('SELECT SUM(amount) FROM stored_real'), /integer overflow/i); return { expectedError: 'integer overflow' }; });
  if (reference) await check('orange-orm@5.5.1 native SUM', 'INTEGER storage engine overflow', async () => { await assert.rejects(() => reference.stored_real.aggregate({ total: x => x.sum(x => x.amount) }), /integer overflow/i); return { expectedError: 'integer overflow', note: 'Explicit raw REAL cast above is a working alternative for this approximate contract.' }; });
  await check('rowstitch', 'nonfinite real sum rejection', () => { assert.throws(() => own.table(tables.real_overflow).aggregate({ select: { total: agg.sum(tables.real_overflow.col('amount')) } }), error => error?.code === 'AGGREGATE_RANGE'); return { expectedError: 'AGGREGATE_RANGE' }; });
  await check('raw node:sqlite', 'nonfinite real sum native result', () => { const actual = rawRows('SELECT SUM(amount) AS total FROM real_overflow')[0]; assert.equal(actual.total, Infinity); return { actual }; });
  if (reference) await check('orange-orm@5.5.1', 'nonfinite real sum native result', async () => { const actual = { ...(await reference.real_overflow.aggregate({ total: x => x.sum(x => x.amount) }))[0] }; assert.equal(actual.total, Infinity); return { actual, note: 'Same engine result as raw SQLite; Rowstitch explicitly rejects it.' }; });
  const invalid = tables.invalid;
  await check('rowstitch', 'count all ignores unrelated invalid storage', () => { const actual = own.table(invalid).aggregate({ select: { rows: agg.count() } }); assert.deepEqual(actual, { rows: 2 }); return { actual }; });
  await check('rowstitch', 'guard catches invalid group outside page', () => { assert.throws(() => own.table(invalid).groupBy({ by: ['category'], select: { rows: agg.count(invalid.col('amount')) }, limit: 1 }), error => error?.code === 'DATA'); return { expectedError: 'DATA' }; });
  await check('rowstitch', 'guard excludes filtered-out invalid data', () => { const actual = own.table(invalid).groupBy({ by: ['category'], select: { total: agg.sum(invalid.col('amount')) }, where: eq(invalid.col('id'), 1), limit: 1 }); assert.deepEqual(actual, [{ category: 'a', total: 1n }]); return { actual }; });
  await check('rowstitch', 'empty page carries no guard', () => { const actual = own.table(invalid).groupBy({ by: ['category'], select: { rows: agg.count(invalid.col('amount')) }, offset: 100 }); assert.deepEqual(actual, []); return { actual, note: 'An empty page makes no data-validity assertion.' }; });
} finally {
  try { await reference?.close(); }
  finally { try { own?.close(); }
    finally { try { raw.close(); }
      finally {
        DatabaseSync.prototype.prepare = originalPrepare;
        const target = path.resolve(folder);
        assert(path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('rowstitch-aggregates-'));
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }
}
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length, contractDifferences: report.contractDifferences.length };
const encode = (_, value) => typeof value === 'bigint' ? { bigint: String(value) } : typeof value === 'number' && !Number.isFinite(value) ? { number: String(value) } : value;
const text = JSON.stringify(report, encode, 2) + '\n';
if (options.output) fs.writeFileSync(options.output, text);
process.stdout.write(text);
if (report.summary.failed) process.exitCode = 1;
