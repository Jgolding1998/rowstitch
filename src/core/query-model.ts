/** Validated data plans. No driver, connection, SQL text, IO or execution lives here. */
import { fail } from './errors.js';
import { identifier, type Kind, type Parameter, type TableStorage } from './schema.js';
import { capturePhysicalName } from './physical-identity.js';

export interface TableModel {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly version?: string;
  readonly kinds?: Readonly<Record<string, Kind>>;
  readonly nullable?: Readonly<Record<string, boolean>>;
  /** Optional on legacy input plans; normalization captures a complete immutable storage identity. */
  readonly storage?: TableStorage;
}
export interface CapturedTableModel extends TableModel { readonly storage: TableStorage }
export type ComparisonOperator = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'IN';
export type ColumnComparisonOperator = Exclude<ComparisonOperator, 'IN'>;
export type TextMatchMode = 'contains' | 'starts-with' | 'ends-with';
export type TextMatchCase = 'sensitive' | 'ascii-insensitive';
export type RelationQuantifier = 'some' | 'none' | 'every';
export type PredicateModel =
  | { readonly kind: 'relation-filter'; readonly quantifier: RelationQuantifier; readonly table: TableModel;
      readonly localKey: string; readonly foreignKey: string; readonly where?: PredicateModel; readonly predicate?: PredicateModel }
  | { readonly kind: 'relation-count'; readonly operator: ColumnComparisonOperator; readonly threshold: number; readonly table: TableModel;
      readonly localKey: string; readonly foreignKey: string; readonly where?: PredicateModel; readonly predicate?: PredicateModel }
  | { readonly kind: 'column-compare'; readonly left: string; readonly right: string; readonly operator: ColumnComparisonOperator }
  | { readonly kind: 'text-match'; readonly column: string; readonly mode: TextMatchMode; readonly case: TextMatchCase; readonly literal: string }
  | { readonly kind: 'compare'; readonly column: string; readonly operator: ComparisonOperator; readonly values: readonly Parameter[] }
  | { readonly kind: 'logic'; readonly operator: 'AND' | 'OR'; readonly children: readonly PredicateModel[] }
  | { readonly kind: 'not'; readonly child: PredicateModel };
export interface OrderModel { readonly column: string; readonly direction: 'ASC' | 'DESC' }
interface HasTable { readonly table: TableModel }
/** One correlated relationship hop. The foreign (related) key is the left operand, as in relation filters. */
export interface RelationStepModel {
  readonly table: TableModel; readonly localKey: string; readonly foreignKey: string; readonly where?: PredicateModel;
}
/** A per-row aggregate over every matching join path through `path`; the leaf column belongs to the last step. */
export interface ProjectedAggregateModel {
  readonly alias: string; readonly operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  readonly column?: string; readonly approximate?: true; readonly path: readonly RelationStepModel[];
}
export interface SelectModel extends HasTable {
  readonly kind: 'select'; readonly columns: readonly string[]; readonly where?: PredicateModel;
  readonly orderBy: readonly OrderModel[]; readonly limit: number; readonly offset: number;
  readonly aggregates?: readonly ProjectedAggregateModel[];
}
export interface CountModel extends HasTable { readonly kind: 'count'; readonly where?: PredicateModel }
/** With `path`, the selection aggregates the leaf rows of that relation path and `column` names a leaf-table column. */
export interface AggregateSelectModel {
  readonly alias: string; readonly operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  readonly column?: string; readonly approximate?: true; readonly path?: readonly RelationStepModel[];
}
export interface AggregateModel extends HasTable {
  readonly kind: 'aggregate'; readonly select: readonly AggregateSelectModel[]; readonly where?: PredicateModel;
}
export interface AggregateOrderModel { readonly field: string; readonly direction: 'ASC' | 'DESC' }
export interface GroupModel extends HasTable {
  readonly kind: 'group'; readonly select: readonly AggregateSelectModel[]; readonly by: readonly string[];
  readonly where?: PredicateModel; readonly orderBy: readonly AggregateOrderModel[];
  readonly limit: number; readonly offset: number; readonly overflow: boolean;
}
export interface InsertModel extends HasTable { readonly kind: 'insert'; readonly columns: readonly string[]; readonly values: readonly Parameter[] }
export interface AssignmentModel { readonly column: string; readonly value: Parameter }
export interface UpdateModel extends HasTable { readonly kind: 'update'; readonly assignments: readonly AssignmentModel[]; readonly where: PredicateModel }
export interface DeleteModel extends HasTable { readonly kind: 'delete'; readonly where: PredicateModel }
export interface RelationModel extends HasTable {
  readonly kind: 'relation'; readonly columns: readonly string[]; readonly partitionBy: string; readonly keys: readonly Parameter[];
  readonly correlateKeys?: boolean;
  readonly where?: PredicateModel; readonly orderBy: readonly OrderModel[];
  readonly offset: number; readonly limit: number; readonly readLimit: number;
}
export interface ForeignKeyTargetModel { readonly schema?: string; readonly table: string; readonly column: string }
export type ForeignKeyModel = { readonly target: ForeignKeyTargetModel; readonly table?: never; readonly column?: never; readonly onDelete: 'cascade' | 'restrict' | 'set null' | 'no action' }
  | { readonly table: string; readonly column: string; readonly target?: never; readonly onDelete: 'cascade' | 'restrict' | 'set null' | 'no action' };
