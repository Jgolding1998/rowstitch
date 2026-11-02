// Fixed correctness and query-count checks; not a latency benchmark.
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
const labels = [null, 'alpha', 'ALPHA', 'x%y', 'x_y', '[a]start', 'slash\\tail', 'A\0b', 'A\0tail', 'hello😀', 'Éclair', 'Ā', '😀', "' OR 1=1 --"];
const fixture = labels.map((label, index) => ({ id: index + 1, label, amount: index % 7 === 0 ? null : index % 5 - 2, exact: index === 0 ? null : index % 2 ? 9007199254740993n : 2n ** 63n - 1n }));
const encodings = ['UTF-8', 'UTF-16le', 'UTF-16be'];
const literal = (method, needle, mode = 'sensitive') => ({ op: 'literal', method, needle, mode });
const range = (field, from, to) => ({ op: 'range', field, from, to });
const expressions = [
  ['literal.percent', literal('contains', '%')], ['literal.underscore', literal('contains', '_')],
  ['literal.brackets.prefix', literal('startsWith', '[a]')], ['literal.backslash.suffix', literal('endsWith', '\\tail')],
  ['literal.quote.injection', literal('contains', "' OR 1=1 --")], ['literal.nul.contains.ascii', literal('contains', '\0B', 'ascii-insensitive')],
  ['literal.nul.suffix.ascii', literal('endsWith', '\0TAIL', 'ascii-insensitive')], ['literal.emoji.suffix', literal('endsWith', '😀')],
  ['literal.unicode.not.folded', literal('startsWith', 'É', 'ascii-insensitive')], ['literal.sensitive', literal('contains', 'alpha')],
  ['literal.ascii.insensitive', literal('contains', 'alpha', 'ascii-insensitive')], ['literal.not.preserves.null', { op: 'not', child: literal('contains', 'x') }],
  ['between.integer.inclusive', range('amount', -1, 1)], ['between.integer.reversed', range('amount', 1, -1)],
  ['between.bigint.precision', range('exact', 9007199254740993n, 2n ** 63n - 1n)], ['between.text.encoding.order', range('label', 'Ā', '😀')],
  ['between.not.preserves.null', { op: 'not', child: range('amount', -1, 1) }],
  ['composed.literal.range', { op: 'and', children: [literal('contains', 'a', 'ascii-insensitive'), range('amount', -1, 1)] }],
];
const fold = value => value.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));
function encoded(value, encoding) {
  const bytes = Buffer.from(value, encoding === 'UTF-8' ? 'utf8' : 'utf16le');
  return encoding === 'UTF-16be' ? bytes.swap16() : bytes;
}
function matches(row, expression, encoding) {
  if (expression.op === 'not') { const result = matches(row, expression.child, encoding); return result === null ? null : !result; }
  if (expression.op === 'and') {
    const results = expression.children.map(child => matches(row, child, encoding));
    return results.includes(false) ? false : results.includes(null) ? null : true;
  }
  if (expression.op === 'literal') {
    if (row.label === null) return null;
    const [value, needle] = expression.mode === 'sensitive' ? [row.label, expression.needle] : [fold(row.label), fold(expression.needle)];
    return value[expression.method === 'contains' ? 'includes' : expression.method](needle);
  }
  const value = row[expression.field];
  if (value === null) return null;
  return typeof value === 'string'
    ? Buffer.compare(encoded(value, encoding), encoded(expression.from, encoding)) >= 0 && Buffer.compare(encoded(value, encoding), encoded(expression.to, encoding)) <= 0
    : value >= expression.from && value <= expression.to;
}
const expected = (expression, encoding) => fixture.filter(row => matches(row, expression, encoding) === true).map(row => row.id);
function rawFilter(expression) {
  if (expression.op === 'not') { const child = rawFilter(expression.child); return { sql: 'NOT (' + child.sql + ')', parameters: child.parameters }; }
  if (expression.op === 'and') { const parts = expression.children.map(rawFilter); return { sql: '(' + parts.map(part => part.sql).join(' AND ') + ')', parameters: parts.flatMap(part => part.parameters) }; }
  if (expression.op === 'range') return { sql: '("' + expression.field + '" >= ? AND "' + expression.field + '" <= ?)', parameters: [expression.from, expression.to] };
  const value = expression.mode === 'sensitive' ? '"label"' : 'lower("label")';
  const needle = expression.mode === 'sensitive' ? '?' : 'lower(?)';
  if (expression.method !== 'endsWith') return { sql: 'instr(' + value + ', ' + needle + ')' + (expression.method === 'contains' ? ' > 0' : ' = 1'), parameters: [expression.needle] };
  // HEX slicing is an independent suffix oracle; the product uses BLOB slicing.
  return { sql: 'CASE WHEN "label" IS NULL THEN NULL ELSE substr(hex(CAST(' + value + ' AS BLOB)), -length(hex(CAST(' + needle + ' AS BLOB)))) = hex(CAST(' + needle + ' AS BLOB)) END', parameters: [expression.needle, expression.needle] };
}
const table = api.defineTable('samples', { id: api.column.integer().primaryKey(), label: api.column.text().nullable(), amount: api.column.integer().nullable(), exact: api.column.bigint().nullable() });
function mappedFilter(expression) {
  if (expression.op === 'not') return api.not(mappedFilter(expression.child));
  if (expression.op === 'and') return api.and(...expression.children.map(mappedFilter));
  if (expression.op === 'range') return api.between(table.col(expression.field), expression.from, expression.to);
  return api[expression.method](table.col('label'), expression.needle, { case: expression.mode });
}
let recording = false, commands = [];
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql), originalAll = statement.all;
  statement.all = function (...parameters) {
    if (!recording) return originalAll.apply(this, parameters);
    const command = { sql, parameters, status: 'pending' }; commands.push(command);
    try { const rows = originalAll.apply(this, parameters); command.status = 'ok'; return rows; }
    catch (error) { command.status = 'error'; throw error; }
  };
  return statement;
};
const report = {
  format: 'rowstitch-expression-comparison', version: 1,
  environment: { node: process.version, nodeSQLite: process.versions.sqlite, rowstitch: ownPackage.version },
  fixture: { rows: fixture.length, expressionCasesPerEncoding: expressions.length, encodings }, cases: [], contractDifferences: [],
  limitations: ['Fixed correctness and actual SELECT counts only; no latency or universal-superiority claim.', 'Native statement calls are observed through forwarding wrappers, restored when the runner finishes.', 'Literal Rowstitch matching and Orange LIKE pattern matching differ; these differences are not upstream defects.', 'Text range order uses SQLite BINARY bytes in the actual database encoding.', 'Orange case-insensitive variants were not exercised; this runner uses its SQLite LIKE helpers.'],
};
async function check(tool, encoding, name, action) {
  commands = []; recording = true;
  let result, error;
  try { result = await action(); } catch (caught) { error = caught.message; } finally { recording = false; }
  report.cases.push({ tool, encoding, name, status: error ? 'fail' : 'pass', ...(error ? { error } : result), selectQueries: commands.filter(command => /^\s*select\b/i.test(command.sql)).length, commands });
}
let orange, orangeMap;
if (options['reference-dir']) {
  const require = createRequire(path.join(options['reference-dir'], 'package.json'));
  const orangePackage = JSON.parse(fs.readFileSync(path.join(options['reference-dir'], 'node_modules/orange-orm/package.json'), 'utf8'));
  assert.equal(orangePackage.version, '5.5.1');
  orange = (await import(pathToFileURL(require.resolve('orange-orm')).href)).default;
  report.environment.orange = orangePackage.version;
  report.environment.orangeEntry = 'Published npm CommonJS source export, explicitly resolved and dynamically imported';
  orangeMap = orange.map(x => ({ samples: x.table('samples').map(({ column: c }) => ({ id: c('id').numeric().primary(), label: c('label').string(), amount: c('amount').numeric() })) }));
} else report.limitations.push('Orange was not loaded. Pass --reference-dir for the pinned released-package comparisons.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rowstitch-expressions-'));
try {
  for (const [index, encoding] of encodings.entries()) {
    const file = path.join(directory, 'samples-' + index + '.sqlite');
    const raw = new DatabaseSync(file, { enableExtensions: false });
    let db, reference;
    try {
      raw.exec("PRAGMA encoding='" + encoding + "'; CREATE TABLE samples(id INTEGER NOT NULL, label TEXT, amount INTEGER, exact INTEGER, PRIMARY KEY(id))");
      assert.equal(raw.prepare('PRAGMA encoding').get().encoding, encoding);
      const insert = raw.prepare('INSERT INTO samples VALUES(?,?,?,?)');
      for (const row of fixture) insert.run(row.id, row.label, row.amount, row.exact);
      db = api.openDatabase(file, { tables: [table] });
      assert.deepEqual(db.planSchema(), []);
      reference = orangeMap?.sqlite(file, { size: 1, min: 1 });
      if (reference) { report.environment.orangeSQLite = String((await reference.query('SELECT sqlite_version() AS version'))[0].version); assert.equal(report.environment.orangeSQLite, process.versions.sqlite); }
      for (const [name, expression] of expressions) {
        const wanted = expected(expression, encoding);
        await check('raw node:sqlite + JS oracle', encoding, name, () => {
          const query = rawFilter(expression);
          const actual = raw.prepare('SELECT id FROM samples WHERE ' + query.sql + ' ORDER BY id').all(...query.parameters).map(row => row.id);
          assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual };
        });
        await check('rowstitch', encoding, name, () => {
          const actual = db.table(table).findMany({ where: mappedFilter(expression), select: ['id'] }).map(row => row.id);
          assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual };
        });
      }
      if (reference) {
        for (const [method, needle] of [['contains', 'alpha'], ['contains', '%'], ['contains', '_'], ['endsWith', '\\tail'], ['contains', 'B']]) {
          const pattern = (method !== 'startsWith' ? '%' : '') + needle + (method !== 'endsWith' ? '%' : '');
          const wanted = raw.prepare('SELECT id FROM samples WHERE label LIKE ? ORDER BY id').all(pattern).map(row => row.id);
          const literalIds = expected(literal(method, needle, 'ascii-insensitive'), encoding);
          await check('orange-orm@5.5.1', encoding, method + '.LIKE.' + JSON.stringify(needle), async () => {
            const actual = (await reference.samples.getMany({ where: x => x.label[method](needle), orderBy: 'id' })).map(row => row.id);
            assert.deepEqual(actual, wanted); return { expectedLikeIds: wanted, actualIds: actual, literalAsciiIds: literalIds };
          });
          if (JSON.stringify(wanted) !== JSON.stringify(literalIds)) report.contractDifferences.push({ encoding, method, needle, orangeLikeIds: wanted, literalAsciiIds: literalIds, note: 'Measured LIKE/literal contract difference, not an upstream defect' });
        }
        for (const [field, from, to] of [['amount', -1, 1], ['amount', 1, -1], ['label', 'Ā', '😀']]) {
          const wanted = expected(range(field, from, to), encoding);
          await check('orange-orm@5.5.1', encoding, 'between.' + field + '.' + String(from), async () => {
            const actual = (await reference.samples.getMany({ where: x => x[field].between(from, to), orderBy: 'id' })).map(row => row.id);
            assert.deepEqual(actual, wanted); return { expectedIds: wanted, actualIds: actual };
          });
        }
      }
    } finally {
      try { await reference?.close(); }
      finally { try { db?.close(); } finally { raw.close(); } }
    }
  }
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  const target = path.resolve(directory);
  assert(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('rowstitch-expressions-'));
  fs.rmSync(target, { recursive: true, force: true });
}
report.summary = { passed: report.cases.filter(item => item.status === 'pass').length, failed: report.cases.filter(item => item.status === 'fail').length, contractDifferences: report.contractDifferences.length };
const text = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? { bigint: String(value) } : value, 2) + '\n';
if (options.output) fs.writeFileSync(options.output, text);
process.stdout.write(text);
if (report.summary.failed) process.exitCode = 1;
