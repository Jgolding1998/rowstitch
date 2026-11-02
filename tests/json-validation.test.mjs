import test from 'node:test';
import assert from 'node:assert/strict';
import { column, defineTable, openDatabase } from '../dist/index.js';

const documents = defineTable('documents', {
  id: column.integer().primaryKey({ generated: true }),
  body: column.json(),
});

test('JSON arrays cannot silently replace their value through serialization hooks', () => {
  const db = openDatabase(':memory:', { tables: [documents] });
  try {
    db.ensureSchema();
    let calls = 0;
    const hooked = [1, 2];
    hooked.toJSON = () => { calls++; return { replacement: true }; };
    const accessor = [1];
    Object.defineProperty(accessor, 'toJSON', { get() { calls++; return () => []; } });
    class CustomArray extends Array { toJSON() { calls++; return ['replacement']; } }
    const annotated = [1]; annotated.extra = 'not represented in JSON';
    const symbol = [1]; symbol[Symbol('extra')] = 'not represented in JSON';
    for (const body of [hooked, accessor, new CustomArray(1, 2), annotated, symbol]) {
      assert.throws(() => db.table(documents).insert({ body }), error => error.code === 'VALIDATION');
    }
    assert.equal(calls, 0, 'Reject unsupported array shapes without invoking user hooks');
    assert.equal(db.table(documents).count(), 0);
  } finally { db.close(); }
});

test('plain, frozen and null-prototype JSON arrays retain their actual values', () => {
  const db = openDatabase(':memory:', { tables: [documents] });
  try {
    db.ensureSchema();
    const noPrototype = Object.setPrototypeOf([true, null, { nested: [3] }], null);
    const bodies = [[], [1, 'two', null], Object.freeze([1, { a: true }]), noPrototype];
    for (const body of bodies) {
      const saved = db.table(documents).insert({ body });
      assert.deepEqual(saved.body, JSON.parse(JSON.stringify(body)));
    }
  } finally { db.close(); }
});
