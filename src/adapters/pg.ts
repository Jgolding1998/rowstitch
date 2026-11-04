/**
 * Optional adapter for one dedicated node-postgres connection. No pool, retry or replay. `pg` loads only when this opens.
 *
 * pg 8.23.1 merges a connection string over its config, including `options`, session timeouts and file-reading TLS query
 * parameters, and falls back to PGOPTIONS, PGPASSWORD, .pgpass and other environment values for any falsy field. So this adapter
 * parses a narrow URI itself, always passes explicit fields, and then asks the server what is actually in effect.
 */
import { RowstitchError } from '../core/errors.js';
import type { AsyncExecutor } from '../core/executor.js';
import { createPostgresExecutor, type PostgresErrorVerdict, type PostgresTransport } from '../core/postgres-executor.js';
import type { PostgresRawResult } from '../core/postgres-result.js';
import type { Parameter } from '../core/schema.js';
import { boundedInteger, boundedText, captureOptions, closingOnDeadline, confirmSettings, invalidOptions, openFailed, openTimedOut, requireSupportedRuntime, resolvePeer, uint32Oid, wireParameters, type Status } from './shared.js';

/** Certificate checks are always on: a server certificate must verify against `ca`, or the Node default roots when `ca` is omitted. */
export interface PgTlsOptions {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}
export interface PgExecutorOptions {
  /** `postgres://user:password@host:port/database`. The only accepted query is `sslmode=disable` or `sslmode=verify-full`. */
  readonly connectionString?: string;
  /** Use with `user` and `database` instead of `connectionString`. A leading `/` selects a Unix socket directory. */
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  /** Environment values and password files are never consulted. */
  readonly password?: string;
  /** Default false. `true` or an object requires verified TLS. */
  readonly ssl?: boolean | PgTlsOptions;
  readonly applicationName?: string;
  /** Deadline for connecting and confirming settings (1-120000 ms, default 10000). */
  readonly connectTimeoutMs?: number;
  /** Client deadline for one request (1-120000 ms, default 30000). Reaching it proves nothing about what the server did. */
  readonly requestTimeoutMs?: number;
  /** Client deadline for closing (1-60000 ms, default 5000). */
  readonly closeTimeoutMs?: number;
  /** Server-side session timeouts in ms (0-2147483647, 0 disables). Omitted values keep the server's own configuration. */
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  /** Needs a server that has this setting (PostgreSQL 17+); otherwise opening fails. */
  readonly transactionTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

const PG_VERSION = '8.23.1';
const OPTION_KEYS = Object.freeze(['connectionString', 'host', 'port', 'user', 'database', 'password', 'ssl', 'applicationName', 'connectTimeoutMs', 'requestTimeoutMs', 'closeTimeoutMs', 'statementTimeoutMs', 'lockTimeoutMs', 'transactionTimeoutMs', 'idleInTransactionTimeoutMs']);
const TIMEOUTS: readonly (readonly [string, string])[] = Object.freeze([
  ['statementTimeoutMs', 'statement_timeout'], ['lockTimeoutMs', 'lock_timeout'],
  ['transactionTimeoutMs', 'transaction_timeout'], ['idleInTransactionTimeoutMs', 'idle_in_transaction_session_timeout'],
]);
/** How long a close waits for a cancelled statement to answer before abandoning the socket. */
const CANCEL_GRACE_MS = 1_000;

interface Target { host: string; port: number; user: string; database: string; password: string | undefined; ssl: boolean | PgTlsOptions }
function tls(value: unknown): boolean | PgTlsOptions {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  const captured = captureOptions(value, ['ca', 'cert', 'key']);
  if ((captured.cert === undefined) !== (captured.key === undefined)) throw invalidOptions();
  const result: { ca?: string; cert?: string; key?: string } = {};
  for (const name of ['ca', 'cert', 'key'] as const) if (captured[name] !== undefined) result[name] = boundedText(captured[name], 1_048_576);
  return Object.freeze(result);
}
/**
 * pg 8.23.1 marks `key` non-enumerable in place on the object it receives, which throws on a frozen one. The frozen snapshot stays
 * private: each pg object gets its own copy of those same captured values, and the caller's object is never handed to pg.
 */
const driverTls = (ssl: boolean | PgTlsOptions): boolean | PgTlsOptions => (typeof ssl === 'object' ? { ...ssl } : ssl);
function validHost(value: unknown): string {
  const host = boundedText(value, 255);
  if (/[\s,\u0000-\u001f\u007f]/u.test(host)) throw invalidOptions();
  return host;
}
function validPort(value: unknown): number { return boundedInteger(value, 5432, 1, 65_535)!; }
function fromUri(uri: string, captured: Record<string, unknown>): Target {
  for (const key of ['host', 'port', 'user', 'database']) if (captured[key] !== undefined) throw invalidOptions();
  let url: URL, user: string, database: string, uriPassword: string;
  try {
    url = new URL(uri);
    user = decodeURIComponent(url.username);
    uriPassword = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw invalidOptions(); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:' || url.hash || !url.hostname || !user || !database || url.pathname.slice(1).includes('/')) throw invalidOptions();
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'sslmode') || keys.length > 1) throw invalidOptions();
  const mode = url.searchParams.get('sslmode');
  if (mode !== null && mode !== 'disable' && mode !== 'verify-full') throw invalidOptions();
  if (mode !== null && captured.ssl !== undefined) throw invalidOptions();
  if (uriPassword && captured.password !== undefined) throw invalidOptions();
  const password = uriPassword || (captured.password === undefined ? undefined : boundedText(captured.password, 4096));
  return { host: validHost(url.hostname.replace(/^\[(.+)\]$/, '$1')), port: validPort(url.port === '' ? undefined : Number(url.port)), user: boundedText(user, 255), database: boundedText(database, 255), password,
    ssl: mode === 'verify-full' ? true : tls(captured.ssl) };
}
function target(captured: Record<string, unknown>): Target {
  if (captured.connectionString !== undefined) return fromUri(boundedText(captured.connectionString, 8192), captured);
  return { host: validHost(captured.host), port: validPort(captured.port), user: boundedText(captured.user, 255), database: boundedText(captured.database, 255),
    password: captured.password === undefined ? undefined : boundedText(captured.password, 4096), ssl: tls(captured.ssl) };
}

