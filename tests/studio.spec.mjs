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
  const namedRound = await exported(page);
  expect(namedRound.dialect).toBe('sqlite');
  expect(Object.keys(namedRound).indexOf('dialect')).toBe(Object.keys(namedRound).indexOf('source') + 1);
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
