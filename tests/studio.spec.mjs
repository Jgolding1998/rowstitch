import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('export is explicit, preserves loaded values and uses an application filename', async ({ page, studioURL }) => {
  await open(page, studioURL);
  const document = trace('Exported synthetic trace');
  await importTrace(page, document, 'private-source-name.json');
  const pending = page.waitForEvent('download');
  await page.locator('#export-trace').click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^rowstitch-trace-\d+\.json$/);
  expect(download.suggestedFilename()).not.toContain('private-source-name');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.title).toBe(document.title);
  expect(exported.queries[0].parameters).toEqual(document.queries[0].parameters);
  expect(exported.queries[0].sql).toBe(document.queries[0].sql);
  expect(exported.results).toEqual(document.results);
  await expect(page.locator('#status')).toContainText('including any values that were not redacted');
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
