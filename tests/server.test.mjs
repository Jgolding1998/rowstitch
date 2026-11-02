import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

async function fixture(t, getDemo = () => ({ format: 'rowstitch-trace', version: 1, source: 'fictional-demo' })) {
  const root = await mkdtemp(join(tmpdir(), 'rowstitch-server-'));
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'studio'));
  await copyFile(new URL('../dist/server.js', import.meta.url), join(root, 'dist', 'server.mjs'));
  for (const [name, text] of Object.entries({ 'index.html': '<!doctype html><title>Fictional Studio</title>', 'app.js': '/* local test fixture */', 'styles.css': 'body { color: black; }', 'mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })) {
    await writeFile(join(root, 'studio', name), text);
  }
  const { startStudio } = await import(pathToFileURL(join(root, 'dist', 'server.mjs')).href);
  const server = startStudio({ port: 0, getDemo });
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('rowstitch-server-'));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, startStudio, origin, port: address.port, root };
}

function request(origin, options = {}, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (body !== undefined && headers['Content-Length'] === undefined && headers['Transfer-Encoding'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = httpRequest(origin, { timeout: 3_000, ...options, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Test request timed out')));
    req.end(body);
  });
}

function wire(port, raw, { timeout = 2_000, allowReset = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString());
    socket.setTimeout(timeout, () => socket.destroy(new Error('Raw HTTP test timed out')));
    socket.on('connect', () => socket.write(raw));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', done);
    socket.on('error', error => allowReset && ['ECONNRESET', 'ECONNABORTED'].includes(error.code) ? done() : reject(error));
    socket.on('close', () => { if (!chunks.length && allowReset) done(); });
  });
}

function policy(headers) {
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.ok(headers['content-security-policy'].includes("frame-ancestors 'none'"));
  assert.ok(headers['content-security-policy'].includes("script-src 'self'"));
  assert.ok(!headers['content-security-policy'].includes("'unsafe-inline'"));
  assert.equal(headers['access-control-allow-origin'], undefined);
  assert.equal(headers['set-cookie'], undefined);
}

test('Studio binds loopback and serves only four fixed assets plus fictional JSON', async t => {
  const { server, origin } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  for (const path of ['/', '/app.js', '/styles.css', '/mark.svg', '/api/demo']) {
    const response = await request(origin + path);
    assert.equal(response.status, 200, path);
    policy(response.headers);
  }
  assert.equal(JSON.parse((await request(origin + '/api/demo')).text).source, 'fictional-demo');
  const get = await request(origin + '/');
  const head = await request(origin + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
});

test('Studio rejects unsupported methods and never exposes database, SQL or filesystem APIs', async t => {
  let calls = 0;
  const { origin } = await fixture(t, () => { calls++; return { source: 'fictional-demo' }; });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(origin + '/api/demo', { method }, 'untrusted synthetic input');
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
    policy(response.headers);
  }
  for (const path of ['/README.md', '/package.json', '/.git/config', '/src/server.ts', '/api/sql', '/api/database', '/api/files', '/constructor', '/__proto__']) {
    const response = await request(origin + path);
    assert.equal(response.status, 404, path);
    policy(response.headers);
  }
  assert.equal(calls, 0);
});

