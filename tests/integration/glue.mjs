// Test-only transports for the internal PostgreSQL executor. Not public SDK adapters.
// Ordinary versus fatal is decided by protocol sequence, not localized severity text: a response only counts as an
// ordinary rejection once ReadyForQuery has followed it on a live connection. A fatal response has none.
import assert from 'node:assert/strict';
import { PGlite, protocol } from '@electric-sql/pglite';
import pg from 'pg';

const identity = value => value;
/** Positional raw text with each field's OID. Duplicate names stay separate columns. The executor validates and parses the exact tag. */
const fieldsOf = fields => fields.map(field => ({ name: field.name, typeOid: uint32Oid(field.dataTypeID) }));
/** PGlite 0.5.15 reads a field OID as signed int32, and pg 8.23.1 as unsigned. Both are one uint32 on the wire; zero is no type. */
function uint32Oid(value) {
  assert.ok(Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 32 && value !== 0, 'Invalid field OID');
  return value < 0 ? value + 2 ** 32 : value;
}
const params = values => values.map(value => typeof value === 'bigint' ? value.toString() : value);

export async function connectPgTransport(config, hooks = {}) {
  const client = new pg.Client(config);
  let lost = false, ready = 0, closed = false;
  const waiters = new Set();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  client.on('error', () => { lost = true; wake(); });
  try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
  hooks.opened?.(client);
  client.connection.on('readyForQuery', () => { ready++; wake(); });
  client.connection.once('end', () => { lost = true; wake(); });
  // The exact tag text belongs to the one serialized request. pg's own rowCount is a rounded Number, so it is never used.
  let requestTags = null, tagsAtError = null, errorsSeen = 0;
  client.connection.on('commandComplete', message => { if (requestTags) requestTags.push(message.text); else { lost = true; wake(); } });
  // Recorded on arrival, because the rejection is observed later: what matters is whether the tag came before this error.
  client.connection.on('errorMessage', () => { errorsSeen++; tagsAtError = requestTags ? requestTags.length : null; });
  const ordinary = new WeakMap();
  return {
    async query(sql, values) {
      // Requests are serialized by the session, so the next ReadyForQuery belongs to this statement.
      const before = ready, tags = [];
      assert.equal(requestTags, null, 'Requests are serialized');
      requestTags = tags; tagsAtError = null; errorsSeen = 0;
      try {
        const result = await client.query({ text: sql, values: params(values), queryMode: 'extended', rowMode: 'array',
          types: { getTypeParser(_oid, format) { assert.ok(format === undefined || format === 'text'); return identity; } } });
        // Exactly one tag belongs to one statement. Missing, repeated or stale tags end this connection.
        if (tags.length !== 1 || Array.isArray(result)) { lost = true; throw new Error('Unexpected command completion'); }
        return { fields: fieldsOf(result.fields), rows: result.rows, commandTag: tags[0] };
      } catch (error) {
        if (error instanceof pg.DatabaseError && typeof error.code === 'string') {
          // pg rejects at ErrorResponse, before ReadyForQuery. The executor's deadline bounds this wait.
          while (!lost && ready === before) await new Promise(resolve => { const done = () => { waiters.delete(done); resolve(); }; waiters.add(done); });
          // One error, at most one earlier tag and no tag after it. Anything else is not an ordinary exchange.
          if (!lost && errorsSeen === 1 && (tagsAtError === 0 || tagsAtError === 1) && tags.length === tagsAtError)
            ordinary.set(error, Object.freeze({ sqlstate: error.code, afterCommandComplete: tagsAtError === 1 }));
        }
        throw error;
      } finally { requestTags = null; }
    },
    transactionStatus() { if (lost) throw new Error('Lost connection'); return client.getTransactionStatus(); },
    serverError(error) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
    async close() { if (!closed) { closed = true; await client.end(); hooks.closed?.(client); } },
    forceClose() { client.connection.stream.destroy(); hooks.closed?.(client); },
  };
}

