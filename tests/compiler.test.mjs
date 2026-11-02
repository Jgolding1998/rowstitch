import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase, eq, asc } from '../dist/index.js';
import { Predicate } from '../dist/core/predicates.js';
import { queryModel, tableModel, predicateTruth } from '../dist/core/query-model.js';
import { compileSqlite, compileSqlitePredicate } from '../dist/core/sqlite-compiler.js';

const code = expected => error => error?.code === expected;
const mapped = tableModel({ name: 'items', columns: ['id', 'value'], primaryKey: ['id'] });

test('normalized plans retain data snapshots while reusable compiler outputs stay independent', () => {
  const source = { table: mapped, columns: ['value'], where: { kind: 'compare', column: 'id', operator: '=', values: [7] }, orderBy: [], limit: 9, offset: 0 };
  const plan = queryModel.select(source);
  source.columns[0] = 'id'; source.where.values[0] = 8;
  const first = compileSqlite(plan), second = compileSqlite(plan);
  assert.deepEqual(first, { sql: 'SELECT "value" FROM "items" WHERE "id" = ? LIMIT ? OFFSET ?', parameters: [7, 9, 0] });
  first.parameters[0] = 99;
  assert.deepEqual(second.parameters, [7, 9, 0]);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.table) && Object.isFrozen(plan.columns) && Object.isFrozen(plan.where.values));
  assert.ok(!Object.isFrozen(source.columns));
});

test('deterministic ordering preserves all public order items plus remaining composite key columns', () => {
  const columns = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, column.integer().primaryKey()]));
  const table = defineTable('composite_order', columns);
  const db = openDatabase(':memory:', { tables: [table] });
  try {
    const query = db.table(table).compileSelect({ select: ['k0'], orderBy: Array.from({ length: 100 }, () => asc(table.col('k0'))) });
    const orders = query.sql.split(' ORDER BY ')[1].split(' LIMIT ')[0].split(', ');
    assert.equal(orders.length, 199);
    assert.equal(orders.at(-1), '"k99" ASC');
    assert.deepEqual(query.parameters, [1000, 0]);
  } finally { db.close(); }
});

test('one captured predicate is used for both guarded count and mutation even if caller state changes', () => {
  const table = defineTable('guard_snapshot', { id: column.integer().primaryKey(), value: column.text() });
  const db = openDatabase(':memory:', { tables: [table], traceValues: true });
  try {
    db.ensureSchema(); const repo = db.table(table);
    repo.insertMany([{ id: 1, value: 'first' }, { id: 2, value: 'second' }]);
    const values = [1];
    const where = new Predicate({ kind: 'comparison', ref: table.col('id'), operator: '=', values });
    const options = new Proxy({ where, maxRows: 1 }, { get(target, name, receiver) {
      if (name === 'maxRows') values[0] = 2;
      return Reflect.get(target, name, receiver);
    } });
    db.clearTrace();
    assert.equal(repo.update({ value: 'changed' }, options)[0].id, 1);
    const queries = db.exportTrace().queries;
    assert.deepEqual(queries.find(q => q.sql.startsWith('SELECT count')).parameters, [1]);
    assert.deepEqual(queries.find(q => q.operation === 'update').parameters, ['changed', 1]);
    assert.equal(repo.findFirst({ where: eq(table.col('id'), 2) }).value, 'second');
  } finally { db.close(); }
});

test('schema and nested transaction statements keep trace classifications and actual rollback scopes', () => {
  const table = defineTable('control_kinds', { id: column.integer().primaryKey(), value: column.text().default("quote'\nline") });
  const db = openDatabase(':memory:', { tables: [table] });
  try {
    db.ensureSchema();
    assert.deepEqual(db.exportTrace().queries.map(q => [q.operation, q.sql.split(' ')[0]]), [['transaction', 'BEGIN'], ['schema', 'CREATE'], ['transaction', 'COMMIT']]);
    db.clearTrace();
    db.transaction(tx => {
      tx.table(table).insert({ id: 1 });
      assert.throws(() => tx.transaction(nested => { nested.table(table).insert({ id: 2 }); throw new Error('synthetic rollback'); }));
    });
    const events = db.exportTrace().queries;
    assert.ok(events.filter(q => /^(?:SAVEPOINT|RELEASE|ROLLBACK)/.test(q.sql)).every(q => q.operation === 'transaction'));
    assert.equal(db.table(table).count(), 1);
    assert.equal(db.table(table).findFirst().value, "quote'\nline");
    assert.deepEqual(db.planSchema(), []);
  } finally { db.close(); }
});

