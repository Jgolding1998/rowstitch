import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTraceState, recordTrace, traceDocument } from '../dist/core/trace-log.js';
import { column, defineTable, openAsyncDatabase } from '../dist/index.js';
import { openAsyncDatabaseWithExecutor } from '../dist/core/async-database.js';
import { inlineAsyncExecutor } from '../dist/core/executor.js';
import { openSqliteExecutor } from '../dist/core/sqlite-executor.js';

// Trace writer and declarations. Studio validation and rendering are covered by tests/studio.spec.mjs.
const state = (extra = {}) => ({ traceValues: false, capacity: 10, traces: [], sequence: 0, traceBytes: 0, omittedEntries: 0, ...extra });
const observed = (table, columns = [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }]) => ({
  name: table, identity: { schema: 'main', table }, coverage: { scope: 'all', columns: 'all', totalColumnCount: columns.length },
  columns, foreignKeys: [], indexes: [],
});
const snapshot = { schema: [observed('fictional_rows')], scope: 'all', registrations: new Map(), defaultSchema: 'main' };
const stable = document => ({ ...document, generatedAt: 'fixed', queries: document.queries.map(query => ({ ...query, durationMs: 0 })) });
const record = target => recordTrace(target, { operation: 'transaction', table: '', sql: 'BEGIN ISOLATION LEVEL SERIALIZABLE', parameters: [], start: 0, rowCount: 0, transactionId: 'tx1', status: 'ok' });
const bytes = document => Buffer.byteLength(JSON.stringify(document), 'utf8');

