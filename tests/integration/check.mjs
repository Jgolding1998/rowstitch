// Internal session and narrow mapped-root integration. Not public PostgreSQL ORM support.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath, join, relative, isAbsolute, sep } from 'node:path';
import { connectPgTransport, connectPgliteTransport } from './glue.mjs';
// Run npm run build first. This check uses only this checkout's compiled source.
const distBase = new URL('../../dist/', import.meta.url).href;
const hashFile = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const harnessSha256 = hashFile(new URL(import.meta.url)), glueSha256 = hashFile(new URL('./glue.mjs',import.meta.url)), mappedSha256 = hashFile(new URL('./mapped.mjs',import.meta.url));
const compiledHashes = () => Object.fromEntries(readdirSync(new URL(distBase), { recursive: true }).filter(name => name.endsWith('.js')).sort().map(name => {
  const file = join(fileURLToPath(distBase), name);
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Compiled files must be ordinary files');
  return [name.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(file)).digest('hex')];
}));
const executedBuildHashes = compiledHashes();
const { checkMappedRoots } = await import('./mapped.mjs');
const { createPostgresExecutor } = await import(distBase + 'core/postgres-executor.js');
const { createAsyncSession } = await import(distBase + 'core/async-session.js');
const { isPostgresRawResult } = await import(distBase + 'core/postgres-result.js');
const { isAcknowledgedRejection } = await import(distBase + 'core/executor.js');
/** A real generic session over the real executor. */
const openSession = (transport, options = {}) => createAsyncSession(createPostgresExecutor(transport), { dialect: 'postgresql', isResult: isPostgresRawResult, ...options });
/** For readable golden assertions only: a result with duplicate names cannot be compared this way. */
const named = result => {
  const names = result.fields.map(field => field.name);
  assert.equal(new Set(names).size, names.length, 'Compare duplicate raw names by position');
  return result.rows.map(row => Object.fromEntries(names.map((name, i) => [name, row[i]])));
};

const imageDigest = 'postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5';
const runLabel = process.argv[2] ?? 'local'; assert.match(runLabel, /^[a-z0-9-]{1,30}$/);
const outputParent = resolvePath(process.env.ROWSTITCH_TEST_OUTPUT_DIR ?? tmpdir());
const checkout = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const within = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('..'+sep) && !isAbsolute(path); };
assert.ok(!within(checkout, outputParent), 'Keep engine reports and fixtures outside the checkout');
mkdirSync(outputParent, { recursive: true });
const realOutputParent = realpathSync(outputParent);
assert.ok(!within(checkout, realOutputParent), 'Keep engine reports and fixtures outside the checkout, including linked paths');
const outputDir = mkdtempSync(join(realOutputParent, 'rowstitch-engine-'));
const resultUrl = pathToFileURL(join(outputDir, 'result.json'));
assert.ok(!existsSync(resultUrl), 'Result path must be new');
const label = 'rowstitch-session-' + randomBytes(6).toString('hex'), password = randomBytes(32).toString('base64url');
const code = wanted => error => error?.code === wanted;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
// A failed transaction must also wake a test waiting for one of its callback's gates.
const reachedBeforeSettlement = (gate, outcome) => Promise.race([gate.promise, outcome.then(() => { throw new Error('Transaction settled before its expected test gate'); })]);
const report = { format: 'rowstitch-postgres-session-integration', runLabel, node: process.version, packages: { pg: '8.23.1', pglite: '0.5.15' }, imageDigest, executedBuildHashes,
  scope: 'Internal Rowstitch executor/session and narrow mapped-root compiler on fixed schemas; not public SDK, schema/settings verification, pool or complete engine support.', engines: {}, cleanup: {},
  credentials: 'Generated per run and not saved in proof files or the repository. Passed to docker through a per-spawn environment, not process arguments. Docker itself may hold it in container metadata until the owned container is removed.' };
