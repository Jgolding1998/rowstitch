import {
  Column, column, defineTable, eq, asc, type ColumnRef, type InsertRow, type KeyRow,
  type Row, type UpdateRow, type Repository,
} from '../../dist/index.js';
import { tableModel, queryModel, type CapturedTableModel, type TableModel } from '../../src/core/query-model.js';
import { mappedTableModel } from '../../src/core/model-mapping.js';
import { column as coreColumn, defineTable as coreDefineTable } from '../../src/core/schema.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const stored = column.integer().storedAs('physical ID');
const generated = column.integer().storedAs('physical generated').primaryKey({ generated: true }).storedAs('other generated');
const nullable = column.integer().nullable().storedAs('physical nullable').default(null).unique();
const defaulted = column.text().default('fallback').storedAs('physical label');
type StoredFlags = Expect<Equal<typeof stored, Column<number, false, false, 'integer'>>>;
type GeneratedFlags = Expect<Equal<typeof generated, Column<number, true, true, 'integer'>>>;
type NullableFlags = Expect<Equal<typeof nullable, Column<number | null, true, false, 'integer'>>>;
type DefaultFlags = Expect<Equal<typeof defaulted, Column<string, true, false, 'text'>>>;

const parents = defineTable('logical_parents', { id: column.integer().primaryKey().storedAs('parent key') }, { storage: { table: 'Parent rows', schema: 'Tenant.Space' } });
const reference = column.integer().storedAs('owner key').references(parents, 'id');
type ReferenceFlags = Expect<Equal<typeof reference, Column<number, false, false, 'integer'>>>;
const records = defineTable('logical_records', {
  id: generated,
  parentId: reference,
  displayName: column.text().storedAs('display name'),
  note: defaulted,
  optionalCount: nullable,
  version: column.integer().default(1).storedAs('revision no'),
}, { version: 'version', storage: { table: 'Record rows', schema: 'Tenant.Space' }, schemaPolicy: 'subset' });

const logicalRow: Row<typeof records> = { id: 1, parentId: 1, displayName: 'Avery', note: 'ok', optionalCount: null, version: 1 };
const insert: InsertRow<typeof records> = { parentId: 1, displayName: 'Avery' };
const update: UpdateRow<typeof records> = { displayName: 'Sam', optionalCount: 2 };
const key: KeyRow<typeof records> = { id: 1 };
const logicalRef: ColumnRef<string, 'text'> = records.col('displayName');
const version: 'version' | undefined = records.version;
const physical: string = records.storage.columns.displayName!;
const physicalSchema: string | undefined = records.storage.schema;
declare const repository: Repository<typeof records>;
const selected = repository.findMany({ select: ['displayName'], where: eq(records.col('parentId'), 1), orderBy: [asc(records.col('displayName'))] });
const display: string = selected[0]!.displayName;
repository.update(update, { where: eq(records.col('id'), 1) });

