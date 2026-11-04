/**
 * Internal PGlite worker host. Not exported from any package entry. The public adapter always selects private memory.
 * Persistent files and shared directories are not supported by the public API.
 */
import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { RowstitchError } from '../core/errors.js';
import type { AsyncExecutor } from '../core/executor.js';
import { createPostgresExecutor, type PostgresErrorVerdict, type PostgresTransport, type PostgresTransportResult } from '../core/postgres-executor.js';
import type { PostgresRawResult } from '../core/postgres-result.js';
import type { Parameter } from '../core/schema.js';
import { boundedText, closingOnDeadline, confirmSettings, invalidOptions, openFailed, openTimedOut, wireParameters, type Status } from './shared.js';

const STATES: readonly unknown[] = Object.freeze(['I', 'T', 'E']);
function exact(packet: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(packet);
  return own.length === keys.length && keys.every(key => Object.hasOwn(packet, key));
}
class EngineRejection extends Error {}
interface Pending { id: number; kind: 'query' | 'close'; resolve(value: unknown): void; reject(error: unknown): void }

function hostPgliteWorker(moduleUrl: string, dataDir: string | null, openTimeoutMs: number, onOpen: (transport: PostgresTransport & { forceClose(): void }) => void): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    let worker: Worker;
    try {
      // An empty environment and captured output: nothing ambient reaches the engine, and nothing it prints reaches the host's logs.
      worker = new Worker(new URL('./pglite-worker.js', import.meta.url), { execArgv: [], env: {}, stdout: true, stderr: true, workerData: { moduleUrl, dataDir } });
      worker.stdout.resume(); worker.stderr.resume();
    } catch { rejectOpen(openFailed()); return; }
    let sequence = 0, lost = false, ready = false, closing: Promise<void> | undefined, status: Status | undefined;
    let current: Pending | undefined;
    const ordinary = new WeakMap<object, PostgresErrorVerdict>();
    const terminate = (): Promise<unknown> => worker.terminate();
    const lose = (failure: RowstitchError = openFailed()): void => {
      if (lost) return;
      lost = true; clearTimeout(startup);
      if (!ready) rejectOpen(failure);
      const pending = current; current = undefined;
      pending?.reject(new Error('Worker lost'));
      terminate().catch(() => { /* Already abandoned. */ });
    };
    const startup = setTimeout(() => lose(openTimedOut()), openTimeoutMs);
    const send = (kind: 'query' | 'close', data: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
      if (lost || current) { lose(); reject(new Error('Unavailable worker')); return; }
      const id = ++sequence;
      current = { id, kind, resolve, reject };
      // Failure to deliver is loss, never a rejection by the engine.
      try { worker.postMessage({ protocol: 1, id, op: kind, ...data }); } catch { lose(); }
    });
    worker.on('error', () => lose());
    worker.on('messageerror', () => lose());
    worker.on('exit', () => lose());
    worker.on('message', (message: unknown) => {
      if (lost) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)) { lose(); return; }
      const packet = message as Record<string, unknown>;
      if (packet.protocol !== 1) { lose(); return; }
      if (!ready) {
        if (packet.kind === 'ready' && exact(packet, ['protocol', 'kind', 'status']) && packet.status === 'I') {
          ready = true; clearTimeout(startup); status = 'I';
          onOpen(transport); resolveOpen();
          return;
        }
        lose(); return;
      }
      // Replies answer the one request in flight, once. A stale, repeated or unsolicited reply ends this worker.
      if (!current || packet.id !== current.id) { lose(); return; }
      const entry = current;
      if (packet.kind === 'closed' && entry.kind === 'close' && exact(packet, ['protocol', 'kind', 'id'])) {
        current = undefined; entry.resolve(undefined); return;
      }
      if (entry.kind !== 'query' || !STATES.includes(packet.status)) { lose(); return; }
      if (packet.kind === 'result' && exact(packet, ['protocol', 'kind', 'id', 'status', 'result'])) {
        current = undefined; status = packet.status as Status; entry.resolve(packet.result); return;
      }
      if (packet.kind === 'rejected' && exact(packet, ['protocol', 'kind', 'id', 'status', 'sqlstate', 'afterCommandComplete'])
          && typeof packet.sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(packet.sqlstate) && typeof packet.afterCommandComplete === 'boolean') {
        current = undefined; status = packet.status as Status;
        const rejection = new EngineRejection('A PostgreSQL engine response rejected this operation.');
        ordinary.set(rejection, Object.freeze({ sqlstate: packet.sqlstate, afterCommandComplete: packet.afterCommandComplete }));
        entry.reject(rejection); return;
      }
      lose();
    });
    const transport = {
      async query(sql: string, parameters: readonly Parameter[]): Promise<PostgresTransportResult> {
        return await send('query', { sql, parameters: wireParameters(parameters) }) as PostgresTransportResult;
      },
      transactionStatus(): Status { if (lost || status === undefined) throw new Error('Lost worker'); return status; },
      serverError(error: unknown) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
      close(): Promise<void> {
        closing ??= (async () => {
          // A statement in flight may be blocking the worker, so it can't answer: stop the thread instead.
          if (lost || current) { lost = true; current?.reject(new Error('Worker closed')); current = undefined; await terminate(); return; }
          await send('close', {});
          lost = true;
          await terminate();
        })();
        return closing;
      },
      forceClose(): void { lost = true; terminate().catch(() => { /* Reported as unconfirmed already. */ }); },
    };
  });
}

export async function openHosted(entry: string, dataDir: string | null, openTimeoutMs: number, executorOptions: { requestTimeoutMs: number; closeTimeoutMs: number }): Promise<AsyncExecutor<PostgresRawResult>> {
  if (dataDir !== null && (!isAbsolute(boundedText(dataDir, 4096)) || dataDir.includes('://'))) throw invalidOptions();
  let transport: (PostgresTransport & { forceClose(): void }) | undefined;
  await hostPgliteWorker(entry, dataDir, openTimeoutMs, opened => { transport = opened; });
  const executor = createPostgresExecutor(transport!, executorOptions);
  try {
    await confirmSettings(executor, {});
  } catch (error) {
    transport!.forceClose();
    if (error instanceof RowstitchError && error.code === 'OPEN') throw error;
    throw openFailed();
  }
  return closingOnDeadline(executor);
}
