import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from 'node:util';
import { capturePhysicalName, quotePhysicalName, quotePhysicalTable, physicalTableIdentity, physicalTableKey } from '../dist/core/physical-identity.js';
import { identifier } from '../dist/core/schema.js';

const rejected = error => error?.code === 'SCHEMA' && error.cause === undefined;

test('physical names preserve exact Unicode, quotes, dots and internal-looking names as data', () => {
  for (const name of ['Order Items', 'select', '__proto__', '__rs_keys', 's.t', '"s"."t"', 'é', 'e\u0301', 'a"b', ' ']) {
    assert.equal(capturePhysicalName(name), name);
    assert.equal(quotePhysicalName(name, 'sqlite'), '"' + name.replaceAll('"', '""') + '"');
  }
  assert.notEqual(capturePhysicalName('é'), capturePhysicalName('e\u0301'));
  assert.throws(() => identifier('__rs_keys'), rejected);
  assert.throws(() => identifier('Order Items'), rejected);
});

test('generic and PostgreSQL byte boundaries count UTF8 and never silently truncate', () => {
  assert.equal(capturePhysicalName('a'.repeat(4096)).length, 4096);
  assert.equal(capturePhysicalName('🧵'.repeat(1024)).length, 2048);
  for (const name of ['a'.repeat(4097), '🧵'.repeat(1024) + 'x', 'é'.repeat(2049)]) assert.throws(() => capturePhysicalName(name), rejected);
  for (const name of ['x'.repeat(63), 'é'.repeat(31) + 'x', '🧵'.repeat(15) + 'xyz']) assert.equal(quotePhysicalName(name, 'postgresql'), '"' + name + '"');
  for (const name of ['x'.repeat(64), 'é'.repeat(32), '🧵'.repeat(16)]) {
    assert.throws(() => quotePhysicalName(name, 'postgresql'), rejected);
    assert.doesNotThrow(() => quotePhysicalName(name, 'sqlite'));
  }
});

test('invalid input refuses without coercion, getters or caller-controlled error contents', () => {
  let traps = 0;
  const object = new Proxy({ toString() { traps++; return 'name'; } }, { get() { traps++; throw new Error('FICTIONAL_PRIVATE_NAME'); } });
  for (const value of ['', '\0', 'x\0y', '\ud800', '\udfff', 'x\ud800y', new String('name'), object, 42, null, undefined]) {
    assert.throws(() => capturePhysicalName(value), error => rejected(error) && !inspect(error, { depth: 6, showHidden: true }).includes('FICTIONAL_PRIVATE_NAME'));
  }
  assert.equal(traps, 0);
  assert.throws(() => quotePhysicalName('name', 'mysql'), rejected);
});

test('structured identity cannot collide with formatted schema-table strings or swapped components', () => {
  assert.notEqual(physicalTableKey('s', 't', 'postgresql'), physicalTableKey('public', '"s"."t"', 'postgresql'));
  assert.notEqual(physicalTableKey('a.b', 'c', 'sqlite'), physicalTableKey('a', 'b.c', 'sqlite'));
  assert.notEqual(physicalTableKey('s', 't', 'sqlite'), physicalTableKey('t', 's', 'sqlite'));
  assert.equal(quotePhysicalTable('s', 'a"b.c', 'postgresql'), '"s"."a""b.c"');
  assert.deepEqual(physicalTableIdentity('main', '__proto__', 'sqlite'), { schema: 'main', table: '__proto__' });
  assert.ok(Object.isFrozen(physicalTableIdentity('main', 'items', 'sqlite')));
});

test('registry identities follow backend ASCII case rules without merging distinct Unicode', () => {
  assert.equal(physicalTableKey('MAIN', 'Items', 'sqlite'), physicalTableKey('main', 'items', 'sqlite'));
  assert.notEqual(physicalTableKey('public', 'Items', 'postgresql'), physicalTableKey('public', 'items', 'postgresql'));
  for (const dialect of ['sqlite', 'postgresql']) {
    assert.notEqual(physicalTableKey('main', 'É', dialect), physicalTableKey('main', 'é', dialect));
    assert.notEqual(physicalTableKey('main', 'é', dialect), physicalTableKey('main', 'e\u0301', dialect));
  }
});

test('quoted physical names reach actual SQLite as identifiers and cannot inject another statement', () => {
  const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: false });
  try {
    const table = 'items"; DROP TABLE sentinel; --', column = '__rs_keys".payload';
    db.exec('CREATE TABLE sentinel(id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE ' + quotePhysicalTable('main', table, 'sqlite') + '(' + quotePhysicalName(column, 'sqlite') + ' TEXT)');
    const result = db.prepare('INSERT INTO ' + quotePhysicalTable('main', table, 'sqlite') + ' VALUES (?) RETURNING '
      + quotePhysicalName(table, 'sqlite') + '.' + quotePhysicalName(column, 'sqlite') + ' AS "value"').get('fictional data');
    assert.equal(result.value, 'fictional data');
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.sentinel').get().n, 0);
    assert.throws(() => db.prepare('SELECT ' + quotePhysicalName(table, 'sqlite') + '."missing" FROM ' + quotePhysicalTable('main', table, 'sqlite')));
  } finally { db.close(); }
});
