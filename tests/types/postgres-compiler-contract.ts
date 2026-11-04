import { bindPostgresEncoded, compilePostgres, type CompiledPostgresQuery, type PostgresCompileOptions } from '../../src/core/postgres-compiler.js';
import { queryModel, tableModel } from '../../src/core/query-model.js';

const table = tableModel({ name: 'sample_rows', columns: ['id'], primaryKey: ['id'], kinds: { id: 'integer' }, nullable: { id: false } });
const model = queryModel.select({ table, columns: ['id'], orderBy: [], limit: 1, offset: 0 });
const options: PostgresCompileOptions = { schema: 'sandbox', only: true };
const compiled: CompiledPostgresQuery = compilePostgres(model, options);
const values: readonly (string | null)[] = compiled.parameters;
const kind: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | null = compiled.command;
const count: true | undefined = compiled.count;
void values; void kind; void count;

// @ts-expect-error PostgreSQL wire parameters are immutable.
compiled.parameters.push('x');
// @ts-expect-error PostgreSQL output metadata is immutable.
compiled.outputs.push({ alias: '__rs_pg_0', property: 'id', kind: 'integer', nullable: false });
// @ts-expect-error A result field descriptor cannot be rewritten.
compiled.outputs[0].kind = 'json';
// @ts-expect-error Schemas are validated identifier strings, not numbers.
compilePostgres(model, { schema: 1 });
// @ts-expect-error ONLY is an explicit boolean.
compilePostgres(model, { only: 'yes' });
// @ts-expect-error Compile options cannot accept caller SQL.
compilePostgres(model, { sql: 'SELECT 1' });
// @ts-expect-error Compiled wire values contain text or SQL NULL, not logical booleans.
const logical: CompiledPostgresQuery = { sql: '', parameters: [true], outputs: [], command: 'SELECT' };
// @ts-expect-error Only a genuine count plan can enable its count contract.
const falseCount: CompiledPostgresQuery = { sql: '', parameters: [], outputs: [], command: 'SELECT', count: false };
// @ts-expect-error An arbitrary engine command is not a compiled root result contract.
const arbitrary: CompiledPostgresQuery = { sql: '', parameters: [], outputs: [], command: 'DROP' };
void logical; void falseCount; void arbitrary;

const wire: string | null = bindPostgresEncoded('json', '{"sample":1}', false);
void wire;
// @ts-expect-error The encoded-constant helper requires a mapped kind.
bindPostgresEncoded('uuid', 'sample', false);
// @ts-expect-error Boolean logical values are not encoded Parameter values.
bindPostgresEncoded('boolean', true, false);
// @ts-expect-error Nullability is explicit, not a truthy string.
bindPostgresEncoded('text', 'sample', 'yes');
