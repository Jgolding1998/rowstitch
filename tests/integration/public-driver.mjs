// Optional adapters against the real pg client, real PGlite, a scripted wire server and a pinned native PostgreSQL container.
// The adapters run from a fresh consumer holding ordinary copies of dist and the pinned peers, under a directory outside the checkout.
// Run npm run build first. Usage: node public-driver.mjs [label] [--no-docker|--require-native] [--compare]. Fictional data only.
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { runPublicApiCases } from './public-api.mjs';
import { runPublicComparisonCases } from './public-compare.mjs';
import { runPublicAggregateCases } from './public-aggregates.mjs';
import { runPublicAggregateComparisonCases } from './public-aggregate-compare.mjs';
import { runAggregateGuardCases } from './aggregate-guards.mjs';
import { runAggregateOperatorCases } from './aggregate-operators.mjs';
import { runAggregateCapacityCases } from './aggregate-capacity.mjs';
import { connectPgliteTransport } from './glue.mjs';

const args = process.argv.slice(2), knownFlags = new Set(['--no-docker', '--require-native', '--compare']);
for (const arg of args.filter(arg => arg.startsWith('--'))) assert.ok(knownFlags.has(arg), 'Unknown integration flag');
const labels = args.filter(arg => !arg.startsWith('--'));
assert.ok(labels.length <= 1, 'Pass at most one run label');
assert.equal(new Set(args.filter(arg => arg.startsWith('--'))).size, args.filter(arg => arg.startsWith('--')).length, 'Do not repeat integration flags');
const label = labels[0] ?? 'local';
assert.match(label, /^[a-z0-9-]{1,30}$/);
const useDocker = !args.includes('--no-docker'), requireNative = args.includes('--require-native'), compare = args.includes('--compare');
assert.ok(useDocker || !requireNative, '--require-native conflicts with --no-docker');
assert.ok(useDocker || !compare, '--compare requires native PostgreSQL and conflicts with --no-docker');

// BEGIN LOCAL DOCKER BOUNDARY: also exercised with a fake CLI in private preflight probes.
function dockerEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key.toUpperCase())) delete env[key];
  return env;
}
function dockerEnvValue(name) {
  const key = Object.keys(process.env).find(key => key.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}
function resolveLocalDockerEndpoint() {
  // Context inspection reads local CLI metadata. No daemon operation is allowed before endpoint validation.
  const context = dockerEnvValue('DOCKER_CONTEXT'), host = dockerEnvValue('DOCKER_HOST');
  let endpoint = host;
  if (context || !host) {
    const args = ['context', 'inspect', ...(context ? [context] : []), '--format', '{{json .Endpoints.docker.Host}}'];
    const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 64 << 10, env: dockerEnvironment() });
    if (result.status !== 0) return null;
    try { endpoint = JSON.parse(result.stdout); } catch { throw new Error('Docker endpoint metadata is invalid.'); }
  }
  const local = typeof endpoint === 'string' && endpoint.length <= 2048
    && (/^unix:\/\/\/[^\u0000-\u0020\u007f]+$/.test(endpoint) || /^npipe:\/{4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint));
  if (!local) throw new Error('A local Docker socket or named pipe is required.');
  return endpoint;
}
// Context takes precedence over HOST, matching Docker, but neither can reroute later pinned daemon calls.
const daemonEndpoint = useDocker ? resolveLocalDockerEndpoint() : null;
function docker(args, extraEnv = {}, input) {
  if (!daemonEndpoint) throw new Error('A validated local Docker endpoint is required.');
  const result = spawnSync('docker', ['--host', daemonEndpoint, ...args], { encoding: 'utf8', windowsHide: true,
    env: dockerEnvironment(extraEnv), input, timeout: args[0] === 'run' ? 180_000 : 60_000, maxBuffer: 8 << 20 });
  if (result.status !== 0) throw new Error('Owned Docker operation failed: ' + args[0]);
  return result.stdout.trim();
}
// END LOCAL DOCKER BOUNDARY.
const imageDigest = 'postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5';
const distSource = fileURLToPath(new URL('../../dist/', import.meta.url));
const peers = dirname(dirname(realpathSync(createRequire(import.meta.url).resolve('pg/package.json'))));
const outputParent = resolve(process.env.ROWSTITCH_TEST_OUTPUT_DIR ?? tmpdir());
const checkout = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
assert.ok(!(outputParent + sep).startsWith(checkout + sep), 'Keep fixtures outside the checkout');
mkdirSync(outputParent, { recursive: true });
const realOutputParent = realpathSync(outputParent);
assert.ok(!(realOutputParent + sep).startsWith(checkout + sep), 'Keep fixtures outside the checkout, including linked paths');
const outputDir = mkdtempSync(join(realOutputParent, 'rowstitch-driver-'));
const consumer = join(outputDir, 'consumer');
function removeOwnedDirectory(target) {
  const absolute = resolve(target), ownedRoot = realpathSync(outputDir);
  assert.ok(absolute.startsWith(ownedRoot + sep), 'Delete only this run\'s owned output child');
  assert.ok(!lstatSync(absolute).isSymbolicLink(), 'Never recursively delete a junction or symlink');
  assert.equal(realpathSync(absolute), absolute, 'Delete only the resolved ordinary directory');
  rmSync(absolute, { recursive: true, force: true });
}
mkdirSync(consumer);
cpSync(distSource, join(consumer, 'dist'), { recursive: true });
cpSync(peers, join(consumer, 'node_modules'), { recursive: true, dereference: true });
writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}');
const fromConsumer = name => import(pathToFileURL(join(consumer, 'dist', name)).href);
const { openPgExecutor } = await fromConsumer('adapters/pg.js');
const { openPgliteExecutor } = await fromConsumer('adapters/pglite.js');
const { createAsyncSession } = await fromConsumer('core/async-session.js');
const { isAcknowledgedRejection } = await fromConsumer('core/executor.js');
const { isPostgresRawResult } = await fromConsumer('core/postgres-result.js');
const sdk = await fromConsumer('index.js');
const { openPostgresDatabase } = await fromConsumer('postgres.js');
const { openPgliteDatabase } = await fromConsumer('pglite.js');
const { createPostgresExecutor } = await fromConsumer('core/postgres-executor.js');
const { captureNativeOpen } = await fromConsumer('core/native-open.js');
const { openPreparedAsyncDatabase } = await fromConsumer('core/async-database.js');
const { RepositoryCore } = await fromConsumer('core/repository-core.js');
const { createPostgresDialect } = await fromConsumer('core/postgres-dialect.js');
const hashOf = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function treeHashes(directory, suffix) {
  const entries = [];
  const visit = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + entry.name, file = join(path, entry.name);
      if (entry.isDirectory()) visit(file, key + '/');
      else if (entry.isFile() && key.endsWith(suffix)) entries.push([key, hashOf(file)]);
    }
  };
  visit(directory); return Object.fromEntries(entries);
}
const sourceHashes = treeHashes(join(checkout, 'src'), '.ts');
const compiledHashes = treeHashes(join(consumer, 'dist'), '.js');
assert.deepEqual(compiledHashes, treeHashes(distSource, '.js'), 'The consumer must hold the exact current compiled source');
const harnessNames = ['public-driver.mjs', 'public-api.mjs', 'public-compare.mjs', 'public-aggregates.mjs',
  'public-aggregate-compare.mjs', 'aggregate-guards.mjs', 'aggregate-operators.mjs', 'aggregate-capacity.mjs', 'glue.mjs'];
const harnessHashes = Object.fromEntries(harnessNames.map(name => [name, hashOf(fileURLToPath(new URL(name, import.meta.url)))]));
const adapterHashes = Object.fromEntries(readdirSync(join(consumer, 'dist/adapters')).filter(name => name.endsWith('.js')).sort().map(name => [name, hashOf(join(consumer, 'dist/adapters', name))]));
const report = { format: 'rowstitch-public-driver-checks', label, node: process.version, packages: { pg: '8.23.1', pglite: '0.5.15' }, imageDigest, adapterHashes, passed: [], skipped: [], failed: [],
  sourceHashes, compiledHashes, harnessHashes, requireNative, compare, publicApi: {}, publicAggregates: {}, aggregateGuards: {}, aggregateOperators: {}, aggregateCapacity: {}, cleanup: {},
  scope: 'Adapter boundary and actual public scalar/aggregate/group/projected ORM APIs on fictional fixtures, native PostgreSQL trigger/partition/restricted-login RLS controls, and explicitly separate inline PGlite malformed-storage/operator controls. Not full ORM parity, pools, replicas, managed services or a performance or reliability claim.' };
