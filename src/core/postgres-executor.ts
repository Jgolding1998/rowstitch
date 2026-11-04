/** Internal, dedicated-connection PostgreSQL protocol adapter. Not exported from the SDK. */
import { RowstitchError } from './errors.js';
import { acknowledgedRejection, type AsyncExecutor } from './executor.js';
import { snapshotPostgresResult, type PostgresRawField, type PostgresRawResult } from './postgres-result.js';
import { MAX_BOUND_PARAMETERS } from './query-model.js';
import type { Parameter } from './schema.js';

type Status = 'I' | 'T' | 'E';
/**
 * One complete response. `commandTag` is the exact CommandComplete text received for this request, never a driver's parsed
 * or rounded count; a fixed parser here derives the command verb and row count. Rows are positional raw text, no parsers.
 */
export interface PostgresTransportResult {
  readonly fields: readonly PostgresRawField[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly commandTag: string;
}
/**
 * What a transport knows about one genuine ErrorResponse. `afterCommandComplete` says that this same request's CommandComplete
 * arrived before the error. In autocommit, that means an implicit commit failed at Sync, which is as uncertain as a failed COMMIT.
 */
export interface PostgresErrorVerdict {
  readonly sqlstate: string;
  readonly afterCommandComplete: boolean;
}
/** Engine-specific ownership and error identity belong to the private connection transport. Preserve raw text; no global parsers. */
export interface PostgresTransport {
  query(sql: string, parameters: readonly Parameter[]): Promise<PostgresTransportResult>;
  /** The status from the most recent ReadyForQuery. Throw if the connection is lost. */
  transactionStatus(): Status;
  /**
   * Return a verdict only for a genuine ErrorResponse that the transport has confirmed left the connection usable, by
   * observing ReadyForQuery after it. A fatal response has none. Never decide from localized severity text, and never
   * return one for a socket, parser or callback error.
   */
  serverError(error: unknown): PostgresErrorVerdict | undefined;
  /** Request an orderly close. It may hang or fail; the executor bounds it and never claims physical closure on failure. */
  close(): Promise<void>;
  /** Optional, synchronous: abandon the connection after an orderly close failed or timed out. */
  forceClose?(): void;
}
export interface PostgresExecutorOptions {
  /** Deadline for one request, after which its outcome is unconfirmed (1-120000 ms, default 30000). */
  readonly requestTimeoutMs?: number;
  /** Deadline for the orderly close request (1-60000 ms, default 5000). */
  readonly closeTimeoutMs?: number;
}

function invalid(): RowstitchError { return new RowstitchError('VALIDATION', 'The PostgreSQL executor received an invalid argument.'); }
function unconfirmedError(): RowstitchError { return new RowstitchError('DATABASE_ERROR', 'The PostgreSQL operation was not confirmed.'); }
function timeoutError(): RowstitchError { return new RowstitchError('DRIVER_TIMEOUT', 'The PostgreSQL request was not confirmed before its deadline. No operation was replayed.'); }
function closeError(): RowstitchError { return new RowstitchError('CLOSE_UNCONFIRMED', 'The PostgreSQL connection close was not confirmed.'); }

/** Tags that always carry a count. PostgreSQL has reported INSERT's legacy OID word as 0 since version 12. */
const COUNTED_TAG = /^(?:(SELECT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY)|(INSERT) 0) (0|[1-9][0-9]{0,19})$/;
const UNCOUNTED_TAG = /^([A-Z]+)(?: [A-Z]+)*$/;
const COUNTED_VERB = /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY)$/;
/** Strict and exact: the count comes only from this tag's digits, so it is never rounded or inferred from returned rows. */
function parseCommandTag(tag: unknown): { command: string; rowCount: bigint | null } {
  if (typeof tag !== 'string' || tag.length > 64) throw invalid();
  const counted = COUNTED_TAG.exec(tag);
  if (counted) return { command: counted[1] ?? counted[2]!, rowCount: BigInt(counted[3]!) };
  const verb = UNCOUNTED_TAG.exec(tag)?.[1];
  if (verb === undefined || COUNTED_VERB.test(verb)) throw invalid();
  return { command: verb, rowCount: null };
}
/** Reads a plain record of exactly these fields, without invoking accessors. */
function exactRecord(value: unknown, keys: readonly string[]): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) throw invalid();
  return keys.map(key => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    return descriptor.value;
  });
}
const RESPONSE_KEYS = Object.freeze(['fields', 'rows', 'commandTag']), VERDICT_KEYS = Object.freeze(['sqlstate', 'afterCommandComplete']);
function errorVerdict(value: unknown): PostgresErrorVerdict {
  const [sqlstate, afterCommandComplete] = exactRecord(value, VERDICT_KEYS);
  if (typeof sqlstate !== 'string' || !/^[0-9A-Z]{5}$/.test(sqlstate) || typeof afterCommandComplete !== 'boolean') throw invalid();
  return { sqlstate, afterCommandComplete };
}
/** A validated, frozen, branded result. The brand is shape identity only; it says nothing about acknowledgment. */
function rawResult(value: unknown): { result: PostgresRawResult; tag: string } {
  const [fields, rows, commandTag] = exactRecord(value, RESPONSE_KEYS);
  const { command, rowCount } = parseCommandTag(commandTag);
  const result = snapshotPostgresResult({ fields, rows, command, rowCount });
  // When a statement returns rows, its own tag must count exactly those rows. A stale or foreign tag cannot.
  if (rowCount !== null && (result.fields.length > 0 || result.rows.length > 0) && rowCount !== BigInt(result.rows.length)) throw invalid();
  return { result, tag: commandTag as string };
}

