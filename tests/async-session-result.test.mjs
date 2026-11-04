import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import * as sdk from '../dist/index.js';
import { openAsyncDatabaseWithExecutor } from '../dist/core/async-database.js';
import { createAsyncSession } from '../dist/core/async-session.js';
import { acknowledgedRejection, inlineAsyncExecutor } from '../dist/core/executor.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';

// A callback's settled result is checked before COMMIT or RELEASE. All data is fictional.
const code = value => error => error?.code === value;
const ticks = async count => { for (let i = 0; i < count; i++) await null; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const items = sdk.defineTable('result_items', { id: sdk.column.integer().primaryKey(), label: sdk.column.text() });

function recording() {
  const sync = openSqliteExecutor(':memory:'), inner = inlineAsyncExecutor(sync), calls = [];
  const state = { calls, committed: false, onControl: undefined, lose: undefined, rejectCommit: false };
  const executor = {
    all: (sql, parameters) => { calls.push(sql); return inner.all(sql, parameters); },
    async exec(sql) {
      calls.push(sql);
      if (sql === 'COMMIT' && state.rejectCommit) { await inner.exec('ROLLBACK'); throw acknowledgedRejection(new sdk.RowstitchError('CONSTRAINT', 'Fictional rejected COMMIT.')); }
      await inner.exec(sql);
      if (sql === 'COMMIT') state.committed = true;
      state.onControl?.(sql);
      if (sql === 'COMMIT' && state.lose) throw new Error('fictional lost acknowledgment');
    },
    inTransaction: () => inner.inTransaction(), close: () => inner.close(),
  };
  return { state, executor, sync };
}
async function bareSession(t) {
  const { state, executor, sync } = recording();
  sync.exec('CREATE TABLE result_items(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  const session = createAsyncSession(executor);
  t.after(() => session.close().catch(() => {}));
  const insert = (owner, id) => owner.all('INSERT INTO result_items(id,label) VALUES (?,?)', [id, 'fictional']);
  return { state, session, insert,
    transaction: session.transaction, nest: (tx, callback) => tx.transaction(callback),
    ids: async () => (await session.all('SELECT id FROM result_items ORDER BY id')).map(row => Number(row.id)) };
}
async function publicDatabase(t) {
  const { state, executor } = recording();
  const db = await openAsyncDatabaseWithExecutor(executor, { tables: [items] });
  t.after(() => db.close());
  await db.ensureSchema(); state.calls.length = 0; state.committed = false;
  return { state, db, insert: (owner, id) => owner.table(items).insert({ id, label: 'fictional' }),
    transaction: (callback, options) => db.transaction(callback, options), nest: (tx, callback) => tx.transaction(callback),
    ids: async () => (await db.table(items).findMany()).map(row => Number(row.id)).sort((a, b) => a - b) };
}
const surfaces = [['bare session', bareSession], ['public async database', publicDatabase]];
const each = (name, body) => { for (const [label, open] of surfaces) test(name + ' (' + label + ')', async t => body(await open(t), t)); };
const noCommit = calls => { assert.ok(!calls.includes('COMMIT')); assert.ok(calls.includes('ROLLBACK')); };

/** Every trap records its name, so a test can prove that validation used none of them. */
function trapped(target, get) {
  const traps = [], handler = {};
  for (const name of Object.getOwnPropertyNames(Reflect)) handler[name] = (...args) => { traps.push(name); return Reflect[name](...args); };
  if (get) handler.get = (...args) => { traps.push('get'); return get(...args); };
  return { proxy: new Proxy(target, handler), traps };
}
const lateThrow = state => () => { if (state.committed) throw new Error('fictional late failure'); return undefined; };
class AccessorThen { get then() { return undefined; } }
class Grandchild extends AccessorThen {}
class DataThen {} DataThen.prototype.then = 'inherited data';

each('the own-getter counterexample is refused before COMMIT, not failed after it', async f => {
  let reads = 0, callbacks = 0; const late = lateThrow(f.state);
  await assert.rejects(f.transaction(tx => { callbacks++; return f.insert(tx, 1).then(() => ({ get then() { reads++; return late(); } })); }), code('VALIDATION'));
  assert.equal(f.state.committed, false); noCommit(f.state.calls);
  assert.equal(callbacks, 1);
  assert.deepEqual(await f.ids(), []);
  // Exactly the engine's adoption reads happened: validation added none, and no read ever saw a committed state.
  const adoption = reads;
  await turn(); assert.equal(reads, adoption);
  // The connection recovers normally.
  await f.transaction(tx => f.insert(tx, 2)); assert.deepEqual(await f.ids(), [2]);
});

test('a synchronous result reaches validation after exactly one engine read and no accessor call by the session', async t => {
  const f = await bareSession(t); let reads = 0;
  await assert.rejects(f.session.transaction(() => ({ get then() { reads++; return undefined; } })), code('VALIDATION'));
  assert.equal(reads, 1);
});

const unsafe = [
  ['own getter', () => ({ get then() { return undefined; } })],
  ['own setter alone', () => ({ set then(_) {} })],
  ['inherited accessor', () => new AccessorThen()],
  ['deeply inherited accessor', () => Object.create(Object.create(new Grandchild()))],
  ['null-prototype accessor', () => Object.defineProperty(Object.create(null), 'then', { get: () => undefined })],
  ['function with an accessor', () => Object.defineProperty(() => {}, 'then', { get: () => undefined })],
  ['plain Proxy', () => new Proxy({}, {})],
  ['Proxy over an array', () => new Proxy([], {})],
  ['Proxy over a function', () => new Proxy(() => {}, {})],
  ['Proxy in the prototype chain', () => Object.create(new Proxy({}, {}))],
  ['Proxy deep in the prototype chain', () => Object.create(Object.create(Object.create(new Proxy({}, {}))))],
  ['cross-realm Proxy', () => vm.runInNewContext('new Proxy({}, {})')],
  ['chain beyond the bound', () => { let value = Object.create(null); for (let i = 0; i < 64; i++) value = Object.create(value); return value; }],
];
each('unsafe settled results roll back before COMMIT', async f => {
  for (const [label, make] of unsafe) {
    f.state.calls.length = 0; let produced;
    await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); produced = make(); return produced; }), error => {
      assert.ok(code('VALIDATION')(error), label); assert.ok(!/fictional/.test(error.message)); return true;
    }, label);
    noCommit(f.state.calls);
    assert.deepEqual(await f.ids(), [], label);
    assert.ok(produced, label);
  }
});
each('a function assigned as then after adoption is refused and never called', async f => {
  let calls = 0; const value = {};
  await assert.rejects(f.transaction(async tx => {
    await f.insert(tx, 1);
    return { then(resolve) { resolve(value); value.then = () => { calls++; }; } };
  }), code('VALIDATION'));
  noCommit(f.state.calls); await turn(); assert.equal(calls, 0);
});
test('a stateful Proxy is refused using only the engine\'s then read, and no other trap', async t => {
  const f = await bareSession(t), late = lateThrow(f.state);
  const { proxy, traps } = trapped({}, (target, key, receiver) => key === 'then' ? late() : Reflect.get(target, key, receiver));
  await assert.rejects(f.session.transaction(tx => f.insert(tx, 1).then(() => proxy)), code('VALIDATION'));
  noCommit(f.state.calls); assert.equal(f.state.committed, false);
  assert.ok(traps.length > 0 && traps.every(name => name === 'get'), 'Only the promise machinery reads, and only through get.');
  const before = traps.length; await turn(); assert.equal(traps.length, before);
  const inherited = trapped({}, (target, key, receiver) => key === 'then' ? undefined : Reflect.get(target, key, receiver));
  await assert.rejects(f.session.transaction(() => Object.create(inherited.proxy)), code('VALIDATION'));
  assert.deepEqual([...new Set(inherited.traps)], ['get']);
});
test('a revoked Proxy fails with the engine\'s own error before COMMIT', async t => {
  const f = await bareSession(t), { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  await assert.rejects(f.session.transaction(tx => f.insert(tx, 1).then(() => proxy)), TypeError);
  noCommit(f.state.calls); assert.deepEqual(await f.ids(), []);
});

each('ordinary settled results commit and keep their exact identity, unmodified', async f => {
  const frozen = Object.freeze({ a: 1 }), sealed = Object.seal({ b: 2 }), fn = () => 1, nullProto = Object.create(null), list = [1], when = new Date(0), map = new Map();
  class Plain {} const instance = new Plain(), shadow = Object.create(new Proxy({}, { get() { throw new Error('fictional trap'); } }));
  Object.defineProperty(shadow, 'then', { value: 'own data shadows the Proxy' });
  let deep = Object.create(null); for (let i = 0; i < 63; i++) deep = Object.create(deep);
  const objects = [frozen, sealed, fn, nullProto, list, when, map, instance, deep, shadow, new DataThen(), { then: 'text' }, { then: null }, { then: 0 }, { then: undefined }, { then: {} },
    Object.assign(() => {}, { then: 'function with data' }), vm.runInNewContext('({ crossRealm: true })')];
  let id = 0;
  for (const value of objects) {
    const keys = Reflect.ownKeys(value), extensible = Object.isExtensible(value), isFrozen = Object.isFrozen(value);
    const nextId = ++id, result = await f.transaction(async tx => { await f.insert(tx, nextId); return value; });
    assert.equal(result, value);
    assert.deepEqual(Reflect.ownKeys(value), keys); assert.equal(Object.isExtensible(value), extensible); assert.equal(Object.isFrozen(value), isFrozen);
  }
  for (const value of [undefined, null, 0, '', 'text', false, 1n, Symbol.iterator]) {
    const nextId = ++id; assert.equal(await f.transaction(async tx => { await f.insert(tx, nextId); return value; }), value);
  }
  assert.equal((await f.ids()).length, id);
});
each('genuine Promises and PromiseLike callbacks that resolve to ordinary values are supported', async f => {
  const value = { label: 'ordinary' }; class Sub extends Promise {} let id = 0;
  const forms = [
    () => Promise.resolve(value), async () => value, () => Sub.resolve(value),
    () => ({ then(resolve) { resolve(value); } }),
    () => ({ then(resolve) { setImmediate(() => resolve(value)); } }),
    () => ({ then(resolve) { resolve({ then(inner) { inner(value); } }); } }),
    () => Object.create({ then(resolve) { resolve(value); } }),
    () => ({ get then() { return resolve => resolve(value); } }),
    () => new Proxy({}, { get: (_, key) => key === 'then' ? resolve => resolve(value) : undefined }),
    () => Object.assign(() => {}, { then(resolve) { resolve(value); } }),
  ];
  for (const form of forms) {
    const nextId = ++id, result = await f.transaction(async tx => { await f.insert(tx, nextId); return form(); });
    assert.equal(result, value);
  }
  assert.equal(await f.transaction(tx => f.insert(tx, ++id).then(() => 'sync thenable path')), 'sync thenable path');
  assert.equal(f.state.calls.filter(sql => sql === 'COMMIT').length, id);
});
each('PromiseLike and Promise resolving to an unsafe value are refused after adoption', async f => {
  const hidden = { get then() { return undefined; } };
  await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); return Promise.resolve(hidden); }), code('VALIDATION'));
  await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); return { then(resolve) { resolve(hidden); } }; }), code('VALIDATION'));
  assert.ok(!f.state.calls.includes('COMMIT')); assert.deepEqual(await f.ids(), []);
});
each('getter, thenable and callback failures keep their exact identity and roll back', async f => {
  for (const original of [new Error('fictional getter failure'), 'fictional text', Object.freeze({ fictional: true })]) {
    let callbacks = 0;
    for (const form of [() => ({ get then() { throw original; } }), () => ({ then(_, reject) { reject(original); } }), () => { throw original; }, () => Promise.reject(original)]) {
      await assert.rejects(f.transaction(async tx => { callbacks++; await f.insert(tx, 1); return form(); }), error => error === original);
    }
    assert.equal(callbacks, 4); noCommit(f.state.calls); assert.deepEqual(await f.ids(), []);
  }
});

