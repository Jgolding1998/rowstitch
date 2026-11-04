// Synthetic checks: the PGlite exchange reader against hand-made message lists, including what the engine itself could not be made to emit,
// and the real pg client against scripted protocol bytes. Scripted responses do not show that a live server emits them. Run npm run build first.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { protocol } from '@electric-sql/pglite';
import { connectPgTransport, connectPgliteTransport, readExchange } from './glue.mjs';

const distBase = new URL('../../dist/', import.meta.url).href;
const { createPostgresExecutor } = await import(distBase + 'core/postgres-executor.js');
const { createAsyncSession } = await import(distBase + 'core/async-session.js');
const { isAcknowledgedRejection } = await import(distBase + 'core/executor.js');
const { isPostgresRawResult } = await import(distBase + 'core/postgres-result.js');

const ready = status => ({ name: 'readyForQuery', status });
const error = { name: 'error', code: '23505' };
const ok = [{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'noData' }, { name: 'commandComplete', text: 'INSERT 0 1' }];

test('complete exchanges are read', () => {
  assert.deepEqual(readExchange([...ok, ready('T')]).result, { fields: [], rows: [], commandTag: 'INSERT 0 1' });
  const out = readExchange([{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 0 }] }, { name: 'notice' }, { name: 'dataRow', fields: ['9223372036854775807'] }, { name: 'commandComplete', text: 'SELECT 1' }, ready('I')]);
  assert.deepEqual(out, { status: 'I', result: { fields: [{ name: 'a', typeOid: 20 }], rows: [['9223372036854775807']], commandTag: 'SELECT 1' } });
  assert.equal(readExchange([error, ready('E')]).error, error);
  assert.equal(readExchange([{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'noData' }, error, ready('E')]).status, 'E');
});

test('an ordinary error may stop a legal exchange at any point, and its partial rows are never returned', () => {
  const [parse, bind, none, tag] = ok;
  const description = { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 0 }] };
  const row = value => ({ name: 'dataRow', fields: [value] });
  const notice = { name: 'notice' };
  for (const [name, replies] of Object.entries({
    parseError: [],
    bindError: [parse],
    describeError: [parse, bind],
    executeErrorNoRows: [parse, bind, none],
    executeErrorWithDescription: [parse, bind, description],
    afterFirstRow: [parse, bind, description, row('1')],
    afterManyRows: [parse, bind, description, row('1'), row('2')],
    afterComplete: [parse, bind, none, tag],
    afterRowsAndComplete: [parse, bind, description, row('1'), { name: 'commandComplete', text: 'INSERT 0 1' }],
    withNotices: [notice, parse, bind, notice, none, notice, tag, notice],
    zeroColumnRow: [parse, bind, { name: 'rowDescription', fields: [] }, { name: 'dataRow', fields: [] }],
  })) {
    const exchange = readExchange([...replies, error, ready('I')]);
    assert.deepEqual(Object.keys(exchange).sort(), ['afterCommandComplete', 'error', 'status'], name);
    assert.equal(exchange.error, error, name);
    assert.equal(exchange.status, 'I', name);
    assert.equal(exchange.afterCommandComplete, name === 'afterComplete' || name === 'afterRowsAndComplete' || name === 'withNotices', name);
  }
  assert.equal(readExchange([parse, bind, description, row('1'), error, ready('E')]).status, 'E', 'status is the real ReadyForQuery byte');
});