export interface ColumnDefinitionModel {
  readonly name: string; readonly kind: Kind; readonly nullable: boolean; readonly primary: boolean;
  readonly generated: boolean; readonly unique: boolean; readonly hasDefault: boolean; readonly defaultValue?: Parameter;
  readonly foreignKey?: ForeignKeyModel;
}
export interface CreateTableModel extends HasTable { readonly kind: 'create-table'; readonly definitions: readonly ColumnDefinitionModel[] }
export interface CreateIndexModel extends HasTable { readonly kind: 'create-index'; readonly name: string; readonly columns: readonly string[] }
export type TransactionAction = 'begin' | 'begin-immediate' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback-to';
export interface TransactionModel { readonly kind: 'transaction'; readonly action: TransactionAction; readonly name?: string }
export interface ExplainModel { readonly kind: 'explain'; readonly query: SelectModel | AggregateModel | GroupModel }
export type QueryModel = SelectModel | CountModel | AggregateModel | GroupModel | InsertModel | UpdateModel | DeleteModel | RelationModel | CreateTableModel | CreateIndexModel | TransactionModel | ExplainModel;

function record(value: unknown, keys: readonly string[], code = 'QUERY'): Record<string, unknown> {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { return fail(code, 'A model must be a plain record with supported fields.'); }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = (descriptors as Record<PropertyKey, PropertyDescriptor>)[key];
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptor)) fail(code, 'A model contains an unsupported field or accessor.');
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function list(value: unknown, maximum: number, minimum = 0, code = 'QUERY'): readonly unknown[] {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!Array.isArray(value) || ![null, Array.prototype].includes(Object.getPrototypeOf(value))) throw new Error();
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  } catch { return fail(code, 'A model array is outside its supported shape or length.'); }
  const length = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < minimum || length > maximum) fail(code, 'A model array is outside its supported shape or length.');
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || +key >= length)) fail(code, 'A model array contains unsupported properties.');
  }
  const copy: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !('value' in descriptor)) fail(code, 'Model arrays cannot contain holes or accessors.');
    copy.push(descriptor.value);
  }
  return copy;
}
function name(value: unknown): string {
  if (typeof value !== 'string') fail('SCHEMA', 'A model identifier must be a string.');
  identifier(value);
  return value;
}
function names(value: unknown, maximum: number, minimum: number, table?: TableModel): readonly string[] {
  const values = list(value, maximum, minimum, table ? 'QUERY' : 'SCHEMA').map(name);
  if (new Set(values).size !== values.length || table && values.some(v => !table.columns.includes(v))) fail(table ? 'QUERY' : 'SCHEMA', 'Model column names must be distinct and mapped.');
  return Object.freeze(values);
}
function field(table: TableModel, value: unknown): string {
  const result = name(value);
  if (!table.columns.includes(result)) fail('QUERY', 'A query references an unmapped column.');
  return result;
}
function parameter(value: unknown, code = 'QUERY'): Parameter {
  if (value === null || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'bigint' && value >= -(2n ** 63n) && value <= 2n ** 63n - 1n
      || typeof value === 'string' && value.length <= 1_048_576) return value as Parameter;
  return fail(code, 'A query parameter must be a bounded SQLite scalar value.');
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('QUERY', 'A model numeric option is outside its supported integer range.');
  return value;
}

/** Literal-search policy only; existing text storage and value comparisons are unchanged. */
export function textMatchLiteral(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\uD800-\uDFFF]/u.test(value)) fail('QUERY', 'A literal text search needs a nonempty, well-formed string of at most 4,096 UTF-16 code units.');
  return value;
}
export function textMatchOptions(input: unknown = {}): TextMatchCase {
  const options = record(input, ['case']);
  if (options.case === undefined) return 'sensitive';
  if (options.case !== 'sensitive' && options.case !== 'ascii-insensitive') fail('QUERY', 'A text search case must be sensitive or ascii-insensitive.');
  return options.case;
}

export function tableModel(input: TableModel): CapturedTableModel {
  const value = record(input, ['name', 'columns', 'primaryKey', 'version', 'kinds', 'nullable', 'storage'], 'SCHEMA');
  const columns = names(value.columns, 100, 1);
  if (new Set(columns.map(v => v.toLowerCase())).size !== columns.length) fail('SCHEMA', 'Mapped column names must be unique ignoring case.');
  let metadata: { kinds?: Readonly<Record<string, Kind>>; nullable?: Readonly<Record<string, boolean>> } = {};
  if (Object.hasOwn(value, 'kinds')) {
    const kinds = record(value.kinds, columns, 'SCHEMA');
    if (Object.keys(kinds).length !== columns.length || columns.some(column => !Object.hasOwn(kinds, column))) fail('SCHEMA', 'Column kind metadata must describe every mapped column.');
    for (const kind of Object.values(kinds)) if (typeof kind !== 'string' || !['integer', 'bigint', 'real', 'text', 'boolean', 'json'].includes(kind)) fail('SCHEMA', 'Column kind metadata contains an unsupported kind.');
    metadata = { kinds: Object.freeze(kinds as Record<string, Kind>) };
  }
  if (Object.hasOwn(value, 'nullable')) {
    const nullable = record(value.nullable, columns, 'SCHEMA');
    if (Object.keys(nullable).length !== columns.length || columns.some(column => !Object.hasOwn(nullable, column))
        || Object.values(nullable).some(flag => typeof flag !== 'boolean')) fail('SCHEMA', 'Nullability metadata must describe every mapped column with booleans.');
    metadata.nullable = Object.freeze(nullable as Record<string, boolean>);
  }
  const logicalName = name(value.name);
  let storage: TableStorage;
  if (value.storage === undefined) {
    storage = Object.freeze({ table: logicalName, columns: Object.freeze(Object.fromEntries(columns.map(column => [column, column]))) });
  } else {
    const supplied = record(value.storage, ['table', 'schema', 'columns'], 'SCHEMA');
    const physical = record(supplied.columns, columns, 'SCHEMA');
    if (Object.keys(physical).length !== columns.length || columns.some(column => !Object.hasOwn(physical, column)))
      fail('SCHEMA', 'Storage metadata must map every logical column exactly once.');
    const mapped = Object.fromEntries(columns.map(column => [column, capturePhysicalName(physical[column])]));
    if (new Set(Object.values(mapped)).size !== columns.length) fail('SCHEMA', 'Mapped physical column names must be distinct.');
    storage = Object.freeze({ table: capturePhysicalName(supplied.table),
      ...(supplied.schema === undefined ? {} : { schema: capturePhysicalName(supplied.schema) }), columns: Object.freeze(mapped) });
  }
  const base = { name: logicalName, columns, primaryKey: names(value.primaryKey, 100, 1), ...metadata, storage };
  if (base.primaryKey.some(v => !columns.includes(v))) fail('SCHEMA', 'A primary key must reference mapped columns.');
  if (value.version !== undefined) {
    const version = name(value.version);
    if (!columns.includes(version) || base.primaryKey.includes(version)) fail('SCHEMA', 'A version field must be a mapped non-key column.');
    return Object.freeze({ ...base, version });
  }
  return Object.freeze(base);
}

