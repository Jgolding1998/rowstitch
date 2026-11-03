// Actual internal Rowstitch session integration. Still not a repository/compiler support claim.
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
const harnessSha256 = hashFile(new URL(import.meta.url)), glueSha256 = hashFile(new URL('./glue.mjs',import.meta.url));
const compiledHashes = () => Object.fromEntries(readdirSync(new URL(distBase), { recursive: true }).filter(name => name.endsWith('.js')).sort().map(name => {
  const file = join(fileURLToPath(distBase), name);
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Compiled files must be ordinary files');
  return [name.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(file)).digest('hex')];
}));
const executedBuildHashes = compiledHashes();
const { createPostgresExecutor } = await import(distBase + 'core/postgres-executor.js');
const { createAsyncSession } = await import(distBase + 'core/async-session.js');

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
  scope: 'Internal Rowstitch executor/session plus real engines, not ORM query/compiler/codec, public SDK, pool or complete engine support.', engines: {}, cleanup: {},
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
async function common(name, connect) {
  const cases = [], transport = await connect(), controls = [];
  const session = createAsyncSession(createPostgresExecutor(transport), { dialect: 'postgresql', observer: { control(e) { controls.push({ sql:e.sql, outcome:e.outcome }); } } });
  let version;
  try {
    version = (await session.all('SELECT version() AS version, current_setting(\'server_version_num\') AS number'))[0];
    if (name === 'postgresql') assert.equal(version.number, '180006');
    phase = name + ': schema/bound values';
    await session.all('CREATE TABLE session_items(id INT PRIMARY KEY, label TEXT UNIQUE NOT NULL, amount BIGINT NOT NULL)');
    const marker = "SYNTHETIC_' OR 1=1--";
    await session.all('INSERT INTO session_items VALUES($1,$2,$3)', [1, marker, 9223372036854775807n]);
    assert.deepEqual(await session.all('SELECT id, label, amount FROM session_items WHERE label=$1', [marker]), [{ id:'1', label:marker, amount:'9223372036854775807' }]);
    cases.push('bound text and int64 preserved through actual executor and engine');
    phase = name + ': rollback';
    const thrown = new Error('synthetic callback failure');
    await assert.rejects(session.transaction(async tx => { await tx.all('INSERT INTO session_items VALUES(2,$1,0)', ['rolled-back']); throw thrown; }), error => error === thrown);
    assert.deepEqual(await session.all('SELECT id FROM session_items ORDER BY id'), [{ id:'1' }]);
    cases.push('callback error preserves identity and actually rolls back');
    phase = name + ': savepoint';
    await session.transaction(async tx => {
      await tx.all('INSERT INTO session_items VALUES(2,$1,0)', ['parent']);
      await assert.rejects(tx.transaction(async child => {
        await child.all('INSERT INTO session_items VALUES(3,$1,0)', ['child']); throw thrown;
      }), error => error === thrown);
    });
    assert.deepEqual(await session.all('SELECT id FROM session_items ORDER BY id'), [{id:'1'},{id:'2'}]);
    cases.push('nested rollback preserves committed parent');
    phase = name + ': nested engine rejection recovery';
    await session.transaction(async tx => {
      await assert.rejects(tx.transaction(child => child.all('INSERT INTO session_items VALUES(12,$1,0)', [marker])), code('CONSTRAINT'));
      await tx.all('INSERT INTO session_items VALUES(6,$1,0)', ['parent-after-rejected-child']);
    });
    assert.deepEqual(await session.all('SELECT id FROM session_items WHERE id=6 OR id=12 ORDER BY id'), [{id:'6'}]);
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
    assert.deepEqual(await session.all('SELECT id FROM session_items WHERE id=7 OR id=15 ORDER BY id'), [{id:'7'}]);
    cases.push('caught child engine error makes RELEASE reject; rollback-to heals parent and its own write commits');
    phase = name + ': multiple statement rejection';
    await assert.rejects(session.all('INSERT INTO session_items VALUES(13,\'forbidden-script\',0); INSERT INTO session_items VALUES(14,\'forbidden-script-two\',0)'));
    assert.deepEqual(await session.all('SELECT id FROM session_items WHERE id=13 OR id=14'), []);
    cases.push('extended query refuses multi-statement scripts before any write');
    phase = name + ': caught unique rejection';
    await assert.rejects(session.transaction(async tx => {
      await tx.all('INSERT INTO session_items VALUES(4,$1,0)', ['before-error']);
      await assert.rejects(tx.all('INSERT INTO session_items VALUES(5,$1,0)', [marker]), code('CONSTRAINT'));
      return 'must not be a successful commit';
    }), code('TRANSACTION_ABORTED'));
    assert.deepEqual(await session.all('SELECT id FROM session_items ORDER BY id'), [{id:'1'},{id:'2'},{id:'6'},{id:'7'}]);
    cases.push('caught SQL error cannot turn COMMIT-ROLLBACK into success');
    phase = name + ': deferred commit failure';
    await session.all('CREATE TABLE session_parents(id INT PRIMARY KEY)');
    await session.all('CREATE TABLE session_children(id INT PRIMARY KEY, parent_id INT REFERENCES session_parents(id) DEFERRABLE INITIALLY DEFERRED)');
    await assert.rejects(session.transaction(tx => tx.all('INSERT INTO session_children VALUES(1,99)')), code('CONSTRAINT'));
    assert.deepEqual(await session.all('SELECT id FROM session_children'), []);
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
    assert.deepEqual(await session.all('SELECT id FROM session_items WHERE id>=10 ORDER BY id'), [{id:'11'}]);
    cases.push('outside root write survives while held transaction rolls back; it cannot have joined that transaction');
  } finally { await session.close(); }
  phase = name + ': read-only';
  const readOnly = createAsyncSession(createPostgresExecutor(await connect()), { dialect:'postgresql', readOnly:true });
  try {
    await assert.rejects(readOnly.all('INSERT INTO session_items VALUES(21,$1,0)', ['read-only-root']), code('READ_ONLY'));
    await assert.rejects(readOnly.all('UPDATE session_items SET label=$1 WHERE id=1', ['read-only-change']), code('READ_ONLY'));
    await assert.rejects(readOnly.all('DELETE FROM session_items WHERE id=1'), code('READ_ONLY'));
    assert.deepEqual(await readOnly.all('SELECT id,label FROM session_items WHERE id=1'), [{id:'1',label:"SYNTHETIC_' OR 1=1--"}]);
    assert.deepEqual(await readOnly.all('SELECT id FROM session_items WHERE id=21'), []);
    cases.push('read-only root insert/update/delete all reject and leave original data and a reusable session');
    await assert.rejects(readOnly.transaction(tx => tx.all('INSERT INTO session_items VALUES(20,$1,0)', ['read-only'])), code('READ_ONLY'));
    assert.deepEqual(await readOnly.all('SELECT id FROM session_items WHERE id=20'), []);
    cases.push('read-only transaction rejects writes and recovers');
  } finally { await readOnly.close(); }
  phase = name + ': unconfirmed applied COMMIT';
  const raw = await connect(), sent = []; let callbacks = 0;
  const hiding = { ...raw, async query(sql, values) { sent.push(sql); const result = await raw.query(sql, values); if (sql === 'COMMIT') throw new Error('synthetic post-ack transport loss'); return result; } };
  const uncertain = createAsyncSession(createPostgresExecutor(hiding), { dialect:'postgresql' });
  try {
    await assert.rejects(uncertain.transaction(async tx => { callbacks++; await tx.all('INSERT INTO session_items VALUES(30,$1,0)', ['durable-unconfirmed']); }), code('COMMIT_UNCONFIRMED'));
    await assert.rejects(uncertain.all('SELECT 1'), code('CONNECTION_UNUSABLE'));
    assert.equal(callbacks, 1); assert.ok(!sent.includes('ROLLBACK'));
  } finally { await uncertain.close(); }
  const reopened = createAsyncSession(createPostgresExecutor(await connect()), { dialect:'postgresql' });
  try { assert.deepEqual(await reopened.all('SELECT id FROM session_items WHERE id=30'), [{id:'30'}]); } finally { await reopened.close(); }
  cases.push('applied COMMIT with deliberately hidden acknowledgment is not replayed or called a rollback; reopen proves durable row');
  return { version, cases, controlStatements: controls, limitations: name === 'pglite' ? ['Single embedded connection, no independent-session/network/pool claim. Synchronous WASM work cannot be interrupted by the executor timer.'] : ['Dedicated clients only; no pool validation. Hidden ACK is deliberate fault injection, not an actual TCP-loss claim.'] };
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
  const one = createAsyncSession(createPostgresExecutor(await connectPg()), {dialect:'postgresql'});
  const two = createAsyncSession(createPostgresExecutor(await connectPg()), {dialect:'postgresql'});
  try {
    const held = deferred(), release = deferred(), read = deferred(); let callbacks = 0;
    const a = one.transaction(async tx => { await tx.all('SELECT amount FROM session_items WHERE id=2'); await tx.all('UPDATE session_items SET amount=1 WHERE id=2'); held.resolve(); await release.promise; });
    // Observe a's failure immediately and always release its held callback, including assertion failures.
    const firstOutcome = a.then(() => undefined, error => error);
    try {
      await reachedBeforeSettlement(held, firstOutcome);
      assert.deepEqual(await two.all('SELECT amount FROM session_items WHERE id=2'), [{amount:'0'}]);
      const b = two.transaction(async tx => { callbacks++; await tx.all('SELECT amount FROM session_items WHERE id=2'); read.resolve(); await tx.all('UPDATE session_items SET amount=2 WHERE id=2'); });
      const outcome = b.then(()=> 'incorrect-success', error => error.code);
      await reachedBeforeSettlement(read, outcome); release.resolve(); assert.equal(await firstOutcome, undefined);
      assert.equal(await outcome, 'SERIALIZATION_FAILURE'); assert.equal(callbacks,1);
    } finally { release.resolve(); await firstOutcome; }
    assert.deepEqual(await two.all('SELECT amount FROM session_items WHERE id=2'), [{amount:'1'}]);
    report.engines.postgresql.cases.push('independent clients cannot observe uncommitted write; actual serialization conflict is reported without replay');
  } finally { await one.close(); await two.close(); }
  phase = 'postgresql: actual backend termination during an issued statement';
  const victim = createAsyncSession(createPostgresExecutor(await connectPg()), {dialect:'postgresql'}), administrator = await connectPg();
  try {
    const pid = (await victim.all('SELECT pg_backend_pid() AS pid'))[0].pid;
    const pending = victim.all('SELECT pg_sleep(30)');
    const outcome = pending.then(()=> 'incorrect-success', error=>error.code);
    let active = false;
    for(let i=0;i<30;i++) {
      const check = await administrator.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
      if(check.rows[0]?.wait_event === 'PgSleep') { active=true; break; }
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
} catch (error) { original ??= error; }
report.sourceHashes = Object.fromEntries(['async-session.ts','executor.ts','postgres-control.ts','postgres-executor.ts'].map(name => [name,createHash('sha256').update(readFileSync(new URL('../../src/core/'+name,import.meta.url))).digest('hex')]));
report.harnessSha256 = harnessSha256;
report.glueSha256 = glueSha256;
// Preserve the finite fictional-data report in CI logs without uploading database files or generated credentials.
const outcome = { ...report, failed:!!original, ...(original ? { phase, error:{code:original.code??'ASSERTION',message:String(original.message).replaceAll(password,'[redacted]').slice(0,1000)} } : {}) };
if (process.env.CI) console.log(JSON.stringify(outcome));
writeFileSync(resultUrl,JSON.stringify(outcome,null,2)+'\n');
if(original) { console.error('Engine checks failed at '+phase+'; report: '+fileURLToPath(resultUrl)); process.exitCode=1; }
else console.log(JSON.stringify({postgresql:report.engines.postgresql.cases.length,pglite:report.engines.pglite.cases.length,cleanup:report.cleanup,scope:report.scope,report:fileURLToPath(resultUrl)}));