test('a state without a dialect exports v2 with the SQLite default and explicit inspection scope', () => {
  const document = traceDocument(state(), 'Fictional', snapshot, []);
  assert.equal(document.version, 2);
  assert.equal(document.dialect, 'sqlite');
  assert.deepEqual(Object.keys(document), ['format', 'version', 'title', 'generatedAt', 'source', 'dialect', 'mapping', 'inspection', 'schema', 'queries', 'notes']);
  assert.deepEqual(document.mapping, { tables: [], omittedTables: 0 });
  assert.deepEqual(document.inspection, { scope: 'all', registeredTables: 0, omittedTables: 0 });
});
test('an explicitly undefined dialect is the same as an absent one', () => {
  const absent = traceDocument(state(), 'Fictional', snapshot, []), undefinedValue = traceDocument(state({ dialect: undefined }), 'Fictional', snapshot, []);
  assert.equal(JSON.stringify(stable(undefinedValue)), JSON.stringify(stable(absent)));
});
for (const dialect of ['postgresql', 'sqlite']) {
  test(`a ${dialect} state identifies its dialect without changing the same schema or events`, () => {
    const plain = state(), named = state({ dialect });
    record(plain); record(named);
    const document = traceDocument(named, 'Fictional', snapshot, ['A note.']), baseline = traceDocument(plain, 'Fictional', snapshot, ['A note.']);
    assert.equal(document.dialect, dialect);
    assert.deepEqual(stable(document), { ...stable(baseline), dialect });
  });
}
test('recording and clearing keep the dialect, and entries never carry it', () => {
  const target = state({ dialect: 'postgresql' });
  record(target);
  assert.ok(!Object.hasOwn(target.traces[0], 'dialect'));
  clearTraceState(target);
  assert.equal(target.dialect, 'postgresql');
  assert.equal(traceDocument(target, 'Fictional', snapshot, []).dialect, 'postgresql');
});
test('an exact two-MiB document preserves raw identities and a one-byte overflow omits the entire schema entry', () => {
  const physical = 'a".\n' + '界'.repeat(1364);
  assert.equal(Buffer.byteLength(physical, 'utf8'), 4096);
  const earlier = Array.from({ length: 9 }, (_, index) => observed('rows_' + index, []));
  const capture = { ...snapshot, schema: [...earlier, observed(physical, [
    { name: physical, type: 'TEXT', nullable: true, primaryKey: false },
  ])] };
  const exportWithNote = note => traceDocument(state(), 'Fictional', capture, [note]);
  const padding = 'x'.repeat(2_097_152 - bytes(exportWithNote('')));
  const exact = exportWithNote(padding);
  assert.equal(bytes(exact), 2_097_152);
  assert.equal(exact.inspection.omittedTables, 0);
  assert.equal(exact.schema.length, 10);
  assert.deepEqual(exact.schema.at(-1).identity, { schema: 'main', table: physical });
  assert.equal(exact.schema.at(-1).name, physical);
  assert.equal(exact.schema.at(-1).columns[0].name, physical);
  const overflow = exportWithNote(padding + 'x');
  assert.deepEqual(overflow.schema.map(table => table.name), earlier.map(table => table.name));
  assert.equal(overflow.inspection.omittedTables, 1);
  assert.equal(overflow.notes.at(-1), padding + 'x');
  assert.ok(bytes(overflow) < 2_097_152);
  assert.throws(() => exportWithNote('x'.repeat(2_097_152)), error => error?.code === 'TRACE_LIMIT');
});
test('SQLite exports keep observed raw names and distinguish identical basenames, missing registrations, and unresolved foreign keys', async () => {
  const name = 'Same."Rows\n日';
  const lowerInitial = 's' + name.slice(1);
  const missingName = 'Absent."Parent';
  const quote = text => '"' + text.replaceAll('"', '""') + '"';
  const main = defineTable('fictional_main', {
    id: column.integer().primaryKey().storedAs('from'), label: column.text().storedAs('__proto__'),
  }, { storage: { table: lowerInitial }, schemaPolicy: 'subset' });
  const temp = defineTable('fictional_temp', {
    id: column.integer().primaryKey(), parentId: column.integer().nullable().storedAs('Parent.Ref'),
  }, { storage: { schema: 'temp', table: name } });
  const missing = defineTable('fictional_missing', { id: column.integer().primaryKey() },
    { storage: { schema: 'temp', table: missingName } });
  const native = openSqliteExecutor();
  let db;
  try {
    native.exec(`CREATE TABLE main.${quote(name)} ("From" INTEGER PRIMARY KEY, "__proto__" TEXT NOT NULL,
      "hidden note" TEXT DEFAULT 'FICTIONAL_UNMAPPED_DEFAULT');
      CREATE TABLE temp.${quote(name)} (id INTEGER PRIMARY KEY, "Parent.Ref" INTEGER REFERENCES ${quote(missingName)});
      CREATE TABLE main."Unregistered" (id INTEGER PRIMARY KEY);`);
    db = await openAsyncDatabaseWithExecutor(inlineAsyncExecutor(native), { tables: [main, temp, missing] });
    const value = 'FICTIONAL_BOUND_VALUE';
    assert.deepEqual(await db.table(main).insert({ id: 1, label: value }), { id: 1, label: value });
    const trace = db.exportTrace();
    assert.equal(trace.version, 2);
    assert.equal(trace.dialect, 'sqlite');
    assert.deepEqual(trace.inspection, { scope: 'mapped', registeredTables: 3, omittedTables: 0 });
    assert.equal(trace.mapping.omittedTables, 0);
    const mapped = new Map(trace.mapping.tables.map(entry => [entry.logical, entry]));
    assert.deepEqual(mapped.get(main.name), {
      logical: main.name, physical: { schema: 'main', table: lowerInitial }, schemaSource: 'default', policy: 'subset',
      columns: [{ logical: 'id', physical: 'from' }, { logical: 'label', physical: '__proto__' }],
    });
    assert.deepEqual(mapped.get(temp.name).physical, { schema: 'temp', table: name });
    assert.equal(mapped.get(temp.name).schemaSource, 'explicit');
    assert.deepEqual(mapped.get(missing.name).physical, { schema: 'temp', table: missingName });
    assert.equal(trace.schema.length, 2);
    const catalog = new Map(trace.schema.map(entry => [entry.identity.schema, entry]));
    assert.deepEqual(catalog.get('main').identity, { schema: 'main', table: name });
    assert.deepEqual(catalog.get('temp').identity, { schema: 'temp', table: name });
    assert.deepEqual(catalog.get('main').coverage, { columns: 'mapped-and-key', totalColumnCount: 3 });
    assert.deepEqual(catalog.get('main').columns.map(column => column.name), ['From', '__proto__']);
    assert.deepEqual(catalog.get('temp').foreignKeys, [{ constraint: '0', width: 1,
      columns: [{ column: 'Parent.Ref', target: null }], targetIdentity: { schema: 'temp', table: missingName },
    }]);
    const insert = trace.queries.find(query => query.operation === 'insert');
    assert.equal(insert.table, main.name);
    assert.deepEqual(insert.parameters, ['[redacted]', '[redacted]']);
    assert.ok(!JSON.stringify(trace).includes(value));
    assert.ok(!JSON.stringify(trace).includes('FICTIONAL_UNMAPPED_DEFAULT'));
    await db.inspectSchema({ scope: 'all' });
    const inspected = db.exportTrace();
    assert.deepEqual(inspected.inspection, { scope: 'all', registeredTables: 3, omittedTables: 0 });
    assert.ok(inspected.schema.some(entry => entry.name === 'Unregistered'));
    assert.ok(!JSON.stringify(inspected).includes('FICTIONAL_UNMAPPED_DEFAULT'));
  } finally { if (db) await db.close(); else native.close(); }
});
test('SQLite trace schema and scope follow transaction commits and savepoint outcomes', async t => {
  const table = defineTable('fictional_snapshot', { id: column.integer().primaryKey() });
  const db = await openAsyncDatabase(':memory:', { tables: [table] });
  t.after(() => db.close());
  const check = (handle, scope, names) => {
    const document = handle.exportTrace();
    assert.equal(document.inspection.scope, scope);
    assert.deepEqual(document.schema.map(entry => entry.identity), names.map(table => ({ schema: 'main', table })));
  };
  const rollback = new Error('Fictional rollback');
  const sameRollback = error => error === rollback;
  check(db, 'mapped', []);

  await assert.rejects(db.transaction(async tx => {
    await tx.ensureSchema();
    check(tx, 'mapped', [table.name]);
    await tx.inspectSchema({ scope: 'all' });
    check(tx, 'all', [table.name]);
    throw rollback;
  }), sameRollback);
  check(db, 'mapped', []);
  assert.deepEqual(await db.inspectSchema({ scope: 'mapped' }), []);

  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  const pending = db.transaction(async outer => {
    await outer.transaction(async inner => {
      await inner.ensureSchema();
      await inner.inspectSchema({ scope: 'all' });
      check(inner, 'all', [table.name]);
    });
    check(outer, 'all', [table.name]);
    reached.resolve();
    await release.promise;
    throw rollback;
  });
  const rejected = assert.rejects(pending, sameRollback);
  try {
    await Promise.race([reached.promise, pending]);
    check(db, 'mapped', []);
  } finally {
    release.resolve();
    await rejected;
  }
  check(db, 'mapped', []);

  await db.transaction(async outer => {
    await outer.ensureSchema();
    await assert.rejects(outer.transaction(async inner => {
      check(inner, 'mapped', [table.name]);
      await inner.inspectSchema({ scope: 'all' });
      check(inner, 'all', [table.name]);
      throw rollback;
    }), sameRollback);
    check(outer, 'mapped', [table.name]);
  });
  check(db, 'mapped', [table.name]);
  assert.equal(await db.table(table).count(), 0);
});
test('declarations require a known v2 dialect and preserve the optional v1 field', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-trace-dialect-'));
  try {
    const target = fileURLToPath(new URL('../dist/core/trace-log.js', import.meta.url)), path = relative(directory, target);
    const specifier = (isAbsolute(path) || path.startsWith('.') ? path : './' + path).replaceAll('\\', '/');
    const source = [
      `import type { TraceDialect, TraceDocument, TraceDocumentV1, TraceDocumentV2, TraceState } from ${JSON.stringify(specifier)};`,
      "const one: TraceDialect = 'postgresql', two: TraceDialect = 'sqlite';",
      "const base = { traceValues: false, capacity: 1, traces: [], sequence: 0, traceBytes: 0, omittedEntries: 0 };",
      'const legacy: TraceState = base;',
      "const named: TraceState = { ...base, dialect: 'postgresql' };",
      "declare const document: TraceDocument;",
      'const read: TraceDialect | undefined = document.dialect;',
      'declare const v1: TraceDocumentV1, v2: TraceDocumentV2;',
      'const legacyRead: TraceDialect | undefined = v1.dialect;',
      'const certainV2: TraceDialect = v2.dialect;',
      'const { dialect, ...missingDialect } = v2;',
      '// @ts-expect-error An SDK v2 trace must include a dialect.',
      'const badV2: TraceDocumentV2 = missingDialect;',
      '// @ts-expect-error A dialect is required to be one of the two known names.',
      "const unknownDialect: TraceDialect = 'mysql';",
      '// @ts-expect-error Display casing is not a dialect.',
      "const cased: TraceDialect = 'PostgreSQL';",
      '// @ts-expect-error A state cannot carry an unknown dialect.',
      "const badState: TraceState = { ...base, dialect: 'oracle' };",
      '// @ts-expect-error A v1-or-v2 trace may be v1 and omit its dialect.',
      'const certain: TraceDialect = document.dialect;',
      'export { one, two, legacy, named, read, legacyRead, certainV2, dialect, badV2, unknownDialect, cased, badState, certain };',
    ];
    const sourcePath = join(directory, 'consumer.mts'), configPath = join(directory, 'tsconfig.json');
    writeFileSync(sourcePath, source.join('\n') + '\n');
    writeFileSync(configPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, exactOptionalPropertyTypes: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], skipLibCheck: true }, files: ['consumer.mts'] }));
    const compiler = fileURLToPath(new URL('../node_modules/typescript/lib/tsc.js', import.meta.url));
    const child = spawnSync(process.execPath, [compiler, '-p', configPath], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
