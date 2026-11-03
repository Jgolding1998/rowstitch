/** Internal PostgreSQL transaction control only. This is not a general query dialect. */
import { fail } from './errors.js';
import { normalizeQueryModel, type TransactionModel } from './query-model.js';
import { identifier } from './schema.js';

export function compilePostgresControl(input: TransactionModel): string {
  const query = normalizeQueryModel(input);
  if (query.kind !== 'transaction') return fail('QUERY', 'Expected a transaction control model.');
  switch (query.action) {
    case 'begin': return 'BEGIN READ ONLY';
    // The SQLite action denotes write intent. Serializable isolation is required before guarded multi-statement writes.
    // A serialization failure is returned to the caller; no transaction callback is replayed.
    case 'begin-immediate': return 'BEGIN ISOLATION LEVEL SERIALIZABLE';
    case 'commit': return 'COMMIT';
    case 'rollback': return 'ROLLBACK';
    case 'savepoint': return 'SAVEPOINT ' + identifier(query.name!);
    case 'release': return 'RELEASE SAVEPOINT ' + identifier(query.name!);
    case 'rollback-to': return 'ROLLBACK TO SAVEPOINT ' + identifier(query.name!);
  }
}
