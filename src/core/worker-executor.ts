import { Worker } from 'node:worker_threads';
import { RowstitchError, fail } from './errors.js';
import { acknowledgedRejection, type AsyncExecutor, type ExecutorRows } from './executor.js';
import { plainRecord, type Parameter } from './schema.js';
import { NODE_REQUIREMENT, supportedNode } from '../runtime.js';

interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; op: string }
const driverError = (code = 'DRIVER_UNAVAILABLE') => new RowstitchError(code,
  code === 'DRIVER_TIMEOUT' ? 'The database worker did not confirm the operation before its deadline. No operation was replayed.' : 'The database worker is unavailable. The operation outcome may be unconfirmed.');

/** Internal transport seam. A lost worker response is never branded as a definite engine rejection. */
export async function connectSqliteWorker(worker: Worker, requestTimeoutMs: number): Promise<AsyncExecutor> {
  let sequence = 0, terminal: RowstitchError | null = null, closing = false, ready = false;
  let termination: Promise<void> | undefined, closeResult: Promise<void> | undefined;
  const pending = new Map<number, Pending>();
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const startup = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const terminate = (): Promise<void> => termination ??= worker.terminate().then(() => {});
  const stop = (error: RowstitchError): void => {
    if (terminal) return;
    terminal = error; clearTimeout(startupTimer); readyReject(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    terminate().catch(() => {});
  };
  const startupTimer = setTimeout(() => stop(driverError('DRIVER_TIMEOUT')), requestTimeoutMs);
  worker.on('error', () => stop(driverError()));
  worker.on('messageerror', () => stop(driverError()));
  worker.on('exit', () => { if (!closing || pending.size || !ready) stop(driverError()); });
  worker.on('message', (message: unknown) => {
    if (terminal) return;
    if (!message || typeof message !== 'object') { stop(driverError()); return; }
    const packet = message as Record<string, unknown>;
    if (!ready) {
      if (packet.protocol === 1 && packet.kind === 'ready') { ready = true; clearTimeout(startupTimer); readyResolve(); return; }
      if (packet.protocol === 1 && packet.kind === 'open-error') {
        stop(new RowstitchError('OPEN', 'The local SQLite worker could not open with the required safety settings.')); return;
      }
      stop(driverError()); return;
    }
    if (packet.protocol !== 1 || packet.kind !== 'result' || !Number.isSafeInteger(packet.id)) { stop(driverError()); return; }
    const entry = pending.get(packet.id as number);
    if (!entry) { stop(driverError()); return; }
    pending.delete(packet.id as number); clearTimeout(entry.timer);
    if (packet.ok === false && typeof packet.code === 'string') {
      entry.reject(acknowledgedRejection(new RowstitchError(packet.code, 'A database operation was rejected.'))); return;
    }
    if (packet.ok !== true || (entry.op === 'all' && !Array.isArray(packet.value)) || (entry.op === 'state' && typeof packet.value !== 'boolean')
      || ((entry.op === 'exec' || entry.op === 'close') && packet.value !== undefined)) {
      entry.reject(driverError()); stop(driverError()); return;
    }
    entry.resolve(packet.value);
  });
  await startup;
  const request = (op: string, data: Record<string, unknown> = {}): Promise<unknown> => {
    if (terminal) return Promise.reject(terminal);
    if (closing && op !== 'close') return Promise.reject(new RowstitchError('CLOSED', 'The database worker is closed.'));
    if (pending.size >= 1024 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new RowstitchError('PENDING_LIMIT', 'Too many worker requests are pending.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(driverError('DRIVER_TIMEOUT')), requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, op });
      try { worker.postMessage({ protocol: 1, id, op, ...data }); } catch { stop(driverError()); }
    });
  };
  return Object.freeze({
    async all(sql: string, parameters: readonly Parameter[]): Promise<ExecutorRows> {
      if (typeof sql !== 'string' || !sql.length || !Array.isArray(parameters)) fail('VALIDATION', 'The worker requires compiled SQL and scalar bindings.');
      const values = Array.from(parameters);
      if (values.some(v => !(v === null || typeof v === 'string' || typeof v === 'bigint' || typeof v === 'number' && Number.isFinite(v))))
        fail('VALIDATION', 'The worker requires compiled SQL and scalar bindings.');
      return await request('all', { sql, parameters: values }) as ExecutorRows;
    },
    async exec(sql: string): Promise<void> {
      if (typeof sql !== 'string' || !sql.length) fail('VALIDATION', 'The worker requires compiled SQL.');
      await request('exec', { sql });
    },
    async inTransaction(): Promise<boolean> { return await request('state') as boolean; },
    close(): Promise<void> {
      if (!closeResult) {
        closing = true;
        closeResult = terminal ? terminate() : request('close').then(() => terminate(), async error => { await terminate(); throw error; });
      }
      return closeResult;
    },
  });
}

/** SQLite runs in one owned worker. No runtime npm dependency or raw-SQL SDK capability is added. */
export async function openWorkerSqliteExecutor(filename = ':memory:', options: { readOnly?: boolean; busyTimeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<AsyncExecutor> {
  if (!supportedNode(process.versions.node)) fail('UNSUPPORTED_RUNTIME', 'Rowstitch requires ' + NODE_REQUIREMENT + '.');
  if (typeof filename !== 'string' || !filename.length || filename.includes('\0')) fail('VALIDATION', 'Choose a local SQLite filename or :memory:.');
  plainRecord(options);
  if (Object.keys(options).some(key => !['readOnly', 'busyTimeoutMs', 'requestTimeoutMs'].includes(key))) fail('QUERY', 'A worker connection option is not supported.');
  if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') fail('VALIDATION', 'readOnly must be a boolean when supplied.');
  const timeout = options.requestTimeoutMs === undefined ? 30_000 : options.requestTimeoutMs;
  const busy = options.busyTimeoutMs === undefined ? 1000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !Number.isSafeInteger(busy) || busy < 0 || busy > 10_000) fail('VALIDATION', 'A worker timeout is outside its supported integer range.');
  let worker: Worker;
  try { worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { workerData: { filename, readOnly: options.readOnly === true, busyTimeoutMs: busy } }); }
  catch { return fail('OPEN', 'The local SQLite worker could not be started.'); }
  return connectSqliteWorker(worker, timeout);
}
