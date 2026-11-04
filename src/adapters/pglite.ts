/**
 * Optional adapter hosting one PGlite instance in a Node worker thread, so request deadlines keep running while WASM blocks.
 * Node only; no browser support is implied. In memory only: nothing persists after close.
 */
import type { AsyncExecutor } from '../core/executor.js';
import type { PostgresRawResult } from '../core/postgres-result.js';
import { openHosted } from './pglite-host.js';
import { boundedInteger, captureOptions, requireSupportedRuntime, resolvePeer } from './shared.js';

export interface PgliteExecutorOptions {
  /** Deadline for starting the worker and engine (1-120000 ms, default 30000). */
  readonly openTimeoutMs?: number;
  /** Client deadline for one request (1-120000 ms, default 30000). Reaching it ends the worker; the outcome stays unconfirmed. */
  readonly requestTimeoutMs?: number;
  /** Client deadline for closing (1-60000 ms, default 5000). */
  readonly closeTimeoutMs?: number;
}

const PGLITE_VERSION = '0.5.15';
const OPTION_KEYS = Object.freeze(['openTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs']);
/** Opens one in-memory PGlite instance in its own worker thread. Options are captured synchronously, before this first awaits. */
export async function openPgliteExecutor(options: PgliteExecutorOptions = {}): Promise<AsyncExecutor<PostgresRawResult>> {
  requireSupportedRuntime();
  const captured = captureOptions(options, OPTION_KEYS);
  const openTimeoutMs = boundedInteger(captured.openTimeoutMs, 30_000, 1, 120_000)!;
  const executorOptions = { requestTimeoutMs: boundedInteger(captured.requestTimeoutMs, 30_000, 1, 120_000)!, closeTimeoutMs: boundedInteger(captured.closeTimeoutMs, 5_000, 1, 60_000)! };
  const entry = await resolvePeer('@electric-sql/pglite', PGLITE_VERSION, 'PGlite');
  return await openHosted(entry, null, openTimeoutMs, executorOptions);
}