// The parts of pg 8.23.1 this adapter uses, stated here so its types never reach emitted declarations. The version guard pins them.
interface PgConnection {
  readonly stream: { destroy(): void };
  on(event: string, listener: (message: never) => void): unknown;
  once(event: string, listener: (message: never) => void): unknown;
  connect(portOrPath: number | string, host?: string): void;
  requestSsl(): void;
  cancel(processId: number, secretKey: number): void;
}
interface PgQueryResult { readonly fields: readonly { readonly name: string; readonly dataTypeID: unknown }[]; readonly rows: readonly (readonly (string | null)[])[] }
interface PgClient {
  readonly connectionParameters: { readonly replication?: unknown; readonly options?: unknown; readonly host?: unknown; readonly database?: unknown; readonly user?: unknown };
  readonly binary?: unknown;
  readonly connection: PgConnection;
  on(event: 'error', listener: () => void): unknown;
  connect(): Promise<unknown>;
  query(config: { text: string; values: readonly (string | null)[]; queryMode: 'extended'; rowMode: 'array'; types: { getTypeParser(oid: unknown, format: unknown): (value: unknown) => unknown } }): Promise<PgQueryResult | readonly PgQueryResult[]>;
  end(): Promise<void>;
}
interface PgModule {
  readonly Client: new (config: Record<string, unknown>) => PgClient;
  readonly Connection: new (config: { ssl: boolean | PgTlsOptions }) => PgConnection;
  readonly DatabaseError: abstract new (...args: never[]) => Error;
}
interface Transport extends PostgresTransport { forceClose(): void; connect(): Promise<void> }

