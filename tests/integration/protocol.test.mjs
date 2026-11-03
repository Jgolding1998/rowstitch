// Synthetic checks: the PGlite exchange reader against hand-made message lists, including what the engine itself could not be made to emit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readExchange } from './glue.mjs';

const ready = status => ({ name: 'readyForQuery', status });
const error = { name: 'error', code: '23505' };
const ok = [{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'noData' }, { name: 'commandComplete', text: 'INSERT 0 1' }];

test('complete exchanges are read', () => {
  assert.deepEqual(readExchange([...ok, ready('T')]).result, { command: 'INSERT', fields: [], rows: [] });
  const out = readExchange([{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'rowDescription', fields: [{ name: 'a', dataTypeID: 20, format: 0 }] }, { name: 'notice' }, { name: 'dataRow', fields: ['9223372036854775807'] }, { name: 'commandComplete', text: 'SELECT 1' }, ready('I')]);
  assert.deepEqual(out, { status: 'I', result: { command: 'SELECT', fields: [{ name: 'a', dataTypeID: 20 }], rows: [['9223372036854775807']] } });
  assert.equal(readExchange([error, ready('E')]).error, error);
  assert.equal(readExchange([{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'noData' }, error, ready('E')]).status, 'E');
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
    errorAfterComplete: [...ok, error, ready('E')],
    twoErrors: [error, error, ready('E')],
    errorNotLast: [error, { name: 'parseComplete' }, ready('E')],
    errorWithRows: [{ name: 'parseComplete' }, { name: 'bindComplete' }, { name: 'rowDescription', fields: [] }, { name: 'dataRow', fields: [] }, error, ready('E')],
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
