// Strict physical-policy and lock checks of the internal mapped-root context on real engines. Not public PostgreSQL ORM support.
// Each refusal is one defect: a native query confirms the defect exists, the policy names it, then one native repair makes the same mapping open.
import assert from 'node:assert/strict';
import { createAsyncSession } from '../../dist/core/async-session.js';
import { isAcknowledgedRejection } from '../../dist/core/executor.js';
import { readPostgresPhysical } from '../../dist/core/postgres-catalog.js';
import { createPostgresExecutor } from '../../dist/core/postgres-executor.js';
import { comparePostgresPhysical } from '../../dist/core/postgres-physical.js';
import { isPostgresRawResult } from '../../dist/core/postgres-result.js';
import { openPostgresRoots } from '../../dist/core/postgres-roots.js';
import { column, defineTable } from '../../dist/core/schema.js';

const id = () => column.integer().primaryKey();
const mapping = (suffix, columns) => defineTable('policy_' + suffix, columns);
const withValue = (suffix, value) => mapping(suffix, { id: id(), value });
const plainTable = name => `CREATE TABLE public.${name}(id BIGINT PRIMARY KEY, value BIGINT NOT NULL)`;
const COLUMN_FACT = "SELECT %s FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '%t' AND column_name = '%c'";
const columnFact = (fact, table, name = 'value') => COLUMN_FACT.replace('%s', fact).replace('%t', table).replace('%c', name);
const catalogFact = (fact, table) => `SELECT ${fact} FROM pg_catalog.pg_class c WHERE c.oid = 'public.${table}'::regclass`;
const indexFact = (fact, index) => `SELECT ${fact} FROM pg_catalog.pg_index i WHERE i.indexrelid = 'public.${index}'::regclass`;

