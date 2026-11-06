/** Internal bridge from structured PostgreSQL plans to the shared repository's storage rows. */
import { fail } from './errors.js';
import { assertOptions } from './predicates.js';
import { physicalTableIdentity } from './physical-identity.js';
import type { RepositoryDialect } from './dialect.js';
import type { QueryModel, RelationModel } from './query-model.js';
import { compilePostgres, type PostgresCompileOptions } from './postgres-compiler.js';
import { decodePostgresStorage } from './postgres-storage.js';
import { decodePostgresAggregateStorage } from './postgres-aggregate-storage.js';
import { decodePostgresRelationStorage, postgresRelationWireBytes } from './postgres-relation-storage.js';
import { createNativeGraphResources } from './graph-resources.js';
import { postgresRealAggregateError } from './postgres-acknowledgment.js';

export function createPostgresDialect(options: PostgresCompileOptions = {}): RepositoryDialect {
  assertOptions(options, ['schema', 'only']);
  const schema = options.schema ?? 'public', only = options.only ?? false;
  physicalTableIdentity(schema, '_', 'postgresql');
  if (/^(?:pg_|information_schema$)/i.test(schema)) fail('SCHEMA', 'Choose a supported PostgreSQL user namespace.');
  if (typeof only !== 'boolean') fail('VALIDATION', 'The PostgreSQL table-scope option must be boolean.');
  const captured = Object.freeze({ schema, only });
  return Object.freeze({
    name: 'postgresql' as const,
    defaultSchema: schema,
    supportsIncludes: true,
    preflightRelation(model: RelationModel) { compilePostgres(model, captured); },
    createGraphResources: createNativeGraphResources,
    relatedWireBytes: postgresRelationWireBytes,
    compile(model: QueryModel) {
      const query = compilePostgres(model, captured);
      if (query.command === null) fail('QUERY', 'A repository statement must have a typed row result.');
      const command = query.command;
      return {
        sql: query.sql, parameters: query.parameters,
        ...(query.realAggregateRange ? { mapError: postgresRealAggregateError } : {}),
        decode: (result: unknown) => query.aggregate ? decodePostgresAggregateStorage(result, query.aggregate)
          : query.relation ? decodePostgresRelationStorage(result, query.relation)
            : decodePostgresStorage(result, query.outputs, command, query.count ? { count: true } : {}),
      };
    },
  });
}
