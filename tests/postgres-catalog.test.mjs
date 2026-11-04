// Private catalog readers against simulated responses. This says nothing about a live engine; shape and lifecycle only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSession } from '../dist/core/async-session.js';
import { acknowledgedRejection, isAcknowledgedRejection } from '../dist/core/executor.js';
import { RowstitchError } from '../dist/core/errors.js';
import { readPostgresPhysical, readPostgresSettings } from '../dist/core/postgres-catalog.js';
import { isPostgresRawResult, snapshotPostgresResult } from '../dist/core/postgres-result.js';
import { column, defineTable } from '../dist/core/schema.js';
import * as sdk from '../dist/index.js';

const code = wanted => error => error?.code === wanted && !error.message.includes('SYNTHETIC');
const table = defineTable('catalog_samples', { id: column.integer().primaryKey() });
const other = defineTable('other_samples', { id: column.integer().primaryKey() });
const physical = (overrides = {}) => ({
  format: 'rowstitch-postgres-physical-v1', serverVersion: 180006, schema: 'public', name: 'catalog_samples', oid: 16400,
  relation: { kind: 'r', persistence: 'p', isPartition: false, hasDescendants: false, hasAncestors: false, rowSecurity: false, forceRowSecurity: false, hasRules: false, userTriggers: 0 },
  columns: [{ name: 'id', position: 1, typeOid: 20, typeModifier: -1, arrayDimensions: 0, notNull: true, notNullValid: true, hasDefault: false, identity: '', generated: '', collationOid: 0 }],
  indexes: [{ oid: 16401, primary: true, unique: true, valid: true, ready: true, live: true, immediate: true, nullsNotDistinct: false, keyColumns: ['id'], includedColumns: [], collationOids: [0], hasExpressions: false, partial: false }],
  ...overrides,
});
const settings = (overrides = {}) => ({ serverVersion: 180006, clientEncoding: 'UTF8', serverEncoding: 'UTF8', extraFloatDigits: 1, replicationRole: 'origin', searchPath: '"$user", public', ...overrides });
const CATALOG = '__rs_pg_catalog', SETTINGS = '__rs_pg_settings', JSONB = 3802;
const raw = (alias, cells, overrides = {}) => snapshotPostgresResult({ fields: [{ name: alias, typeOid: JSONB }], rows: cells.map(cell => [cell === null ? null : JSON.stringify(cell)]), command: 'SELECT', rowCount: BigInt(cells.length), ...overrides });
function owner(answer) {
  const calls = [];
  return { calls, all(sql, parameters, options) { calls.push({ sql, parameters, options, argumentCount: arguments.length }); return Promise.resolve().then(() => answer(sql, parameters)); } };
}
const answering = value => owner(() => value);

