#!/usr/bin/env node
import { once } from 'node:events';

const help = `Rowstitch 0.1.1

Usage:
  rowstitch demo [--port 4317]   Open a local, read-only SQL inspector with fictional data
  rowstitch schema <file>       Print an existing SQLite database's schema as JSON
  rowstitch --help              Show these instructions
  rowstitch --version           Show the version

Requires Node 24.22.2 or a newer Node 24 LTS release.
The inspector imports trace JSON in browser memory; it never runs imported SQL.
The schema command opens only the file you name, read-only. Its output can reveal
schema names and default values. Review it before sharing.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (command === '--version') {
    if (rest.length) throw new Error('Use rowstitch --version without extra arguments.');
    process.stdout.write('0.1.1\n'); return;
  }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor! < 22 || minor === 22 && patch! < 2) {
    throw new Error('Use Node 24.22.2 or a newer Node 24 LTS release.');
  }
  if (command === 'schema') {
    if (rest.length !== 1 || rest[0]!.startsWith('-') || rest[0] === ':memory:') {
      throw new Error('Usage: rowstitch schema <existing SQLite file>');
    }
    const { statSync } = await import('node:fs');
    const file = rest[0]!;
    try { if (!statSync(file).isFile()) throw new Error(); }
    catch { throw new Error('Choose an existing, readable SQLite database file.'); }
    const { openDatabase } = await import('./index.js');
    const db = openDatabase(file, { readOnly: true });
    try { process.stdout.write(JSON.stringify(db.inspectSchema(), null, 2) + '\n'); }
    finally { db.close(); }
    return;
  }
  if (command !== 'demo') throw new Error('Unknown command. Run rowstitch --help.');
  let port = 4317;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--port' || !/^\d{1,5}$/.test(rest[1]!)) {
      throw new Error('Usage: rowstitch demo [--port 4317]');
    }
    port = Number(rest[1]);
    if (port > 65535) throw new Error('Choose a port from 0 through 65535.');
  }
  const [{ startStudio }, { buildDemo }] = await Promise.all([import('./server.js'), import('./demo.js')]);
  const server = await startStudio({ port, getDemo: buildDemo });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The local inspector could not start.');
  process.stdout.write(`Rowstitch: http://127.0.0.1:${address.port}\nFictional demo. Press Ctrl+C to stop.\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 3000);
    timer.unref();
    server.once('close', () => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// This module is the package's executable entry point.
main().catch(error => {
  const safeCodes: Record<string, string> = { EADDRINUSE: 'That port is already in use. Try --port 4318.', EACCES: 'That port or file is not accessible.' };
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const known = error instanceof Error && !code ? error.message : safeCodes[code];
  process.stderr.write(`Rowstitch: ${known || 'The operation could not finish. Check the input and try again.'}\n`);
  process.exitCode = 1;
});
