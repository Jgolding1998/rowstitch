/** Closed native lowering of the shared loader's captured batched relation windows. */
import { fail } from './errors.js';
import { identifier, type Kind, type Parameter } from './schema.js';
import type { OrderModel, PredicateModel, RelationModel, TableModel } from './query-model.js';
import type { PostgresOutputField } from './postgres-result.js';
import { POSTGRES_RELATION_LIMITS, type PostgresRelationProfile } from './postgres-relation-profile.js';

interface RelationContext {
  source(table: TableModel): string;
  kind(table: TableModel, column: string): Kind;
  predicate(table: TableModel, scope: string, model?: PredicateModel): string;
  order(table: TableModel, scope: string, entries: readonly OrderModel[]): string;
  bindKey(value: string, kind: 'int8' | 'text'): string;
  textKey(value: Parameter): string;
  bindInteger(value: number): string;
}

const ROOT = '"__rs_pg_root"', KEYS = '"__rs_pg_keys"', WINDOW = '"__rs_pg_window"';
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
const physical = (index: number): string => '"__rs_pg_' + index + '"';
const operator = (value: '=' | '>' | '<='): string => ' OPERATOR("pg_catalog".' + value + ') ';
const keyError = (): never => fail('VALIDATION', 'A native relationship key is outside its supported scalar contract.');

export function compilePostgresRelation(query: RelationModel, ctx: RelationContext): { sql: string; profile: PostgresRelationProfile } {
  const keyKind = ctx.kind(query.table, query.partitionBy), correlated = query.correlateKeys === true;
  if (correlated ? keyKind !== 'text' : keyKind !== 'integer' && keyKind !== 'bigint')
    fail('QUERY', 'Native eager relationships require numeric keys or correlated text keys.');
  let bytes = 0;
  const keys = query.keys.map(value => {
    let key: bigint | string;
    if (correlated) {
      // Text source and target codecs have the same encoded image; the shared native binder checks UTF-8 text rules.
      const text = ctx.textKey(value);
      if (typeof text !== 'string') return keyError();
      key = text;
    } else {
      // Source encoding may be number for integer or bigint for bigint, independently of the target key's kind.
      if (typeof value === 'number' && Number.isSafeInteger(value)) key = BigInt(value);
      else if (typeof value === 'bigint' && value >= INT64_MIN && value <= INT64_MAX) key = value;
      else return keyError();
    }
    const wire = String(key);
    bytes += Buffer.byteLength(wire, 'utf8');
    if (bytes > POSTGRES_RELATION_LIMITS.keyBytes) fail('RESULT_LIMIT', 'Native relationship keys exceeded their UTF-8 request budget. Narrow the root query.');
    return { key, wire };
  });
  const outputs: readonly PostgresOutputField[] = Object.freeze(query.columns.map((column, index) => Object.freeze({
    alias: '__rs_pg_' + index, property: column, kind: ctx.kind(query.table, column), nullable: query.table.nullable![column]!,
  })));
  const rank = physical(outputs.length), parent = physical(outputs.length + 1);
  const partition = ROOT + '.' + identifier(query.partitionBy);
  const projection = query.columns.map((column, index) => ROOT + '.' + identifier(column) + ' AS ' + physical(index));
  let prefix = '', from = ctx.source(query.table) + ' AS ' + ROOT, keyFilter = '';
  if (correlated) {
    // Ordinals are bounded generated nonnegative int8 constants, not another caller-parameter allowance.
    prefix = 'WITH ' + KEYS + '("__rs_key", "__rs_ordinal") AS (VALUES '
      + keys.map((key, index) => '(' + ctx.bindKey(key.wire, 'text') + ', \'' + index + '\'::"pg_catalog"."int8")').join(', ') + ') ';
    from += ' JOIN ' + KEYS + ' ON ' + partition + operator('=') + KEYS + '."__rs_key"';
  } else {
    keyFilter = partition + operator('=') + 'ANY (ARRAY[' + keys.map(key => ctx.bindKey(key.wire, 'int8')).join(', ') + ']::"pg_catalog"."int8"[])';
  }
  const where = ctx.predicate(query.table, ROOT, query.where);
  const filter = [keyFilter, where ? '(' + where + ')' : ''].filter(Boolean).join(' AND ');
  const group = correlated ? KEYS + '."__rs_ordinal"' : partition;
  projection.push('"pg_catalog"."row_number"() OVER (PARTITION BY ' + group + ctx.order(query.table, ROOT, query.orderBy) + ') AS ' + rank);
  if (correlated) projection.push(KEYS + '."__rs_ordinal" AS ' + parent);
  const inner = 'SELECT ' + projection.join(', ') + ' FROM ' + from + (filter ? ' WHERE ' + filter : '');
  const slots = [...outputs.map((_, index) => physical(index)), rank, ...(correlated ? [parent] : [])];
  const lower = ctx.bindInteger(query.offset), upper = ctx.bindInteger(query.offset + query.limit), readLimit = ctx.bindInteger(query.readLimit);
  const outerGroup = correlated ? parent : physical(query.columns.indexOf(query.partitionBy));
  const sql = prefix + 'SELECT ' + slots.map(slot => WINDOW + '.' + slot).join(', ') + ' FROM (' + inner + ') AS ' + WINDOW
    + ' WHERE ' + WINDOW + '.' + rank + operator('>') + lower + ' AND ' + WINDOW + '.' + rank + operator('<=') + upper
    + ' ORDER BY ' + WINDOW + '.' + outerGroup + ' ASC, ' + WINDOW + '.' + rank + ' ASC LIMIT ' + readLimit;
  const profile: PostgresRelationProfile = Object.freeze({ outputs, partitionBy: query.partitionBy,
    keys: Object.freeze(keys.map(key => key.key)), correlateKeys: correlated, offset: query.offset, limit: query.limit, readLimit: query.readLimit });
  return { sql, profile };
}
