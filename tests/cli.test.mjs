import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
const cleanup = directory => {
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  assert.match(basename(directory), /^rowstitch-(?:cli|schema)-/);
  rmSync(directory, { recursive: true, force: true });
};

test('CLI help and version work without starting the inspector', () => {
  for (const args of [[], ['--help'], ['--version']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0\.1\.1/);
    assert.doesNotMatch(result.stdout, /http:\/\/127\.0\.0\.1:/);
  }
});

test('CLI rejects malformed commands, ports and absent database paths without creating files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-cli-'));
  try {
    const missing = join(directory, 'not-created.sqlite');
    for (const args of [['unknown'], ['demo', '--port', '65536'], ['demo', '--port', '-1'], ['demo', '--port', '2junk'], ['schema'], ['schema', missing]]) {
      const result = run(args);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /^Rowstitch:/);
      assert.doesNotMatch(result.stderr, /at main|node:internal/);
      assert.ok(!result.stderr.includes(directory));
    }
    assert.equal(existsSync(missing), false);
  } finally { cleanup(directory); }
});

test('schema command inspects a named database read-only without changing its bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rowstitch-schema-'));
  const file = join(directory, 'a database.sqlite');
  try {
    const db = new DatabaseSync(file, { defensive: true });
    db.exec('CREATE TABLE authors(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE books(id INTEGER PRIMARY KEY, authorId INTEGER REFERENCES authors(id), title TEXT); INSERT INTO authors VALUES(1,\'Fictional author\');');
    db.close();
    const before = readFileSync(file);
    const result = run(['schema', file]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(JSON.stringify(report), /authors/);
    assert.match(JSON.stringify(report), /books/);
    assert.doesNotMatch(result.stdout, /Fictional author/);
    assert.deepEqual(readFileSync(file), before);
  } finally { cleanup(directory); }
});

test('demo serves an actual in-memory ORM trace and fictional results', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [cli, 'demo', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI startup timed out: ' + stderr)), 8000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('CLI exited ' + code + ': ' + stderr)); });
    });
    const response = await fetch(origin + '/api/demo');
    assert.equal(response.status, 200);
    const demo = await response.json();
    assert.equal(demo.format, 'rowstitch-trace');
    assert.equal(demo.version, 1);
    assert.equal(demo.source, 'fictional-demo');
    assert.ok(demo.schema.some(table => table.name === 'authors'));
    assert.ok(demo.schema.some(table => table.name === 'posts'));
    assert.ok(demo.queries.some(query => query.operation === 'select'));
    assert.ok(demo.queries.every(query => query.parameters.every(value => value === '[redacted]')));
    assert.equal(demo.results[0].rows.length, 3);
    assert.equal(demo.results[0].rows[0][0], 'Avery Lee');
    assert.equal(demo.results[0].rows[0][2], 2);
    assert.ok(demo.notes.some(note => note.includes('rejected')));
    assert.equal((await fetch(origin + '/api/query')).status, 404);
    assert.equal((await fetch(origin + '/api/demo?sql=DROP%20TABLE%20authors')).status, 400);
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  }
});