test('field OIDs are normalized to uint32 at the adapter, only after validation', () => {
  const oidOf = dataTypeID => readExchange([ok[0], ok[1], { name: 'rowDescription', fields: [{ name: 'a', dataTypeID, format: 0 }] }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I')]).result.fields[0].typeOid;
  for (const [reader, expected] of [[1, 1], [20, 20], [2147483647, 2147483647], [-2147483648, 2147483648], [-1, 4294967295], [-2, 4294967294], [2147483648, 2147483648], [4294967295, 4294967295]])
    assert.equal(oidOf(reader), expected, String(reader));
  for (const bad of [0, -0, 4294967296, -2147483649, 1.5, NaN, Infinity, '20', null, undefined, 20n]) assert.throws(() => oidOf(bad), undefined, String(bad));
});

test('the pinned PGlite parser really reads a high-bit OID as negative, and the adapter restores it exactly', () => {
  for (const [wireOid, signed] of [[2147483648, -2147483648], [4294967295, -1]]) {
    const description = describeBytes([['a', wireOid]]), messages = [];
    new protocol.Parser().parse(description, message => messages.push(message));
    assert.equal(messages[0].fields[0].dataTypeID, signed, 'if a future parser reads unsigned, this control needs revisiting');
    const exchange = readExchange([ok[0], ok[1], messages[0], { name: 'commandComplete', text: 'SELECT 0' }, ready('I')]);
    assert.equal(exchange.result.fields[0].typeOid, wireOid);
  }
});

test('a fatal shape, with no ReadyForQuery after the error, is not a known outcome whatever its severity', () => {
  for (const severity of ['FATAL', 'ERROR', 'ERREUR']) assert.throws(() => readExchange([{ ...error, severity }]));
  assert.throws(() => readExchange([]));
  assert.throws(() => readExchange([...ok]));
});

test('malformed exchanges are refused', () => {
  for (const [name, messages] of Object.entries({
    badStatus: [...ok, ready('X')],
    noStatus: [...ok, ready(undefined)],
    twoReady: [...ok, ready('I'), ready('I')],
    readyThenMore: [ready('I'), ...ok, ready('I')],
    twoErrors: [error, error, ready('E')],
    twoErrorsAfterPrefix: [ok[0], ok[1], ok[2], error, error, ready('E')],
    errorNotLast: [error, { name: 'parseComplete' }, ready('E')],
    errorThenComplete: [ok[0], ok[1], ok[2], error, ok[3], ready('E')],
    errorThenRow: [ok[0], ok[1], { name: 'rowDescription', fields: [] }, error, { name: 'dataRow', fields: [] }, ready('E')],
    errorThenReady: [...ok, error, ready('I'), ready('I')],
    readyThenError: [ready('I'), error, ready('I')],
    errorAfterBindOnly: [ok[1], error, ready('E')],
    errorAfterDescribeOnly: [ok[2], error, ready('E')],
    errorAfterSwappedPrefix: [ok[1], ok[0], error, ready('E')],
    errorAfterDescribeWithoutBind: [ok[0], ok[2], error, ready('E')],
    errorAfterCompleteWithoutDescribe: [ok[0], ok[1], ok[3], error, ready('E')],
    errorAfterCompleteOnly: [ok[3], error, ready('E')],
    errorAfterTwoParses: [ok[0], ok[0], error, ready('E')],
    errorAfterTwoBinds: [ok[0], ok[1], ok[1], error, ready('E')],
    errorAfterTwoDescriptions: [ok[0], ok[1], ok[2], ok[2], error, ready('E')],
    errorAfterTwoCompletes: [...ok, ok[3], error, ready('E')],
    errorAfterRowWithoutDescription: [ok[0], ok[1], { name: 'dataRow', fields: [] }, error, ready('E')],
    errorAfterRowAfterNoData: [ok[0], ok[1], ok[2], { name: 'dataRow', fields: [] }, error, ready('E')],
    errorAfterRowAfterComplete: [ok[0], ok[1], { name: 'rowDescription', fields: [] }, { name: 'commandComplete', text: 'SELECT 0' }, { name: 'dataRow', fields: [] }, error, ready('E')],
    errorAfterWrongWidthRow: [ok[0], ok[1], { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 0 }] }, { name: 'dataRow', fields: ['1', '2'] }, error, ready('E')],
    errorAfterBinaryDescription: [ok[0], ok[1], { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 1 }] }, error, ready('E')],
    errorAfterBadTag: [ok[0], ok[1], ok[2], { name: 'commandComplete', text: '123' }, error, ready('E')],
    errorAfterCopyOut: [ok[0], ok[1], ok[2], { name: 'copyOutResponse' }, error, ready('E')],
    errorAfterCopyIn: [ok[0], ok[1], ok[2], { name: 'copyInResponse' }, error, ready('E')],
    errorAfterCopyData: [ok[0], ok[1], { name: 'rowDescription', fields: [] }, { name: 'copyData' }, error, ready('E')],
    errorAfterEmptyQuery: [ok[0], ok[1], ok[2], { name: 'emptyQueryResponse' }, error, ready('E')],
    errorAfterSuspended: [ok[0], ok[1], ok[2], { name: 'portalSuspended' }, error, ready('E')],
    errorAfterUnknown: [ok[0], { name: 'surprise' }, error, ready('E')],
    errorWithoutReady: [ok[0], ok[1], ok[2], error],
    rowDescriptionNotAList: [ok[0], ok[1], { name: 'rowDescription', fields: 'a' }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I')],
    rowNotAList: [ok[0], ok[1], { name: 'rowDescription', fields: [] }, { name: 'dataRow', fields: 'x' }, { name: 'commandComplete', text: 'SELECT 1' }, ready('I')],
    onlyPrefix: [ok[0], ready('I')],
    empty: [ready('I')],
    swappedPrefix: [ok[1], ok[0], ok[2], ok[3], ready('I')],
    wrongDescribe: [ok[0], ok[1], { name: 'copyOutResponse' }, ok[3], ready('I')],
    noParse: ok.slice(1).concat(ready('I')),
    noBind: [ok[0], ...ok.slice(2), ready('I')],
    noDescribe: [ok[0], ok[1], ok[3], ready('I')],
    noComplete: [...ok.slice(0, 3), ready('I')],
    rowsWithoutDescription: [ok[0], ok[1], ok[2], { name: 'dataRow', fields: ['x'] }, ok[3], ready('I')],
    otherInBody: [ok[0], ok[1], ok[2], { name: 'copyOutResponse' }, ok[3], ready('I')],
    emptyQuery: [ok[0], ok[1], ok[2], { name: 'emptyQueryResponse' }, ready('I')],
    binaryField: [ok[0], ok[1], { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 1 }] }, { name: 'commandComplete', text: 'SELECT 0' }, ready('I')],
    badTag: [ok[0], ok[1], ok[2], { name: 'commandComplete', text: '123' }, ready('I')],
    notArray: 'readyForQuery',
  })) assert.throws(() => readExchange(messages), undefined, name);
});

