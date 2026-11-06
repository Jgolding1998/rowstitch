import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { column, defineTable, openDatabase } from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const test = base.extend({
  studioURL: [async ({}, use) => {
    const child = spawn(process.execPath, ['dist/cli.js', 'demo', '--port', '0'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', bytes => { errors += String(bytes); });
    const timer = setTimeout(() => child.kill(), 10_000);
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => {
        output += String(bytes);
        const match = /Rowstitch: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Studio exited before ready (${code}): ${errors.slice(0, 500)}`)));
    });
    try { await use(url); }
    finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
        try { await exited; } finally { clearTimeout(force); }
      }
    }
  }, { scope: 'worker' }],
  browserAudit: [async ({ page, studioURL }, use) => {
    const failures = { outside: [], errors: [], dialogs: [] };
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== studioURL) failures.outside.push(request.url());
    });
    page.on('pageerror', error => failures.errors.push(error.message));
    page.on('dialog', async dialog => { failures.dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(() => {
      window.__studioCsp = [];
      window.__studioStorageWrites = [];
      document.addEventListener('securitypolicyviolation', event => window.__studioCsp.push(event.violatedDirective));
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        window.__studioStorageWrites.push(String(key));
        return setItem.call(this, key, value);
      };
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        window.__studioStorageWrites.push('indexedDB');
        return open.apply(this, args);
      };
    });
    await use(failures);
    expect(failures.outside).toEqual([]);
    expect(failures.errors).toEqual([]);
    expect(failures.dialogs).toEqual([]);
    if (!page.isClosed()) {
      expect(await page.evaluate(() => window.__studioCsp)).toEqual([]);
      expect(await page.evaluate(() => window.__studioStorageWrites)).toEqual([]);
      expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    }
  }, { auto: true }],
});

function trace(title = 'Independent local trace') {
  return {
    format: 'rowstitch-trace', version: 1, title, generatedAt: '2026-11-02T12:30:00.000Z', source: 'local-trace',
    schema: [
      { name: 'authors', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }, { name: 'name', type: 'text', nullable: false, primaryKey: false }], foreignKeys: [] },
      { name: 'posts', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }, { name: 'authorId', type: 'integer', nullable: false, primaryKey: false }], foreignKeys: [{ column: 'authorId', table: 'authors', target: 'id' }] },
    ],
    queries: [
      { id: 'read-authors', operation: 'select', table: 'authors', sql: 'SELECT "id", "name" FROM "authors" WHERE "name" = ?', parameters: ['SYNTHETIC_BOUND_VALUE'], durationMs: 0.25, rowCount: 1, transactionId: null, status: 'ok', plan: [{ detail: 'SEARCH authors USING INDEX authors_name (name=?)' }] },
      { id: 'insert-post', operation: 'insert', table: 'posts', sql: 'INSERT INTO "posts" ("authorId") VALUES (?)', parameters: ['[redacted]'], durationMs: 0.5, rowCount: 1, transactionId: 'tx-local-1', status: 'ok', plan: null },
      { id: 'stale-update', operation: 'update', table: 'posts', sql: 'UPDATE "posts" SET "authorId" = ? WHERE "id" = ?', parameters: ['[redacted]', '[redacted]'], durationMs: 0.75, rowCount: 0, transactionId: 'tx-local-1', status: 'error', plan: null },
    ],
    results: [{ title: 'Fictional preview', columns: ['Author', 'Post'], rows: [['Avery', 'Moon garden']] }],
    notes: ['Independent synthetic browser fixture.'],
  };
}

async function open(page, studioURL) {
  const response = await page.goto(studioURL);
  expect(response.status()).toBe(200);
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
}

async function put(page, document, name = 'fixture.json') {
  const body = typeof document === 'string' || Buffer.isBuffer(document) ? document : JSON.stringify(document);
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(body) });
}

async function importTrace(page, document = trace(), name) {
  await put(page, document, name);
  await expect(page.locator('#loaded-title')).toHaveText(document.title);
  await expect(page.locator('#error')).toBeHidden();
}

async function importBytes(page, bytes, title, name) {
  await put(page, bytes, name);
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#loaded-title')).toHaveText(title);
}

async function downloadBytes(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-trace').click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), filename: download.suggestedFilename() };
}

const expectSameBytes = (actual, expected) => {
  expect(actual.length).toBe(expected.length);
  expect(actual.equals(expected)).toBe(true);
};

async function deferFileRead(page) {
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      const buffer = await original.call(this);
      if (this.name === 'held.json') await new Promise(resolve => { window.__releaseHeldRead = resolve; });
      return buffer;
    };
  });
}

test('write effects follow real nested rollbacks and match a reopened database', async ({ page, studioURL }) => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-studio-outcomes-'));
  expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  const filename = join(directory, 'fictional.sqlite');
  const items = defineTable('outcome_items', { id: column.integer().primaryKey(), label: column.text() });
  const db = openDatabase(filename, { tables: [items], traceValues: true });
  let document;
  try {
    db.ensureSchema();
    db.clearTrace();
    db.transaction(tx => {
      tx.table(items).insert({ id: 1, label: 'kept' });
      expect(() => tx.transaction(inner => {
        inner.table(items).insert({ id: 2, label: 'inner rollback' });
        throw new Error('Fictional inner failure');
      })).toThrow('Fictional inner failure');
    });
    expect(() => db.transaction(tx => {
      tx.table(items).insert({ id: 3, label: 'outer rollback' });
      tx.transaction(inner => inner.table(items).insert({ id: 4, label: 'released then undone' }));
      throw new Error('Fictional outer failure');
    })).toThrow('Fictional outer failure');
    document = db.exportTrace({ title: 'Independent persisted outcome check' });
  } finally { db.close(); }
  try {
    const raw = new DatabaseSync(filename, { readOnly: true });
    let persisted;
    try { persisted = raw.prepare('SELECT id FROM outcome_items ORDER BY id').all().map(row => row.id); }
    finally { raw.close(); }
    expect(persisted).toEqual([1]);
    await open(page, studioURL);
    await importTrace(page, document);
    for (const [index, query] of document.queries.entries()) {
      if (query.operation !== 'insert' || query.status !== 'ok') continue;
      await page.locator('#query-list .q-row').nth(index).click();
      await expect(page.locator('.fact-effect')).toContainText(persisted.includes(query.parameters[0]) ? 'Committed in trace' : 'Undone');
      await expect(page.locator('#detail-body')).toContainText('Succeeded');
    }
    await expect(page.locator('#counts')).toContainText('Undone writes');
    await expect(page.locator('#counts')).toContainText('savepoints');
    await page.locator('#tab-about').click();
    await expect(page.locator('#view-about')).toContainText('1 committed, 3 undone');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function outcomeTrace(queries) {
  const document = trace('Independent transaction boundary check');
  document.queries = queries.map((query, index) => ({
    id: 'outcome-' + index, operation: 'transaction', table: null, sql: '', parameters: [],
    durationMs: 0.1, rowCount: null, transactionId: 'tx-one', status: 'ok', plan: null, ...query,
  }));
  return document;
}

test('incomplete or malformed transaction controls never claim a committed write', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const write = { operation: 'insert', table: 'posts', sql: 'INSERT INTO "posts" ("id") VALUES (?)', parameters: ['[redacted]'], rowCount: 1 };
  const cases = [
    [{ ...write }, { sql: 'COMMIT' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT\n' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT\r\n' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT;' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT', parameters: ['unexpected'] }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT', table: 'posts' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT', transactionId: 'wrong-id' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT', status: 'error' }],
    [{ sql: 'BEGIN IMMEDIATE' }, write, { sql: 'COMMIT', operation: 'select' }],
    [{ sql: 'BEGIN IMMEDIATE' }, { sql: 'SAVEPOINT "rs_sp_one"', transactionId: 'tx-two' }, { ...write, transactionId: 'tx-two' }, { sql: 'RELEASE SAVEPOINT "other"', transactionId: 'tx-two' }, { sql: 'COMMIT' }],
    [{ sql: 'BEGIN IMMEDIATE' }, { sql: 'SAVEPOINT "rs_sp_one\n"', transactionId: 'tx-two' }, { ...write, transactionId: 'tx-two' }, { sql: 'RELEASE SAVEPOINT "rs_sp_one\n"', transactionId: 'tx-two' }, { sql: 'COMMIT' }],
  ];
  for (const queries of cases) {
    const document = outcomeTrace(queries);
    await importTrace(page, document);
    const index = queries.findIndex(query => query.operation === 'insert');
    await page.locator('#query-list .q-row').nth(index).click();
    await expect(page.locator('.fact-effect')).not.toContainText('Committed');
    await expect(page.locator('.fact-effect')).toContainText(/Unknown|Not finished/);
  }
});

test('a mid-transaction snapshot stays unfinished even after the real transaction commits', async ({ page, studioURL }) => {
  const items = defineTable('snapshot_items', { id: column.integer().primaryKey() });
  const db = openDatabase(':memory:', { tables: [items] });
  let document;
  try {
    db.ensureSchema();
    db.clearTrace();
    db.transaction(tx => {
      tx.table(items).insert({ id: 1 });
      document = tx.exportTrace({ title: 'Snapshot before commit' });
    });
    expect(db.table(items).findMany()).toEqual([{ id: 1 }]);
  } finally { db.close(); }
  await open(page, studioURL);
  await importTrace(page, document);
  const index = document.queries.findIndex(query => query.operation === 'insert');
  await page.locator('#query-list .q-row').nth(index).click();
  await expect(page.locator('.fact-effect')).toContainText('Not finished in this trace');
  await expect(page.locator('#outcome-note')).toBeVisible();
  await expect(page.locator('#outcome-note')).toContainText('not finished');
});

test('failed commit followed by rollback links the undone write to the deciding statement', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = outcomeTrace([
    { sql: 'BEGIN IMMEDIATE' },
    { operation: 'update', table: 'posts', sql: 'UPDATE "posts" SET "id" = ? WHERE "id" = ?', parameters: ['[redacted]', '[redacted]'], rowCount: 1 },
    { sql: 'COMMIT', status: 'error' },
    { sql: 'ROLLBACK' },
  ]);
  await importTrace(page, document);
  await page.locator('#query-list .q-row').nth(1).click();
  await expect(page.locator('.fact-effect')).toContainText('Undone by ROLLBACK');
  const jump = page.getByRole('button', { name: 'Show statement outcome-3', exact: true });
  await jump.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail-body .sql')).toHaveText('ROLLBACK');
  await expect(page.locator('.fact-effect')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#outcome-note')).toBeHidden();
});

test('actual CLI demo matches the real ORM document and local security policy', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#loaded-kind')).toHaveText('Fictional demo');
  const response = await page.request.get(studioURL + '/api/demo');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response.headers()['content-security-policy']).not.toContain('unsafe-inline');
  const document = await response.json();
  expect(document.source).toBe('fictional-demo');
  expect(document.queries.length).toBeGreaterThan(0);
  await expect(page.locator('#query-list .q-row')).toHaveCount(document.queries.length);
  await expect(page.locator('#tab-count-schema')).toHaveText(String(document.schema.length));
  await expect(page.locator('#thread-figure')).toContainText('Statement, in recorded order');
  await expect(page.locator('#thread-scroll svg')).toHaveAttribute('aria-label', new RegExp(String(document.queries.length) + ' statements? in recorded order'));
  await page.locator('#tab-schema').click();
  for (const table of document.schema) await expect(page.locator('#tables')).toContainText(table.name);
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('Redaction is not anonymization');
});

test('SQL and hostile imported text stay inert across every view, without uploads', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const payload = '<img src="https://outside.example/trace" onerror="window.__traceExecuted=1"><script>window.__traceExecuted=1</script>';
  const document = trace(payload);
  document.schema[0].name = payload;
  document.queries[0].table = payload;
  document.queries[0].sql = `SELECT '${payload}'; DROP TABLE authors; --`;
  document.queries[0].parameters = [payload];
  document.results[0].rows[0][0] = payload;
  document.notes = [payload];
  const requests = [];
  page.on('request', request => requests.push(request.method() + ' ' + request.url()));
  await importTrace(page, document, '<img-onerror>.json');
  await expect(page.locator('#detail-body .sql')).toContainText(payload);
  await page.getByRole('button', { name: 'Show values', exact: true }).click();
  await expect(page.locator('#detail-body .params')).toContainText(JSON.stringify(payload));
  for (const name of ['schema', 'results', 'about']) {
    await page.locator('#tab-' + name).click();
    await expect(page.locator('#view-' + name)).toContainText(payload);
  }
  expect(await page.evaluate(() => window.__traceExecuted)).toBeUndefined();
  await expect(page.locator('#workspace img, #workspace script, #workspace iframe, #workspace [onerror]')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('bound values start hidden and are hidden again when choosing a different statement', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page);
  await expect(page.locator('#detail-body')).not.toContainText('SYNTHETIC_BOUND_VALUE');
  await page.getByRole('button', { name: 'Show values', exact: true }).click();
  await expect(page.locator('#detail-body')).toContainText('SYNTHETIC_BOUND_VALUE');
  await page.locator('#query-list .q-row').nth(1).click();
  await page.locator('#query-list .q-row').first().click();
  await expect(page.locator('#detail-body')).not.toContainText('SYNTHETIC_BOUND_VALUE');
  await expect(page.getByRole('button', { name: 'Show values', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('invalid, hostile and bounded imports preserve the previous trace', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const previous = trace('Kept after rejection');
  await importTrace(page, previous);
  const changes = [];
  const change = (name, edit) => { const value = trace(); edit(value); changes.push([name, JSON.stringify(value)]); };
  changes.push(['empty', ''], ['invalid-json', '{'], ['array', '[]'], ['deep', '['.repeat(64) + '0' + ']'.repeat(64)]);
  changes.push(['proto', JSON.stringify(trace()).replace('"title":', '"__proto__":{"polluted":"yes"},"title":')]);
  changes.push(['constructor', JSON.stringify(trace()).replace('"title":', '"constructor":{"prototype":{"polluted":"yes"}},"title":')]);
  change('version', value => { value.version = 2; });
  change('format', value => { value.format = 'other-format'; });
  change('unknown-field', value => { value.arbitrary = 'not a trace field'; });
  change('long-string', value => { value.title = 'x'.repeat(4097); });
  change('query-count', value => { value.queries = Array.from({ length: 1001 }, (_, i) => ({ ...value.queries[0], id: 'q' + i })); });
  change('table-count', value => { value.schema = Array.from({ length: 101 }, (_, i) => ({ ...value.schema[0], name: 't' + i })); });
  change('column-count', value => { value.schema[0].columns = Array.from({ length: 101 }, (_, i) => ({ ...value.schema[0].columns[0], name: 'c' + i })); });
  change('parameter-count', value => { value.queries[0].parameters = Array(1001).fill('[redacted]'); });
  change('row-count', value => { value.results[0].rows = Array.from({ length: 501 }, () => ['Avery', 'Moon']); });
  change('row-width', value => { value.results[0].rows = [['extra', 'cell', 'here']]; });
  change('duplicate-id', value => { value.queries[1].id = value.queries[0].id; });
  change('wrong-type', value => { value.queries[0].durationMs = 'NaN'; });
  change('node-count', value => { value.queries = Array.from({ length: 410 }, (_, i) => ({ ...value.queries[0], id: 'q' + i, parameters: Array(1000).fill(0) })); });
  changes.push(['oversize', Buffer.alloc(2 * 1024 * 1024 + 1, 32)], ['bad-utf8', Buffer.from([0xff, 0xfe, 0xff])]);
  for (const [name, content] of changes) {
    await test.step(name, async () => {
      await put(page, content, name + '.json');
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#error-text')).toContainText('previous trace is still shown');
      await expect(page.locator('#loaded-title')).toHaveText(previous.title);
    });
  }
  expect(await page.evaluate(() => Object.prototype.polluted)).toBeUndefined();
  await importTrace(page, trace('Valid after rejections'));
});

test('a supported maximum-size query list stays searchable with honest counts', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = trace('One thousand statements');
  document.queries = Array.from({ length: 1000 }, (_, i) => ({ ...document.queries[0], id: 'statement-' + i }));
  await importTrace(page, document);
  await expect(page.locator('#query-list .q-row')).toHaveCount(1000);
  await expect(page.locator('#showing')).toHaveText('Showing all 1,000 statements');
  await page.getByRole('searchbox', { name: 'Search statements' }).fill('statement-999');
  await expect(page.locator('#query-list .q-row')).toHaveCount(1);
  await expect(page.locator('#showing')).toHaveText('Showing 1 of 1,000 statements');
});

test('keyboard tabs, search, operation and failure filters work on the loaded trace', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page);
  await page.locator('#tab-queries').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-schema')).toBeFocused();
  await expect(page.locator('#view-schema')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.locator('#tab-about')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('#tab-queries')).toBeFocused();
  await page.keyboard.press('/');
  await expect(page.locator('#query-search')).toBeFocused();
  await page.locator('#query-search').fill('stale-update');
  await expect(page.locator('#query-list .q-row')).toHaveCount(1);
  await expect(page.locator('#detail-body')).toContainText('stale-update');
  await page.keyboard.press('Escape');
  await expect(page.locator('#query-list .q-row')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('update');
  await expect(page.locator('#query-list .q-row')).toHaveCount(1);
  await page.locator('#errors-only').click();
  await expect(page.locator('#errors-only')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detail-body')).toContainText('Failed');
  await expect(page.locator('#showing')).toHaveText('Showing 1 of 3 statements');
});

test('an empty filter does not keep an unrelated statement visible as its result', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page);
  await page.locator('#query-search').fill('NO_SUCH_STATEMENT');
  await expect(page.locator('#query-list .q-row')).toHaveCount(0);
  await expect(page.locator('#query-list')).toContainText('No statements match');
  await expect(page.locator('#detail-body .sql')).toHaveCount(0);
});

test('mobile views fit the viewport and query/detail keyboard focus remains useful', async ({ page, studioURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, studioURL);
  await importTrace(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('#query-list .q-row').nth(1).click();
  await expect(page.locator('#detail-title')).toBeFocused();
  await page.getByRole('button', { name: 'Back to the list', exact: true }).click();
  await expect(page.locator('#query-list .q-row').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#query-list .q-row').nth(2)).toBeFocused();
  await page.locator('#tab-schema').click();
  await expect(page.locator('#relationships')).toContainText('authorId');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('#tab-results').click();
  await expect(page.locator('#results')).toContainText('Moon garden');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('export is explicit, copies the source bytes and uses an application filename', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = trace('Exported synthetic trace');
  await importTrace(page, document, 'private-source-name.json');
  const { bytes, filename } = await downloadBytes(page);
  expect(filename).toMatch(/^rowstitch-trace-\d+\.json$/);
  expect(filename).not.toContain('private-source-name');
  expectSameBytes(bytes, Buffer.from(JSON.stringify(document)));
  await expect(page.locator('#status')).toContainText('including any values that were not redacted');
});

test('a sparse legacy trace exports byte for byte, omissions, repeats and number spellings included', async ({ page, studioURL }) => {
  await open(page, studioURL);
  // Hand-written so nothing here depends on JSON.stringify: a BOM, CRLF, odd spacing, an escape, a repeated key, omitted optional
  // fields, and numbers whose spelling or value JavaScript does not keep.
  const source = Buffer.from('\ufeff{ "format":"rowstitch-trace",\r\n  "version":1, "title":"EARLIER_REPEATED_TITLE", "title":"Sparse caf\\u00e9",\r\n'
    + ' "generatedAt":"2026-11-02T12:30:00.000Z","source":"local-trace",\r\n'
    + ' "schema":[ {"name":"t","columns":[{"name":"id","type":"integer","nullable":false,"primaryKey":true}]} ],\r\n'
    + ' "queries":[{"id":"bare","operation":"select","sql":"SELECT ?, ?, ?","parameters":[9007199254740993,1.50,1e2],"status":"ok"}],\r\n'
    + ' "results":[{"title":"r","columns":["n"],"rows":[[12345678901234567890]]}] }\r\n\r\n');
  await importBytes(page, source, 'Sparse caf\u00e9');

  // The preview is allowed to approximate, and the repeated key is not shown. Neither reaches the copy.
  await page.getByRole('button', { name: 'Show values', exact: true }).click();
  await expect(page.locator('#detail-body .params')).toContainText('9007199254740992');
  await expect(page.locator('#workspace')).not.toContainText('EARLIER_REPEATED_TITLE');

  const { bytes } = await downloadBytes(page);
  expectSameBytes(bytes, source);
  for (const kept of ['EARLIER_REPEATED_TITLE', '9007199254740993', '1.50', '1e2', '12345678901234567890']) expect(bytes.toString()).toContain(kept);
  for (const added of ['"table"', '"durationMs"', '"rowCount"', '"transactionId"', '"plan"', '"foreignKeys"', '"dialect"', '"notes"']) expect(bytes.toString()).not.toContain(added);

  const status = page.locator('#status');
  await expect(status).toContainText('an unchanged copy of the original trace');
  await expect(status).toContainText('anything this page does not show, such as repeated fields');
  await expect(status).toContainText('It is not sanitized');
  await page.locator('#tab-about').click();
  const privacy = page.locator('.privacy');
  await expect(privacy).toContainText('Export downloads an unchanged copy of the original trace. It is not sanitized');
  await expect(privacy).toContainText('an earlier value of a repeated field');
  await expect(privacy).toContainText('the copy keeps them as written');
  for (const stale of ['exactly as loaded', 'what is in the file and nothing else', 'null or an empty list']) {
    await expect(status).not.toContainText(stale);
    await expect(privacy).not.toContainText(stale);
  }

  // The copy opens again, and exports the same bytes again.
  await importBytes(page, bytes, 'Sparse caf\u00e9');
  expectSameBytes((await downloadBytes(page)).bytes, source);
});

test('a trace near the 2 MiB limit round-trips, including one normalizing would have pushed over it', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const limit = 2 * 1024 * 1024;
  // 1,000 statements, the item limit, of 2,000 characters each, far below the 4,096 limit on a single string.
  const document = {
    format: 'rowstitch-trace', version: 1, title: 'Near the limit', generatedAt: '2026-11-02T12:30:00.000Z', source: 'local-trace', schema: [],
    queries: Array.from({ length: 1000 }, (_, i) => ({ id: 'q' + i, operation: 'select', sql: 'S'.repeat(2000), parameters: [], status: 'ok' })),
  };
  const source = Buffer.from(JSON.stringify(document));
  expect(source.length).toBeGreaterThan(2_050_000);
  expect(source.length).toBeLessThan(limit);
  const normalized = { ...document, queries: document.queries.map(q => ({ id: q.id, operation: q.operation, table: null, sql: q.sql, parameters: q.parameters, durationMs: null, rowCount: null, transactionId: null, status: q.status, plan: null })) };
  expect(Buffer.byteLength(JSON.stringify(normalized, null, 2))).toBeGreaterThan(limit);

  await test.step('accepted, exported and accepted again', async () => {
    await importBytes(page, source, document.title);
    await expect(page.locator('#tab-count-queries')).toHaveText('1,000');
    const first = await downloadBytes(page);
    expectSameBytes(first.bytes, source);
    await page.locator('#clear-trace').click();
    await importBytes(page, first.bytes, document.title);
    expectSameBytes((await downloadBytes(page)).bytes, source);
  });

  await test.step('exactly at the limit, and refused one byte past it', async () => {
    const atLimit = Buffer.concat([source, Buffer.alloc(limit - source.length, 32)]);
    await page.locator('#clear-trace').click();
    await importBytes(page, atLimit, document.title);
    const round = await downloadBytes(page);
    expectSameBytes(round.bytes, atLimit);
    await put(page, Buffer.concat([atLimit, Buffer.from(' ')]), 'over.json');
    await expect(page.locator('#error-text')).toContainText('2 MiB or smaller');
    expectSameBytes((await downloadBytes(page)).bytes, atLimit);
  });
});

test('export follows the shown trace through failed, superseded and canceled reads', async ({ page, studioURL }) => {
  await open(page, studioURL);
  // Formatted differently on purpose, so a copy made from any parsed document could not match.
  const source = title => Buffer.from(JSON.stringify(trace(title), null, 3) + '\n\n');
  const kept = source('Kept source');
  await importBytes(page, kept, 'Kept source');

  await test.step('failed imports and a failed demo change nothing', async () => {
    const refused = [Buffer.from('{'), Buffer.from(JSON.stringify({ ...trace('Refused'), version: 3 })), Buffer.from([0xff, 0xfe, 0xff]), Buffer.alloc(2 * 1024 * 1024 + 1, 32)];
    for (const bytes of refused) {
      await put(page, bytes, 'refused.json');
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#loaded-title')).toHaveText('Kept source');
      expectSameBytes((await downloadBytes(page)).bytes, kept);
    }
    await page.route('**/api/demo', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic busy response"}' }));
    await page.locator('#load-demo').click();
    await expect(page.locator('#error-text')).toContainText('503');
    await page.unroute('**/api/demo');
    expectSameBytes((await downloadBytes(page)).bytes, kept);
  });

  await deferFileRead(page);
  const holdRead = async bytes => {
    await put(page, bytes, 'held.json');
    await page.waitForFunction(() => typeof window.__releaseHeldRead === 'function');
  };
  const releaseRead = async () => {
    await page.evaluate(() => { window.__releaseHeldRead(); delete window.__releaseHeldRead; });
    await page.waitForTimeout(100);
  };

  await test.step('a pending read does not change the export until it wins', async () => {
    await holdRead(source('Now current'));
    expectSameBytes((await downloadBytes(page)).bytes, kept);
    await releaseRead();
    await expect(page.locator('#loaded-title')).toHaveText('Now current');
    expectSameBytes((await downloadBytes(page)).bytes, source('Now current'));
  });

  await test.step('a superseded read never replaces the newer bytes', async () => {
    await holdRead(source('Stale'));
    const newer = source('Newer');
    await importBytes(page, newer, 'Newer');
    await releaseRead();
    await expect(page.locator('#loaded-title')).toHaveText('Newer');
    expectSameBytes((await downloadBytes(page)).bytes, newer);
  });

  await test.step('an older demo response never replaces the newer bytes', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    await page.route('**/api/demo', async route => { started(); await held; try { await route.continue(); } catch {} });
    await page.locator('#load-demo').click();
    await entered;
    const winner = source('Beats demo');
    await importBytes(page, winner, 'Beats demo');
    release();
    await page.waitForTimeout(150);
    await page.unroute('**/api/demo');
    expectSameBytes((await downloadBytes(page)).bytes, winner);
  });

  await test.step('a read canceled by Clear leaves nothing to export', async () => {
    await holdRead(source('Canceled'));
    await page.locator('#clear-trace').click();
    await releaseRead();
    await expect(page.locator('#loaded-kind')).toHaveText('Nothing loaded');
    await expect(page.locator('#export-trace')).toBeDisabled();
    await expect(page.locator('#status')).toContainText('Files you exported are not affected');
  });
});

test('the demo exports the bytes the local server sent', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const [response] = await Promise.all([page.waitForResponse('**/api/demo'), page.locator('#load-demo').click()]);
  const served = await response.body();
  await expect(page.locator('#status')).toContainText('Loaded the fictional demo');
  const { bytes, filename } = await downloadBytes(page);
  expect(filename).toMatch(/^rowstitch-demo-\d+\.json$/);
  expectSameBytes(bytes, served);
});

test('replacing and clearing a trace release its source bytes', async ({ page, studioURL }) => {
  await page.addInitScript(() => {
    const blobs = window.__sourceBlobs = [];
    window.Blob = new Proxy(window.Blob, {
      construct(target, args, newTarget) {
        const blob = Reflect.construct(target, args, newTarget);
        blobs.push(new WeakRef(blob));
        return blob;
      },
    });
  });
  await open(page, studioURL);
  const session = await page.context().newCDPSession(page);
  const live = async () => {
    await session.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => window.__sourceBlobs.filter(ref => ref.deref()).length);
  };
  // Retained while shown: this is what makes the release checks below mean something.
  await expect.poll(live).toBe(1);
  await importTrace(page, trace('First'));
  await expect.poll(live).toBe(1);
  await importTrace(page, trace('Second'));
  await expect.poll(live).toBe(1);
  await put(page, '{', 'refused.json');
  await expect(page.locator('#error')).toBeVisible();
  await expect.poll(live).toBe(1);

  await downloadBytes(page);
  await page.locator('#clear-trace').click();
  await expect(page.locator('#export-trace')).toBeDisabled();
  // The object URL of a just-finished export is revoked within a second.
  await expect.poll(live, { timeout: 5_000 }).toBe(0);
});

test('the agent brief shows all of its rules without scrolling at desktop width', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await page.locator('#guide-summary').click();
  const fits = await page.locator('#guide-brief').evaluate(node => node.scrollHeight <= node.clientHeight + 1);
  expect(fits).toBe(true);
});

test('Clear removes imported content from the DOM as well as the visible page', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const marker = 'CLEAR_DOM_SENTINEL_428';
  const document = trace(marker);
  document.queries[0].sql = `SELECT '${marker}'`;
  document.results[0].rows[0][0] = marker;
  document.notes = [marker];
  await importTrace(page, document);
  await page.locator('#clear-trace').click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty-title')).toBeFocused();
  await expect(page.locator('#export-trace')).toBeDisabled();
  expect(await page.evaluate(value => document.body.textContent.includes(value), marker)).toBe(false);
  expect(await page.locator('#file-input').evaluate(input => input.files.length)).toBe(0);
});

test('Clear cancels an initially pending demo even before a document has loaded', async ({ page, studioURL }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  await page.route('**/api/demo', async route => { started(); await held; try { await route.continue(); } catch {} });
  await page.goto(studioURL);
  await entered;
  try {
    await expect(page.locator('#clear-trace')).toBeEnabled();
    await page.locator('#clear-trace').click();
  } finally { release(); }
  await page.waitForTimeout(150);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#loaded-kind')).toHaveText('Nothing loaded');
});

test('Clear and a newer import each prevent an older file read from reappearing', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, trace('Current before delayed file'));
  await deferFileRead(page);
  await put(page, trace('Stale file A'), 'held.json');
  await page.waitForFunction(() => typeof window.__releaseHeldRead === 'function');
  await page.locator('#clear-trace').click();
  await page.evaluate(() => { window.__releaseHeldRead(); delete window.__releaseHeldRead; });
  await page.waitForTimeout(100);
  await expect(page.locator('#loaded-kind')).toHaveText('Nothing loaded');
  await importTrace(page, trace('Current file B'));
  await put(page, trace('Stale file C'), 'held.json');
  await page.waitForFunction(() => typeof window.__releaseHeldRead === 'function');
  await importTrace(page, trace('Newest file D'));
  await page.evaluate(() => window.__releaseHeldRead());
  await page.waitForTimeout(100);
  await expect(page.locator('#loaded-title')).toHaveText('Newest file D');
});

test('a newer imported trace wins over an older demo response and its error', async ({ page, studioURL }) => {
  await open(page, studioURL);
  for (const status of [200, 503]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    await page.route('**/api/demo', async route => {
      started(); await held;
      try { status === 200 ? await route.continue() : await route.fulfill({ status, contentType: 'application/json', body: '{"error":"Synthetic busy response"}' }); } catch {}
    });
    await page.locator('#load-demo').click();
    await entered;
    await importTrace(page, trace('Wins over demo ' + status));
    release();
    await page.waitForTimeout(150);
    await expect(page.locator('#loaded-title')).toHaveText('Wins over demo ' + status);
    await expect(page.locator('#error')).toBeHidden();
    await page.unroute('**/api/demo');
  }
});

test('a failed demo keeps the previous imported trace and shows an understandable error', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, trace('Kept while server is busy'));
  await page.route('**/api/demo', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic busy response"}' }));
  await page.locator('#load-demo').click();
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error-text')).toContainText('503');
  await expect(page.locator('#error-text')).toContainText('previous trace is still shown');
  await expect(page.locator('#loaded-title')).toHaveText('Kept while server is busy');
});

test('an impossible calendar date is rejected instead of silently changing the generated day', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, trace('Valid calendar date stays loaded'));
  const document = trace('Invalid February date');
  document.generatedAt = '2026-02-30T12:30:00.000Z';
  await put(page, document);
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#loaded-title')).toHaveText('Valid calendar date stays loaded');
});

test('accepted durations never produce an infinite recorded-time total', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, trace('Normal duration baseline'));
  const document = trace('Large finite durations');
  for (const query of document.queries) query.durationMs = 1e308;
  await put(page, document);
  await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#counts')).not.toContainText(/Infinity|NaN/);
});

test('getting-started guide supports keyboard discovery and recovery after Clear', async ({ page, studioURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, studioURL);
  const guide = page.locator('details#guide');
  const summary = page.locator('#guide-summary');
  await expect(page.locator('#workspace')).toBeVisible();
  expect(await guide.evaluate(node => node.open)).toBe(false);
  await expect(page.locator('#guide-brief')).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#guide-brief')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#guide-demo')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#guide-brief')).toBeHidden();
  await importTrace(page, trace('Ordinary imported onboarding fixture'));
  await page.locator('#clear-trace').click();
  await expect(page.locator('#empty-title')).toBeFocused();
  await expect(page.locator('#export-trace')).toBeDisabled();
  await page.getByRole('button', { name: 'How do I get a trace from my app?', exact: true }).click();
  await expect(summary).toBeFocused();
  await expect(page.locator('#guide-brief')).toBeVisible();
  await expect(page.locator('#loaded-kind')).toHaveText('Nothing loaded');
});

test('README navigation stays static and requires an explicit click after hostile imports', async ({ page, context, studioURL }) => {
  const navigations = [];
  // Fulfil the new tab locally: exercise an explicit navigation without contacting GitHub.
  await context.route('https://**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest()) navigations.push(request.url());
    if (request.isNavigationRequest() && request.url() === 'https://github.com/Jgolding1998/rowstitch') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>README test landing</title>' });
    } else await route.abort();
  });
  await open(page, studioURL);
  await page.locator('#guide-summary').click();
  const brief = await page.locator('#guide-brief').inputValue();
  const document = trace('https://outside.example/not-installation');
  document.notes = ['<a href="https://outside.example/setup">Imported installation link</a>'];
  await importTrace(page, document);
  expect(await page.locator('#guide-brief').inputValue()).toBe(brief);
  await expect(page.locator('#workspace a')).toHaveCount(0);
  const destinations = [
    'https://github.com/Jgolding1998/rowstitch#use-it-in-an-application',
    'https://github.com/Jgolding1998/rowstitch#readme',
  ];
  const links = page.locator('#guide a');
  await expect(links).toHaveCount(2);
  expect(navigations).toEqual([]);
  for (const [index, destination] of destinations.entries()) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute('href', destination);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    await expect(link).toHaveAttribute('rel', /\bnoreferrer\b/);
    const popupReady = context.waitForEvent('page');
    await link.click();
    const popup = await popupReady;
    try {
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toBe(destination);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    } finally { await popup.close(); }
    expect(navigations).toHaveLength(index + 1);
    expect(page.url()).toBe(studioURL + '/');
    await expect(page.locator('#loaded-title')).toHaveText(document.title);
  }
});

test('guide copy controls use fixed content and select complete text when clipboard access fails', async ({ page, studioURL }) => {
  // Keep the user's system clipboard intact and make permission denial deterministic.
  await page.addInitScript(() => {
    window.__guideCopies = [];
    window.__blockGuideCopy = false;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => {
      window.__guideCopies.push(value);
      if (window.__blockGuideCopy) throw new Error('Clipboard blocked for this test');
    } } });
  });
  await open(page, studioURL);
  await page.locator('#guide-summary').click();
  const brief = page.locator('#guide-brief');
  const briefText = await brief.inputValue();
  const codeText = await page.locator('#guide-trace-code').textContent();
  await importTrace(page, trace('Imported data is separate from the static guide'));
  await page.getByRole('button', { name: 'Copy brief', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__guideCopies)).toEqual([briefText]);
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__guideCopies)).toEqual([briefText, codeText]);
  await page.evaluate(() => { window.__blockGuideCopy = true; });
  await page.getByRole('button', { name: 'Copy brief', exact: true }).click();
  await expect(brief).toBeFocused();
  expect(await brief.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe(briefText);
  await expect(page.locator('#status')).toContainText(/Ctrl\+C|Command\+C/);
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toBe(codeText);
  await expect(page.locator('#status')).toContainText(/Ctrl\+C|Command\+C/);
});

// ---------------------------------------------------------------------------
// Trace dialect. SQL shapes follow what the PostgreSQL compiler and control statements generate; all data is fictional.
// ---------------------------------------------------------------------------
const PG_BEGIN = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const pgWrite = (extra = {}) => ({ operation: 'insert', table: 'sample_rows', sql: 'INSERT INTO "sample"."sample_rows" AS "__rs_pg_root" ("id", "label") VALUES ($1::"pg_catalog"."int8", $2::"pg_catalog"."text") RETURNING "__rs_pg_root"."id" AS "__rs_pg_0"', parameters: ['[redacted]', '[redacted]'], rowCount: 1, ...extra });
const pgRead = (extra = {}) => ({ operation: 'select', table: 'sample_rows', sql: 'SELECT "pg_catalog"."count"(*) AS "__rs_pg_count" FROM "sample"."sample_rows" AS "__rs_pg_root"', parameters: [], rowCount: 1, ...extra });
const pgTrace = queries => ({ ...outcomeTrace(queries), dialect: 'postgresql', title: 'Fictional PostgreSQL trace' });
const rowAt = (page, index) => page.locator('#query-list .q-row').nth(index);
const effectAt = async (page, index, expected) => { await rowAt(page, index).click(); await expect(page.locator('.fact-effect')).toContainText(expected); };
const exported = async page => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-trace').click()]);
  return JSON.parse(readFileSync(await download.path(), 'utf8'));
};

test('a PostgreSQL trace names its database and reads its real control statements', async ({ page, studioURL }) => {
  const requests = [];
  page.on('request', request => requests.push(request.method() + ' ' + new URL(request.url()).pathname));
  await open(page, studioURL);
  const after = requests.length;
  const document = pgTrace([
    { sql: PG_BEGIN }, pgWrite(), { sql: 'COMMIT' },
    { sql: 'BEGIN READ ONLY', transactionId: 'tx-read' }, pgRead({ transactionId: 'tx-read' }), { sql: 'COMMIT', transactionId: 'tx-read' },
    { sql: PG_BEGIN, transactionId: 'tx-undone' }, pgWrite({ transactionId: 'tx-undone' }), { sql: 'ROLLBACK', transactionId: 'tx-undone' },
    pgRead({ transactionId: null }),
  ]);
  await importTrace(page, document);
  await expect(page.locator('#loaded-dialect')).toHaveText('PostgreSQL');
  await expect(page.locator('#outcome-note')).toBeHidden();
  await expect(page.locator('#counts')).toContainText('Recorded plans');
  await expect(page.locator('#counts')).not.toContainText('full scan');
  const groups = page.locator('.tx-group');
  await expect(groups.nth(0)).toContainText('Committed in trace');
  await expect(groups.nth(0)).toContainText('Serializable');
  await expect(groups.nth(1)).toContainText('Read only');
  await expect(groups.nth(2)).toContainText('Rolled back');
  await effectAt(page, 1, 'Committed in trace');
  await effectAt(page, 7, 'Undone by ROLLBACK');
  await expect(page.locator('#detail-body')).toContainText('PostgreSQL ran this write');
  await expect(page.locator('#detail-body')).not.toContainText('SQLite');
  await rowAt(page, 1).click();
  const chips = page.locator('#detail-body .sql .slot');
  await expect(chips).toHaveText(['$1', '$2']);
  await expect(page.locator('#detail-body .slot-cell')).toHaveText(['$1', '$2']);
  await expect(page.locator('#detail-body')).not.toContainText('The SQL has');
  await expect(page.locator('#detail-body')).toContainText('This trace has no query plan for this statement.');
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('PostgreSQL, named by this trace');
  await expect(page.locator('#view-about')).toContainText('1 committed, 1 undone, 0 not finished, 0 unknown');
  expect(requests.slice(after).filter(request => !request.startsWith('GET /'))).toEqual([]);
  expect(requests.slice(after).filter(request => /api|sql|query/i.test(request))).toEqual([]);
  expect((await exported(page)).dialect).toBe('postgresql');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('#loaded-dialect')).toBeHidden();
  await expect(page.locator('#loaded-dialect')).toHaveText('');
});

test('the nested savepoints of a real PostgreSQL trace resolve their write effects', async ({ page, studioURL }) => {
  await open(page, studioURL);
  // The same frames, ids and order that the actual engine prototype recorded: a released child, a doubly nested failure, a later child.
  await importTrace(page, pgTrace([
    { sql: PG_BEGIN, transactionId: 'tx8' },
    { sql: 'SAVEPOINT "rs_async_sp_2"', transactionId: 'tx9' }, pgWrite({ transactionId: 'tx9' }), { sql: 'RELEASE SAVEPOINT "rs_async_sp_2"', transactionId: 'tx9' },
    { sql: 'SAVEPOINT "rs_async_sp_3"', transactionId: 'tx10' }, { sql: 'SAVEPOINT "rs_async_sp_4"', transactionId: 'tx11' },
    pgWrite({ transactionId: 'tx11', status: 'error', rowCount: 0 }),
    { sql: 'ROLLBACK TO SAVEPOINT "rs_async_sp_4"', transactionId: 'tx11' }, { sql: 'RELEASE SAVEPOINT "rs_async_sp_4"', transactionId: 'tx11' },
    { sql: 'ROLLBACK TO SAVEPOINT "rs_async_sp_3"', transactionId: 'tx10' }, { sql: 'RELEASE SAVEPOINT "rs_async_sp_3"', transactionId: 'tx10' },
    { sql: 'SAVEPOINT "rs_async_sp_5"', transactionId: 'tx12' }, pgWrite({ transactionId: 'tx12' }), { sql: 'RELEASE SAVEPOINT "rs_async_sp_5"', transactionId: 'tx12' },
    { sql: 'COMMIT', transactionId: 'tx8' },
  ]));
  await effectAt(page, 2, 'Committed in trace');
  await effectAt(page, 12, 'Committed in trace');
  await rowAt(page, 6).click();
  await expect(page.locator('.fact-effect')).toHaveCount(0);
  await expect(page.locator('#detail-body')).toContainText('does not prove that nothing changed');
  await expect(page.locator('.tx-group .tx-label', { hasText: 'Savepoint' })).toHaveCount(5);
  await expect(page.locator('#counts')).toContainText('4 savepoints');
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('2 committed, 0 undone, 0 not finished, 0 unknown');
});

test('a failed PostgreSQL COMMIT stays unknown, and a later ROLLBACK does not make it a rollback', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const lost = pgTrace([{ sql: PG_BEGIN }, pgWrite(), { sql: 'COMMIT', status: 'error' }]);
  await importTrace(page, lost);
  await effectAt(page, 1, 'Unknown from this trace');
  await expect(page.locator('#detail-body .callout.is-note')).toContainText('cannot show whether PostgreSQL applied it');
  await expect(page.locator('.tx-outcome')).toHaveText('COMMIT outcome unknown');
  await expect(page.locator('#outcome-note')).toContainText('1 write has an outcome this trace does not show');
  await rowAt(page, 2).click();
  await expect(page.locator('#detail-body .callout.is-error')).toContainText('does not prove that nothing changed');

  // ROLLBACK succeeds in PostgreSQL with nothing open, so this order proves no rollback. The same order in SQLite does.
  await importTrace(page, { ...pgTrace([{ sql: PG_BEGIN }, pgWrite(), { sql: 'COMMIT', status: 'error' }, { sql: 'ROLLBACK' }]), title: 'Rollback after failure' });
  await effectAt(page, 1, 'Unknown from this trace');
  await expect(page.locator('.fact-effect')).not.toContainText('Undone');
  await expect(page.locator('.tx-outcome').first()).not.toHaveText('Rolled back');
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('0 committed, 0 undone, 0 not finished, 1 unknown');
  await page.locator('#tab-queries').click();

  // A rejected COMMIT ends the transaction, so later work is ordinary and resolves on its own.
  await importTrace(page, { ...pgTrace([{ sql: PG_BEGIN }, pgWrite(), { sql: 'COMMIT', status: 'error' }, pgRead({ transactionId: null }),
    { sql: PG_BEGIN, transactionId: 'tx-two' }, pgWrite({ transactionId: 'tx-two' }), { sql: 'COMMIT', transactionId: 'tx-two' }]), title: 'Work after a rejected commit' });
  await effectAt(page, 1, 'Unknown from this trace');
  await effectAt(page, 5, 'Committed in trace');
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('1 committed, 0 undone, 0 not finished, 1 unknown');
});

test('a PostgreSQL trace follows aborted-transaction rules instead of trusting impossible success', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const failedRead = pgRead({ status: 'error', rowCount: 0 });
  const cases = [
    // A failed statement aborts the transaction, so a COMMIT reported as ok here is not a recorded order.
    ['Impossible commit', [{ sql: PG_BEGIN }, pgWrite(), failedRead, { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Impossible statement', [{ sql: PG_BEGIN }, pgWrite(), failedRead, pgRead(), { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Impossible write', [{ sql: PG_BEGIN }, failedRead, pgWrite(), { sql: 'ROLLBACK' }], 2, 'Unknown from this trace'],
    ['Impossible savepoint', [{ sql: PG_BEGIN }, pgWrite(), failedRead, { sql: 'SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }], 1, 'Unknown from this trace'],
    ['Whole rollback', [{ sql: PG_BEGIN }, pgWrite(), failedRead, { sql: 'ROLLBACK' }], 1, 'Undone by ROLLBACK'],
    ['Savepoint recovery', [{ sql: PG_BEGIN }, pgWrite(),
      { sql: 'SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }, pgRead({ transactionId: 'tx-child', status: 'error', rowCount: 0 }),
      { sql: 'ROLLBACK TO SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }, { sql: 'RELEASE SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }, { sql: 'COMMIT' }], 1, 'Committed in trace'],
    ['Failed savepoint release', [{ sql: PG_BEGIN }, pgWrite(),
      { sql: 'SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }, pgRead({ transactionId: 'tx-child', status: 'error', rowCount: 0 }),
      { sql: 'RELEASE SAVEPOINT "rs_async_sp_1"', transactionId: 'tx-child' }, { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    // SQLite's BEGIN forms and transaction spellings other than the generated ones are not PostgreSQL controls.
    ['SQLite begin', [{ sql: 'BEGIN IMMEDIATE' }, pgWrite(), { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Plain begin', [{ sql: 'BEGIN' }, pgWrite(), { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Lowercase begin', [{ sql: PG_BEGIN.toLowerCase() }, pgWrite(), { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Extra space', [{ sql: PG_BEGIN.replace(' ', '  ') }, pgWrite(), { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Abort spelling', [{ sql: PG_BEGIN }, pgWrite(), { sql: 'ABORT' }], 1, 'Unknown from this trace'],
    ['Disguised abort', [{ sql: PG_BEGIN }, pgWrite(), { operation: 'select', table: 'sample_rows', sql: 'ABORT', rowCount: 0 }, { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Disguised start', [{ sql: PG_BEGIN }, pgWrite(), { operation: 'select', table: 'sample_rows', sql: 'START TRANSACTION', rowCount: 0 }, { sql: 'COMMIT' }], 1, 'Unknown from this trace'],
    ['Autocommit write', [pgWrite({ transactionId: null })], 0, 'Unknown from this trace'],
    ['Unfinished', [{ sql: PG_BEGIN }, pgWrite()], 1, 'Not finished in this trace'],
    ['Failed rollback', [{ sql: PG_BEGIN }, pgWrite(), { sql: 'ROLLBACK', status: 'error' }], 1, 'Unknown from this trace'],
  ];
  for (const [title, queries, index, expected] of cases) {
    await importTrace(page, { ...pgTrace(queries), title });
    await effectAt(page, index, expected);
  }
});

test('legacy and SQLite traces keep their meaning, and the PostgreSQL forms are not read into them', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const legacy = trace('Legacy trace without a dialect');
  await importTrace(page, legacy);
  await expect(page.locator('#loaded-dialect')).toHaveText('SQLite');
  await expect(page.locator('#counts')).toContainText('Plans with a full scan');
  await expect(page.locator('#detail-body .sql .slot')).toHaveText(['?1']);
  const round = await exported(page);
  expect(Object.keys(round)).not.toContain('dialect');
  expect(round.queries.map(query => query.sql)).toEqual(legacy.queries.map(query => query.sql));
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('This trace names no database');
  await page.locator('#tab-queries').click();

  const named = { ...trace('Explicit SQLite trace'), dialect: 'sqlite' };
  await importTrace(page, named);
  await expect(page.locator('#loaded-dialect')).toHaveText('SQLite');
  expectSameBytes((await downloadBytes(page)).bytes, Buffer.from(JSON.stringify(named)));
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('SQLite, named by this trace');
  await page.locator('#tab-queries').click();

  for (const extra of [{}, { dialect: 'sqlite' }]) {
    await importTrace(page, { ...outcomeTrace([{ sql: PG_BEGIN }, { operation: 'insert', table: 'posts', sql: 'INSERT INTO "posts" ("id") VALUES ($1)', parameters: ['[redacted]'], rowCount: 1 }, { sql: 'COMMIT' }]), ...extra, title: 'PostgreSQL forms in SQLite ' + Object.keys(extra).length });
    await effectAt(page, 1, 'Unknown from this trace');
    await expect(page.locator('#detail-body .sql .slot')).toHaveCount(0);
  }
  // In SQLite ROLLBACK after a failed COMMIT does prove the transaction was still open.
  await importTrace(page, { ...outcomeTrace([{ sql: 'BEGIN IMMEDIATE' }, { operation: 'insert', table: 'posts', sql: 'INSERT INTO "posts" ("id") VALUES (?)', parameters: ['[redacted]'], rowCount: 1 }, { sql: 'COMMIT', status: 'error' }, { sql: 'ROLLBACK' }]), title: 'SQLite recovery' });
  await effectAt(page, 1, 'Undone by ROLLBACK');
  await expect(page.locator('#detail-body')).toContainText('SQLite ran this write');
});

test('malformed dialects are refused without echoing them, and the current trace stays', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, trace('Trace that stays'));
  const hostile = '<img src=x onerror="window.__dialectInjected=1">';
  for (const dialect of ['PostgreSQL', 'postgres', 'postgresql ', ' sqlite', 'mysql', '', null, 0, 1, true, false, [], ['postgresql'], {}, { name: 'postgresql' }, hostile]) {
    await put(page, { ...trace('Refused'), dialect });
    await expect(page.locator('#error-text')).toContainText('"dialect" must be "sqlite" or "postgresql" when present');
    await expect(page.locator('#error-text')).toContainText('The previous trace is still shown');
    await expect(page.locator('#error-text')).not.toContainText('onerror');
    await expect(page.locator('#loaded-title')).toHaveText('Trace that stays');
    await expect(page.locator('#loaded-dialect')).toHaveText('SQLite');
  }
  await put(page, JSON.stringify(trace('Reserved')).replace('"format"', '"__proto__":{"dialect":"postgresql"},"format"'));
  await expect(page.locator('#error-text')).toContainText('reserved field name');
  expect(await page.evaluate(() => window.__dialectInjected)).toBeUndefined();
  await expect(page.locator('#detail-body img, #loaded img:not(.brand-mark)')).toHaveCount(0);
});

test('PostgreSQL placeholders are slots only where PostgreSQL reads them, and hostile text stays text', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const markup = '<img src=x onerror="window.__traceInjected=1">';
  const slotsOf = async (index, sql, parameters, expected) => {
    await rowAt(page, index).click();
    await expect(page.locator('#detail-body .sql code')).toHaveText(sql);
    await expect(page.locator('#detail-body .sql .slot')).toHaveText(expected);
  };
  const statements = [
    ['SELECT "a" FROM "t" WHERE "a" OPERATOR("pg_catalog".=) $1::"pg_catalog"."int8" AND "b" = $2 OR "c" = $1', ['[redacted]', '[redacted]'], ['$1', '$2', '$1']],
    ['SELECT "j" ? \'k\', "j" ?| $1 FROM "t"', ['[redacted]'], ['$1']],
    ['SELECT ("arr"[$1])[$2]::"pg_catalog"."int4"[] FROM "t"', ['[redacted]', '[redacted]'], ['$1', '$2']],
    ['SELECT $tag$ not $9 a slot $tag$, $$ nor $8 $$, $1 FROM "t"', ['[redacted]'], ['$1']],
    ['SELECT \'$7\', "$6", E\'it\\\'s $5\', $1 FROM "t"', ['[redacted]'], ['$1']],
    ['SELECT name$1, $1 FROM "t" -- $4\n/* $3 */', ['[redacted]'], ['$1']],
    ['SELECT \'' + markup + '\', "' + markup + '", $1', ['[redacted]'], ['$1']],
  ];
  const document = pgTrace(statements.map(([sql, parameters]) => ({ operation: 'select', table: markup, id: undefined, sql, parameters, transactionId: null, rowCount: 1 })));
  document.title = markup; document.notes = [markup]; document.queries.forEach((query, index) => { query.id = markup + index; });
  await put(page, document);
  await expect(page.locator('#loaded-title')).toHaveText(markup);
  await expect(page.locator('#loaded-dialect')).toHaveText('PostgreSQL');
  for (const [index, [sql, parameters, expected]] of statements.entries()) await slotsOf(index, sql, parameters, expected);
  await rowAt(page, 0).click();
  await expect(page.locator('#detail-body')).not.toContainText('The SQL has');
  // A shortfall is still called out, in the same notation.
  await importTrace(page, pgTrace([{ operation: 'select', table: 'sample_rows', sql: 'SELECT $1, $2, $3', parameters: ['[redacted]'], transactionId: null }]));
  await expect(page.locator('#detail-body')).toContainText('The SQL has 3 slots and the trace lists 1 value.');
  await importTrace(page, { ...pgTrace([{ operation: 'select', table: 'sample_rows', sql: 'SELECT 1', parameters: [], transactionId: null, plan: [{ detail: 'SCAN sample_rows' }, { detail: 'Seq Scan on sample_rows USING INDEX TEMP B-TREE' }] }]), title: 'Plan text only' });
  await expect(page.locator('#detail-body .plan .tag')).toHaveCount(0);
  await expect(page.locator('#detail-body')).toContainText('shown without interpretation');
  await expect(page.locator('#counts')).toContainText('Recorded plans');
  expect(await page.evaluate(() => window.__traceInjected)).toBeUndefined();
  await expect(page.locator('body img:not(.brand-mark)')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Trace version 2. Fixtures follow TraceDocumentV2 and all names are fictional. Titles starting "writer:" use the real library
// writer through dist; every other case below is fixture driven.
// ---------------------------------------------------------------------------
const named = (schema, table) => ({ schema, table });
const catalogColumn = (name, extra = {}) => ({ name, type: 'integer', nullable: false, primaryKey: false, ...extra });
const registration = (logical, physical, columns, extra = {}) => ({
  logical, physical, schemaSource: 'explicit', policy: 'legacy',
  columns: Object.entries(columns).map(([property, stored]) => ({ logical: property, physical: stored })), ...extra,
});
const observedTable = (identity, columns, extra = {}) => ({
  name: identity.table, identity, coverage: { columns: 'all', totalColumnCount: columns.length }, columns, foreignKeys: [], ...extra,
});
function v2Document(title, { dialect = 'sqlite', scope = 'mapped', tables = [], schema = [], queries = [], mappingOmitted = 0, inspectionOmitted = 0 } = {}) {
  return {
    format: 'rowstitch-trace', version: 2, title, generatedAt: '2026-11-02T12:30:00.000Z', source: 'local-trace', dialect,
    mapping: { tables, omittedTables: mappingOmitted },
    inspection: { scope, registeredTables: tables.length + mappingOmitted, omittedTables: inspectionOmitted },
    schema, queries, notes: ['Fictional mapped trace.'],
  };
}
const statement = (id, table, extra = {}) => ({
  id, operation: 'select', table, sql: 'SELECT "c" FROM "s"."t" WHERE "c" = ?', parameters: ['[redacted]'], durationMs: 0.25, rowCount: 1, transactionId: null, status: 'ok', ...extra,
});
function mappedOrders(title = 'Fictional mapped orders') {
  return v2Document(title, {
    tables: [
      registration('orders', named('billing_main', 'tbl_orders'), { id: 'order_id', customerId: 'customer_ref' }, { policy: 'exact' }),
      registration('customers', named('main', 'customers'), { id: 'id', name: 'name' }, { schemaSource: 'default' }),
      registration('events', named('main', 'event_log'), { id: 'event_id', note: 'note_text' }, { policy: 'subset', schemaSource: 'default' }),
      registration('ghosts', named('main', 'never_created'), { id: 'ghost_id' }),
    ],
    schema: [
      observedTable(named('billing_main', 'tbl_orders'), [catalogColumn('order_id', { primaryKey: true }), catalogColumn('customer_ref')], {
        foreignKeys: [{ constraint: '0', width: 1, columns: [{ column: 'customer_ref', target: 'id' }], targetIdentity: named('main', 'customers') }],
      }),
      observedTable(named('main', 'customers'), [catalogColumn('id', { primaryKey: true }), catalogColumn('name', { type: 'text' })]),
      observedTable(named('main', 'event_log'), [catalogColumn('event_id', { primaryKey: true }), catalogColumn('note_text', { type: 'text', nullable: true })], {
        coverage: { columns: 'mapped-and-key', totalColumnCount: 14 },
      }),
    ],
    queries: [statement('read-orders', 'orders'), statement('read-orders-2', 'orders'), statement('read-customer', 'customers'), statement('begin', '', { operation: 'transaction', sql: 'BEGIN IMMEDIATE', parameters: [], transactionId: 'tx-a' })],
  });
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const card = (page, text) => page.locator('.table-card').filter({ has: page.locator('h2.table-name', { hasText: new RegExp('^' + text + '$') }) });

test('column headers stay on one line beside long stored names', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = v2Document('Long stored names', {
    dialect: 'postgresql',
    tables: [registration('ghosts', named('public', 'g'.repeat(63)), { id: 'c'.repeat(63) })],
  });
  await importTrace(page, document);
  await page.locator('#tab-schema').click();
  const headers = card(page, 'ghosts').locator('thead th');
  await expect(headers).toHaveText(['Property', 'Stored column', 'Type', 'Rules']);
  const lines = await headers.evaluateAll(cells => cells.map(cell => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
  }));
  expect(lines).toEqual([1, 1, 1, 1]);
  expect(await noOverflow(page)).toBe(true);
});

test('a v2 card joins statements, stored names and columns through the mapping', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = mappedOrders();
  await importTrace(page, document);
  await page.locator('#tab-schema').click();
  await expect(page.locator('#tab-count-schema')).toHaveText('4');

  const orders = card(page, 'orders');
  await expect(orders.locator('.stored-as')).toContainText('Stored as "billing_main"."tbl_orders"');
  await expect(orders.locator('.stored-as')).toContainText('(named schema)');
  await expect(orders.locator('thead th')).toHaveText(['Property', 'Stored column', 'Type', 'Rules']);
  const firstRow = orders.locator('tbody tr').first();
  await expect(firstRow.locator('td')).toHaveText(['id', '"order_id"', 'integer', 'Primary key · Required']);
  await expect(orders.locator('tbody tr').nth(1).locator('td').nth(3)).toContainText('Foreign key');
  await expect(orders).toContainText('Declared policy: exact');
  await expect(orders).not.toContainText(/verified|guaranteed/i);

  // An identity table says so once, instead of repeating each name.
  const customers = card(page, 'customers');
  await expect(customers.locator('.stored-as')).toContainText('Stored under the same name, in "main"');
  await expect(customers.locator('.stored-as')).toContainText('(default schema)');
  await expect(customers.locator('thead th')).toHaveText(['Column', 'Type', 'Rules']);
  await expect(customers).toContainText('Referenced by "billing_main"."tbl_orders"');

  // The earlier false claim: statements ran on an aliased table, and it must not read as unused.
  const show = orders.getByRole('button', { name: 'Show 2 statements', exact: true });
  await show.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-queries')).toBeFocused();
  await expect(page.locator('#table-filter-name')).toHaveText('orders');
  await expect(page.locator('#query-list .q-row')).toHaveCount(2);
  await expect(page.locator('#query-list .q-table').first()).toHaveText('orders');
  await expect(page.locator('.fact-stored')).toContainText('"billing_main"."tbl_orders"');
  await page.locator('#table-filter-clear').click();

  // Searching finds a statement by its stored name, though neither its SQL nor its table holds that text.
  await page.locator('#query-search').fill('tbl_orders');
  await expect(page.locator('#query-list .q-row')).toHaveCount(2);
  await page.locator('#query-search').fill('');
  await page.locator('#query-list .q-row').nth(3).click();
  await expect(page.locator('.fact-stored')).toHaveCount(0);

  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('Version 2, with stored names and coverage');
  await expect(page.locator('#view-about')).toContainText('Mapped tables only');
  expect(await exported(page)).toMatchObject({ version: 2, mapping: document.mapping, inspection: document.inspection, schema: document.schema });
});

test('coverage says what a snapshot covers and never implies more', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, mappedOrders());
  await page.locator('#tab-schema').click();
  const coverage = page.locator('#schema-coverage');
  await expect(coverage).toContainText('Mapped tables only. Other tables may exist. 4 tables registered, 3 tables in this snapshot.');
  await expect(coverage).toContainText('not a check result');
  await expect(card(page, 'events').locator('.coverage-line')).toHaveText('Mapped and key columns only: 2 of 14. 12 more columns exist in the database and are not listed.');
  await expect(card(page, 'orders').locator('.coverage-line')).toHaveText('All 2 columns in the catalog are listed.');
  const ghosts = card(page, 'ghosts');
  await expect(ghosts).toContainText('Not in this snapshot');
  await expect(ghosts).toContainText('can mean the table does not exist');
  await expect(ghosts.locator('tbody td').nth(2)).toHaveText('Not in this snapshot');
  await expect(ghosts.locator('tbody td').nth(3)).toHaveText('Not known');
  await expect(ghosts.getByRole('button', { name: 'No statements recorded for this table', exact: true })).toBeDisabled();

  await importTrace(page, v2Document('Nothing registered'));
  await page.locator('#tab-schema').click();
  await expect(coverage).toContainText('No tables are registered, so none were inspected. This says nothing about the database.');
  await expect(page.locator('#tables')).toContainText('says nothing about what the database holds');

  await importTrace(page, v2Document('Everything visible', { scope: 'all', dialect: 'postgresql', schema: [{ ...observedTable(named('public', 'loose_rows'), [catalogColumn('id')]), coverage: { columns: 'all' } }] }));
  await page.locator('#tab-schema').click();
  await expect(coverage).toContainText('does not prove the database is empty or unchanged since');
  await expect(coverage).toContainText('No tables are registered, so no stored names are mapped.');
  const loose = page.locator('.table-card').first();
  await expect(loose).toContainText('Not registered');
  await expect(loose.locator('h2')).toContainText('"public"."loose_rows"');
  await expect(loose).toContainText('Every column in the catalog is listed.');
  await expect(loose).toContainText('no statement in this trace is linked');

  const partial = mappedOrders('Left out and no total');
  partial.mapping.tables.pop();
  partial.mapping.omittedTables = 1;
  partial.inspection.omittedTables = 1;
  delete partial.schema[2].coverage.totalColumnCount;
  await importTrace(page, partial);
  await page.locator('#tab-schema').click();
  await expect(coverage).toContainText('1 registration was left out of this file, so its mapping is not shown.');
  await expect(coverage).toContainText('1 table from the catalog was left out of this file');
  await expect(card(page, 'events').locator('.coverage-line')).toHaveText('Mapped and key columns only. The catalog gave no total, so other columns may exist.');
  await page.locator('#tab-queries').click();
  // Once the mapping can be partial, a statement with no entry says so rather than guessing.
  const unmatched = mappedOrders('Statement without an entry');
  unmatched.mapping.tables.pop();
  unmatched.mapping.omittedTables = 1;
  unmatched.queries.push(statement('read-omitted', 'omitted_table'));
  await importTrace(page, unmatched);
  await page.locator('#query-list .q-row').nth(4).click();
  await expect(page.locator('.fact-stored')).toHaveText(/Its mapping entry was left out of this trace/);
});

test('the same table name in two schemas stays two identities, with no guessing by basename', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const shared = v2Document('Same basename', {
    tables: [
      registration('liveOrders', named('main', 'orders'), { id: 'id' }),
      registration('scratchOrders', named('temp', 'orders'), { id: 'scratch_id' }, { policy: 'subset' }),
    ],
    schema: [
      observedTable(named('main', 'orders'), [catalogColumn('id', { primaryKey: true })]),
      observedTable(named('temp', 'orders'), [catalogColumn('scratch_id', { primaryKey: true }), catalogColumn('hidden_detail', { type: 'text' })], {
        foreignKeys: [{ constraint: '0', width: 1, columns: [{ column: 'scratch_id', target: 'id' }], targetIdentity: named('main', 'orders') }],
      }),
    ],
    queries: [statement('live-1', 'liveOrders'), statement('scratch-1', 'scratchOrders'), statement('scratch-2', 'scratchOrders'), statement('scratch-3', 'scratchOrders')],
  });
  await importTrace(page, shared);
  await page.locator('#tab-schema').click();
  await expect(page.locator('#tab-count-schema')).toHaveText('2');
  const live = card(page, 'liveOrders');
  const scratch = card(page, 'scratchOrders');
  await expect(live.locator('.stored-as')).toContainText('"main"."orders"');
  await expect(scratch.locator('.stored-as')).toContainText('"temp"."orders"');
  await expect(live.getByRole('button', { name: 'Show 1 statement', exact: true })).toBeEnabled();
  await expect(scratch.getByRole('button', { name: 'Show 3 statements', exact: true })).toBeEnabled();
  await expect(scratch.locator('tbody tr').nth(1).locator('td').first()).toHaveText('Not mapped');
  await expect(live).toContainText('Referenced by "temp"."orders"');
  await expect(scratch).not.toContainText('Referenced by');
  await expect(page.locator('#relationships .relationship')).toHaveCount(1);
  await expect(page.locator('#relationships .rel-head')).toContainText('"temp"."orders" references "main"."orders"');
  await page.locator('#tab-queries').click();
  await rowAt(page, 1).click();
  await expect(page.locator('.fact-stored')).toContainText('"temp"."orders"');
  await rowAt(page, 0).click();
  await expect(page.locator('.fact-stored')).toContainText('"main"."orders"');

  // Two unregistered tables with one name are still two cards in an inspection of everything.
  await importTrace(page, v2Document('Same basename unregistered', { scope: 'all', schema: [
    observedTable(named('main', 'notes'), [catalogColumn('id')]),
    observedTable(named('temp', 'notes'), [catalogColumn('id')]),
  ] }));
  await page.locator('#tab-schema').click();
  await expect(page.locator('.table-card h2')).toHaveText(['"main"."notes"', '"temp"."notes"']);
});

test('names compare the way each database compares them', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const build = dialect => v2Document('Case rule ' + dialect, {
    dialect, scope: 'all',
    tables: [registration('ledger', named(dialect === 'sqlite' ? 'MAIN' : 'public', 'Ledger_Rows'), { id: 'Row_Id' })],
    schema: [observedTable(named(dialect === 'sqlite' ? 'main' : 'public', 'ledger_rows'), [catalogColumn('row_id', { primaryKey: true })])],
  });
  // SQLite folds ASCII, so the registration finds its catalog row and shows the catalog's spelling.
  await importTrace(page, build('sqlite'));
  await page.locator('#tab-schema').click();
  await expect(page.locator('.table-card')).toHaveCount(1);
  await expect(card(page, 'ledger').locator('.stored-as')).toContainText('"main"."ledger_rows"');
  await expect(card(page, 'ledger').locator('tbody td').nth(1)).toHaveText('"row_id"');
  await expect(card(page, 'ledger').locator('tbody td').nth(2)).toHaveText('integer');

  // PostgreSQL does not, so these are unrelated tables.
  await importTrace(page, build('postgresql'));
  await page.locator('#tab-schema').click();
  await expect(page.locator('.table-card')).toHaveCount(2);
  await expect(card(page, 'ledger')).toContainText('Not in this snapshot');
  await expect(page.locator('.table-card').nth(1)).toContainText('Not registered');

  // SQLite folds A to Z only. A Unicode case pair stays distinct, and so do these two registrations.
  const unicode = v2Document('Unicode case', {
    tables: [registration('first', named('main', 'É_rows'), { id: 'id' }), registration('second', named('main', 'é_rows'), { id: 'id' })],
    schema: [observedTable(named('main', 'é_rows'), [catalogColumn('id')])],
  });
  await importTrace(page, unicode);
  await page.locator('#tab-schema').click();
  await expect(card(page, 'first')).toContainText('Not in this snapshot');
  await expect(card(page, 'second')).toContainText('1 column');
});

test('foreign keys stay structured, including compound, unresolved and absent targets', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, v2Document('Relationship shapes', {
    tables: [registration('lines', named('main', 'order.lines'), { a: 'part.a', b: 'part_b' })],
    schema: [observedTable(named('main', 'order.lines'), [catalogColumn('part.a'), catalogColumn('part_b')], { foreignKeys: [
      { constraint: '0', width: 2, columns: [{ column: 'part.a', target: 'x' }, { column: 'part_b', target: 'y' }], targetIdentity: named('main', 'other.table') },
      { constraint: '1', width: 1, columns: [{ column: 'part_b', target: null }], targetIdentity: named('main', 'order.lines') },
      { constraint: '2', width: 1, columns: [{ column: 'not_listed', target: 'missing_column' }], targetIdentity: named('main', 'order.lines') },
    ] })],
  }));
  await page.locator('#tab-schema').click();
  const relationships = page.locator('#relationships .relationship');
  await expect(relationships).toHaveCount(3);
  await expect(relationships.nth(0).locator('.rel-head')).toContainText('"main"."order.lines" references "main"."other.table"');
  await expect(relationships.nth(0).locator('.rel-head')).toContainText('Table not in this snapshot');
  await expect(relationships.nth(0).locator('.rel-head')).toContainText('2 columns together');
  await expect(relationships.nth(0).locator('.rel-pair')).toHaveText(['"part.a" to "x"', '"part_b" to "y"']);
  await expect(relationships.nth(1).locator('.rel-pair')).toContainText('Target key not resolved by the catalog');
  await expect(relationships.nth(1).locator('.rel-head')).not.toContainText('not in this snapshot');
  await expect(relationships.nth(2).locator('.rel-pair .tag')).toHaveText(['Column not in this snapshot', 'Column not in this snapshot']);
  // The schema and table are separate elements, so a dot in a name can't pass as a qualifier.
  await expect(relationships.nth(0).locator('.rel-head .ident-pair').first().locator('.ident')).toHaveText(['"main"', '"order.lines"']);
  await expect(card(page, 'lines')).toContainText('3 foreign keys from this table');
});

test('version 1 stays strict, gains no mappings, and re-exports as version 1', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const legacy = { ...trace('Legacy stays legacy'), dialect: 'sqlite' };
  await importTrace(page, legacy);
  await page.locator('#tab-schema').click();
  await expect(page.locator('#schema-coverage')).toHaveText('This trace predates mappings. It shows table names as they were recorded, with no stored names, schemas or coverage.');
  await expect(page.locator('#tables .stored-as, #tables .coverage-line, #tables .policy')).toHaveCount(0);
  await expect(page.locator('#view-schema')).not.toContainText('Stored as');
  await expect(card(page, 'posts').locator('thead th')).toHaveText(['Column', 'Type', 'Rules']);
  await page.locator('#tab-about').click();
  await expect(page.locator('#view-about')).toContainText('Version 1. This trace predates mappings.');
  await page.locator('#tab-queries').click();
  await expect(page.locator('.fact-stored')).toHaveCount(0);
  const round = await exported(page);
  expect(round.version).toBe(1);
  expect(Object.keys(round).sort()).toEqual(Object.keys(legacy).sort());
  expect(round.schema).toEqual(legacy.schema);
  await importTrace(page, { ...round, title: 'Legacy after a round trip' });

  // Version 2 fields on a version 1 trace, and the reverse, are not mixed quietly.
  const previous = 'Legacy after a round trip';
  const refused = [
    ['mapping on v1', { ...trace(), mapping: { tables: [], omittedTables: 0 } }, 'unexpected field "mapping"'],
    ['inspection on v1', { ...trace(), inspection: { scope: 'all', registeredTables: 0, omittedTables: 0 } }, 'unexpected field "inspection"'],
    ['identity on a v1 table', (() => { const t = trace(); t.schema[0].identity = named('main', 'authors'); return t; })(), 'unexpected field "identity"'],
    ['v1 foreign key on v2', (() => { const t = mappedOrders(); t.schema[0].foreignKeys = [{ column: 'a', table: 'b', target: 'c' }]; return t; })(), 'unexpected field "column"'],
    ['version 3', { ...mappedOrders(), version: 3 }, 'The studio reads versions 1 and 2'],
    ['version text', { ...mappedOrders(), version: '2' }, 'The studio reads versions 1 and 2'],
    ['version 1.5', { ...mappedOrders(), version: 1.5 }, 'The studio reads versions 1 and 2'],
  ];
  for (const [name, document, message] of refused) {
    await test.step(name, async () => {
      await put(page, document, 'refused.json');
      await expect(page.locator('#error-text')).toContainText(message);
      await expect(page.locator('#loaded-title')).toHaveText(previous);
    });
  }
});

test('version 2 re-exports its mapping and re-imports to the same document', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = mappedOrders('Round trip');
  document.schema[2].coverage = { columns: 'mapped-and-key' };
  document.results = [{ title: 'Fictional preview', columns: ['A'], rows: [['B']] }];
  await importTrace(page, document);
  const first = await exported(page);
  expect(first.version).toBe(2);
  expect(first.dialect).toBe('sqlite');
  expect(first.mapping).toEqual(document.mapping);
  expect(first.inspection).toEqual(document.inspection);
  expect(first.schema).toEqual(document.schema);
  expect(first.schema[2].coverage).not.toHaveProperty('totalColumnCount');
  expect(first.notes).toEqual(document.notes);
  expect(first.results).toEqual(document.results);
  // Internal joins never reach the file.
  expect(Object.keys(first).sort()).toEqual(['dialect', 'format', 'generatedAt', 'inspection', 'mapping', 'notes', 'queries', 'results', 'schema', 'source', 'title', 'version']);
  await importTrace(page, { ...first, title: 'Round trip again' });
  const second = await exported(page);
  expect({ ...second, title: first.title }).toEqual(first);
});

test('malformed version 2 documents are refused with bounded messages, and the trace stays', async ({ page, studioURL }) => {
  await open(page, studioURL);
  await importTrace(page, mappedOrders('Kept through bad imports'));
  const hostile = '<img src=x onerror="window.__v2Injected=1">SECRET_NAME';
  const edit = change => { const value = mappedOrders('Refused'); change(value); return value; };
  const cases = [
    ['missing dialect', v => { delete v.dialect; }, 'is missing "dialect"'],
    ['bad dialect', v => { v.dialect = hostile; }, '"dialect" must be "sqlite" or "postgresql"'],
    ['missing mapping', v => { delete v.mapping; }, 'is missing "mapping"'],
    ['missing inspection', v => { delete v.inspection; }, 'is missing "inspection"'],
    ['missing notes', v => { delete v.notes; }, 'is missing "notes"'],
    ['unknown root', v => { v.extra = 1; }, 'unexpected field "extra"'],
    ['mapping is a list', v => { v.mapping = []; }, 'must be an object'],
    ['tables keyed by name', v => { v.mapping.tables = { orders: {} }; }, 'must be a list'],
    ['too many tables', v => { v.mapping.tables = Array(101).fill(v.mapping.tables[0]); }, 'the limit is 100'],
    ['unknown mapping field', v => { v.mapping.tables[0].sql = 'DROP'; }, 'unexpected field "sql"'],
    ['bad logical', v => { v.mapping.tables[0].logical = hostile; }, 'must be a simple logical name'],
    ['reserved logical', v => { v.mapping.tables[0].logical = '__rs_rows'; }, 'must be a simple logical name'],
    ['prototype logical', v => { v.mapping.tables[0].logical = '__proto__'; }, 'must be a simple logical name'],
    ['bad property', v => { v.mapping.tables[0].columns[0].logical = 'has space'; }, 'must be a simple logical name'],
    ['bad source', v => { v.mapping.tables[0].schemaSource = hostile; }, 'schemaSource must be one of'],
    ['bad policy', v => { v.mapping.tables[0].policy = 'verified'; }, 'policy must be one of'],
    ['bad scope', v => { v.inspection.scope = 'everything'; }, 'scope" must be one of'],
    ['duplicate logical', v => { v.mapping.tables[1].logical = 'orders'; }, 'repeats a registered table'],
    ['duplicate physical', v => { v.mapping.tables[1].physical = named('billing_main', 'tbl_orders'); }, 'repeats a stored table'],
    ['duplicate folded physical', v => { v.mapping.tables[1].physical = named('BILLING_MAIN', 'TBL_ORDERS'); }, 'repeats a stored table'],
    ['duplicate schema identity', v => { v.schema[1] = { ...v.schema[0] }; }, 'repeats a table already in this schema'],
    ['duplicate folded schema identity', v => { v.schema[1] = { ...v.schema[0], name: 'TBL_ORDERS', identity: named('billing_main', 'TBL_ORDERS') }; }, 'repeats a table already in this schema'],
    ['duplicate property', v => { v.mapping.tables[0].columns[1].logical = 'id'; }, 'repeats a property'],
    ['duplicate stored column', v => { v.mapping.tables[0].columns[1].physical = 'ORDER_ID'; }, 'repeats a stored column'],
    ['duplicate catalog column', v => { v.schema[0].columns[1].name = 'ORDER_ID'; }, 'repeats a column'],
    ['duplicate constraint', v => { v.schema[0].foreignKeys.push({ ...v.schema[0].foreignKeys[0] }); }, 'repeats a constraint'],
    ['name differs from identity', v => { v.schema[0].name = 'orders'; }, 'must equal its identity table'],
    ['registered count low', v => { v.inspection.registeredTables = 3; }, 'but the mapping accounts for 4'],
    ['registered count high', v => { v.inspection.registeredTables = 5; }, 'but the mapping accounts for 4'],
    ['mapping omitted count', v => { v.mapping.omittedTables = 1; }, 'but the mapping accounts for 5'],
    ['negative count', v => { v.mapping.omittedTables = -1; }, 'must be a whole number'],
    ['fractional count', v => { v.inspection.omittedTables = 0.5; }, 'must be a whole number'],
    ['text count', v => { v.inspection.omittedTables = '0'; }, 'must be a whole number'],
    ['count over limit', v => { v.inspection.omittedTables = 101; }, 'more than the limit'],
    ['snapshot beyond registrations', v => { v.inspection.omittedTables = 2; }, 'only 4 are registered'],
    ['unregistered in mapped scope', v => { v.schema[1] = observedTable(named('main', 'elsewhere'), [catalogColumn('id')]); }, 'is not registered'],
    ['partial columns in scope all', v => { v.inspection.scope = 'all'; }, 'an inspection of everything cannot produce'],
    ['width zero', v => { v.schema[0].foreignKeys[0].width = 0; }, 'must be a whole number that matches its 1 listed columns'],
    ['width too small', v => { v.schema[0].foreignKeys[0].columns.push({ column: 'order_id', target: 'name' }); }, 'matches its 2 listed columns'],
    ['width too large', v => { v.schema[0].foreignKeys[0].width = 2; }, 'matches its 1 listed columns'],
    ['width text', v => { v.schema[0].foreignKeys[0].width = '1'; }, 'matches its 1 listed columns'],
    ['empty components', v => { v.schema[0].foreignKeys[0].columns = []; v.schema[0].foreignKeys[0].width = 0; }, 'matches its 0 listed columns'],
    ['coverage value', v => { v.schema[0].coverage.columns = 'some'; }, 'coverage.columns must be one of'],
    ['coverage field', v => { v.schema[0].coverage.scope = 'mapped'; }, 'unexpected field "scope"'],
    ['total below listed', v => { v.schema[2].coverage.totalColumnCount = 1; }, 'contradicts the 2 listed columns'],
    ['complete but total differs', v => { v.schema[0].coverage.totalColumnCount = 9; }, 'contradicts the 2 listed columns'],
    ['total negative', v => { v.schema[2].coverage.totalColumnCount = -1; }, 'must be a whole number'],
    ['empty schema name', v => { v.mapping.tables[0].physical.schema = ''; }, 'must not be empty'],
    ['non-text table', v => { v.mapping.tables[0].physical.table = 7; }, 'must be text'],
    ['identity joined by a dot', v => { v.mapping.tables[0].physical = 'billing_main.tbl_orders'; }, 'must be an object'],
    ['identity extra field', v => { v.schema[0].identity.database = 'x'; }, 'unexpected field "database"'],
    ['NUL in name', v => { v.schema[0].columns[0].name = 'a\u0000b'; }, 'without a NUL character'],
    ['lone surrogate', v => { v.schema[0].columns[0].name = 'a\ud800b'; }, 'well-formed text'],
    ['over 4096 bytes', v => { v.mapping.tables[0].physical.table = 'é'.repeat(2049); }, 'is longer than 4,096 bytes'],
    ['over 4096 characters', v => { v.mapping.tables[0].physical.table = 'x'.repeat(4097); }, 'is longer than 4,096 bytes'],
    ['over 63 bytes on PostgreSQL', v => { v.dialect = 'postgresql'; v.mapping.tables[0].physical.table = '€'.repeat(22); }, 'is longer than 63 bytes'],
    ['null target table', v => { v.schema[0].foreignKeys[0].targetIdentity = null; }, 'must be an object'],
  ];
  for (const [name, change, message] of cases) {
    await test.step(name, async () => {
      await put(page, edit(change), 'bad.json');
      await expect(page.locator('#error-text')).toContainText(message);
      await expect(page.locator('#error-text')).toContainText('The previous trace is still shown');
      await expect(page.locator('#error-text')).not.toContainText('SECRET_NAME');
      await expect(page.locator('#loaded-title')).toHaveText('Kept through bad imports');
    });
  }
  // A reserved key inside a v2 section fails in the parser, before anything reads it.
  await put(page, JSON.stringify(mappedOrders()).replace('"mapping":{', '"mapping":{"__proto__":{"polluted":"yes"},'));
  await expect(page.locator('#error-text')).toContainText('reserved field name');
  expect(await page.evaluate(() => Object.prototype.polluted)).toBeUndefined();
  expect(await page.evaluate(() => window.__v2Injected)).toBeUndefined();
  await expect(page.locator('#workspace img')).toHaveCount(0);
});

test('a limit-sized name is accepted at exactly its byte bound on each database', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const atLimit = (dialect, name) => v2Document('Limit ' + dialect, { dialect, tables: [registration('edge', named('s', name), { id: name })], schema: [observedTable(named('s', name), [catalogColumn(name)])] });
  await importTrace(page, atLimit('postgresql', '€'.repeat(21))); // 63 UTF-8 bytes, 21 characters.
  await page.locator('#tab-schema').click();
  await expect(card(page, 'edge').locator('.stored-as')).toContainText('€'.repeat(21));
  await importTrace(page, atLimit('sqlite', 'é'.repeat(2048))); // 4,096 UTF-8 bytes.
  await page.locator('#tab-schema').click();
  await expect(card(page, 'edge').locator('.ident-length').first()).toHaveText('2,048 characters, shortened');
  await importTrace(page, atLimit('sqlite', 'x'.repeat(4096)));
  await page.locator('#tab-schema').click();
  await expect(card(page, 'edge').locator('.ident-length').first()).toHaveText('4,096 characters, shortened');
  await expect(card(page, 'edge').locator('.exact-summary')).toContainText('Exact characters');
  expect(await noOverflow(page)).toBe(true);
  const round = await exported(page);
  // Display shortening never touches the data.
  expect(round.mapping.tables[0].physical.table).toBe('x'.repeat(4096));
  expect(round.schema[0].columns[0].name).toBe('x'.repeat(4096));
});

test('hostile catalog text stays inert text, with hidden characters made visible', async ({ page, studioURL }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await open(page, studioURL);
  const after = requests.length;
  const markup = '<img src=x onerror="window.__nameInjected=1"><script>window.__nameInjected=1</script>';
  const tricky = [
    markup,
    'line\nbreak\ttab\rreturn',
    'a"."b',
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    '  padded  twice ',
    '\u202Egnp.exe',
    'zero\u200Bwidth',
    '\u0410ccount', // Begins with a Cyrillic letter that reads like Latin A.
    'written[U+000A]literally',
    '../../etc/passwd',
    'javascript:window.__nameInjected=1',
    "'; DROP TABLE orders; --",
    '{{7*7}}${7*7}',
  ];
  const columns = Object.fromEntries(tricky.map((name, index) => ['c' + index, name]));
  const document = v2Document(markup, {
    tables: [registration('hostile', named('__proto__', markup), columns), registration('protoTable', named('constructor', '__proto__'), { id: 'constructor' })],
    schema: [
      observedTable(named('__proto__', markup), tricky.map(name => catalogColumn(name, { type: markup })), {
        foreignKeys: [{ constraint: markup, width: 1, columns: [{ column: 'constructor', target: '__proto__' }], targetIdentity: named('constructor', '__proto__') }],
      }),
      observedTable(named('constructor', '__proto__'), [catalogColumn('constructor'), catalogColumn('__proto__')]),
    ],
    queries: [statement('hostile-read', 'hostile'), statement('proto-read', 'protoTable')],
  });
  await importTrace(page, document, '<b>name</b>.json');
  await page.locator('#tab-schema').click();
  const hostile = card(page, 'hostile');
  const stored = await hostile.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(stored).toEqual([
    `"<img src=x onerror=""window.__nameInjected=1""><script>window.__nameInjected=1</script>"`,
    '"line[U+000A]break[U+0009]tab[U+000D]return"',
    '"a"".""b"',
    '"__proto__"',
    '"constructor"',
    '"prototype"',
    '"toString"',
    '"  padded  twice "',
    '"[U+202E]gnp.exe"',
    '"zero[U+200B]width"',
    '"\u0410ccount"',
    '"written[U+000A]literally"',
    '"../../etc/passwd"',
    '"javascript:window.__nameInjected=1"',
    `"'; DROP TABLE orders; --"`,
    '"{{7*7}}${7*7}"',
  ]);
  // Spaces render, not only exist in the DOM.
  const padded = hostile.locator('tbody tr').nth(7).locator('td:nth-child(2) .ident');
  expect(await padded.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
  // A real newline and the literal words read the same as text, so the exact view separates them.
  const exact = hostile.locator('.exact');
  await expect(exact.locator('.exact-points')).toHaveCount(0);
  await exact.locator('summary').focus();
  await page.keyboard.press('Enter');
  const points = exact.locator('.exact-points');
  await expect(points.first()).toBeVisible();
  const allPoints = await points.allTextContents();
  expect(allPoints).toContain(Array.from('line\nbreak\ttab\rreturn').map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
  expect(allPoints).toContain(Array.from('written[U+000A]literally').map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
  expect(allPoints.some(value => value.startsWith('U+0410 U+0063'))).toBe(true);
  await expect(exact.locator('.exact-list')).toHaveAttribute('tabindex', '0');

  // Prototype-like names join like any other name, and don't reach any object.
  const proto = card(page, 'protoTable');
  await expect(proto.locator('.stored-as')).toContainText('"constructor"."__proto__"');
  await expect(proto.getByRole('button', { name: 'Show 1 statement', exact: true })).toBeEnabled();
  await expect(proto).toContainText('Referenced by');
  await expect(page.locator('#relationships .tag')).toHaveCount(0);
  await page.locator('#tab-queries').click();
  await rowAt(page, 1).click();
  await expect(page.locator('.fact-stored')).toContainText('"constructor"."__proto__"');

  expect(await page.evaluate(() => window.__nameInjected === undefined && Object.prototype.polluted === undefined && ({}).schema === undefined)).toBe(true);
  await expect(page.locator('#workspace img, #workspace script, #workspace a, #workspace iframe, #workspace [onerror], #workspace [style]')).toHaveCount(0);
  expect(requests.slice(after).filter(url => !url.endsWith('/api/demo'))).toEqual([]);
  const round = await exported(page);
  expect(round.mapping).toEqual(document.mapping);
  expect(round.schema).toEqual(document.schema);

  // Clear removes every name, including the lazily built exact view.
  await page.locator('#tab-schema').click();
  await page.locator('#clear-trace').click();
  expect(await page.evaluate(() => document.body.textContent.includes('__nameInjected'))).toBe(false);
  expect(await page.evaluate(() => document.body.textContent.includes('U+202E'))).toBe(false);
});

test('a maximum-size v2 schema stays bounded and usable', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const columnsOf = table => Array.from({ length: 100 }, (_, c) => 'long_column_' + String(table).padStart(3, '0') + '_' + String(c).padStart(3, '0') + '_' + 'x'.repeat(20));
  const tables = [];
  const schema = [];
  for (let t = 0; t < 100; t++) {
    const names = columnsOf(t);
    const identity = named('main', 'table_' + t);
    tables.push(registration('table_' + t, identity, Object.fromEntries(names.map((name, c) => ['p' + c, name]))));
    schema.push(observedTable(identity, names.map(name => catalogColumn(name)), { foreignKeys: [{ constraint: '0', width: 2, columns: [{ column: names[0], target: 'id' }, { column: names[1], target: null }], targetIdentity: named('main', 'table_' + ((t + 1) % 100)) }] }));
  }
  const document = v2Document('Large', { tables, schema });
  expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(2 * 1024 * 1024);
  await importTrace(page, document);
  await page.locator('#tab-schema').click();
  await expect(page.locator('.table-card')).toHaveCount(100);
  await expect(page.locator('#relationships .relationship')).toHaveCount(100);
  await expect(page.locator('#tab-count-schema')).toHaveText('100');
  expect(await noOverflow(page)).toBe(true);
  const over = structuredClone(document);
  over.mapping.tables[0].columns.push({ logical: 'p100', physical: 'one_too_many' });
  await put(page, over, 'over.json');
  await expect(page.locator('#error-text')).toContainText('has 101 items, the limit is 100');
  await expect(page.locator('#loaded-title')).toHaveText('Large');
});

for (const [label, width, height] of [['desktop', 1440, 1000], ['narrow', 390, 844], ['tiny', 320, 640]]) {
  test(`v2 schema fits ${label} screens with long, hostile names and stays keyboard usable`, async ({ page, studioURL }) => {
    await page.setViewportSize({ width, height });
    await open(page, studioURL);
    const long = 'stored_' + 'long_name_without_spaces_'.repeat(160);
    const document = mappedOrders('Layout ' + 'wide_title_'.repeat(30));
    document.mapping.tables[0].physical = named(long.slice(0, 300), long);
    document.mapping.tables[0].columns[0].physical = long;
    document.schema[0].identity = document.mapping.tables[0].physical;
    document.schema[0].name = long;
    document.schema[0].columns[0].name = long;
    document.schema[0].columns[1].type = 'numeric_' + 'x'.repeat(600);
    document.schema[1].columns[1].name = 'gap and "quote" and\nnewline';
    document.mapping.tables[1].columns[1].physical = 'gap and "quote" and\nnewline';
    document.schema[0].foreignKeys[0].columns[0] = { column: long, target: long };
    await put(page, document);
    await expect(page.locator('#loaded-title')).toContainText('Layout');
    await expect(page.locator('#error')).toBeHidden();
    await rowAt(page, 0).click();
    await expect(page.locator('.fact-stored')).toContainText('shortened');
    expect(await noOverflow(page)).toBe(true);
    await page.locator('#tab-schema').click();
    expect(await noOverflow(page)).toBe(true);
    const orders = card(page, 'orders');
    await expect(orders.locator('.ident-length').first()).toContainText('characters, shortened');
    const cardFits = await page.locator('.table-card').evaluateAll(cards => cards.every(node => node.scrollWidth <= node.clientWidth + 1));
    expect(cardFits).toBe(true);
    const summary = orders.locator('.exact-summary');
    // Arrive by keyboard, so the focus ring reflects keyboard use rather than the earlier click.
    await summary.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    expect(await summary.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(orders.locator('.exact-list')).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    if (width < 860) {
      // The row layout changes, but each cell keeps its label and table role.
      const cell = orders.locator('tbody tr').first().locator('td').nth(1);
      expect(await cell.getAttribute('data-label')).toBe('Stored column');
      expect(await cell.getAttribute('role')).toBe('cell');
      expect(await orders.locator('table').getAttribute('role')).toBe('table');
      await expect(page.getByRole('columnheader', { name: 'Stored column' }).first()).toBeAttached();
      const box = await summary.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
    await page.locator('#tab-about').click();
    expect(await noOverflow(page)).toBe(true);
  });
}

test('writer: a real mapped SQLite trace reads back through the mapping', async ({ page, studioURL }) => {
  const parents = defineTable('parents', { id: column.integer().primaryKey().storedAs('parent_id') }, { storage: { table: 'stored parents' } });
  const children = defineTable('children', {
    id: column.integer().primaryKey(),
    parentId: column.integer().references(parents, 'id').storedAs('parent.ref'),
  });
  const db = openDatabase(':memory:', { tables: [parents, children] });
  let document;
  try {
    db.ensureSchema();
    db.table(parents).insert({ id: 1 });
    db.table(children).insert({ id: 1, parentId: 1 });
    db.table(parents).findMany();
    document = db.exportTrace({ title: 'Real mapped trace' });
  } finally { db.close(); }
  expect(document.version).toBe(2);
  await open(page, studioURL);
  await importTrace(page, document);
  await page.locator('#tab-schema').click();
  await expect(page.locator('#schema-coverage')).toContainText('Mapped tables only');
  const parentCard = card(page, 'parents');
  await expect(parentCard.locator('.stored-as')).toContainText('"main"."stored parents"');
  await expect(parentCard.locator('tbody tr').first().locator('td').nth(1)).toHaveText('"parent_id"');
  await expect(parentCard.getByRole('button', { name: /^Show \d+ statements?$/ })).toBeEnabled();
  await expect(page.locator('#relationships .rel-pair')).toHaveText('"parent.ref" to "parent_id"');
  await expect(page.locator('#relationships .rel-head')).toContainText('"main"."children" references "main"."stored parents"');
  const round = await exported(page);
  expect(round.mapping).toEqual(document.mapping);
  expect(round.inspection).toEqual(document.inspection);
  expect(round.schema).toEqual(document.schema);
});

test('writer: the fictional demo shows identity and mapped tables, and keeps its behavior', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const demo = await (await page.request.get(studioURL + '/api/demo')).json();
  expect(demo.version).toBe(2);
  expect(demo.source).toBe('fictional-demo');
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#loaded-kind')).toHaveText('Fictional demo');
  await page.locator('#tab-schema').click();
  await expect(card(page, 'authors').locator('.stored-as')).toContainText('Stored under the same name, in "main"');
  const labels = card(page, 'labels');
  await expect(labels.locator('.stored-as')).toContainText('"main"."notebook_labels"');
  await expect(labels).toContainText('Declared policy: subset');
  await expect(labels.locator('.coverage-line')).toContainText('Mapped and key columns only');
  await expect(labels.locator('tbody tr').first().locator('td').nth(1)).toHaveText('"label_id"');
  await labels.getByRole('button', { name: /^Show \d+ statements?$/ }).click();
  await expect(page.locator('#table-filter-name')).toHaveText('labels');
  await expect(page.locator('.fact-stored')).toContainText('"main"."notebook_labels"');
  await page.locator('#tab-results').click();
  await expect(page.locator('#results')).toContainText('Avery Lee');
  expect(demo.results[0].rows).toHaveLength(3);
});

test('the PostgreSQL view fits a phone, and stays usable from the keyboard', async ({ page, studioURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, studioURL);
  await importTrace(page, { ...pgTrace([{ sql: PG_BEGIN }, pgWrite(), { sql: 'COMMIT', status: 'error' }, { sql: 'BEGIN READ ONLY', transactionId: 'tx-two' }, pgRead({ transactionId: 'tx-two' }), { sql: 'ROLLBACK', transactionId: 'tx-two' }]), title: 'A long fictional PostgreSQL trace title that has to wrap on a phone' });
  await expect(page.locator('#loaded-dialect')).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await rowAt(page, 1).click();
  await expect(page.locator('#detail-title')).toBeFocused();
  await expect(page.locator('.fact-effect')).toContainText('Unknown from this trace');
  await expect(page.locator('#detail-body .sql .slot')).toHaveText(['$1', '$2']);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = rowAt(page, 0);
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(rowAt(page, 1)).toBeFocused();
  await expect(rowAt(page, 1)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('#detail-body .sql')).toHaveText('ROLLBACK');
});
