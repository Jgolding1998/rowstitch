import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = process.env.ROWSTITCH_TEST_DIST ? pathToFileURL(resolve(process.env.ROWSTITCH_TEST_DIST) + '/') : new URL('../dist/', import.meta.url);
const { createNativeGraphResources: create, NATIVE_GRAPH_LIMITS: LIMITS } = await import(new URL('core/graph-resources.js', dist));
const secret = 'FICTIONAL_PRIVATE_GRAPH_VALUE';
const code = expected => error => {
  assert.equal(error?.code, expected);
  assert.equal(error?.cause, undefined);
  assert.ok(!inspect(error, { showHidden: true, depth: 8 }).includes(secret));
  return true;
};
const meter = (units, wireBytes = LIMITS.wireBytes) => create({ units, wireBytes });
const attached = (m, storage, logical = storage) => { const costs = m.source(storage); m.attach(logical, costs); return logical; };
const hostile = () => {
  let traps = 0;
  const proxy = new Proxy({}, new Proxy({}, { get() { return () => { traps++; throw new Error(secret); }; } }));
  return { proxy, count: () => traps };
};

test('native defaults are fixed and both ledgers accept zero private limits', () => {
  assert.deepEqual(LIMITS, { wireBytes: 33_554_432, units: 268_435_456 });
  assert.ok(Object.isFrozen(LIMITS));
  assert.ok(Object.isFrozen(create()));
  const m = meter(0, 0);
  m.relatedWire(0);
  assert.throws(() => m.relatedWire(1), code('RESULT_LIMIT'));
  assert.throws(() => m.source({}), code('RESULT_LIMIT'));
});
test('wire accounting is cumulative, exact-boundary and independent of unit accounting', () => {
  const m = meter(32, 7);
  m.relatedWire(3); m.relatedWire(4); m.relatedWire(0);
  m.source({});
  assert.throws(() => m.relatedWire(1), code('RESULT_LIMIT'));
  assert.throws(() => m.source({}), code('RESULT_LIMIT'));
});
test('a failed wire reservation does not spend otherwise available wire', () => {
  const m = meter(0, 4);
  assert.throws(() => m.relatedWire(5), code('RESULT_LIMIT'));
  m.relatedWire(4);
});
test('source record and primitive property unit boundaries are exact', () => {
  const m = meter(66);
  const costs = m.source({ x: 1 });
  assert.deepEqual({ ...costs }, { x: 34 });
  assert.ok(Object.isFrozen(costs));
  assert.equal(Object.getPrototypeOf(costs), null);
  assert.equal(Reflect.ownKeys(costs).length, 1);
  assert.throws(() => m.source({}), code('RESULT_LIMIT'));
  assert.throws(() => meter(65).source({ x: 1 }), code('RESULT_LIMIT'));
});
test('one shared unit ledger charges source work and every materialized occurrence', () => {
  const m = meter(198), row = attached(m, { x: 1 });
  m.outputRecord(row, ['x']); m.outputRecord(row, ['x']);
  assert.throws(() => m.outputRecord(row, ['x']), code('RESULT_LIMIT'));
});
test('hidden source fields remain charged but are not copied unless visible', () => {
  const m = meter(176), row = attached(m, { x: 1, hidden: null });
  assert.throws(() => m.outputRecord(row, ['hidden']), code('RESULT_LIMIT'));
  m.outputRecord(row, ['x']);
  assert.throws(() => m.outputArray(0), code('RESULT_LIMIT'));
});
test('source and output include internal aggregate names and safe own __proto__ fields', () => {
  const storage = Object.assign(Object.create(null), { __rs_bad: 0n, __rs_hi: 2n, constructor: true });
  Object.defineProperty(storage, '__proto__', { value: null, enumerable: true });
  const m = create(), costs = m.source(storage), row = { __rs_bad: 0n };
  m.attach(row, costs); m.outputRecord(row, ['__rs_bad']);
  assert.deepEqual(Object.keys(costs), ['__rs_bad', '__rs_hi', 'constructor', '__proto__']);
});
test('UTF-8 and UTF-16 accounting handle non-ASCII, escaped storage and logical JSON strings', () => {
  for (const [value, fieldCost] of [['é', 36], ['💡', 38], ['\ud800', 37], ['\0', 36]]) {
    const m = meter(32 + fieldCost), costs = m.source({ x: value });
    assert.equal(costs.x, fieldCost);
  }
  const storage = { j: '"\\u0000\\ud800"' }, logical = { j: '\0\ud800' }, m = create();
  const costs = m.source(storage); m.attach(logical, costs); m.outputRecord(logical, ['j']);
  assert.equal(costs.j, 34 + 2 * storage.j.length);
});
test('huge positive and negative exact bigint costs use full decimal width without rounding', () => {
  for (const value of [10n ** 10_000n, -(10n ** 10_000n), 9007199254740993n]) {
    const width = String(value).length, expected = 34 + 2 * width;
    const m = meter(2 * (32 + expected)), row = attached(m, { x: value });
    m.outputRecord(row, ['x']);
    assert.throws(() => m.outputArray(0), code('RESULT_LIMIT'));
  }
});
test('projected records independently charge recombined bigint and long text beside root output', () => {
  const sum = 2n ** 90n, m = create();
  const root = attached(m, { id: 1n, __rs_hi: sum / 4294967296n, __rs_low: sum % 4294967296n, __rs_bad: 0n }, { id: 1 });
  const projected = attached(m, { total: sum, latest: 'z'.repeat(10_000) });
  m.outputRecord(root, ['id']); m.outputRecord(projected, ['total', 'latest']);
  const costs = create().source({ total: sum });
  assert.equal(costs.total, 16 + 10 + 16 + 2 * String(sum).length);
});
test('empty JSON object and array structural source/copy costs have exact boundaries', () => {
  for (const value of [{}, []]) {
    const m = meter(184), row = { j: value };
    m.attach(row, m.source({ j: Array.isArray(value) ? '[]' : '{}' }));
    m.outputRecord(row, ['j']);
    assert.throws(() => m.outputArray(0), code('RESULT_LIMIT'));
    const low = meter(183), r = { j: value };
    low.attach(r, low.source({ j: Array.isArray(value) ? '[]' : '{}' }));
    assert.throws(() => low.outputRecord(r, ['j']), code('RESULT_LIMIT'));
  }
});
test('many-small-object JSON is charged structurally at attach rather than only by wire spelling', () => {
  const value = Array.from({ length: 20 }, () => ({})), text = '[' + Array(20).fill('{}').join(',') + ']';
  assert.equal(text.length, 61);
  const m = meter(1019), row = { j: value };
  const costs = m.source({ j: text });
  assert.equal(costs.j, 156);
  assert.throws(() => m.attach(row, costs), code('RESULT_LIMIT'));
  const exact = meter(1902), r = { j: value };
  exact.attach(r, exact.source({ j: text })); exact.outputRecord(r, ['j']);
  assert.throws(() => exact.outputRecord(r, ['j']), code('RESULT_LIMIT'));
});
test('repeated-parent and alias JSON copies are reserved before the next clone', () => {
  const json = { a: 1 }, m = meter(262), row = { j: json };
  m.attach(row, m.source({ j: '{"a":1}' }));
  let clones = 0;
  const materialize = () => { m.outputRecord(row, ['j']); clones++; return structuredClone(json); };
  assert.deepEqual(materialize(), json);
  assert.throws(materialize, code('RESULT_LIMIT'));
  assert.equal(clones, 1);
});
test('attachment caches numeric JSON costs once without retaining or rewalking its values', () => {
  let calls = 0;
  const json = { a: 1 }, m = create(), row = { j: json };
  const costs = m.source({ j: '{"a":1}' }); m.attach(row, costs);
  Object.defineProperty(json, 'a', { get() { calls++; throw new Error(secret); }, enumerable: true });
  Object.defineProperty(row, 'j', { get() { calls++; throw new Error(secret); }, enumerable: true });
  m.outputRecord(row, ['j']); m.outputRecord(row, ['j']);
  assert.equal(calls, 0);
  assert.ok(Object.values(costs).every(cost => typeof cost === 'number'));
});
test('alias, singular/null, many-array and root-array overhead is charged on each occurrence', () => {
  const m = meter(208);
  m.outputArray(2);       // 48
  m.outputAlias('kids', 2); // property24 + array48 =72
  m.outputAlias('one', null); // property22 + scalar16 =38
  m.outputAlias('x', 0); // property18 + array32 =50; total208
  assert.throws(() => m.outputArray(0), code('RESULT_LIMIT'));
});
test('alias and array exact zero-entry boundaries are independent reservations', () => {
  meter(32).outputArray(0);
  assert.throws(() => meter(31).outputArray(0), code('RESULT_LIMIT'));
  meter(50).outputAlias('x', 0);
  assert.throws(() => meter(49).outputAlias('x', 0), code('RESULT_LIMIT'));
  meter(34).outputAlias('x', null);
  assert.throws(() => meter(33).outputAlias('x', null), code('RESULT_LIMIT'));
});
test('meter counters, attachments and source-cost provenance are per Work', () => {
  const a = meter(66, 2), b = meter(132, 2), costs = a.source({ x: 1 }), row = { x: 1 };
  a.relatedWire(2); b.relatedWire(2);
  assert.throws(() => b.attach(row, costs), code('DATA'));
  b.attach(row, b.source({ x: 1 })); b.outputRecord(row, ['x']);
  assert.throws(() => a.outputRecord(row, ['x']), code('DATA'));
});
test('plain null-prototype and frozen data inputs work and caller objects are not changed', () => {
  const m = create(), storage = Object.freeze(Object.assign(Object.create(null), { x: 'hi' }));
  const row = Object.freeze(Object.assign(Object.create(null), { x: 'hi' }));
  const keys = Reflect.ownKeys(row);
  m.attach(row, m.source(storage)); m.outputRecord(row, Object.freeze(['x']));
  assert.deepEqual(Reflect.ownKeys(row), keys); assert.equal(row.x, 'hi');
});
test('limits are captured once and reject elevated, incomplete, non-own and invalid values', () => {
  const input = { units: 32, wireBytes: 0 }, m = create(input);
  input.units = LIMITS.units; input.wireBytes = LIMITS.wireBytes;
  m.source({});
  assert.throws(() => m.source({}), code('RESULT_LIMIT'));
  assert.throws(() => m.relatedWire(1), code('RESULT_LIMIT'));
  for (const input of [null, [], 1, {}, { units: 0 }, { units: 0, wireBytes: 0, other: 0 },
    { units: LIMITS.units + 1, wireBytes: 0 }, { units: 0, wireBytes: LIMITS.wireBytes + 1 },
    { units: NaN, wireBytes: 0 }, { units: 0, wireBytes: -1 }, { units: 0.5, wireBytes: 0 },
    Object.create({ units: 0, wireBytes: 0 })]) assert.throws(() => create(input), code('DATA'));
});
test('source rejects noncanonical objects and primitives without coercing or exposing values', () => {
  for (const value of [undefined, Symbol(secret), () => secret, {}, [], NaN, Infinity, -Infinity]) {
    assert.throws(() => create().source({ [secret]: value }), code('DATA'));
  }
  for (const value of [null, [], new Date(), Object.create({ x: 1 }), 1, secret, () => secret]) {
    assert.throws(() => create().source(value), code('DATA'));
  }
});
test('source, limits, row and fields reject accessors and symbols without invoking getters', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error(secret); } };
  const storage = {}; Object.defineProperty(storage, 'x', getter);
  assert.throws(() => create().source(storage), code('DATA'));
  const limits = { units: 0 }; Object.defineProperty(limits, 'wireBytes', getter);
  assert.throws(() => create(limits), code('DATA'));
  const m = create(), costs = m.source({ x: 1 });
  assert.throws(() => m.attach(storage, costs), code('DATA'));
  const row = attached(m, { x: 1 }), fields = ['x']; Object.defineProperty(fields, '0', getter);
  assert.throws(() => m.outputRecord(row, fields), code('DATA'));
  for (const value of [{ x: 1, [Symbol(secret)]: 1 }, Object.defineProperty({}, 'x', { value: 1 })]) {
    assert.throws(() => create().source(value), code('DATA'));
    assert.throws(() => create().attach(value, costs), code('DATA'));
  }
  assert.equal(calls, 0);
});
test('proxies and revoked proxies are refused before any trap across all object inputs', () => {
  const h = hostile(), { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  for (const value of [h.proxy, proxy]) {
    assert.throws(() => create(value), code('DATA'));
    const m = create(), costs = m.source({ x: 1 }), row = { x: 1 }; m.attach(row, costs);
    assert.throws(() => m.source(value), code('DATA'));
    assert.throws(() => m.attach(value, costs), code('DATA'));
    assert.throws(() => m.attach({}, value), code('DATA'));
    assert.throws(() => m.attach({ x: value }, costs), code('DATA'));
    assert.throws(() => m.outputRecord(value, ['x']), code('DATA'));
    assert.throws(() => m.outputRecord(row, value), code('DATA'));
  }
  assert.equal(h.count(), 0);
});
test('attachment rejects duplicate rows, missing fields and forged or copied source metadata', () => {
  const m = create(), costs = m.source({ x: 1 }), row = { x: 1 };
  for (const fake of [{ x: 34 }, { ...costs }, Object.create(costs), null, 1]) assert.throws(() => m.attach(row, fake), code('DATA'));
  assert.throws(() => m.attach({ missing: 1 }, costs), code('DATA'));
  m.attach(row, costs);
  assert.throws(() => m.attach(row, costs), code('DATA'));
  assert.throws(() => m.outputRecord({ x: 1 }, ['x']), code('DATA'));
});
test('visible fields must be own dense distinct strings present in attached logical metadata', () => {
  const m = create(), row = attached(m, { x: 1, hidden: 2 }, { x: 1 });
  for (const fields of [['hidden'], ['missing'], ['x', 'x'], [1], [null], { 0: 'x', length: 1 }, ['x', ,],
    Object.assign(['x'], { extra: 1 }), Object.setPrototypeOf(['x'], {})]) assert.throws(() => m.outputRecord(row, fields), code('DATA'));
  m.outputRecord(row, []); m.outputRecord(row, ['x']);
});
test('logical primitives are validated even when canonical source provenance is legitimate', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, Symbol(secret), () => secret]) {
    const m = create(); assert.throws(() => m.attach({ x: value }, m.source({ x: 'encoded' })), code('DATA'));
  }
});
test('logical JSON rejects hooks, accessors, custom prototypes and symbolic metadata safely', () => {
  let calls = 0;
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { calls++; throw new Error(secret); } });
  for (const value of [{ toJSON() { calls++; throw new Error(secret); } }, getter, new Date(),
    Object.create({ private: secret }), { [Symbol(secret)]: 1 }, { a: undefined }, { a: 1n }, { a: NaN }]) {
    const m = create(); assert.throws(() => m.attach({ j: value }, m.source({ j: '{}' })), code('DATA'));
  }
  assert.equal(calls, 0);
});
test('logical JSON arrays must be dense plain data without custom keys or accessors', () => {
  let calls = 0;
  const accessor = [1]; Object.defineProperty(accessor, '0', { enumerable: true, get() { calls++; return 1; } });
  for (const value of [[,], Object.assign([], { extra: 1 }), Object.assign([], { [Symbol(secret)]: 1 }), accessor,
    Object.setPrototypeOf([], {}), [undefined], [Infinity], [() => secret]]) {
    const m = create(); assert.throws(() => m.attach({ j: value }, m.source({ j: '[]' })), code('DATA'));
  }
  assert.equal(calls, 0);
});
test('JSON null-prototype containers, escaped NUL/surrogates and acyclic repeated objects remain legal', () => {
  const shared = Object.assign(Object.create(null), { text: '\0\ud800', toJSON: 'plain data' });
  const array = Object.setPrototypeOf([shared, shared], null), m = create(), row = { j: array };
  m.attach(row, m.source({ j: '[]' })); m.outputRecord(row, ['j']);
});
test('JSON depth64 succeeds and depth65/cycles fail without recursive hooks', () => {
  const nested = count => { let value = null; for (let i = 0; i < count; i++) value = [value]; return value; };
  const m = create(); m.attach({ j: nested(64) }, m.source({ j: '[]' }));
  const over = create(); assert.throws(() => over.attach({ j: nested(65) }, over.source({ j: '[]' })), code('DATA'));
  const object = {}, array = []; object.self = object; array.push(array);
  for (const value of [object, array]) { const x = create(); assert.throws(() => x.attach({ j: value }, x.source({ j: '{}' })), code('DATA')); }
});
test('JSON counts every visited node: exactly100000 succeeds, one extra fails', () => {
  const m = create(); m.attach({ j: Array(99_999).fill(null) }, m.source({ j: '[]' }));
  const over = create(); assert.throws(() => over.attach({ j: Array(100_000).fill(null) }, over.source({ j: '[]' })), code('DATA'));
});
test('numeric metadata rejects coercion, fractions, negatives and unsafe or overflowing lengths', () => {
  let calls = 0;
  const coercible = { valueOf() { calls++; return 1; }, toString() { calls++; return secret; } };
  for (const value of [coercible, null, undefined, '1', true, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => create().relatedWire(value), code('DATA'));
    assert.throws(() => create().outputArray(value), code('DATA'));
    if (value !== null) assert.throws(() => create().outputAlias('x', value), code('DATA'));
  }
  assert.throws(() => create().outputArray(Number.MAX_SAFE_INTEGER), code('RESULT_LIMIT'));
  assert.throws(() => create().outputAlias('x', Number.MAX_SAFE_INTEGER), code('RESULT_LIMIT'));
  for (const value of [coercible, 1, null, undefined, new String('name')]) assert.throws(() => create().outputAlias(value, null), code('DATA'));
  assert.equal(calls, 0);
});
test('invalid descriptors and exhausted ledgers produce constant value-free diagnostics', () => {
  let data, limit;
  try { create().source({ [secret]: {} }); } catch (e) { data = e; }
  try { meter(0).source({ [secret]: secret }); } catch (e) { limit = e; }
  assert.equal(data.message, 'Native graph accounting data is invalid.');
  assert.equal(limit.message, 'The native eager graph exceeds its resource budget. Narrow the selected fields or page limits.');
  assert.ok(code('DATA')(data)); assert.ok(code('RESULT_LIMIT')(limit));
});
