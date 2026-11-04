/** Internal query/result seam. Dialects never own a connection or receive caller SQL. */
import type { Parameter } from './schema.js';
import type { QueryModel, RelationModel } from './query-model.js';
import type { GraphResources } from './graph-resources.js';

export interface DialectQuery {
  readonly sql: string;
  readonly parameters: readonly Parameter[];
  /** Validate native metadata, then return the shared codec's storage representation, not logical values. */
  readonly decode?: (result: unknown) => Record<string, unknown>[];
  /** Narrow classification of an already processed engine error, without changing connection/session state. */
  readonly mapError?: (error: unknown) => unknown;
}
export interface RepositoryDialect {
  readonly name: 'sqlite' | 'postgresql';
  /** False refuses an include during planning, before the root SELECT can run. */
  readonly supportsIncludes?: boolean;
  /** Validate known native child values during whole-tree planning; dummy keys never execute. */
  readonly preflightRelation?: (model: RelationModel) => void;
  /** A new accounting scope for one native graph Work; absent for ordinary SQLite reads. */
  readonly createGraphResources?: () => GraphResources;
  /** Compiler-decoded related response provenance, never raw data or acknowledgment. */
  readonly relatedWireBytes?: (rows: unknown) => number;
  compile(model: QueryModel): DialectQuery;
}
