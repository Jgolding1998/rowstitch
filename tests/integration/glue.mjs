// Test-only transports for the internal PostgreSQL executor. Not public SDK adapters.
// Ordinary versus fatal is decided by protocol sequence, not localized severity text: a response only counts as an
// ordinary rejection once ReadyForQuery has followed it on a live connection. A fatal response has none.
import assert from 'node:assert/strict';
import { PGlite, protocol } from '@electric-sql/pglite';
import pg from 'pg';

const identity = value => value;
function rows(result) {
  assert.ok(result && !Array.isArray(result) && Array.isArray(result.rows) && Array.isArray(result.fields));
  const names = result.fields.map(field => field.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate field names cannot silently overwrite values');
  for (const field of result.fields) assert.equal(typeof field.dataTypeID, 'number');
  return { command: result.command, rows: result.rows.map(row => {
    assert.ok(Array.isArray(row) && row.length === names.length);
    for (const value of row) assert.ok(value === null || typeof value === 'string', 'Conformance transport preserves raw scalar text');
    return Object.fromEntries(names.map((name, i) => [name, row[i]]));
  }) };
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
  const ordinary = new WeakMap();
  return {
    async query(sql, values) {
      // Requests are serialized by the session, so the next ReadyForQuery belongs to this statement.
      const before = ready;
      try {
        return rows(await client.query({ text: sql, values: params(values), queryMode: 'extended', rowMode: 'array',
          types: { getTypeParser(_oid, format) { assert.ok(format === undefined || format === 'text'); return identity; } } }));
      } catch (error) {
        if (error instanceof pg.DatabaseError && typeof error.code === 'string') {
          // pg rejects at ErrorResponse, before ReadyForQuery. The executor's deadline bounds this wait.
          while (!lost && ready === before) await new Promise(resolve => { const done = () => { waiters.delete(done); resolve(); }; waiters.add(done); });
          if (!lost) ordinary.set(error, error.code);
        }
        throw error;
      }
    },
    transactionStatus() { if (lost) throw new Error('Lost connection'); return client.getTransactionStatus(); },
    serverError(error) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
    async close() { if (!closed) { closed = true; await client.end(); hooks.closed?.(client); } },
    forceClose() { client.connection.stream.destroy(); hooks.closed?.(client); },
  };
}

// PGlite through its public protocol API, so status is the real ReadyForQuery byte, not inferred from isInTransaction, which
// cannot tell T from E. One extended Parse per query refuses scripts. Everything stays raw text with its OID; the positional
// result is private, and rows() adapts it to named rows, refusing duplicate names, until the next compiler contract.
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
/** The whole response must be one exchange ending in one ReadyForQuery. Anything else is not a known outcome. */
export function readExchange(messages) {
  assert.ok(Array.isArray(messages));
  const list = messages.filter(message => !IGNORED_MESSAGES.has(message.name));
  const last = list.at(-1);
  assert.ok(last?.name === 'readyForQuery' && ['I', 'T', 'E'].includes(last.status), 'No ReadyForQuery ended this exchange');
  const body = list.slice(0, -1);
  assert.ok(!body.some(message => message.name === 'readyForQuery'));
  const errors = body.filter(message => message.name === 'error');
  if (errors.length) {
    assert.ok(errors.length === 1 && body.at(-1) === errors[0] && !body.some(message => message.name === 'commandComplete' || message.name === 'dataRow'));
    return { status: last.status, error: errors[0] };
  }
  const [parsed, bound, described, ...rest] = body;
  const completed = rest.pop();
  assert.ok(parsed?.name === 'parseComplete' && bound?.name === 'bindComplete' && completed?.name === 'commandComplete');
  assert.ok(described?.name === 'rowDescription' || described?.name === 'noData');
  assert.ok(rest.every(message => message.name === 'dataRow') && (described.name === 'rowDescription' || rest.length === 0));
  const fields = described.name === 'rowDescription' ? described.fields : [];
  assert.ok(fields.every(field => field.format === 0), 'Text results only');
  const command = /^[A-Za-z]+/.exec(completed.text)?.[0];
  assert.ok(command, 'Malformed command tag');
  return { status: last.status, result: { command, fields: fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID })), rows: rest.map(message => message.fields) } };
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
        if (typeof outcome.error.code === 'string' && !db.closed) ordinary.set(outcome.error, outcome.error.code);
        throw outcome.error;
      }
      return rows(outcome.result);
    },
    transactionStatus() { if (lost || db.closed || status === undefined) throw new Error('Lost connection'); return status; },
    serverError(error) { return error !== null && typeof error === 'object' ? ordinary.get(error) : undefined; },
    async close() { if (!closed) { closed = true; await db.close(); hooks.closed?.(db); } },
  };
}
