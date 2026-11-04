/**
 * Internal worker entry owning one PGlite instance. WASM execution blocks this thread, not the host's event loop.
 * A reply says only what this worker saw: a success, or one ErrorResponse that ReadyForQuery followed on a live instance.
 * It carries no message text, values or stacks. Anything else ends the worker, and the host treats that as an unknown outcome.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extendedStatement, readExchange, type PgliteOutcome, type PgliteSerializer } from './pglite-protocol.js';

if (isMainThread || !parentPort) throw new Error('This module is an internal PGlite worker entry.');
const port = parentPort;
const stop = (): never => process.exit(1);
const { moduleUrl, dataDir } = workerData as { moduleUrl: string; dataDir: string | null };

// The parts of PGlite 0.5.15 this worker uses, stated here so its types never reach emitted declarations. The version guard pins them.
interface PgliteInstance {
  readonly closed: boolean;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  execProtocol(bytes: Uint8Array, options: { throwOnError: false; syncToFs: true }): Promise<{ readonly messages: readonly { readonly name?: unknown; readonly status?: unknown }[] }>;
  close(): Promise<void>;
}
interface PgliteModule { readonly PGlite: { create(dataDir?: string): Promise<PgliteInstance> }; readonly protocol: { readonly serialize: PgliteSerializer } }
let db: PgliteInstance, serialize: PgliteSerializer;
const exchange = async (bytes: Uint8Array): Promise<PgliteOutcome> => {
  const { messages } = await db.runExclusive(() => db.execProtocol(bytes, { throwOnError: false, syncToFs: true }));
  return readExchange(messages);
};
const openingStatus = async (): Promise<unknown> => {
  // The opening status also comes from the engine: a Sync alone is answered by ReadyForQuery alone.
  const { messages } = await db.runExclusive(() => db.execProtocol(new Uint8Array(serialize.sync()), { throwOnError: false, syncToFs: true }));
  if (messages.length !== 1 || messages[0]!.name !== 'readyForQuery') throw new Error('No opening status');
  return messages[0]!.status;
};

let lastId = 0, busy = false;
async function handle(packet: Record<string, unknown>): Promise<void> {
  const id = packet.id as number;
  if (packet.op === 'close') {
    await db.close();
    port.postMessage({ protocol: 1, kind: 'closed', id });
    return;
  }
  if (packet.op !== 'query' || typeof packet.sql !== 'string' || !Array.isArray(packet.parameters)) throw new Error('Invalid request');
  const outcome = await exchange(extendedStatement(serialize, packet.sql, packet.parameters as (string | null)[]));
  if (outcome.error) {
    const sqlstate = outcome.error.code;
    if (typeof sqlstate !== 'string' || db.closed) throw new Error('Not an ordinary rejection');
    port.postMessage({ protocol: 1, kind: 'rejected', id, status: outcome.status, sqlstate, afterCommandComplete: outcome.afterCommandComplete === true });
    return;
  }
  port.postMessage({ protocol: 1, kind: 'result', id, status: outcome.status, result: outcome.result });
}

try {
  const loaded = await import(moduleUrl) as Partial<PgliteModule>;
  if (typeof loaded.PGlite?.create !== 'function' || typeof loaded.protocol?.serialize?.sync !== 'function') throw new Error('Unexpected module');
  serialize = loaded.protocol.serialize;
  db = await loaded.PGlite.create(dataDir ?? undefined);
  const set = await exchange(extendedStatement(serialize, 'SET extra_float_digits = 3', []));
  if (set.error || set.status !== 'I') throw new Error('Settings not applied');
  port.postMessage({ protocol: 1, kind: 'ready', status: await openingStatus() });
} catch {
  try { port.postMessage({ protocol: 1, kind: 'open-error' }); } catch { /* The host also sees this worker exit. */ }
  stop();
}
port.on('message', (request: unknown) => {
  const packet = request as Record<string, unknown> | null;
  if (!packet || typeof packet !== 'object' || packet.protocol !== 1 || !Number.isSafeInteger(packet.id) || (packet.id as number) <= lastId || busy) stop();
  lastId = packet!.id as number; busy = true;
  handle(packet!).then(() => { busy = false; if (packet!.op === 'close') port.close(); }, stop);
});
