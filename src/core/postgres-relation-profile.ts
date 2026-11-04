/** Internal native eager-window result contract. No caller OIDs, SQL or connection ownership. */
import type { PostgresOutputField } from './postgres-result.js';
import { MAX_RELATION_KEYS } from './query-model.js';

export interface PostgresRelationProfile {
  readonly outputs: readonly PostgresOutputField[];
  readonly partitionBy: string;
  readonly keys: readonly (bigint | string)[];
  readonly correlateKeys: boolean;
  readonly offset: number;
  readonly limit: number;
  readonly readLimit: number;
}

/** Per response, not a whole-graph bound or prevention of an already received driver-buffer allocation. */
export const POSTGRES_RELATION_LIMITS = Object.freeze({
  outputs: 100, keys: MAX_RELATION_KEYS, offset: 1_000_000_000, limit: 1000, readLimit: 10_001,
  keyBytes: 16_777_216, bytes: 16_777_216,
});