each('a nested unsafe result is refused before RELEASE; the parent may catch it and commit', async f => {
  const outcome = await f.transaction(async tx => {
    await f.insert(tx, 1);
    await assert.rejects(f.nest(tx, async child => { await f.insert(child, 2); return { get then() { return undefined; } }; }), code('VALIDATION'));
    await f.insert(tx, 3);
    return 'parent value';
  });
  assert.equal(outcome, 'parent value'); assert.deepEqual(await f.ids(), [1, 3]);
  assert.ok(f.state.calls.some(sql => sql.startsWith('ROLLBACK TO'))); assert.equal(f.state.calls.filter(sql => sql === 'COMMIT').length, 1);
});

const changes = {
  'callable data then': value => { value.then = () => { throw new Error('fictional foreign failure'); }; },
  'accessor then': value => { Object.defineProperty(value, 'then', { get() { throw new Error('fictional foreign failure'); } }); },
  'prototype with a callable then': value => { Object.setPrototypeOf(value, { then() { throw new Error('fictional foreign failure'); } }); },
  'Proxy prototype': value => { Object.setPrototypeOf(value, new Proxy({}, { get() { throw new Error('fictional foreign failure'); } })); },
};
each('a result changed while COMMIT is in flight reports the acknowledged commit explicitly', async f => {
  let id = 0;
  for (const [label, change] of Object.entries(changes)) {
    const value = {}, nextId = ++id;
    f.state.onControl = sql => { if (sql === 'COMMIT') change(value); };
    await assert.rejects(f.transaction(async tx => { await f.insert(tx, nextId); return value; }), error => {
      assert.ok(code('TRANSACTION_RESULT_CHANGED')(error), label); assert.match(error.message, /acknowledged/); assert.ok(!/foreign/.test(error.message)); return true;
    }, label);
    f.state.onControl = undefined;
    assert.ok(!f.state.calls.includes('ROLLBACK'), 'Nothing is rolled back after an acknowledged COMMIT.');
    assert.ok((await f.ids()).includes(nextId), 'The row is durable: this is not reported as a rollback.');
  }
});
test('nested result changed during RELEASE is reported, and the parent still decides', async t => {
  const f = await bareSession(t), value = {};
  f.state.onControl = sql => { if (sql.startsWith('RELEASE')) value.then = () => {}; };
  await f.session.transaction(async tx => {
    await assert.rejects(tx.transaction(async child => { await f.insert(child, 1); return value; }), code('TRANSACTION_RESULT_CHANGED'));
  });
  f.state.onControl = undefined; assert.deepEqual(await f.ids(), [1]);
});
test('bare session: a change at any tick after COMMIT never surfaces a foreign failure', async t => {
  const seen = new Set();
  for (let tick = 0; tick < 24; tick++) {
    const f = await bareSession(t), value = {}; let foreign = 0;
    f.state.onControl = sql => { if (sql === 'COMMIT') ticks(tick).then(() => { value.then = () => { foreign++; throw new Error('fictional foreign failure'); }; }); };
    const result = await f.session.transaction(tx => f.insert(tx, 1).then(() => value)).then(got => { assert.equal(got, value); return 'delivered'; }, error => error.code);
    seen.add(result); assert.ok(['delivered', 'TRANSACTION_RESULT_CHANGED'].includes(result), String(result));
    await turn(); assert.equal(foreign, 0, 'The session read then exactly once, right after its check.');
    assert.deepEqual(await f.ids(), [1]);
  }
  assert.deepEqual([...seen].sort(), ['TRANSACTION_RESULT_CHANGED', 'delivered']);
});