let network, container, daemonEndpoint, resourcesAttempted = false, phase = 'initializing', config, original;
const open = new Set();
function docker(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Pin every daemon operation to the validated endpoint, independent of Docker's ambient context/host precedence.
  for (const key of Object.keys(env)) if (['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'].includes(key.toUpperCase())) delete env[key];
  const command = daemonEndpoint ? ['--host', daemonEndpoint, ...args] : args;
  const r = spawnSync('docker', command, { encoding: 'utf8', windowsHide: true, timeout: args[0] === 'pull' ? 180_000 : 60_000, maxBuffer: 2 * 1024 * 1024, env });
  if (r.status !== 0) throw new Error('Owned Docker operation failed: ' + args[0]);
  return r.stdout.trim();
}
const embeddedDir = join(outputDir, 'pglite-data');
const connectPg = () => connectPgTransport(config, { opened: client => open.add(client), closed: client => open.delete(client) });
const connectPglite = () => connectPgliteTransport(embeddedDir, { opened: db => open.add(db), closed: db => open.delete(db) });
/** Exact wire metadata on the real engine, through the real session. Counted apart from the established scenario counts. */
async function positional(connect) {
  const cases = [], session = openSession(await connect());
  const exact = (result, fields, rows, command, rowCount) => {
    assert.ok(isPostgresRawResult(result) && Object.isFrozen(result) && Object.isFrozen(result.fields) && Object.isFrozen(result.rows));
    assert.deepEqual({ fields: result.fields, rows: result.rows, command: result.command, rowCount: result.rowCount }, { fields, rows, command, rowCount });
  };
  try {
    exact(await session.all(`SELECT 9223372036854775807::bigint AS dup, 'é𝄞'::text AS dup, true AS dup, 1.5::float8 AS other, '{"a":1}'::jsonb AS "é", 7::int AS small, NULL::int AS missing`),
      [{name:'dup',typeOid:20},{name:'dup',typeOid:25},{name:'dup',typeOid:16},{name:'other',typeOid:701},{name:'é',typeOid:3802},{name:'small',typeOid:23},{name:'missing',typeOid:23}],
      [['9223372036854775807','é𝄞','t','1.5','{"a": 1}','7',null]], 'SELECT', 1n);
    cases.push('duplicate raw names stay separate columns, with exact OIDs and raw text, including NULL and non-BMP values');
    await session.all('CREATE TABLE positional_items(id BIGINT PRIMARY KEY, label TEXT NOT NULL)');
    exact(await session.all(`INSERT INTO positional_items VALUES (1,'a'),(2,'b'),(3,'c')`), [], [], 'INSERT', 3n);
    exact(await session.all(`INSERT INTO positional_items VALUES ($1,$2) RETURNING id, label`, [4n, 'd']), [{name:'id',typeOid:20},{name:'label',typeOid:25}], [['4','d']], 'INSERT', 1n);
    exact(await session.all(`UPDATE positional_items SET label=label WHERE id<=2`), [], [], 'UPDATE', 2n);
    exact(await session.all(`UPDATE positional_items SET label=label WHERE id=99`), [], [], 'UPDATE', 0n);
    exact(await session.all(`DELETE FROM positional_items WHERE id=4`), [], [], 'DELETE', 1n);
    cases.push('rowCount comes from the native tag for writes without returned rows, for zero, and for RETURNING');
    exact(await session.all('SELECT id FROM positional_items WHERE id=99'), [{name:'id',typeOid:20}], [], 'SELECT', 0n);
    exact(await session.all('SELECT FROM positional_items'), [], [[],[],[]], 'SELECT', 3n);
    const shown = await session.all('SHOW server_version_num');
    exact(shown, [{name:'server_version_num',typeOid:25}], [[shown.rows[0][0]]], 'SHOW', null);
    assert.match(shown.rows[0][0], /^[0-9]+$/);
    exact(await session.all('CREATE TABLE positional_other(id INT)'), [], [], 'CREATE', null);
    cases.push('empty results keep metadata, zero-column rows keep their count, and uncounted statements have a null rowCount');
    const inTransaction = await session.transaction(async tx => ({ root: await tx.all('SELECT 1::bigint AS a'), child: await tx.transaction(child => child.all(`SELECT 'x'::text AS a, 'y'::text AS a`)) }));
    exact(inTransaction.root, [{name:'a',typeOid:20}], [['1']], 'SELECT', 1n);
    exact(inTransaction.child, [{name:'a',typeOid:25},{name:'a',typeOid:25}], [['x','y']], 'SELECT', 1n);
    cases.push('the raw result passes through transaction and child handles');
  } finally { await session.close(); }
  const readOnly = openSession(await connect(), { readOnly:true });
  try {
    exact(await readOnly.all('SELECT count(*) AS n FROM positional_items'), [{name:'n',typeOid:20}], [['3']], 'SELECT', 1n);
    cases.push('the raw result passes through the read-only implicit transaction');
  } finally { await readOnly.close(); }
  return cases;
}
/** Ordinary errors after a partial exchange. Counted apart from the established scenario counts. An acknowledgment does not promise that nothing happened. */
async function errorRecovery(connect) {
  const cases = [], session = openSession(await connect());
  const definite = wanted => error => { assert.equal(error?.code, wanted); assert.ok(isAcknowledgedRejection(error), 'Acknowledged'); return true; };
  const dividing = 'SELECT 1/(2-g) AS v FROM pg_catalog.generate_series(1,3) g';
  try {
    await assert.rejects(session.all(dividing), definite('DATABASE_ERROR'));
    assert.deepEqual(named(await session.all('SELECT 1::bigint AS v')), [{v:'1'}]);
    const recovered = await session.transaction(async tx => {
      await assert.rejects(tx.transaction(child => child.all(dividing)), definite('DATABASE_ERROR'));
      return tx.all('SELECT 2::bigint AS v');
    });
    assert.deepEqual(named(recovered), [{v:'2'}]);
    await assert.rejects(session.transaction(async tx => { await assert.rejects(tx.all(dividing), definite('DATABASE_ERROR')); return 'must not commit'; }), definite('TRANSACTION_ABORTED'));
    assert.deepEqual(named(await session.all('SELECT 3::bigint AS v')), [{v:'3'}]);
    cases.push('an error after rows is a definite rejection, without partial rows, in autocommit and with transaction recovery');
    await session.all('CREATE TABLE recovery_parents(id BIGINT PRIMARY KEY)');
    await session.all('CREATE TABLE recovery_children(id BIGINT PRIMARY KEY, parent_id BIGINT REFERENCES recovery_parents(id) DEFERRABLE INITIALLY DEFERRED)');
    await assert.rejects(session.all('INSERT INTO recovery_children VALUES (1,99)'), definite('CONSTRAINT'));
    await assert.rejects(session.all('INSERT INTO recovery_children VALUES (2,99) RETURNING id'), definite('CONSTRAINT'));
    assert.deepEqual(named(await session.all('SELECT id FROM recovery_children')), []);
    await session.all('INSERT INTO recovery_parents VALUES (99)');
    const written = await session.all('INSERT INTO recovery_children VALUES (3,99) RETURNING id');
    assert.equal(written.rowCount, 1n);
    assert.deepEqual(named(await session.all('SELECT id FROM recovery_children')), [{id:'3'}]);
    cases.push('an autocommit deferred-constraint failure after CommandComplete is a definite rejection, and the session stays reusable');
    // A real engine response: this deliberately raises a code off COMMIT's list at the implicit commit. It does not simulate a disk failure.
    await session.all(`CREATE FUNCTION recovery_raise() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional' USING ERRCODE = '53100'; END $$`);
    await session.all('CREATE TABLE recovery_raised(id BIGINT PRIMARY KEY)');
    await session.all('CREATE CONSTRAINT TRIGGER recovery_raised_at_commit AFTER INSERT ON recovery_raised DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recovery_raise()');
  } finally { await session.close(); }
  const raw = await connect();
  const verdicts = {};
  for (const [name, sql] of [['tag', 'INSERT INTO recovery_children VALUES (4,98)'], ['rows', dividing]]) verdicts[name] = await raw.query(sql, []).then(() => null, error => raw.serverError(error));
  await raw.close();
  assert.deepEqual(verdicts, { tag:{ sqlstate:'23503', afterCommandComplete:true }, rows:{ sqlstate:'22012', afterCommandComplete:false } });
  const counted = await connect(), sent = [];
  const uncertain = openSession({ ...counted, query(sql, values) { sent.push(sql); return counted.query(sql, values); } });
  try {
    await assert.rejects(uncertain.all('INSERT INTO recovery_raised VALUES (1)'), error => { assert.equal(error?.code, 'EXECUTION_UNCONFIRMED'); assert.ok(!isAcknowledgedRejection(error)); return true; });
    await assert.rejects(uncertain.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
    assert.deepEqual(sent, ['INSERT INTO recovery_raised VALUES (1)'], 'Sent once: no replay, no rollback and nothing more');
  } finally { await uncertain.close(); }
  const after = openSession(await connect());
  try {
    await assert.rejects(after.all(`DO $$ BEGIN RAISE EXCEPTION 'fictional' USING ERRCODE = '53100'; END $$`), definite('DATABASE_ERROR'));
    assert.deepEqual(named(await after.all('SELECT 1::bigint AS v')), [{v:'1'}], 'the same code before any CommandComplete stays definite');
    assert.deepEqual(named(await after.all('SELECT id FROM recovery_raised')), [], 'this engine did not keep the row; the outcome was still reported as unknown');
  } finally { await after.close(); }
  cases.push('a code off the COMMIT list after CommandComplete in autocommit is unconfirmed and poisons, while before CommandComplete it stays definite');
  return cases;
}
async function common(name, connect) {
  const cases = [], transport = await connect(), controls = [];
  const session = openSession(transport, { observer: { control(e) { controls.push({ sql:e.sql, outcome:e.outcome }); } } });
  let version;
  try {
    version = named(await session.all('SELECT version() AS version, current_setting(\'server_version_num\') AS number'))[0];
    if (name === 'postgresql') assert.equal(version.number, '180006');
    phase = name + ': schema/bound values';
    await session.all('CREATE TABLE session_items(id INT PRIMARY KEY, label TEXT UNIQUE NOT NULL, amount BIGINT NOT NULL)');
    const marker = "SYNTHETIC_' OR 1=1--";
    await session.all('INSERT INTO session_items VALUES($1,$2,$3)', [1, marker, 9223372036854775807n]);
    assert.deepEqual(named(await session.all('SELECT id, label, amount FROM session_items WHERE label=$1', [marker])), [{ id:'1', label:marker, amount:'9223372036854775807' }]);
    cases.push('bound text and int64 preserved through actual executor and engine');
    phase = name + ': rollback';
    const thrown = new Error('synthetic callback failure');
    await assert.rejects(session.transaction(async tx => { await tx.all('INSERT INTO session_items VALUES(2,$1,0)', ['rolled-back']); throw thrown; }), error => error === thrown);
    assert.deepEqual(named(await session.all('SELECT id FROM session_items ORDER BY id')), [{ id:'1' }]);
    cases.push('callback error preserves identity and actually rolls back');
    phase = name + ': savepoint';
    await session.transaction(async tx => {
      await tx.all('INSERT INTO session_items VALUES(2,$1,0)', ['parent']);
      await assert.rejects(tx.transaction(async child => {
        await child.all('INSERT INTO session_items VALUES(3,$1,0)', ['child']); throw thrown;
      }), error => error === thrown);
    });
    assert.deepEqual(named(await session.all('SELECT id FROM session_items ORDER BY id')), [{id:'1'},{id:'2'}]);
    cases.push('nested rollback preserves committed parent');
    phase = name + ': nested engine rejection recovery';
    await session.transaction(async tx => {
      await assert.rejects(tx.transaction(child => child.all('INSERT INTO session_items VALUES(12,$1,0)', [marker])), code('CONSTRAINT'));
      await tx.all('INSERT INTO session_items VALUES(6,$1,0)', ['parent-after-rejected-child']);
    });
    assert.deepEqual(named(await session.all('SELECT id FROM session_items WHERE id=6 OR id=12 ORDER BY id')), [{id:'6'}]);
    cases.push('actual constraint failure rolls back child savepoint and parent remains usable');
    phase = name + ': caught child error and rejected RELEASE recovery';
    await session.transaction(async tx => {
      await assert.rejects(tx.transaction(async child => {
        await assert.rejects(child.all('INSERT INTO session_items VALUES(15,$1,0)', [marker]), code('CONSTRAINT'));
        // A failed transaction cannot successfully RELEASE. The session must recover this savepoint, not poison its parent.
        return 'the rejected RELEASE must still be reported';
      }), code('DATABASE_ERROR'));
      await tx.all('INSERT INTO session_items VALUES(7,$1,0)', ['parent-after-rejected-release']);
    });
    assert.deepEqual(named(await session.all('SELECT id FROM session_items WHERE id=7 OR id=15 ORDER BY id')), [{id:'7'}]);
    cases.push('caught child engine error makes RELEASE reject; rollback-to heals parent and its own write commits');
    phase = name + ': multiple statement rejection';
    await assert.rejects(session.all('INSERT INTO session_items VALUES(13,\'forbidden-script\',0); INSERT INTO session_items VALUES(14,\'forbidden-script-two\',0)'));
    assert.deepEqual(named(await session.all('SELECT id FROM session_items WHERE id=13 OR id=14')), []);
    cases.push('extended query refuses multi-statement scripts before any write');
    phase = name + ': caught unique rejection';
    await assert.rejects(session.transaction(async tx => {
      await tx.all('INSERT INTO session_items VALUES(4,$1,0)', ['before-error']);
      await assert.rejects(tx.all('INSERT INTO session_items VALUES(5,$1,0)', [marker]), code('CONSTRAINT'));
      return 'must not be a successful commit';
    }), code('TRANSACTION_ABORTED'));
    assert.deepEqual(named(await session.all('SELECT id FROM session_items ORDER BY id')), [{id:'1'},{id:'2'},{id:'6'},{id:'7'}]);
    cases.push('caught SQL error cannot turn COMMIT-ROLLBACK into success');
    phase = name + ': deferred commit failure';
    await session.all('CREATE TABLE session_parents(id INT PRIMARY KEY)');
    await session.all('CREATE TABLE session_children(id INT PRIMARY KEY, parent_id INT REFERENCES session_parents(id) DEFERRABLE INITIALLY DEFERRED)');
    await assert.rejects(session.transaction(tx => tx.all('INSERT INTO session_children VALUES(1,99)')), code('CONSTRAINT'));
    assert.deepEqual(named(await session.all('SELECT id FROM session_children')), []);
    cases.push('deferred foreign-key COMMIT failure and reusable session');
    phase = name + ': outside root isolation';
    const reached = deferred(), release = deferred();
    const transaction = session.transaction(async tx => {
      await tx.all('INSERT INTO session_items VALUES(10,$1,0)', ['transaction']); reached.resolve(); await release.promise; throw thrown;
    });
    const transactionOutcome = transaction.then(()=> 'incorrect-success', error=>error);
    try {
      await reachedBeforeSettlement(reached, transactionOutcome);
      const queuedOutcome = session.all('INSERT INTO session_items VALUES(11,$1,0)', ['outside']).then(() => undefined, error => error);
      release.resolve(); assert.equal(await transactionOutcome, thrown); assert.equal(await queuedOutcome, undefined);
    } finally { release.resolve(); await transactionOutcome; }
    assert.deepEqual(named(await session.all('SELECT id FROM session_items WHERE id>=10 ORDER BY id')), [{id:'11'}]);
    cases.push('outside root write survives while held transaction rolls back; it cannot have joined that transaction');
  } finally { await session.close(); }
  phase = name + ': read-only';
  const readOnly = openSession(await connect(), { readOnly:true });
  try {
    await assert.rejects(readOnly.all('INSERT INTO session_items VALUES(21,$1,0)', ['read-only-root']), code('READ_ONLY'));
    await assert.rejects(readOnly.all('UPDATE session_items SET label=$1 WHERE id=1', ['read-only-change']), code('READ_ONLY'));
    await assert.rejects(readOnly.all('DELETE FROM session_items WHERE id=1'), code('READ_ONLY'));
    assert.deepEqual(named(await readOnly.all('SELECT id,label FROM session_items WHERE id=1')), [{id:'1',label:"SYNTHETIC_' OR 1=1--"}]);
    assert.deepEqual(named(await readOnly.all('SELECT id FROM session_items WHERE id=21')), []);
    cases.push('read-only root insert/update/delete all reject and leave original data and a reusable session');
    await assert.rejects(readOnly.transaction(tx => tx.all('INSERT INTO session_items VALUES(20,$1,0)', ['read-only'])), code('READ_ONLY'));
    assert.deepEqual(named(await readOnly.all('SELECT id FROM session_items WHERE id=20')), []);
    cases.push('read-only transaction rejects writes and recovers');
  } finally { await readOnly.close(); }
  phase = name + ': unconfirmed applied COMMIT';
  const raw = await connect(), sent = []; let callbacks = 0;
  const hiding = { ...raw, async query(sql, values) { sent.push(sql); const result = await raw.query(sql, values); if (sql === 'COMMIT') throw new Error('synthetic post-ack transport loss'); return result; } };
  const uncertain = openSession(hiding);
  try {
    await assert.rejects(uncertain.transaction(async tx => { callbacks++; await tx.all('INSERT INTO session_items VALUES(30,$1,0)', ['durable-unconfirmed']); }), code('COMMIT_UNCONFIRMED'));
    await assert.rejects(uncertain.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
    assert.equal(callbacks, 1); assert.ok(!sent.includes('ROLLBACK'));
  } finally { await uncertain.close(); }
  const reopened = openSession(await connect());
  try { assert.deepEqual(named(await reopened.all('SELECT id FROM session_items WHERE id=30')), [{id:'30'}]); } finally { await reopened.close(); }
  cases.push('applied COMMIT with deliberately hidden acknowledgment is not replayed or called a rollback; reopen proves durable row');
  phase = name + ': positional raw results';
  const positionalCases = await positional(connect);
  phase = name + ': ordinary errors after partial exchanges';
  const errorRecoveryCases = await errorRecovery(connect);
  return { version, cases, positionalCases, errorRecoveryCases, controlStatements: controls, limitations: name === 'pglite' ? ['Single embedded connection, no independent-session/network/pool claim. Synchronous WASM work cannot be interrupted by the executor timer.'] : ['Dedicated clients only; no pool validation. Hidden ACK is deliberate fault injection, not an actual TCP-loss claim.'] };
}
try {
  phase = 'local Docker preflight';
  // This test starts only its own labelled containers on a local daemon.
  const context = process.env.DOCKER_CONTEXT;
  const endpoint = process.env.DOCKER_HOST || JSON.parse(docker(context
    ? ['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']
    : ['context','inspect','--format','{{json .Endpoints.docker.Host}}']));
  const localEndpoint = typeof endpoint === 'string' && (endpoint.startsWith('unix:///') || /^npipe:\/{4}\.\/pipe\/[^/\\]+$/.test(endpoint));
  assert.ok(localEndpoint, 'A local Docker daemon endpoint is required');
  daemonEndpoint = endpoint;
  phase = 'pinned image';
  // Pull only the immutable official image, using no install hooks or application credentials.
  docker(['pull', imageDigest]);
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)));
  assert.equal(lock.packages['node_modules/pg'].version, '8.23.1'); assert.equal(lock.packages['node_modules/@electric-sql/pglite'].version, '0.5.15');
  for (const [name, wanted] of [['pg','8.23.1'],['@electric-sql/pglite','0.5.15']]) {
    assert.equal(JSON.parse(readFileSync(new URL('./node_modules/'+name+'/package.json', import.meta.url))).version, wanted);
  }
  resourcesAttempted = true;
  console.log('Owned engine-test resource label: org.rowstitch.session='+label);
  phase = 'create isolated network';
  network = docker(['network','create','--driver','bridge','--label','org.rowstitch.session='+label,label]);
  phase = 'create isolated server';
  container = docker(['run','--detach','--name',label,'--label','org.rowstitch.session='+label,'--network',label,
    '--memory','256m','--cpus','1','--pids-limit','128','--tmpfs','/var/lib/postgresql:rw,size=128m','--publish','127.0.0.1::5432',
    '--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=rowstitch_session','--env','POSTGRES_INITDB_ARGS=--no-locale --encoding=UTF8 --auth-host=scram-sha-256',imageDigest,
    '-c','shared_buffers=16MB','-c','max_connections=10','-c','log_min_messages=warning'], { POSTGRES_PASSWORD: password });
  assert.match(container, /^[a-f0-9]{64}$/);
  const info = JSON.parse(docker(['inspect',container]))[0]; assert.equal(info.Config.Labels['org.rowstitch.session'], label);
  const port = info.NetworkSettings.Ports['5432/tcp'][0]; assert.equal(port.HostIp,'127.0.0.1');
  assert.match(port.HostPort, /^[0-9]{1,5}$/);
  const hostPort = Number(port.HostPort);
  assert.ok(Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535, 'Use only the owned server\'s assigned port');
  config = { host:'127.0.0.1', port:hostPort, user:'postgres', database:'rowstitch_session', password, connectionTimeoutMillis:1000,
    ssl:false, options:'-c client_min_messages=warning', application_name:'rowstitch-engine-check' };
  const readyDeadline = Date.now() + 30_000;
  for (;;) { try { const ready=await connectPg(); await ready.close(); break; } catch { if(Date.now()>=readyDeadline)throw new Error('Isolated server not ready'); await pause(200); } }
  report.engines.postgresql = await common('postgresql', connectPg);
  phase = 'postgresql: independent sessions and serialization';
  const one = openSession(await connectPg());
  const two = openSession(await connectPg());
  try {
    const held = deferred(), release = deferred(), read = deferred(); let callbacks = 0;
    const a = one.transaction(async tx => { await tx.all('SELECT amount FROM session_items WHERE id=2'); await tx.all('UPDATE session_items SET amount=1 WHERE id=2'); held.resolve(); await release.promise; });
    // Observe a's failure immediately and always release its held callback, including assertion failures.
    const firstOutcome = a.then(() => undefined, error => error);
    try {
      await reachedBeforeSettlement(held, firstOutcome);
      assert.deepEqual(named(await two.all('SELECT amount FROM session_items WHERE id=2')), [{amount:'0'}]);
      const b = two.transaction(async tx => { callbacks++; await tx.all('SELECT amount FROM session_items WHERE id=2'); read.resolve(); await tx.all('UPDATE session_items SET amount=2 WHERE id=2'); });
      const outcome = b.then(()=> 'incorrect-success', error => error.code);
      await reachedBeforeSettlement(read, outcome); release.resolve(); assert.equal(await firstOutcome, undefined);
      assert.equal(await outcome, 'SERIALIZATION_FAILURE'); assert.equal(callbacks,1);
    } finally { release.resolve(); await firstOutcome; }
    assert.deepEqual(named(await two.all('SELECT amount FROM session_items WHERE id=2')), [{amount:'1'}]);
    report.engines.postgresql.cases.push('independent clients cannot observe uncommitted write; actual serialization conflict is reported without replay');
  } finally { await one.close(); await two.close(); }
  phase = 'postgresql: actual backend termination during an issued statement';
  const victim = openSession(await connectPg()), administrator = await connectPg();
  try {
    const pid = (await victim.all('SELECT pg_backend_pid() AS pid')).rows[0][0];
    const pending = victim.all('SELECT pg_sleep(30)');
    const outcome = pending.then(()=> 'incorrect-success', error=>error.code);
    let active = false;
    for(let i=0;i<30;i++) {
      const check = await administrator.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
      if(check.rows[0]?.[0] === 'PgSleep') { active=true; break; }
      await pause(50);
    }
    assert.ok(active, 'Must observe the actual statement before terminating its owned backend');
    await administrator.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
    assert.equal(await outcome, 'EXECUTION_UNCONFIRMED');
    await assert.rejects(victim.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
    report.engines.postgresql.cases.push('actual owned backend termination during issued statement is unconfirmed, poisons connection, and is not retried');
  } finally { await victim.close(); await administrator.close(); }
  report.engines.pglite = await common('pglite', connectPglite);
  assert.equal(report.engines.postgresql.cases.length, 14);
  assert.equal(report.engines.pglite.cases.length, 12);
  assert.equal(report.engines.postgresql.positionalCases.length, 5);
  assert.equal(report.engines.pglite.positionalCases.length, 5);
  assert.equal(report.engines.postgresql.errorRecoveryCases.length, 3);
  assert.equal(report.engines.pglite.errorRecoveryCases.length, 3);
  phase = 'postgresql: mapped root compiler and execution';
  report.engines.postgresql.mappedCases = await checkMappedRoots('postgresql', connectPg);
  phase = 'pglite: mapped root compiler and execution';
  report.engines.pglite.mappedCases = await checkMappedRoots('pglite', connectPglite);
  assert.equal(report.engines.postgresql.mappedCases.cases.length, 8);
  assert.equal(report.engines.pglite.mappedCases.cases.length, 8);
} catch (error) { original = error; }
finally {
  for (const resource of open) {
    let timer;
    try { await Promise.race([
      Promise.resolve().then(() => resource.end ? resource.end() : resource.close()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned client cleanup deadline exceeded')), 5000); }),
    ]); }
    catch {
      try { resource.connection?.stream?.destroy(); } catch {}
      report.cleanup.clientCloseUnconfirmed = true;
      original ??= new Error('Owned client cleanup was not confirmed');
    }
    finally { clearTimeout(timer); }
  }
  // A cleanup failure is recorded; it must not replace the original failure or lose the receipt.
  try { if (resourcesAttempted) {
    // A failed/timed-out create can leave a resource without returning its ID. Discover only this run's exact label.
    const ids = docker(['ps','--all','--quiet','--no-trunc','--filter','label=org.rowstitch.session='+label]).split(/\s+/).filter(Boolean);
    report.cleanup.containersFound = ids.length;
    for (const id of ids) { const info = JSON.parse(docker(['inspect',id]))[0]; assert.equal(info.Config.Labels['org.rowstitch.session'],label); assert.equal(info.Name,'/'+label); docker(['rm','--force',id]); }
    report.cleanup.ownedContainerRemoved=ids.length>0;
  } }
  catch (error) { report.cleanup.containerError = String(error?.message ?? error).slice(0, 200); original ??= error; }
  try { if (resourcesAttempted) {
    const ids = docker(['network','ls','--quiet','--no-trunc','--filter','label=org.rowstitch.session='+label]).split(/\s+/).filter(Boolean);
    report.cleanup.networksFound = ids.length;
    for (const id of ids) { const info = JSON.parse(docker(['network','inspect',id]))[0]; assert.equal(info.Labels['org.rowstitch.session'],label); assert.equal(info.Name,label); docker(['network','rm',id]); }
    report.cleanup.ownedNetworkRemoved=ids.length>0;
  } }
  catch (error) { report.cleanup.networkError = String(error?.message ?? error).slice(0, 200); original ??= error; }
  try { if (!original && existsSync(embeddedDir)) {
    const target = realpathSync(embeddedDir), owned = realpathSync(outputDir);
    assert.ok(target !== owned && within(owned, target));
    assert.equal(target, join(owned, 'pglite-data'));
    assert.ok(lstatSync(embeddedDir).isDirectory() && !lstatSync(embeddedDir).isSymbolicLink());
    rmSync(target, { recursive:true, force:true, maxRetries:3 });
    report.cleanup.pgliteFixtureRemoved=true;
  } } catch (error) { report.cleanup.fixtureError='Owned fixture cleanup was not confirmed'; original ??= error; }
}
try {
  assert.deepEqual(compiledHashes(), executedBuildHashes, 'Compiled build changed during checks');
  assert.equal(hashFile(new URL(import.meta.url)), harnessSha256, 'Harness changed during checks');
  assert.equal(hashFile(new URL('./glue.mjs',import.meta.url)), glueSha256, 'Test transport changed during checks');
  assert.equal(hashFile(new URL('./mapped.mjs',import.meta.url)), mappedSha256, 'Mapped tests changed during checks');
} catch (error) { original ??= error; }
report.sourceHashes = Object.fromEntries(['async-session.ts','executor.ts','postgres-control.ts','postgres-executor.ts','postgres-result.ts','postgres-root-plan.ts','postgres-root-execution.ts'].map(name => [name,createHash('sha256').update(readFileSync(new URL('../../src/core/'+name,import.meta.url))).digest('hex')]));
report.harnessSha256 = harnessSha256;
report.glueSha256 = glueSha256;
report.mappedSha256 = mappedSha256;
// Preserve the finite fictional-data report in CI logs without uploading database files or generated credentials.
const outcome = { ...report, failed:!!original, ...(original ? { phase, error:{code:original.code??'ASSERTION',message:String(original.message).replaceAll(password,'[redacted]').slice(0,1000)} } : {}) };
if (process.env.CI) console.log(JSON.stringify(outcome));
writeFileSync(resultUrl,JSON.stringify(outcome,null,2)+'\n');
if(original) { console.error('Engine checks failed at '+phase+'; report: '+fileURLToPath(resultUrl)); process.exitCode=1; }
else console.log(JSON.stringify({postgresql:report.engines.postgresql.cases.length,pglite:report.engines.pglite.cases.length,positional:report.engines.postgresql.positionalCases.length+'+'+report.engines.pglite.positionalCases.length,errorRecovery:report.engines.postgresql.errorRecoveryCases.length+'+'+report.engines.pglite.errorRecoveryCases.length,mapped:report.engines.postgresql.mappedCases.cases.length+'+'+report.engines.pglite.mappedCases.cases.length,cleanup:report.cleanup,scope:report.scope,report:fileURLToPath(resultUrl)}));
