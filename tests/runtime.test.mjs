import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { supportedNode, NODE_REQUIREMENT } from '../dist/runtime.js';

test('supported runtimes are maintained stable LTS lines, not every newer major', () => {
  for (const version of ['24.22.2', '24.22.3', '24.23.0', '26.13.0', '26.13.1', '26.14.0']) assert.equal(supportedNode(version), true, version);
  for (const version of ['22.22.0', '24.22.1', '25.9.0', '26.12.99', '27.0.0', '26.13.0-rc.1', '26.13.0+custom', '026.13.0', '26.13', '26.13.0\n', '26.99999999999999999999.0']) assert.equal(supportedNode(version), false, version);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.engines.node, '^24.22.2 || ^26.13.0');
});

test('CLI refuses unsupported runtimes before opening a file or starting a server', () => {
  const cli = new URL('../dist/cli.js', import.meta.url).href;
  for (const version of ['24.22.1', '26.12.1', '26.13.0-rc.1', '27.0.0']) {
    const script = `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}}); process.argv=[process.execPath,${JSON.stringify(fileURLToPath(cli))},'demo','--port','0']; await import(${JSON.stringify(cli)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(NODE_REQUIREMENT));
  }
});