function wire(type, body = Buffer.alloc(0)) {
  const head = Buffer.alloc(5); head.write(type, 0, 'latin1'); head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const text = value => Buffer.from(value + '\0', 'utf8');
const complete = tag => wire('C', text(tag));
const wireReady = status => wire('Z', Buffer.from(status, 'latin1'));
const noData = wire('n');
function describeBytes(fields) {
  const count = Buffer.alloc(2); count.writeInt16BE(fields.length);
  return wire('T', Buffer.concat([count, ...fields.flatMap(([name, oid]) => {
    const meta = Buffer.alloc(18); meta.writeUInt32BE(oid, 6); meta.writeInt16BE(-1, 10); meta.writeInt32BE(-1, 12);
    return [text(name), meta];
  })]));
}
const describe = describeBytes;
function dataRow(cells) {
  const count = Buffer.alloc(2); count.writeInt16BE(cells.length);
  return wire('D', Buffer.concat([count, ...cells.flatMap(cell => {
    const length = Buffer.alloc(4);
    if (cell === null) { length.writeInt32BE(-1); return [length]; }
    const bytes = Buffer.from(cell, 'utf8'); length.writeInt32BE(bytes.length);
    return [length, bytes];
  })]));
}
const wireError = state => wire('E', Buffer.from('SERROR\0C' + state + '\0MSYNTHETIC_PRIVATE_DETAIL\0\0', 'utf8'));
const PREFIX = Buffer.concat([wire('1'), wire('2')]);
const statement = (...parts) => Buffer.concat([PREFIX, ...parts]);
/** script(sql, socket, api) answers one Sync. Only the protocol: no engine and no SQL execution. */
async function scripted(t, script) {
  const sockets = new Set(), seen = [], api = { status: 'I' };
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0), started = false, sql = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          socket.write(Buffer.concat([wire('R', Buffer.alloc(4)), wireReady('I')]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffer[0]), length = buffer.readInt32BE(1), body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        if (type === 'P') sql = body.toString('utf8', body.indexOf(0) + 1, body.indexOf(0, body.indexOf(0) + 1));
        if (type === 'X') socket.end();
        if (type === 'S') { seen.push(sql); script(sql, socket, api); }
      }
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); });
  const transport = await connectPgTransport({ host: '127.0.0.1', port: server.address().port, user: 'fixture', database: 'fixture', connectionTimeoutMillis: 2000, ssl: false, options: '' });
  return { executor: createPostgresExecutor(transport), seen, api };
}
const unconfirmed = error => !isAcknowledgedRejection(error) && !/SYNTHETIC/.test(error.message);