const isResultList = (value: PgQueryResult | readonly PgQueryResult[]): value is readonly PgQueryResult[] => Array.isArray(value);
function createTransport(pg: PgModule, connection: Target, config: Record<string, unknown>): Transport {
  const client = new pg.Client(config);
  // Refuse anything the ambient environment or mutated global defaults still changed.
  const params = client.connectionParameters;
  if (params.replication || client.binary || params.options !== config.options || params.host !== connection.host || params.database !== connection.database || params.user !== connection.user) throw openFailed();
  const socket = client.connection;
  let lost = false, opened = false, ready = 0, closing: Promise<void> | undefined;
  let status: Status | undefined, processId: unknown, secretKey: unknown;
  let requestTags: string[] | null = null, tagsAtError: number | null = null, errorsSeen = 0;
  const waiters = new Set<() => void>();
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const lose = (): void => { lost = true; wake(); };
  const ordinary = new WeakMap<object, PostgresErrorVerdict>();
  // Attached before connecting, so these run before pg's own listeners: each fact is recorded before pg settles its promise.
  client.on('error', lose);
  socket.once('end', lose);
  socket.on('backendKeyData', (message: { processID?: unknown; secretKey?: unknown }) => { processId = message.processID; secretKey = message.secretKey; });
  socket.on('readyForQuery', (message: { status?: unknown }) => {
    if (message.status !== 'I' && message.status !== 'T' && message.status !== 'E') { lose(); return; }
    // The only ReadyForQuery allowed outside a request is the first one, which ends startup.
    if (requestTags === null) { if (opened) { lose(); return; } opened = true; }
    status = message.status; ready++; wake();
  });
  // The exact tag text belongs to the one serialized request. pg's own rowCount is a rounded Number, so it is never used.
  socket.on('commandComplete', (message: { text: string }) => { if (requestTags) requestTags.push(message.text); else lose(); });
  // Recorded on arrival, because the rejection is observed later: what matters is whether the tag came before this error.
  socket.on('errorMessage', () => { errorsSeen++; tagsAtError = requestTags ? requestTags.length : null; });
  // Any reported encoding change invalidates the decoding contract for this connection.
  socket.on('parameterStatus', (message: { parameterName?: unknown; parameterValue?: unknown }) => { if (message.parameterName === 'client_encoding' && message.parameterValue !== 'UTF8') lose(); });

  const identity = (value: unknown): unknown => value;
  /** CancelRequest on its own short connection, over TLS when this connection uses it. It asks; it proves nothing. */
  const cancel = (): Promise<void> => new Promise(resolve => {
    if (typeof processId !== 'number' || typeof secretKey !== 'number') { resolve(); return; }
    const pid = processId, key = secretKey;
    let extra: PgConnection;
    try { extra = new pg.Connection({ ssl: driverTls(connection.ssl) }); } catch { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => { clearTimeout(timer); try { extra.stream.destroy(); } catch { /* Best effort. */ } resolve(); };
    timer = setTimeout(done, CANCEL_GRACE_MS);
    extra.on('error', done);
    extra.once('end', done);
    extra.once('sslconnect', () => { try { extra.cancel(pid, key); } catch { done(); } });
    extra.once('connect', () => { try { if (connection.ssl) extra.requestSsl(); else extra.cancel(pid, key); } catch { done(); } });
    try {
      if (connection.host.startsWith('/')) extra.connect(connection.host + '/.s.PGSQL.' + connection.port);
      else extra.connect(connection.port, connection.host);
    } catch { done(); }
  });
  const answeredOrLost = (ms: number): Promise<void> => new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); waiters.delete(check); resolve(); };
    const check = (): void => { if (lost || requestTags === null) done(); };
    const timer = setTimeout(done, ms);
    waiters.add(check); check();
  });

  return {
    async connect(): Promise<void> { await client.connect(); if (status === undefined) { lose(); throw new Error('No ReadyForQuery ended startup'); } },
    async query(sql: string, parameters: readonly Parameter[]) {
      if (lost || requestTags !== null) { lose(); throw new Error('Unavailable connection'); }
      const before = ready, tags: string[] = [];
      let binary = false;
      requestTags = tags; tagsAtError = null; errorsSeen = 0;
      try {
        const result = await client.query({ text: sql, values: wireParameters(parameters), queryMode: 'extended', rowMode: 'array',
          types: { getTypeParser(_oid: unknown, format: unknown) { if (format !== undefined && format !== 'text') binary = true; return identity; } } });
        // Exactly one tag and one ReadyForQuery belong to one statement. Anything else ends this connection.
        if (tags.length !== 1 || isResultList(result) || binary || ready !== before + 1) { lose(); throw new Error('Unexpected command completion'); }
        return { fields: result.fields.map(field => ({ name: field.name, typeOid: uint32Oid(field.dataTypeID) })), rows: result.rows, commandTag: tags[0]! };
      } catch (error) {
        if (error instanceof pg.DatabaseError && typeof (error as { code?: unknown }).code === 'string') {
          // pg rejects at ErrorResponse, before ReadyForQuery. The executor's deadline bounds this wait.
          while (!lost && ready === before) await new Promise<void>(resolve => { const done = (): void => { waiters.delete(done); resolve(); }; waiters.add(done); });
          // One error, one ReadyForQuery, at most one earlier tag and no tag after it. Anything else is not an ordinary exchange.
          const at = tagsAtError as number | null;
          if (!lost && ready === before + 1 && errorsSeen === 1 && (at === 0 || at === 1) && tags.length === at) {
            ordinary.set(error as object, Object.freeze({ sqlstate: (error as unknown as { code: string }).code, afterCommandComplete: at === 1 }));
          }
        }
        throw error;
      } finally { requestTags = null; wake(); }
    },
    transactionStatus(): Status { if (lost || status === undefined) throw new Error('Lost connection'); return status; },
    serverError(error: unknown) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
    close(): Promise<void> {
      closing ??= (async () => {
        // A server does not notice a dropped client while a statement runs, so ask it to stop first. Asking proves nothing.
        if (requestTags !== null && !lost) { await cancel(); await answeredOrLost(CANCEL_GRACE_MS); }
        await client.end();
      })();
      return closing;
    },
    forceClose(): void { lose(); socket.stream.destroy(); },
  };
}