/** Codec domains for column operands; this does not cast or inspect stored rows. */
export function columnKindsCompatible(left: Kind, right: Kind, operator: ColumnComparisonOperator): boolean {
  const numeric = ['integer', 'bigint', 'real'];
  return numeric.includes(left) && numeric.includes(right) || left === 'text' && right === 'text'
    || left === 'boolean' && right === 'boolean' && (operator === '=' || operator === '<>');
}

/** Relationship equality follows the foreign column's native SQLite collation. */
export function relationKindsCompatible(left: Kind, right: Kind): boolean {
  return ['integer', 'bigint'].includes(left) && ['integer', 'bigint'].includes(right) || left === 'text' && right === 'text';
}

export function relationCountComparison(operator: unknown, threshold: unknown): { readonly operator: ColumnComparisonOperator; readonly threshold: number } {
  if (typeof operator !== 'string' || !['=', '<>', '>', '>=', '<', '<='].includes(operator)) fail('QUERY', 'A related count needs one of =, <>, >, >=, < or <=.');
  return Object.freeze({ operator: operator as ColumnComparisonOperator, threshold: number(threshold, 0, Number.MAX_SAFE_INTEGER) });
}

/** Logical limits shared by every predicate scope of one query (root where and all related domains). */
export interface PredicateBudget { nodes: number; parameters: number }
export const MAX_PREDICATE_NODES = 100, MAX_BOUND_PARAMETERS = 10_000;
export const MAX_RELATION_KEYS = 400;
/** Physical requests also carry generated paging, assignments or relation keys. The largest is a relation window. */
export const MAX_REQUEST_PARAMETERS = MAX_BOUND_PARAMETERS + MAX_RELATION_KEYS + 3;
export function predicateModel(tableInput: TableModel, input: PredicateModel, budget: PredicateBudget = { nodes: 0, parameters: 0 }, startRelationDepth = 0): PredicateModel {
  const table = tableModel(tableInput);
  if (!Number.isSafeInteger(startRelationDepth) || startRelationDepth < 0 || startRelationDepth > 4) fail('QUERY', 'Relation filters support at most four nested relationships.');
  function visit(source: unknown, depth: number, scope: TableModel = table, relationDepth = startRelationDepth): PredicateModel {
    if (++budget.nodes > MAX_PREDICATE_NODES || depth > 16) fail('QUERY', 'Predicates exceed their node or depth limit.');
    const node = record(source, ['kind', 'column', 'operator', 'values', 'children', 'child', 'mode', 'case', 'literal', 'left', 'right', 'quantifier', 'table', 'localKey', 'foreignKey', 'where', 'predicate', 'threshold']);
    if (node.kind === 'relation-filter' || node.kind === 'relation-count') {
      if (relationDepth >= 4) fail('QUERY', 'Relation filters support at most four nested relationships.');
      record(node, ['kind', 'table', 'localKey', 'foreignKey', 'where', 'predicate', ...(node.kind === 'relation-filter' ? ['quantifier'] : ['operator', 'threshold'])]);
      if (node.kind === 'relation-filter' && node.quantifier !== 'some' && node.quantifier !== 'none' && node.quantifier !== 'every') fail('QUERY', 'The relation quantifier is not supported.');
      const target = tableModel(node.table as TableModel);
      const localKey = field(scope, node.localKey), foreignKey = field(target, node.foreignKey);
      if (!scope.kinds || !target.kinds || !relationKindsCompatible(scope.kinds[localKey], target.kinds[foreignKey])) fail('QUERY', 'Relation filters require compatible integer, bigint or text keys.');
      if (node.quantifier === 'every' && node.predicate === undefined) fail('QUERY', 'Every requires a predicate for the related rows.');
      const base = { table: target, localKey, foreignKey,
        ...(node.where === undefined ? {} : { where: visit(node.where, depth + 1, target, relationDepth + 1) }),
        ...(node.predicate === undefined ? {} : { predicate: visit(node.predicate, depth + 1, target, relationDepth + 1) }) };
      if (node.kind === 'relation-count') {
        const comparison = relationCountComparison(node.operator, node.threshold);
        if (++budget.parameters > MAX_BOUND_PARAMETERS) fail('QUERY', 'Predicate parameters exceed their supported length.');
        return Object.freeze({ ...base, kind: 'relation-count', ...comparison });
      }
      return Object.freeze({ ...base, kind: 'relation-filter', quantifier: node.quantifier as RelationQuantifier });
    }
    if (node.kind === 'column-compare') {
      record(node, ['kind', 'left', 'right', 'operator']);
      if (typeof node.operator !== 'string' || !['=', '<>', '>', '>=', '<', '<='].includes(node.operator)) fail('QUERY', 'The column comparison operator is not supported.');
      const left = field(scope, node.left), right = field(scope, node.right);
      if (left === right) fail('QUERY', 'Compare two distinct mapped columns. Use an explicit NULL predicate for a self check.');
      if (!scope.kinds) fail('QUERY', 'Column comparisons require mapped column kind metadata.');
      const operator = node.operator as ColumnComparisonOperator;
      if (!columnKindsCompatible(scope.kinds[left], scope.kinds[right], operator)) fail('QUERY', 'Column comparison operands must have compatible scalar kinds.');
      return Object.freeze({ kind: 'column-compare', left, right, operator });
    }
    if (node.kind === 'text-match') {
      record(node, ['kind', 'column', 'mode', 'case', 'literal']);
      if (node.mode !== 'contains' && node.mode !== 'starts-with' && node.mode !== 'ends-with') fail('QUERY', 'The literal text search mode is not supported.');
      if (node.case !== 'sensitive' && node.case !== 'ascii-insensitive') fail('QUERY', 'A text search case must be sensitive or ascii-insensitive.');
      const matchCase = node.case;
      const literal = textMatchLiteral(node.literal);
      budget.parameters += node.mode === 'ends-with' ? 3 : 1;
      if (budget.parameters > MAX_BOUND_PARAMETERS) fail('QUERY', 'Predicate parameters exceed their supported length.');
      return Object.freeze({ kind: 'text-match', column: field(scope, node.column), mode: node.mode, case: matchCase, literal });
    }
    if (node.kind === 'compare') {
      record(node, ['kind', 'column', 'operator', 'values']);
      if (typeof node.operator !== 'string' || !['=', '<>', '>', '>=', '<', '<=', 'IN'].includes(node.operator)) fail('QUERY', 'The comparison operator is not supported.');
      const values = list(node.values, 10_000).map(v => parameter(v));
      budget.parameters += values.filter(value => value !== null).length;
      if (budget.parameters > MAX_BOUND_PARAMETERS || node.operator !== 'IN' && values.length !== 1) fail('QUERY', 'Predicate parameters exceed their supported length.');
      if (values[0] === null && !['=', '<>', 'IN'].includes(node.operator)) fail('QUERY', 'NULL only supports equality or inequality comparisons.');
      return Object.freeze({ kind: 'compare', column: field(scope, node.column), operator: node.operator as ComparisonOperator, values: Object.freeze(values) });
    }
    if (node.kind === 'logic') {
      record(node, ['kind', 'operator', 'children']);
      if (node.operator !== 'AND' && node.operator !== 'OR') fail('QUERY', 'The logical operator is not supported.');
      const children = list(node.children, 100).map(child => visit(child, depth + 1, scope, relationDepth));
      return Object.freeze({ kind: 'logic', operator: node.operator, children: Object.freeze(children) });
    }
    if (node.kind === 'not') {
      record(node, ['kind', 'child']);
      return Object.freeze({ kind: 'not', child: visit(node.child, depth + 1, scope, relationDepth) });
    }
    return fail('QUERY', 'The predicate model kind is not supported.');
  }
  return visit(input, 0);
}
/** Bound values the SQLite compiler emits for one rendering of a normalized predicate. */
export function predicateParameterCount(predicate?: PredicateModel): number {
  if (predicate === undefined) return 0;
  switch (predicate.kind) {
    case 'relation-filter': return predicateParameterCount(predicate.where) + predicateParameterCount(predicate.predicate);
    case 'relation-count': return predicateParameterCount(predicate.where) + predicateParameterCount(predicate.predicate) + 1;
    case 'column-compare': return 0;
    case 'text-match': return predicate.mode === 'ends-with' ? 3 : 1;
    case 'compare': return predicate.operator === 'IN' ? predicate.values.filter(value => value !== null).length : predicate.values[0] === null ? 0 : 1;
    case 'not': return predicateParameterCount(predicate.child);
    default: return predicate.children.reduce((total, child) => total + predicateParameterCount(child), 0);
  }
}
export function predicateTruth(predicate?: PredicateModel): true | false | null {
  if (predicate === undefined) return true;
  if (predicate.kind === 'relation-count') {
    const { operator, threshold } = predicate;
    if (predicateTruth(predicate.where) === false || predicateTruth(predicate.predicate) === false) {
      switch (operator) {
        case '=': return threshold === 0;
        case '<>': return threshold !== 0;
        case '>': return false;
        case '>=': return threshold === 0;
        case '<': return threshold > 0;
        case '<=': return true;
      }
    }
    return threshold === 0 && operator === '>=' ? true : threshold === 0 && operator === '<' ? false : null;
  }
  if (predicate.kind === 'relation-filter') {
    const domain = predicateTruth(predicate.where), test = predicateTruth(predicate.predicate);
    if (predicate.quantifier === 'every') return domain === false || test === true ? true : null;
    return domain === false || test === false ? predicate.quantifier === 'none' : null;
  }
  if (predicate.kind === 'text-match' || predicate.kind === 'column-compare') return null;
  if (predicate.kind === 'compare') return predicate.operator === 'IN' && predicate.values.length === 0 ? false : null;
  if (predicate.kind === 'not') {
    const truth = predicateTruth(predicate.child);
    return truth === null ? null : !truth;
  }
  const children = predicate.children.map(child => predicateTruth(child));
  return predicate.operator === 'AND'
    ? children.some(v => v === false) ? false : children.every(v => v === true) ? true : null
    : children.some(v => v === true) ? true : children.every(v => v === false) ? false : null;
}
export function hasRelationFilter(predicate?: PredicateModel): boolean {
  if (predicate === undefined) return false;
  if (predicate.kind === 'relation-filter' || predicate.kind === 'relation-count') return true;
  if (predicate.kind === 'not') return hasRelationFilter(predicate.child);
  return predicate.kind === 'logic' && predicate.children.some(hasRelationFilter);
}
export function orderingModel(tableInput: TableModel, input: readonly OrderModel[]): readonly OrderModel[] {
  const table = tableModel(tableInput);
  return Object.freeze(list(input, 200).map(source => {
    const order = record(source, ['column', 'direction']);
    if (order.direction !== 'ASC' && order.direction !== 'DESC') fail('QUERY', 'The ordering direction is not supported.');
    return Object.freeze({ column: field(table, order.column), direction: order.direction });
  }));
}