test('the real pg client: exact counts past Number range, duplicate names, OIDs, raw text and NULL stay exact', async t => {
  const answers = {
    'UPDATE big': statement(noData, complete('UPDATE 18446744073709551615')),
    'UPDATE odd': statement(noData, complete('UPDATE 9007199254740993')),
    'SELECT dup': statement(describe([['a', 20], ['a', 25], ['é𝄞', 4294967]]), dataRow(['9223372036854775807', 'é𝄞', null]), complete('SELECT 1')),
    'SELECT none': statement(describe([['a', 16]]), complete('SELECT 0')),
  };
  const { executor } = await scripted(t, (sql, socket) => socket.write(Buffer.concat([answers[sql], wireReady('I')])));
  assert.deepEqual(await executor.all('UPDATE big', []), { fields: [], rows: [], command: 'UPDATE', rowCount: 18446744073709551615n });
  assert.deepEqual(await executor.all('UPDATE odd', []), { fields: [], rows: [], command: 'UPDATE', rowCount: 9007199254740993n }, 'a rounded Number would end in 992');
  const duplicate = await executor.all('SELECT dup', []);
  assert.deepEqual(duplicate, { fields: [{ name: 'a', typeOid: 20 }, { name: 'a', typeOid: 25 }, { name: 'é𝄞', typeOid: 4294967 }], rows: [['9223372036854775807', 'é𝄞', null]], command: 'SELECT', rowCount: 1n });
  assert.ok(isPostgresRawResult(duplicate));
  assert.deepEqual(await executor.all('SELECT none', []), { fields: [{ name: 'a', typeOid: 16 }], rows: [], command: 'SELECT', rowCount: 0n });
  await executor.close();
});

test('the real pg client: high-bit OIDs stay exact uint32, and an OID of zero is refused', async t => {
  const answers = {
    'SELECT high': statement(describe([['a', 2147483648], ['a', 4294967295], ['b', 2147483647]]), complete('SELECT 0')),
    'SELECT zero': statement(describe([['a', 0]]), complete('SELECT 0')),
  };
  const { executor, seen } = await scripted(t, (sql, socket) => socket.write(Buffer.concat([answers[sql], wireReady('I')])));
  assert.deepEqual((await executor.all('SELECT high', [])).fields, [{ name: 'a', typeOid: 2147483648 }, { name: 'a', typeOid: 4294967295 }, { name: 'b', typeOid: 2147483647 }]);
  await assert.rejects(executor.all('SELECT zero', []), unconfirmed);
  await assert.rejects(executor.all('SELECT high', []), unconfirmed, 'the connection ended');
  assert.deepEqual(seen, ['SELECT high', 'SELECT zero']);
  await executor.close();
});