each('unknown-outcome rules are unchanged: a lost COMMIT stays unconfirmed, whatever the result', async f => {
  f.state.lose = true;
  await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); return { then: 'data' }; }), code('COMMIT_UNCONFIRMED'));
  assert.ok(!f.state.calls.includes('ROLLBACK'));
});
each('an acknowledged COMMIT rejection is still reported as such', async f => {
  f.state.rejectCommit = true;
  await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); return { ordinary: true }; }), code('CONSTRAINT'));
  f.state.rejectCommit = false;
});
each('pending work takes precedence over an unsafe result and stays handled', async f => {
  const unhandled = [], listener = error => unhandled.push(error); process.on('unhandledRejection', listener);
  try {
    await assert.rejects(f.transaction(async tx => { f.insert(tx, 1); return { get then() { return undefined; } }; }), code('TRANSACTION_PENDING'));
    noCommit(f.state.calls); await turn(); await turn(); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
each('abort takes precedence over an unsafe result', async f => {
  const controller = new AbortController();
  await assert.rejects(f.transaction(async tx => { await f.insert(tx, 1); controller.abort(); return { get then() { return undefined; } }; }, { signal: controller.signal }), code('ABORTED'));
  noCommit(f.state.calls);
});
test('a refused result does not block queued root work, in order', async t => {
  const f = await bareSession(t);
  const first = f.session.transaction(async tx => { await f.insert(tx, 1); return new Proxy({}, {}); });
  const second = f.session.transaction(tx => f.insert(tx, 2).then(() => 'queued value'));
  await assert.rejects(first, code('VALIDATION')); assert.equal(await second, 'queued value');
  assert.deepEqual(await f.ids(), [2]);
});

test('the real worker-backed public API refuses before COMMIT and stays usable', async t => {
  const db = await sdk.openAsyncDatabase(':memory:', { tables: [items] });
  t.after(() => db.close());
  await db.ensureSchema(); db.clearTrace();
  let committed = false;
  const repository = db.table(items);
  await assert.rejects(db.transaction(async tx => {
    await tx.table(items).insert({ id: 1, label: 'fictional' });
    return { get then() { if (committed) throw new Error('fictional late failure'); return undefined; } };
  }), code('VALIDATION'));
  committed = true;
  assert.equal(await repository.count(), 0);
  const sql = db.exportTrace().queries.map(entry => entry.sql);
  assert.ok(sql.includes('ROLLBACK')); assert.ok(!sql.includes('COMMIT'));
  const value = { then: 'ordinary field' };
  assert.equal(await db.transaction(async tx => { await tx.table(items).insert({ id: 2, label: 'fictional' }); return value; }), value);
  assert.equal(await repository.count(), 1);
});

// Default process policy: no listener is installed in the child, so nothing here can mark a rejection handled.
function child(body) {
  const source = `(async () => {
    const { createAsyncSession } = await import(${JSON.stringify(new URL('../dist/core/async-session.js', import.meta.url).href)});
    const { inlineAsyncExecutor } = await import(${JSON.stringify(new URL('../dist/core/executor.js', import.meta.url).href)});
    const { openSqliteExecutor } = await import(${JSON.stringify(new URL('../dist/core/sqlite-executor.js', import.meta.url).href)});
    const session = createAsyncSession(inlineAsyncExecutor(openSqliteExecutor(':memory:')));
    ${body}
    await new Promise(resolve => setTimeout(resolve, 40));
    console.log('SURVIVED');
    await session.close();
  })();`;
  return spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 30_000 });
}
test('a forgotten refused or changed transaction stays reported by Node, not silently swallowed', () => {
  const refused = child(`session.transaction(() => new Proxy({}, {}));`);
  assert.notEqual(refused.status, 0); assert.ok(!refused.stdout.includes('SURVIVED')); assert.match(refused.stderr, /VALIDATION/);
  const changed = child(`const inner = inlineAsyncExecutor(openSqliteExecutor(':memory:')), value = {};
    const hooked = createAsyncSession({ all: (sql, values) => inner.all(sql, values), exec: async sql => { await inner.exec(sql); if (sql === 'COMMIT') value.then = () => {}; }, inTransaction: () => inner.inTransaction(), close: () => inner.close() });
    hooked.transaction(() => value);`);
  assert.notEqual(changed.status, 0); assert.ok(!changed.stdout.includes('SURVIVED')); assert.match(changed.stderr, /TRANSACTION_RESULT_CHANGED/);
  const ordinary = child(`await session.transaction(() => ({ then: 'data' }));`);
  assert.equal(ordinary.status, 0, ordinary.stderr); assert.ok(ordinary.stdout.includes('SURVIVED'));
});