/** One fixture per defect: { suffix, table, setup, control: [sql, expected], reason, repair }. */
function typeFixtures() {
  return [
    ['integer', 'INTEGER', 'integer', 'BIGINT'], ['integer', 'SMALLINT', 'smallint', 'BIGINT'], ['integer', 'NUMERIC', 'numeric', 'BIGINT'], ['integer', 'BIGINT[]', 'ARRAY', 'BIGINT'],
    ['bigint', 'INTEGER', 'integer', 'BIGINT'], ['bigint', 'NUMERIC(20,0)', 'numeric', 'BIGINT'],
    ['real', 'REAL', 'real', 'DOUBLE PRECISION'], ['real', 'NUMERIC', 'numeric', 'DOUBLE PRECISION'], ['real', 'BIGINT', 'bigint', 'DOUBLE PRECISION'],
    ['text', 'VARCHAR', 'character varying', 'TEXT'], ['text', 'VARCHAR(9)', 'character varying', 'TEXT'], ['text', 'CHAR(3)', 'character', 'TEXT'], ['text', 'TEXT[]', 'ARRAY', 'TEXT'],
    ['boolean', 'SMALLINT', 'smallint', 'BOOLEAN'], ['boolean', 'TEXT', 'text', 'BOOLEAN'],
    ['json', 'JSON', 'json', 'JSONB'], ['json', 'TEXT', 'text', 'JSONB'],
  ].map(([kind, physical, dataType, native], i) => {
    const suffix = 'type_' + i, name = 'policy_' + suffix;
    return {
      suffix, table: withValue(suffix, column[kind]()), setup: [`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY, value ${physical} NOT NULL)`],
      control: [columnFact('data_type', name), dataType], reason: 'COLUMN_TYPE',
      repair: [`ALTER TABLE public.${name} DROP COLUMN value`, `ALTER TABLE public.${name} ADD COLUMN value ${native} NOT NULL`],
    };
  });
}
const manualAttribute = (suffix, kind, physical, field, wrong, right) => {
  const name = 'policy_' + suffix, target = `attrelid = 'public.${name}'::regclass AND attname = 'value'`;
  return { suffix, table: withValue(suffix, column[kind]()), setup: [`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY, value ${physical} NOT NULL)`, `UPDATE pg_catalog.pg_attribute SET ${field} = ${wrong} WHERE ${target}`],
    control: [`SELECT ${field}::text FROM pg_catalog.pg_attribute WHERE ${target}`, String(wrong)], reason: 'COLUMN_TYPE', repair: [`UPDATE pg_catalog.pg_attribute SET ${field} = ${right} WHERE ${target}`] };
};
const COLUMN_FIXTURES = () => [
  // No native DDL gives the six types a type modifier or array dimensions, so these two need a catalog update.
  manualAttribute('manual_typmod', 'text', 'TEXT', 'atttypmod', 13, -1),
  manualAttribute('manual_dimensions', 'bigint', 'BIGINT', 'attndims', 1, 0),
  { suffix: 'domain', table: withValue('domain', column.bigint()), setup: ['CREATE DOMAIN public.policy_big AS BIGINT', 'CREATE TABLE public.policy_domain(id BIGINT PRIMARY KEY, value public.policy_big NOT NULL)'],
    control: [columnFact('domain_name', 'policy_domain'), 'policy_big'], reason: 'COLUMN_TYPE', repair: ['ALTER TABLE public.policy_domain DROP COLUMN value', 'ALTER TABLE public.policy_domain ADD COLUMN value BIGINT NOT NULL'] },
  { suffix: 'nullable_physical', table: withValue('nullable_physical', column.bigint()), setup: ['CREATE TABLE public.policy_nullable_physical(id BIGINT PRIMARY KEY, value BIGINT)'],
    control: [columnFact('is_nullable', 'policy_nullable_physical'), 'YES'], reason: 'COLUMN_NULLABILITY', repair: ['ALTER TABLE public.policy_nullable_physical ALTER COLUMN value SET NOT NULL'] },
  { suffix: 'nullable_mapped', table: withValue('nullable_mapped', column.bigint().nullable()), setup: [plainTable('policy_nullable_mapped')],
    control: [columnFact('is_nullable', 'policy_nullable_mapped'), 'NO'], reason: 'COLUMN_NULLABILITY', repair: ['ALTER TABLE public.policy_nullable_mapped ALTER COLUMN value DROP NOT NULL'] },
  { suffix: 'not_valid', table: withValue('not_valid', column.bigint()), setup: ['CREATE TABLE public.policy_not_valid(id BIGINT PRIMARY KEY, value BIGINT)', 'ALTER TABLE public.policy_not_valid ADD CONSTRAINT policy_not_valid_value NOT NULL value NOT VALID'],
    control: ["SELECT k.convalidated::text FROM pg_catalog.pg_constraint k WHERE k.conname = 'policy_not_valid_value'", 'false'], reason: 'COLUMN_NOT_NULL_INVALID', repair: ['ALTER TABLE public.policy_not_valid VALIDATE CONSTRAINT policy_not_valid_value'] },
  { suffix: 'extra', table: mapping('extra', { id: id() }), setup: [plainTable('policy_extra')],
    control: [columnFact('column_name', 'policy_extra'), 'value'], reason: 'COLUMN_SET', repair: ['ALTER TABLE public.policy_extra DROP COLUMN value'] },
  { suffix: 'absent_column', table: withValue('absent_column', column.bigint()), setup: ['CREATE TABLE public.policy_absent_column(id BIGINT PRIMARY KEY)'],
    control: ["SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policy_absent_column'", '1'], reason: 'COLUMN_SET', repair: ['ALTER TABLE public.policy_absent_column ADD COLUMN value BIGINT NOT NULL'] },
  { suffix: 'case_column', table: withValue('case_column', column.bigint()), setup: ['CREATE TABLE public.policy_case_column(id BIGINT PRIMARY KEY, "Value" BIGINT NOT NULL)'],
    control: [columnFact('column_name', 'policy_case_column', 'Value'), 'Value'], reason: 'COLUMN_SET', repair: ['ALTER TABLE public.policy_case_column RENAME COLUMN "Value" TO value'] },
];
const GENERATED_FIXTURES = () => [
  { suffix: 'stored', table: withValue('stored', column.bigint().nullable()), setup: ['CREATE TABLE public.policy_stored(id BIGINT PRIMARY KEY, value BIGINT GENERATED ALWAYS AS (id) STORED)'],
    control: [columnFact('is_generated', 'policy_stored'), 'ALWAYS'], reason: 'COLUMN_GENERATED', repair: ['ALTER TABLE public.policy_stored ALTER COLUMN value DROP EXPRESSION'] },
  { suffix: 'virtual', table: withValue('virtual', column.bigint().nullable()), setup: ['CREATE TABLE public.policy_virtual(id BIGINT PRIMARY KEY, value BIGINT GENERATED ALWAYS AS (id) VIRTUAL)'],
    control: ["SELECT a.attgenerated::text FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.policy_virtual'::regclass AND a.attname = 'value'", 'v'], reason: 'COLUMN_GENERATED',
    repair: ['ALTER TABLE public.policy_virtual DROP COLUMN value', 'ALTER TABLE public.policy_virtual ADD COLUMN value BIGINT'] },
  { suffix: 'identity_always', table: mapping('identity_always', { id: id() }), setup: ['CREATE TABLE public.policy_identity_always(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)'],
    control: [columnFact('identity_generation', 'policy_identity_always', 'id'), 'ALWAYS'], reason: 'COLUMN_IDENTITY', repair: ['ALTER TABLE public.policy_identity_always ALTER COLUMN id DROP IDENTITY'] },
  { suffix: 'identity_default', table: mapping('identity_default', { id: id() }), setup: ['CREATE TABLE public.policy_identity_default(id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)'],
    control: [columnFact('identity_generation', 'policy_identity_default', 'id'), 'BY DEFAULT'], reason: 'COLUMN_IDENTITY', repair: ['ALTER TABLE public.policy_identity_default ALTER COLUMN id DROP IDENTITY'] },
  { suffix: 'generated_plain', table: mapping('generated_plain', { id: column.integer().primaryKey({ generated: true }) }), setup: ['CREATE TABLE public.policy_generated_plain(id BIGINT PRIMARY KEY)'],
    control: [columnFact('is_identity', 'policy_generated_plain', 'id'), 'NO'], reason: 'COLUMN_IDENTITY', repair: ['ALTER TABLE public.policy_generated_plain ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY'] },
  { suffix: 'default_absent', table: withValue('default_absent', column.bigint().default(1n)), setup: [plainTable('policy_default_absent')],
    control: [`SELECT (${columnFact('column_default', 'policy_default_absent')}) IS NULL`, 't'], reason: 'COLUMN_DEFAULT', repair: ['ALTER TABLE public.policy_default_absent ALTER COLUMN value SET DEFAULT 1'] },
];
const addKey = (name, keys = 'id') => `ALTER TABLE public.${name} ADD PRIMARY KEY (${keys})`;
const dropKey = name => `ALTER TABLE public.${name} DROP CONSTRAINT ${name}_pkey`;
const KEY_FIXTURES = () => [
  { suffix: 'no_key', table: mapping('no_key', { id: id() }), setup: ['CREATE TABLE public.policy_no_key(id BIGINT NOT NULL)'],
    control: ["SELECT count(*)::text FROM information_schema.table_constraints WHERE table_name = 'policy_no_key' AND constraint_type = 'PRIMARY KEY'", '0'], reason: 'PRIMARY_KEY', repair: [addKey('policy_no_key')] },
  { suffix: 'other_key', table: withValue('other_key', column.bigint()), setup: ['CREATE TABLE public.policy_other_key(id BIGINT NOT NULL, value BIGINT PRIMARY KEY)'],
    control: ["SELECT column_name FROM information_schema.key_column_usage WHERE constraint_name = 'policy_other_key_pkey'", 'value'], reason: 'PRIMARY_KEY', repair: [dropKey('policy_other_key'), addKey('policy_other_key')] },
  { suffix: 'wider_key', table: withValue('wider_key', column.bigint()), setup: ['CREATE TABLE public.policy_wider_key(id BIGINT NOT NULL, value BIGINT NOT NULL, PRIMARY KEY (id, value))'],
    control: ["SELECT count(*)::text FROM information_schema.key_column_usage WHERE constraint_name = 'policy_wider_key_pkey'", '2'], reason: 'PRIMARY_KEY', repair: [dropKey('policy_wider_key'), addKey('policy_wider_key')] },
  { suffix: 'narrower_key', table: mapping('narrower_key', { id: id(), value: column.bigint().primaryKey() }), setup: [plainTable('policy_narrower_key')],
    control: ["SELECT count(*)::text FROM information_schema.key_column_usage WHERE constraint_name = 'policy_narrower_key_pkey'", '1'], reason: 'PRIMARY_KEY', repair: [dropKey('policy_narrower_key'), addKey('policy_narrower_key', 'value, id')] },
  { suffix: 'deferrable_key', table: mapping('deferrable_key', { id: id() }), setup: ['CREATE TABLE public.policy_deferrable_key(id BIGINT PRIMARY KEY DEFERRABLE INITIALLY IMMEDIATE)'],
    control: [indexFact('i.indimmediate::text', 'policy_deferrable_key_pkey'), 'false'], reason: 'PRIMARY_KEY', repair: [dropKey('policy_deferrable_key'), addKey('policy_deferrable_key')] },
  { suffix: 'included_key', table: withValue('included_key', column.bigint()), setup: ['CREATE TABLE public.policy_included_key(id BIGINT NOT NULL, value BIGINT NOT NULL, PRIMARY KEY (id) INCLUDE (value))'],
    control: [indexFact('(i.indnatts - i.indnkeyatts)::text', 'policy_included_key_pkey'), '1'], reason: 'PRIMARY_KEY', repair: [dropKey('policy_included_key'), addKey('policy_included_key')] },
  // These three flags are set by a direct catalog update. A natural failed build isn't possible for a primary key created this way.
  ...['indisvalid', 'indisready', 'indislive'].map(flag => {
    const suffix = 'manual_' + flag, name = 'policy_' + suffix;
    return { suffix, table: mapping(suffix, { id: id() }), setup: [`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY)`, `UPDATE pg_catalog.pg_index SET ${flag} = false WHERE indexrelid = 'public.${name}_pkey'::regclass`],
      control: [indexFact(`i.${flag}::text`, name + '_pkey'), 'false'], reason: 'PRIMARY_KEY', repair: [`UPDATE pg_catalog.pg_index SET ${flag} = true WHERE indexrelid = 'public.${name}_pkey'::regclass`] };
  }),
  // PostgreSQL refuses a primary key whose index collation differs from its column (42809), so each side alone needs a catalog update.
  { suffix: 'manual_index_collation', table: mapping('manual_index_collation', { id: column.text().primaryKey() }), setup: ['CREATE TABLE public.policy_manual_index_collation(id TEXT PRIMARY KEY)', `UPDATE pg_catalog.pg_index SET indcollation = '950'::pg_catalog.oidvector WHERE indexrelid = 'public.policy_manual_index_collation_pkey'::regclass`],
    control: [indexFact('i.indcollation::text', 'policy_manual_index_collation_pkey'), '950'], reason: 'KEY_COLLATION', repair: [`UPDATE pg_catalog.pg_index SET indcollation = '100'::pg_catalog.oidvector WHERE indexrelid = 'public.policy_manual_index_collation_pkey'::regclass`] },
  { suffix: 'manual_column_collation', table: mapping('manual_column_collation', { id: column.text().primaryKey() }), setup: ['CREATE TABLE public.policy_manual_column_collation(id TEXT PRIMARY KEY)', `UPDATE pg_catalog.pg_attribute SET attcollation = 950 WHERE attrelid = 'public.policy_manual_column_collation'::regclass AND attname = 'id'`],
    control: [indexFact('i.indcollation::text', 'policy_manual_column_collation_pkey'), '100'], reason: 'KEY_COLLATION', repair: [`UPDATE pg_catalog.pg_attribute SET attcollation = 100 WHERE attrelid = 'public.policy_manual_column_collation'::regclass AND attname = 'id'`] },
  { suffix: 'key_collation', table: mapping('key_collation', { id: column.text().primaryKey() }), setup: ['CREATE TABLE public.policy_key_collation(id TEXT COLLATE "C" PRIMARY KEY)'],
    control: [columnFact('collation_name', 'policy_key_collation', 'id'), 'C'], reason: 'KEY_COLLATION', repair: ['ALTER TABLE public.policy_key_collation ALTER COLUMN id TYPE TEXT COLLATE "default"'] },
];
const uniqueIndex = (name, nulls = '') => `CREATE UNIQUE INDEX ${name}_good ON public.${name}(value)${nulls}`;
const UNIQUE_FIXTURES = () => {
  const fixture = (suffix, extra, control, nullable = false, repairFirst = []) => {
    const name = 'policy_' + suffix;
    return { suffix, table: withValue(suffix, nullable ? column.bigint().nullable().unique() : column.bigint().unique()),
      setup: [`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY, value BIGINT${nullable ? '' : ' NOT NULL'})`, ...extra(name)], control, reason: 'UNIQUE', repair: [...repairFirst, uniqueIndex(name)] };
  };
  return [
    fixture('unique_none', () => [], ["SELECT count(*)::text FROM pg_catalog.pg_indexes WHERE tablename = 'policy_unique_none' AND indexname <> 'policy_unique_none_pkey'", '0']),
    fixture('unique_plain', name => [`CREATE INDEX ${name}_i ON public.${name}(value)`], [indexFact('i.indisunique::text', 'policy_unique_plain_i'), 'false']),
    fixture('unique_partial', name => [`CREATE UNIQUE INDEX ${name}_i ON public.${name}(value) WHERE value > 0`], [indexFact('(i.indpred IS NOT NULL)::text', 'policy_unique_partial_i'), 'true']),
    fixture('unique_composite', name => [`CREATE UNIQUE INDEX ${name}_i ON public.${name}(value, id)`], [indexFact('i.indnkeyatts::text', 'policy_unique_composite_i'), '2']),
    fixture('unique_expression', name => [`CREATE UNIQUE INDEX ${name}_i ON public.${name}((value + 1))`], [indexFact('(i.indexprs IS NOT NULL)::text', 'policy_unique_expression_i'), 'true']),
    fixture('unique_deferrable', name => [`ALTER TABLE public.${name} ADD CONSTRAINT ${name}_u UNIQUE (value) DEFERRABLE`], [indexFact('i.indimmediate::text', 'policy_unique_deferrable_u'), 'false']),
    fixture('unique_nulls', name => [`CREATE UNIQUE INDEX ${name}_i ON public.${name}(value) NULLS NOT DISTINCT`], [indexFact('i.indnullsnotdistinct::text', 'policy_unique_nulls_i'), 'true'], true, ['DROP INDEX public.policy_unique_nulls_i']),
    // A natural invalid index: a concurrent build that failed on duplicates, leaving the catalog entry behind.
    fixture('unique_invalid', name => [`INSERT INTO public.${name} VALUES (1, 7), (2, 7)`, { expectRejected: `CREATE UNIQUE INDEX CONCURRENTLY ${name}_i ON public.${name}(value)` }], [indexFact('i.indisvalid::text', 'policy_unique_invalid_i'), 'false'], false, ['DROP INDEX public.policy_unique_invalid_i', 'DELETE FROM public.policy_unique_invalid']),
  ];
};
const RELATION_FIXTURES = () => {
  const replaced = (name, drop) => [drop, `CREATE TABLE public.${name}(id BIGINT PRIMARY KEY)`];
  const only = suffix => mapping(suffix, { id: id() });
  const relkind = (name, kind) => [catalogFact('c.relkind::text', name), kind];
  return [
    { suffix: 'view', table: only('view'), setup: ['CREATE VIEW public.policy_view AS SELECT 1::bigint AS id'], control: relkind('policy_view', 'v'), reason: 'RELATION_KIND', repair: replaced('policy_view', 'DROP VIEW public.policy_view') },
    { suffix: 'matview', table: only('matview'), setup: ['CREATE MATERIALIZED VIEW public.policy_matview AS SELECT 1::bigint AS id'], control: relkind('policy_matview', 'm'), reason: 'RELATION_KIND', repair: replaced('policy_matview', 'DROP MATERIALIZED VIEW public.policy_matview') },
    { suffix: 'parted', table: only('parted'), setup: ['CREATE TABLE public.policy_parted(id BIGINT PRIMARY KEY) PARTITION BY RANGE (id)'], control: relkind('policy_parted', 'p'), reason: 'RELATION_KIND', repair: replaced('policy_parted', 'DROP TABLE public.policy_parted') },
    { suffix: 'part', table: only('part'), setup: ['CREATE TABLE public.policy_part_root(id BIGINT PRIMARY KEY) PARTITION BY RANGE (id)', 'CREATE TABLE public.policy_part PARTITION OF public.policy_part_root FOR VALUES FROM (0) TO (10)'],
      control: [catalogFact('c.relispartition::text', 'policy_part'), 'true'], reason: 'RELATION_KIND', repair: ['ALTER TABLE public.policy_part_root DETACH PARTITION public.policy_part'] },
    { suffix: 'foreign', table: only('foreign'), setup: ['CREATE FOREIGN DATA WRAPPER policy_wrapper', 'CREATE SERVER policy_server FOREIGN DATA WRAPPER policy_wrapper', 'CREATE FOREIGN TABLE public.policy_foreign(id BIGINT) SERVER policy_server'],
      control: relkind('policy_foreign', 'f'), reason: 'RELATION_KIND', repair: replaced('policy_foreign', 'DROP FOREIGN TABLE public.policy_foreign') },
    { suffix: 'sequence', table: only('sequence'), setup: ['CREATE SEQUENCE public.policy_sequence'], control: relkind('policy_sequence', 'S'), reason: 'RELATION_KIND', repair: replaced('policy_sequence', 'DROP SEQUENCE public.policy_sequence') },
    { suffix: 'composite', table: only('composite'), setup: ['CREATE TYPE public.policy_composite AS (id BIGINT)'], control: relkind('policy_composite', 'c'), reason: 'RELATION_KIND', repair: replaced('policy_composite', 'DROP TYPE public.policy_composite') },
    { suffix: 'unlogged', table: only('unlogged'), setup: ['CREATE UNLOGGED TABLE public.policy_unlogged(id BIGINT PRIMARY KEY)'], control: [catalogFact('c.relpersistence::text', 'policy_unlogged'), 'u'], reason: 'RELATION_PERSISTENCE', repair: ['ALTER TABLE public.policy_unlogged SET LOGGED'] },
    // The repair leaves relhassubclass stale. See the control in `repairControl`.
    { suffix: 'parent', table: only('parent'), setup: ['CREATE TABLE public.policy_parent(id BIGINT PRIMARY KEY)', 'CREATE TABLE public.policy_parent_child(id BIGINT PRIMARY KEY) INHERITS (public.policy_parent)'],
      control: ["SELECT count(*)::text FROM pg_catalog.pg_inherits WHERE inhparent = 'public.policy_parent'::regclass", '1'], reason: 'INHERITANCE', repair: ['ALTER TABLE public.policy_parent_child NO INHERIT public.policy_parent'],
      repairControl: [catalogFact('c.relhassubclass::text', 'policy_parent'), 'true'] },
    { suffix: 'child', table: only('child'), setup: ['CREATE TABLE public.policy_child_root(id BIGINT PRIMARY KEY)', 'CREATE TABLE public.policy_child(id BIGINT PRIMARY KEY) INHERITS (public.policy_child_root)'],
      control: ["SELECT count(*)::text FROM pg_catalog.pg_inherits WHERE inhrelid = 'public.policy_child'::regclass", '1'], reason: 'INHERITANCE', repair: ['ALTER TABLE public.policy_child NO INHERIT public.policy_child_root'] },
    { suffix: 'rls', table: only('rls'), setup: ['CREATE TABLE public.policy_rls(id BIGINT PRIMARY KEY)', 'ALTER TABLE public.policy_rls ENABLE ROW LEVEL SECURITY'], control: ["SELECT rowsecurity::text FROM pg_catalog.pg_tables WHERE tablename = 'policy_rls'", 'true'], reason: 'ROW_SECURITY', repair: ['ALTER TABLE public.policy_rls DISABLE ROW LEVEL SECURITY'] },
    { suffix: 'rls_forced', table: only('rls_forced'), setup: ['CREATE TABLE public.policy_rls_forced(id BIGINT PRIMARY KEY)', 'ALTER TABLE public.policy_rls_forced FORCE ROW LEVEL SECURITY'], control: [catalogFact('c.relforcerowsecurity::text', 'policy_rls_forced'), 'true'], reason: 'ROW_SECURITY', repair: ['ALTER TABLE public.policy_rls_forced NO FORCE ROW LEVEL SECURITY'] },
    { suffix: 'rule', table: only('rule'), setup: ['CREATE TABLE public.policy_rule(id BIGINT PRIMARY KEY)', 'CREATE RULE policy_keep AS ON DELETE TO public.policy_rule DO INSTEAD NOTHING'], control: ["SELECT count(*)::text FROM pg_catalog.pg_rules WHERE tablename = 'policy_rule'", '1'], reason: 'REWRITE_RULES', repair: ['DROP RULE policy_keep ON public.policy_rule'] },
    ...[['enabled', ''], ['disabled', 'ALTER TABLE public.policy_trigger_disabled DISABLE TRIGGER policy_t'], ['always', 'ALTER TABLE public.policy_trigger_always ENABLE ALWAYS TRIGGER policy_t']].map(([state, change]) => {
      const name = 'policy_trigger_' + state;
      return { suffix: 'trigger_' + state, table: only('trigger_' + state), setup: [`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY)`, `CREATE TRIGGER policy_t BEFORE INSERT ON public.${name} FOR EACH ROW EXECUTE FUNCTION public.policy_noop()`, ...(change ? [change] : [])],
        control: [`SELECT g.tgenabled::text FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'public.${name}'::regclass AND g.tgname = 'policy_t'`, { enabled: 'O', disabled: 'D', always: 'A' }[state]], reason: 'USER_TRIGGERS', repair: [`DROP TRIGGER policy_t ON public.${name}`] };
    }),
    { suffix: 'trigger_truncate', table: only('trigger_truncate'), setup: ['CREATE TABLE public.policy_trigger_truncate(id BIGINT PRIMARY KEY)', 'CREATE TRIGGER policy_t BEFORE TRUNCATE ON public.policy_trigger_truncate FOR EACH STATEMENT EXECUTE FUNCTION public.policy_noop()'],
      control: ["SELECT count(*)::text FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'public.policy_trigger_truncate'::regclass AND NOT g.tgisinternal", '1'], reason: 'USER_TRIGGERS', repair: ['DROP TRIGGER policy_t ON public.policy_trigger_truncate'] },
  ];
};
const rejected = sqlstate => error => { assert.equal(error?.code, sqlstate); return true; };
const reasonOf = error => /: ([A-Z_]+)\.$/.exec(String(error?.message))?.[1];

