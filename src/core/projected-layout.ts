/** Generated output names for per-row projected aggregates, shared by the SQL compiler and the decoder. No IO. */
import { projectedIntegerSum, type ProjectedAggregateModel } from './query-model.js';

export type ProjectedOutput =
  | { readonly kind: 'scalar'; readonly aggregate: ProjectedAggregateModel; readonly name: string }
  | { readonly kind: 'integer-sum'; readonly aggregate: ProjectedAggregateModel; readonly high: string; readonly low: string };
export interface ProjectedLayout { readonly outputs: readonly ProjectedOutput[]; readonly guard: string }

/** Accepts normalized models. Names are compiler-owned (reserved __rs_ prefix); user aliases never enter SQL. */
export function projectedLayout(aggregates: readonly ProjectedAggregateModel[]): ProjectedLayout {
  const outputs = aggregates.map((aggregate, index): ProjectedOutput => projectedIntegerSum(aggregate)
    ? Object.freeze({ kind: 'integer-sum', aggregate, high: '__rs_ragg_hi_' + index, low: '__rs_ragg_lo_' + index })
    : Object.freeze({ kind: 'scalar', aggregate, name: '__rs_ragg_' + index }));
  return Object.freeze({ outputs: Object.freeze(outputs), guard: '__rs_ragg_bad' });
}
