/** Internal bridge from structured PostgreSQL plans to the shared repository's storage rows. */
import { fail } from './errors.js';
import { assertOptions } from './predicates.js';
import { identifier } from './schema.js';
import type { RepositoryDialect } from './dialect.js';
import type { QueryModel } from './query-model.js';
import { compilePostgres, type PostgresCompileOptions } from './postgres-compiler.js';
import { decodePostgresStorage } from './postgres-storage.js';
import { decodePostgresAggregateStorage } from './postgres-aggregate-storage.js';
import { postgresRealAggregateError } from './postgres-acknowledgment.js';

export function createPostgresDialect(options: PostgresCompileOptions = {}): RepositoryDialect {
  assertOptions(options, ['schema', 'only']);
  const schema = options.schema ?? 'public', only = options.only ?? false;
  identifier(schema);
  if (typeof only !== 'boolean') fail('VALIDATION', 'The PostgreSQL table-scope option must be boolean.');
  const captured = Object.freeze({ schema, only });
  return Object.freeze({
    name: 'postgresql' as const,
    supportsIncludes: false,
    compile(model: QueryModel) {
      const query = compilePostgres(model, captured);
      if (query.command === null) fail('QUERY', 'A repository statement must have a typed row result.');
      const command = query.command;
      return {
        sql: query.sql, parameters: query.parameters,
        ...(query.realAggregateRange ? { mapError: postgresRealAggregateError } : {}),
        decode: (result: unknown) => query.aggregate ? decodePostgresAggregateStorage(result, query.aggregate)
          : decodePostgresStorage(result, query.outputs, command, query.count ? { count: true } : {}),
      };
    },
  });
}
