/** Shared generated-output layout for aggregate SQL and decoding. No driver or IO. */
import type { AggregateModel, AggregateSelectModel, GroupModel } from './query-model.js';

export interface AggregateOutput { readonly name: string; readonly ordinal: number }
export interface AggregateKeyLayout { readonly column: string; readonly output: AggregateOutput }
export type AggregateValueLayout =
  | { readonly kind: 'scalar'; readonly selection: AggregateSelectModel; readonly output: AggregateOutput }
  | { readonly kind: 'integer-sum'; readonly selection: AggregateSelectModel; readonly high: AggregateOutput; readonly low: AggregateOutput };
export interface AggregateLayout {
  readonly keys: readonly AggregateKeyLayout[];
  readonly aggregates: readonly AggregateValueLayout[];
  readonly guard: AggregateOutput;
  readonly outputs: readonly AggregateOutput[];
  readonly inputColumns: readonly string[];
}

/** Accepts a normalized model. Names are compiler-owned; user aliases never enter SQL. */
export function aggregateLayout(query: AggregateModel | GroupModel): AggregateLayout {
  const outputs: AggregateOutput[] = [], inputs = new Set<string>();
  const output = (name: string): AggregateOutput => {
    const item = Object.freeze({ name, ordinal: outputs.length + 1 });
    outputs.push(item);
    return item;
  };
  const keys = (query.kind === 'group' ? query.by : []).map((column, index) => {
    inputs.add(column);
    return Object.freeze({ column, output: output('__rs_key_' + index) });
  });
  const aggregates: AggregateValueLayout[] = query.select.map((selection, index) => {
    if (selection.column !== undefined) inputs.add(selection.column);
    const kind = selection.column === undefined ? undefined : query.table.kinds?.[selection.column];
    if (selection.operation === 'sum' && (kind === 'integer' || kind === 'bigint')) return Object.freeze({
      kind: 'integer-sum' as const, selection,
      high: output('__rs_sum_hi_' + index), low: output('__rs_sum_lo_' + index),
    });
    return Object.freeze({ kind: 'scalar' as const, selection, output: output('__rs_agg_' + index) });
  });
  const guard = output('__rs_bad');
  return Object.freeze({ keys: Object.freeze(keys), aggregates: Object.freeze(aggregates), guard,
    outputs: Object.freeze(outputs), inputColumns: Object.freeze([...inputs]) });
}
