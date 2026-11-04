import { decodePostgresRelationStorage } from '../../src/core/postgres-relation-storage.js';
import type { PostgresRelationProfile } from '../../src/core/postgres-relation-profile.js';
// @ts-expect-error The internal decoder is not a public SDK export.
import { decodePostgresRelationStorage as publicDecoder } from '../../src/index.js';

declare const raw: unknown;
const profile: PostgresRelationProfile = {outputs:[{alias:'__rs_pg_0',property:'id',kind:'bigint',nullable:false}],partitionBy:'id',keys:[1n],correlateKeys:false,offset:0,limit:2,readLimit:3};
const rows: Record<string,unknown>[] = decodePostgresRelationStorage(raw,profile);
const text: PostgresRelationProfile = {...profile,outputs:[{alias:'__rs_pg_0',property:'key',kind:'text',nullable:false}],partitionBy:'key',keys:['a'],correlateKeys:true};
decodePostgresRelationStorage(raw,text);
// @ts-expect-error A relation decoder requires its compiled profile, never SQL text.
decodePostgresRelationStorage(raw,'SELECT private');
// @ts-expect-error Partition identity is required.
decodePostgresRelationStorage(raw,{outputs:profile.outputs,keys:[1n],correlateKeys:false,offset:0,limit:2,readLimit:3});
// @ts-expect-error The profile never accepts arbitrary physical OIDs.
decodePostgresRelationStorage(raw,{...profile,typeOids:[20,20]});
// @ts-expect-error Source keys are canonical bigint or native text, not numbers.
const numbers: PostgresRelationProfile = {...profile,keys:[1]};
// @ts-expect-error Source keys cannot be NULL.
const nullKey: PostgresRelationProfile = {...profile,keys:[null]};
// @ts-expect-error Arbitrary key coercion callbacks are not accepted.
const objectKey: PostgresRelationProfile = {...profile,keys:[{toString(){return '1';}}]};
// @ts-expect-error Correlation policy must be explicit boolean.
const flag: PostgresRelationProfile = {...profile,correlateKeys:'yes'};
// @ts-expect-error Page limits must be numbers.
const limit: PostgresRelationProfile = {...profile,limit:'2'};
// @ts-expect-error Read limit cannot be omitted.
const missing: PostgresRelationProfile = {outputs:profile.outputs,partitionBy:'id',keys:[1n],correlateKeys:false,offset:0,limit:2};
// @ts-expect-error Scalar kind is closed, not an arbitrary PostgreSQL type.
const numeric: PostgresRelationProfile = {...profile,outputs:[{alias:'__rs_pg_0',property:'id',kind:'numeric',nullable:false}]};
// @ts-expect-error Mapped nullability is boolean.
const nullable: PostgresRelationProfile = {...profile,outputs:[{alias:'__rs_pg_0',property:'id',kind:'bigint',nullable:1}]};
// @ts-expect-error Outputs do not allow arbitrary OID declarations.
const oid: PostgresRelationProfile = {...profile,outputs:[{alias:'__rs_pg_0',property:'id',kind:'bigint',nullable:false,typeOid:20}]};
// @ts-expect-error Captured profile properties are readonly.
profile.partitionBy='other';
// @ts-expect-error Captured keys are readonly.
profile.keys[0]=2n;
// @ts-expect-error Captured outputs are readonly.
profile.outputs.push(profile.outputs[0]!);
// @ts-expect-error Canonical storage is unknown until the shared logical codec decodes it.
const logicalId: number = rows[0]!.id;
// @ts-expect-error Parent ordinals are not promised as already decoded public numbers.
const ordinal: number = rows[0]!.__rs_parent;
void [publicDecoder,numbers,nullKey,objectKey,flag,limit,missing,numeric,nullable,oid,logicalId,ordinal];
