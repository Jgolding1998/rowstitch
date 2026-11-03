// Bounded correctness/query-count examples, not a latency benchmark.
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
const operators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const orangeOperators = { eq: 'eq', ne: 'ne', gt: 'gt', gte: 'ge', lt: 'lt', lte: 'le' };
const domains = {
  integer: [null, -1, 0, 1, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0, 0],
  bigint: [null, -1n, 0n, 1n, -(2n ** 63n), 2n ** 63n - 1n, 2n ** 53n + 1n, -(2n ** 53n) - 1n, 0n, 0n],
  real: [null, -1, 0, 1, -(2 ** 63), 2 ** 63, 2 ** 53, -(2 ** 53), .5, Number.MIN_VALUE],
};
const numeric = Object.keys(domains).flatMap(leftKind => Object.keys(domains).map(rightKind => {
  const rows = domains[leftKind].map((lhs, index) => ({ id: index + 1, lhs, rhs: domains[rightKind][index] }));
  rows.push({ id: 11, lhs: null, rhs: domains[rightKind][3] }, { id: 12, lhs: domains[leftKind][3], rhs: null });
  return { name: 'pair_' + leftKind + '_' + rightKind, leftKind, rightKind, rows };
}));
const pairs = [['Alpha', 'alpha'], ['a\0X', 'a\0Y'], ['same', 'same '], ['É', 'é'], ['e\u0301', 'é'], ['🧵', '\ue000'], ['Ā', 'a'], ['a', 'aa'], ['', ''], [null, 'a'], ['a', null], [null, null]];
const texts = pairs.map(([nocase, binary], index) => ({ id: index + 1, nocase, binary, trimmed: binary }));
const booleans = [null, false, true].flatMap(lhs => [null, false, true].map(rhs => ({ lhs, rhs }))).map((row, index) => ({ id: index + 1, ...row }));
function rational(value) {
  if (typeof value === 'bigint') return [value, 1n];
  const data = new DataView(new ArrayBuffer(8)); data.setFloat64(0, value, false);
  const bits = data.getBigUint64(0, false), exponent = Number((bits >> 52n) & 0x7ffn), fraction = bits & ((1n << 52n) - 1n);
  const magnitude = exponent ? (1n << 52n) | fraction : fraction, signed = bits >> 63n ? -magnitude : magnitude;
  const power = exponent ? exponent - 1023 - 52 : -1074;
  return power >= 0 ? [signed << BigInt(power), 1n] : [signed, 1n << BigInt(-power)];
}
function matches(left, right, operation, negated) {
  if (left === null || right === null) return null;
  const [ln, ld] = rational(left), [rn, rd] = rational(right), delta = ln * rd - rn * ld;
  const result = { eq: delta === 0n, ne: delta !== 0n, gt: delta > 0n, gte: delta >= 0n, lt: delta < 0n, lte: delta <= 0n }[operation];
  return negated ? !result : result;
}
const mapped = Object.fromEntries(numeric.map(fixture => [fixture.name, api.defineTable(fixture.name, { id: api.column.integer().primaryKey(), lhs: api.column[fixture.leftKind]().nullable(), rhs: api.column[fixture.rightKind]().nullable() })]));
mapped.texts = api.defineTable('texts', { id: api.column.integer().primaryKey(), nocase: api.column.text().nullable(), binary: api.column.text().nullable(), trimmed: api.column.text().nullable() });
mapped.booleans = api.defineTable('booleans', { id: api.column.integer().primaryKey(), lhs: api.column.boolean().nullable(), rhs: api.column.boolean().nullable() });
const report = { format: 'rowstitch-column-comparison', version: 1,
  environment: { node: process.version, nodeSQLite: process.versions.sqlite, rowstitch: ownPackage.version },
  fixture: { numericPairs: 9, rowsPerNumericPair: 12, textRows: texts.length, booleanRows: booleans.length, encodings: ['UTF-8', 'UTF-16le', 'UTF-16be'], note: 'Numeric operators rotate across the nine pairs with NOT for each pair. All six operators also exercise both text operand orders. The larger independent proof covers every numeric pair/operator combination.' },
  cases: [], collationObservations: [],
  limitations: ['Bounded fictional correctness and actual SQL/bindings/query counts only; no latency or universal-superiority claim.', 'Bigint/binary64 expectations use exact BigInt rational arithmetic, never Number(bigint).', 'Native declared NOCASE/BINARY/RTRIM and left-operand precedence are preserved; no forced BINARY comparison.', 'Rowstitch rejects self/cross-table/cross-domain comparisons by contract; broader Orange/Kysely contracts are not defects.', 'Released SQLite paths only. Kysely uses the separately reported pinned native-driver engine.'] };