function optionalWhere(table: TableModel, value: unknown): { where?: PredicateModel } {
  return value === undefined ? {} : { where: predicateModel(table, value as PredicateModel) };
}
function guardedWhere(table: TableModel, value: unknown): PredicateModel {
  if (value === undefined) fail('UNSAFE_WRITE', 'Updates and deletes require a meaningful filter.');
  const where = predicateModel(table, value as PredicateModel);
  if (hasRelationFilter(where)) fail('UNSAFE_WRITE', 'Relation filters currently support reads only. Use explicit key filters for guarded writes.');
  if (predicateTruth(where) === true) fail('UNSAFE_WRITE', 'Updates and deletes require a meaningful filter.');
  return where;
}
function definition(input: unknown, table: TableModel): ColumnDefinitionModel {
  const value = record(input, ['name', 'kind', 'nullable', 'primary', 'generated', 'unique', 'hasDefault', 'defaultValue', 'foreignKey'], 'SCHEMA');
  const kind = value.kind;
  if (typeof kind !== 'string' || !['integer', 'bigint', 'real', 'text', 'boolean', 'json'].includes(kind)) fail('SCHEMA', 'The column kind is not supported.');
  for (const key of ['nullable', 'primary', 'generated', 'unique', 'hasDefault']) if (typeof value[key] !== 'boolean') fail('SCHEMA', 'Column flags must be booleans.');
  const columnName = field(table, value.name);
  if (value.primary !== table.primaryKey.includes(columnName)) fail('SCHEMA', 'Column primary flags must match the table primary key.');
  if (value.primary && (value.nullable || !['integer', 'bigint', 'text'].includes(kind))
      || value.generated && (!value.primary || !['integer', 'bigint'].includes(kind) || table.primaryKey.length !== 1)) fail('SCHEMA', 'The primary or generated column definition is not supported.');
  const base = { name: columnName, kind: kind as Kind, nullable: value.nullable as boolean, primary: value.primary as boolean,
    generated: value.generated as boolean, unique: value.unique as boolean, hasDefault: value.hasDefault as boolean };
  let defaultValue: { defaultValue?: Parameter } = {};
  if (value.hasDefault) {
    const scalar = parameter(value.defaultValue, 'SCHEMA');
    if (scalar === null && !value.nullable) fail('SCHEMA', 'A non-null column cannot default to NULL.');
    if (typeof scalar === 'string' && scalar.includes('\0')) fail('SCHEMA', 'SQLite default literals cannot contain a NUL character.');
    defaultValue = { defaultValue: scalar };
  } else if (Object.hasOwn(value, 'defaultValue')) fail('SCHEMA', 'A default value needs its hasDefault flag.');
  let foreignKey: { foreignKey?: NonNullable<ColumnDefinitionModel['foreignKey']> } = {};
  if (value.foreignKey !== undefined) {
    const fk = record(value.foreignKey, ['table', 'column', 'target', 'onDelete'], 'SCHEMA');
    if (typeof fk.onDelete !== 'string' || !['cascade', 'restrict', 'set null', 'no action'].includes(fk.onDelete) || fk.onDelete === 'set null' && !value.nullable) fail('SCHEMA', 'The foreign-key delete action is not supported.');
    let target: ForeignKeyTargetModel;
    if (Object.hasOwn(fk, 'target')) {
      if (Object.hasOwn(fk, 'table') || Object.hasOwn(fk, 'column')) fail('SCHEMA', 'A foreign key needs one structured target.');
      const physical = record(fk.target, ['schema', 'table', 'column'], 'SCHEMA');
      target = Object.freeze({ table: capturePhysicalName(physical.table), column: capturePhysicalName(physical.column),
        ...(physical.schema === undefined ? {} : { schema: capturePhysicalName(physical.schema) }) });
    } else target = Object.freeze({ table: name(fk.table), column: name(fk.column) });
    foreignKey = { foreignKey: Object.freeze({ target, onDelete: fk.onDelete as ForeignKeyModel['onDelete'] }) };
  }
  return Object.freeze({ ...base, ...defaultValue, ...foreignKey });
}