/**
 * An ErrorResponse is not always a known negative outcome. PostgreSQL documents 40003 (statement_completion_unknown) and
 * class 08 (connection exceptions, including 08007 transaction_resolution_unknown) as unresolved. Shutdown, timeout,
 * system and internal errors leave the connection or its effects in doubt as well. None of these may acknowledge.
 */
const UNRESOLVED_STATE = /^(?:08|58|XX|57P)|^(?:40003|25P03|25P04)$/;
/** COMMIT, explicit or implicit, is held to a positive list: only failures that PostgreSQL raises before the commit point are definite. */
const DEFINITE_COMMIT_STATE = /^(?:23[0-9A-Z]{3}|40001|40002|40P01|P0001)$/;
function errorCode(state: string): string {
  if (/^23[0-9A-Z]{3}$/.test(state)) return 'CONSTRAINT';
  if (state === '25006') return 'READ_ONLY';
  if (state === '40001') return 'SERIALIZATION_FAILURE';
  if (state === '40P01') return 'DEADLOCK';
  if (state === '55P03') return 'BUSY';
  return 'DATABASE_ERROR';
}
/** Statement tags that change transaction or session state. Only generated control commands may do that, through exec. */
const FORBIDDEN_STATEMENT_TAG = /^(?:BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|PREPARE|SET|RESET|DISCARD|LISTEN|UNLISTEN)\b/i;

type Transitions = Readonly<Partial<Record<Status, Status>>>;
/**
 * `send` lists the prior states a command may be sent in. `success` and `rejection` map a prior state to the only state that
 * outcome may leave. They differ on purpose: SAVEPOINT and RELEASE are sent in a failed transaction, because the engine's
 * ordinary rejection there is what lets the session recover, yet neither can succeed there, since only a rollback heals it.
 * A transport must report the real ReadyForQuery status: an aborted transaction is E, never T. Control `rejection` entries
 * are limited to transitions observed from real engines. Any other rejection has no known resulting state, so it is unconfirmed.
 */
