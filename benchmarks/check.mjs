// Run the local comparison fixtures in CI without installing reference libraries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['compare.mjs', 'expressions.mjs', 'columns.mjs']) {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(run.status, 0, name + ' failed: ' + (run.error?.message ?? run.stderr));
  const report = JSON.parse(run.stdout);
  assert.equal(report.summary.failed, 0, name + ' reported failed cases');
  assert.ok(report.summary.passed > 0, name + ' did not run any cases');
  console.log(name + ': ' + report.summary.passed + ' passed');
}