test('the real pg client: rows before an ordinary error are never returned, and the connection stays usable', async t => {
  const { executor } = await scripted(t, (sql, socket) => {
    if (sql === 'SELECT partial') return socket.write(Buffer.concat([statement(describe([['a', 25]]), dataRow(['SYNTHETIC_PARTIAL_ROW'])), wireError('22012'), wireReady('I')]));
    socket.write(Buffer.concat([statement(noData, complete('UPDATE 3')), wireReady('I')]));
  });
  await assert.rejects(executor.all('SELECT partial', []), error => error.code === 'DATABASE_ERROR' && isAcknowledgedRejection(error) && !/SYNTHETIC/.test(error.message));
  assert.equal((await executor.all('UPDATE next', [])).rowCount, 3n);
  await executor.close();
});

test('the real pg client: malformed, repeated, missing and mismatched tags are unknown outcomes, and nothing more is sent', async t => {
  const cases = {
    'leading zero': statement(noData, complete('UPDATE 01')),
    'legacy oid': statement(noData, complete('INSERT 5 1')),
    'no count': statement(noData, complete('SELECT')),
    'lower case': statement(noData, complete('update 1')),
    'too large': statement(noData, complete('UPDATE 18446744073709551616')),
    'twice': statement(noData, complete('UPDATE 1'), complete('UPDATE 1')),
    'two different': statement(noData, complete('UPDATE 1'), complete('DELETE 2')),
    'missing': statement(noData),
    'counts other rows': statement(describe([['a', 25]]), dataRow(['x']), complete('SELECT 2')),
    'counts no rows': statement(describe([['a', 25]]), dataRow(['x']), complete('SELECT 0')),
  };
  for (const [name, response] of Object.entries(cases)) {
    const { executor, seen } = await scripted(t, (sql, socket) => socket.write(Buffer.concat([response, wireReady('I')])));
    await assert.rejects(executor.all('SELECT 1', []), unconfirmed, name);
    await assert.rejects(executor.all('SELECT 2', []), unconfirmed, name);
    assert.deepEqual(seen, ['SELECT 1'], name);
    await executor.close().catch(() => {});
  }
});

test('the real pg client: a stale tag arriving between requests ends the connection, and is never given to the next one', async t => {
  const { executor, seen } = await scripted(t, (sql, socket) => {
    socket.write(Buffer.concat([statement(noData, complete('UPDATE 1')), wireReady('I')]));
    setTimeout(() => socket.write(complete('DELETE 999')), 20);
  });
  assert.equal((await executor.all('UPDATE first', [])).rowCount, 1n);
  await new Promise(done => setTimeout(done, 60));
  await assert.rejects(executor.all('UPDATE second', []), unconfirmed);
  assert.deepEqual(seen, ['UPDATE first']);
  await executor.close().catch(() => {});
});

test('the real pg client: a tag followed by an ordinary error at Sync is a definite rejection, not a success', async t => {
  const { executor } = await scripted(t, (sql, socket) => {
    if (sql === 'INSERT deferred') return socket.write(Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('23503'), wireReady('I')]));
    socket.write(Buffer.concat([statement(noData, complete('UPDATE 7')), wireReady('I')]));
  });
  await assert.rejects(executor.all('INSERT deferred', []), error => error.code === 'CONSTRAINT' && isAcknowledgedRejection(error));
  assert.equal((await executor.all('UPDATE next', [])).rowCount, 7n, 'the next request uses only its own tag');
  await executor.close();
});

