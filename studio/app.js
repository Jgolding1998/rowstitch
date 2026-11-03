// Rowstitch Studio: a read-only, local inspector for Rowstitch trace documents.
// Every value from a trace is untrusted text. It is rendered with textContent and numeric SVG attributes only.
// Nothing here executes SQL, stores data in the browser, or requests anything except GET /api/demo.
'use strict';

(() => {
  const LIMITS = Object.freeze({
    bytes: 2 * 1024 * 1024,
    depth: 8,
    nodes: 400000,
    string: 4096,
    tables: 100,
    columns: 100,
    foreignKeys: 100,
    queries: 1000,
    parameters: 1000,
    planSteps: 200,
    results: 20,
    resultColumns: 60,
    resultRows: 500,
    notes: 100,
  });
  const OPERATIONS = ['select', 'insert', 'update', 'delete', 'schema', 'transaction'];
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const REDACTED = '[redacted]';
  const SQL_KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX ' +
    'UNIQUE IF EXISTS PRIMARY KEY REFERENCES FOREIGN DEFAULT ORDER BY ASC DESC LIMIT OFFSET GROUP HAVING JOIN LEFT INNER OUTER ' +
    'CROSS ON AS DISTINCT COUNT RETURNING BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TO TRANSACTION IMMEDIATE DEFERRED EXCLUSIVE ' +
    'INTEGER TEXT REAL BLOB NUMERIC CHECK CONSTRAINT LIKE GLOB BETWEEN CASE WHEN THEN ELSE END UNION ALL EXCEPT INTERSECT WITH ' +
    'RECURSIVE CONFLICT DO NOTHING REPLACE ABORT FAIL IGNORE STRICT WITHOUT ROWID COLLATE NOCASE EXPLAIN QUERY PLAN').split(' '));

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  class TraceError extends Error {}
  const fail = (path, message) => { throw new TraceError(path ? `${path} ${message}` : message); };
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  }

  function checkKeys(value, path, required, optional) {
    if (!isPlainObject(value)) fail(path, 'must be an object');
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key)) fail(path, `has an unexpected field "${clip(key, 40)}"`);
    }
    for (const key of required) if (!has(value, key)) fail(path, `is missing "${key}"`);
  }

  function text(value, path, { allowEmpty = true, max = LIMITS.string } = {}) {
    if (typeof value !== 'string') fail(path, 'must be text');
    if (!allowEmpty && value.trim() === '') fail(path, 'must not be empty');
    if (value.length > max) fail(path, `is longer than ${max.toLocaleString('en-US')} characters`);
    return value;
  }

  function list(value, path, max) {
    if (!Array.isArray(value)) fail(path, 'must be a list');
    if (value.length > max) fail(path, `has ${value.length.toLocaleString('en-US')} items, the limit is ${max.toLocaleString('en-US')}`);
    return value;
  }

  function bool(value, path) {
    if (typeof value !== 'boolean') fail(path, 'must be true or false');
    return value;
  }

  function scalar(value, path) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(path, 'must be a finite number');
      return value;
    }
    if (typeof value === 'string') return text(value, path);
    return fail(path, 'must be text, a number, true, false or null');
  }

  function nullableNumber(value, path, { integer = false } = {}) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, 'must be a number of zero or more, or null');
    if (integer && !Number.isSafeInteger(value)) fail(path, 'must be a whole number');
    return value;
  }

  // Cheap scan before JSON.parse so a hostile file cannot nest deeply enough to stress the parser or the validator.
  function nestingDepth(source) {
    let depth = 0;
    let max = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const c = source.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) inString = false;
      } else if (c === 34) {
        inString = true;
      } else if (c === 123 || c === 91) {
        depth += 1;
        if (depth > max) {
          max = depth;
          if (max > LIMITS.depth) return max;
        }
      } else if (c === 125 || c === 93) {
        depth -= 1;
      }
    }
    return max;
  }

  function parseTrace(source) {
    const body = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    if (body.trim() === '') fail('', 'The file is empty.');
    if (nestingDepth(body) > LIMITS.depth) fail('', `The file nests deeper than a Rowstitch trace can (more than ${LIMITS.depth} levels).`);
    let nodes = 0;
    let raw;
    try {
      raw = JSON.parse(body, (key, value) => {
        if (FORBIDDEN_KEYS.has(key)) throw new TraceError(`The file uses the reserved field name "${key}", which is not allowed.`);
        nodes += 1;
        if (nodes > LIMITS.nodes) throw new TraceError(`The file holds more than ${LIMITS.nodes.toLocaleString('en-US')} values, more than a trace may.`);
        return value;
      });
    } catch (error) {
      if (error instanceof TraceError) throw error;
      fail('', 'The file is not valid JSON.');
    }
    return normalizeTrace(raw);
  }

  function normalizeTrace(raw) {
    if (!isPlainObject(raw)) fail('', 'The file is JSON, but not a Rowstitch trace object.');
    if (raw.format !== 'rowstitch-trace') fail('', 'This is not a Rowstitch trace: "format" must be "rowstitch-trace".');
    if (raw.version !== 1) fail('', 'This trace version is not supported. The studio reads version 1.');
    checkKeys(raw, 'The trace', ['format', 'version', 'title', 'generatedAt', 'source', 'schema', 'queries'], ['results', 'notes']);

    const title = text(raw.title, '"title"');
    const generatedAt = text(raw.generatedAt, '"generatedAt"', { max: 64 });
    // Date.parse quietly rolls impossible dates over (2026-02-30 becomes 2026-03-02), so check the fields themselves.
    const stamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(generatedAt);
    const fieldsValid = stamp && (() => {
      const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((k) => Number(stamp[k] || 0));
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const zoneOk = stamp[7] === 'Z' || (Number(stamp[8]) <= 23 && Number(stamp[9]) <= 59);
      return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 && zoneOk;
    })();
    if (!fieldsValid || !Number.isFinite(Date.parse(generatedAt))) {
      fail('"generatedAt"', 'must be a real ISO 8601 date and time');
    }
    if (raw.source !== 'fictional-demo' && raw.source !== 'local-trace') fail('"source"', 'must be "fictional-demo" or "local-trace"');

    const schema = list(raw.schema, '"schema"', LIMITS.tables).map((table, t) => {
      const at = `schema[${t}]`;
      checkKeys(table, at, ['name', 'columns'], ['foreignKeys']);
      const columns = list(table.columns, `${at}.columns`, LIMITS.columns).map((column, c) => {
        const cat = `${at}.columns[${c}]`;
        checkKeys(column, cat, ['name', 'type', 'nullable', 'primaryKey'], []);
        return {
          name: text(column.name, `${cat}.name`, { allowEmpty: false }),
          type: text(column.type, `${cat}.type`),
          nullable: bool(column.nullable, `${cat}.nullable`),
          primaryKey: bool(column.primaryKey, `${cat}.primaryKey`),
        };
      });
      const foreignKeys = has(table, 'foreignKeys')
        ? list(table.foreignKeys, `${at}.foreignKeys`, LIMITS.foreignKeys).map((fk, f) => {
          const fat = `${at}.foreignKeys[${f}]`;
          checkKeys(fk, fat, ['column', 'table', 'target'], []);
          return {
            column: text(fk.column, `${fat}.column`, { allowEmpty: false }),
            table: text(fk.table, `${fat}.table`, { allowEmpty: false }),
            target: text(fk.target, `${fat}.target`, { allowEmpty: false }),
          };
        })
        : [];
      return { name: text(table.name, `${at}.name`, { allowEmpty: false }), columns, foreignKeys };
    });

    const seenIds = new Set();
    const queries = list(raw.queries, '"queries"', LIMITS.queries).map((query, i) => {
      const at = `queries[${i}]`;
      checkKeys(query, at, ['id', 'operation', 'sql', 'parameters', 'status'], ['table', 'durationMs', 'rowCount', 'transactionId', 'plan']);
      const id = text(query.id, `${at}.id`, { allowEmpty: false, max: 200 });
      if (seenIds.has(id)) fail(`${at}.id`, 'repeats an id used by an earlier statement');
      seenIds.add(id);
      if (!OPERATIONS.includes(query.operation)) fail(`${at}.operation`, `must be one of ${OPERATIONS.join(', ')}`);
      if (query.status !== 'ok' && query.status !== 'error') fail(`${at}.status`, 'must be "ok" or "error"');
      // An empty table string means the statement has no associated table (for example BEGIN or COMMIT).
      // It is kept as loaded so an export matches the original document.
      const table = query.table === undefined || query.table === null ? null : text(query.table, `${at}.table`);
      const transactionId = query.transactionId === undefined || query.transactionId === null
        ? null : text(query.transactionId, `${at}.transactionId`, { allowEmpty: false, max: 200 });
      const parameters = list(query.parameters, `${at}.parameters`, LIMITS.parameters).map((p, k) => scalar(p, `${at}.parameters[${k}]`));
      let plan = null;
      if (query.plan !== undefined && query.plan !== null) {
        plan = list(query.plan, `${at}.plan`, LIMITS.planSteps).map((step, s) => {
          const sat = `${at}.plan[${s}]`;
          checkKeys(step, sat, ['detail'], ['id', 'parent']);
          const out = { detail: text(step.detail, `${sat}.detail`) };
          if (has(step, 'id')) out.id = nullableNumber(step.id, `${sat}.id`, { integer: true });
          if (has(step, 'parent')) out.parent = nullableNumber(step.parent, `${sat}.parent`, { integer: true });
          return out;
        });
      }
      return {
        id,
        operation: query.operation,
        table,
        sql: text(query.sql, `${at}.sql`, { allowEmpty: false }),
        parameters,
        durationMs: query.durationMs === undefined ? null : nullableNumber(query.durationMs, `${at}.durationMs`),
        rowCount: query.rowCount === undefined ? null : nullableNumber(query.rowCount, `${at}.rowCount`, { integer: true }),
        transactionId,
        status: query.status,
        plan,
      };
    });

    const doc = { format: 'rowstitch-trace', version: 1, title, generatedAt, source: raw.source, schema, queries };
    if (has(raw, 'results')) {
      doc.results = list(raw.results, '"results"', LIMITS.results).map((result, r) => {
        const at = `results[${r}]`;
        checkKeys(result, at, ['title', 'columns', 'rows'], []);
        const columns = list(result.columns, `${at}.columns`, LIMITS.resultColumns).map((c, k) => text(c, `${at}.columns[${k}]`));
        const rows = list(result.rows, `${at}.rows`, LIMITS.resultRows).map((row, k) => {
          list(row, `${at}.rows[${k}]`, LIMITS.resultColumns);
          if (row.length !== columns.length) fail(`${at}.rows[${k}]`, `has ${row.length} cells but there are ${columns.length} columns`);
          return row.map((cell, j) => scalar(cell, `${at}.rows[${k}][${j}]`));
        });
        return { title: text(result.title, `${at}.title`), columns, rows };
      });
    }
    if (has(raw, 'notes')) {
      doc.notes = list(raw.notes, '"notes"', LIMITS.notes).map((note, k) => text(note, `notes[${k}]`));
    }
    return doc;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (text only)
  // ---------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  // Bidirectional overrides and other invisible format characters can make text read differently from what it is
  // (for example a file name that looks like ".png" but ends in ".exe"). Show them as visible code points instead.
  const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
  const visible = (value) => String(value).replace(INVISIBLE, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
  function setText(node, value) { node.textContent = visible(value); }
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) setText(node, content);
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, typeof value === 'number' ? String(Math.round(value * 100) / 100) : value);
    return node;
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  function formatMs(ms) {
    if (ms === null) return 'not recorded';
    // Each duration is finite, but a sum of very large ones can overflow; say so instead of printing Infinity.
    if (!Number.isFinite(ms)) return 'too large to add up';
    if (ms === 0) return '0 ms';
    if (ms >= 1e12) return `${(ms / 1000).toExponential(2)} s`;
    if (ms < 0.01) return '<0.01 ms';
    if (ms < 10) return `${ms.toFixed(2)} ms`;
    if (ms < 1000) return `${ms.toFixed(1)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  function formatValue(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value.length > 400 ? `${value.slice(0, 399)}…` : value);
    return String(value);
  }
  function opLabel(op) { return op.charAt(0).toUpperCase() + op.slice(1); }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    doc: null,
    origin: '',
    generation: 0,
    abort: null,
    selected: -1,
    search: '',
    op: 'all',
    errorsOnly: false,
    table: null,
    showValues: false,
    view: 'queries',
    rowButtons: [],
    paramRows: [],
  };

  // ---------------------------------------------------------------------------
  // Notices
  // ---------------------------------------------------------------------------

  function setStatus(message) { setText($('status'), message); }
  function showError(message) {
    setText($('error-text'), message);
    $('error').hidden = false;
  }
  function hideError() {
    $('error').hidden = true;
    $('error-text').textContent = '';
  }
  function setBusy(busy, message) {
    document.body.classList.toggle('is-busy', busy);
    $('main').setAttribute('aria-busy', busy ? 'true' : 'false');
    updateClearButton();
    if (message) setStatus(message);
  }

  // ---------------------------------------------------------------------------
  // Loading (every path is guarded by a generation token)
  // ---------------------------------------------------------------------------

  function beginLoad() {
    state.generation += 1;
    if (state.abort) state.abort.abort();
    state.abort = null;
    return state.generation;
  }

  function decode(buffer) {
    if (buffer.byteLength > LIMITS.bytes) fail('', `The trace is ${formatBytes(buffer.byteLength)}. The limit is 2 MiB.`);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return fail('', 'The file is not UTF-8 text.');
    }
  }

  async function loadDemo() {
    const generation = beginLoad();
    const controller = new AbortController();
    state.abort = controller;
    hideError();
    setBusy(true, 'Loading the fictional demo');
    try {
      const response = await fetch('/api/demo', {
        method: 'GET', signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (generation !== state.generation) return;
      if (!response.ok) fail('', `The local server answered ${response.status} for the demo.`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > LIMITS.bytes) fail('', 'The demo is larger than 2 MiB.');
      const buffer = await response.arrayBuffer();
      if (generation !== state.generation) return;
      const doc = parseTrace(decode(buffer));
      if (doc.source !== 'fictional-demo') fail('', 'The demo endpoint did not return a fictional demo, so it was not shown.');
      applyDocument(doc, 'Served by this local studio');
      setStatus(`Loaded the fictional demo: ${plural(doc.queries.length, 'statement', 'statements')}`);
    } catch (error) {
      if (generation !== state.generation || (error && error.name === 'AbortError')) return;
      const reason = error instanceof TraceError ? error.message : 'The local server could not be reached.';
      showError(`The demo did not load. ${reason}${state.doc ? ' The previous trace is still shown.' : ''}`);
      setStatus('');
    } finally {
      if (generation === state.generation) {
        state.abort = null;
        setBusy(false);
      }
    }
  }

  async function importFile(file) {
    const generation = beginLoad();
    hideError();
    const name = clip(String(file.name || 'unnamed file'), 80);
    const keep = state.doc ? ' The previous trace is still shown.' : '';
    if (file.size > LIMITS.bytes) {
      showError(`"${name}" is ${formatBytes(file.size)}. Traces must be 2 MiB or smaller.${keep}`);
      setBusy(false);
      setStatus('');
      return;
    }
    setBusy(true, `Reading ${name}`);
    try {
      const buffer = await file.arrayBuffer();
      if (generation !== state.generation) return;
      const doc = parseTrace(decode(buffer));
      if (generation !== state.generation) return;
      applyDocument(doc, `File: ${name}`);
      setStatus(`Opened ${name}: ${plural(doc.queries.length, 'statement', 'statements')}`);
    } catch (error) {
      if (generation !== state.generation) return;
      const reason = error instanceof TraceError ? error.message : 'The file could not be read.';
      showError(`"${name}" was not opened. ${reason}${keep}`);
      setStatus('');
    } finally {
      if (generation === state.generation) setBusy(false);
    }
  }

  function clearDocument() {
    // Cancels any pending demo fetch or file read (even before a first document exists) and removes every
    // rendered trace value from the DOM, not only from view.
    const hadDocument = Boolean(state.doc);
    beginLoad();
    hideError();
    state.doc = null;
    state.origin = '';
    resetView();
    $('file-input').value = '';
    setBusy(false);
    render();
    setStatus(hadDocument
      ? 'Cleared. The trace was removed from this page and nothing was saved.'
      : 'Stopped loading. Nothing is loaded and nothing was saved.');
    $('empty-title').focus();
  }

  // Empties every container that can hold trace-derived text so a cleared trace does not linger in hidden DOM.
  const TRACE_CONTAINERS = ['counts', 'thread-scroll', 'thread-scale', 'query-list', 'showing', 'errors-count', 'table-filter-name',
    'detail-body', 'relationships', 'tables', 'results', 'facts', 'notes', 'loaded-title',
    'tab-count-queries', 'tab-count-schema', 'tab-count-results'];
  function purgeTraceDom() {
    for (const id of TRACE_CONTAINERS) clear($(id));
    state.rowButtons = [];
    state.paramRows = [];
    $('table-filter').hidden = true;
  }

  function updateClearButton() {
    // Clear stays usable while a load is pending so it can cancel it.
    $('clear-trace').disabled = !state.doc && !document.body.classList.contains('is-busy');
  }

  function resetView() {
    state.selected = -1;
    state.search = '';
    state.op = 'all';
    state.errorsOnly = false;
    state.table = null;
    state.showValues = false;
    $('query-search').value = '';
    $('op-filter').value = 'all';
  }

  function applyDocument(doc, origin) {
    state.doc = doc;
    state.origin = origin;
    resetView();
    state.selected = doc.queries.length ? 0 : -1;
    selectView('queries', false);
    render();
  }

  function exportDocument() {
    const doc = state.doc;
    if (!doc) return;
    const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' });
    const stamp = doc.generatedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'export';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `rowstitch-${doc.source === 'fictional-demo' ? 'demo' : 'trace'}-${stamp}.json`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus(`Downloaded ${link.download}. It contains the trace exactly as loaded, including any values that were not redacted.`);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    const doc = state.doc;
    $('empty').hidden = Boolean(doc);
    $('workspace').hidden = !doc;
    $('export-trace').disabled = !doc;
    updateClearButton();
    if (!doc) {
      $('loaded-kind').textContent = 'Nothing loaded';
      $('loaded-kind').className = 'loaded-kind';
      purgeTraceDom();
      return;
    }
    $('loaded-kind').textContent = doc.source === 'fictional-demo' ? 'Fictional demo' : 'Local trace';
    $('loaded-kind').className = `loaded-kind ${doc.source === 'fictional-demo' ? 'is-demo' : 'is-local'}`;
    setText($('loaded-title'), doc.title || 'Untitled trace');
    $('tab-count-queries').textContent = doc.queries.length.toLocaleString('en-US');
    $('tab-count-schema').textContent = doc.schema.length.toLocaleString('en-US');
    $('tab-count-results').textContent = doc.results ? doc.results.length.toLocaleString('en-US') : '0';
    renderCounts();
    renderThread();
    renderList();
    renderDetail();
    renderSchema();
    renderResults();
    renderAbout();
  }

  function stats(doc) {
    const transactions = new Set();
    let failed = 0;
    let withPlan = 0;
    let scans = 0;
    let timed = 0;
    let total = 0;
    for (const q of doc.queries) {
      if (q.transactionId !== null) transactions.add(q.transactionId);
      if (q.status === 'error') failed += 1;
      if (q.plan && q.plan.length) {
        withPlan += 1;
        if (q.plan.some((s) => isFullScan(s.detail))) scans += 1;
      }
      if (q.durationMs !== null) { timed += 1; total += q.durationMs; }
    }
    return { transactions: transactions.size, failed, withPlan, scans, timed, total };
  }

  function renderCounts() {
    const doc = state.doc;
    const s = stats(doc);
    const box = $('counts');
    clear(box);
    const item = (value, label, tone) => {
      const wrap = el('div', `count${tone ? ` ${tone}` : ''}`);
      wrap.append(el('dt', 'count-label', label), el('dd', 'count-value', value));
      box.append(wrap);
    };
    item(doc.queries.length.toLocaleString('en-US'), doc.queries.length === 1 ? 'Statement' : 'Statements');
    item(s.transactions.toLocaleString('en-US'), s.transactions === 1 ? 'Transaction' : 'Transactions');
    item(s.failed.toLocaleString('en-US'), 'Failed', s.failed ? 'is-error' : '');
    item(`${s.scans} of ${s.withPlan}`, 'Plans with a full scan', s.scans ? 'is-warn' : '');
    const missing = doc.queries.length - s.timed;
    item(s.timed ? formatMs(s.total) : 'none', missing ? `Recorded time, ${missing} without a duration` : 'Recorded time');
  }

  function isFullScan(detail) {
    return /^SCAN\s/.test(detail) && !/\bUSING\b/.test(detail) && !/\bCONSTANT ROW\b/.test(detail);
  }

  function renderThread() {
    const doc = state.doc;
    const host = $('thread-scroll');
    clear(host);
    const n = doc.queries.length;
    if (!n) {
      host.append(el('p', 'thread-empty', 'No statements were recorded in this trace.'));
      $('thread-scale').textContent = '';
      return;
    }
    const maxMs = doc.queries.reduce((m, q) => (q.durationMs !== null && q.durationMs > m ? q.durationMs : m), 0);
    const available = Math.max(240, host.clientWidth || 640);
    const step = Math.max(8, Math.min(56, (available - 24) / n));
    const width = Math.max(available, Math.ceil(step * n + 24));
    const height = 72;
    const base = 46;
    const tall = 34;
    const graph = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'thread-svg' });
    const failed = doc.queries.filter((q) => q.status === 'error').length;
    graph.setAttribute('aria-label', `${plural(n, 'statement', 'statements')} in recorded order, ${plural(failed, 'failed', 'failed')}. Use the list below to inspect them.`);
    graph.append(svg('line', { x1: 8, x2: width - 8, y1: base + 0.5, y2: base + 0.5, class: 'thread-base' }));

    // Transaction threads: one line under each consecutive run of statements with the same transaction id.
    let start = 0;
    while (start < n) {
      const tx = doc.queries[start].transactionId;
      let end = start;
      while (end + 1 < n && doc.queries[end + 1].transactionId === tx && tx !== null) end += 1;
      if (tx !== null) {
        const x1 = 12 + start * step;
        const x2 = 12 + end * step + Math.max(2, step * 0.5);
        const path = `M${x1} ${base + 8} Q${(x1 + x2) / 2} ${base + 20} ${x2} ${base + 8}`;
        graph.append(svg('path', { d: path, class: 'thread-tx' }));
      }
      start = end + 1;
    }

    doc.queries.forEach((q, i) => {
      const x = 12 + i * step;
      const w = Math.max(2, step * 0.5);
      const h = q.durationMs === null || maxMs === 0 ? 6 : 6 + (tall - 6) * (q.durationMs / maxMs);
      const cls = ['stitch'];
      if (q.status === 'error') cls.push('is-error');
      if (q.durationMs === null) cls.push('is-untimed');
      if (i === state.selected) cls.push('is-selected');
      const hit = svg('g', { class: 'stitch-hit' });
      hit.append(svg('rect', { x: x - (step - w) / 2, y: 4, width: step, height: base + 4, class: 'stitch-area' }));
      hit.append(svg('rect', { x, y: base - h, width: w, height: h, rx: Math.min(2, w / 2), class: cls.join(' ') }));
      if (q.status === 'error') hit.append(svg('circle', { cx: x + w / 2, cy: base + 6, r: 2.5, class: 'stitch-fail' }));
      const tip = svg('title');
      tip.textContent = visible(`${q.id} · ${opLabel(q.operation)}${q.table ? ` ${q.table}` : ''} · ${formatMs(q.durationMs)}${q.status === 'error' ? ' · failed' : ''}`);
      hit.append(tip);
      hit.addEventListener('click', () => select(i, { focusDetail: false, reveal: true }));
      graph.append(hit);
    });
    host.append(graph);
    $('thread-scale').textContent = maxMs > 0 ? `Tallest stitch: ${formatMs(maxMs)}, heights are linear` : 'No durations recorded';
  }

  function matches(q) {
    if (state.op !== 'all' && q.operation !== state.op) return false;
    if (state.errorsOnly && q.status !== 'error') return false;
    if (state.table !== null && q.table !== state.table) return false;
    if (state.search) {
      const needle = state.search.toLowerCase();
      const hay = `${q.id}\n${q.operation}\n${q.table || ''}\n${q.transactionId || ''}\n${q.sql}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }

  function groups(queries) {
    const out = [];
    queries.forEach((q, i) => {
      const last = out[out.length - 1];
      if (q.transactionId !== null && last && last.tx === q.transactionId) last.items.push(i);
      else out.push({ tx: q.transactionId, items: [i] });
    });
    return out;
  }

  function renderList() {
    const doc = state.doc;
    const listNode = $('query-list');
    clear(listNode);
    state.rowButtons = [];
    const failed = doc.queries.filter((q) => q.status === 'error').length;
    $('errors-count').textContent = failed.toLocaleString('en-US');
    $('errors-only').setAttribute('aria-pressed', state.errorsOnly ? 'true' : 'false');
    $('errors-only').disabled = failed === 0 && !state.errorsOnly;
    $('table-filter').hidden = state.table === null;
    setText($('table-filter-name'), state.table === null ? '' : state.table);

    let shown = 0;
    for (const group of groups(doc.queries)) {
      const visible = group.items.filter((i) => matches(doc.queries[i]));
      if (!visible.length) continue;
      shown += visible.length;
      if (group.tx === null) {
        for (const i of visible) listNode.append(row(i));
        continue;
      }
      const item = el('li', 'tx-group');
      const header = el('div', 'tx-head');
      const groupFailed = group.items.filter((i) => doc.queries[i].status === 'error').length;
      const groupMs = group.items.reduce((sum, i) => sum + (doc.queries[i].durationMs || 0), 0);
      header.append(el('span', 'tx-label', 'Transaction'), el('code', 'tx-id mono', group.tx));
      const meta = [plural(group.items.length, 'statement', 'statements')];
      if (visible.length !== group.items.length) meta.push(`${visible.length} shown`);
      if (groupFailed) meta.push(`${groupFailed} failed`);
      meta.push(formatMs(groupMs));
      header.append(el('span', `tx-meta${groupFailed ? ' has-error' : ''}`, meta.join(' · ')));
      const inner = el('ol', 'tx-items');
      for (const i of visible) inner.append(row(i));
      item.append(header, inner);
      listNode.append(item);
    }
    if (!shown) {
      const none = el('li', 'list-empty');
      none.append(el('p', '', doc.queries.length ? 'No statements match these filters.' : 'This trace has no statements.'));
      if (doc.queries.length) {
        const reset = el('button', 'btn btn-small', 'Reset filters');
        reset.type = 'button';
        reset.addEventListener('click', () => { resetFilters(); $('query-search').focus(); });
        none.append(reset);
      }
      listNode.append(none);
    }
    $('showing').textContent = shown === doc.queries.length
      ? `Showing all ${plural(shown, 'statement', 'statements')}`
      : `Showing ${shown.toLocaleString('en-US')} of ${plural(doc.queries.length, 'statement', 'statements')}`;
  }

  function row(i) {
    const q = state.doc.queries[i];
    const li = el('li', 'q-item');
    const button = el('button', `q-row${q.status === 'error' ? ' is-error' : ''}`);
    button.type = 'button';
    if (i === state.selected) button.setAttribute('aria-current', 'true');
    const top = el('span', 'q-top');
    top.append(el('span', `op op-${q.operation}`, opLabel(q.operation)));
    if (q.table) top.append(el('span', 'q-table mono', q.table));
    top.append(el('span', 'q-id mono', q.id));
    const meta = el('span', 'q-meta');
    if (q.status === 'error') meta.append(el('span', 'q-fail', 'Failed'));
    meta.append(el('span', 'mono', formatMs(q.durationMs)));
    top.append(meta);
    button.append(top, el('span', 'q-sql mono', q.sql.replace(/\s+/g, ' ').slice(0, 240)));
    button.addEventListener('click', () => select(i, { focusDetail: isNarrow(), reveal: false }));
    button.addEventListener('keydown', (event) => onRowKey(event, i));
    state.rowButtons.push({ index: i, button });
    li.append(button);
    return li;
  }

  function onRowKey(event, i) {
    const pos = state.rowButtons.findIndex((r) => r.index === i);
    let next = -1;
    if (event.key === 'ArrowDown') next = Math.min(state.rowButtons.length - 1, pos + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, pos - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = state.rowButtons.length - 1;
    else return;
    event.preventDefault();
    const target = state.rowButtons[next];
    if (!target) return;
    select(target.index, { focusDetail: false, reveal: false });
    const again = state.rowButtons.find((r) => r.index === target.index);
    if (again) again.button.focus();
  }

  const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

  function select(i, { focusDetail, reveal }) {
    if (!state.doc || i < 0 || i >= state.doc.queries.length) return;
    if (state.selected !== i) state.showValues = false;
    state.selected = i;
    const current = state.rowButtons.find((r) => r.index === i);
    for (const r of state.rowButtons) {
      if (r.index === i) r.button.setAttribute('aria-current', 'true');
      else r.button.removeAttribute('aria-current');
    }
    renderThread();
    renderDetail();
    if (reveal && current) current.button.scrollIntoView({ block: 'nearest' });
    if (focusDetail) {
      const heading = $('detail-title');
      if (heading) {
        heading.focus();
        heading.scrollIntoView({ block: 'start' });
      }
    }
  }

  function tokenizeSql(sql) {
    // Splits SQL into display tokens. Placeholders are numbered in order; quoted text is never treated as a placeholder.
    const tokens = [];
    let i = 0;
    let slot = 0;
    let plain = '';
    const flush = () => { if (plain) { tokens.push({ kind: 'plain', text: plain }); plain = ''; } };
    while (i < sql.length) {
      const c = sql[i];
      if (c === '\'' || c === '"' || c === '`' || c === '[') {
        const close = c === '[' ? ']' : c;
        let j = i + 1;
        while (j < sql.length) {
          if (sql[j] === close) {
            if (close !== ']' && sql[j + 1] === close) { j += 2; continue; }
            break;
          }
          j += 1;
        }
        flush();
        tokens.push({ kind: c === '\'' ? 'string' : 'ident', text: sql.slice(i, j + 1) });
        i = j + 1;
      } else if (c === '-' && sql[i + 1] === '-') {
        const j = sql.indexOf('\n', i);
        const end = j < 0 ? sql.length : j;
        flush();
        tokens.push({ kind: 'comment', text: sql.slice(i, end) });
        i = end;
      } else if (c === '/' && sql[i + 1] === '*') {
        const j = sql.indexOf('*/', i + 2);
        const end = j < 0 ? sql.length : j + 2;
        flush();
        tokens.push({ kind: 'comment', text: sql.slice(i, end) });
        i = end;
      } else if (c === '?') {
        let j = i + 1;
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j += 1;
        flush();
        const explicit = j > i + 1 ? Number(sql.slice(i + 1, j)) : null;
        slot = explicit !== null ? Math.max(slot, explicit) : slot + 1;
        tokens.push({ kind: 'slot', text: sql.slice(i, j), slot: explicit !== null ? explicit : slot });
        i = j;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
        const word = sql.slice(i, j);
        if (SQL_KEYWORDS.has(word.toUpperCase())) {
          flush();
          tokens.push({ kind: 'keyword', text: word });
        } else {
          plain += word;
        }
        i = j;
      } else {
        plain += c;
        i += 1;
      }
    }
    flush();
    return { tokens, slots: slot };
  }

  function renderDetail() {
    const body = $('detail-body');
    clear(body);
    state.paramRows = [];
    const doc = state.doc;
    const q = doc && state.selected >= 0 ? doc.queries[state.selected] : null;
    if (!q) {
      let message = 'There is nothing to inspect.';
      if (doc && doc.queries.length) {
        message = doc.queries.some(matches)
          ? 'Choose a statement to inspect it.'
          : 'No statement matches the current search and filters, so nothing is selected.';
      }
      body.append(el('p', 'detail-empty', message));
      return;
    }

    const head = el('div', 'detail-head');
    const title = el('h2', 'detail-title');
    title.id = 'detail-title';
    title.tabIndex = -1;
    title.append(el('span', `op op-${q.operation}`, opLabel(q.operation)), document.createTextNode(' '));
    title.append(q.table ? el('span', 'mono', q.table) : el('span', 'muted', 'Database, no single table'));
    head.append(title);
    const nav = el('div', 'detail-nav');
    const prev = el('button', 'btn btn-small', 'Previous');
    prev.type = 'button';
    prev.disabled = state.selected <= 0;
    prev.addEventListener('click', () => select(state.selected - 1, { focusDetail: false, reveal: true }));
    const next = el('button', 'btn btn-small', 'Next');
    next.type = 'button';
    next.disabled = state.selected >= doc.queries.length - 1;
    next.addEventListener('click', () => select(state.selected + 1, { focusDetail: false, reveal: true }));
    nav.append(el('span', 'detail-pos mono', `${state.selected + 1} of ${doc.queries.length}`), prev, next);
    head.append(nav);
    body.append(head);

    const facts = el('dl', 'detail-facts');
    const fact = (label, value, cls) => {
      const wrap = el('div', 'fact');
      wrap.append(el('dt', '', label), el('dd', cls || '', value));
      facts.append(wrap);
    };
    fact('Status', q.status === 'error' ? 'Failed' : 'Succeeded', q.status === 'error' ? 'is-error' : 'is-ok');
    fact('Statement id', q.id, 'mono');
    fact('Transaction', q.transactionId === null ? 'Autocommit' : q.transactionId, q.transactionId === null ? '' : 'mono');
    fact('Duration', formatMs(q.durationMs), 'mono');
    fact('Rows reported', q.rowCount === null ? 'not recorded' : q.rowCount.toLocaleString('en-US'), 'mono');
    body.append(facts);
    if (q.status === 'error') {
      body.append(el('p', 'callout is-error', 'This statement failed. Traces do not carry error messages, so check your application log for the reason.'));
    }

    // SQL
    const { tokens, slots } = tokenizeSql(q.sql);
    const sqlBlock = el('section', 'block');
    const sqlHead = el('div', 'block-head');
    sqlHead.append(el('h3', 'block-title', 'SQL'));
    const copy = el('button', 'btn btn-small', 'Copy SQL');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(q.sql);
        setStatus('Copied the SQL text. Bound values were not included.');
      } catch {
        setStatus('The browser did not allow copying. Select the SQL text and copy it instead.');
      }
    });
    sqlHead.append(copy);
    sqlBlock.append(sqlHead);
    const pre = el('pre', 'sql');
    const code = el('code', 'mono');
    for (const t of tokens) {
      if (t.kind === 'plain') code.append(document.createTextNode(t.text));
      else if (t.kind === 'slot') {
        const chip = el('span', 'slot', `?${t.slot}`);
        chip.dataset.slot = String(t.slot);
        chip.addEventListener('mouseenter', () => highlightSlot(t.slot, true));
        chip.addEventListener('mouseleave', () => highlightSlot(t.slot, false));
        code.append(chip);
      } else code.append(el('span', `tok-${t.kind}`, t.text));
    }
    pre.append(code);
    sqlBlock.append(pre);
    sqlBlock.append(el('p', 'fine', 'Numbered chips mark bound-value slots. Values travel separately from the SQL text and are never pasted into it here.'));
    body.append(sqlBlock);

    // Parameters
    const params = el('section', 'block');
    const paramsHead = el('div', 'block-head');
    paramsHead.append(el('h3', 'block-title', `Bound values (${q.parameters.length})`));
    const readable = q.parameters.filter((p) => p !== REDACTED).length;
    if (readable) {
      const toggle = el('button', 'btn btn-small toggle', state.showValues ? 'Hide values' : 'Show values');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', state.showValues ? 'true' : 'false');
      toggle.addEventListener('click', () => {
        state.showValues = !state.showValues;
        renderDetail();
        const again = document.querySelector('#detail-body .block .toggle');
        if (again) again.focus();
      });
      paramsHead.append(toggle);
    }
    params.append(paramsHead);
    if (!q.parameters.length) {
      params.append(el('p', 'muted', slots ? 'The SQL has slots, but the trace lists no values for them.' : 'This statement has no bound values.'));
    } else {
      const table = el('table', 'params');
      const thead = el('thead');
      const hr = el('tr');
      hr.append(el('th', '', 'Slot'), el('th', '', 'Value'));
      thead.append(hr);
      const tbody = el('tbody');
      q.parameters.forEach((value, k) => {
        const tr = el('tr');
        tr.append(el('td', 'mono slot-cell', `?${k + 1}`));
        let cell;
        if (value === REDACTED) cell = el('td', 'muted', 'Redacted when the trace was written');
        else if (!state.showValues) cell = el('td', 'muted', `Hidden (${value === null ? 'null' : typeof value === 'string' ? 'text' : typeof value})`);
        else cell = el('td', 'mono value', formatValue(value));
        tr.append(cell);
        tbody.append(tr);
        state.paramRows.push({ slot: k + 1, tr });
      });
      table.append(thead, tbody);
      params.append(table);
      if (readable && !state.showValues) params.append(el('p', 'fine', `${plural(readable, 'value is', 'values are')} in the file but hidden here. Showing them lasts until you pick another statement.`));
      if (!readable) params.append(el('p', 'fine', 'All values were redacted before the trace was written.'));
    }
    if (slots && q.parameters.length && slots !== q.parameters.length) {
      params.append(el('p', 'callout is-warn', `The SQL has ${plural(slots, 'slot', 'slots')} and the trace lists ${plural(q.parameters.length, 'value', 'values')}.`));
    }
    body.append(params);

    // Plan
    const planBlock = el('section', 'block');
    planBlock.append(el('h3', 'block-title', 'Query plan'));
    if (q.plan === null) {
      planBlock.append(el('p', 'muted', q.operation === 'select'
        ? 'No plan was recorded for this read.'
        : 'No plan in the trace. Rowstitch records EXPLAIN QUERY PLAN for generated reads.'));
    } else if (!q.plan.length) {
      planBlock.append(el('p', 'muted', 'A plan was recorded with no steps.'));
    } else {
      planBlock.append(renderPlan(q.plan));
      planBlock.append(el('p', 'fine', 'From SQLite\'s EXPLAIN QUERY PLAN text in the trace. The labels are reading aids, not measurements. Nothing was re-run.'));
    }
    body.append(planBlock);
  }

  function highlightSlot(slot, on) {
    for (const r of state.paramRows) r.tr.classList.toggle('is-hot', on && r.slot === slot);
  }

  function renderPlan(plan) {
    const byId = new Map();
    plan.forEach((step, k) => { if (typeof step.id === 'number' && !byId.has(step.id)) byId.set(step.id, k); });
    const depthOf = (k) => {
      let depth = 0;
      let current = plan[k];
      const seen = new Set([k]);
      while (current && typeof current.parent === 'number' && current.parent !== 0 && byId.has(current.parent) && depth < 6) {
        const parentIndex = byId.get(current.parent);
        if (seen.has(parentIndex)) break;
        seen.add(parentIndex);
        depth += 1;
        current = plan[parentIndex];
      }
      return depth;
    };
    const listNode = el('ol', 'plan');
    plan.forEach((step, k) => {
      const li = el('li', `plan-step depth-${depthOf(k)}`);
      li.append(el('code', 'mono plan-detail', step.detail || '(empty step)'));
      const d = step.detail;
      if (isFullScan(d)) li.append(el('span', 'tag is-warn', 'Reads every row'));
      else if (/\bUSING (COVERING )?INDEX\b|\bUSING (INTEGER )?PRIMARY KEY\b/.test(d)) li.append(el('span', 'tag is-ok', 'Uses an index'));
      if (/\bTEMP B-TREE\b/.test(d)) li.append(el('span', 'tag', 'Temporary sort'));
      listNode.append(li);
    });
    return listNode;
  }

  function renderSchema() {
    const doc = state.doc;
    const rel = $('relationships');
    clear(rel);
    const names = new Set(doc.schema.map((t) => t.name));
    const referencedBy = new Map();
    let count = 0;
    for (const table of doc.schema) {
      for (const fk of table.foreignKeys) {
        count += 1;
        const li = el('li', 'relationship');
        li.append(el('code', 'mono', `${table.name}.${fk.column}`), el('span', 'arrow', ' references '), el('code', 'mono', `${fk.table}.${fk.target}`));
        if (!names.has(fk.table)) li.append(el('span', 'tag', 'Table not in this trace'));
        rel.append(li);
        if (!referencedBy.has(fk.table)) referencedBy.set(fk.table, []);
        referencedBy.get(fk.table).push(`${table.name}.${fk.column}`);
      }
    }
    if (!count) rel.append(el('li', 'muted', 'No foreign keys are recorded.'));

    const host = $('tables');
    clear(host);
    if (!doc.schema.length) host.append(el('p', 'muted', 'This trace has no schema.'));
    for (const table of doc.schema) {
      const card = el('section', 'table-card');
      const head = el('div', 'table-head');
      head.append(el('h2', 'table-name mono', table.name));
      head.append(el('span', 'muted', plural(table.columns.length, 'column', 'columns')));
      card.append(head);
      const cols = el('table', 'columns');
      const thead = el('thead');
      const hr = el('tr');
      hr.append(el('th', '', 'Column'), el('th', '', 'Type'), el('th', '', 'Rules'));
      thead.append(hr);
      const tbody = el('tbody');
      const fkCols = new Map(table.foreignKeys.map((fk) => [fk.column, fk]));
      for (const column of table.columns) {
        const tr = el('tr');
        tr.append(el('td', 'mono', column.name), el('td', 'mono muted', column.type || 'untyped'));
        const rules = [];
        if (column.primaryKey) rules.push('Primary key');
        rules.push(column.nullable ? 'Nullable' : 'Required');
        const fk = fkCols.get(column.name);
        if (fk) rules.push(`References ${fk.table}.${fk.target}`);
        tr.append(el('td', '', rules.join(' · ')));
        tbody.append(tr);
      }
      cols.append(thead, tbody);
      card.append(cols);
      const refs = referencedBy.get(table.name);
      if (refs) card.append(el('p', 'fine', `Referenced by ${refs.join(', ')}`));
      const used = doc.queries.filter((q) => q.table === table.name).length;
      const show = el('button', 'btn btn-small', used ? `Show ${plural(used, 'statement', 'statements')}` : 'No statements on this table');
      show.type = 'button';
      show.disabled = !used;
      show.addEventListener('click', () => {
        state.table = table.name;
        state.search = '';
        state.op = 'all';
        state.errorsOnly = false;
        $('query-search').value = '';
        $('op-filter').value = 'all';
        selectView('queries', true);
        refreshListAndSelection();
      });
      card.append(show);
      host.append(card);
    }
  }

  function renderResults() {
    const doc = state.doc;
    const host = $('results');
    clear(host);
    if (!doc.results || !doc.results.length) {
      $('results-lede').textContent = 'Rows included in the trace file. The studio never runs a query to get them.';
      host.append(el('p', 'muted empty-note', doc.source === 'local-trace'
        ? 'This trace has no result previews. Local traces usually leave rows out, which is the safer default.'
        : 'This trace has no result previews.'));
      return;
    }
    $('results-lede').textContent = doc.source === 'local-trace'
      ? 'This local trace includes result rows. Review them before sharing the file. The studio never runs a query to get them.'
      : 'Fictional rows included in the demo. The studio never runs a query to get them.';
    for (const result of doc.results) {
      const card = el('section', 'result');
      const head = el('div', 'table-head');
      head.append(el('h2', 'result-title', result.title || 'Untitled preview'));
      head.append(el('span', 'muted', `${plural(result.rows.length, 'row', 'rows')} × ${plural(result.columns.length, 'column', 'columns')}`));
      card.append(head);
      const scroller = el('div', 'result-scroll');
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', 'Result preview table, scrolls sideways');
      const table = el('table', 'grid');
      const thead = el('thead');
      const hr = el('tr');
      for (const c of result.columns) hr.append(el('th', '', c));
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of result.rows) {
        const tr = el('tr');
        for (const cell of r) {
          const td = el('td', cell === null ? 'is-null mono' : typeof cell === 'number' ? 'is-num mono' : typeof cell === 'boolean' ? 'mono' : '',
            cell === null ? 'null' : String(cell).length > 400 ? `${String(cell).slice(0, 399)}…` : String(cell));
          tr.append(td);
        }
        tbody.append(tr);
      }
      if (!result.rows.length) {
        const tr = el('tr');
        const td = el('td', 'muted', 'No rows');
        td.colSpan = Math.max(1, result.columns.length);
        tr.append(td);
        tbody.append(tr);
      }
      table.append(thead, tbody);
      scroller.append(table);
      card.append(scroller);
      host.append(card);
    }
  }

  function renderAbout() {
    const doc = state.doc;
    const facts = $('facts');
    clear(facts);
    const add = (label, value, cls) => {
      const wrap = el('div', 'fact');
      wrap.append(el('dt', '', label), el('dd', cls || '', value));
      facts.append(wrap);
    };
    const s = stats(doc);
    const columns = doc.schema.reduce((n, t) => n + t.columns.length, 0);
    const relationships = doc.schema.reduce((n, t) => n + t.foreignKeys.length, 0);
    const when = new Date(Date.parse(doc.generatedAt));
    add('Title', doc.title || 'Untitled trace');
    add('Source', doc.source === 'fictional-demo' ? 'Fictional demo data' : 'Local trace');
    add('Loaded from', state.origin);
    add('Generated', `${doc.generatedAt} (${when.toISOString().replace('T', ' ').slice(0, 19)} UTC)`, 'mono');
    add('Statements', `${doc.queries.length.toLocaleString('en-US')}, ${s.failed} failed, ${plural(s.transactions, 'transaction', 'transactions')}`);
    add('Schema', `${plural(doc.schema.length, 'table', 'tables')}, ${plural(columns, 'column', 'columns')}, ${plural(relationships, 'foreign key', 'foreign keys')}`);
    add('Result previews', doc.results ? plural(doc.results.length, 'preview', 'previews') : 'Not included');
    const notes = $('notes');
    clear(notes);
    if (!doc.notes || !doc.notes.length) notes.append(el('li', 'muted', 'The trace has no notes.'));
    else for (const note of doc.notes) notes.append(el('li', '', note));
  }

  // ---------------------------------------------------------------------------
  // Views and filters
  // ---------------------------------------------------------------------------

  const VIEWS = ['queries', 'schema', 'results', 'about'];
  function selectView(view, focusTab) {
    state.view = view;
    for (const name of VIEWS) {
      const tab = $(`tab-${name}`);
      const on = name === view;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $(`view-${name}`).hidden = !on;
    }
    if (focusTab) $(`tab-${view}`).focus();
    if (view === 'queries' && state.doc) requestAnimationFrame(() => { if (state.doc) renderThread(); });
  }

  function refreshListAndSelection() {
    renderList();
    const visible = state.rowButtons.map((r) => r.index);
    if (visible.length && !visible.includes(state.selected)) {
      state.selected = visible[0];
      state.showValues = false;
      for (const r of state.rowButtons) {
        if (r.index === state.selected) r.button.setAttribute('aria-current', 'true');
        else r.button.removeAttribute('aria-current');
      }
    } else if (!visible.length) {
      // Nothing matches: do not keep showing an unrelated statement as if it were a result.
      state.selected = -1;
      state.showValues = false;
    }
    renderThread();
    renderDetail();
  }

  function resetFilters() {
    state.search = '';
    state.op = 'all';
    state.errorsOnly = false;
    state.table = null;
    $('query-search').value = '';
    $('op-filter').value = 'all';
    refreshListAndSelection();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function pickFile() { $('file-input').click(); }

  // Getting-started guide. Static text only: it never reads trace data and copies only its own fixed text.
  function selectText(node) {
    if (node instanceof HTMLTextAreaElement) {
      node.focus();
      node.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  async function copyGuideText(sourceId, label) {
    const node = $(sourceId);
    const value = node instanceof HTMLTextAreaElement ? node.value : node.textContent;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('unavailable');
      await navigator.clipboard.writeText(value);
      setStatus(`Copied the ${label}.`);
    } catch {
      selectText(node);
      setStatus(`The browser did not allow copying, so the ${label} is selected. Press Ctrl+C, or Command+C on a Mac.`);
    }
  }
  function openGuide() {
    const guide = $('guide');
    guide.open = true;
    $('guide-summary').focus();
    guide.scrollIntoView({ block: 'start' });
  }

  function init() {
    $('open-trace').addEventListener('click', pickFile);
    $('empty-open').addEventListener('click', pickFile);
    $('load-demo').addEventListener('click', loadDemo);
    $('empty-demo').addEventListener('click', loadDemo);
    $('guide-demo').addEventListener('click', loadDemo);
    $('guide-open').addEventListener('click', pickFile);
    $('guide-copy-code').addEventListener('click', () => copyGuideText('guide-trace-code', 'trace code'));
    $('guide-copy-brief').addEventListener('click', () => copyGuideText('guide-brief', 'agent brief'));
    $('empty-guide').addEventListener('click', openGuide);
    $('export-trace').addEventListener('click', exportDocument);
    $('clear-trace').addEventListener('click', clearDocument);
    $('error-dismiss').addEventListener('click', hideError);
    $('file-input').addEventListener('change', (event) => {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = '';
      if (file) importFile(file);
    });

    $('query-search').addEventListener('input', (event) => {
      state.search = event.target.value.slice(0, 200);
      refreshListAndSelection();
    });
    $('query-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.target.value) {
        event.preventDefault();
        event.target.value = '';
        state.search = '';
        refreshListAndSelection();
      }
    });
    $('op-filter').addEventListener('change', (event) => {
      state.op = OPERATIONS.includes(event.target.value) ? event.target.value : 'all';
      refreshListAndSelection();
    });
    $('errors-only').addEventListener('click', () => {
      state.errorsOnly = !state.errorsOnly;
      refreshListAndSelection();
    });
    $('table-filter-clear').addEventListener('click', () => {
      state.table = null;
      refreshListAndSelection();
      $('query-search').focus();
    });
    $('back-to-list').addEventListener('click', () => {
      const current = state.rowButtons.find((r) => r.index === state.selected);
      if (current) {
        current.button.focus();
        current.button.scrollIntoView({ block: 'center' });
      } else $('query-search').focus();
    });

    const tablist = document.querySelector('.tabs');
    for (const name of VIEWS) $(`tab-${name}`).addEventListener('click', () => selectView(name, false));
    tablist.addEventListener('keydown', (event) => {
      const at = VIEWS.indexOf(state.view);
      let next = -1;
      if (event.key === 'ArrowRight') next = (at + 1) % VIEWS.length;
      else if (event.key === 'ArrowLeft') next = (at - 1 + VIEWS.length) % VIEWS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = VIEWS.length - 1;
      if (next < 0) return;
      event.preventDefault();
      selectView(VIEWS[next], true);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      if (!state.doc) return;
      event.preventDefault();
      selectView('queries', false);
      $('query-search').focus();
    });

    // Drag and drop: a file dropped anywhere opens like "Open trace". Nothing else is accepted.
    let dragDepth = 0;
    const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      document.body.classList.add('is-dragging');
    });
    document.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('is-dragging');
    });
    document.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('is-dragging');
      const files = event.dataTransfer ? event.dataTransfer.files : null;
      if (!files || !files.length) return;
      if (files.length > 1) {
        showError(`Drop one trace file at a time.${state.doc ? ' The previous trace is still shown.' : ''}`);
        return;
      }
      importFile(files[0]);
    });

    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { if (state.doc && state.view === 'queries') renderThread(); });
    });

    render();
    loadDemo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
