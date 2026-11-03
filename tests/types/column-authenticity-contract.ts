import { Column, column, defineTable, openDatabase, type Row, type InsertRow } from '../../dist/index.js';
const parents = defineTable('typed_parents', { id: column.integer().primaryKey(), code: column.text().unique() });
const direct = new Column<number | null, true, false, 'integer'>({ kind: 'integer', nullable: true, primary: false, generated: false, unique: false, hasDefault: false,
  foreignKey: { table: parents, column: 'id', onDelete: 'set null' } });
const children = defineTable('typed_children', { id: column.integer().primaryKey(), parentId: direct, note: column.text().default('none') });
type ChildRow = Row<typeof children>;
const row: ChildRow = { id: 1, parentId: null, note: 'x' };
const insert: InsertRow<typeof children> = { id: 1 };
const parentId: number | null = row.parentId;
const db = openDatabase(':memory:', { tables: [parents, children] });
const inserted: ChildRow = db.table(children).insert(insert);
void inserted; void parentId;
// @ts-expect-error A direct column needs every configuration flag.
new Column({ kind: 'integer' });
// @ts-expect-error Unsupported kinds are not column configurations.
new Column({ kind: 'uuid', nullable: false, primary: false, generated: false, unique: false, hasDefault: false });
// @ts-expect-error Flags are booleans, not strings.
new Column({ kind: 'integer', nullable: 'no', primary: false, generated: false, unique: false, hasDefault: false });
// @ts-expect-error Foreign-key delete actions are a closed set.
new Column({ kind: 'integer', nullable: false, primary: false, generated: false, unique: false, hasDefault: false, foreignKey: { table: parents, column: 'id', onDelete: 'drop' } });
// @ts-expect-error Default values are encoded scalars, not objects.
new Column({ kind: 'json', nullable: false, primary: false, generated: false, unique: false, hasDefault: true, defaultValue: { a: 1 } });
// @ts-expect-error Builder typing is preserved: integer defaults are numbers.
column.integer().default('1');
// @ts-expect-error A non-null typed row field rejects null.
const wrong: ChildRow = { id: 1, parentId: null, note: null };
void wrong;
db.close();