// @ts-expect-error Physical spellings never become row properties.
const physicalRowField = logicalRow['display name'];
// @ts-expect-error The logical required field is still required after storage aliasing.
const missingInsert: InsertRow<typeof records> = { parentId: 1 };
// @ts-expect-error Physical names cannot replace logical insert keys.
const physicalInsert: InsertRow<typeof records> = { parentId: 1, 'display name': 'Avery' };
// @ts-expect-error Optimistic version writes remain owned by the ORM.
const versionUpdate: UpdateRow<typeof records> = { version: 2 };
// @ts-expect-error Primary keys are excluded from ordinary updates.
const primaryUpdate: UpdateRow<typeof records> = { id: 2 };
// @ts-expect-error KeyRow preserves the literal primary-key generic.
const otherKey: KeyRow<typeof records> = { parentId: 1 };
// @ts-expect-error ColumnRef lookup remains logical.
records.col('display name');
// @ts-expect-error Target references use logical keys.
column.integer().references(parents, 'parent key');
// @ts-expect-error Stored column Kind remains integer through all four generics.
const wrongKind: ColumnRef<number, 'text'> = records.col('parentId');
// @ts-expect-error Selected rows omit other logical fields as before.
selected[0]!.id;
// @ts-expect-error Physical names cannot be used in select.
repository.findMany({ select: ['display name'] });
// @ts-expect-error Physical names cannot be used for the version policy.
defineTable('wrong_version', { id: column.integer().primaryKey(), version: column.integer().storedAs('revision') }, { version: 'revision' });
// @ts-expect-error Only named schema policies are accepted.
defineTable('wrong_policy', { id: column.integer().primaryKey() }, { schemaPolicy: 'permissive' });
// @ts-expect-error Column storage names are configured on builders, not Table storage options.
defineTable('wrong_map_option', { id: column.integer().primaryKey() }, { storage: { columns: { id: 'ID' } } });
// @ts-expect-error Storage is a closed options record.
defineTable('wrong_storage_option', { id: column.integer().primaryKey() }, { storage: { database: 'db' } });
// @ts-expect-error Physical name input is text without implicit coercion.
column.integer().storedAs(12);
// @ts-expect-error Captured table storage is immutable.
records.storage.table = 'changed';
// @ts-expect-error Captured storage map is immutable.
records.storage.columns.displayName = 'changed';
// @ts-expect-error Captured schema policy is immutable.
records.schemaPolicy = 'exact';

const oldInput: TableModel = { name: 'legacy_model', columns: ['id'], primaryKey: ['id'] };
const oldCaptured: CapturedTableModel = tableModel(oldInput);
// Internal source modules share the source declaration graph. Installed public builders above
// deliberately retain dist types; crossing those recursive Column/Table graphs is not a public API.
const coreRecords = coreDefineTable('core_logical_records', {
  id: coreColumn.integer().primaryKey().storedAs('physical ID'),
  version: coreColumn.integer().storedAs('revision no'),
}, { version: 'version', storage: { table: 'Physical core records' }, schemaPolicy: 'subset' });
const genuineCaptured: CapturedTableModel = mappedTableModel(coreRecords);
const complete: string = oldCaptured.storage.columns.id!;
const explicit: CapturedTableModel = tableModel({ ...oldInput, storage: { table: 'physical.model', schema: 'S', columns: { id: '__proto__' } } });
// @ts-expect-error A canonical model must include complete captured storage metadata.
const missingCaptured: CapturedTableModel = oldInput;
// @ts-expect-error Captured model storage is not assignable.
explicit.storage = { table: 'changed', columns: { id: 'changed' } };
// @ts-expect-error Pure physical storage input needs a table name and map.
tableModel({ ...oldInput, storage: { columns: { id: 'ID' } } });

const base = { name: 'id', kind: 'integer' as const, nullable: false, primary: true, generated: false, unique: false, hasDefault: false };
queryModel.createTable({ table: oldInput, definitions: [{ ...base, foreignKey: { table: 'parents', column: 'id', onDelete: 'no action' } }] });
queryModel.createTable({ table: oldInput, definitions: [{ ...base, foreignKey: { target: { schema: 'S', table: 'Physical parent', column: 'parent ID' }, onDelete: 'cascade' } }] });
// @ts-expect-error Canonical foreign targets need a column component.
queryModel.createTable({ table: oldInput, definitions: [{ ...base, foreignKey: { target: { table: 'parents' }, onDelete: 'no action' } }] });
// @ts-expect-error Legacy and canonical FK input forms cannot be combined.
queryModel.createTable({ table: oldInput, definitions: [{ ...base, foreignKey: { table: 'parents', column: 'id', target: { table: 'parents', column: 'id' }, onDelete: 'no action' } }] });

void [logicalRow, insert, key, logicalRef, version, physical, physicalSchema, display, physicalRowField, missingInsert, physicalInsert, versionUpdate, primaryUpdate, otherKey, wrongKind, complete, genuineCaptured, missingCaptured];
type AllFlags = [StoredFlags, GeneratedFlags, NullableFlags, DefaultFlags, ReferenceFlags];
declare const flags: AllFlags;
void flags;