interface ControlContract { readonly tag: string; readonly send: readonly Status[]; readonly success: Transitions; readonly rejection: Transitions }
/** An ordinary ERROR leaves idle as idle, aborts an open transaction, and leaves a failed one failed. */
const STATEMENT_REJECTION: Transitions = { I: 'I', T: 'E', E: 'E' };
function controlContract(sql: string): ControlContract | undefined {
  if (sql === 'BEGIN READ ONLY' || sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') return { tag: 'BEGIN', send: ['I'], success: { I: 'T' }, rejection: {} };
  // COMMIT needs an open transaction: outside one, PostgreSQL only warns and still answers with a COMMIT tag.
  // From a failed transaction, COMMIT cannot succeed: its only valid answer is the ROLLBACK tag handled in exec.
  // A failure raised while committing (deferred constraint, serialization) has already ended the transaction.
  if (sql === 'COMMIT') return { tag: 'COMMIT', send: ['T', 'E'], success: { T: 'I' }, rejection: { T: 'I' } };
  // ROLLBACK may follow a rejected COMMIT, which has already ended the transaction; it is harmless and verified afterwards.
  if (sql === 'ROLLBACK') return { tag: 'ROLLBACK', send: ['I', 'T', 'E'], success: { I: 'I', T: 'I', E: 'I' }, rejection: {} };
  if (/^SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return { tag: 'SAVEPOINT', send: ['T', 'E'], success: { T: 'T' }, rejection: { E: 'E' } };
  if (/^RELEASE SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return { tag: 'RELEASE', send: ['T', 'E'], success: { T: 'T' }, rejection: { T: 'E', E: 'E' } };
  if (/^ROLLBACK TO SAVEPOINT "[A-Za-z_][A-Za-z0-9_]{0,62}"$/.test(sql)) return { tag: 'ROLLBACK', send: ['T', 'E'], success: { T: 'T', E: 'T' }, rejection: { T: 'E', E: 'E' } };
  return undefined;
}
function limit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw invalid();
  return value;
}

export function createPostgresExecutor(transport: PostgresTransport, options: PostgresExecutorOptions = {}): AsyncExecutor<PostgresRawResult> {
  if (!transport || typeof transport !== 'object') throw invalid();
  const query = transport.query?.bind(transport), status = transport.transactionStatus?.bind(transport);
  const serverError = transport.serverError?.bind(transport), close = transport.close?.bind(transport);
  if (![query, status, serverError, close].every(fn => typeof fn === 'function')) throw invalid();
  const forceClose = typeof transport.forceClose === 'function' ? transport.forceClose.bind(transport) : undefined;
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => key !== 'requestTimeoutMs' && key !== 'closeTimeoutMs')) throw invalid();
  const requestTimeoutMs = limit(options.requestTimeoutMs, 30_000, 120_000), closeTimeoutMs = limit(options.closeTimeoutMs, 5_000, 60_000);

  let ended: Promise<void> | undefined;
  /** Set by any unconfirmed outcome: this connection's state is unknown, so nothing more is sent on it. */
  let unusable = false;
  const uncertain = (error = unconfirmedError()): RowstitchError => { unusable = true; return error; };
  const usable = (): void => {
    if (ended) throw new RowstitchError('CLOSED', 'This PostgreSQL connection is closed.');
    if (unusable) throw unconfirmedError();
  };
  const readStatus = (): Status => {
    let state: unknown;
    try { state = status(); } catch { throw uncertain(); }
    if (state !== 'I' && state !== 'T' && state !== 'E') throw uncertain();
    return state;
  };

  const request = async (sql: string, parameters: readonly Parameter[], before: Status, rejection: Transitions, commit = false): Promise<{ result: PostgresRawResult; tag: string }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = timeoutError();
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { unusable = true; reject(expired); }, requestTimeoutMs); });
    let result: unknown;
    try {
      // A sent request is never withdrawn. The race observes it, so a late result or rejection after the deadline is ignored.
      result = await Promise.race([Promise.resolve().then(() => query(sql, parameters)), deadline]);
    } catch (error) {
      if (error === expired) throw expired;
      let verdict: PostgresErrorVerdict;
      try { verdict = errorVerdict(serverError(error)); } catch { throw uncertain(); }
      const state = verdict.sqlstate;
      // In autocommit, a completed statement commits at Sync, so an error after its CommandComplete is a failed implicit commit.
      const implicitCommit = before === 'I' && verdict.afterCommandComplete;
      if (UNRESOLVED_STATE.test(state) || (commit || implicitCommit) && !DEFINITE_COMMIT_STATE.test(state)) throw uncertain();
      // A rejection is definite only if the connection then reports the state that this rejection leaves.
      if (readStatus() !== rejection[before]) throw uncertain();
      throw acknowledgedRejection(new RowstitchError(errorCode(state), 'A PostgreSQL engine response rejected this operation.'));
    } finally { clearTimeout(timer); }
    // Validation is outside the ErrorResponse handling: malformed success is not an acknowledged rejection.
    try { return rawResult(result); } catch { throw uncertain(); }
  };

  return Object.freeze({
    async all(sql: string, parameters: readonly Parameter[]): Promise<PostgresRawResult> {
      if (typeof sql !== 'string' || !sql || sql.includes('\0') || !Array.isArray(parameters) || parameters.length > MAX_BOUND_PARAMETERS) throw invalid();
      const values = Array.from(parameters);
      if (values.some(value => !(value === null || typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value)))) throw invalid();
      usable();
      const before = readStatus();
      const { result } = await request(sql, Object.freeze(values), before, STATEMENT_REJECTION);
      // Transaction control belongs to exec; procedures can also change state without a telltale tag.
      // A failed transaction rejects ordinary statements, so a success there is not a response PostgreSQL can give.
      const after = readStatus();
      if (FORBIDDEN_STATEMENT_TAG.test(result.command) || before === 'E' || after !== before) throw uncertain();
      return result;
    },
    async exec(sql: string): Promise<void> {
      const contract = typeof sql === 'string' ? controlContract(sql) : undefined;
      if (contract === undefined) throw invalid();
      usable();
      const before = readStatus();
      if (!contract.send.includes(before)) throw uncertain();
      const { result, tag } = await request(sql, [], before, contract.rejection, sql === 'COMMIT');
      const after = readStatus();
      // A control command answers with its tag alone: no fields, no rows and no count.
      if (result.fields.length > 0 || result.rows.length > 0 || result.rowCount !== null) throw uncertain();
      // PostgreSQL COMMIT answers ROLLBACK when a caught error left the transaction aborted. Only that: from a healthy
      // transaction the tag contradicts the reported state, and the outcome is unknown rather than a rollback.
      if (sql === 'COMMIT' && tag === 'ROLLBACK') {
        if (before !== 'E' || after !== 'I') throw uncertain();
        throw acknowledgedRejection(new RowstitchError('TRANSACTION_ABORTED', 'The database rolled back the aborted transaction.'));
      }
      if (tag !== contract.tag || after !== contract.success[before]) throw uncertain();
    },
    async inTransaction(): Promise<boolean> {
      usable();
      return readStatus() !== 'I';
    },
    close(): Promise<void> {
      ended ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(closeError()), closeTimeoutMs); });
        try {
          await Promise.race([Promise.resolve().then(close), deadline]);
        } catch {
          // Failure or timeout says nothing about physical closure. Abandon the connection and report exactly that.
          try { forceClose?.(); } catch { /* The result is already unconfirmed. */ }
          throw closeError();
        } finally { clearTimeout(timer); }
      })();
      return ended;
    },
  });
}