function aggregateSelections(table: TableModel, source: unknown, budget: PredicateBudget, groupKeys: readonly string[] = []): readonly AggregateSelectModel[] {
  if (!table.kinds || !table.nullable) fail('QUERY', 'Aggregates require complete column kind and nullability metadata.');
  const occupied = new Set(groupKeys.map(key => key.toLowerCase()));
  const selections = list(source, 32, 1).map(item => {
    const value = record(item, ['alias', 'operation', 'column', 'approximate', 'path']);
    const alias = name(value.alias), operation = value.operation;
    if (occupied.has(alias.toLowerCase())) fail('QUERY', 'Aggregate aliases must be unique and distinct from grouping keys ignoring case.');
    occupied.add(alias.toLowerCase());
    if (typeof operation !== 'string' || !['count', 'sum', 'avg', 'min', 'max'].includes(operation)) fail('QUERY', 'The aggregate operation is not supported.');
    // A related selection is validated against its leaf table; the root table only supplies the first local key.
    const related = value.path === undefined ? undefined : relationPath(table, value.path, budget);
    const scope = related?.leaf ?? table;
    const column = value.column === undefined ? undefined : field(scope, value.column);
    if (column === undefined && operation !== 'count') fail('QUERY', 'This aggregate requires a mapped column.');
    const kind = column === undefined ? undefined : scope.kinds![column];
    if (kind === 'json' || (operation === 'sum' || operation === 'avg') && !['integer', 'bigint', 'real'].includes(kind!)
        || (operation === 'min' || operation === 'max') && !['integer', 'bigint', 'real', 'text'].includes(kind!)) fail('QUERY', 'The aggregate does not support this column kind.');
    if (Object.hasOwn(value, 'approximate') && (value.approximate !== true || operation !== 'avg')
        || operation === 'avg' && kind === 'bigint' && value.approximate !== true) fail('QUERY', 'Bigint averages require approximate: true; only averages accept that option.');
    return Object.freeze({ alias, operation: operation as AggregateSelectModel['operation'], ...(column === undefined ? {} : { column }),
      ...(value.approximate === true ? { approximate: true as const } : {}), ...(related === undefined ? {} : { path: related.path }) });
  });
  const outputs = groupKeys.length + 1 + selections.reduce((total, selection) => total + (selectionIntegerSum(table, selection) ? 2 : 1), 0);
  if (outputs > 128) fail('QUERY', 'An aggregate query has too many generated outputs.');
  return Object.freeze(selections);
}

