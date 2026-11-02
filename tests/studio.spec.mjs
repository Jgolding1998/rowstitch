import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

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
