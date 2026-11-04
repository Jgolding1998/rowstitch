/** Same-row native type/codec checks over an already materialized raw value. No IO or public SQL extension. */
import type { Kind } from './schema.js';

const cast = (type: string): string => '::"pg_catalog"."' + type + '"';
const compare = (left: string, operator: '=' | '>=' | '<=', right: string): string => '(' + left + ' OPERATOR("pg_catalog".' + operator + ') ' + right + ')';
const OIDS: Readonly<Record<Kind, string>> = Object.freeze({
  integer: '20,21,23', bigint: '20,21,23', real: '700,701', text: '25,1043', boolean: '16', json: '114,3802',
});
export const POSTGRES_CANONICAL_TYPE: Readonly<Record<Kind, string>> = Object.freeze({
  integer: 'int8', bigint: 'int8', real: 'float8', text: 'text', boolean: 'bool', json: 'json',
});
export interface PostgresAggregateInput { readonly value: string; readonly invalid: string; readonly familyInvalid: string }

export function postgresAggregateInput(ref: string, kind: Kind, nullable: boolean): PostgresAggregateInput {
  const type = '"pg_catalog"."pg_typeof"(' + ref + ')' + cast('oid');
  const family = '(' + OIDS[kind].split(',').map(oid => compare(type, '=', oid + cast('oid'))).join(' OR ') + ')';
  const text = '(' + ref + ')' + cast('text');
  const parsed = kind === 'real'
    ? '(CASE WHEN ' + compare(type, '=', '700' + cast('oid')) + ' THEN (' + text + cast('float4') + ')' + cast('float8')
      + ' ELSE ' + text + cast('float8') + ' END)'
    : text + cast(POSTGRES_CANONICAL_TYPE[kind]);
  // The family test must precede even text conversion; a wrong native family is not a permissive cast opportunity.
  const value = '(CASE WHEN ' + family + ' THEN ' + parsed + ' ELSE NULL' + cast(POSTGRES_CANONICAL_TYPE[kind]) + ' END)';
  let logical = 'TRUE';
  if (kind === 'integer') logical = '(' + compare(value, '>=', "'-9007199254740991'" + cast('int8'))
    + ' AND ' + compare(value, '<=', '9007199254740991' + cast('int8')) + ')';
  if (kind === 'real') logical = '(' + compare(value, '>=', "'-1.7976931348623157e308'" + cast('float8'))
    + ' AND ' + compare(value, '<=', "'1.7976931348623157e308'" + cast('float8')) + ')';
  const invalid = '(CASE WHEN NOT ' + family + ' THEN 1 WHEN ' + ref + ' IS NULL THEN ' + (nullable ? '0' : '1')
    + ' WHEN ' + logical + ' THEN 0 ELSE 1 END)';
  // Keep the physical canonical value for joins, even when a logical-width guard rejects it. Sanitizing a join key to
  // NULL here would hide a bad matching path. Aggregate arguments are globally gated only after all domains exist.
  return { value, invalid, familyInvalid: '(CASE WHEN ' + family + ' THEN 0 ELSE 1 END)' };
}
