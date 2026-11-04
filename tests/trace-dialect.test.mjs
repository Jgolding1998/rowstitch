import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTraceState, recordTrace, traceDocument } from '../dist/core/trace-log.js';
import { column, defineTable, openDatabase } from '../dist/index.js';

// The optional trace dialect. Studio validation and rendering are covered by tests/studio.spec.mjs. All data is fictional.
const state = (extra = {}) => ({ traceValues: false, capacity: 10, traces: [], sequence: 0, traceBytes: 0, omittedEntries: 0, ...extra });
const schema = [{ name: 'fictional_rows', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }], foreignKeys: [] }];
const stable = document => ({ ...document, generatedAt: 'fixed', queries: document.queries.map(query => ({ ...query, durationMs: 0 })) });
const record = target => recordTrace(target, { operation: 'transaction', table: '', sql: 'BEGIN ISOLATION LEVEL SERIALIZABLE', parameters: [], start: 0, rowCount: 0, transactionId: 'tx1', status: 'ok' });

test('a state without a dialect exports no dialect key at all', () => {
  const document = traceDocument(state(), 'Fictional', schema, []);
  assert.equal(Object.hasOwn(document, 'dialect'), false);
  assert.deepEqual(Object.keys(document), ['format', 'version', 'title', 'generatedAt', 'source', 'schema', 'queries', 'notes']);
  assert.ok(!JSON.stringify(document).includes('dialect'));
});
test('an explicitly undefined dialect is the same as an absent one', () => {
  const absent = traceDocument(state(), 'Fictional', schema, []), undefinedValue = traceDocument(state({ dialect: undefined }), 'Fictional', schema, []);
  assert.equal(Object.hasOwn(undefinedValue, 'dialect'), false);
  assert.equal(JSON.stringify(stable(undefinedValue)), JSON.stringify(stable(absent)));
});
for (const dialect of ['postgresql', 'sqlite']) {
  test(`a ${dialect} state exports its dialect straight after source and changes nothing else`, () => {
    const plain = state(), named = state({ dialect });
    record(plain); record(named);
    const document = traceDocument(named, 'Fictional', schema, ['A note.']), baseline = traceDocument(plain, 'Fictional', schema, ['A note.']);
    assert.equal(document.dialect, dialect);
    assert.deepEqual(Object.keys(document), ['format', 'version', 'title', 'generatedAt', 'source', 'dialect', 'schema', 'queries', 'notes']);
    const { dialect: removed, ...rest } = document;
    assert.equal(removed, dialect);
    assert.equal(JSON.stringify(stable(rest)), JSON.stringify(stable(baseline)));
  });
}
test('recording and clearing keep the dialect, and entries never carry it', () => {
  const target = state({ dialect: 'postgresql' });
  record(target);
  assert.ok(!Object.hasOwn(target.traces[0], 'dialect'));
  clearTraceState(target);
  assert.equal(target.dialect, 'postgresql');
  assert.equal(traceDocument(target, 'Fictional', schema, []).dialect, 'postgresql');
});
test('the dialect counts toward the document limit, and the size limit still applies', () => {
  const huge = [{ name: 'x'.repeat(4096), columns: Array.from({ length: 600 }, (_, i) => ({ name: 'c'.repeat(4090) + String(i), type: 'TEXT', nullable: false, primaryKey: false })), foreignKeys: [] }];
  assert.throws(() => traceDocument(state({ dialect: 'postgresql' }), 'Fictional', huge, []), error => error?.code === 'TRACE_LIMIT');
});
test('the public synchronous SQLite export stays free of a dialect', () => {
  const rows = defineTable('fictional_rows', { id: column.integer().primaryKey(), label: column.text() });
  const db = openDatabase(':memory:', { tables: [rows] });
  try {
    db.ensureSchema(); db.clearTrace();
    db.table(rows).insert({ id: 1, label: 'fictional' });
    assert.equal(Object.hasOwn(db.exportTrace(), 'dialect'), false);
  } finally { db.close(); }
});
test('declarations accept only the two dialects, and leave them optional', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-trace-dialect-'));
  try {
    const target = fileURLToPath(new URL('../dist/core/trace-log.js', import.meta.url)), path = relative(directory, target);
    const specifier = (isAbsolute(path) || path.startsWith('.') ? path : './' + path).replaceAll('\\', '/');
    const source = [
      `import type { TraceDialect, TraceDocument, TraceState } from ${JSON.stringify(specifier)};`,
      "const one: TraceDialect = 'postgresql', two: TraceDialect = 'sqlite';",
      "const base = { traceValues: false, capacity: 1, traces: [], sequence: 0, traceBytes: 0, omittedEntries: 0 };",
      'const legacy: TraceState = base;',
      "const named: TraceState = { ...base, dialect: 'postgresql' };",
      "declare const document: TraceDocument;",
      'const read: TraceDialect | undefined = document.dialect;',
      '// @ts-expect-error A dialect is required to be one of the two known names.',
      "const unknownDialect: TraceDialect = 'mysql';",
      '// @ts-expect-error Display casing is not a dialect.',
      "const cased: TraceDialect = 'PostgreSQL';",
      '// @ts-expect-error A state cannot carry an unknown dialect.',
      "const badState: TraceState = { ...base, dialect: 'oracle' };",
      '// @ts-expect-error A dialect is optional, so reading one may give undefined.',
      'const certain: TraceDialect = document.dialect;',
      'export { one, two, legacy, named, read, unknownDialect, cased, badState, certain };',
    ];
    const sourcePath = join(directory, 'consumer.mts'), configPath = join(directory, 'tsconfig.json');
    writeFileSync(sourcePath, source.join('\n') + '\n');
    writeFileSync(configPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, exactOptionalPropertyTypes: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], skipLibCheck: true }, files: ['consumer.mts'] }));
    const compiler = fileURLToPath(new URL('../node_modules/typescript/lib/tsc.js', import.meta.url));
    const child = spawnSync(process.execPath, [compiler, '-p', configPath], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