test('NUL DDL defaults reject before schema SQL or CREATE while bound NUL DML remains exact', () => {
  const invalid = defineTable('nul_default', { id: column.integer().primaryKey(), value: column.text().default('a\0b') });
  const db = openDatabase(':memory:', { tables: [invalid] });
  try {
    assert.throws(() => db.planSchema(), code('SCHEMA'));
    assert.throws(() => db.ensureSchema(), code('SCHEMA'));
    assert.deepEqual(db.inspectSchema(), []);
    assert.ok(!db.exportTrace().queries.some(q => q.sql.startsWith('CREATE')));
  } finally { db.close(); }
  const table = defineTable('nul_data', { id: column.integer().primaryKey(), value: column.text() });
  const good = openDatabase(':memory:', { tables: [table] });
  try { good.ensureSchema(); good.table(table).insert({ id: 1, value: 'a\0b' }); assert.equal(good.table(table).findFirst().value, 'a\0b'); }
  finally { good.close(); }
});

// Deterministic generated predicates exercise the pure compiler against SQLite and
// an independent three-valued evaluator, including empty groups and mixed NULL IN.
test('generated nested predicate semantics agree with a separate evaluator on actual SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value INTEGER)');
    const rows = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, value: i % 5 === 0 ? null : i % 7 }));
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)'); for (const row of rows) insert.run(row.id, row.value);
    let seed = 129;
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    function expression(depth) {
      if (depth && random(3) !== 0) {
        if (random(3) === 0) return { kind: 'not', child: expression(depth - 1) };
        return { kind: 'logic', operator: random(2) ? 'AND' : 'OR', children: Array.from({ length: random(4) }, () => expression(depth - 1)) };
      }
      const operator = ['=', '<>', '>', '<=', 'IN'][random(5)];
      return { kind: 'compare', column: 'value', operator, values: operator === 'IN' ? Array.from({ length: random(5) }, () => random(4) ? random(7) : null) : [(operator === '=' || operator === '<>') && random(3) === 0 ? null : random(7)] };
    }
    function evaluate(node, row) {
      if (node.kind === 'not') { const child = evaluate(node.child, row); return child === null ? null : !child; }
      if (node.kind === 'logic') {
        const children = node.children.map(c => evaluate(c, row));
        return node.operator === 'AND' ? children.includes(false) ? false : children.includes(null) ? null : true : children.includes(true) ? true : children.includes(null) ? null : false;
      }
      const value = row[node.column], expected = node.values[0];
      if (node.operator === 'IN') return !node.values.length ? false : value === null ? node.values.includes(null) ? true : null : node.values.includes(value);
      if (expected === null) return node.operator === '=' ? value === null : value !== null;
      if (value === null) return null;
      return node.operator === '=' ? value === expected : node.operator === '<>' ? value !== expected : node.operator === '>' ? value > expected : value <= expected;
    }
    for (let index = 0; index < 150; index++) {
      const where = expression(3), query = compileSqlite(queryModel.select({ table: mapped, columns: ['id'], where, orderBy: [{ column: 'id', direction: 'ASC' }], limit: 100, offset: 0 }));
      const actual = db.prepare(query.sql).all(...query.parameters).map(row => row.id);
      assert.deepEqual(actual, rows.filter(row => evaluate(where, row) === true).map(row => row.id), 'generated case ' + index);
      assert.equal(compileSqlitePredicate(mapped, where).truth, predicateTruth(where));
    }
  } finally { db.close(); }
});
