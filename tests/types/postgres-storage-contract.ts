import { decodePostgresStorage } from '../../src/core/postgres-storage.js';
import type { PostgresOutputField } from '../../src/core/postgres-result.js';

declare const raw: unknown;
const fields: readonly PostgresOutputField[] = [{ alias: '__rs_pg_0', property: 'id', kind: 'integer', nullable: false }];
const rows: Record<string, unknown>[] = decodePostgresStorage(raw, fields, 'SELECT');
const counted: Record<string, unknown>[] = decodePostgresStorage(raw, [{alias: '__rs_pg_count', property: 'n', kind: 'bigint', nullable: false}], 'SELECT', {count: true});
void [rows, counted];

// @ts-expect-error Only the four compiled CRUD commands are accepted.
decodePostgresStorage(raw, fields, 'SHOW');
// @ts-expect-error A SQL string is not a command tag contract.
decodePostgresStorage(raw, fields, 'SELECT * FROM hidden');
// @ts-expect-error Count is a boolean option, never a desired row count.
decodePostgresStorage(raw, fields, 'SELECT', {count: 1});
// @ts-expect-error Unknown decoder options cannot override OID validation.
decodePostgresStorage(raw, fields, 'SELECT', {allowAnyOid: true});
// @ts-expect-error All four positional output metadata fields are required.
decodePostgresStorage(raw, [{alias: '__rs_pg_0', property: 'id', kind: 'integer'}], 'SELECT');
// @ts-expect-error Unknown scalar mappings need a separate explicit type contract.
decodePostgresStorage(raw, [{alias: '__rs_pg_0', property: 'id', kind: 'numeric', nullable: false}], 'SELECT');
// @ts-expect-error Canonical storage cells are not assumed to be application numbers.
const id: number = rows[0]!.id;
void id;