// PGlite through its public protocol API, so status is the real ReadyForQuery byte, not inferred from isInTransaction, which
// cannot tell T from E. One extended Parse per query refuses scripts. Everything stays positional raw text with its OID.
const IGNORED_MESSAGES = new Set(['notice', 'notification', 'parameterStatus']);
const concatenated = parts => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
/** Each part is copied as it is produced, in case the serializer reuses its buffer. */
function extendedStatement(sql, values) {
  const { serialize } = protocol;
  return concatenated([
    new Uint8Array(serialize.parse({ text: sql })),
    new Uint8Array(serialize.bind({ values: values.map(value => value === null ? null : String(value)) })),
    new Uint8Array(serialize.describe({ type: 'P' })),
    new Uint8Array(serialize.execute({})),
    new Uint8Array(serialize.sync()),
  ]);
}
/**
 * The replies to Parse, Bind, Describe(portal), Execute and Sync arrive in this order, and an ordinary error can stop them at
 * any point, including after rows or after CommandComplete, when an implicit commit fails at Sync. Returns how far the legal
 * order reached.
 */
function readLegalPrefix(body) {
  let at = 0, described, completed;
  const rows = [];
  if (body[at]?.name === 'parseComplete' && body[++at]?.name === 'bindComplete') {
    const next = body[++at];
    if (next?.name === 'rowDescription' || next?.name === 'noData') {
      described = next; at++;
      const fields = described.name === 'rowDescription' ? described.fields : [];
      assert.ok(Array.isArray(fields) && fields.every(field => field.format === 0), 'Text results only');
      if (described.name === 'rowDescription') while (body[at]?.name === 'dataRow') {
        assert.ok(Array.isArray(body[at].fields) && body[at].fields.length === fields.length, 'Row width must match its description');
        rows.push(body[at++].fields);
      }
      if (body[at]?.name === 'commandComplete') {
        completed = body[at++];
        assert.ok(typeof completed.text === 'string' && /^[A-Z]/.test(completed.text), 'Malformed command tag');
      }
    }
  }
  return { at, described, completed, rows };
}
/** The whole response must be one exchange ending in one ReadyForQuery. Anything else is not a known outcome. */
export function readExchange(messages) {
  assert.ok(Array.isArray(messages));
  const list = messages.filter(message => !IGNORED_MESSAGES.has(message.name));
  const last = list.at(-1);
  assert.ok(last?.name === 'readyForQuery' && ['I', 'T', 'E'].includes(last.status), 'No ReadyForQuery ended this exchange');
  const body = list.slice(0, -1);
  assert.ok(!body.some(message => message.name === 'readyForQuery'));
  const error = body.at(-1)?.name === 'error' ? body.at(-1) : undefined;
  const replies = error ? body.slice(0, -1) : body;
  const { at, described, completed, rows } = readLegalPrefix(replies);
  assert.equal(at, replies.length, 'Replies must follow the legal order of one extended query');
  // Rows already received before an error are discarded: the statement is reported only as rejected.
  if (error) return { status: last.status, error, afterCommandComplete: completed !== undefined };
  assert.ok(described && completed, 'A successful exchange is complete');
  return { status: last.status, result: { fields: fieldsOf(described.name === 'rowDescription' ? described.fields : []), rows, commandTag: completed.text } };
}

export async function connectPgliteTransport(directory, hooks = {}) {
  const db = await PGlite.create(directory);
  hooks.opened?.(db);
  let closed = false, lost = false, status;
  const ordinary = new WeakMap();
  const exchange = async bytes => {
    try {
      const { messages } = await db.runExclusive(() => db.execProtocol(bytes, { throwOnError: false, syncToFs: true }));
      const outcome = readExchange(messages);
      status = outcome.status;
      return outcome;
    } catch (error) { lost = true; throw error; }
  };
  // The opening status also comes from the engine: a Sync alone is answered by ReadyForQuery alone.
  const { messages: opening } = await db.runExclusive(() => db.execProtocol(new Uint8Array(protocol.serialize.sync()), { throwOnError: false, syncToFs: true }));
  assert.ok(opening.length === 1 && opening[0].name === 'readyForQuery');
  status = opening[0].status;
  return {
    async query(sql, values) {
      const outcome = await exchange(extendedStatement(sql, values));
      if (outcome.error) {
        // ReadyForQuery followed on a live instance, so this was an ordinary rejection. Severity text is never read.
        if (typeof outcome.error.code === 'string' && !db.closed) ordinary.set(outcome.error, Object.freeze({ sqlstate: outcome.error.code, afterCommandComplete: outcome.afterCommandComplete }));
        throw outcome.error;
      }
      return outcome.result;
    },
    transactionStatus() { if (lost || db.closed || status === undefined) throw new Error('Lost connection'); return status; },
    serverError(error) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
    async close() { if (!closed) { closed = true; await db.close(); hooks.closed?.(db); } },
  };
}
