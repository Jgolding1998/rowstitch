import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePostgresStorage } from '../dist/core/postgres-storage.js';
import { decode } from '../dist/core/schema.js';
import { decodePostgresRows, snapshotPostgresResult } from '../dist/core/postgres-result.js';

const data = error => error?.code === 'DATA' && !/SYNTHETIC_PRIVATE/.test(error.message);
const output = (kind, nullable = false, property = 'value') => [{alias: '__rs_pg_0', property, kind, nullable}];
const raw = (oid, values, command = 'SELECT') => ({fields: [{name: '__rs_pg_0', typeOid: oid}], rows: values.map(value => [value]), command, rowCount: BigInt(values.length)});
const values = (kind, oid, cells, nullable = false) => decodePostgresStorage(raw(oid, cells), output(kind, nullable), 'SELECT').map(row => row.value);
const config = (kind, nullable = false) => ({kind, nullable, primary: false, generated: false, unique: false, hasDefault: false});
const countOutput = [{alias: '__rs_pg_count', property: 'n', kind: 'bigint', nullable: false}];
const countRaw = cells => ({...raw(20, cells), fields: [{name: '__rs_pg_count', typeOid: 20}]});
const frozen = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; };

test('native integer widths produce exact shared-codec inputs and public integer or bigint values', () => {
  for (const [oid, min, max] of [[21, -32768n, 32767n], [23, -2147483648n, 2147483647n], [20, -9223372036854775808n, 9223372036854775807n]]) {
    const text = [min.toString(), '0', max.toString()];
    assert.deepEqual(values('bigint', oid, text), [min, 0n, max]);
    if (oid !== 20) assert.deepEqual(values('integer', oid, text).map(value => decode(config('integer'), value)), [Number(min), 0, Number(max)]);
  }
  const safe = [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER];
  assert.deepEqual(values('integer', 20, safe.map(String)).map(value => decode(config('integer'), value)), safe);
});

test('reported integer widths and safe integer bounds are checked before conversion', () => {
  for (const [oid, cells] of [[21, ['-32769', '32768']], [23, ['-2147483649', '2147483648']], [20, ['-9223372036854775809', '9223372036854775808']]]) {
    for (const kind of ['integer', 'bigint']) for (const cell of cells) assert.throws(() => values(kind, oid, [cell]), data);
  }
  for (const cell of ['-9007199254740992', '9007199254740992']) assert.throws(() => values('integer', 20, [cell]), data);
  for (const cell of ['-0', '+1', '01', '-01', '1.0', '1e2', '0x10', ' 1', '1 ', '', '1'.repeat(21)]) {
    for (const kind of ['integer', 'bigint']) assert.throws(() => values(kind, 20, [cell]), data);
  }
});

test('native float4 uses the stored binary32 value rather than a different Number parsed from shortest text', () => {
  // Native PGlite oracle: (0.1::real)::float8 is 0.10000000149011612, while real's text is 0.1.
  const result = values('real', 700, ['0.1', '-0', '0', '1e-45', '-1e-45', '3.4028235e38', '-3.4028235e38']);
  assert.equal(result[0], 0.10000000149011612); assert.notEqual(result[0], Number('0.1'));
  assert.ok(Object.is(result[1], -0)); assert.ok(Object.is(result[2], 0));
  assert.equal(result[3], Math.fround(1e-45)); assert.equal(result[4], Math.fround(-1e-45));
  assert.equal(result[5], Math.fround(3.4028235e38)); assert.equal(result[6], Math.fround(-3.4028235e38));
  for (const text of ['3.5e38', '-3.5e38', '1e-50', '-1e-50']) assert.throws(() => values('real', 700, [text]), data);
});

test('native float8 preserves finite extremes and minus zero and rejects malformed numeric text', () => {
  const result = values('real', 701, ['-0', '0.1', '1.7976931348623157e+308', '5e-324']);
  assert.ok(Object.is(result[0], -0)); assert.equal(result[1], 0.1); assert.equal(result[2], Number.MAX_VALUE); assert.equal(result[3], Number.MIN_VALUE);
  for (const oid of [700, 701]) for (const text of ['NaN', 'Infinity', '-Infinity', '1e309', '1e-400', '+1', '01', '0x10', '1junk', ' 1', '', '1'.repeat(65)]) assert.throws(() => values('real', oid, [text]), data);
});