test('scripted only: in autocommit, an error after the tag is held to the COMMIT list, and before the tag it is not', async t => {
  const script = (sql, socket, api) => {
    const rows = statement(describe([['a', 25]]), dataRow(['SYNTHETIC_PARTIAL_ROW']));
    const answers = {
      'INSERT after-53100': Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('53100'), wireReady('I')]),
      'INSERT after-42501': Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('42501'), wireReady('I')]),
      'INSERT returning-after-53100': Buffer.concat([rows, complete('INSERT 0 1'), wireError('53100'), wireReady('I')]),
      'INSERT after-23503': Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('23503'), wireReady('I')]),
      'INSERT after-40001': Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('40001'), wireReady('I')]),
      'INSERT before-53100': Buffer.concat([statement(noData), wireError('53100'), wireReady('I')]),
      'SELECT partial-53100': Buffer.concat([rows, wireError('53100'), wireReady('I')]),
      'INSERT parse-53100': Buffer.concat([wireError('53100'), wireReady('I')]),
    };
    if (answers[sql]) return socket.write(answers[sql]);
    socket.write(Buffer.concat([statement(noData, complete('UPDATE 1')), wireReady(api.status)]));
  };
  for (const [sql, expected] of [['INSERT after-23503', 'CONSTRAINT'], ['INSERT after-40001', 'SERIALIZATION_FAILURE'], ['INSERT before-53100', 'DATABASE_ERROR'], ['SELECT partial-53100', 'DATABASE_ERROR'], ['INSERT parse-53100', 'DATABASE_ERROR']]) {
    const { executor } = await scripted(t, script);
    await assert.rejects(executor.all(sql, []), error => error.code === expected && isAcknowledgedRejection(error) && !/SYNTHETIC/.test(error.message), sql);
    assert.equal((await executor.all('UPDATE next', [])).rowCount, 1n, sql);
    await executor.close();
  }
  for (const sql of ['INSERT after-53100', 'INSERT after-42501', 'INSERT returning-after-53100']) {
    const { executor, seen } = await scripted(t, script);
    await assert.rejects(executor.all(sql, []), unconfirmed, sql);
    await assert.rejects(executor.all('UPDATE next', []), unconfirmed, sql);
    assert.deepEqual(seen, [sql], 'nothing replayed and nothing more sent');
    await executor.close();
  }
});

test('scripted only: an earlier request\'s tag is never counted for a later error', async t => {
  const { executor } = await scripted(t, (sql, socket) => {
    if (sql === 'UPDATE first') return socket.write(Buffer.concat([statement(noData, complete('UPDATE 1')), wireReady('I')]));
    socket.write(Buffer.concat([statement(noData), wireError('53100'), wireReady('I')]));
  });
  assert.equal((await executor.all('UPDATE first', [])).rowCount, 1n);
  await assert.rejects(executor.all('INSERT second', []), error => error.code === 'DATABASE_ERROR' && isAcknowledgedRejection(error), 'no tag belongs to this request');
  await executor.close();
});

test('scripted only: successive ordinary errors on one connection are each judged on their own request', async t => {
  const { executor } = await scripted(t, (sql, socket) => {
    if (sql === 'INSERT tagged') return socket.write(Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('23503'), wireReady('I')]));
    socket.write(Buffer.concat([statement(noData), wireError('53100'), wireReady('I')]));
  });
  for (const sql of ['INSERT plain', 'INSERT plain', 'INSERT tagged', 'INSERT plain', 'INSERT tagged']) await assert.rejects(executor.all(sql, []), isAcknowledgedRejection, sql);
  await executor.close();
});