const password = randomBytes(32).toString('base64url');
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const code = wanted => error => { assert.equal(error.code, wanted); return true; };
const acknowledged = wanted => error => { assert.equal(error.code, wanted); assert.ok(isAcknowledgedRejection(error), 'Must be an acknowledged rejection'); return true; };
function checkedOperators(result) {
  assert.equal(result.status, 'passed'); assert.equal(result.setupError, undefined);
  assert.equal(result.failures.length, 0); assert.equal(result.cases.length, 13);
  assert.deepEqual(result.cleanup, { createdSchemas: 2, droppedSchemas: 2, searchPathRestored: true });
  return result;
}
const unconfirmed = error => { assert.ok(!isAcknowledgedRejection(error), 'Must not be acknowledged'); return true; };
const safe = error => { const text = String(error?.message) + String(error?.stack) + JSON.stringify(error ?? null); assert.ok(!text.includes(password), 'Must not expose the password'); assert.equal(error.cause, undefined); return true; };
async function step(name, fn) {
  try { await fn(); report.passed.push(name); process.stdout.write('ok   ' + name + '\n'); }
  catch (error) { report.failed.push(name); process.stdout.write('FAIL ' + name + ': ' + String(error?.message).replaceAll(password, '<password>').slice(0, 500) + '\n'); }
}
async function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const HOSTILE_ENV = { PGOPTIONS: '-c extra_float_digits=0 -c statement_timeout=1', PGCLIENT_ENCODING: 'LATIN1', PGAPPNAME: 'env-app', PGHOST: '192.0.2.1', PGPORT: '1', PGUSER: 'env_user', PGDATABASE: 'env_db', PGSSLMODE: 'require', PGSSLNEGOTIATION: 'direct', PGBINARY: 'true' };