/** Opens one dedicated, verified connection. Options are captured synchronously, before this first awaits. */
export async function openPgExecutor(options: PgExecutorOptions): Promise<AsyncExecutor<PostgresRawResult>> {
  requireSupportedRuntime();
  const captured = captureOptions(options, OPTION_KEYS);
  const connection = target(captured);
  const connectTimeoutMs = boundedInteger(captured.connectTimeoutMs, 10_000, 1, 120_000)!;
  const executorOptions = { requestTimeoutMs: boundedInteger(captured.requestTimeoutMs, 30_000, 1, 120_000)!, closeTimeoutMs: boundedInteger(captured.closeTimeoutMs, 5_000, 1, 60_000)! };
  const applicationName = captured.applicationName === undefined ? 'rowstitch' : boundedText(captured.applicationName, 63);
  if (!/^[\x20-\x7e]+$/.test(applicationName)) throw invalidOptions();
  const expected: Record<string, string> = {};
  // Only validated integers and fixed names reach this startup string. All settings travel in it, so 0 can truly disable a timeout.
  let startup = '-c extra_float_digits=3 -c client_encoding=UTF8';
  for (const [option, setting] of TIMEOUTS) {
    const value = boundedInteger(captured[option], undefined, 0, 2_147_483_647);
    if (value !== undefined) { startup += ' -c ' + setting + '=' + value; expected[setting] = String(value); }
  }
  const { password } = connection;
  const config = { host: connection.host, port: connection.port, user: connection.user, database: connection.database, ssl: driverTls(connection.ssl),
    // A function keeps pg away from PGPASSWORD and password files. Undefined means this connection has no password to offer.
    password: () => password, options: startup, client_encoding: 'UTF8', application_name: applicationName, sslnegotiation: 'postgres' };

  let transport: Transport | undefined, timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(openTimedOut()); }, connectTimeoutMs); });
  const open = (async () => {
    const entry = await resolvePeer('pg', PG_VERSION, 'PostgreSQL');
    let pg: PgModule;
    try {
      const loaded = await import(entry) as { default?: PgModule } & Partial<PgModule>;
      const candidate = loaded.default ?? loaded;
      if (typeof candidate?.Client !== 'function' || typeof candidate?.Connection !== 'function' || typeof candidate?.DatabaseError !== 'function') throw new Error('Unexpected module');
      pg = candidate as PgModule;
    } catch { throw new RowstitchError('DRIVER_UNAVAILABLE', 'The optional PostgreSQL client could not be loaded.'); }
    if (expired) throw openTimedOut();
    transport = createTransport(pg, connection, config);
    await transport.connect();
    const executor = createPostgresExecutor(transport, executorOptions);
    await confirmSettings(executor, expected);
    return closingOnDeadline(executor);
  })();
  try {
    return await Promise.race([open, deadline]);
  } catch (error) {
    try { transport?.forceClose(); } catch { /* The open already failed. */ }
    open.catch(() => { /* A later failure has nowhere to go. */ });
    // Only this adapter's own constant failures pass through. Driver and executor errors become one constant message.
    if (error instanceof RowstitchError && ['DRIVER_UNAVAILABLE', 'DRIVER_VERSION', 'DRIVER_TIMEOUT', 'OPEN'].includes(error.code)) throw error;
    throw openFailed();
  } finally { clearTimeout(timer); }
}
