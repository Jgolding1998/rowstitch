/** Decodes one generated aggregate/group row into the public typed object. Pure: no SQL, IO or runtime imports. */
import { fail } from './errors.js';
import { decode, isTable, type AnyTable, type Column } from './schema.js';
import { aggregateLayout } from './aggregate-layout.js';
import type { AggregateModel, GroupModel, TableModel } from './query-model.js';

const LOW_WORD = 4_294_967_296n;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function read(row: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(row, name)) fail('DATA', 'An aggregate result is missing a generated column.');
  return row[name];
}
function finite(value: unknown): number | null {
  if (value === null) return null;
  // The compiler casts real SUM input to REAL and SQLite AVG always returns REAL, so integer storage here is malformed
  // (never silently coerced: a bigint beyond 2^53 would lose precision without notice).
  if (typeof value !== 'number' || Number.isNaN(value)) fail('DATA', 'An aggregate returned an unexpected value type.');
  if (!Number.isFinite(value)) fail('AGGREGATE_RANGE', 'An aggregate result is not a finite number.');
  return value;
}

/** Throws DATA when the same-query storage guard flagged any filtered input, before any public value is produced. */
/** `leaves[i]` is the leaf table of related selection i (undefined for root selections); min/max use its codec. */
export function decodeAggregateRow(table: AnyTable, model: AggregateModel | GroupModel, row: Record<string, unknown>, leaves: readonly (AnyTable | undefined)[] = []): Record<string, unknown> {
  if (!isTable(table) || model.table.name !== table.name) fail('QUERY', 'An aggregate result must be decoded with its own mapped table.');
  if (row === null || typeof row !== 'object') fail('DATA', 'An aggregate result row is malformed.');
  const matches = (owner: AnyTable | undefined, kinds: TableModel['kinds'], column: string): boolean => isTable(owner)
    && Object.hasOwn(owner.columns, column) && kinds?.[column] === (owner.columns[column] as Column<unknown, boolean, boolean>).config.kind;
  for (const column of model.kind === 'group' ? model.by : []) if (!matches(table, model.table.kinds, column)) fail('QUERY', 'An aggregate model does not match its mapped table.');
  model.select.forEach((item, index) => {
    if (item.path === undefined) {
      if (item.column !== undefined && !matches(table, model.table.kinds, item.column)) fail('QUERY', 'An aggregate model does not match its mapped table.');
      return;
    }
    const leaf = leaves[index], last = item.path[item.path.length - 1].table;
    if (!isTable(leaf) || leaf.name !== last.name || item.column !== undefined && !matches(leaf, last.kinds, item.column)) fail('QUERY', 'A related aggregate plan does not match its mapped tables.');
  });
  // The compiler's shared layout defines every generated name, so SQL and decoding cannot drift.
  const layout = aggregateLayout(model);
  const guard = read(row, layout.guard.name);
  if (guard !== 0n && guard !== 0) {
    if (guard === 1n || guard === 1) fail('DATA', 'Stored data used by this aggregate does not match its mapped columns.');
    fail('DATA', 'An aggregate result row is malformed.');
  }
  const result: Record<string, unknown> = {};
  for (const key of layout.keys) {
    const config = (table.columns[key.column] as Column<unknown, boolean, boolean>).config;
    result[key.column] = decode(config, read(row, key.output.name));
  }
  layout.aggregates.forEach((entry, index) => {
    const item = entry.selection, owner = item.path === undefined ? table : leaves[index]!;
    if (entry.kind === 'integer-sum') {
      const high = read(row, entry.high.name), low = read(row, entry.low.name);
      if (high === null && low === null) { result[item.alias] = null; return; }
      if (typeof high !== 'bigint' || typeof low !== 'bigint' || low < 0n || low >= LOW_WORD) fail('DATA', 'An exact sum returned malformed partial values.');
      result[item.alias] = high * LOW_WORD + low;
      return;
    }
    const value = read(row, entry.output.name);
    switch (item.operation) {
      case 'count':
        if (typeof value !== 'bigint' || value < 0n || value > SAFE_MAX) fail('DATA', 'A database count exceeds the supported range.');
        result[item.alias] = Number(value);
        return;
      case 'sum': case 'avg':
        result[item.alias] = finite(value);
        return;
      default: {
        // MIN/MAX of empty or all-NULL input is NULL even for non-null columns: decode with a nullable output codec.
        const config = (owner.columns[item.column!] as Column<unknown, boolean, boolean>).config;
        result[item.alias] = decode({ ...config, nullable: true }, value);
      }
    }
  });
  return result;
}