// ---------- Real PGlite through the worker host ----------
await step('pglite public API: actual factory, scalar CRUD/filters/relations and unsupported boundaries (ten groups)', async () => {
  const result = await runPublicApiCases({ engine: 'pglite', sdk, openPgliteDatabase });
  assert.equal(result.cases.length, 10);
  assert.equal(result.cleanup.openedDatabases, result.cleanup.closedDatabases);
  report.publicApi.pglite = result;
});
await step('pglite public summaries: actual worker factory, root/group/related/projection and numeric boundaries', async () => {
  const result = await runPublicAggregateCases({ engine: 'pglite', sdk, openPgliteDatabase });
  assert.equal(result.cases.length, 17);
  assert.equal(result.cleanup.openedDatabases, result.cleanup.closedDatabases); assert.equal(result.cleanup.schemaDropped, true);
  report.publicAggregates.pglite = result;
});
await step('pglite inline native controls: malformed mapped storage, input guards and hostile operator lookup', async () => {
  const transport = await connectPgliteTransport();
  try {
    const executor = createPostgresExecutor(transport);
    // The fixture owns the physical connection; each ORM session borrows it until its namespace has been dropped.
    const borrowed = { all: (...args) => executor.all(...args), exec: (...args) => executor.exec(...args),
      inTransaction: () => executor.inTransaction(), async close() {} };
    const openDatabase = options => {
      const captured = captureNativeOpen(options, []);
      return openPreparedAsyncDatabase(borrowed, captured.database, captured.runtime);
    };
    const guarded = await runAggregateGuardCases({ engine: 'pglite-inline', sdk, openDatabase, admin: transport });
    assert.equal(guarded.cases.length, 14); assert.equal(guarded.cleanup.schemaDropped, true);
    assert.equal(guarded.cleanup.openedHandles, guarded.cleanup.closedHandles);
    report.aggregateGuards.pglite = guarded;
    report.aggregateOperators.pglite = checkedOperators(await runAggregateOperatorCases({ engine: 'pglite', sdk, RepositoryCore, createPostgresDialect, admin: transport }));
  } finally { await transport.close(); }
});
await step('pglite worker capacity: exact 10000-row ordinary and projected field boundaries', async () => {
  const executor = await openPgliteExecutor();
  try {
    const borrowed = { all: (...args) => executor.all(...args), exec: (...args) => executor.exec(...args),
      inTransaction: () => executor.inTransaction(), async close() {} };
    const openDatabase = options => {
      const captured = captureNativeOpen(options, []);
      return openPreparedAsyncDatabase(borrowed, captured.database, captured.runtime);
    };
    const result = await runAggregateCapacityCases({ engine: 'pglite-worker-adapter', sdk, openDatabase,
      admin: { query: (sql, parameters = []) => executor.all(sql, parameters) } });
    assert.equal(result.cases.length, 8); assert.equal(result.maxRawCells, 1_330_000);
    assert.deepEqual(result.cleanup, { schemaDropped: true, openedHandles: 1, closedHandles: 1 });
    report.aggregateCapacity.pglite = result;
  } finally { await executor.close(); }
});
await step('pglite: CRUD through the worker, with values read back through the same connection', async () => {
  const db = await openPgliteExecutor();
  try {
    await db.all('CREATE TABLE crud (id int8 PRIMARY KEY, label text NOT NULL, ratio float8, ok bool, doc jsonb)', []);
    const created = await db.all('INSERT INTO crud VALUES ($1::int8,$2::text,$3::float8,$4::bool,$5::jsonb) RETURNING id, label', ['9007199254740993', "O'Hara %_\\", '5e-324', 'true', '{"a":null}']);
    assert.deepEqual([created.command, created.rowCount, created.rows], ['INSERT', 1n, [['9007199254740993', "O'Hara %_\\"]]]);
    assert.deepEqual((await db.all('SELECT ratio, ok, doc FROM crud WHERE id=$1::int8', ['9007199254740993'])).rows, [['5e-324', 't', '{"a": null}']]);
    const updated = await db.all('UPDATE crud SET label=$1::text WHERE id=$2::int8 RETURNING label', ['changed', '9007199254740993']);
    assert.deepEqual([updated.command, updated.rowCount, updated.rows], ['UPDATE', 1n, [['changed']]]);
    const missing = await db.all('DELETE FROM crud WHERE id=$1::int8', ['1']);
    assert.deepEqual([missing.command, missing.rowCount], ['DELETE', 0n]);
    assert.equal((await db.all('DELETE FROM crud', [])).rowCount, 1n);
    await assert.rejects(db.all('INSERT INTO crud (id, label) VALUES ($1::int8, NULL)', ['fictional-value-not-a-number']), error => { assert.ok(isAcknowledgedRejection(error)); assert.ok(!(String(error.message) + String(error.stack)).includes('fictional-value')); return true; });
  } finally { await db.close(); }
});
await step('pglite: exact positional raw results, tags and transaction status through the worker', async () => {
  const db = await openPgliteExecutor();
  try {
    const typed = await db.all('SELECT $1::int8 AS a, $2::text AS a, NULL::float8 AS c, $3::jsonb AS d, $4::float8 AS e, true AS f', ['9223372036854775807', 'é🙂', '{"b":1,"a":[null]}', '-0']);
    assert.ok(isPostgresRawResult(typed));
    assert.deepEqual(typed.fields.map(f => [f.name, f.typeOid]), [['a', 20], ['a', 25], ['c', 701], ['d', 3802], ['e', 701], ['f', 16]]);
    assert.deepEqual(typed.rows, [['9223372036854775807', 'é🙂', null, '{"a": [null], "b": 1}', '-0', 't']]);
    await db.all('CREATE TABLE notes (id int8 PRIMARY KEY, body text NOT NULL)', []);
    const insert = await db.all('INSERT INTO notes VALUES (1,$1),(2,$2) RETURNING id', ['one', 'two']);
    assert.deepEqual([insert.command, insert.rowCount, insert.rows], ['INSERT', 2n, [['1'], ['2']]]);
    const update = await db.all('UPDATE notes SET body=$1', ['x']);
    assert.deepEqual([update.command, update.rowCount, update.fields, update.rows], ['UPDATE', 2n, [], []]);
    await db.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
    assert.equal(await db.inTransaction(), true);
    await db.exec('SAVEPOINT "s1"');
    await assert.rejects(db.all('INSERT INTO notes VALUES (1,$1)', ['dup']), acknowledged('CONSTRAINT'));
    assert.equal(await db.inTransaction(), true);
    await db.exec('ROLLBACK TO SAVEPOINT "s1"');
    await db.all('INSERT INTO notes VALUES (3,$1)', ['three']);
    await db.exec('COMMIT');
    assert.equal(await db.inTransaction(), false);
    assert.deepEqual((await db.all('SELECT count(*) FROM notes', [])).rows, [['3']]);
  } finally { await db.close(); }
});
await step('pglite: settings are confirmed on the engine, one Parse refuses scripts, and partial rows are never returned', async () => {
  const db = await openPgliteExecutor();
  try {
    assert.deepEqual((await db.all("SELECT current_setting('extra_float_digits'), current_setting('client_encoding'), current_setting('server_encoding')", [])).rows, [['3', 'UTF8', 'UTF8']]);
    await assert.rejects(db.all('SELECT 1; SELECT 2', []), acknowledged('DATABASE_ERROR'));
    await assert.rejects(db.all('SELECT 1/(n-2) FROM generate_series(1,3) n', []), acknowledged('DATABASE_ERROR'));
    assert.deepEqual((await db.all('SELECT 0.1::float8, 1e300::float8', [])).rows, [['0.1', '1e+300']]);
  } finally { await db.close(); }
});
await step('pglite: a deferred constraint failing at implicit commit is definite, and rolls the statement back', async () => {
  const db = await openPgliteExecutor();
  try {
    await db.all('CREATE TABLE parents (id int8 PRIMARY KEY)', []);
    await db.all('CREATE TABLE children (parent int8 REFERENCES parents DEFERRABLE INITIALLY DEFERRED)', []);
    await assert.rejects(db.all('INSERT INTO children VALUES (1)', []), acknowledged('CONSTRAINT'));
    assert.deepEqual((await db.all('SELECT count(*) FROM children', [])).rows, [['0']]);
  } finally { await db.close(); }
});
await step('pglite: a statement changing session state poisons rather than passes', async () => {
  const db = await openPgliteExecutor();
  try {
    await assert.rejects(db.all('SET extra_float_digits = 0', []), unconfirmed);
    await assert.rejects(db.all('SELECT 1', []), unconfirmed);
  } finally { await db.close(); }
});
await step('pglite: a deadline fires during a real blocking statement, the host loop runs, and the worker ends', async () => {
  const db = await openPgliteExecutor({ requestTimeoutMs: 300 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  await assert.rejects(db.all('SELECT count(*) FROM generate_series(1,2000000000)', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); return unconfirmed(error); });
  clearInterval(timer);
  assert.ok(Date.now() - started < 3000);
  assert.ok(ticks >= 10, 'The host event loop kept running: ' + ticks);
  await db.close();
  await assert.rejects(db.all('SELECT 1', []), code('CLOSED'));
});
/** Exit by itself proves nothing still holds the event loop: no worker thread, socket or timer. A hang is killed and fails. */
function runInConsumer(name, body, ms = 25_000) {
  const file = join(consumer, name + '.mjs');
  writeFileSync(file, body);
  return new Promise(ok => {
    const child = spawn(process.execPath, [file], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', killed = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, ms);
    child.once('exit', status => { clearTimeout(timer); ok({ status, killed, stdout: stdout.trim() }); });
  });
}
await step('pglite: real worker is released after close, and after a deadline with no close call', async () => {
  const closed = await runInConsumer('pglite-close', "import { openPgliteExecutor } from './dist/adapters/pglite.js'; const db = await openPgliteExecutor(); await db.all('SELECT 1', []); await db.close(); console.log('closed');");
  assert.deepEqual(closed, { status: 0, killed: false, stdout: 'closed' });
  const deadline = await runInConsumer('pglite-deadline', "import { openPgliteExecutor } from './dist/adapters/pglite.js'; const db = await openPgliteExecutor({ requestTimeoutMs: 300 }); await db.all('SELECT count(*) FROM generate_series(1,2000000000)', []).catch(error => console.log(error.code));");
  assert.deepEqual(deadline, { status: 0, killed: false, stdout: 'DRIVER_TIMEOUT' });
});
await step('peers: a consumer with no optional clients gets constant errors, and the SQLite entry still works', async () => {
  const bare = join(outputDir, 'bare');
  mkdirSync(bare);
  cpSync(distSource, join(bare, 'dist'), { recursive: true });
  writeFileSync(join(bare, 'package.json'), '{"type":"module","private":true}');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { openPgExecutor } = await import('./dist/adapters/pg.js');
    const { openPgliteExecutor } = await import('./dist/adapters/pglite.js');
    const { openDatabase, defineTable, column } = await import('./dist/index.js');
    const codes = [];
    await openPgExecutor({ host: 'localhost', user: 'u', database: 'd' }).catch(error => codes.push(error.code));
    await openPgliteExecutor().catch(error => codes.push(error.code));
    const notes = defineTable('notes', { id: column.integer().primaryKey({ generated: true }) });
    const db = openDatabase(':memory:', { tables: [notes] }); db.ensureSchema(); codes.push(db.table(notes).insert({}).id); db.close();
    console.log(JSON.stringify(codes));`], { cwd: bare, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), ['DRIVER_UNAVAILABLE', 'DRIVER_UNAVAILABLE', 1]);
  removeOwnedDirectory(bare);
});
await step('pglite: a generic session runs on the worker executor with commit and rollback', async () => {
  const session = createAsyncSession(await openPgliteExecutor(), { dialect: 'postgresql', isResult: isPostgresRawResult });
  try {
    await session.all('CREATE TABLE items (id int8 PRIMARY KEY)', []);
    await session.transaction(async tx => { await tx.all('INSERT INTO items VALUES (1)', []); });
    await assert.rejects(session.transaction(async tx => { await tx.all('INSERT INTO items VALUES (2)', []); throw new RangeError('fictional'); }), RangeError);
    await assert.rejects(session.transaction(async tx => { await tx.all('INSERT INTO items VALUES (1)', []); }), code('CONSTRAINT'));
    assert.deepEqual((await session.all('SELECT id FROM items', [])).rows, [['1']]);
  } finally { await session.close(); }
});
await step('pglite: ambient environment and engine notices do not reach the host', async () => {
  let printed = '';
  const write = process.stdout.write, errorWrite = process.stderr.write;
  process.stdout.write = chunk => { printed += chunk; return true; };
  process.stderr.write = chunk => { printed += chunk; return true; };
  try {
    await withEnv(HOSTILE_ENV, async () => {
      const db = await openPgliteExecutor();
      await db.all("DO $$ BEGIN RAISE NOTICE 'fictional-notice-value'; RAISE WARNING 'fictional-warning-value'; END $$", []);
      assert.deepEqual((await db.all("SELECT current_setting('extra_float_digits')", [])).rows, [['3']]);
      await db.close();
    });
  } finally { process.stdout.write = write; process.stderr.write = errorWrite; }
  assert.ok(!printed.includes('fictional-'), 'Engine output must stay in the worker');
});

// ---------- Real pg client against a scripted wire server ----------
const textOid = 25;
function frame(type, ...parts) {
  const body = Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part + '\0') : part));
  const length = Buffer.alloc(4); length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const int32 = value => { const out = Buffer.alloc(4); out.writeInt32BE(value); return out; };
const int16 = value => { const out = Buffer.alloc(2); out.writeInt16BE(value); return out; };
const wire = {
  auth: () => frame('R', int32(0)), key: () => frame('K', int32(4242), int32(987654)), ready: (status = 'I') => frame('Z', Buffer.from(status)), parseOk: () => frame('1'), bindOk: () => frame('2'), noData: () => frame('n'),
  parameter: (name, value) => frame('S', name, value), tag: text => frame('C', text),
  fields: names => frame('T', int16(names.length), ...names.flatMap(name => [Buffer.from(name + '\0'), int32(0), int16(0), int32(textOid), int16(-1), int32(-1), int16(0)])),
  row: values => frame('D', int16(values.length), ...values.flatMap(value => { const data = Buffer.from(value); return [int32(data.length), data]; })),
  error: (severity, sqlstate, message) => frame('E', Buffer.from('S' + severity + '\0V' + severity + '\0C' + sqlstate + '\0M' + message + '\0\0')),
};
const SETTINGS = { client_encoding: 'UTF8', server_encoding: 'UTF8', extra_float_digits: '3', server_version_num: '180006' };
/** Speaks enough protocol for one connection at a time. `answer(sql, socket)` writes everything after ParseComplete and BindComplete. */
function scriptedServer({ answer = () => {}, onConnection, onSslRequest, settings = {} } = {}) {
  const seen = { startups: [], cancels: [], sql: [], terminates: 0, connections: 0, socketsClosed: 0 };
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); seen.connections++;
    socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); seen.socketsClosed++; });
    if (onConnection?.(socket) === false) return;
    let buffer = Buffer.alloc(0), started = false, sql, wanted = [];
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const codeValue = buffer.readInt32BE(4), body = buffer.subarray(8, length);
          buffer = buffer.subarray(length);
          if (codeValue === 80877103) { (onSslRequest ?? (s => s.write('N')))(socket); continue; }
          if (codeValue === 80877102) { seen.cancels.push([body.readInt32BE(0), body.readInt32BE(4)]); socket.end(); return; }
          const items = body.toString().split('\0'), params = {};
          for (let i = 0; i + 1 < items.length && items[i]; i += 2) params[items[i]] = items[i + 1];
          seen.startups.push(params); started = true;
          socket.write(Buffer.concat([wire.auth(), wire.parameter('client_encoding', 'UTF8'), wire.key(), wire.ready()]));
          continue;
        }
        if (buffer.length < 5) return;
        const length = buffer.readInt32BE(1) + 1;
        if (buffer.length < length) return;
        const type = String.fromCharCode(buffer[0]), body = buffer.subarray(5, length);
        buffer = buffer.subarray(length);
        if (type === 'P') { const parts = body.toString().split('\0'); sql = parts[1]; seen.sql.push(sql); }
        if (type === 'B') wanted = (/\{([a-z_,]+)\}/.exec(body.toString()) ?? [])[1]?.split(',') ?? [];
        if (type === 'X') { seen.terminates++; socket.end(); return; }
        if (type === 'S') {
          socket.write(Buffer.concat([wire.parseOk(), wire.bindOk()]));
          if (sql.includes('pg_settings')) {
            // Like the real catalog: only the names asked for, and only if this server has them.
            const values = { ...SETTINGS, ...settings }, rows = wanted.filter(name => values[name] !== undefined).map(name => [name, values[name]]);
            socket.write(Buffer.concat([wire.fields(['name', 'setting']), ...rows.map(row => wire.row(row)), wire.tag('SELECT ' + rows.length), wire.ready()]));
          }
          else answer(sql, socket);
        }
      }
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, seen, close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }) })));
}
const scriptedOptions = port => ({ host: '127.0.0.1', port, user: 'app_user', database: 'app_db', password, connectTimeoutMs: 2000 });

await step('pg wire: real startup carries library settings despite hostile environment', async () => {
  const server = await scriptedServer({ answer: (sql, socket) => socket.write(Buffer.concat([wire.noData(), wire.tag('SELECT 0'), wire.ready()])) });
  try {
    const db = await withEnv(HOSTILE_ENV, () => openPgExecutor({ ...scriptedOptions(server.port), statementTimeoutMs: 0, lockTimeoutMs: 7 }).catch(error => { if (error.code !== 'OPEN') throw error; return error; }));
    const [startup] = server.seen.startups;
    assert.equal(startup.options, '-c extra_float_digits=3 -c client_encoding=UTF8 -c statement_timeout=0 -c lock_timeout=7');
    assert.equal(startup.user, 'app_user');
    assert.equal(startup.database, 'app_db');
    assert.equal(startup.application_name, 'rowstitch');
    assert.equal(startup.client_encoding, 'UTF8');
    assert.equal(startup.replication, undefined);
    assert.ok(db.code === 'OPEN', 'This fixture does not echo the requested timeouts, so opening must refuse');
  } finally { await server.close(); }
});
await step('pg wire: control shows the same environment does reach an unprotected pg client', async () => {
  const server = await scriptedServer();
  try {
    await withEnv({ PGOPTIONS: HOSTILE_ENV.PGOPTIONS, PGAPPNAME: HOSTILE_ENV.PGAPPNAME }, async () => {
      const client = new pg.Client({ host: '127.0.0.1', port: server.port, user: 'u', database: 'd', ssl: false });
      client.on('error', () => {});
      await client.connect();
      await client.end();
    });
    assert.equal(server.seen.startups[0].options, HOSTILE_ENV.PGOPTIONS);
    assert.equal(server.seen.startups[0].application_name, HOSTILE_ENV.PGAPPNAME);
  } finally { await server.close(); }
});
await step('pg wire: real exact tag, count wider than Number, duplicate names and ignored notices', async () => {
  const server = await scriptedServer({ answer: (sql, socket) => {
    if (sql === 'WIDE') socket.write(Buffer.concat([wire.noData(), wire.tag('UPDATE 9007199254740993'), wire.ready()]));
    else socket.write(Buffer.concat([wire.fields(['a', 'a']), frame('N', Buffer.from('SNOTICE\0Mfictional\0\0')), wire.row(['1', '2']), wire.tag('SELECT 1'), wire.ready()]));
  } });
  try {
    const db = await openPgExecutor(scriptedOptions(server.port));
    assert.equal((await db.all('WIDE', [])).rowCount, 9007199254740993n);
    assert.deepEqual((await db.all('DUPLICATE', [])).rows, [['1', '2']]);
    await db.close();
  } finally { await server.close(); }
});
await step('pg wire: real pg abnormal exchanges are never acknowledged', async () => {
  const scripts = {
    fatalThenClose: socket => { socket.write(wire.error('FATAL', '57P01', 'fictional')); socket.end(); },
    errorNoReady: socket => { socket.write(wire.error('ERROR', '42601', 'fictional')); setTimeout(() => socket.destroy(), 20); },
    twoTags: socket => socket.write(Buffer.concat([wire.noData(), wire.tag('SELECT 0'), wire.tag('SELECT 0'), wire.ready()])),
    twoReady: socket => socket.write(Buffer.concat([wire.noData(), wire.tag('SELECT 0'), wire.ready(), wire.ready()])),
    tagAfterError: socket => socket.write(Buffer.concat([wire.error('ERROR', '42601', 'fictional'), wire.tag('SELECT 0'), wire.ready()])),
    twoErrors: socket => socket.write(Buffer.concat([wire.error('ERROR', '42601', 'fictional'), wire.error('ERROR', '42601', 'fictional'), wire.ready()])),
    badStatus: socket => socket.write(Buffer.concat([wire.noData(), wire.tag('SELECT 0'), wire.ready('X')])),
    encodingChange: socket => socket.write(Buffer.concat([wire.parameter('client_encoding', 'LATIN1'), wire.noData(), wire.tag('SELECT 0'), wire.ready()])),
    malformedTag: socket => socket.write(Buffer.concat([wire.noData(), wire.tag('select 1'), wire.ready()])),
    reset: socket => socket.destroy(),
  };
  for (const [name, script] of Object.entries(scripts)) {
    const server = await scriptedServer({ answer: (sql, socket) => script(socket) });
    try {
      const db = await openPgExecutor({ ...scriptedOptions(server.port), requestTimeoutMs: 500 });
      await assert.rejects(db.all('SELECT fictional', []), error => { assert.ok(unconfirmed(error), name); return safe(error); }, name);
      await assert.rejects(db.all('SELECT fictional', []), unconfirmed, name);
      await db.close().catch(() => {});
    } finally { await server.close(); }
  }
  // Unsolicited traffic between requests.
  for (const [name, bytes] of Object.entries({ ready: wire.ready(), tag: wire.tag('SELECT 0'), fatal: wire.error('FATAL', '57P01', 'fictional') })) {
    let remote;
    const server = await scriptedServer({ onConnection: socket => { remote = socket; }, answer: (sql, socket) => socket.write(Buffer.concat([wire.noData(), wire.tag('SELECT 0'), wire.ready()])) });
    try {
      const db = await openPgExecutor(scriptedOptions(server.port));
      remote.write(bytes);
      await pause(30);
      await assert.rejects(db.all('SELECT fictional', []), unconfirmed, name);
      await db.close().catch(() => {});
    } finally { await server.close(); }
  }
  // The control: the same server, an ordinary rejection.
  const server = await scriptedServer({ answer: (sql, socket) => socket.write(Buffer.concat([wire.error('ERROR', '23505', 'fictional-' + password), wire.ready()])) });
  try {
    const db = await openPgExecutor(scriptedOptions(server.port));
    await assert.rejects(db.all('INSERT fictional', []), error => { acknowledged('CONSTRAINT')(error); return safe(error); });
    assert.equal(await db.inTransaction(), false);
    await db.close();
  } finally { await server.close(); }
});
await step('pg wire: a client deadline sends one real CancelRequest with the backend key and closes', async () => {
  const server = await scriptedServer();
  try {
    const db = await openPgExecutor({ ...scriptedOptions(server.port), requestTimeoutMs: 100 });
    await assert.rejects(db.all('SELECT fictional', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); return unconfirmed(error); });
    await db.close();
    assert.deepEqual(server.seen.cancels, [[4242, 987654]]);
    assert.equal(server.seen.sql.filter(sql => sql === 'SELECT fictional').length, 1, 'Never replayed');
  } finally { await server.close(); }
});
await step('pg wire: open is bounded and constant for a silent server, a refused port and a refused TLS upgrade', async () => {
  const silent = await scriptedServer({ onConnection: () => false });
  try {
    const started = Date.now();
    await assert.rejects(openPgExecutor({ ...scriptedOptions(silent.port), connectTimeoutMs: 150 }), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); return safe(error); });
    assert.ok(Date.now() - started < 1500);
  } finally { await silent.close(); }
  const closed = await scriptedServer();
  const { port } = closed; await closed.close();
  await assert.rejects(openPgExecutor(scriptedOptions(port)), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
  const plain = await scriptedServer();
  try {
    await assert.rejects(openPgExecutor({ ...scriptedOptions(plain.port), ssl: true }), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
    assert.deepEqual(plain.seen.startups, [], 'A refused upgrade never falls back to clear text');
  } finally { await plain.close(); }
});
await step('pg wire: real pg takes client certificate options to the wire; control shows it refuses a frozen key', async () => {
  // Why the adapter must not hand pg its frozen snapshot: the real constructor redefines ssl.key in place.
  assert.throws(() => new pg.Client({ host: '127.0.0.1', port: 1, user: 'app_user', database: 'app_db', password: () => undefined, ssl: Object.freeze({ cert: 'c', key: 'k' }) }), TypeError);
  assert.ok(new pg.Client({ host: '127.0.0.1', port: 1, user: 'app_user', database: 'app_db', password: () => undefined, ssl: { cert: 'c', key: 'k' } }));
  const plain = await scriptedServer();
  try {
    const caller = Object.freeze({ cert: 'fictional certificate text', key: 'fictional key text' });
    await assert.rejects(openPgExecutor({ ...scriptedOptions(plain.port), ssl: caller }), error => {
      assert.equal(error.code, 'OPEN'); assert.ok(!String(error.stack).includes('fictional key text')); return safe(error);
    });
    // The upgrade was asked for, and refused: so the real client was constructed and really dialled.
    assert.equal(plain.seen.connections, 1, 'The real client must reach the server');
    assert.deepEqual(plain.seen.startups, [], 'A refused upgrade never falls back to clear text');
    assert.equal(Object.getOwnPropertyDescriptor(caller, 'key').enumerable, true);
  } finally { await plain.close(); }
});
await step('pg wire: requested settings must be confirmed: missing or different values refuse and release the connection', async () => {
  for (const [settings, works] of [[{}, false], [{ statement_timeout: '6' }, false], [{ statement_timeout: '5' }, true]]) {
    const server = await scriptedServer({ settings });
    try {
      const attempt = openPgExecutor({ ...scriptedOptions(server.port), statementTimeoutMs: 5 });
      if (works) await (await attempt).close();
      else await assert.rejects(attempt, error => { assert.equal(error.code, 'OPEN'); return safe(error); });
      for (let i = 0; i < 100 && server.seen.socketsClosed < 1; i++) await pause(10);
      assert.equal(server.seen.socketsClosed, 1, 'The connection was released');
    } finally { await server.close(); }
  }
  // Library-owned settings are confirmed the same way.
  for (const settings of [{ extra_float_digits: '1' }, { client_encoding: 'LATIN1' }, { server_encoding: 'SQL_ASCII' }, { server_version_num: '110000' }]) {
    const server = await scriptedServer({ settings });
    try { await assert.rejects(openPgExecutor(scriptedOptions(server.port)), code('OPEN')); } finally { await server.close(); }
  }
});
await step('pg wire: release is real: close sends Terminate, and a deadline with no close call lets the process exit', async () => {
  const orderly = await scriptedServer();
  try {
    await (await openPgExecutor(scriptedOptions(orderly.port))).close();
    for (let i = 0; i < 100 && !orderly.seen.socketsClosed; i++) await pause(10);
    assert.deepEqual([orderly.seen.terminates, orderly.seen.socketsClosed, orderly.seen.cancels], [1, 1, []]);
  } finally { await orderly.close(); }
  const server = await scriptedServer();
  try {
    const child = await runInConsumer('pg-deadline', "import { openPgExecutor } from './dist/adapters/pg.js'; const db = await openPgExecutor({ host: '127.0.0.1', port: " + server.port + ", user: 'u', database: 'd', requestTimeoutMs: 100 }); await db.all('SELECT fictional', []).catch(error => console.log(error.code));");
    assert.deepEqual(child, { status: 0, killed: false, stdout: 'DRIVER_TIMEOUT' });
    assert.deepEqual(server.seen.cancels, [[4242, 987654]]);
    assert.equal(server.seen.sql.filter(sql => sql === 'SELECT fictional').length, 1);
  } finally { await server.close(); }
});

// ---------- Native PostgreSQL ----------
const dockerLabel = 'rowstitch-driver-' + randomBytes(6).toString('hex');
let container;
async function native() {
  container = docker(['run', '--detach', '--name', dockerLabel, '--label', 'org.rowstitch.session=' + dockerLabel, '--memory', '256m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/var/lib/postgresql:rw,size=128m', '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=driver_checks', '--env', 'POSTGRES_INITDB_ARGS=--no-locale --encoding=UTF8 --auth-host=scram-sha-256', imageDigest, '-c', 'shared_buffers=16MB', '-c', 'max_connections=20'], { POSTGRES_PASSWORD: password });
  const inspected = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(inspected.Config.Labels['org.rowstitch.session'], dockerLabel);
  // The image declares a volume at this path. The tmpfs must take its place, so no anonymous volume outlives this run.
  assert.deepEqual(inspected.Mounts.filter(mount => mount.Type === 'volume'), [], 'This fixture must not create a volume');
  assert.ok(Object.hasOwn(inspected.HostConfig.Tmpfs, '/var/lib/postgresql'));
  const port = Number(inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const base = { host: '127.0.0.1', port, user: 'postgres', database: 'driver_checks' };
  const options = { ...base, password, connectTimeoutMs: 5000 };
  let admin;
  for (let i = 0; i < 150 && !admin; i++) {
    const client = new pg.Client({ ...base, password, connectionTimeoutMillis: 1000, ssl: false });
    client.on('error', () => {});
    try { await client.connect(); admin = client; } catch { await client.end().catch(() => {}); await pause(200); }
  }
  assert.ok(admin, 'PostgreSQL did not start');
  const backend = async name => (await admin.query('SELECT pid, state, wait_event FROM pg_stat_activity WHERE application_name=$1', [name])).rows;
  const until = async (test, ms = 5000) => { const end = Date.now() + ms; for (; Date.now() < end; await pause(50)) if (await test()) return true; return false; };
  report.serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
  report.cleanup.docker = { localEndpointValidated: true, pinnedEndpoint: true, ownedLabelVerified: true, anonymousVolumes: 0, tmpfsData: true, removedContainers: 0, remainingContainers: null };
  const publicAdmin = { query: (text, values = []) => admin.query({ text, values, rowMode: 'array', types: { getTypeParser: () => value => value } }) };
  await step('native public API: scalar CRUD/filters/relations plus trusted triggers/partitions/restricted-login RLS (fourteen groups)', async () => {
    const result = await runPublicApiCases({ engine: 'postgresql', sdk, openPostgresDatabase, postgresOptions: { ...options, ssl: false }, admin: publicAdmin });
    assert.equal(result.cases.length, 14);
    assert.equal(result.cleanup.openedDatabases, result.cleanup.closedDatabases);
    assert.equal(result.cleanup.schemaDropped, true); assert.equal(result.cleanup.roleDropped, true);
    report.publicApi.postgresql = result;
  });
  await step('native public summaries: actual PostgreSQL factory, root/group/related/projection and numeric boundaries', async () => {
    report.publicAggregates.postgresql = await runPublicAggregateCases({ engine: 'postgresql', sdk, openPostgresDatabase,
      postgresOptions: { ...options, ssl: false }, admin: publicAdmin });
    assert.equal(report.publicAggregates.postgresql.cases.length, 18);
    assert.equal(report.publicAggregates.postgresql.cleanup.openedDatabases, report.publicAggregates.postgresql.cleanup.closedDatabases);
    assert.equal(report.publicAggregates.postgresql.cleanup.schemaDropped, true);
  });
  await step('native aggregate controls: malformed mapped storage and hidden invalid inputs', async () => {
    const result = await runAggregateGuardCases({ engine: 'postgresql', sdk,
      openDatabase: orm => openPostgresDatabase({ ...options, ssl: false, ...orm }), admin: publicAdmin });
    assert.equal(result.cases.length, 14); assert.equal(result.cleanup.schemaDropped, true);
    assert.equal(result.cleanup.openedHandles, result.cleanup.closedHandles); report.aggregateGuards.postgresql = result;
  });
  await step('native aggregate controls: hostile operators and declared text collation', async () => {
    report.aggregateOperators.postgresql = checkedOperators(await runAggregateOperatorCases({ engine: 'postgresql', sdk, RepositoryCore, createPostgresDialect, admin: publicAdmin }));
  });
  await step('native aggregate capacity: exact 10000-row ordinary and projected field boundaries', async () => {
    const result = await runAggregateCapacityCases({ engine: 'postgresql', sdk,
      openDatabase: orm => openPostgresDatabase({ ...options, ssl: false, ...orm }), admin: publicAdmin });
    assert.equal(result.cases.length, 8); assert.equal(result.maxRawCells, 1_330_000);
    assert.deepEqual(result.cleanup, { schemaDropped: true, openedHandles: 1, closedHandles: 1 });
    report.aggregateCapacity.postgresql = result;
  });
  if (compare) await step('native comparison: pinned Orange ORM and Kysely on the same owned PostgreSQL engine', async () => {
    // References have their own peer tree: Orange's older optional PGlite peer must not replace the tested 0.5.15 peer.
    const references = createRequire(new URL('../comparison/package.json', import.meta.url));
    const entries = Object.fromEntries(['orange-orm', 'kysely', 'pg'].map(name => [name, realpathSync(references.resolve(name))]));
    function installedVersion(name, entry) {
      let directory = dirname(entry);
      for (let depth = 0; depth < 10; depth++) {
        try { const info = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (info.name === name) return info.version; } catch {}
        const parent = dirname(directory); if (parent === directory) break; directory = parent;
      }
      throw new Error('Comparison package metadata is unavailable.');
    }
    const versions = { orange: installedVersion('orange-orm', entries['orange-orm']), kysely: installedVersion('kysely', entries.kysely), pg: installedVersion('pg', entries.pg) };
    assert.deepEqual(versions, { orange: '5.5.1', kysely: '0.29.8', pg: '8.23.1' });
    const comparisonPg = references('pg');
    assert.equal(createRequire(entries['orange-orm'])('pg'), comparisonPg, 'Orange must use the exact supplied comparison pg copy');
    const orange = (await import(pathToFileURL(entries['orange-orm']).href)).default;
    const kysely = await import(pathToFileURL(entries.kysely).href);
    const parser = comparisonPg.types.getTypeParser(1700, 'text');
    const result = await runPublicComparisonCases({ sdk, openPostgresDatabase, postgresOptions: { ...options, ssl: false }, admin: publicAdmin,
      orange, kysely, pg: comparisonPg, versions });
    report.comparison = result;
    assert.equal(comparisonPg.types.getTypeParser(1700, 'text'), parser, 'Reference NUMERIC parser must be restored');
    assert.equal(result.cases.length, 42);
    assert.deepEqual(result.summary, { pass: 40, difference: 2, fail: 0, unsupported: 0 });
    assert.deepEqual(result.cleanup, { openedHandles: 3, closedHandles: 3, schemasDropped: 3 });
    const aggregateResult = await runPublicAggregateComparisonCases({ sdk, openPostgresDatabase,
      postgresOptions: { ...options, ssl: false }, admin: publicAdmin, orange, kysely, pg: comparisonPg, versions });
    report.aggregateComparison = aggregateResult;
    assert.equal(comparisonPg.types.getTypeParser(1700, 'text'), parser, 'Aggregate comparison must restore the reference NUMERIC parser');
    assert.equal(aggregateResult.cases.length, 30);
    assert.deepEqual(aggregateResult.summary, { pass: 20, difference: 10, fail: 0 });
    assert.deepEqual(aggregateResult.cleanup, { openedHandles: 3, closedHandles: 3, schemasDropped: 3 });
  });
  await admin.query('CREATE TABLE ledger (id int8 PRIMARY KEY, note text)');
  await admin.query('CREATE ROLE app_role LOGIN PASSWORD ' + pg.escapeLiteral(password) + " IN ROLE pg_read_all_stats");
  await admin.query('GRANT ALL ON ledger TO app_role');
  await admin.query('GRANT CREATE ON SCHEMA public TO app_role');
  await admin.query('ALTER ROLE app_role SET extra_float_digits = 0');
  await admin.query('ALTER ROLE app_role SET statement_timeout = 123456');
  await admin.query('ALTER ROLE app_role SET client_encoding = LATIN1');
  const appOptions = { ...options, user: 'app_role' };

  await step('native: opens by fields and by URI, with settings the server reports', async () => {
    for (const open of [() => openPgExecutor(options), () => openPgExecutor({ connectionString: 'postgres://postgres:' + encodeURIComponent(password) + '@127.0.0.1:' + port + '/driver_checks?sslmode=disable' })]) {
      const db = await open();
      assert.deepEqual((await db.all("SELECT current_setting('extra_float_digits'), current_setting('client_encoding'), current_setting('application_name'), (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid())", [])).rows, [['3', 'UTF8', 'rowstitch', 'f']]);
      await db.close();
    }
  });
  await step('native: startup settings beat hostile environment and role defaults, and a role timeout stays unless requested', async () => {
    const db = await withEnv(HOSTILE_ENV, () => openPgExecutor(appOptions));
    assert.deepEqual((await db.all("SELECT current_setting('extra_float_digits'), current_setting('client_encoding'), current_user", [])).rows, [['3', 'UTF8', 'app_role']]);
    assert.deepEqual((await db.all("SELECT setting FROM pg_settings WHERE name='statement_timeout'", [])).rows, [['123456']]);
    await db.close();
    const zero = await openPgExecutor({ ...appOptions, statementTimeoutMs: 0, lockTimeoutMs: 1500, idleInTransactionTimeoutMs: 60000, transactionTimeoutMs: 90000 });
    assert.deepEqual((await zero.all("SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','transaction_timeout') ORDER BY name", [])).rows, [['idle_in_transaction_session_timeout', '60000'], ['lock_timeout', '1500'], ['statement_timeout', '0'], ['transaction_timeout', '90000']]);
    await zero.close();
  });
  await step('native: control shows role defaults and a URI query do override an unprotected pg client', async () => {
    const role = new pg.Client({ ...base, user: 'app_role', password, ssl: false });
    role.on('error', () => {});
    await role.connect();
    assert.equal((await role.query("SELECT current_setting('extra_float_digits') AS v")).rows[0].v, '0');
    await role.end();
    const uri = new pg.Client({ connectionString: 'postgres://postgres:' + encodeURIComponent(password) + '@127.0.0.1:' + port + '/driver_checks?sslmode=disable&options=-c%20extra_float_digits%3D-1', options: '-c extra_float_digits=3' });
    uri.on('error', () => {});
    await uri.connect();
    assert.equal((await uri.query("SELECT current_setting('extra_float_digits') AS v")).rows[0].v, '-1', 'The URI overrode explicit config');
    await uri.end();
    await assert.rejects(openPgExecutor({ connectionString: 'postgres://postgres:' + encodeURIComponent(password) + '@127.0.0.1:' + port + '/driver_checks?sslmode=disable&options=-c%20extra_float_digits%3D-1' }), error => { assert.equal(error.code, 'VALIDATION'); return safe(error); });
  });
  await step('native: a wrong or missing password fails with one constant error, and PGPASSWORD is never used', async () => {
    await assert.rejects(openPgExecutor({ ...options, password: 'not-' + password }), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
    await withEnv({ PGPASSWORD: password }, async () => {
      await assert.rejects(openPgExecutor(base), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
      const control = new pg.Client({ ...base, ssl: false });
      control.on('error', () => {});
      await control.connect();
      await control.end();
    });
    await assert.rejects(openPgExecutor({ ...options, database: 'fictional_missing' }), code('OPEN'));
    await assert.rejects(openPgExecutor({ ...options, transactionTimeoutMs: -1 }), code('VALIDATION'));
  });
  await step('native: a close releases its backend, observed from another connection', async () => {
    const name = 'driver-close';
    const db = await openPgExecutor({ ...options, applicationName: name });
    await db.all('SELECT 1', []);
    assert.equal((await backend(name)).length, 1);
    await db.close();
    assert.ok(await until(async () => (await backend(name)).length === 0, 5000));
  });
  await step('native: CRUD through the adapter, with exact tags and values read back independently', async () => {
    const db = await openPgExecutor(options);
    try {
      await db.all('CREATE TABLE crud (id int8 PRIMARY KEY, label text NOT NULL, ratio float8, ok bool, doc jsonb)', []);
      const created = await db.all('INSERT INTO crud VALUES ($1::int8,$2::text,$3::float8,$4::bool,$5::jsonb) RETURNING id, label', ['9007199254740993', "O'Hara %_\\", '5e-324', 'true', '{"a":null}']);
      assert.deepEqual([created.command, created.rowCount, created.rows], ['INSERT', 1n, [['9007199254740993', "O'Hara %_\\"]]]);
      assert.deepEqual((await db.all('SELECT ratio, ok, doc FROM crud WHERE id=$1::int8', ['9007199254740993'])).rows, [['5e-324', 't', '{"a": null}']]);
      const updated = await db.all('UPDATE crud SET label=$1::text WHERE id=$2::int8 RETURNING label', ['changed', '9007199254740993']);
      assert.deepEqual([updated.command, updated.rowCount, updated.rows], ['UPDATE', 1n, [['changed']]]);
      assert.deepEqual((await admin.query('SELECT label, id::text FROM crud')).rows, [{ label: 'changed', id: '9007199254740993' }]);
      const missing = await db.all('DELETE FROM crud WHERE id=$1::int8', ['1']);
      assert.deepEqual([missing.command, missing.rowCount], ['DELETE', 0n]);
      assert.equal((await db.all('DELETE FROM crud', [])).rowCount, 1n);
    } finally { await db.close(); }
  });
  await step('native: exact tags, exact types and transaction states through the real connection', async () => {
    const db = await openPgExecutor(options);
    try {
      const typed = await db.all('SELECT $1::int8 AS a, $2::text AS a, NULL::float8 AS c, $3::jsonb AS d, $4::float8 AS e, true AS f', ['9223372036854775807', 'é🙂', '{"b":1}', '-0']);
      assert.deepEqual(typed.fields.map(f => [f.name, f.typeOid]), [['a', 20], ['a', 25], ['c', 701], ['d', 3802], ['e', 701], ['f', 16]]);
      assert.deepEqual(typed.rows, [['9223372036854775807', 'é🙂', null, '{"b": 1}', '-0', 't']]);
      const insert = await db.all('INSERT INTO ledger VALUES ($1,$2),($3,$4) RETURNING id', ['1', 'a', '2', 'b']);
      assert.deepEqual([insert.command, insert.rowCount], ['INSERT', 2n]);
      assert.deepEqual([(await db.all('DELETE FROM ledger', [])).rowCount], [2n]);
      await db.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await db.exec('SAVEPOINT "s1"');
      await assert.rejects(db.all('SELECT 1/0', []), acknowledged('DATABASE_ERROR'));
      assert.equal(await db.inTransaction(), true);
      await db.exec('ROLLBACK TO SAVEPOINT "s1"');
      await db.exec('COMMIT');
      assert.equal(await db.inTransaction(), false);
      await assert.rejects(db.all('SELECT 1; SELECT 2', []), acknowledged('DATABASE_ERROR'));
      await assert.rejects(db.all('SELECT 1/(n-2) FROM generate_series(1,3) n', []), acknowledged('DATABASE_ERROR'));
    } finally { await db.close(); }
  });
  await step('native: server timeouts are real and classified: statement, lock, idle transaction, transaction', async () => {
    const statement = await openPgExecutor({ ...options, statementTimeoutMs: 100 });
    await assert.rejects(statement.all('SELECT pg_sleep(5)', []), acknowledged('DATABASE_ERROR'));
    assert.deepEqual((await statement.all('SELECT 1', [])).rows, [['1']]);
    await statement.close();
    const holder = await openPgExecutor(options), waiter = await openPgExecutor({ ...options, lockTimeoutMs: 100 });
    await holder.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await holder.all('LOCK TABLE ledger IN ACCESS EXCLUSIVE MODE', []);
    await assert.rejects(waiter.all('SELECT * FROM ledger', []), acknowledged('BUSY'));
    await holder.exec('ROLLBACK');
    await holder.close(); await waiter.close();
    const idle = await openPgExecutor({ ...options, idleInTransactionTimeoutMs: 100 });
    await idle.exec('BEGIN READ ONLY');
    await pause(500);
    await assert.rejects(idle.all('SELECT 1', []), unconfirmed);
    await assert.rejects(idle.all('SELECT 1', []), unconfirmed);
    await idle.close().catch(() => {});
    const whole = await openPgExecutor({ ...options, transactionTimeoutMs: 100 });
    await whole.exec('BEGIN READ ONLY');
    await assert.rejects(whole.all('SELECT pg_sleep(5)', []), unconfirmed);
    await whole.close().catch(() => {});
  });
  await step('native: a deferred constraint failing at implicit commit is definite and leaves no row', async () => {
    const db = await openPgExecutor(options);
    try {
      await db.all('CREATE TABLE parents (id int8 PRIMARY KEY)', []);
      await db.all('CREATE TABLE children (parent int8 REFERENCES parents DEFERRABLE INITIALLY DEFERRED)', []);
      await assert.rejects(db.all('INSERT INTO children VALUES (1)', []), acknowledged('CONSTRAINT'));
      assert.deepEqual((await db.all('SELECT count(*) FROM children', [])).rows, [['0']]);
    } finally { await db.close(); }
  });
  await step('native: an owned backend terminated mid-statement is unconfirmed, poisoned and not retried', async () => {
    const name = 'driver-terminate';
    const db = await openPgExecutor({ ...options, applicationName: name });
    const pending = db.all('SELECT pg_sleep(30)', []).then(() => 'success', error => error);
    assert.ok(await until(async () => (await backend(name))[0]?.wait_event === 'PgSleep'));
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [name]);
    const outcome = await pending;
    assert.notEqual(outcome, 'success');
    unconfirmed(outcome); safe(outcome);
    await assert.rejects(db.all('SELECT 1', []), unconfirmed);
    await db.close().catch(() => {});
  });
  await step('native cancel control: dropping the socket alone leaves the statement running', async () => {
    const name = 'driver-drop-control';
    const client = new pg.Client({ ...base, password, application_name: name, ssl: false });
    client.on('error', () => {});
    await client.connect();
    client.query('SELECT pg_sleep(4)').catch(() => {});
    assert.ok(await until(async () => (await backend(name))[0]?.wait_event === 'PgSleep'));
    client.connection.stream.destroy();
    await pause(1500);
    assert.equal((await backend(name))[0]?.wait_event, 'PgSleep', 'The backend keeps running after its client left');
    assert.ok(await until(async () => (await backend(name)).length === 0, 10000));
  });
  await step('native cancel: a client deadline stops an ordinary running statement, observed from another connection', async () => {
    const name = 'driver-deadline';
    const db = await openPgExecutor({ ...options, applicationName: name, requestTimeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(db.all('SELECT pg_sleep(30)', []), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); assert.doesNotMatch(error.message, /stopped|cancel/i); return unconfirmed(error); });
    assert.ok(Date.now() - started < 2000);
    assert.ok(await until(async () => (await backend(name)).length === 0, 5000), 'The backend ended after the requested cancel');
    await db.close();
    await assert.rejects(db.all('SELECT 1', []), code('CLOSED'));
  });
  await step('native cancel proves nothing: a statement that survives the cancel still commits after the deadline, and is not replayed', async () => {
    await admin.query(`CREATE FUNCTION stubborn(wanted int8) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN
      BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END;
      INSERT INTO ledger VALUES (wanted, 'after-deadline');
    END $f$`);
    const db = await openPgExecutor({ ...options, requestTimeoutMs: 300 });
    await assert.rejects(db.all('SELECT stubborn($1)', ['77']), error => { assert.equal(error.code, 'DRIVER_TIMEOUT'); return unconfirmed(error); });
    await db.close();
    assert.ok(await until(async () => (await admin.query('SELECT 1 FROM ledger WHERE id=77')).rows.length === 1, 5000), 'The row committed despite the deadline and cancel');
    assert.equal((await admin.query('SELECT count(*) AS n FROM ledger WHERE id=77')).rows[0].n, '1');
  });
  await step('native: a session reports unconfirmed on a deadline and refuses further work', async () => {
    const session = createAsyncSession(await openPgExecutor({ ...options, requestTimeoutMs: 300 }), { dialect: 'postgresql', isResult: isPostgresRawResult });
    await assert.rejects(session.all('SELECT pg_sleep(30)', []), code('EXECUTION_UNCONFIRMED'));
    await assert.rejects(session.all('SELECT 1', []), code('CONNECTION_UNUSABLE'));
    await session.close();
  });

  // TLS: throwaway certificates made for this run with the host's openssl. The image has no CLI. They are deleted below.
  const tlsDir = join(outputDir, 'tls');
  mkdirSync(tlsDir);
  const makeCertificate = (name, subject, extra = []) => spawnSync('openssl', ['req', '-new', '-x509', '-days', '1', '-nodes', '-newkey', 'rsa:2048', '-subj', subject, ...extra, '-keyout', join(tlsDir, name + '.key'), '-out', join(tlsDir, name + '.crt')],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } }).status === 0;
  if (!makeCertificate('server', '/CN=localhost', ['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']) || !makeCertificate('other', '/CN=fictional-other')
      || !makeCertificate('client', '/CN=cert_role') || !makeCertificate('stranger', '/CN=cert_role')) {
    report.skipped.push('native TLS: host openssl unavailable');
    removeOwnedDirectory(tlsDir);
    await admin.end();
    return;
  }
  const ca = readFileSync(join(tlsDir, 'server.crt'), 'utf8'), otherCa = readFileSync(join(tlsDir, 'other.crt'), 'utf8');
  const clientTls = Object.freeze({ ca, cert: readFileSync(join(tlsDir, 'client.crt'), 'utf8'), key: readFileSync(join(tlsDir, 'client.key'), 'utf8') });
  const strangerTls = Object.freeze({ ca, cert: readFileSync(join(tlsDir, 'stranger.crt'), 'utf8'), key: readFileSync(join(tlsDir, 'stranger.key'), 'utf8') });
  docker(['exec', '-i', container, 'sh', '-c', 'cat > /var/lib/postgresql/server.crt'], {}, ca);
  docker(['exec', '-i', container, 'sh', '-c', 'cat > /var/lib/postgresql/server.key'], {}, readFileSync(join(tlsDir, 'server.key'), 'utf8'));
  removeOwnedDirectory(tlsDir);
  docker(['exec', container, 'sh', '-c', 'chown postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt && chmod 600 /var/lib/postgresql/server.key']);
  await admin.query("ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'");
  await admin.query("ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'");
  await admin.query("ALTER SYSTEM SET ssl=on");
  await admin.query('SELECT pg_reload_conf()');
  await pause(500);
  await step('native TLS: verified connections work; an untrusted certificate refuses; the URI form verifies too', async () => {
    const db = await openPgExecutor({ ...options, ssl: { ca } });
    assert.deepEqual((await db.all('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()', [])).rows, [['t']]);
    await db.close();
    await assert.rejects(openPgExecutor({ ...options, ssl: { ca: otherCa } }), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
    await assert.rejects(openPgExecutor({ ...options, ssl: true }), code('OPEN'));
    await assert.rejects(openPgExecutor({ connectionString: 'postgres://postgres:' + encodeURIComponent(password) + '@127.0.0.1:' + port + '/driver_checks?sslmode=verify-full' }), error => { assert.equal(error.code, 'OPEN'); return safe(error); });
  });
  await step('native TLS: a client deadline cancels over TLS, observed from another connection', async () => {
    const name = 'driver-tls-deadline';
    const db = await openPgExecutor({ ...options, ssl: { ca }, applicationName: name, requestTimeoutMs: 300 });
    await assert.rejects(db.all('SELECT pg_sleep(30)', []), code('DRIVER_TIMEOUT'));
    assert.ok(await until(async () => (await backend(name)).length === 0, 5000));
    await db.close();
  });
  // Client certificates: this role has no password and may only sign in with a certificate the server trusts, named for it.
  const { password: _unused, ...withoutPassword } = options;
  const certOptions = { ...withoutPassword, user: 'cert_role' };
  await step('native TLS: a client certificate really authenticates; none or an untrusted one refuses', async () => {
    await admin.query('CREATE ROLE cert_role LOGIN');
    docker(['exec', '-i', container, 'sh', '-c', 'cat > /var/lib/postgresql/client-ca.crt'], {}, clientTls.cert);
    docker(['exec', container, 'sh', '-c', 'chown postgres /var/lib/postgresql/client-ca.crt']);
    const { hba_file: hba } = (await admin.query('SHOW hba_file')).rows[0];
    assert.match(hba, /^\/[A-Za-z0-9_./-]+$/);
    docker(['exec', '-u', 'postgres', container, 'sed', '-i', '1i hostssl all cert_role all cert', hba]);
    await admin.query("ALTER SYSTEM SET ssl_ca_file='/var/lib/postgresql/client-ca.crt'");
    await admin.query('SELECT pg_reload_conf()');
    await pause(500);
    const db = await openPgExecutor({ ...certOptions, ssl: clientTls });
    assert.deepEqual((await db.all('SELECT current_user::text, ssl::text, client_dn FROM pg_stat_ssl WHERE pid=pg_backend_pid()', [])).rows, [['cert_role', 'true', '/CN=cert_role']]);
    await db.close();
    assert.equal(Object.getOwnPropertyDescriptor(clientTls, 'key').enumerable, true);
    for (const ssl of [{ ca }, strangerTls]) {
      await assert.rejects(openPgExecutor({ ...certOptions, ssl }), error => {
        assert.equal(error.code, 'OPEN'); assert.ok(!String(error.stack).includes(clientTls.key)); return safe(error);
      });
    }
    await assert.rejects(openPgExecutor({ ...certOptions, password, ssl: { ca } }), code('OPEN'));
  });
  await step('native TLS: a client deadline cancels a certificate-authenticated connection, observed from another connection', async () => {
    const name = 'driver-cert-deadline';
    const db = await openPgExecutor({ ...certOptions, ssl: clientTls, applicationName: name, requestTimeoutMs: 300 });
    await assert.rejects(db.all('SELECT pg_sleep(30)', []), code('DRIVER_TIMEOUT'));
    assert.ok(await until(async () => (await backend(name)).length === 0, 5000));
    await db.close();
  });
  await admin.end();
}
let nativeReady = false;
if (useDocker && daemonEndpoint) try { docker(['version']); nativeReady = true; } catch {}
if (nativeReady) {
  report.resourceLabel = dockerLabel;
  process.stdout.write(JSON.stringify({ ownedDockerLabel: dockerLabel }) + '\n');
  try {
    docker(['image', 'inspect', imageDigest]);
    await native();
  } catch (error) {
    report.failed.push('native setup: ' + String(error?.message).replaceAll(password, '<password>').slice(0, 300));
  } finally {
    try {
      // Only this run's labelled container, with any volume it owns. Nothing global.
      for (const id of docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=org.rowstitch.session=' + dockerLabel]).split(/\s+/).filter(Boolean)) {
        assert.equal(JSON.parse(docker(['inspect', id]))[0].Config.Labels['org.rowstitch.session'], dockerLabel);
        docker(['rm', '--force', '--volumes', id]);
        if (report.cleanup.docker) report.cleanup.docker.removedContainers++;
      }
      assert.equal(docker(['ps', '--all', '--quiet', '--filter', 'label=org.rowstitch.session=' + dockerLabel]), '');
      if (report.cleanup.docker) report.cleanup.docker.remainingContainers = 0;
    } catch (error) { report.failed.push('docker cleanup: ' + String(error?.message).slice(0, 200)); }
  }
} else report.skipped.push('native PostgreSQL: Docker unavailable or --no-docker');

if ((requireNative || compare) && report.skipped.length) report.failed.push('Required native integration checks were skipped: ' + report.skipped.join('; '));
try {
  assert.deepEqual(treeHashes(join(checkout, 'src'), '.ts'), sourceHashes, 'Source changed during the proof');
  assert.deepEqual(treeHashes(distSource, '.js'), compiledHashes, 'Compiled source changed during the proof');
  assert.deepEqual(treeHashes(join(consumer, 'dist'), '.js'), compiledHashes, 'The fresh consumer was modified during the proof');
  assert.deepEqual(Object.fromEntries(harnessNames.map(name => [name, hashOf(fileURLToPath(new URL(name, import.meta.url)))])), harnessHashes, 'Harness changed during the proof');
  report.hashesStable = true;
} catch (error) { report.failed.push('proof coherence: ' + String(error?.message).slice(0, 200)); }
const serialized = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? { type: 'bigint', decimal: value.toString() }
  : typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
    ? { type: 'number', value: Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value) } : value, 1);
assert.ok(!serialized.includes(password), 'The report must not contain the password');
const out = join(realpathSync(outputDir), 'result.json');
writeFileSync(out, serialized + '\n');
removeOwnedDirectory(consumer);
process.stdout.write(JSON.stringify({ passed: report.passed.length, failed: report.failed, skipped: report.skipped, result: out }) + '\n');
process.exit(report.failed.length ? 1 : 0);