function aggregateOrdering(source: unknown, keys: readonly string[], selections: readonly AggregateSelectModel[]): readonly AggregateOrderModel[] {
  const fields = new Set([...keys, ...selections.map(selection => selection.alias)]);
  const orders = list(source, 100).map(item => {
    const value = record(item, ['field', 'direction']);
    if (typeof value.field !== 'string' || !fields.has(value.field) || value.direction !== 'ASC' && value.direction !== 'DESC') fail('QUERY', 'Grouped ordering must name a selected key or aggregate and use ASC or DESC.');
    return Object.freeze({ field: value.field, direction: value.direction });
  });
  if (new Set(orders.map(order => order.field)).size !== orders.length) fail('QUERY', 'Grouped ordering fields must be distinct.');
  for (const key of keys) if (!orders.some(order => order.field === key)) orders.push(Object.freeze({ field: key, direction: 'ASC' }));
  return Object.freeze(orders);
}

export const MAX_PROJECTED_AGGREGATES = 32, MAX_RELATION_PATH = 4;
/** True when a projected aggregate is rendered as an exact split integer sum (two outputs). */
export function projectedIntegerSum(aggregate: ProjectedAggregateModel): boolean {
  const leaf = aggregate.path[aggregate.path.length - 1].table;
  return aggregate.operation === 'sum' && ['integer', 'bigint'].includes(leaf.kinds![aggregate.column!]);
}
/** Physical copies of a path's domain values in the generated statement: value subquery (two for split integer sums) + guard. */
export function projectedCopies(aggregate: ProjectedAggregateModel): number {
  return (projectedIntegerSum(aggregate) ? 2 : 1) + 1;
}
/** Validates a relation path from `root` with the query-wide budget; a domain at step i starts at relation depth i. */
function relationPath(root: TableModel, source: unknown, budget: PredicateBudget): { path: readonly RelationStepModel[]; leaf: TableModel } {
  let scope = root;
  const path = list(source, MAX_RELATION_PATH, 1).map((item, index) => {
    const step = record(item, ['table', 'localKey', 'foreignKey', 'where']);
    const target = tableModel(step.table as TableModel);
    if (!scope.kinds || !target.kinds || !target.nullable) fail('QUERY', 'Related aggregates require complete column kind and nullability metadata.');
    const localKey = field(scope, step.localKey), foreignKey = field(target, step.foreignKey);
    if (!relationKindsCompatible(scope.kinds[localKey], target.kinds[foreignKey])) fail('QUERY', 'Relation paths require compatible integer, bigint or text keys.');
    const where = step.where === undefined ? undefined : predicateModel(target, step.where as PredicateModel, budget, index + 1);
    scope = target;
    return Object.freeze({ table: target, localKey, foreignKey, ...(where === undefined ? {} : { where }) });
  });
  return { path: Object.freeze(path), leaf: scope };
}
/** The table whose column a root aggregate selection reads: the root, or the leaf of its relation path. */
export function selectionTable(root: TableModel, selection: AggregateSelectModel): TableModel {
  return selection.path === undefined ? root : selection.path[selection.path.length - 1].table;
}
/** True when a root aggregate selection is rendered as an exact split integer sum (two outputs). */
export function selectionIntegerSum(root: TableModel, selection: AggregateSelectModel): boolean {
  return selection.operation === 'sum' && selection.column !== undefined && ['integer', 'bigint'].includes(selectionTable(root, selection).kinds![selection.column]);
}
/**
 * Bound values (excluding LIMIT/OFFSET) of an aggregate/group statement. Every related selection repeats the root WHERE
 * and its own domains once per physical copy: its value subquery (two for a split integer sum) and its storage guard.
 */
export function aggregatePhysicalParameters(query: AggregateModel | GroupModel): number {
  const where = predicateParameterCount(query.where);
  return where + query.select.reduce((total, selection) => selection.path === undefined ? total
    : total + ((selectionIntegerSum(query.table, selection) ? 2 : 1) + 1)
      * (where + selection.path.reduce((sum, step) => sum + predicateParameterCount(step.where), 0)), 0);
}
function projectedAggregates(root: TableModel, source: unknown, budget: PredicateBudget): readonly ProjectedAggregateModel[] {
  const occupied = new Set<string>();
  return Object.freeze(list(source, MAX_PROJECTED_AGGREGATES, 1).map(item => {
    const value = record(item, ['alias', 'operation', 'column', 'approximate', 'path']);
    const alias = name(value.alias), operation = value.operation;
    if (occupied.has(alias.toLowerCase())) fail('QUERY', 'Projected aggregate aliases must be unique ignoring case.');
    occupied.add(alias.toLowerCase());
    if (typeof operation !== 'string' || !['count', 'sum', 'avg', 'min', 'max'].includes(operation)) fail('QUERY', 'The aggregate operation is not supported.');
    const { path, leaf: scope } = relationPath(root, value.path, budget);
    const column = value.column === undefined ? undefined : field(scope, value.column);
    if (column === undefined && operation !== 'count') fail('QUERY', 'This aggregate requires a mapped column.');
    const kind = column === undefined ? undefined : scope.kinds![column];
    if (kind === 'json' || (operation === 'sum' || operation === 'avg') && !['integer', 'bigint', 'real'].includes(kind!)
        || (operation === 'min' || operation === 'max') && !['integer', 'bigint', 'real', 'text'].includes(kind!)) fail('QUERY', 'The aggregate does not support this column kind.');
    if (Object.hasOwn(value, 'approximate') && (value.approximate !== true || operation !== 'avg')
        || operation === 'avg' && kind === 'bigint' && value.approximate !== true) fail('QUERY', 'Bigint averages require approximate: true; only averages accept that option.');
    return Object.freeze({ alias, operation: operation as ProjectedAggregateModel['operation'], ...(column === undefined ? {} : { column }),
      ...(value.approximate === true ? { approximate: true as const } : {}), path });
  }));
}
/** Bound values (excluding LIMIT/OFFSET) of a select statement, counting every physical copy of a repeated domain. */
export function selectPhysicalParameters(query: SelectModel): number {
  return predicateParameterCount(query.where) + (query.aggregates ?? []).reduce((total, aggregate) =>
    total + projectedCopies(aggregate) * aggregate.path.reduce((sum, step) => sum + predicateParameterCount(step.where), 0), 0);
}