test('embedded PGlite: the verdict reports whether a tag of this same request came before its error', async () => {
  const directory = resolve(mkdtempSync(join(resolve(tmpdir()), 'rowstitch-verdict-')));
  const transport = await connectPgliteTransport(directory);
  try {
    const verdict = sql => transport.query(sql, []).then(() => assert.fail(sql), error => transport.serverError(error));
    await transport.query('CREATE TABLE verdict_parents(id BIGINT PRIMARY KEY)', []);
    await transport.query('CREATE TABLE verdict_children(id BIGINT PRIMARY KEY, parent_id BIGINT REFERENCES verdict_parents(id) DEFERRABLE INITIALLY DEFERRED)', []);
    assert.deepEqual(await verdict('INSERT INTO verdict_children VALUES (1,99)'), { sqlstate: '23503', afterCommandComplete: true });
    assert.deepEqual(await verdict('SELECT 1/(2-g) FROM pg_catalog.generate_series(1,3) g'), { sqlstate: '22012', afterCommandComplete: false });
    assert.deepEqual(await verdict('SELECT * FROM verdict_absent'), { sqlstate: '42P01', afterCommandComplete: false });
    assert.equal(transport.serverError(new Error('fictional')), undefined);
  } finally {
    await transport.close();
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep) && directory.includes('rowstitch-verdict-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scripted only: repeated tags, a tag after the error, or two errors are not ordinary, whatever the code', async t => {
  for (const [name, response] of Object.entries({
    'two tags then error': Buffer.concat([statement(noData, complete('INSERT 0 1'), complete('INSERT 0 1')), wireError('23503'), wireReady('I')]),
    'error then tag': Buffer.concat([statement(noData), wireError('23503'), complete('INSERT 0 1'), wireReady('I')]),
    'two errors': Buffer.concat([statement(noData), wireError('23503'), wireError('23503'), wireReady('I')]),
    'error, no ready, then close': Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('23503')]),
  })) {
    const { executor } = await scripted(t, (sql, socket) => { socket.write(response); if (name.endsWith('close')) socket.end(); });
    await assert.rejects(executor.all('INSERT 1', []), unconfirmed, name);
    await assert.rejects(executor.all('INSERT 2', []), unconfirmed, name);
    await executor.close().catch(() => {});
  }
});

test('scripted only: in an open transaction, an error after a tag keeps the ordinary rule', async t => {
  const { executor } = await scripted(t, (sql, socket, api) => {
    if (sql.startsWith('BEGIN')) { api.status = 'T'; return socket.write(Buffer.concat([statement(noData, complete('BEGIN')), wireReady('T')])); }
    if (sql === 'INSERT in-tx') { api.status = 'E'; return socket.write(Buffer.concat([statement(noData, complete('INSERT 0 1')), wireError('53100'), wireReady('E')])); }
    if (sql === 'ROLLBACK') { api.status = 'I'; return socket.write(Buffer.concat([statement(noData, complete('ROLLBACK')), wireReady('I')])); }
    socket.write(Buffer.concat([statement(noData, complete('UPDATE 1')), wireReady(api.status)]));
  });
  await executor.exec('BEGIN READ ONLY');
  await assert.rejects(executor.all('INSERT in-tx', []), error => error.code === 'DATABASE_ERROR' && isAcknowledgedRejection(error));
  await executor.exec('ROLLBACK');
  assert.equal(await executor.inTransaction(), false);
  await executor.close();
});

test('the real pg client: a control answer with fields, rows or a count is unconfirmed through a real session', async t => {
  for (const [name, response] of Object.entries({
    fields: statement(describe([['a', 25]]), complete('COMMIT')),
    count: statement(noData, complete('COMMIT 1')),
    words: statement(noData, complete('COMMIT PREPARED')),
  })) {
    const { executor, seen } = await scripted(t, (sql, socket, api) => {
      if (sql === 'COMMIT') { api.status = 'I'; return socket.write(Buffer.concat([response, wireReady('I')])); }
      if (sql.startsWith('BEGIN')) { api.status = 'T'; return socket.write(Buffer.concat([statement(noData, complete('BEGIN')), wireReady('T')])); }
      socket.write(Buffer.concat([statement(noData, complete('SELECT 0')), wireReady(api.status)]));
    });
    const session = createAsyncSession(executor, { dialect: 'postgresql', isResult: isPostgresRawResult });
    await assert.rejects(session.transaction(() => 1), error => error.code === 'COMMIT_UNCONFIRMED', name);
    assert.ok(!seen.includes('ROLLBACK'), name);
    await session.close();
  }
});