export async function checkSchemaPolicy(name, connect) {
  const native = await connect(), cases = [];
  let failed = false;
  const run = async (sql, parameters = []) => (await native.query(sql, parameters)).rows;
  const value = async sql => { const rows = await run(sql); return rows[0]?.join('|'); };
  const open = ({ readOnly = false } = {}) => {
    const sent = [];
    // These sessions share the one fixture connection, which also suits the single-connection engine, and don't own its close.
    const transport = { ...native, async close() {}, query(sql, parameters) { sent.push(sql); return native.query(sql, parameters); } };
    return { sent, session: createAsyncSession(createPostgresExecutor(transport), { dialect: 'postgresql', isResult: isPostgresRawResult, readOnly }) };
  };
  async function refuses(table, reason, { schema = 'public', code = 'SCHEMA', label = table.name } = {}) {
    const { session, sent } = open();
    await assert.rejects(openPostgresRoots(session, { tables: [table], schema }), error => {
      assert.equal(error?.code, code, label); assert.equal(reasonOf(error), reason, label + ': ' + error?.message); return true;
    });
    assert.ok(sent.every(sql => !/^(?:INSERT|LOCK)/.test(sql)), label + ': a refused open only reads');
    if (code === 'SCHEMA') assert.equal(comparePostgresPhysical(table, schema, await readPostgresPhysical(session, table, schema)), reason, label + ' direct comparison');
    await session.close();
  }
  async function opens(table, options = {}) {
    const { session } = open();
    const roots = await openPostgresRoots(session, { tables: [table], ...options });
    return { roots, session };
  }
  async function repaired(table, options = {}) {
    const { roots, session } = await opens(table, options);
    assert.equal(typeof await roots.count(table), 'number', table.name + ' opens and counts');
    await session.close();
  }
  /** The defect exists natively, the policy names it, and one native repair makes the same mapping open. */
  async function defect(f) {
    for (const step of f.setup) {
      if (typeof step === 'string') await run(step);
      else await assert.rejects(native.query(step.expectRejected, []), error => native.serverError(error)?.sqlstate === '23505', f.suffix + ' natural failure');
    }
    assert.equal(await value(f.control[0]), f.control[1], f.suffix + ' native control');
    await refuses(f.table, f.reason, { label: f.suffix });
    for (const step of f.repair) await run(step);
    if (f.repairControl) assert.equal(await value(f.repairControl[0]), f.repairControl[1], f.suffix + ' repair control');
    await repaired(f.table);
  }
  const group = async (fixtures, text) => { for (const f of fixtures()) await defect(f); cases.push(text + ' (' + fixtures().length + ' fixtures, each with native control and repair)'); };
  try {
    await run(`CREATE FUNCTION public.policy_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);

    // Positive controls first: without these, every refusal below could be a broken context.
    {
      const table = mapping('six', { id: id(), exact: column.bigint(), ratio: column.real(), label: column.text(), enabled: column.boolean(), data: column.json() });
      await run('CREATE TABLE public.policy_six(id BIGINT PRIMARY KEY, exact BIGINT NOT NULL, ratio DOUBLE PRECISION NOT NULL, label TEXT NOT NULL, enabled BOOLEAN NOT NULL, data JSONB NOT NULL)');
      const { roots, session } = await opens(table);
      const row = { id: 1, exact: 9223372036854775807n, ratio: 0.30000000000000004, label: 'é𝄞', enabled: true, data: { a: [1, null] } };
      assert.deepEqual(await roots.insert(table, row), row);
      assert.deepEqual(await roots.byKey(table, { id: 1 }), row);
      assert.deepEqual(await run('SELECT exact::text, ratio::text, label, enabled::text, data::text FROM ONLY public.policy_six'), [['9223372036854775807', '0.30000000000000004', 'é𝄞', 'true', '{"a": [1, null]}']]);
      await session.close();
      cases.push('an exact six-kind table opens and round-trips against independent native SQL');
    }
    {
      const table = mapping('reversed', { a: column.bigint().primaryKey(), b: column.text().primaryKey(), note: column.text() });
      await run('CREATE TABLE public.policy_reversed(b TEXT, a BIGINT, note TEXT NOT NULL, PRIMARY KEY (b, a))');
      assert.deepEqual(await run("SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.key_column_usage WHERE constraint_name = 'policy_reversed_pkey'"), [['b,a']]);
      const { roots, session } = await opens(table);
      await roots.insert(table, { a: 1n, b: 'x', note: 'first' }); await roots.insert(table, { a: 1n, b: 'y', note: 'second' });
      assert.equal((await roots.byKey(table, { a: 1n, b: 'y' })).note, 'second');
      assert.equal(await roots.byKey(table, { a: 2n, b: 'y' }), null);
      await session.close();
      cases.push('a composite key in reversed physical and column order opens, and all key components select the row');
    }
    {
      const table = mapping('defaults', { id: id(), plain: column.bigint(), maybe: column.text().nullable(), declared: column.bigint().default(1n) });
      await run("CREATE TABLE public.policy_defaults(id BIGINT PRIMARY KEY, plain BIGINT NOT NULL DEFAULT 777, maybe TEXT DEFAULT 'engine', declared BIGINT NOT NULL DEFAULT 999)");
      assert.equal(await value("SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'policy_defaults' AND column_default IS NOT NULL"), '3');
      const { roots, session } = await opens(table);
      await roots.insert(table, { id: 1, plain: 5n, maybe: null, declared: 6n });
      assert.deepEqual(await run('SELECT plain::text, maybe, declared::text FROM ONLY public.policy_defaults'), [['5', null, '6']]);
      await session.close();
      // Stated limitation made visible: the mapped default is 1, the physical one 999, and only presence is checked.
      cases.push('physical defaults are allowed and never used, because inserts stay explicit; a differing default expression is not detected');
    }
    {
      const parent = mapping('fk_parent', { id: id() }), child = mapping('fk_child', { id: id(), parent_id: column.bigint(), amount: column.bigint() }), late = mapping('fk_late', { id: id(), parent_id: column.bigint() });
      await run('CREATE TABLE public.policy_fk_parent(id BIGINT PRIMARY KEY)');
      await run('CREATE TABLE public.policy_fk_child(id BIGINT PRIMARY KEY, parent_id BIGINT NOT NULL REFERENCES public.policy_fk_parent(id), amount BIGINT NOT NULL CHECK (amount > 0))');
      await run('CREATE TABLE public.policy_fk_late(id BIGINT PRIMARY KEY, parent_id BIGINT NOT NULL REFERENCES public.policy_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)');
      assert.ok(Number(await value("SELECT count(*)::text FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.policy_fk_child'::regclass AND tgisinternal")) > 0, 'internal FK triggers exist');
      const { session } = open(), roots = await openPostgresRoots(session, { tables: [parent, child, late] });
      await roots.insert(parent, { id: 1 });
      await roots.insert(child, { id: 1, parent_id: 1n, amount: 5n });
      const refused = wanted => error => { assert.equal(error?.code, wanted); assert.ok(isAcknowledgedRejection(error)); return true; };
      await assert.rejects(roots.insert(child, { id: 2, parent_id: 99n, amount: 5n }), refused('CONSTRAINT'));
      await assert.rejects(roots.insert(child, { id: 3, parent_id: 1n, amount: -1n }), refused('CONSTRAINT'));
      await assert.rejects(roots.insert(late, { id: 1, parent_id: 99n }), refused('CONSTRAINT'));
      assert.equal(await roots.count(child), 1); assert.equal(await roots.count(late), 0);
      await session.close();
      cases.push('physical FK and CHECK are allowed: internal triggers do not count, violations are definite and the context stays usable');
    }
    {
      await run('CREATE TABLE public.policy_gap(id BIGINT PRIMARY KEY, gone BIGINT, value BIGINT NOT NULL)');
      await run('ALTER TABLE public.policy_gap DROP COLUMN gone');
      await repaired(withValue('gap', column.bigint()));
      const free = mapping('free', { id: id(), key: column.text(), note: column.text() });
      await run('CREATE TABLE public.policy_free(id BIGINT PRIMARY KEY, key TEXT COLLATE "C" NOT NULL, note TEXT NOT NULL)');
      await repaired(free);
      cases.push('a dropped-column gap and a non-default collation outside the key are allowed');
    }
    {
      const nullable = withValue('unique_ok', column.bigint().nullable().unique());
      await run('CREATE TABLE public.policy_unique_ok(id BIGINT PRIMARY KEY, value BIGINT)');
      await run('CREATE UNIQUE INDEX policy_unique_ok_i ON public.policy_unique_ok(value)');
      const { roots, session } = await opens(nullable);
      await roots.insert(nullable, { id: 1, value: null }); await roots.insert(nullable, { id: 2, value: null });
      await assert.rejects(roots.insert(nullable, { id: 3, value: 5n }).then(() => roots.insert(nullable, { id: 4, value: 5n })), error => error.code === 'CONSTRAINT');
      await session.close();
      await run('CREATE TABLE public.policy_nulls_native(id BIGINT PRIMARY KEY, value BIGINT)');
      await run('CREATE UNIQUE INDEX policy_nulls_native_i ON public.policy_nulls_native(value) NULLS NOT DISTINCT');
      await run('INSERT INTO public.policy_nulls_native VALUES (1, NULL)');
      await assert.rejects(native.query('INSERT INTO public.policy_nulls_native VALUES (2, NULL)', []), error => native.serverError(error)?.sqlstate === '23505', 'the semantic the policy refuses for a nullable mapping');
      const strict = withValue('nulls_strict', column.bigint().unique());
      await run('CREATE TABLE public.policy_nulls_strict(id BIGINT PRIMARY KEY, value BIGINT NOT NULL)');
      await run('CREATE UNIQUE INDEX policy_nulls_strict_i ON public.policy_nulls_strict(value) NULLS NOT DISTINCT');
      await repaired(strict);
      const included = withValue('unique_included', column.bigint().unique());
      await run('CREATE TABLE public.policy_unique_included(id BIGINT PRIMARY KEY, value BIGINT NOT NULL)');
      await run('CREATE UNIQUE INDEX policy_unique_included_i ON public.policy_unique_included(value) INCLUDE (id)');
      await repaired(included);
      cases.push('unique: a nullable mapping keeps native multiple NULLs with a distinct index; a not-null mapping may use NULLS NOT DISTINCT or INCLUDE');
    }
    {
      const table = mapping('identity_ok', { id: column.integer().primaryKey({ generated: true }), name: column.text() });
      const serial = mapping('serial_ok', { id: column.integer().primaryKey({ generated: true }) });
      await run('CREATE TABLE public.policy_identity_ok(id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL)');
      await run('CREATE TABLE public.policy_serial_ok(id BIGSERIAL PRIMARY KEY)');
      const { roots, session } = await opens(table);
      assert.equal(await roots.count(table), 0);
      await assert.rejects(roots.insert(table, { id: 1, name: 'refused' }), error => error.code === 'QUERY');
      assert.equal(await roots.count(table), 0);
      await session.close();
      await repaired(serial);
      cases.push('a generated mapping opens for reads on native identity or a serial default, and the current compiler still refuses its insert');
    }

    await group(typeFixtures, 'near-miss native types are refused as COLUMN_TYPE');
    await group(COLUMN_FIXTURES, 'a domain, nullability both ways, a not-valid NOT NULL and column-set differences are each refused with their reason');
    await group(GENERATED_FIXTURES, 'stored and virtual generated, unmapped identity, a generated mapping on a plain column and an absent mapped default are refused');
    await group(KEY_FIXTURES, 'primary key: absent, other, wider, narrower, deferrable, included, manually flagged and non-default collation are refused');
    await group(UNIQUE_FIXTURES, 'mapped unique: absent, not unique, partial, composite, expression, deferrable, nulls-not-distinct and a naturally invalid index are refused');
    await group(RELATION_FIXTURES, 'relation: views, partitions, foreign, unlogged, inheritance with a stale-flag control, RLS, rules and all trigger states are refused');

    // Identity of the relation.
    {
      await refuses(mapping('absent', { id: id() }), 'MISSING');
      await run('CREATE SCHEMA policy_space');
      await run('CREATE TABLE policy_space.policy_elsewhere(id BIGINT PRIMARY KEY)');
      const elsewhere = mapping('elsewhere', { id: id() });
      await refuses(elsewhere, 'MISSING');
      await repaired(elsewhere, { schema: 'policy_space' });
      await run('CREATE TABLE public."Policy_Case"(id BIGINT PRIMARY KEY)');
      await refuses(mapping('case', { id: id() }), 'MISSING', { label: 'lower-case mapping, mixed-case table' });
      await repaired(defineTable('Policy_Case', { id: id() }));
      await run('CREATE TEMP TABLE policy_temp_only(id BIGINT PRIMARY KEY)');
      assert.equal(await value("SELECT relpersistence::text FROM pg_catalog.pg_class WHERE oid = 'pg_temp.policy_temp_only'::regclass"), 't');
      await refuses(mapping('temp_only', { id: id() }), 'MISSING');
      const { session } = open();
      for (const schema of ['pg_temp', 'pg_catalog', 'PG_TOAST', 'information_schema']) await assert.rejects(openPostgresRoots(session, { tables: [mapping('temp_only', { id: id() })], schema }), error => error.code === 'VALIDATION', schema);
      await session.close();
      // A temporary table of the same name is earlier on the search path, and takes no part.
      const shadow = withValue('shadow', column.bigint());
      await run(plainTable('policy_shadow'));
      await run('CREATE TEMP TABLE policy_shadow(id BIGINT PRIMARY KEY, value BIGINT NOT NULL)');
      await run('INSERT INTO pg_temp.policy_shadow VALUES (88, 88)');
      assert.equal(await value('SELECT count(*)::text FROM policy_shadow'), '1', 'the control: unqualified SQL finds the temporary table');
      const opened = await opens(shadow);
      await opened.roots.insert(shadow, { id: 1, value: 1n });
      assert.equal(await opened.roots.count(shadow), 1);
      assert.equal(await opened.roots.byKey(shadow, { id: 88 }), null);
      assert.equal(await value('SELECT count(*)::text FROM public.policy_shadow'), '1');
      assert.equal(await value('SELECT count(*)::text FROM pg_temp.policy_shadow'), '1');
      await opened.session.close();
      cases.push('relation identity: absent, other schema, case-sensitive and temporary-only are MISSING; system schemas are refused; a temporary shadow is not read or written');
    }

    // Settings wrong at open.
    {
      const table = mapping('settings', { id: id() });
      await run('CREATE TABLE public.policy_settings(id BIGINT PRIMARY KEY)');
      for (const [setting, wrong, reason, good] of [['extra_float_digits', '0', 'FLOAT_PRECISION', '1'], ['extra_float_digits', '-15', 'FLOAT_PRECISION', '1'], ['session_replication_role', 'replica', 'REPLICATION_ROLE', 'origin'], ['session_replication_role', 'local', 'REPLICATION_ROLE', 'origin'], ['client_encoding', 'LATIN1', 'ENCODING', 'UTF8']]) {
        await run(`SET ${setting} = '${wrong}'`);
        assert.equal(await value(`SHOW ${setting}`), wrong, setting + ' native control');
        await refuses(table, reason, { code: 'DATA', label: setting + '=' + wrong });
        await run(`SET ${setting} = '${good}'`);
        await repaired(table);
      }
      for (const allowed of ['2', '3']) { await run(`SET extra_float_digits = '${allowed}'`); await repaired(table); }
      await run("SET extra_float_digits = '1'");
      cases.push('settings wrong at open: lossy float digits, a non-origin replication role and a non-UTF8 client are DATA with their reason, and each repair opens; 2 and 3 are allowed');
    }

    // search_path: captured at open, and drift is refused, while compiled SQL stays qualified.
    {
      const table = withValue('path', column.bigint());
      await run(plainTable('policy_path'));
      const original = await value('SHOW search_path');
      const { roots, session } = await opens(table);
      await roots.insert(table, { id: 1, value: 1n });
      const inner = open();
      const watched = await openPostgresRoots(inner.session, { tables: [table] });
      await run("SET search_path = 'pg_temp, policy_space, pg_catalog'");
      const before = inner.sent.length;
      for (const attempt of [() => watched.count(table), () => watched.insert(table, { id: 2, value: 2n }), () => watched.transaction(() => 'never')]) {
        await assert.rejects(attempt(), error => { assert.equal(error.code, 'DATA'); assert.equal(reasonOf(error), 'SEARCH_PATH'); return true; });
      }
      assert.ok(inner.sent.slice(before).every(sql => !sql.startsWith('INSERT')), 'no write after drift');
      const latched = inner.sent.length;
      await run(`SELECT pg_catalog.set_config('search_path', $1, false)`, [original]);
      await assert.rejects(watched.count(table), error => reasonOf(error) === 'SEARCH_PATH', 'restoring it does not unlatch');
      assert.equal(inner.sent.length, latched, 'a latched context sends nothing');
      await inner.session.close();
      assert.equal(await roots.count(table), 1, 'a context whose captured path matches is unaffected');
      await session.close();
      await run("SET search_path = 'pg_temp, policy_space, pg_catalog'");
      const fresh = await opens(table);
      assert.deepEqual(await fresh.roots.byKey(table, { id: 1 }), { id: 1, value: 1n }, 'an open under another path captures it, and compiled SQL stays qualified');
      await fresh.session.close();
      await run(`SELECT pg_catalog.set_config('search_path', $1, false)`, [original]);
      cases.push('search_path drift after open is DATA for reads, writes and transactions, stays latched after restoring, and a fresh context captures the new path');
    }

    // Physical drift after open: the root recheck names the new defect, on a read as well as a write.
    {
      const drifts = [
        ['column', 'ALTER TABLE public.%n ADD COLUMN extra BIGINT', 'COLUMN_SET'],
        ['type', 'ALTER TABLE public.%n ALTER COLUMN value TYPE INTEGER', 'COLUMN_TYPE'],
        ['nullability', 'ALTER TABLE public.%n ALTER COLUMN value DROP NOT NULL', 'COLUMN_NULLABILITY'],
        ['trigger', 'CREATE TRIGGER policy_t BEFORE INSERT ON public.%n FOR EACH ROW EXECUTE FUNCTION public.policy_noop()', 'USER_TRIGGERS'],
        ['rule', 'CREATE RULE policy_r AS ON DELETE TO public.%n DO INSTEAD NOTHING', 'REWRITE_RULES'],
        ['rls', 'ALTER TABLE public.%n ENABLE ROW LEVEL SECURITY', 'ROW_SECURITY'],
        ['inherit', 'CREATE TABLE public.%n_child() INHERITS (public.%n)', 'INHERITANCE'],
        ['key', 'ALTER TABLE public.%n DROP CONSTRAINT %n_pkey', 'PRIMARY_KEY'],
        ['index', 'CREATE INDEX %n_i ON public.%n(value)', 'FINGERPRINT'],
      ];
      for (const [label, ddl, reason] of drifts) for (const operation of ['read', 'write']) {
        const suffix = 'drift_' + label + '_' + operation, name = 'policy_' + suffix, table = withValue(suffix, column.bigint());
        await run(plainTable(name));
        const opened = open(), roots = await openPostgresRoots(opened.session, { tables: [table] });
        await run(ddl.replaceAll('%n', name));
        await assert.rejects(operation === 'read' ? roots.count(table) : roots.insert(table, { id: 1, value: 1n }), error => { assert.equal(error.code, 'SCHEMA', suffix); assert.equal(reasonOf(error), reason, suffix); return true; });
        assert.ok(!opened.sent.some(sql => sql.startsWith('INSERT')), suffix + ' sent no INSERT');
        assert.equal(await value(`SELECT count(*)::text FROM ONLY public.${name}`), '0');
        const sent = opened.sent.length;
        await assert.rejects(roots.count(table), error => error.code === 'SCHEMA', suffix + ' stays latched');
        assert.equal(opened.sent.length, sent, suffix + ' sends nothing more');
        await opened.session.close();
      }
      cases.push('physical drift after open is refused with its reason on the next read or write: no INSERT, the context stays latched and sends nothing more');
    }

    // A dropped table reaches the engine at LOCK, before any catalog read.
    {
      const table = withValue('dropped', column.bigint());
      await run(plainTable('policy_dropped'));
      const opened = open(), roots = await openPostgresRoots(opened.session, { tables: [table] });
      await run('DROP TABLE public.policy_dropped');
      await assert.rejects(roots.count(table), error => { assert.equal(error.code, 'DATABASE_ERROR'); assert.ok(isAcknowledgedRejection(error)); return true; });
      assert.match(opened.sent.findLast(sql => !/^(?:ROLLBACK|SELECT)/.test(sql)), /^LOCK/, 'the LOCK is the statement the engine refused');
      await run(plainTable('policy_dropped'));
      await assert.rejects(roots.count(table), error => error.code === 'SCHEMA', 'a recreated table has another identity');
      await opened.session.close();
      cases.push('a dropped table is a definite engine rejection at LOCK, not SCHEMA and not latched; once recreated, its new identity is SCHEMA');
    }
    return { cases, limitations: [
      'Structural subset on fixed fictional fixtures of one server version (' + name + '): not mapped FK targets, CHECK or default expressions, opclasses, roles, policy contents or function bodies.',
      'Set by direct catalog update, because native DDL does not produce them here: primary-key indisvalid, indisready and indislive, a type modifier, array dimensions on a scalar, and a column and index collation that differ. indimmediate, nulls-not-distinct and the invalid unique index occur naturally.',
      'Refusals show this policy on these fixtures. They do not show that every database in these categories is unsafe, or that a table that opens is safe.',
      'A fixture connection runs as superuser; role and privilege behaviour is not exercised.',
    ] };
  } catch (error) { failed = true; throw error; }
  finally { try { await native.close(); } catch (error) { if (!failed) throw error; } }
}

const BOUND_MS = 15_000;
async function until(check, label) {
  const deadline = Date.now() + BOUND_MS;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('Not observed within its bound: ' + label);
    await new Promise(done => setTimeout(done, 25));
  }
}
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Did not finish within its bound: ' + label)), BOUND_MS); })]).finally(() => clearTimeout(timer));
}

/** Real server only: two and three clients, with waits observed in pg_locks and pg_stat_activity for the exact backend. */
export async function checkPostgresSchemaLocks(connectPg) {
  const cases = [], open = [];
  const client = async () => { const transport = await connectPg(); open.push(transport); return transport; };
  /** Every client of a finished case, keeping the first (the observer). A later case never depends on them. */
  const finishCase = async () => { for (const transport of open.splice(1)) await transport.close(); };
  const pidOf = async transport => Number((await transport.query('SELECT pg_catalog.pg_backend_pid()::text', [])).rows[0][0]);
  const session = (transport, options = {}, executorOptions = {}) => {
    const sent = [], hooks = {};
    const wrapped = { ...transport, async query(sql, parameters) { sent.push(sql); if (sql === 'COMMIT' && hooks.beforeCommit) await hooks.beforeCommit(); return transport.query(sql, parameters); } };
    return { sent, hooks, session: createAsyncSession(createPostgresExecutor(wrapped, executorOptions), { dialect: 'postgresql', isResult: isPostgresRawResult, ...options }) };
  };
  try {
    const admin = await client();
    const run = async (sql, parameters = []) => (await admin.query(sql, parameters)).rows;
    const value = async sql => (await run(sql))[0]?.[0];
    /** The exact backend is waiting for a relation lock, ungranted, and blocked by the expected PID. */
    const blockedBy = (waiter, holder, relation, mode) => until(async () => {
      const rows = await run(`SELECT a.wait_event_type, l.mode, pg_catalog.pg_blocking_pids(a.pid)::text FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_locks l ON l.pid = a.pid AND NOT l.granted AND l.relation = $2::regclass WHERE a.pid = $1::integer`, [waiter, relation]);
      const row = rows[0];
      if (!row || row[0] !== 'Lock') return undefined;
      assert.equal(row[1], mode, 'the waiting lock mode');
      assert.ok(row[2].replace(/[{}]/g, '').split(',').map(Number).includes(holder), 'blocked by the owned backend');
      return row;
    }, 'backend ' + waiter + ' waiting on ' + relation);
    const holds = async (pid, relation, mode) => {
      const rows = await run(`SELECT l.granted::text FROM pg_catalog.pg_locks l WHERE l.pid = $1::integer AND l.relation = $2::regclass AND l.mode = $3`, [pid, relation, mode]);
      assert.deepEqual(rows, [['true']], pid + ' holds ' + mode + ' on ' + relation);
    };
    const pendingOf = (transport, sql) => { const state = { settled: false }; state.promise = transport.query(sql, []).then(() => { state.settled = true; return 'done'; }, error => { state.settled = true; return 'rejected ' + transport.serverError(error)?.sqlstate; }); return state; };
    const table = (name, extra = {}) => defineTable(name, { id: column.integer().primaryKey(), value: column.bigint(), ...extra });
    const create = name => run(`CREATE TABLE public.${name}(id BIGINT PRIMARY KEY, value BIGINT NOT NULL)`);

    // 1. A transaction's prelock holds DDL back until COMMIT; the old context then sees the drift.
    {
      await create('policy_lock_tx');
      const mapped = table('policy_lock_tx'), a = await client(), b = await client(), aPid = await pidOf(a), bPid = await pidOf(b);
      const owner = session(a), roots = await openPostgresRoots(owner.session, { tables: [mapped] });
      let alter;
      await roots.transaction(async tx => {
        await holds(aPid, 'public.policy_lock_tx', 'RowExclusiveLock');
        alter = pendingOf(b, 'ALTER TABLE public.policy_lock_tx ADD COLUMN added_later BIGINT');
        await blockedBy(bPid, aPid, 'public.policy_lock_tx', 'AccessExclusiveLock');
        assert.equal(alter.settled, false);
        await tx.insert(mapped, { id: 1, value: 1n });
        await blockedBy(bPid, aPid, 'public.policy_lock_tx', 'AccessExclusiveLock');
        assert.equal(alter.settled, false, 'still waiting after the write');
      });
      assert.equal(await bounded(alter.promise, 'ALTER after COMMIT'), 'done');
      assert.equal(await value('SELECT count(*)::text FROM ONLY public.policy_lock_tx'), '1');
      assert.equal(await value("SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'policy_lock_tx' AND column_name = 'added_later'"), '1');
      const sent = owner.sent.length;
      await assert.rejects(roots.count(mapped), error => { assert.equal(error.code, 'SCHEMA'); assert.match(error.message, /COLUMN_SET/); return true; });
      assert.ok(owner.sent.slice(sent).every(sql => !sql.startsWith('INSERT') && !sql.includes('__rs_pg_count')), 'neither the read nor a write ran');
      await owner.session.close();
      cases.push('a transaction prelock makes ALTER TABLE wait, observed by exact PID until COMMIT; ALTER then completes and the old context refuses the drift');
      await finishCase();
    }
    // 2. Every registered table is locked, including one the callback never touches.
    {
      await create('policy_lock_a_used'); await create('policy_lock_z_unused');
      const used = table('policy_lock_a_used'), unused = table('policy_lock_z_unused'), a = await client(), b = await client(), aPid = await pidOf(a), bPid = await pidOf(b);
      const owner = session(a), roots = await openPostgresRoots(owner.session, { tables: [used, unused] });
      let alter;
      await roots.transaction(async tx => {
        await holds(aPid, 'public.policy_lock_a_used', 'RowExclusiveLock');
        await holds(aPid, 'public.policy_lock_z_unused', 'RowExclusiveLock');
        alter = pendingOf(b, 'ALTER TABLE public.policy_lock_z_unused ADD COLUMN added_later BIGINT');
        await blockedBy(bPid, aPid, 'public.policy_lock_z_unused', 'AccessExclusiveLock');
        await tx.insert(used, { id: 1, value: 1n });
        assert.equal(alter.settled, false);
      });
      assert.equal(await bounded(alter.promise, 'ALTER of the unused table'), 'done');
      await owner.session.close();
      cases.push('a transaction locks every registered table, including one its callback never touches');
      await finishCase();
    }
    // 3. A single insert holds the lock up to its own COMMIT.
    {
      await create('policy_lock_single');
      const mapped = table('policy_lock_single'), a = await client(), b = await client(), aPid = await pidOf(a), bPid = await pidOf(b);
      const owner = session(a), roots = await openPostgresRoots(owner.session, { tables: [mapped] });
      let alter, observed;
      owner.hooks.beforeCommit = async () => {
        owner.hooks.beforeCommit = undefined;
        try { alter = pendingOf(b, 'ALTER TABLE public.policy_lock_single ADD COLUMN added_later BIGINT'); await blockedBy(bPid, aPid, 'public.policy_lock_single', 'AccessExclusiveLock'); observed = alter.settled === false; }
        catch (error) { observed = error; }
      };
      const start = owner.sent.length;
      assert.deepEqual(await roots.insert(mapped, { id: 1, value: 1n }), { id: 1, value: 1n });
      assert.equal(observed, true);
      assert.equal(await bounded(alter.promise, 'ALTER after a single insert'), 'done');
      const issued = owner.sent.slice(start).map(sql => sql.includes('__rs_pg_catalog') ? 'CATALOG' : sql.includes('__rs_pg_settings') ? 'SETTINGS' : sql.split(' ')[0]);
      assert.deepEqual(issued, ['BEGIN', 'LOCK', 'CATALOG', 'SETTINGS', 'INSERT', 'SETTINGS', 'COMMIT'], 'LOCK first, and nothing after COMMIT');
      await owner.session.close();
      cases.push('a single insert takes its lock before its first catalog read and holds it to COMMIT');
      await finishCase();
    }
    // 4. Whichever comes first: DDL first means the context waits, then sees the committed change, and doesn't write.
    {
      await create('policy_lock_first');
      const mapped = table('policy_lock_first'), a = await client(), d = await client(), aPid = await pidOf(a), dPid = await pidOf(d);
      const owner = session(a), roots = await openPostgresRoots(owner.session, { tables: [mapped] });
      await d.query('BEGIN', []);
      await d.query('ALTER TABLE public.policy_lock_first ADD COLUMN added_first BIGINT', []);
      const attempt = roots.insert(mapped, { id: 1, value: 1n }).then(value => ({ value }), error => ({ error }));
      await blockedBy(aPid, dPid, 'public.policy_lock_first', 'RowExclusiveLock');
      assert.ok(!owner.sent.some(sql => sql.startsWith('INSERT')));
      await d.query('COMMIT', []);
      const { error } = await bounded(attempt, 'insert after the DDL commit');
      assert.equal(error?.code, 'SCHEMA'); assert.match(error.message, /COLUMN_SET/);
      assert.ok(!owner.sent.some(sql => sql.startsWith('INSERT')), 'no INSERT');
      assert.equal(await value('SELECT count(*)::text FROM ONLY public.policy_lock_first'), '0');
      await owner.session.close();
      cases.push('with DDL first, the insert waits at LOCK, then its fresh read sees the committed change and refuses without an INSERT');
      await finishCase();
    }
    // 5. What a prelock does not hold back.
    {
      await create('policy_lock_limits');
      await run('ALTER TABLE public.policy_lock_limits ADD CONSTRAINT policy_lock_check CHECK (value > 0) NOT VALID');
      const mapped = table('policy_lock_limits'), a = await client(), b = await client(), aPid = await pidOf(a), bPid = await pidOf(b);
      const owner = session(a), roots = await openPostgresRoots(owner.session, { tables: [mapped] });
      let trigger, index;
      await run(`CREATE FUNCTION public.policy_lock_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await roots.transaction(async () => {
        assert.equal(await bounded(pendingOf(b, 'ALTER TABLE public.policy_lock_limits VALIDATE CONSTRAINT policy_lock_check').promise, 'VALIDATE during a prelock'), 'done');
        trigger = pendingOf(b, 'CREATE TRIGGER policy_lock_t BEFORE INSERT ON public.policy_lock_limits FOR EACH ROW EXECUTE FUNCTION public.policy_lock_noop()');
        await blockedBy(bPid, aPid, 'public.policy_lock_limits', 'ShareRowExclusiveLock');
      });
      assert.equal(await bounded(trigger.promise, 'CREATE TRIGGER after COMMIT'), 'done');
      await owner.session.close();
      await create('policy_lock_reads');
      const reads = table('policy_lock_reads'), c = await client(), e = await client(), cPid = await pidOf(c), ePid = await pidOf(e);
      const reader = session(c, { readOnly: true }), readRoots = await openPostgresRoots(reader.session, { tables: [reads], readOnly: true });
      await readRoots.transaction(async tx => {
        await holds(cPid, 'public.policy_lock_reads', 'AccessShareLock');
        assert.equal(await tx.count(reads), 0);
        index = await bounded(pendingOf(e, 'CREATE INDEX policy_lock_reads_i ON public.policy_lock_reads(value)').promise, 'CREATE INDEX during a read-only prelock');
        assert.equal(index, 'done');
        const held = pendingOf(e, 'ALTER TABLE public.policy_lock_reads ADD COLUMN added_later BIGINT');
        await blockedBy(ePid, cPid, 'public.policy_lock_reads', 'AccessExclusiveLock');
        assert.equal(held.settled, false);
        trigger = held;
      });
      assert.equal(await bounded(trigger.promise, 'ALTER after a read-only transaction'), 'done');
      await reader.session.close();
      cases.push('limits observed: a write prelock lets VALIDATE CONSTRAINT through and holds CREATE TRIGGER; a read-only prelock holds ALTER but lets CREATE INDEX through');
      await finishCase();
    }
    // 6. A held lock past the request deadline: unknown, one attempt, no INSERT, and the row never appears.
    {
      await create('policy_lock_deadline');
      const mapped = table('policy_lock_deadline'), a = await client(), h = await client(), aPid = await pidOf(a), hPid = await pidOf(h);
      const owner = session(a, {}, { requestTimeoutMs: 3000, closeTimeoutMs: 3000 }), roots = await openPostgresRoots(owner.session, { tables: [mapped] });
      await h.query('BEGIN', []);
      await h.query('LOCK TABLE public.policy_lock_deadline IN ACCESS EXCLUSIVE MODE', []);
      const before = owner.sent.length, started = Date.now();
      const attempt = roots.insert(mapped, { id: 1, value: 1n }).then(value => ({ value }), error => ({ error }));
      await blockedBy(aPid, hPid, 'public.policy_lock_deadline', 'RowExclusiveLock');
      const { error } = await bounded(attempt, 'the request deadline');
      const elapsed = Date.now() - started;
      assert.equal(error?.code, 'EXECUTION_UNCONFIRMED'); assert.ok(!isAcknowledgedRejection(error));
      assert.ok(elapsed >= 2500 && elapsed < 10_000, 'bounded by the deadline: ' + elapsed);
      await assert.rejects(roots.count(mapped), error => error.code === 'CONNECTION_UNUSABLE');
      const issued = owner.sent.slice(before);
      assert.equal(issued.length, 2, 'BEGIN and LOCK only: ' + issued.length);
      assert.match(issued[0], /^BEGIN/); assert.match(issued[1], /^LOCK/);
      await owner.session.close();
      await h.query('ROLLBACK', []);
      await until(async () => (await run('SELECT count(*)::text FROM pg_catalog.pg_stat_activity WHERE pid = $1::integer', [aPid]))[0][0] === '0', 'the abandoned backend ending');
      assert.equal(await value('SELECT count(*)::text FROM ONLY public.policy_lock_deadline'), '0');
      const fresh = session(await client()), again = await openPostgresRoots(fresh.session, { tables: [mapped] });
      assert.deepEqual(await again.insert(mapped, { id: 1, value: 1n }), { id: 1, value: 1n }, 'one later attempt on a new connection succeeds');
      await fresh.session.close();
      cases.push('a lock held past the request deadline is unconfirmed: BEGIN and LOCK only, no INSERT, no replay, an unusable session, and no row after the holder releases');
      await finishCase();
    }
    return { cases, limitations: [
      'One server version, dedicated superuser clients, loopback. Waits are observed in pg_locks and pg_stat_activity for exact PIDs on these fixtures, not a general concurrency proof.',
      'The prelock covers only DDL whose lock conflicts with its mode. SHARE UPDATE EXCLUSIVE DDL passes a write prelock, and a read-only prelock also lets SHARE-level DDL through. Those changes are noticed only by a later root recheck, if at all.',
      'The deadline case is a JavaScript request deadline with a held lock, not network failure, and a server-side LOCK wait is not cancelled by it until the socket is closed. No lock_timeout is set.',
      'Clients other than these fixtures may hold or queue for locks in other orders. Deadlock between multiple prelocks and application DDL was not exercised.',
    ] };
  } finally {
    for (const transport of open) { try { await transport.close(); } catch { try { transport.forceClose?.(); } catch {} } }
  }
}
