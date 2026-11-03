/** Per-row related aggregates: validated lowering to pure models and decoding of generated outputs. No SQL, IO or runtime imports. */
import { RowstitchError, fail } from './errors.js';
import { decode, isColumnRef, isTable, type AnyTable, type Column, type Kind } from './schema.js';
import { mappedTableModel } from './model-mapping.js';
import { isAggregateSelector, isRelatedAggregate, MAX_SELECTORS } from './aggregates.js';
import { filterRelationSnapshot, type LoweringBudget, type Predicate } from './predicates.js';
import { MAX_RELATION_PATH, type PredicateModel, type ProjectedAggregateModel, type RelationStepModel } from './query-model.js';
import { projectedLayout } from './projected-layout.js';

export interface ProjectedLowering {
  /** Exact registration check for every table on a path. */
  mapped(table: AnyTable): void;
  /** Lowers a relation domain with the query-wide budget, starting at the given relation depth. */
  where(table: AnyTable, where: Predicate, budget: LoweringBudget, relationDepth: number): PredicateModel | undefined;
  /** Selected column names and include names; aliases may not repeat them ignoring case. */
  reserved: readonly string[];
}
export interface ProjectedPlan { readonly models: readonly ProjectedAggregateModel[]; readonly leaves: readonly AnyTable[] }

const LOW_WORD = 4_294_967_296n;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const reservedNames = ['__proto__', 'constructor', 'prototype'];

function kindOf(table: AnyTable, column: string): Kind {
  return (table.columns[column] as Column<unknown, boolean, boolean>).config.kind;
}
/** Reads own data properties of a plain record once; accessors and symbols are refused without being called. */
function entries(input: unknown): [string, unknown][] {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail('QUERY', 'aggregates must be a plain record of agg.related values.');
    return Reflect.ownKeys(input).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) fail('QUERY', 'aggregates cannot use accessors or symbol keys.');
      return [key, descriptor.value] as [string, unknown];
    });
  } catch (error) {
    if (error instanceof RowstitchError) throw error;
    return fail('QUERY', 'aggregates must be a plain record of agg.related values.');
  }
}

/** Lowers findMany/findFirst `aggregates`. The result is revalidated again by the select-model normalizer. */
export function projectedAggregatesToModel(root: AnyTable, input: unknown, context: ProjectedLowering, budget: LoweringBudget): ProjectedPlan {
  if (!isTable(root)) fail('SCHEMA', 'Aggregates require a genuine mapped table.');
  const items = entries(input);
  if (items.length < 1 || items.length > MAX_SELECTORS) fail('QUERY', 'Select 1 to 32 related aggregates.');
  const occupied = new Set(context.reserved.map(name => name.toLowerCase()));
  const seen = new Set<string>();
  const models: ProjectedAggregateModel[] = [], leaves: AnyTable[] = [];
  for (const [alias, value] of items) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(alias) || /^(?:sqlite_|__rs_)/i.test(alias) || reservedNames.includes(alias)) fail('QUERY', 'Aggregate aliases must be simple names of 1 to 63 characters and cannot use reserved names.');
    if (seen.has(alias.toLowerCase())) fail('QUERY', 'Aggregate aliases must be unique ignoring case.');
    if (occupied.has(alias.toLowerCase())) fail('QUERY', 'Aggregate aliases cannot repeat a selected column or include name.');
    seen.add(alias.toLowerCase());
    if (isAggregateSelector(value)) fail('QUERY', 'Per-row aggregates need agg.related; plain agg selectors belong in aggregate or groupBy.');
    if (!isRelatedAggregate(value)) fail('QUERY', 'Per-row aggregates must be created with agg.related.');
    const path: RelationStepModel[] = [];
    let scope = root, item: unknown = value;
    while (isRelatedAggregate(item)) {
      if (path.length >= MAX_RELATION_PATH) fail('QUERY', 'Related aggregates support at most four relationships in a path.');
      const { table, options } = filterRelationSnapshot(item.relation);
      const { localKey, foreignKey, where } = options;
      if (!isColumnRef(localKey) || localKey.table !== scope) fail('QUERY', 'Each related aggregate relation must start from the previous table in its path.');
      if (!isColumnRef(foreignKey) || foreignKey.table !== table) fail('QUERY', 'A relation foreign key must belong to its related table.');
      context.mapped(table);
      const domain = where === undefined ? undefined : context.where(table, where, budget, path.length + 1);
      path.push(Object.freeze({ table: mappedTableModel(table), localKey: localKey.name, foreignKey: foreignKey.name, ...(domain === undefined ? {} : { where: domain }) }));
      scope = table;
      item = item.selector;
    }
    if (!isAggregateSelector(item)) fail('QUERY', 'agg.related needs an agg selector at the end of its path.');
    const ref = item.ref;
    if (ref !== undefined && (ref.table !== scope || !Object.hasOwn(scope.columns, ref.name))) fail('QUERY', 'A related aggregate column must belong to the last table in its path.');
    if (ref === undefined && item.operation !== 'count') fail('QUERY', 'This aggregate needs a column.');
    if (ref !== undefined && item.operation === 'avg' && kindOf(scope, ref.name) === 'bigint' && !item.approximate) fail('QUERY', 'A bigint average is approximate; pass { approximate: true }.');
    models.push(Object.freeze({ alias, operation: item.operation, ...(ref === undefined ? {} : { column: ref.name }),
      ...(item.approximate ? { approximate: true as const } : {}), path: Object.freeze(path) }));
    leaves.push(scope);
  }
  return Object.freeze({ models: Object.freeze(models), leaves: Object.freeze(leaves) });
}