test('every catalog relation, function, operator and cast is pg_catalog-qualified, and no name reaches the SQL', async () => {
  const a = answering(raw(CATALOG, [])), b = answering(raw(SETTINGS, [settings()]));
  await readPostgresPhysical(a, table, 'demo_space');
  await readPostgresPhysical(a, other);
  await readPostgresSettings(b);
  const catalog = a.calls[0].sql, values = b.calls[0].sql;
  assert.equal(a.calls[1].sql, catalog, 'one fixed statement for every table');
  assert.deepEqual(a.calls[0].parameters, ['demo_space', 'catalog_samples']);
  assert.deepEqual(a.calls[1].parameters, ['public', 'other_samples']);
  assert.deepEqual(b.calls[0].parameters, []);
  assert.ok(!catalog.includes('catalog_samples') && !catalog.includes('demo_space'));
  for (const sql of [catalog, values]) {
    assert.ok(!sql.includes(';'), 'one statement');
    // Inside quoted literals nothing is an identifier, and these keywords are SQL syntax rather than resolvable names.
    const code = sql.replace(/'[^']*'/g, "''");
    for (const match of code.matchAll(/\b(FROM|JOIN)\s+(?!\(|"pg_catalog")/g)) assert.fail('Unqualified relation after ' + match[1]);
    for (const match of code.matchAll(/([A-Za-z_"][A-Za-z0-9_"]*)\s*\(/g)) {
      if (!['SELECT', 'COALESCE', 'EXISTS', 'ANY', 'BY', 'k', 'o', 'AS', 'OPERATOR', 'AND', 'IN'].includes(match[1]) && !code.slice(Math.max(0, match.index - 15), match.index + match[0].length).includes('"pg_catalog".')) assert.fail('Unqualified function ' + match[1]);
    }
    for (const match of code.matchAll(/::(?!"pg_catalog")/g)) assert.fail('Unqualified cast at ' + match.index);
    for (const match of code.matchAll(/(?<![A-Za-z(".])\s(=|<>|<=|>=|<|>)\s/g)) assert.fail('Bare operator ' + match[1]);
  }
  assert.ok(catalog.includes(`"${CATALOG}"`) && values.includes(`"${SETTINGS}"`));
  assert.ok(!values.toUpperCase().includes('SET_CONFIG') && !/\bSET\b/.test(values), 'never changes a setting');
});

test('a matching relation becomes a detached frozen snapshot; no match is null', async () => {
  const input = physical(), result = await readPostgresPhysical(answering(raw(CATALOG, [input])), table);
  assert.deepEqual(result, input);
  for (const frozen of [result, result.relation, result.columns, result.columns[0], result.indexes, result.indexes[0], result.indexes[0].keyColumns, result.indexes[0].collationOids]) assert.ok(Object.isFrozen(frozen));
  assert.equal(await readPostgresPhysical(answering(raw(CATALOG, [])), table), null);
  assert.deepEqual(await readPostgresPhysical(answering(raw(CATALOG, [physical({ columns: [], indexes: [] })])), table), physical({ columns: [], indexes: [] }), 'a table with no columns is a fact, not an error');
});

test('native index entries survive: expressions stay null, and physical names need not be mapping identifiers', async () => {
  const entry = { ...physical().indexes[0], primary: false, oid: 16402, keyColumns: [null, 'Odd Name é𝄞', '__proto__'], includedColumns: ['extra', null], collationOids: [100, 950, 0], hasExpressions: true, partial: true, nullsNotDistinct: true };
  const columns = [{ ...physical().columns[0], name: 'Odd Name é𝄞', position: 3 }, { ...physical().columns[0], name: '__proto__', position: 5 }];
  const result = await readPostgresPhysical(answering(raw(CATALOG, [physical({ columns, indexes: [entry] })])), table);
  assert.deepEqual(result.indexes[0].keyColumns, [null, 'Odd Name é𝄞', '__proto__']);
  assert.deepEqual(result.indexes[0].includedColumns, ['extra', null]);
  assert.deepEqual(result.columns.map(item => item.position), [3, 5]);
  assert.equal({}.polluted, undefined);
});

test('more than one match is SCHEMA, and a malformed snapshot is SCHEMA', async () => {
  await assert.rejects(readPostgresPhysical(answering(raw(CATALOG, [physical(), physical()])), table), code('SCHEMA'));
  const { oid, ...withoutOid } = physical();
  for (const cell of [{}, [], 'text', 1, withoutOid, physical({ extra: 1 }), physical({ format: 'other' }), physical({ columns: 'none' }), physical({ indexes: [{}] }), physical({ relation: {} })])
    await assert.rejects(readPostgresPhysical(answering(raw(CATALOG, [cell])), table), code('SCHEMA'), JSON.stringify(cell).slice(0, 40));
});

test('a malformed settings snapshot is DATA, and exactly one row is required', async () => {
  assert.deepEqual(await readPostgresSettings(answering(raw(SETTINGS, [settings()]))), settings());
  assert.ok(Object.isFrozen(await readPostgresSettings(answering(raw(SETTINGS, [settings()])))));
  const { searchPath, ...missing } = settings();
  for (const cell of [{}, [], missing, settings({ extra: 1 }), settings({ extraFloatDigits: '1' }), settings({ serverVersion: null }), settings({ searchPath: 1 })])
    await assert.rejects(readPostgresSettings(answering(raw(SETTINGS, [cell]))), code('DATA'), JSON.stringify(cell).slice(0, 40));
  for (const cells of [[], [settings(), settings()]]) await assert.rejects(readPostgresSettings(answering(raw(SETTINGS, cells))), code('DATA'));
});

test('the exact alias, OID, command and count are checked, also when nothing matched', async () => {
  const cases = [
    raw('other', []), raw('other', [physical()]),
    raw(CATALOG, [], { fields: [{ name: CATALOG, typeOid: 114 }] }), raw(CATALOG, [physical()], { fields: [{ name: CATALOG, typeOid: 25 }] }),
    raw(CATALOG, [], { fields: [] }), raw(CATALOG, [], { fields: [{ name: CATALOG, typeOid: JSONB }, { name: 'second', typeOid: 25 }] }),
    raw(CATALOG, [], { command: 'INSERT' }), raw(CATALOG, [], { rowCount: null }), raw(CATALOG, [], { rowCount: 1n }), raw(CATALOG, [physical()], { rowCount: 0n }),
    { fields: [{ name: CATALOG, typeOid: JSONB }], rows: [[null]], command: 'SELECT', rowCount: 1n }, { fields: [{ name: CATALOG, typeOid: JSONB }], rows: [['{broken']], command: 'SELECT', rowCount: 1n },
    [], {}, null, undefined, { rows: [] }, new Proxy({}, { ownKeys() { throw new Error('SYNTHETIC_TRAP'); } }),
  ];
  for (const value of cases) await assert.rejects(readPostgresPhysical(answering(value), table), code('DATA'));
  for (const value of [raw('other', []), raw(SETTINGS, [], { fields: [{ name: SETTINGS, typeOid: 25 }] }), raw(SETTINGS, [settings()], { command: 'SHOW' }), raw(CATALOG, [settings()])])
    await assert.rejects(readPostgresSettings(answering(value)), code('DATA'));
});

test('invalid targets are refused before any I/O, as rejections', async () => {
  const forged = Object.create(Object.getPrototypeOf(table));
  let reads = 0;
  Object.defineProperty(forged, 'name', { get() { reads++; return 'SYNTHETIC_NAME'; } });
  const a = answering(raw(CATALOG, []));
  for (const value of [forged, new Proxy(table, {}), { name: 'catalog_samples', columns: {} }, 'catalog_samples', null, undefined]) {
    const pending = readPostgresPhysical(a, value);
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, code('SCHEMA'));
  }
  for (const schema of ['bad.schema', 'quote"d', '', 'x'.repeat(64), '__rs_space', 'sqlite_space', '__proto__', 1, null, {}, 'pg_catalog', 'PG_TEMP', 'pg_toast', 'information_schema', 'INFORMATION_SCHEMA'])
    await assert.rejects(readPostgresPhysical(a, table, schema), code('SCHEMA'), String(schema));
  assert.equal(reads, 0);
  assert.deepEqual(a.calls, []);
  for (const bad of [null, undefined, {}, 'session', { all: 'nope' }]) {
    await assert.rejects(readPostgresPhysical(bad, table), code('VALIDATION'));
    await assert.rejects(readPostgresSettings(bad), code('VALIDATION'));
  }
});

test('the statement is issued in the calling turn, with options passed through by identity', async () => {
  const a = answering(raw(CATALOG, [])), options = { signal: new AbortController().signal };
  const first = readPostgresPhysical(a, table, 'demo_space', options);
  assert.equal(a.calls.length, 1, 'no await before the request, so a later change cannot alter its target');
  assert.equal(a.calls[0].options, options);
  await first;
  await readPostgresPhysical(a, table);
  assert.equal(a.calls[1].options, undefined);
  assert.deepEqual(a.calls[1].parameters, ['public', 'catalog_samples']);
  const b = answering(raw(SETTINGS, [settings()]));
  const second = readPostgresSettings(b, options);
  assert.equal(b.calls[0].options, options);
  await second;
  assert.throws(() => { 'use strict'; a.calls[0].parameters.push('more'); }, TypeError);
});

test('owner rejections pass through by identity: acknowledged stays acknowledged, unknown stays unknown', async () => {
  const definite = acknowledgedRejection(new RowstitchError('CONSTRAINT', 'SYNTHETIC')), unknown = new RowstitchError('EXECUTION_UNCONFIRMED', 'fictional');
  for (const failure of [definite, unknown]) {
    const a = owner(() => { throw failure; });
    await assert.rejects(readPostgresPhysical(a, table), error => error === failure);
    await assert.rejects(readPostgresSettings(a), error => error === failure);
  }
  assert.ok(isAcknowledgedRejection(definite));
  const decodeFailure = await readPostgresPhysical(answering(raw(CATALOG, [{}])), table).catch(error => error);
  assert.ok(!isAcknowledgedRejection(decodeFailure), 'a shape failure is the reader\'s, not an engine acknowledgment');
});

function sessionFixture(options = {}) {
  const calls = [], gates = new Map();
  let active = false, closes = 0;
  const d = {
    calls, get closes() { return closes; }, answer: sql => sql.includes(SETTINGS) ? raw(SETTINGS, [settings()]) : raw(CATALOG, [physical()]),
    hold(match) { let release, reached; const gate = new Promise(ok => { release = ok; }), started = new Promise(ok => { reached = ok; }); gates.set(match, { gate, reached }); return { release, started }; },
  };
  const session = createAsyncSession({
    async all(sql) { calls.push(sql.includes(SETTINGS) ? 'SETTINGS' : 'CATALOG'); const held = gates.get(calls.at(-1)); if (held) { held.reached(); await held.gate; } return d.answer(sql); },
    async exec(sql) { calls.push(sql); if (sql.startsWith('BEGIN')) active = true; if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false; },
    async inTransaction() { return active; }, async close() { closes++; },
  }, { dialect: 'postgresql', isResult: isPostgresRawResult, ...options });
  d.session = session;
  return d;
}

test('through a real generic session: root, transaction, child and the read-only implicit transaction', async () => {
  const d = sessionFixture();
  assert.equal((await readPostgresPhysical(d.session, table)).oid, 16400);
  assert.deepEqual(d.calls, ['CATALOG'], 'a read needs no transaction');
  const nested = await d.session.transaction(async tx => [await readPostgresPhysical(tx, table), await readPostgresSettings(tx), await tx.transaction(child => readPostgresSettings(child))]);
  assert.equal(nested[0].oid, 16400); assert.equal(nested[1].clientEncoding, 'UTF8'); assert.equal(nested[2].clientEncoding, 'UTF8');
  assert.equal(d.calls.at(-1), 'COMMIT');
  await d.session.close();
  const r = sessionFixture({ readOnly: true });
  assert.equal((await readPostgresSettings(r.session)).replicationRole, 'origin');
  assert.deepEqual(r.calls, ['BEGIN READ ONLY', 'SETTINGS', 'COMMIT']);
  await r.session.close();
});

test('through a real session: cancellation, a forgotten read and an unknown outcome keep their meaning', async () => {
  const d = sessionFixture(), aborted = new AbortController(); aborted.abort();
  await assert.rejects(readPostgresPhysical(d.session, table, 'public', { signal: aborted.signal }), code('ABORTED'));
  await assert.rejects(readPostgresSettings(d.session, { signal: aborted.signal }), code('ABORTED'));
  assert.deepEqual(d.calls, [], 'a pre-aborted read sends nothing');

  const held = d.hold('CATALOG');
  let forgotten;
  const running = d.session.transaction(tx => { forgotten = readPostgresPhysical(tx, table); });
  const outcome = running.then(() => null, error => error.code);
  await held.started;
  held.release();
  assert.equal(await outcome, 'TRANSACTION_PENDING', 'an issued read is unfinished work, and nothing commits');
  await forgotten;
  assert.ok(!d.calls.includes('COMMIT') && d.calls.includes('ROLLBACK'));
  await d.session.close();

  const u = sessionFixture();
  u.answer = () => { throw new Error('SYNTHETIC_PRIVATE_VALUE'); };
  await assert.rejects(readPostgresSettings(u.session), code('EXECUTION_UNCONFIRMED'));
  u.answer = sql => raw(CATALOG, [physical()]);
  await assert.rejects(readPostgresPhysical(u.session, table), code('CONNECTION_UNUSABLE'));
  assert.deepEqual(u.calls, ['SETTINGS'], 'nothing replayed and nothing more sent');
  await u.session.close();
  assert.equal(u.closes, 1);

  const s = sessionFixture();
  s.answer = () => raw(CATALOG, [{}]);
  await assert.rejects(readPostgresPhysical(s.session, table), code('SCHEMA'));
  s.answer = () => raw(SETTINGS, [settings()]);
  assert.equal((await readPostgresSettings(s.session)).serverEncoding, 'UTF8', 'a reader shape failure does not poison the connection');
  await s.session.close();
});

test('the readers are not SDK exports', () => {
  for (const name of ['readPostgresPhysical', 'readPostgresSettings', 'snapshotPostgresPhysical', 'snapshotPostgresSettings']) assert.ok(!(name in sdk), name);
});
