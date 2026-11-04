/** Internal query/result seam. Dialects never own a connection or receive caller SQL. */
import type { Parameter } from './schema.js';
import type { QueryModel } from './query-model.js';

export interface DialectQuery {
  readonly sql: string;
  readonly parameters: readonly Parameter[];
  /** Validate native metadata, then return the shared codec's storage representation, not logical values. */
  readonly decode?: (result: unknown) => Record<string, unknown>[];
}
export interface RepositoryDialect {
  readonly name: 'sqlite' | 'postgresql';
  /** False refuses an include during planning, before the root SELECT can run. */
  readonly supportsIncludes?: boolean;
  compile(model: QueryModel): DialectQuery;
}
