import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openSqliteExecutor } from './sqlite-executor.js';
import { databaseError } from './errors.js';
import type { SyncExecutor } from './executor.js';
import type { Parameter } from './schema.js';

if (isMainThread || !parentPort) throw new Error('This module is an internal SQLite worker entry.');
const port = parentPort;
let executor: SyncExecutor | undefined;
try {
  executor = openSqliteExecutor(workerData.filename, { readOnly: workerData.readOnly, busyTimeoutMs: workerData.busyTimeoutMs });
  port.postMessage({ protocol: 1, kind: 'ready' });
} catch {
  port.postMessage({ protocol: 1, kind: 'open-error' });
  port.close();
}
let lastId = 0;
const connection = executor;
if (connection) port.on('message', (request: unknown) => {
  if (!request || typeof request !== 'object') { port.close(); return; }
  const packet = request as Record<string, unknown>;
  if (packet.protocol !== 1 || !Number.isSafeInteger(packet.id) || (packet.id as number) <= lastId || typeof packet.op !== 'string') { port.close(); return; }
  const id = packet.id;
  lastId = id as number;
  let value: unknown;
  try {
    switch (packet.op) {
      case 'all':
        if (typeof packet.sql !== 'string' || !packet.sql.length || !Array.isArray(packet.parameters)) throw new Error('invalid query');
        value = connection.all(packet.sql, packet.parameters as Parameter[]); break;
      case 'exec':
        if (typeof packet.sql !== 'string' || !packet.sql.length) throw new Error('invalid control');
        connection.exec(packet.sql); break;
      case 'state': value = connection.inTransaction(); break;
      case 'close': connection.close(); break;
      default: throw new Error('invalid operation');
    }
  } catch (error) {
    // The worker sends only a safe code from an actual engine response. Never send paths, values or driver stacks.
    const mapped = databaseError(error);
    port.postMessage({ protocol: 1, kind: 'result', id, ok: false, code: mapped.code });
    return;
  }
  // Delivery/serialization failure is transport loss after possible effects, never an engine rejection.
  try { port.postMessage({ protocol: 1, kind: 'result', id, ok: true, value }); }
  catch { port.close(); return; }
  if (packet.op === 'close') port.close();
});
