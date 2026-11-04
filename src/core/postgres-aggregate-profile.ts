/** Internal native aggregate result contract. Compiler-owned slots, never caller SQL or arbitrary OID declarations. */
import type { Kind } from './schema.js';
import { POSTGRES_MAX_RESULT_CELLS } from './postgres-result.js';

interface PhysicalSlot { readonly alias: string }
export type PostgresAggregateField =
  | (PhysicalSlot & { readonly kind: 'count'; readonly target: string })
  | (PhysicalSlot & { readonly kind: 'integer-sum'; readonly high: string; readonly low: string })
  | (PhysicalSlot & { readonly kind: 'real-aggregate'; readonly target: string })
  | (PhysicalSlot & { readonly kind: 'mapped'; readonly target: string; readonly storageKind: Kind;
      readonly nullable: boolean; readonly canonical: boolean })
  | (PhysicalSlot & { readonly kind: 'guard'; readonly target: string });

/**
 * Every physical alias is __rs_pg_<index> in field order. One integer NUMERIC sum expands to the existing shared
 * high/low storage pair; it is not a mapped int64. A profile has exactly one generated guard, __rs_bad for root/group
 * or __rs_ragg_bad for projected summaries. Targets are distinct validated identifiers, and no target is SQL text.
 *
 * count: exact OID20, nonnegative safe integer. integer-sum: exact OID1700, NULL or mathematically integral NUMERIC.
 * real-aggregate: exact OID701, nullable; nonfinite range results are AGGREGATE_RANGE, NaN/malformed data is DATA.
 * guard: exact OID23 with nonnullable 0/1. Guard1 refuses DATA before decoding other cells in that result row.
 *
 * mapped canonical=true requires OID20(integer/bigint),701(real),25(text),16(boolean),114(json). With canonical=false
 * the ordinary M14 scalar families apply instead, preserving physical int2/int4/int8, float4/float8, text/varchar and
 * json/jsonb handling. Canonical storage still uses bigint integers, 0n/1n booleans and validated JSON wire text.
 */
export interface PostgresAggregateProfile {
  readonly mode: 'aggregate' | 'group' | 'projected';
  readonly fields: readonly PostgresAggregateField[];
}

/** Native limits, not a claim that JavaScript numbers represent arbitrary decimal values exactly. */
export const POSTGRES_AGGREGATE_LIMITS = Object.freeze({
  fields: 512, rows: 100_000, cells: POSTGRES_MAX_RESULT_CELLS, bytes: 16_777_216,
  // PostgreSQL18 unconstrained NUMERIC limits: https://www.postgresql.org/docs/18/datatype-numeric.html
  integerDigits: 131_072, fractionDigits: 16_383,
});