/** Revalidation is public to internal compilers: forged objects do not bypass constructors. */
export function normalizeQueryModel(input: QueryModel): QueryModel {
  const value = record(input, ['kind', 'table', 'columns', 'where', 'orderBy', 'limit', 'offset', 'values', 'assignments', 'partitionBy', 'keys', 'correlateKeys', 'readLimit', 'definitions', 'name', 'action', 'query', 'select', 'by', 'overflow', 'aggregates']);
  const kind = value.kind;
  if (kind === 'transaction') {
    record(value, ['kind', 'action', 'name']);
    if (typeof value.action !== 'string' || !['begin', 'begin-immediate', 'commit', 'rollback', 'savepoint', 'release', 'rollback-to'].includes(value.action)) fail('QUERY', 'The transaction action is not supported.');
    const action = value.action as TransactionAction;
    const needsName = ['savepoint', 'release', 'rollback-to'].includes(action);
    if (!needsName && value.name !== undefined) fail('QUERY', 'This transaction action does not accept a name.');
    return Object.freeze({ kind, action, ...(needsName ? { name: name(value.name) } : {}) });
  }
  if (kind === 'explain') {
    record(value, ['kind', 'query']);
    const select = record(value.query, ['kind', 'table', 'columns', 'where', 'orderBy', 'limit', 'offset', 'select', 'by', 'overflow', 'aggregates']);
    if (!['select', 'aggregate', 'group'].includes(select.kind as string)) fail('QUERY', 'Only generated row, aggregate or group reads can be explained.');
    const query = normalizeQueryModel(select as unknown as SelectModel | AggregateModel | GroupModel);
    if (query.kind !== 'select' && query.kind !== 'aggregate' && query.kind !== 'group') fail('QUERY', 'Only generated row, aggregate or group reads can be explained.');
    return Object.freeze({ kind, query });
  }
  if (typeof kind !== 'string' || !['select', 'count', 'aggregate', 'group', 'insert', 'update', 'delete', 'relation', 'create-table', 'create-index'].includes(kind)) fail('QUERY', 'The query model kind is not supported.');
  const table = tableModel(value.table as TableModel);
  if (kind === 'aggregate') {
    record(value, ['kind', 'table', 'select', 'where']);
    // One logical budget covers the root where and every related domain; the physical count includes repeated copies.
    const budget: PredicateBudget = { nodes: 0, parameters: 0 };
    const where = value.where === undefined ? {} : { where: predicateModel(table, value.where as PredicateModel, budget) };
    const query = Object.freeze({ kind, table, select: aggregateSelections(table, value.select, budget), ...where }) as AggregateModel;
    if (aggregatePhysicalParameters(query) > MAX_BOUND_PARAMETERS) fail('QUERY', 'A query has too many bound parameters once the root filter and related domains are repeated for related selectors.');
    return query;
  }
  if (kind === 'group') {
    record(value, ['kind', 'table', 'select', 'by', 'where', 'orderBy', 'limit', 'offset', 'overflow']);
    const by = names(value.by, 16, 1, table);
    if (!table.kinds || !table.nullable || by.some(key => table.kinds![key] === 'json')) fail('QUERY', 'Grouping requires complete metadata and scalar keys other than JSON.');
    const budget: PredicateBudget = { nodes: 0, parameters: 0 };
    const where = value.where === undefined ? {} : { where: predicateModel(table, value.where as PredicateModel, budget) };
    const select = aggregateSelections(table, value.select, budget, by);
    if (typeof value.overflow !== 'boolean') fail('QUERY', 'The group overflow option must be a boolean.');
    const limit = value.overflow ? number(value.limit, 10_001, 10_001) : number(value.limit, 0, 10_000);
    const query = Object.freeze({ kind, table, select, by, ...where,
      orderBy: aggregateOrdering(value.orderBy, by, select), limit, offset: number(value.offset, 0, 1_000_000_000), overflow: value.overflow }) as GroupModel;
    if (aggregatePhysicalParameters(query) > MAX_BOUND_PARAMETERS) fail('QUERY', 'A query has too many bound parameters once the root filter and related domains are repeated for related selectors.');
    return query;
  }
  if (kind === 'select') {
    record(value, ['kind', 'table', 'columns', 'where', 'orderBy', 'limit', 'offset', 'aggregates']);
    // One logical budget covers the root where and every related domain; no scope gets a fresh allowance.
    const budget: PredicateBudget = { nodes: 0, parameters: 0 };
    const where = value.where === undefined ? {} : { where: predicateModel(table, value.where as PredicateModel, budget) };
    const aggregates = value.aggregates === undefined ? {} : { aggregates: projectedAggregates(table, value.aggregates, budget) };
    const query = Object.freeze({ kind, table, columns: names(value.columns, 100, 1, table), ...where, ...aggregates,
      orderBy: orderingModel(table, value.orderBy as readonly OrderModel[]), limit: number(value.limit, 0, 10_000), offset: number(value.offset, 0, 1_000_000_000) }) as SelectModel;
    if (selectPhysicalParameters(query) > MAX_BOUND_PARAMETERS) fail('QUERY', 'A query has too many bound parameters once repeated relation domains are counted.');
    return query;
  }
  if (kind === 'count') {
    record(value, ['kind', 'table', 'where']);
    return Object.freeze({ kind, table, ...optionalWhere(table, value.where) });
  }
  if (kind === 'insert') {
    record(value, ['kind', 'table', 'columns', 'values']);
    const columns = names(value.columns, 100, 0, table), values = list(value.values, 100).map(v => parameter(v));
    if (columns.length !== values.length) fail('QUERY', 'Insert columns and values must have the same length.');
    return Object.freeze({ kind, table, columns, values: Object.freeze(values) });
  }
  if (kind === 'update') {
    record(value, ['kind', 'table', 'assignments', 'where']);
    const assignments = list(value.assignments, 100, 1).map(source => {
      const item = record(source, ['column', 'value']);
      const column = field(table, item.column);
      if (table.primaryKey.includes(column) || table.version === column) fail('QUERY', 'Primary and version columns are not directly editable.');
      return Object.freeze({ column, value: parameter(item.value) });
    });
    if (new Set(assignments.map(a => a.column)).size !== assignments.length) fail('QUERY', 'Update assignments must have distinct columns.');
    return Object.freeze({ kind, table, assignments: Object.freeze(assignments), where: guardedWhere(table, value.where) });
  }
  if (kind === 'delete') {
    record(value, ['kind', 'table', 'where']);
    return Object.freeze({ kind, table, where: guardedWhere(table, value.where) });
  }
  if (kind === 'relation') {
    record(value, ['kind', 'table', 'columns', 'partitionBy', 'keys', 'correlateKeys', 'where', 'orderBy', 'offset', 'limit', 'readLimit']);
    const columns = names(value.columns, 100, 1, table), partitionBy = field(table, value.partitionBy);
    if (!columns.includes(partitionBy)) fail('QUERY', 'A relationship window must retain its partition key internally.');
    const keys = list(value.keys, MAX_RELATION_KEYS, 1).map(v => parameter(v));
    if (keys.some(v => v === null)) fail('QUERY', 'Relationship key batches cannot contain NULL.');
    if (value.correlateKeys !== undefined && typeof value.correlateKeys !== 'boolean') fail('QUERY', 'Relationship key correlation must be a boolean.');
    if (value.correlateKeys && (table.kinds?.[partitionBy] !== 'text' || keys.some(key => typeof key !== 'string'))) fail('QUERY', 'Correlated relationship keys require mapped text columns and text values.');
    return Object.freeze({ kind, table, columns, partitionBy, keys: Object.freeze(keys), ...(value.correlateKeys ? { correlateKeys: true } : {}), ...optionalWhere(table, value.where),
      orderBy: orderingModel(table, value.orderBy as readonly OrderModel[]), offset: number(value.offset, 0, 1_000_000_000),
      limit: number(value.limit, 0, 1000), readLimit: number(value.readLimit, 1, 10_001) });
  }
  if (kind === 'create-index') {
    record(value, ['kind', 'table', 'name', 'columns']);
    return Object.freeze({ kind, table, name: capturePhysicalName(value.name), columns: names(value.columns, 100, 1, table) });
  }
  record(value, ['kind', 'table', 'definitions'], 'SCHEMA');
  const definitions = list(value.definitions, 100, 1, 'SCHEMA').map(d => definition(d, table));
  if (definitions.length !== table.columns.length || definitions.some((d, i) => d.name !== table.columns[i])) fail('SCHEMA', 'Column definitions must match the mapped table order.');
  if (table.version) {
    const version = definitions.find(d => d.name === table.version)!;
    if (version.kind !== 'integer' || version.nullable) fail('SCHEMA', 'The version column must be a non-null integer.');
  }
  return Object.freeze({ kind: 'create-table', table, definitions: Object.freeze(definitions) });
}