/** Raises DATA when any returned row's same-query storage guard is set. Call before decoding or exposing any row. */
export function assertProjectedGuard(rows: readonly Record<string, unknown>[]): void {
  const guard = projectedLayout([]).guard;
  for (const row of rows) {
    if (!Object.hasOwn(row, guard)) fail('DATA', 'A related aggregate result is missing its storage guard.');
    const value = row[guard];
    if (value === 0n || value === 0) continue;
    if (value === 1n || value === 1) fail('DATA', 'Stored data used by a related aggregate does not match its mapped columns.');
    fail('DATA', 'A related aggregate result row is malformed.');
  }
}

function read(row: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(row, name)) fail('DATA', 'A related aggregate result is missing a generated column.');
  return row[name];
}
function finite(value: unknown): number | null {
  if (value === null) return null;
  // Real SUM is cast to REAL and AVG returns REAL; integer storage here is malformed and never coerced via Number(bigint).
  if (typeof value !== 'number' || Number.isNaN(value)) fail('DATA', 'A related aggregate returned an unexpected value type.');
  if (!Number.isFinite(value)) fail('AGGREGATE_RANGE', 'An aggregate result is not a finite number.');
  return value;
}

/** Decodes the projected aggregate outputs of one already-guarded row. */
export function decodeProjectedRow(plan: ProjectedPlan, row: Record<string, unknown>): Record<string, unknown> {
  const layout = projectedLayout(plan.models);
  const result: Record<string, unknown> = {};
  layout.outputs.forEach((output, index) => {
    const aggregate = output.aggregate, leaf = plan.leaves[index], last = aggregate.path[aggregate.path.length - 1].table;
    if (!isTable(leaf) || leaf.name !== last.name || aggregate.column !== undefined && last.kinds?.[aggregate.column] !== kindOf(leaf, aggregate.column)) fail('QUERY', 'A related aggregate plan does not match its mapped tables.');
    if (output.kind === 'integer-sum') {
      const high = read(row, output.high), low = read(row, output.low);
      if (high === null && low === null) { result[aggregate.alias] = null; return; }
      if (typeof high !== 'bigint' || typeof low !== 'bigint' || low < 0n || low >= LOW_WORD) fail('DATA', 'An exact sum returned malformed partial values.');
      result[aggregate.alias] = high * LOW_WORD + low;
      return;
    }
    const value = read(row, output.name);
    switch (aggregate.operation) {
      case 'count':
        if (typeof value !== 'bigint' || value < 0n || value > SAFE_MAX) fail('DATA', 'A database count exceeds the supported range.');
        result[aggregate.alias] = Number(value);
        return;
      case 'sum': case 'avg':
        result[aggregate.alias] = finite(value);
        return;
      default: {
        // MIN/MAX of an empty path is NULL even for non-null columns: decode with the leaf codec forced nullable.
        const config = (leaf.columns[aggregate.column!] as Column<unknown, boolean, boolean>).config;
        result[aggregate.alias] = decode({ ...config, nullable: true }, value);
      }
    }
  });
  return result;
}
