import { decodePostgresAggregateStorage } from '../../src/core/postgres-aggregate-storage.js';
import type { PostgresAggregateField, PostgresAggregateProfile } from '../../src/core/postgres-aggregate-profile.js';
declare const raw: unknown;
const fields: readonly PostgresAggregateField[] = [
  {kind:'count',alias:'__rs_pg_0',target:'__rs_agg_0'},
  {kind:'integer-sum',alias:'__rs_pg_1',high:'__rs_sum_hi_1',low:'__rs_sum_lo_1'},
  {kind:'real-aggregate',alias:'__rs_pg_2',target:'__rs_agg_2'},
  {kind:'mapped',alias:'__rs_pg_3',target:'__rs_key_0',storageKind:'text',nullable:true,canonical:true},
  {kind:'guard',alias:'__rs_pg_4',target:'__rs_bad'},
];
const profile: PostgresAggregateProfile = {mode:'aggregate',fields};
const rows: Record<string,unknown>[] = decodePostgresAggregateStorage(raw,profile);
void rows;
// @ts-expect-error An aggregate decoder needs a compiled profile, not SQL text.
decodePostgresAggregateStorage(raw,'SELECT sum(hidden)');
// @ts-expect-error Row mode is a closed union.
decodePostgresAggregateStorage(raw,{mode:'select',fields});
// @ts-expect-error The caller cannot declare arbitrary OIDs.
const arbitrary: PostgresAggregateField = {kind:'count',alias:'__rs_pg_0',target:'n',typeOid:1700};
// @ts-expect-error Exact sum has a high/low pair, not one target.
const single: PostgresAggregateField = {kind:'integer-sum',alias:'__rs_pg_0',target:'total'};
// @ts-expect-error Both sum targets are required.
const missing: PostgresAggregateField = {kind:'integer-sum',alias:'__rs_pg_0',high:'high'};
// @ts-expect-error Mapped slots require explicit canonical policy.
const noPolicy: PostgresAggregateField = {kind:'mapped',alias:'__rs_pg_0',target:'id',storageKind:'integer',nullable:false};
// @ts-expect-error NUMERIC is not an ordinary mapped storage kind.
const numeric: PostgresAggregateField = {kind:'mapped',alias:'__rs_pg_0',target:'id',storageKind:'numeric',nullable:false,canonical:false};
// @ts-expect-error Only boolean nullability is permitted.
const nullable: PostgresAggregateField = {kind:'mapped',alias:'__rs_pg_0',target:'id',storageKind:'integer',nullable:1,canonical:false};
// @ts-expect-error A guard cannot override its nullability.
const guard: PostgresAggregateField = {kind:'guard',alias:'__rs_pg_0',target:'__rs_bad',nullable:true};
// @ts-expect-error Unknown aggregate operations need another reviewed profile.
const unknown: PostgresAggregateField = {kind:'decimal',alias:'__rs_pg_0',target:'n'};
// @ts-expect-error Canonical storage is not already a public number.
const count: number = rows[0]!.n;
void [arbitrary,single,missing,noPolicy,numeric,nullable,guard,unknown,count];