test('boolean, text and JSON canonical storage decode through the existing shared codecs', () => {
  assert.deepEqual(values('boolean', 16, ['t', 'f']).map(value => decode(config('boolean'), value)), [true, false]);
  for (const cell of ['true', 'false', '1', '0', 'T', '']) assert.throws(() => values('boolean', 16, [cell]), data);
  for (const oid of [25, 1043]) assert.deepEqual(values('text', oid, ['é𝄞', "SYNTHETIC_' OR 1=1--"]), ['é𝄞', "SYNTHETIC_' OR 1=1--"]);
  for (const oid of [114, 3802]) {
    const text = '{"nested":[true,null,1],"exact":"9223372036854775807"}';
    assert.equal(values('json', oid, [text])[0], text);
    assert.deepEqual(decode(config('json'), values('json', oid, [text])[0]), {nested: [true, null, 1], exact: '9223372036854775807'});
  }
});

test('native JSON null is distinct from SQL NULL until the application codec decodes it', () => {
  for (const oid of [114, 3802]) {
    assert.deepEqual(values('json', oid, ['null']), ['null']);
    assert.equal(decode(config('json'), values('json', oid, ['null'])[0]), null);
    assert.throws(() => values('json', oid, [null]), data);
    assert.deepEqual(values('json', oid, [null, 'null', '"null"'], true), [null, 'null', '"null"']);
  }
  assert.equal(decode(config('json'), values('json', 114, ['"null"'])[0]), 'null');
});

test('native JSON uses the shared JS JSON contract without imposing JSONB escaped-string restrictions on JSON', () => {
  for (const text of ['"\\u0000"', '"\\ud800"', '{"\\u0000":"\\udfff"}']) {
    const encoded = values('json', 114, [text])[0];
    assert.equal(encoded, text); assert.deepEqual(decode(config('json'), encoded), JSON.parse(text));
  }
  const text = '{"n":9007199254740993,"z":-0}';
  const parsed = decode(config('json'), values('json', 114, [text])[0]);
  // Explicit existing JS-JSON limitations, not an arbitrary-precision or provenance guarantee.
  assert.equal(parsed.n, 9007199254740992); assert.ok(Object.is(parsed.z, -0));
  for (const text of ['not json', '{"n":1e999}', ' '.repeat(1_048_577)]) assert.throws(() => values('json', 114, [text]), data);
  let deep = 0; for (let i = 0; i < 65; i++) deep = [deep];
  assert.throws(() => values('json', 114, [JSON.stringify(deep)]), data);
});

test('JSON property names remain inert data and do not change object prototypes', () => {
  const text = '{"__proto__":{"polluted":true},"constructor":"fictional","prototype":1}';
  const stored = values('json', 114, [text])[0], parsed = decode(config('json'), stored);
  assert.equal(stored, text); assert.ok(Object.hasOwn(parsed, '__proto__'));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype); assert.equal({}.polluted, undefined);
});

test('actual wire strings must be valid UTF-8 text even when JSON escaped strings are allowed', () => {
  for (const [kind, oid] of [['text', 25], ['text', 1043], ['json', 114], ['json', 3802]]) {
    for (const text of ['bad\0text', '\ud800', '"\udfff"']) assert.throws(() => values(kind, oid, [text]), data);
  }
});

test('SQL NULL obeys declared nullability for every native kind', () => {
  for (const [kind, oid] of [['integer', 23], ['bigint', 20], ['real', 700], ['text', 1043], ['boolean', 16], ['json', 114]]) {
    assert.deepEqual(values(kind, oid, [null], true), [null]);
    assert.throws(() => values(kind, oid, [null]), data);
  }
});

test('closed OID sets and aliases are validated even when no rows exist', () => {
  for (const [kind, accepted] of [['integer', [21, 23, 20]], ['bigint', [21, 23, 20]], ['real', [700, 701]], ['text', [25, 1043]], ['boolean', [16]], ['json', [114, 3802]]]) {
    for (const oid of accepted) assert.deepEqual(values(kind, oid, []), []);
    for (const oid of [1700, 1042, 2950, 1007, 999999]) assert.throws(() => values(kind, oid, []), data);
    const wrong = raw(accepted[0], []); wrong.fields[0].name = 'value';
    assert.throws(() => decodePostgresStorage(wrong, output(kind), 'SELECT'), data);
  }
});

test('native widening does not change the accepted strict M13 decoder', () => {
  const result = raw(23, ['1']), fields = output('integer');
  assert.deepEqual(decodePostgresStorage(result, fields, 'SELECT'), [{value: 1n}]);
  assert.throws(() => decodePostgresRows(result, fields), data);
});