type Input<M extends QueryModel> = Omit<M, 'kind'>;
function build<M extends QueryModel>(kind: M['kind'], input: Input<M>, allowed: readonly string[]): M {
  const snapshot = record(input, allowed, kind === 'create-table' || kind === 'create-index' ? 'SCHEMA' : 'QUERY');
  return normalizeQueryModel({ ...snapshot, kind } as M) as M;
}
export const queryModel = Object.freeze({
  select: (input: Input<SelectModel>): SelectModel => build('select', input, ['table', 'columns', 'where', 'orderBy', 'limit', 'offset', 'aggregates']),
  count: (input: Input<CountModel>): CountModel => build('count', input, ['table', 'where']),
  aggregate: (input: Input<AggregateModel>): AggregateModel => build('aggregate', input, ['table', 'select', 'where']),
  group: (input: Input<GroupModel>): GroupModel => build('group', input, ['table', 'select', 'by', 'where', 'orderBy', 'limit', 'offset', 'overflow']),
  insert: (input: Input<InsertModel>): InsertModel => build('insert', input, ['table', 'columns', 'values']),
  update: (input: Input<UpdateModel>): UpdateModel => build('update', input, ['table', 'assignments', 'where']),
  delete: (input: Input<DeleteModel>): DeleteModel => build('delete', input, ['table', 'where']),
  relation: (input: Input<RelationModel>): RelationModel => build('relation', input, ['table', 'columns', 'partitionBy', 'keys', 'correlateKeys', 'where', 'orderBy', 'offset', 'limit', 'readLimit']),
  createTable: (input: Input<CreateTableModel>): CreateTableModel => build('create-table', input, ['table', 'definitions']),
  createIndex: (input: Input<CreateIndexModel>): CreateIndexModel => build('create-index', input, ['table', 'name', 'columns']),
  transaction: (input: Input<TransactionModel>): TransactionModel => build('transaction', input, ['action', 'name']),
  explain: (input: Input<ExplainModel>): ExplainModel => build('explain', input, ['query']),
});