let recording = false, commands = [];
let orangeMap, Kysely, SqliteDialect, Better;
if (options['reference-dir']) {
  const require = createRequire(path.join(options['reference-dir'], 'package.json'));
  for (const [name, version] of [['orange-orm', '5.5.1'], ['kysely', '0.29.8'], ['better-sqlite3', '12.6.2']]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(options['reference-dir'], 'node_modules', name, 'package.json'), 'utf8')).version, version);
    report.environment[name] = version;
  }
  const orange = (await import(pathToFileURL(require.resolve('orange-orm')).href)).default;
  ({ Kysely, SqliteDialect } = await import(pathToFileURL(require.resolve('kysely')).href)); Better = require('better-sqlite3');
  orangeMap = orange.map(mapper => Object.fromEntries([
    ...numeric.map(fixture => [fixture.name, mapper.table(fixture.name).map(({ column: c }) => ({ id: c('id').numeric().primary(), lhs: fixture.leftKind === 'bigint' ? c('lhs').bigint() : c('lhs').numeric(), rhs: fixture.rightKind === 'bigint' ? c('rhs').bigint() : c('rhs').numeric() }))]),
    ['texts', mapper.table('texts').map(({ column: c }) => ({ id: c('id').numeric().primary(), nocase: c('nocase').string(), binary: c('binary').string(), trimmed: c('trimmed').string() }))],
    ['booleans', mapper.table('booleans').map(({ column: c }) => ({ id: c('id').numeric().primary(), lhs: c('lhs').boolean(), rhs: c('rhs').boolean() }))],
  ]));
} else report.limitations.push('External references not loaded; pass --reference-dir containing the pinned released packages.');
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql), all = statement.all;
  statement.all = function (...parameters) {
    if (!recording) return all.apply(this, parameters);
    const command = { sql, parameters, status: 'pending' }; commands.push(command);
    try { const result = all.apply(this, parameters); command.status = 'ok'; return result; }
    catch (error) { command.status = 'error'; throw error; }
  }; return statement;
};
async function check(tool, encoding, name, action) {
  commands = []; recording = true; let result, error;
  try { result = await action(); } catch (failure) { error = failure.message; } finally { recording = false; }
  report.cases.push({ tool, encoding, name, status: error ? 'fail' : 'pass', ...(error ? { error } : result), selectQueries: commands.filter(command => /^\s*select\b/i.test(command.sql)).length, commands });
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-columns-'));
try {
  for (const [index, encoding] of report.fixture.encodings.entries()) {
    const file = path.join(directory, 'fixture-' + index + '.sqlite'), raw = new DatabaseSync(file, { enableExtensions: false });
    let db, reference, kdb, native;
    try {
      raw.exec("PRAGMA encoding='" + encoding + "'");
      for (const fixture of numeric) {
        raw.exec('CREATE TABLE ' + fixture.name + '(id INTEGER NOT NULL, lhs ' + (fixture.leftKind === 'real' ? 'REAL' : 'INTEGER') + ', rhs ' + (fixture.rightKind === 'real' ? 'REAL' : 'INTEGER') + ', PRIMARY KEY(id))');
        const insert = raw.prepare('INSERT INTO ' + fixture.name + ' VALUES(?,?,?)');
        for (const row of fixture.rows) insert.run(row.id, row.lhs, row.rhs);
      }
      raw.exec('CREATE TABLE texts(id INTEGER NOT NULL, nocase TEXT COLLATE NOCASE, binary TEXT COLLATE BINARY, trimmed TEXT COLLATE RTRIM, PRIMARY KEY(id)); CREATE TABLE booleans(id INTEGER NOT NULL, lhs INTEGER CHECK(lhs IN(0,1)), rhs INTEGER CHECK(rhs IN(0,1)), PRIMARY KEY(id))');
      const insertText = raw.prepare('INSERT INTO texts VALUES(?,?,?,?)'), insertBool = raw.prepare('INSERT INTO booleans VALUES(?,?,?)');
      for (const row of texts) insertText.run(row.id, row.nocase, row.binary, row.trimmed);
      for (const row of booleans) insertBool.run(row.id, row.lhs === null ? null : +row.lhs, row.rhs === null ? null : +row.rhs);
      assert.equal(raw.prepare('PRAGMA encoding').get().encoding, encoding);
      db = api.openDatabase(file, { tables: Object.values(mapped) }); assert.deepEqual(db.planSchema(), []);
      if (orangeMap) {
        reference = orangeMap.sqlite(file, { size: 1, min: 1 }); report.environment.orangeSQLite = String((await reference.query('SELECT sqlite_version() AS version'))[0].version);
        native = new Better(file); report.environment.kyselySQLite = String(native.prepare('SELECT sqlite_version() AS version').get().version);
        kdb = new Kysely({ dialect: new SqliteDialect({ database: native }), log(event) { if (recording && event.level === 'query') commands.push({ sql: event.query.sql, parameters: [...event.query.parameters], status: 'ok' }); } });
      }
      async function compare(table, left, right, operation, negated, wanted, name) {
        const leaf = '"' + left + '" ' + operators[operation] + ' "' + right + '"', filter = negated ? 'NOT (' + leaf + ')' : leaf;
        await check('raw node:sqlite', encoding, name, () => { const actual = raw.prepare('SELECT id FROM "' + table + '" WHERE ' + filter + ' ORDER BY id LIMIT ? OFFSET ?').all(1000, 0).map(row => row.id); assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual }; });
        await check('rowstitch', encoding, name, () => { const definition = mapped[table], predicate = api[operation + 'Columns'](definition.col(left), definition.col(right)); const actual = db.table(definition).findMany({ where: negated ? api.not(predicate) : predicate, select: ['id'] }).map(row => row.id); assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual }; });
        if (reference) await check('orange-orm@5.5.1', encoding, name, async () => { const actual = (await reference[table].getMany({ id: true, where: row => { const predicate = row[left][orangeOperators[operation]](row[right]); return negated ? predicate.not() : predicate; }, orderBy: 'id', limit: 1000, offset: 0 })).map(row => row.id); assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual }; });
        if (kdb) await check('kysely@0.29.8', encoding, name, async () => { let query = kdb.selectFrom(table).select('id'); query = negated ? query.where(builder => builder.not(builder(left, operators[operation], builder.ref(right)))) : query.whereRef(left, operators[operation], right); const actual = (await query.orderBy('id').limit(1000).offset(0).execute()).map(row => row.id); assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual }; });
      }
      for (const [pairIndex, fixture] of numeric.entries()) for (const negated of [false, true]) {
        const operation = Object.keys(operators)[pairIndex % 6], wanted = fixture.rows.filter(row => matches(row.lhs, row.rhs, operation, negated) === true).map(row => row.id);
        await compare(fixture.name, 'lhs', 'rhs', operation, negated, wanted, fixture.leftKind + '.' + fixture.rightKind + '.' + operation + (negated ? '.not' : ''));
      }
      for (const [left, right] of [['nocase', 'binary'], ['binary', 'nocase']]) for (const operation of Object.keys(operators)) {
        const wanted = raw.prepare('SELECT id FROM texts WHERE "' + left + '" ' + operators[operation] + ' "' + right + '" ORDER BY id').all().map(row => row.id);
        await compare('texts', left, right, operation, false, wanted, 'text.' + left + '.' + right + '.' + operation);
      }
      for (const negated of [false, true]) {
        const wanted = raw.prepare('SELECT id FROM texts WHERE ' + (negated ? 'NOT (' : '(') + 'trimmed = nocase) ORDER BY id').all().map(row => row.id);
        await compare('texts', 'trimmed', 'nocase', 'eq', negated, wanted, 'text.RTRIM.eq' + (negated ? '.not' : ''));
      }
      for (const operation of ['eq', 'ne']) for (const negated of [false, true]) {
        const wanted = booleans.filter(row => matches(row.lhs === null ? null : +row.lhs, row.rhs === null ? null : +row.rhs, operation, negated) === true).map(row => row.id);
        await compare('booleans', 'lhs', 'rhs', operation, negated, wanted, 'boolean.' + operation + (negated ? '.not' : ''));
      }
      const observation = raw.prepare('SELECT id,nocase = binary AS leftNoCase,binary = nocase AS leftBinary,trimmed = nocase AS leftRtrim FROM texts ORDER BY id').all();
      assert.equal(observation[0].leftNoCase, 1); assert.equal(observation[0].leftBinary, 0); assert.equal(observation[2].leftRtrim, 1); report.collationObservations.push({ encoding, rows: observation });
    } finally { try { await reference?.close(); } finally { try { if (kdb) await kdb.destroy(); else native?.close(); } finally { try { db?.close(); } finally { raw.close(); } } } }
  }
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  const target = path.resolve(directory); assert(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('rowstitch-columns-')); fs.rmSync(target, { recursive: true, force: true });
}
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length };
const text = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? { bigint: String(value) } : value, 2) + '\n';
if (options.output) fs.writeFileSync(options.output, text); process.stdout.write(text); if (report.summary.failed) process.exitCode = 1;
