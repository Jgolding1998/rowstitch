// Rowstitch Studio: a read-only, local inspector for Rowstitch trace documents.
// Every value from a trace is untrusted text. It is rendered with textContent and numeric SVG attributes only.
// Nothing here executes SQL, stores data in the browser, or requests anything except GET /api/demo.
// The parsed document is for display only. Export writes the validated source bytes, never a serialized document.
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
  const POSTGRES_KEYWORDS = new Set('OPERATOR OVERRIDING SYSTEM USER VALUE ONLY ISOLATION LEVEL SERIALIZABLE READ'.split(' '));
  const DIALECTS = Object.freeze(['sqlite', 'postgresql']);
  const SCOPES = Object.freeze(['all', 'mapped']);
  const SCHEMA_SOURCES = Object.freeze(['explicit', 'default']);
  const POLICIES = Object.freeze(['legacy', 'exact', 'subset']);
  const COVERAGES = Object.freeze(['all', 'mapped-and-key']);
  // The same rules as the library's identifier(). Logical names are simple; physical names are arbitrary catalog data.
  const LOGICAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
  const RESERVED_LOGICAL = /^(?:sqlite_|__rs_)/i;
  const LONE_SURROGATE = /\p{Cs}/u;
  const isPostgres = (doc) => doc.dialect === 'postgresql';
  // Constant display names. An imported dialect is validated against DIALECTS and never shown as text.
  const backendName = (doc) => (isPostgres(doc) ? 'PostgreSQL' : 'SQLite');

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
    if (raw.version !== 1 && raw.version !== 2) fail('', 'This trace version is not supported. The studio reads versions 1 and 2.');
    const v2 = raw.version === 2;
    if (v2) {
      checkKeys(raw, 'The trace', ['format', 'version', 'dialect', 'title', 'generatedAt', 'source', 'mapping', 'inspection', 'schema', 'queries', 'notes'], ['results']);
      if (!DIALECTS.includes(raw.dialect)) fail('"dialect"', 'must be "sqlite" or "postgresql"');
    } else {
      checkKeys(raw, 'The trace', ['format', 'version', 'title', 'generatedAt', 'source', 'schema', 'queries'], ['results', 'notes', 'dialect']);
      // Absent means a legacy SQLite trace. It stays absent, so the About view can say the trace names no database.
      if (has(raw, 'dialect') && !DIALECTS.includes(raw.dialect)) fail('"dialect"', 'must be "sqlite" or "postgresql" when present');
    }

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

    const mapping = v2 ? normalizeMapping(raw.mapping, raw.dialect) : null;
    const inspection = v2 ? normalizeInspection(raw.inspection) : null;
    const schema = v2 ? normalizeSchemaV2(raw.schema, raw.dialect) : normalizeSchemaV1(raw.schema);
    if (v2) checkTraceCounts(mapping, inspection, schema, raw.dialect);

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
      // The views treat an empty string and a missing table alike.
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

    const doc = v2
      ? { format: 'rowstitch-trace', version: 2, title, generatedAt, source: raw.source, dialect: raw.dialect, mapping, inspection, schema, queries }
      : { format: 'rowstitch-trace', version: 1, title, generatedAt, source: raw.source, ...(has(raw, 'dialect') ? { dialect: raw.dialect } : {}), schema, queries };
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
  // Schema sections, by trace version
  // ---------------------------------------------------------------------------

  function normalizeSchemaV1(value) {
    return list(value, '"schema"', LIMITS.tables).map((table, t) => {
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
  }

  // Physical names are data from a catalog: they may hold quotes, dots, newlines or prototype-like words. They are only ever
  // text, and only ever keys in a Map or Set. The rules match the library's capturePhysicalName, and errors never repeat a name.
  function physicalName(value, path, dialect) {
    if (typeof value !== 'string') fail(path, 'must be text');
    if (value === '') fail(path, 'must not be empty');
    if (value.length > LIMITS.string) fail(path, `is longer than ${LIMITS.string.toLocaleString('en-US')} bytes`);
    if (value.includes('\u0000') || LONE_SURROGATE.test(value)) fail(path, 'must be well-formed text without a NUL character');
    const max = dialect === 'postgresql' ? 63 : LIMITS.string;
    if (new TextEncoder().encode(value).length > max) fail(path, `is longer than ${max.toLocaleString('en-US')} bytes`);
    return value;
  }

  function logicalName(value, path) {
    if (typeof value !== 'string' || !LOGICAL_NAME.test(value) || RESERVED_LOGICAL.test(value) || FORBIDDEN_KEYS.has(value)) {
      fail(path, 'must be a simple logical name');
    }
    return value;
  }

  function identity(value, path, dialect) {
    checkKeys(value, path, ['schema', 'table'], []);
    return { schema: physicalName(value.schema, `${path}.schema`, dialect), table: physicalName(value.table, `${path}.table`, dialect) };
  }

  function oneOf(value, path, allowed) {
    if (!allowed.includes(value)) fail(path, `must be one of ${allowed.join(', ')}`);
    return value;
  }

  function count(value, path, max) {
    if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a whole number of zero or more');
    if (value > max) fail(path, `is more than the limit of ${max.toLocaleString('en-US')}`);
    return value;
  }

  // PostgreSQL compares names exactly. SQLite folds ASCII A to Z only, separately for each part.
  const nameKey = (name, dialect) => (dialect === 'sqlite' ? name.replace(/[A-Z]/g, (c) => c.toLowerCase()) : name);
  // A JSON tuple cannot collide across the two parts, whatever characters they hold.
  const identityKey = (id, dialect) => JSON.stringify([nameKey(id.schema, dialect), nameKey(id.table, dialect)]);

  function normalizeMapping(value, dialect) {
    checkKeys(value, '"mapping"', ['tables', 'omittedTables'], []);
    const logicals = new Set();
    const physicals = new Set();
    const tables = list(value.tables, '"mapping.tables"', LIMITS.tables).map((table, t) => {
      const at = `mapping.tables[${t}]`;
      checkKeys(table, at, ['logical', 'physical', 'schemaSource', 'policy', 'columns'], []);
      const logical = logicalName(table.logical, `${at}.logical`);
      if (logicals.has(logical)) fail(`${at}.logical`, 'repeats a registered table');
      logicals.add(logical);
      const physical = identity(table.physical, `${at}.physical`, dialect);
      const key = identityKey(physical, dialect);
      if (physicals.has(key)) fail(`${at}.physical`, 'repeats a stored table used by another registration');
      physicals.add(key);
      const properties = new Set();
      const stored = new Set();
      const columns = list(table.columns, `${at}.columns`, LIMITS.columns).map((column, c) => {
        const cat = `${at}.columns[${c}]`;
        checkKeys(column, cat, ['logical', 'physical'], []);
        const property = logicalName(column.logical, `${cat}.logical`);
        if (properties.has(property)) fail(`${cat}.logical`, 'repeats a property in this table');
        properties.add(property);
        const name = physicalName(column.physical, `${cat}.physical`, dialect);
        if (stored.has(nameKey(name, dialect))) fail(`${cat}.physical`, 'repeats a stored column in this table');
        stored.add(nameKey(name, dialect));
        return { logical: property, physical: name };
      });
      return {
        logical, physical,
        schemaSource: oneOf(table.schemaSource, `${at}.schemaSource`, SCHEMA_SOURCES),
        policy: oneOf(table.policy, `${at}.policy`, POLICIES),
        columns,
      };
    });
    return { tables, omittedTables: count(value.omittedTables, '"mapping.omittedTables"', LIMITS.tables) };
  }

  function normalizeInspection(value) {
    checkKeys(value, '"inspection"', ['scope', 'registeredTables', 'omittedTables'], []);
    return {
      scope: oneOf(value.scope, '"inspection.scope"', SCOPES),
      registeredTables: count(value.registeredTables, '"inspection.registeredTables"', LIMITS.tables),
      omittedTables: count(value.omittedTables, '"inspection.omittedTables"', LIMITS.tables),
    };
  }

  function normalizeSchemaV2(value, dialect) {
    const identities = new Set();
    return list(value, '"schema"', LIMITS.tables).map((table, t) => {
      const at = `schema[${t}]`;
      checkKeys(table, at, ['name', 'identity', 'coverage', 'columns', 'foreignKeys'], []);
      const id = identity(table.identity, `${at}.identity`, dialect);
      if (table.name !== id.table) fail(`${at}.name`, 'must equal its identity table');
      const key = identityKey(id, dialect);
      if (identities.has(key)) fail(`${at}.identity`, 'repeats a table already in this schema');
      identities.add(key);
      const seenColumns = new Set();
      const columns = list(table.columns, `${at}.columns`, LIMITS.columns).map((column, c) => {
        const cat = `${at}.columns[${c}]`;
        checkKeys(column, cat, ['name', 'type', 'nullable', 'primaryKey'], []);
        const name = physicalName(column.name, `${cat}.name`, dialect);
        if (seenColumns.has(nameKey(name, dialect))) fail(`${cat}.name`, 'repeats a column in this table');
        seenColumns.add(nameKey(name, dialect));
        return { name, type: text(column.type, `${cat}.type`), nullable: bool(column.nullable, `${cat}.nullable`), primaryKey: bool(column.primaryKey, `${cat}.primaryKey`) };
      });
      checkKeys(table.coverage, `${at}.coverage`, ['columns'], ['totalColumnCount']);
      const coverage = { columns: oneOf(table.coverage.columns, `${at}.coverage.columns`, COVERAGES) };
      if (has(table.coverage, 'totalColumnCount')) {
        coverage.totalColumnCount = count(table.coverage.totalColumnCount, `${at}.coverage.totalColumnCount`, Number.MAX_SAFE_INTEGER);
        if (coverage.columns === 'all' ? coverage.totalColumnCount !== columns.length : coverage.totalColumnCount < columns.length) {
          fail(`${at}.coverage.totalColumnCount`, `contradicts the ${columns.length.toLocaleString('en-US')} listed columns`);
        }
      }
      const constraints = new Set();
      const foreignKeys = list(table.foreignKeys, `${at}.foreignKeys`, LIMITS.foreignKeys).map((fk, f) => {
        const fat = `${at}.foreignKeys[${f}]`;
        checkKeys(fk, fat, ['constraint', 'width', 'columns', 'targetIdentity'], []);
        const constraint = physicalName(fk.constraint, `${fat}.constraint`, dialect);
        if (constraints.has(constraint)) fail(`${fat}.constraint`, 'repeats a constraint in this table');
        constraints.add(constraint);
        const components = list(fk.columns, `${fat}.columns`, LIMITS.columns).map((component, c) => {
          const cat = `${fat}.columns[${c}]`;
          checkKeys(component, cat, ['column', 'target'], []);
          return {
            column: physicalName(component.column, `${cat}.column`, dialect),
            target: component.target === null ? null : physicalName(component.target, `${cat}.target`, dialect),
          };
        });
        if (!Number.isSafeInteger(fk.width) || fk.width < 1 || fk.width !== components.length) {
          fail(`${fat}.width`, `must be a whole number that matches its ${components.length.toLocaleString('en-US')} listed columns`);
        }
        return { constraint, width: fk.width, columns: components, targetIdentity: identity(fk.targetIdentity, `${fat}.targetIdentity`, dialect) };
      });
      return { name: id.table, identity: id, coverage, columns, foreignKeys };
    });
  }

  function checkTraceCounts(mapping, inspection, schema, dialect) {
    const accounted = mapping.tables.length + mapping.omittedTables;
    if (inspection.registeredTables !== accounted) {
      fail('"inspection.registeredTables"', `says ${inspection.registeredTables.toLocaleString('en-US')}, but the mapping accounts for ${accounted.toLocaleString('en-US')}`);
    }
    const inspected = schema.length + inspection.omittedTables;
    if (inspected > LIMITS.tables) fail('"inspection.omittedTables"', `brings the snapshot to ${inspected.toLocaleString('en-US')} tables, the limit is ${LIMITS.tables}`);
    if (inspection.scope === 'all') {
      // An unscoped inspection has no registrations to narrow its columns by.
      if (schema.some((table) => table.coverage.columns !== 'all')) fail('"schema"', 'lists partial columns, which an inspection of everything cannot produce');
      return;
    }
    // Mapped inspection reads only registered identities, and each resolves to at most one table.
    if (inspected > inspection.registeredTables) {
      fail('"inspection.omittedTables"', `brings a mapped snapshot to ${inspected.toLocaleString('en-US')} tables, but only ${inspection.registeredTables.toLocaleString('en-US')} are registered`);
    }
    if (mapping.omittedTables === 0) {
      const registered = new Set(mapping.tables.map((table) => identityKey(table.physical, dialect)));
      schema.forEach((table, t) => {
        if (!registered.has(identityKey(table.identity, dialect))) fail(`schema[${t}].identity`, 'is not registered, but this snapshot covers mapped tables only');
      });
    }
  }

  /** Joins registrations to observed tables by structured identity. For display only, and kept out of the document. */
  function buildMappingModel(doc) {
    if (doc.version !== 2) return null;
    const observed = new Map(doc.schema.map((table) => [identityKey(table.identity, doc.dialect), table]));
    const claimed = new Set();
    const byLogical = new Map();
    const cards = doc.mapping.tables.map((mapping) => {
      const key = identityKey(mapping.physical, doc.dialect);
      claimed.add(key);
      const table = observed.get(key) || null;
      const stored = table ? table.identity : mapping.physical;
      byLogical.set(mapping.logical, { mapping, observed: table, identity: stored, search: `${stored.schema}\n${stored.table}`.toLowerCase() });
      return { logical: mapping.logical, mapping, observed: table, identity: stored };
    });
    for (const table of doc.schema) {
      if (!claimed.has(identityKey(table.identity, doc.dialect))) cards.push({ logical: null, mapping: null, observed: table, identity: table.identity });
    }
    return { observed, byLogical, cards };
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

  // Catalog names shown as text. Every format, control, separator and default-ignorable character becomes a visible code point,
  // including the tab and newline that visible() keeps for SQL. Quotes stay as delimiters, so edge and repeated spaces can be seen.
  const HIDDEN_IN_NAME = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/gu;
  const PLAIN_NAME = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
  const NAME_SHOWN = 96;
  const NAME_HEAD = 64;
  const NAME_TAIL = 24;
  const codePoint = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const showHidden = (value) => value.replace(HIDDEN_IN_NAME, (c) => (c === ' ' ? c : `[${codePoint(c)}]`));
  /** True when the plain text of a name can mislead, so the exact code points are worth offering. */
  const isUnusualName = (name) => name.length > NAME_SHOWN || !PLAIN_NAME.test(name) || name.includes('[U+');

  function nameNode(name) {
    const points = Array.from(name);
    const wrap = el('span', 'ident');
    const quoted = (value) => `"${showHidden(value).replaceAll('"', '""')}"`;
    const code = document.createElement('code');
    code.className = 'mono';
    if (points.length <= NAME_SHOWN) {
      code.textContent = quoted(name);
      wrap.append(code);
      return wrap;
    }
    // Never a silent clip: the length is stated, both ends stay visible, and the exact characters are one disclosure away.
    code.textContent = `${quoted(points.slice(0, NAME_HEAD).join('')).slice(0, -1)}…${quoted(points.slice(-NAME_TAIL).join('')).slice(1)}`;
    wrap.append(code, el('span', 'ident-length', `${points.length.toLocaleString('en-US')} characters, shortened`));
    return wrap;
  }

  /** Schema and table stay two separate elements, so a table named with a dot can't read as a qualified name. */
  function identityNode(id) {
    const wrap = el('span', 'ident-pair');
    wrap.append(nameNode(id.schema), el('span', 'ident-dot', '.'), nameNode(id.table));
    return wrap;
  }

  /** Lazy, because a hostile card can hold a hundred 4 KiB names. Nothing is built until the reader asks. */
  function exactNames(entries) {
    const seen = new Set();
    const unusual = entries.filter(({ label, value }) => {
      const key = JSON.stringify([label, value]);
      if (!isUnusualName(value) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!unusual.length) return null;
    const details = el('details', 'exact');
    const summary = el('summary', 'exact-summary', `Exact characters of ${plural(unusual.length, 'unusual name', 'unusual names')}`);
    details.append(summary);
    let built = false;
    details.addEventListener('toggle', () => {
      if (!details.open || built) return;
      built = true;
      const listNode = el('dl', 'exact-list');
      listNode.tabIndex = 0;
      listNode.setAttribute('role', 'group');
      listNode.setAttribute('aria-label', 'Code points of each unusual name. Scrolls.');
      const encoder = new TextEncoder();
      for (const { label, value } of unusual) {
        const points = Array.from(value);
        const row = el('div', 'exact-row');
        row.append(el('dt', '', `${label}, ${plural(points.length, 'character', 'characters')}, ${plural(encoder.encode(value).length, 'UTF-8 byte', 'UTF-8 bytes')}`));
        const dd = el('dd', 'mono exact-points');
        dd.textContent = points.map(codePoint).join(' ');
        row.append(dd);
        listNode.append(row);
      }
      details.append(listNode);
    });
    return details;
  }

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
    // The exact bytes behind doc, set and released together with it. Immutable, and the only thing Export writes.
    sourceBlob: null,
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
    outcomes: null,
    mapping: null,
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
      applyDocument(doc, buffer, 'Served by this local studio');
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
      applyDocument(doc, buffer, `File: ${name}`);
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
    state.sourceBlob = null;
    state.origin = '';
    resetView();
    $('file-input').value = '';
    setBusy(false);
    render();
    setStatus(hadDocument
      ? 'Cleared. The trace was removed from this page. Files you exported are not affected.'
      : 'Stopped loading. Nothing is loaded and nothing was saved.');
    $('empty-title').focus();
  }

  // Empties every container that can hold trace-derived text so a cleared trace does not linger in hidden DOM.
  const TRACE_CONTAINERS = ['counts', 'thread-scroll', 'thread-scale', 'query-list', 'showing', 'errors-count', 'table-filter-name',
    'detail-body', 'schema-coverage', 'relationships', 'tables', 'results', 'facts', 'notes', 'loaded-title', 'loaded-dialect',
    'tab-count-queries', 'tab-count-schema', 'tab-count-results', 'outcome-note'];
  function purgeTraceDom() {
    for (const id of TRACE_CONTAINERS) clear($(id));
    state.rowButtons = [];
    state.paramRows = [];
    state.outcomes = null;
    state.mapping = null;
    $('table-filter').hidden = true;
    $('outcome-note').hidden = true;
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

  // Callers reach this only after validating the bytes and confirming their load is still current,
  // so a failed, superseded or canceled read can never replace what Export writes.
  function applyDocument(doc, buffer, origin) {
    state.doc = doc;
    state.sourceBlob = new Blob([buffer], { type: 'application/json' });
    state.outcomes = analyzeOutcomes(doc.queries, isPostgres(doc));
    state.mapping = buildMappingModel(doc);
    state.origin = origin;
    resetView();
    state.selected = doc.queries.length ? 0 : -1;
    selectView('queries', false);
    render();
  }

  function exportDocument() {
    const { doc, sourceBlob } = state;
    if (!doc || !sourceBlob) return;
    const stamp = doc.generatedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'export';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(sourceBlob);
    link.download = `rowstitch-${doc.source === 'fictional-demo' ? 'demo' : 'trace'}-${stamp}.json`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus(`Downloaded ${link.download}, an unchanged copy of the original trace, including any values that were not redacted and anything this page does not show, such as repeated fields. It is not sanitized, so review it before sharing.`);
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
      $('loaded-dialect').hidden = true;
      purgeTraceDom();
      return;
    }
    $('loaded-kind').textContent = doc.source === 'fictional-demo' ? 'Fictional demo' : 'Local trace';
    $('loaded-kind').className = `loaded-kind ${doc.source === 'fictional-demo' ? 'is-demo' : 'is-local'}`;
    $('loaded-dialect').textContent = backendName(doc);
    $('loaded-dialect').hidden = false;
    setText($('loaded-title'), doc.title || 'Untitled trace');
    $('tab-count-queries').textContent = doc.queries.length.toLocaleString('en-US');
    $('tab-count-schema').textContent = (state.mapping ? state.mapping.cards.length : doc.schema.length).toLocaleString('en-US');
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
    let failed = 0;
    let withPlan = 0;
    let scans = 0;
    let timed = 0;
    let total = 0;
    for (const q of doc.queries) {
      if (q.status === 'error') failed += 1;
      if (q.plan && q.plan.length) {
        withPlan += 1;
        if (!isPostgres(doc) && q.plan.some((s) => isFullScan(s.detail))) scans += 1;
      }
      if (q.durationMs !== null) { timed += 1; total += q.durationMs; }
    }
    return { failed, withPlan, scans, timed, total };
  }

  // ---------------------------------------------------------------------------
  // Transaction outcomes, inferred only from the recorded order of Rowstitch's own control statements.
  // Conservative: anything the order does not prove becomes "unknown". This never claims the current database state.
  // ---------------------------------------------------------------------------

  const MAX_OUTCOME_DEPTH = 64;
  // Exact generated forms only, compared by full string equality (no regex anchors, case folding or whitespace tolerance).
  const PLAIN_CONTROLS = Object.freeze(new Map([['BEGIN', 'begin'], ['BEGIN IMMEDIATE', 'begin'], ['COMMIT', 'commit'], ['ROLLBACK', 'rollback']]));
  const NAMED_CONTROLS = Object.freeze([
    ['ROLLBACK TO SAVEPOINT "', 'rollback-to'],
    ['RELEASE SAVEPOINT "', 'release'],
    ['SAVEPOINT "', 'savepoint'],
  ]);
  const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
  // SQL that reads like transaction control but is not recorded as a "transaction" operation is ambiguous, never ignored.
  const CONTROL_LOOKALIKE = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
  // The exact statements compilePostgresControl generates. SQLite's BEGIN forms are not PostgreSQL controls, and the reverse.
  const POSTGRES_PLAIN_CONTROLS = Object.freeze(new Map([['BEGIN READ ONLY', 'begin'], ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'begin'], ['COMMIT', 'commit'], ['ROLLBACK', 'rollback']]));
  const POSTGRES_BEGIN_MODES = Object.freeze(new Map([['BEGIN READ ONLY', 'Read only'], ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'Serializable']]));
  const POSTGRES_LOOKALIKE = /^\s*(?:START\s+TRANSACTION|ABORT|PREPARE\s+TRANSACTION)\b/i;
  const WRITE_OPERATIONS = new Set(['insert', 'update', 'delete']);
  const UNRECOGNIZED = Object.freeze({ kind: 'unrecognized', name: null });

  function parseControl(q, postgres) {
    if (q.operation !== 'transaction') return CONTROL_LOOKALIKE.test(q.sql) || (postgres && POSTGRES_LOOKALIKE.test(q.sql)) ? UNRECOGNIZED : null;
    // Rowstitch records its own control statements with no bound values and no table.
    if (q.parameters.length !== 0 || (q.table !== null && q.table !== '')) return UNRECOGNIZED;
    const plain = (postgres ? POSTGRES_PLAIN_CONTROLS : PLAIN_CONTROLS).get(q.sql);
    if (plain) return { kind: plain, name: null };
    for (const [prefix, kind] of NAMED_CONTROLS) {
      if (!q.sql.startsWith(prefix) || !q.sql.endsWith('"') || q.sql.length <= prefix.length + 1) continue;
      const name = q.sql.slice(prefix.length, -1);
      if (SAVEPOINT_NAME.test(name) && `${prefix}${name}"` === q.sql) return { kind, name };
      return UNRECOGNIZED;
    }
    return UNRECOGNIZED;
  }

  /**
   * Returns per-statement write outcomes and per-statement frame outcomes (for opening statements):
   *   writes: Map<index, {state: 'kept'|'undone'|'pending'|'unknown', by: index|null, how: string}>
   *   frames: Map<openingIndex, 'committed'|'rolled-back'|'rolled-back-to'|'unfinished'|'commit-unknown'>
   *
   * PostgreSQL differs from SQLite in three ways that change what the order of statements proves:
   * - ROLLBACK succeeds with no open transaction, so a ROLLBACK after a failed COMMIT proves nothing. A failed COMMIT may have
   *   applied (lost acknowledgment) or already ended the transaction, and the trace's "error" cannot tell these apart.
   * - A rejected COMMIT ends the transaction with no ROLLBACK, so other work can legitimately follow it.
   * - A failed statement aborts its transaction until ROLLBACK or ROLLBACK TO, so a later success there breaks the recorded order.
   */
  function analyzeOutcomes(queries, postgres = false) {
    const writes = new Map();
    const frames = new Map();
    let stack = [];
    let synced = false;
    let transactions = 0;
    let savepoints = 0;
    const settle = (indices, outcome) => { for (const i of indices) writes.set(i, outcome); };
    const desync = (at) => {
      for (const frame of stack) settle(frame.pending, { state: 'unknown', by: at, how: 'lost' });
      stack = [];
      synced = false;
    };
    const top = () => stack[stack.length - 1];
    const limit = Math.min(queries.length, 1000);
    for (let i = 0; i < limit; i += 1) {
      const q = queries[i];
      const control = parseControl(q, postgres);
      const ok = q.status === 'ok';
      if (control && control.kind === 'begin' && ok) {
        if (stack.length) desync(i);
        if (typeof q.transactionId !== 'string') { synced = false; continue; }
        stack = [{ kind: 'tx', id: q.transactionId, name: null, open: i, pending: [], commitFailed: false }];
        synced = true;
        transactions += 1;
        continue;
      }
      if (!synced) {
        if (!control && ok && WRITE_OPERATIONS.has(q.operation)) writes.set(i, { state: 'unknown', by: null, how: 'no-start' });
        continue;
      }
      if (!control) {
        const frame = top();
        const isWrite = ok && WRITE_OPERATIONS.has(q.operation);
        if (!frame) {
          // Between transactions: statements must carry no transaction id. Rowstitch wraps every write in a transaction,
          // so a write here has no recorded start or end and stays unknown.
          if (q.transactionId !== null) { if (isWrite) writes.set(i, { state: 'unknown', by: i, how: 'lost' }); desync(i); continue; }
          if (isWrite) writes.set(i, { state: 'unknown', by: null, how: 'no-start' });
          continue;
        }
        if (q.transactionId !== frame.id) { if (isWrite) writes.set(i, { state: 'unknown', by: i, how: 'lost' }); desync(i); continue; }
        if (postgres && frame.aborted && ok) { if (isWrite) writes.set(i, { state: 'unknown', by: i, how: 'lost' }); desync(i); continue; }
        if (postgres && !ok) frame.aborted = true;
        if (isWrite) frame.pending.push(i);
        continue;
      }
      const frame = top();
      if (control.kind === 'begin') {
        // A failed BEGIN with nothing open started nothing; anything else is ambiguous.
        if (!stack.length) continue;
        desync(i); continue;
      }
      if (control.kind === 'commit' && !ok) {
        if (stack.length === 1 && frame.kind === 'tx' && q.transactionId === frame.id) {
          if (postgres) {
            settle(frame.pending, { state: 'unknown', by: null, how: 'commit-failed' });
            frames.set(frame.open, 'commit-unknown');
            stack = [];
            continue;
          }
          frame.commitFailed = true;
          continue;
        }
        desync(i); continue;
      }
      if (!ok || control.kind === 'unrecognized') { desync(i); continue; }
      if (postgres && frame && frame.aborted && control.kind !== 'rollback' && control.kind !== 'rollback-to') { desync(i); continue; }
      if (control.kind === 'savepoint') {
        if (!stack.length || typeof q.transactionId !== 'string' || stack.some((f) => f.id === q.transactionId) || stack.length >= MAX_OUTCOME_DEPTH) { desync(i); continue; }
        stack.push({ kind: 'sp', id: q.transactionId, name: control.name, open: i, pending: [], commitFailed: false, rolledBackTo: false });
        savepoints += 1;
        continue;
      }
      if (control.kind === 'release' || control.kind === 'rollback-to') {
        if (!frame || frame.kind !== 'sp' || frame.name !== control.name || frame.id !== q.transactionId) { desync(i); continue; }
        if (control.kind === 'rollback-to') {
          settle(frame.pending, { state: 'undone', by: i, how: 'rollback-to' });
          frame.pending = [];
          frame.rolledBackTo = true;
          frame.aborted = false;
          continue;
        }
        stack.pop();
        top().pending.push(...frame.pending);
        if (frame.rolledBackTo) frames.set(frame.open, 'rolled-back-to');
        continue;
      }
      // COMMIT ok or ROLLBACK ok: must close exactly the one open top-level transaction.
      if (stack.length !== 1 || frame.kind !== 'tx' || frame.id !== q.transactionId || (control.kind === 'commit' && frame.commitFailed)) { desync(i); continue; }
      if (control.kind === 'commit') {
        settle(frame.pending, { state: 'kept', by: i, how: 'commit' });
        frames.set(frame.open, 'committed');
      } else {
        settle(frame.pending, { state: 'undone', by: i, how: 'rollback' });
        frames.set(frame.open, 'rolled-back');
      }
      stack = [];
    }
    for (const frame of stack) {
      settle(frame.pending, frame.commitFailed ? { state: 'unknown', by: null, how: 'commit-failed' } : { state: 'pending', by: null, how: 'unfinished' });
      if (!frame.commitFailed) frames.set(frame.open, 'unfinished');
    }
    if (queries.length > limit) for (let i = limit; i < queries.length; i += 1) if (WRITE_OPERATIONS.has(queries[i].operation)) writes.set(i, { state: 'unknown', by: null, how: 'lost' });
    const totals = { kept: 0, undone: 0, pending: 0, unknown: 0 };
    for (const outcome of writes.values()) totals[outcome.state] += 1;
    // Label a list group only when its transaction id belongs to exactly one opened frame in this trace.
    const frameById = new Map();
    const seenIds = new Map();
    const opened = new Map();
    for (let i = 0; i < limit; i += 1) {
      const control = parseControl(queries[i], postgres);
      if (control && (control.kind === 'begin' || control.kind === 'savepoint') && queries[i].status === 'ok' && typeof queries[i].transactionId === 'string') {
        seenIds.set(queries[i].transactionId, (seenIds.get(queries[i].transactionId) || 0) + 1);
        opened.set(queries[i].transactionId, control.kind === 'savepoint' ? { savepoint: true, mode: null } : { savepoint: false, mode: POSTGRES_BEGIN_MODES.get(queries[i].sql) });
      }
    }
    for (const [open, outcome] of frames) {
      const id = queries[open].transactionId;
      if (seenIds.get(id) === 1) frameById.set(id, outcome);
    }
    // PostgreSQL traces name what each group opened; a repeated id cannot be attributed, so it is not labelled.
    const openedById = new Map();
    if (postgres) for (const [id, value] of opened) if (seenIds.get(id) === 1) openedById.set(id, value);
    return { writes, frames, frameById, openedById, totals, transactions, savepoints };
  }

  const FRAME_LABELS = Object.freeze({
    committed: 'Committed in trace', 'rolled-back': 'Rolled back', 'rolled-back-to': 'Rolled back to savepoint', unfinished: 'Not finished in trace', 'commit-unknown': 'COMMIT outcome unknown',
  });
  const EFFECT_LABELS = Object.freeze({
    kept: { default: 'Committed in trace' },
    undone: { rollback: 'Undone by ROLLBACK', 'rollback-to': 'Undone by ROLLBACK TO SAVEPOINT', default: 'Undone' },
    pending: { default: 'Not finished in this trace' },
    unknown: { default: 'Unknown from this trace' },
  });
  const EFFECT_NOTES = Object.freeze({
    rollback: (doc) => `${backendName(doc)} ran this write, but its transaction was rolled back later in this trace, so the change was not kept.`,
    'rollback-to': (doc) => `${backendName(doc)} ran this write, but a later ROLLBACK TO SAVEPOINT in this trace undid it.`,
    unfinished: 'The trace ends before this write\'s transaction committed or rolled back. A trace exported inside a transaction looks like this.',
    'commit-failed': (doc) => (isPostgres(doc)
      ? 'COMMIT reported a failure, and a trace cannot show whether PostgreSQL applied it: the failure may be a rejection or a lost acknowledgment. The effect is unknown, so check the data before retrying.'
      : 'COMMIT failed and the trace ends before the transaction\'s outcome, so the effect is unknown.'),
    'no-start': 'This trace does not show where this write\'s transaction began, for example because older entries were left out, so the effect is unknown.',
    lost: 'The transaction statements around this write do not follow the order Rowstitch records, so no effect is inferred.',
  });

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
    const a = state.outcomes;
    item(doc.queries.length.toLocaleString('en-US'), doc.queries.length === 1 ? 'Statement' : 'Statements');
    item(a.transactions.toLocaleString('en-US'), `${a.transactions === 1 ? 'Transaction' : 'Transactions'}${a.savepoints ? `, ${plural(a.savepoints, 'savepoint', 'savepoints')}` : ''}`);
    item(s.failed.toLocaleString('en-US'), 'Failed', s.failed ? 'is-error' : '');
    // Scan labels read SQLite's plan text. They say nothing about a plan from another database.
    if (isPostgres(doc)) item(s.withPlan.toLocaleString('en-US'), 'Recorded plans');
    else item(`${s.scans} of ${s.withPlan}`, 'Plans with a full scan', s.scans ? 'is-warn' : '');
    const missing = doc.queries.length - s.timed;
    item(s.timed ? formatMs(s.total) : 'none', missing ? `Recorded time, ${missing} without a duration` : 'Recorded time');
    if (a.totals.undone) item(a.totals.undone.toLocaleString('en-US'), a.totals.undone === 1 ? 'Undone write' : 'Undone writes');
    const note = $('outcome-note');
    const parts = [];
    if (a.totals.pending) parts.push(`${plural(a.totals.pending, 'write is', 'writes are')} not finished in this trace`);
    if (a.totals.unknown) parts.push(`${plural(a.totals.unknown, 'write has', 'writes have')} an outcome this trace does not show`);
    note.hidden = parts.length === 0;
    note.textContent = parts.length ? `${parts.join(', and ')}. Outcomes come from the order of statements in this file.` : '';
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
      const entry = state.mapping && q.table ? state.mapping.byLogical.get(q.table) : undefined;
      const hay = `${q.id}\n${q.operation}\n${q.table || ''}\n${q.transactionId || ''}\n${q.sql}`.toLowerCase();
      if (!hay.includes(needle) && !(entry && entry.search.includes(needle))) return false;
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
      const opened = state.outcomes ? state.outcomes.openedById.get(group.tx) : undefined;
      header.append(el('span', 'tx-label', opened && opened.savepoint ? 'Savepoint' : 'Transaction'), el('code', 'tx-id mono', group.tx));
      const meta = [plural(group.items.length, 'statement', 'statements')];
      if (opened && opened.mode) meta.unshift(opened.mode);
      if (visible.length !== group.items.length) meta.push(`${visible.length} shown`);
      if (groupFailed) meta.push(`${groupFailed} failed`);
      meta.push(formatMs(groupMs));
      const frameOutcome = state.outcomes ? state.outcomes.frameById.get(group.tx) : undefined;
      if (frameOutcome) header.append(el('span', `tx-outcome is-${frameOutcome}`, FRAME_LABELS[frameOutcome]));
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
    const effect = state.outcomes ? state.outcomes.writes.get(i) : undefined;
    if (effect && (effect.state === 'undone' || effect.state === 'pending')) meta.append(el('span', `q-effect is-${effect.state}`, effect.state === 'undone' ? 'Undone' : 'Not finished'));
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

  function tokenizeSql(sql, postgres = false) {
    // Splits SQL into display tokens. Placeholders are numbered in order; quoted text is never treated as a placeholder.
    // In PostgreSQL only $n is a placeholder: ? is an operator, [ ] are array brackets, and $tag$ opens a quoted string.
    const tokens = [];
    let i = 0;
    let slot = 0;
    let plain = '';
    const flush = () => { if (plain) { tokens.push({ kind: 'plain', text: plain }); plain = ''; } };
    while (i < sql.length) {
      const c = sql[i];
      if (postgres && c === '$') {
        const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66));
        if (dollar) {
          const j = sql.indexOf(dollar[0], i + dollar[0].length);
          const end = j < 0 ? sql.length : j + dollar[0].length;
          flush();
          tokens.push({ kind: 'string', text: sql.slice(i, end) });
          i = end;
          continue;
        }
        let j = i + 1;
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j += 1;
        if (j > i + 1) {
          flush();
          const number = Number(sql.slice(i + 1, j));
          slot = Math.max(slot, number);
          tokens.push({ kind: 'slot', text: sql.slice(i, j), slot: number });
          i = j;
          continue;
        }
        plain += c;
        i += 1;
      } else if (c === '\'' || c === '"' || (!postgres && (c === '`' || c === '['))) {
        const close = c === '[' ? ']' : c;
        // PostgreSQL E'...' strings use backslash escapes, so an escaped quote does not end them.
        const escapes = postgres && c === '\'' && /(?:^|[^A-Za-z0-9_$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
        let j = i + 1;
        while (j < sql.length) {
          if (escapes && sql[j] === '\\') { j += 2; continue; }
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
      } else if (c === '?' && !postgres) {
        let j = i + 1;
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j += 1;
        flush();
        const explicit = j > i + 1 ? Number(sql.slice(i + 1, j)) : null;
        slot = explicit !== null ? Math.max(slot, explicit) : slot + 1;
        tokens.push({ kind: 'slot', text: sql.slice(i, j), slot: explicit !== null ? explicit : slot });
        i = j;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        // A PostgreSQL identifier may contain $, which then does not start a placeholder.
        while (j < sql.length && (postgres ? /[A-Za-z0-9_$]/ : /[A-Za-z0-9_]/).test(sql[j])) j += 1;
        const word = sql.slice(i, j);
        if (SQL_KEYWORDS.has(word.toUpperCase()) || (postgres && POSTGRES_KEYWORDS.has(word.toUpperCase()))) {
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
    if (state.mapping && q.table) {
      // The statement's table is the registered name. The join to the stored name goes through the mapping, never the SQL text.
      const entry = state.mapping.byLogical.get(q.table);
      const wrap = el('div', 'fact fact-stored');
      const value = el('dd', '');
      if (entry) value.append(identityNode(entry.identity));
      else value.textContent = doc.mapping.omittedTables ? 'Its mapping entry was left out of this trace' : 'This trace has no mapping entry for it';
      wrap.append(el('dt', '', 'Stored as'), value);
      facts.append(wrap);
    }
    const effect =state.outcomes ? state.outcomes.writes.get(state.selected) : undefined;
    if (effect) {
      const wrap = el('div', 'fact fact-effect');
      const value = el('dd', `effect is-${effect.state}`);
      value.append(document.createTextNode(EFFECT_LABELS[effect.state][effect.how] || EFFECT_LABELS[effect.state].default));
      if (effect.by !== null && (effect.state === 'kept' || effect.state === 'undone')) {
        const target = effect.by;
        const jump = el('button', 'link-button mono', doc.queries[target].id);
        jump.type = 'button';
        jump.setAttribute('aria-label', `Show statement ${doc.queries[target].id}`);
        jump.addEventListener('click', () => select(target, { focusDetail: true, reveal: true }));
        value.append(document.createTextNode(' at '), jump);
      }
      wrap.append(el('dt', '', 'Effect in this trace'), value);
      facts.append(wrap);
    }
    body.append(facts);
    const postgres = isPostgres(doc);
    const slotLabel = (n) => `${postgres ? '$' : '?'}${n}`;
    if (q.status === 'error') {
      body.append(el('p', 'callout is-error', `This statement failed. Traces do not carry error messages, so check your application log for the reason.${postgres ? ' A failed status can also mean the outcome was never confirmed, so it does not prove that nothing changed.' : ''}`));
    }
    if (effect && effect.state !== 'kept') {
      const note = EFFECT_NOTES[effect.how];
      body.append(el('p', 'callout is-note', typeof note === 'function' ? note(doc) : note));
    }

    // SQL
    const { tokens, slots } = tokenizeSql(q.sql, postgres);
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
        const chip = el('span', 'slot', slotLabel(t.slot));
        chip.dataset.slot = String(t.slot);
        chip.addEventListener('mouseenter', () => highlightSlot(t.slot, true));
        chip.addEventListener('mouseleave', () => highlightSlot(t.slot, false));
        code.append(chip);
      } else code.append(el('span', `tok-${t.kind}`, t.text));
    }
    pre.append(code);
    sqlBlock.append(pre);
    sqlBlock.append(el('p', 'fine', 'Numbered chips mark bound-value slots. Bound values travel separately from the SQL text and are never pasted into it here.'));
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
        tr.append(el('td', 'mono slot-cell', slotLabel(k + 1)));
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
        : (postgres ? 'This trace has no query plan for this statement.' : 'No plan in the trace. Rowstitch records EXPLAIN QUERY PLAN for generated reads.')));
    } else if (!q.plan.length) {
      planBlock.append(el('p', 'muted', 'A plan was recorded with no steps.'));
    } else {
      planBlock.append(renderPlan(q.plan, postgres));
      planBlock.append(el('p', 'fine', postgres
        ? 'Plan text from the trace, shown without interpretation. Nothing was re-run.'
        : 'From SQLite\'s EXPLAIN QUERY PLAN text in the trace. The labels are reading aids, not measurements. Nothing was re-run.'));
    }
    body.append(planBlock);
  }

  function highlightSlot(slot, on) {
    for (const r of state.paramRows) r.tr.classList.toggle('is-hot', on && r.slot === slot);
  }

  function renderPlan(plan, postgres = false) {
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
      const d = postgres ? '' : step.detail;
      if (isFullScan(d)) li.append(el('span', 'tag is-warn', 'Reads every row'));
      else if (/\bUSING (COVERING )?INDEX\b|\bUSING (INTEGER )?PRIMARY KEY\b/.test(d)) li.append(el('span', 'tag is-ok', 'Uses an index'));
      if (/\bTEMP B-TREE\b/.test(d)) li.append(el('span', 'tag', 'Temporary sort'));
      listNode.append(li);
    });
    return listNode;
  }

  function renderSchema() {
    const coverage = $('schema-coverage');
    clear(coverage);
    if (state.mapping) renderMappedSchema(coverage);
    else renderLegacySchema(coverage);
  }

  const POLICY_LABELS = new Map([
    ['legacy', 'Declared policy: legacy, this database\'s default comparison'],
    ['exact', 'Declared policy: exact, the mapped columns must match'],
    ['subset', 'Declared policy: subset, allows extra columns'],
  ]);

  function renderCoverage(host) {
    const { doc, mapping: model } = state;
    const { scope, registeredTables, omittedTables } = doc.inspection;
    const say = (tone, message) => host.append(el('p', `callout ${tone}`, message));
    const counts = `${plural(registeredTables, 'table', 'tables')} registered, ${plural(doc.schema.length, 'table', 'tables')} in this snapshot.`;
    if (scope === 'mapped') {
      say('is-note', registeredTables === 0
        ? 'No tables are registered, so none were inspected. This says nothing about the database.'
        : `Mapped tables only. Other tables may exist. ${counts}`);
    } else {
      say('is-note', `Every table this connection could see in the namespaces it inspected, at that moment. It does not prove the database is empty or unchanged since. ${registeredTables === 0 ? 'No tables are registered, so no stored names are mapped.' : counts}`);
    }
    if (doc.mapping.omittedTables) say('is-warn', `${plural(doc.mapping.omittedTables, 'registration was', 'registrations were')} left out of this file, so ${doc.mapping.omittedTables === 1 ? 'its mapping is' : 'their mappings are'} not shown.`);
    if (omittedTables) say('is-warn', `${plural(omittedTables, 'table', 'tables')} from the catalog ${omittedTables === 1 ? 'was' : 'were'} left out of this file, for example because ${omittedTables === 1 ? 'it was' : 'they were'} too large to export intact.`);
    if (model.cards.some((card) => card.mapping)) host.append(el('p', 'fine', 'Policies are what the application declared, not a check result. They do not cover triggers, row security or CHECK rules.'));
  }

  function renderMappedSchema(coverage) {
    const { doc, mapping: model } = state;
    const key = (id) => identityKey(id, doc.dialect);
    renderCoverage(coverage);

    const rel = $('relationships');
    clear(rel);
    const referencedBy = new Map();
    let constraints = 0;
    for (const table of doc.schema) {
      for (const fk of table.foreignKeys) {
        constraints += 1;
        const target = model.observed.get(key(fk.targetIdentity));
        const li = el('li', 'relationship');
        const head = el('div', 'rel-head');
        head.append(identityNode(table.identity), el('span', 'arrow', ' references '), identityNode(fk.targetIdentity));
        if (!target) head.append(el('span', 'tag', 'Table not in this snapshot'));
        if (fk.width > 1) head.append(el('span', 'tag', `${fk.width} columns together`));
        li.append(head);
        const pairs = el('ul', 'rel-pairs');
        const local = new Set(table.columns.map((c) => nameKey(c.name, doc.dialect)));
        const remote = target ? new Set(target.columns.map((c) => nameKey(c.name, doc.dialect))) : null;
        for (const pair of fk.columns) {
          const row = el('li', 'rel-pair');
          row.append(nameNode(pair.column));
          if (!local.has(nameKey(pair.column, doc.dialect))) row.append(el('span', 'tag', 'Column not in this snapshot'));
          row.append(el('span', 'arrow', ' to '));
          if (pair.target === null) row.append(el('span', 'tag is-warn', 'Target key not resolved by the catalog'));
          else {
            row.append(nameNode(pair.target));
            if (remote && !remote.has(nameKey(pair.target, doc.dialect))) row.append(el('span', 'tag', 'Column not in this snapshot'));
          }
          pairs.append(row);
        }
        li.append(pairs);
        rel.append(li);
        const refKey = key(fk.targetIdentity);
        if (!referencedBy.has(refKey)) referencedBy.set(refKey, []);
        referencedBy.get(refKey).push(table.identity);
      }
    }
    if (!constraints) rel.append(el('li', 'muted', 'No foreign keys are recorded.'));

    const host = $('tables');
    clear(host);
    host.classList.add('is-mapped');
    if (!model.cards.length) host.append(el('p', 'muted', 'No tables are listed. That says nothing about what the database holds.'));
    model.cards.forEach((card, index) => host.append(tableCard(card, index, referencedBy.get(key(card.identity)))));
  }

  function tableCard(card, index, references) {
    const { doc } = state;
    const { logical, mapping, observed } = card;
    const section = el('section', 'table-card');
    const headingId = `table-card-${index}`;
    section.setAttribute('aria-labelledby', headingId);
    const names = [];
    const note = (label, value) => names.push({ label, value });
    note('Stored schema', card.identity.schema);
    note('Stored table', card.identity.table);

    const head = el('div', 'table-head');
    const heading = el('h2', 'table-name mono');
    heading.id = headingId;
    if (logical !== null) setText(heading, logical);
    else heading.append(identityNode(card.identity));
    head.append(heading);
    if (mapping === null) head.append(el('span', 'tag', 'Not registered'));
    else if (observed) head.append(el('span', 'muted', plural(observed.columns.length, 'column', 'columns')));
    else head.append(el('span', 'tag is-warn', 'Not in this snapshot'));
    section.append(head);

    const sameColumns = mapping !== null && mapping.columns.every((c) => c.logical === c.physical);
    const sameName = mapping !== null && mapping.physical.table === mapping.logical;
    if (mapping) {
      const line = el('p', 'stored-as');
      if (sameName) {
        line.append(document.createTextNode('Stored under the same name, in '), nameNode(card.identity.schema));
      } else {
        line.append(document.createTextNode('Stored as '), identityNode(card.identity));
      }
      line.append(el('span', 'muted', mapping.schemaSource === 'default' ? ' (default schema)' : ' (named schema)'));
      section.append(line);
      section.append(el('p', 'fine policy', POLICY_LABELS.get(mapping.policy)));
    }

    if (observed) section.append(el('p', 'fine coverage-line', coverageLine(observed)));
    else {
      section.append(el('p', 'callout is-note', doc.inspection.omittedTables
        ? 'Registered, but this snapshot has no catalog entry for it. The table may not exist, or its entry may be one of those left out of this file.'
        : 'Registered, but this snapshot has no catalog entry for it. That can mean the table does not exist, or that it changed after inspection.'));
    }

    const rows = columnRows(mapping, observed);
    if (rows.length) section.append(columnTable(rows, mapping !== null && !sameColumns, note));
    if (mapping && !observed) {
      section.append(el('p', 'fine', 'Types and rules come from the catalog, so they are not known here.'));
    }

    if (observed && observed.foreignKeys.length) {
      section.append(el('p', 'fine', `${plural(observed.foreignKeys.length, 'foreign key', 'foreign keys')} from this table, listed under Relationships.`));
      for (const fk of observed.foreignKeys) {
        note('Constraint', fk.constraint);
        note('Referenced schema', fk.targetIdentity.schema);
        note('Referenced table', fk.targetIdentity.table);
        for (const pair of fk.columns) {
          note('Foreign key column', pair.column);
          if (pair.target !== null) note('Referenced column', pair.target);
        }
      }
    }
    if (references) {
      const line = el('p', 'fine referenced-by');
      line.append(document.createTextNode('Referenced by '));
      references.forEach((id, k) => {
        if (k) line.append(document.createTextNode(', '));
        line.append(identityNode(id));
      });
      section.append(line);
    }

    const exact = exactNames(names);
    if (exact) section.append(exact);

    if (logical === null) {
      section.append(el('p', 'fine', 'Not registered, so no statement in this trace is linked to it.'));
    } else {
      const used = doc.queries.filter((q) => q.table === logical).length;
      const show = el('button', 'btn btn-small', used ? `Show ${plural(used, 'statement', 'statements')}` : 'No statements recorded for this table');
      show.type = 'button';
      show.disabled = !used;
      show.addEventListener('click', () => showTableStatements(logical));
      section.append(show);
    }
    return section;
  }

  function coverageLine(table) {
    const shown = table.columns.length;
    const total = table.coverage.totalColumnCount;
    if (table.coverage.columns === 'all') return total === undefined ? 'Every column in the catalog is listed.' : `All ${plural(total, 'column', 'columns')} in the catalog ${total === 1 ? 'is' : 'are'} listed.`;
    if (total === undefined) return 'Mapped and key columns only. The catalog gave no total, so other columns may exist.';
    if (total === shown) return `Mapped and key columns only, and the catalog counts ${plural(total, 'column', 'columns')} in all.`;
    const more = total - shown;
    return `Mapped and key columns only: ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}. ${plural(more, 'more column exists', 'more columns exist')} in the database and ${more === 1 ? 'is' : 'are'} not listed.`;
  }

  /** One row per mapped property, then any observed column no property maps. Matched by comparing names for this database. */
  function columnRows(mapping, observed) {
    const dialect = state.doc.dialect;
    const catalog = new Map((observed ? observed.columns : []).map((column) => [nameKey(column.name, dialect), column]));
    const foreign = new Set();
    if (observed) for (const fk of observed.foreignKeys) for (const pair of fk.columns) foreign.add(nameKey(pair.column, dialect));
    const used = new Set();
    const rows = [];
    for (const column of mapping ? mapping.columns : []) {
      const key = nameKey(column.physical, dialect);
      const found = catalog.get(key) || null;
      if (found) used.add(key);
      rows.push({ property: column.logical, stored: found ? found.name : column.physical, column: found, foreign: foreign.has(key) });
    }
    for (const [key, column] of catalog) {
      if (!used.has(key)) rows.push({ property: null, stored: column.name, column, foreign: foreign.has(key) });
    }
    return rows;
  }

  // Explicit roles, because the narrow layout restyles these cells as a grid and CSS display would otherwise remove their table semantics.
  function columnTable(rows, showProperty, note) {
    const table = el('table', `columns mapped-columns${showProperty ? ' has-property' : ''}`);
    table.setAttribute('role', 'table');
    const headers = showProperty ? ['Property', 'Stored column', 'Type', 'Rules'] : ['Column', 'Type', 'Rules'];
    const cell = (label, className) => {
      const td = el('td', className);
      td.setAttribute('role', 'cell');
      td.dataset.label = label;
      return td;
    };
    const thead = el('thead');
    thead.setAttribute('role', 'rowgroup');
    const hr = el('tr');
    hr.setAttribute('role', 'row');
    for (const header of headers) {
      const th = el('th', '', header);
      th.setAttribute('role', 'columnheader');
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    tbody.setAttribute('role', 'rowgroup');
    for (const row of rows) {
      const tr = el('tr');
      tr.setAttribute('role', 'row');
      if (showProperty) {
        const property = cell('Property', row.property === null ? 'muted' : 'mono');
        setText(property, row.property === null ? 'Not mapped' : row.property);
        tr.append(property);
      }
      const stored = cell(showProperty ? 'Stored column' : 'Column', '');
      stored.append(nameNode(row.stored));
      note('Stored column', row.stored);
      tr.append(stored);
      const type = cell('Type', 'mono muted');
      setText(type, row.column ? (row.column.type || 'untyped') : 'Not in this snapshot');
      tr.append(type);
      const rules = [];
      if (row.column) {
        if (row.column.primaryKey) rules.push('Primary key');
        rules.push(row.column.nullable ? 'Nullable' : 'Required');
      }
      if (row.foreign) rules.push('Foreign key');
      const rule = cell('Rules', '');
      setText(rule, rules.join(' · ') || 'Not known');
      tr.append(rule);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }

  function showTableStatements(name) {
    state.table = name;
    state.search = '';
    state.op = 'all';
    state.errorsOnly = false;
    $('query-search').value = '';
    $('op-filter').value = 'all';
    selectView('queries', true);
    refreshListAndSelection();
  }

  function renderLegacySchema(coverage) {
    const doc = state.doc;
    // Version 1 never recorded stored names, so none are inferred, even where the table name looks like one.
    coverage.append(el('p', 'callout is-note', 'This trace predates mappings. It shows table names as they were recorded, with no stored names, schemas or coverage.'));
    const rel = $('relationships');
    clear(rel);
    $('tables').classList.remove('is-mapped');
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
      show.addEventListener('click', () => showTableStatements(table.name));
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
    add('Database', has(doc, 'dialect') ? `${backendName(doc)}, named by this trace` : 'SQLite. This trace names no database, as older SQLite traces do.');
    add('Loaded from', state.origin);
    add('Generated', `${doc.generatedAt} (${when.toISOString().replace('T', ' ').slice(0, 19)} UTC)`, 'mono');
    add('Statements', `${doc.queries.length.toLocaleString('en-US')}, ${s.failed} failed, ${plural(state.outcomes.transactions, 'transaction', 'transactions')}, ${plural(state.outcomes.savepoints, 'savepoint', 'savepoints')}`);
    add('Trace format', doc.version === 2 ? 'Version 2, with stored names and coverage' : 'Version 1. This trace predates mappings.');
    add('Schema', `${plural(doc.schema.length, 'table', 'tables')}, ${plural(columns, 'column', 'columns')}, ${plural(relationships, 'foreign key', 'foreign keys')}${doc.version === 2 ? ' in this snapshot' : ''}`);
    if (doc.version === 2) {
      add('Inspection', doc.inspection.scope === 'mapped' ? 'Mapped tables only. Other tables may exist.' : 'Every table visible when inspected. Not proof of an empty or unchanged database.');
      add('Registered tables', `${doc.inspection.registeredTables.toLocaleString('en-US')}, with ${doc.mapping.omittedTables.toLocaleString('en-US')} left out of the mapping and ${doc.inspection.omittedTables.toLocaleString('en-US')} left out of the snapshot`);
    }
    add('Result previews', doc.results ? plural(doc.results.length, 'preview', 'previews') : 'Not included');
    const t = state.outcomes.totals;
    add('Write effects in this trace', `${t.kept} committed, ${t.undone} undone, ${t.pending} not finished, ${t.unknown} unknown`);
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