test('each expected CRUD command requires its own confirmed count, including empty results', () => {
  for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.deepEqual(decodePostgresStorage(raw(25, ['ok'], command), output('text'), command), [{value: 'ok'}]);
    assert.deepEqual(decodePostgresStorage(raw(25, [], command), output('text'), command), []);
    for (const change of [r => {r.command = 'SHOW';}, r => {r.rowCount = null;}, r => {r.rowCount = 0n;}, r => {r.rowCount = 2n;}]) {
      const result = raw(25, ['ok'], command); change(result); assert.throws(() => decodePostgresStorage(result, output('text'), command), data);
    }
  }
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), output('text'), 'SELECT 1'), data);
});

test('count has its own exact int8 alias, shape, cardinality and safe range contract', () => {
  for (const text of ['0', '7', String(Number.MAX_SAFE_INTEGER)]) assert.deepEqual(decodePostgresStorage(countRaw([text]), countOutput, 'SELECT', {count: true}), [{n: BigInt(text)}]);
  for (const cells of [[], ['0', '1'], ['-1'], ['9007199254740992'], [null]]) assert.throws(() => decodePostgresStorage(countRaw(cells), countOutput, 'SELECT', {count: true}), data);
  for (const oid of [21, 23, 1700]) { const result = countRaw(['1']); result.fields[0].typeOid = oid; assert.throws(() => decodePostgresStorage(result, countOutput, 'SELECT', {count: true}), data); }
  for (const change of [f => {f.alias = '__rs_pg_0';}, f => {f.property = 'count';}, f => {f.kind = 'integer';}, f => {f.nullable = true;}]) {
    const fields = structuredClone(countOutput); change(fields[0]); assert.throws(() => decodePostgresStorage(countRaw(['1']), fields, 'SELECT', {count: true}), data);
  }
  assert.throws(() => decodePostgresStorage({...countRaw(['1']), command: 'INSERT'}, countOutput, 'INSERT', {count: true}), data);
});

test('output metadata is bounded, positional, unique and restricted to mapped property names', () => {
  const result = {fields: [{name: '__rs_pg_0', typeOid: 25}, {name: '__rs_pg_1', typeOid: 25}], rows: [['left', 'right']], command: 'SELECT', rowCount: 1n};
  const fields = [{alias: '__rs_pg_0', property: 'left', kind: 'text', nullable: false}, {alias: '__rs_pg_1', property: 'right', kind: 'text', nullable: false}];
  assert.deepEqual(decodePostgresStorage(result, fields, 'SELECT'), [{left: 'left', right: 'right'}]);
  for (const property of ['__proto__', 'constructor', 'prototype', '__rs_private', 'sqlite_private', 'bad-name', '']) assert.throws(() => decodePostgresStorage(raw(25, ['ok']), output('text', false, property), 'SELECT'), data);
  for (const change of [f => {f[1].property = 'left';}, f => {f[1].alias = '__rs_pg_0';}, f => {f[0].alias = '__rs_pg_1';}, f => {f[0].kind = 'uuid';}, f => {f[0].nullable = 1;}, f => {f[0].extra = true;}]) {
    const copy = structuredClone(fields); change(copy); assert.throws(() => decodePostgresStorage(result, copy, 'SELECT'), data);
  }
  assert.throws(() => decodePostgresStorage(result, [], 'SELECT'), data);
  assert.throws(() => decodePostgresStorage(result, new Array(513), 'SELECT'), data);
});

test('malformed raw fields, rows and metadata are refused with a constant error', () => {
  for (const change of [r => {delete r.rowCount;}, r => {r.rowCount = 1;}, r => {r.rows[0] = [];}, r => {r.rows[0].push('extra');},
    r => {r.rows[0][0] = 1;}, r => {r.rows[0][0] = {};}, r => {r.fields[0].extra = true;}, r => {r.fields[0].typeOid = 0;},
    r => {r.fields[0].typeOid = 2 ** 32;}, r => {r.fields[0].typeOid = 1.5;}, r => {r.fields[0].name = '\ud800';},
    r => {r.rows = new Array(100_001);}, r => {r.fields = new Array(513);}, r => {r.rows = new Array(1);},
    r => {r.rows[0].extra = 'SYNTHETIC_PRIVATE';}, r => {r.rows[Symbol('hidden')] = 1;}, r => {Object.setPrototypeOf(r.rows, {});}]) {
    const result = raw(25, ['SYNTHETIC_PRIVATE']); change(result); assert.throws(() => decodePostgresStorage(result, output('text'), 'SELECT'), data);
  }
});

