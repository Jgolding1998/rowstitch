import { snapshotPostgresPhysical, snapshotPostgresSettings, type PostgresPhysicalReason, type PostgresSettingsReason } from '../../src/core/postgres-physical.js';
declare const input: unknown;
const physical = snapshotPostgresPhysical(input);
const settings = snapshotPostgresSettings(input);
// @ts-expect-error Captured physical metadata is immutable.
physical.oid = 1;
// @ts-expect-error Column records are immutable.
physical.columns[0]!.typeOid = 25;
// @ts-expect-error Captured arrays cannot be extended.
physical.indexes.push(physical.indexes[0]!);
// @ts-expect-error Key arrays are readonly too.
physical.indexes[0]!.keyColumns[0] = 'changed';
// @ts-expect-error Session settings are immutable.
settings.extraFloatDigits = 0;
// @ts-expect-error Physical reasons are a closed set.
const badReason: PostgresPhysicalReason = 'SYNTHETIC_PRIVATE_VALUE';
// @ts-expect-error Setting reasons do not include unrelated physical mismatches.
const badSettings: PostgresSettingsReason = 'PRIMARY_KEY';
void [badReason,badSettings];