test('Studio requires the exact local host and same-origin browser context', async t => {
  let calls = 0;
  const { origin, port } = await fixture(t, () => { calls++; return { source: 'fictional-demo' }; });
  const bad = [
    { Host: 'outside.example' }, { Host: '127.0.0.1:1' }, { Host: `127.0.0.1:${port}.outside.example` },
    { Origin: 'null' }, { Origin: 'https://outside.example' }, { Origin: `http://localhost:${port}` },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ];
  for (const headers of bad) {
    const response = await request(origin + '/api/demo', { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    policy(response.headers);
  }
  assert.equal(calls, 0);
  assert.equal((await request(origin + '/api/demo', { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await request(origin + '/api/demo', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
});

test('raw duplicate headers, framing, proxy targets and encoded paths fail closed', async t => {
  let calls = 0;
  const { port } = await fixture(t, () => { calls++; return {}; });
  const host = `Host: 127.0.0.1:${port}\r\n`;
  const cases = [
    ['GET /api/demo HTTP/1.1\r\n' + host + host + '\r\n', 403],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Origin: null\r\nOrigin: null\r\n\r\n', 403],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Content-Length: 1\r\n\r\nx', 400],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 400],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Content-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 400],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Content-Length: 0\r\nContent-Length: 0\r\n\r\n', 400],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'Expect: 100-continue\r\n\r\n', 400],
    ['GET http://outside.example/api/demo HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET //api/demo HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET /%2e%2e/package.json HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET /api\\demo HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET /api/demo?sql=SELECT+1 HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET /api/demo?path=sample.db HTTP/1.1\r\n' + host + '\r\n', 400],
    ['GET /api/demo HTTP/1.1\r\n' + host + 'X-Fill: ' + 'x'.repeat(9000) + '\r\n\r\n', 431],
  ];
  for (const [raw, expected] of cases) {
    const response = await wire(port, raw);
    assert.match(response, new RegExp('^HTTP/1\\.[01] ' + expected));
    assert.ok(response.toLowerCase().includes('x-content-type-options: nosniff'));
    assert.ok(response.includes("frame-ancestors 'none'"));
    assert.ok(!response.includes('100 Continue'));
  }
  assert.equal(calls, 0);
});

test('too many headers, CONNECT and upgrades do not open another transport', async t => {
  const { port } = await fixture(t);
  const host = `Host: 127.0.0.1:${port}\r\n`;
  const many = Array.from({ length: 51 }, (_, i) => `X-${i}: a\r\n`).join('');
  assert.match(await wire(port, 'GET /api/demo HTTP/1.1\r\n' + host + many + '\r\n'), /^HTTP\/1\.1 431/);
  assert.match(await wire(port, 'CONNECT outside.example:80 HTTP/1.1\r\n' + host + '\r\n'), /^HTTP\/1\.1 405/);
  assert.match(await wire(port, 'GET / HTTP/1.1\r\n' + host + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /^HTTP\/1\.1 400/);
});

test('pipelined or malformed trailing requests never append another response or call', async t => {
  let calls = 0;
  const { port } = await fixture(t, () => { calls++; return {}; });
  const first = `GET /api/demo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
  for (const tail of ['invalid trailing bytes', first]) {
    const response = await wire(port, first + tail);
    assert.match(response, /^HTTP\/1\.1 200/);
    assert.equal((response.match(/HTTP\/1\.1 /g) ?? []).length, 1);
  }
  assert.equal(calls, 2);
});

test('provider failures, non-JSON values and oversized demo documents are safe errors', async t => {
  const marker = 'SYNTHETIC_PRIVATE_ERROR_MARKER';
  for (const provider of [() => { throw new Error(marker); }, () => undefined, () => 1n, () => ({ text: 'x'.repeat(2 * 1024 * 1024) }), () => Promise.resolve({ text: marker }), () => Promise.reject(new Error(marker))]) {
    const { origin } = await fixture(t, provider);
    const response = await request(origin + '/api/demo');
    assert.equal(response.status, 500);
    assert.ok(!response.text.includes(marker));
    assert.ok(!response.text.includes('server.ts'));
    policy(response.headers);
  }
});

test('oversized static assets are refused and a disconnected client does not poison the server', async t => {
  const { origin, root, port } = await fixture(t);
  await writeFile(join(root, 'studio', 'app.js'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await request(origin + '/app.js')).status, 500);
  await new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.write(`GET /api/demo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      socket.destroy();
      resolve();
    });
    socket.on('error', resolve);
  });
  assert.equal((await request(origin + '/api/demo')).status, 200);
});

test('slow headers have an absolute bounded lifetime and leave Studio usable', { timeout: 8_000 }, async t => {
  const { port, origin } = await fixture(t);
  const started = performance.now();
  const result = await wire(port, 'GET /api/demo HTTP/1.1\r\nHost: ', { timeout: 6_500, allowReset: true });
  assert.ok(result === '' || /^HTTP\/1\.1 408/.test(result));
  assert.ok(performance.now() - started < 6_000);
  assert.equal((await request(origin + '/api/demo')).status, 200);
});

test('invalid Studio ports and providers are rejected before opening a listener', async t => {
  const { startStudio } = await fixture(t);
  for (const port of [-1, 65536, 1.5, NaN, Infinity, '8127']) {
    assert.throws(() => startStudio({ port, getDemo: () => ({}) }), /port/);
  }
  assert.throws(() => startStudio({ port: 0, getDemo: null }), /provider/);
});