test('total cell budget is checked before copying a large repeated raw row', () => {
  const fields = Array.from({length: 100}, (_, i) => ({alias: '__rs_pg_' + i, property: 'p' + i, kind: 'text', nullable: false}));
  const result = {fields: fields.map(field => ({name: field.alias, typeOid: 25})), rows: new Array(10_001).fill(new Array(100).fill('fictional')), command: 'SELECT', rowCount: 10_001n};
  assert.throws(() => decodePostgresStorage(result, fields, 'SELECT'), data);
  assert.equal(result.rows.length, 10_001); assert.equal(result.rows[0].length, 100);
});

test('accessors in raw input, output metadata and options are rejected without invocation', () => {
  let reads = 0;
  const accessor = {get() {reads++; throw new Error('SYNTHETIC_PRIVATE');}, enumerable: true};
  for (const make of [r => Object.defineProperty(r, 'rows', accessor), r => Object.defineProperty(r.fields[0], 'typeOid', accessor), r => Object.defineProperty(r.rows[0], '0', accessor)]) {
    const result = raw(25, ['ok']); make(result); assert.throws(() => decodePostgresStorage(result, output('text'), 'SELECT'), data);
  }
  const fields = output('text'); Object.defineProperty(fields[0], 'kind', accessor);
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), fields, 'SELECT'), data);
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), output('text'), 'SELECT', Object.defineProperty({}, 'count', accessor)), data);
  assert.equal(reads, 0);
});

test('missing output metadata does not consult an inherited accessor on the descriptor map', () => {
  let reads = 0;
  Object.defineProperty(Object.prototype, 'alias', {get() {reads++; throw new Error('SYNTHETIC_PRIVATE');}, configurable: true});
  try {
    const fields = [{property: 'value', kind: 'text', nullable: false, extra: true}];
    assert.throws(() => decodePostgresStorage(raw(25, ['ok']), fields, 'SELECT'), data);
    assert.equal(reads, 0);
  } finally { delete Object.prototype.alias; }
});

test('Proxy input cannot run traps during raw or metadata validation', () => {
  let traps = 0; const proxy = target => new Proxy(target, {get() {traps++; throw new Error('SYNTHETIC_PRIVATE');}, getPrototypeOf() {traps++; throw new Error('SYNTHETIC_PRIVATE');}, ownKeys() {traps++; throw new Error('SYNTHETIC_PRIVATE');}});
  for (const make of [r => proxy(r), r => {r.fields = proxy(r.fields); return r;}, r => {r.fields[0] = proxy(r.fields[0]); return r;}, r => {r.rows = proxy(r.rows); return r;}, r => {r.rows[0] = proxy(r.rows[0]); return r;}]) assert.throws(() => decodePostgresStorage(make(raw(25, ['ok'])), output('text'), 'SELECT'), data);
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), proxy(output('text')), 'SELECT'), data);
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), [proxy(output('text')[0])], 'SELECT'), data);
  assert.throws(() => decodePostgresStorage(raw(25, ['ok']), output('text'), 'SELECT', proxy({})), data);
  const revoked = Proxy.revocable(raw(25, ['ok']), {}); revoked.revoke();
  assert.throws(() => decodePostgresStorage(revoked.proxy, output('text'), 'SELECT'), data);
  assert.equal(traps, 0);
});

test('decoder accepts immutable snapshots without treating the snapshot brand as execution proof', () => {
  const input = raw(25, ['first']), snapshot = snapshotPostgresResult(input);
  input.rows[0][0] = 'changed'; input.fields[0].name = 'changed';
  assert.deepEqual(decodePostgresStorage(snapshot, frozen(output('text')), 'SELECT'), [{value: 'first'}]);
  assert.deepEqual(decodePostgresStorage(frozen(raw(25, ['frozen raw'])), frozen(output('text')), 'SELECT'), [{value: 'frozen raw'}]);
});

test('decode does not mutate caller data or tie result records to mutable input', () => {
  const input = raw(25, ['first']), fields = output('text'), before = structuredClone({input, fields});
  const result = decodePostgresStorage(input, fields, 'SELECT');
  assert.deepEqual({input, fields}, before);
  input.rows[0][0] = 'changed'; fields[0].property = 'other';
  assert.deepEqual(result, [{value: 'first'}]); result[0].value = 'caller-owned';
  assert.equal(input.rows[0][0], 'changed');
});

test('count options reject unknown fields, bad values and custom records', () => {
  for (const options of [{count: 1}, {count: undefined}, {other: true}, {count: false, extra: true}, [], Object.create({count: false}), {[Symbol('hidden')]: true}, null]) assert.throws(() => decodePostgresStorage(raw(25, ['ok']), output('text'), 'SELECT', options), data);
  assert.deepEqual(decodePostgresStorage(raw(25, ['ok']), output('text'), 'SELECT', {count: false}), [{value: 'ok'}]);
});
