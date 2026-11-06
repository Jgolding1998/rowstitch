/** Mapping-to-plan translation; no SQL construction or driver operations. */
import { isTable, type AnyTable, type Columns } from './schema.js';
import { fail } from './errors.js';
import { queryModel, tableModel, type CapturedTableModel, type CreateTableModel } from './query-model.js';

const mappedTables = new WeakMap<AnyTable, CapturedTableModel>();
export function mappedTableModel(table: AnyTable): CapturedTableModel {
  if (!isTable(table)) fail('SCHEMA', 'A query model requires a genuine mapped table.');
  let model = mappedTables.get(table);
  if (!model) {
    const columns = Object.entries(table.columns as Columns);
    model = tableModel({ name: table.name, storage: table.storage, columns: columns.map(([name]) => name),
      kinds: Object.fromEntries(columns.map(([name, column]) => [name, column.config.kind])),
      nullable: Object.fromEntries(columns.map(([name, column]) => [name, column.config.nullable])),
      primaryKey: columns.filter(([, column]) => column.config.primary).map(([name]) => name),
      ...(table.version === undefined ? {} : { version: table.version }) });
    mappedTables.set(table, model);
  }
  return model;
}
export function mappedCreateTableModel(table: AnyTable): CreateTableModel {
  return queryModel.createTable({ table: mappedTableModel(table), definitions: Object.entries(table.columns as Columns).map(([name, column]) => {
    const c = column.config, fk = c.foreignKey;
    return { name, kind: c.kind, nullable: c.nullable, primary: c.primary, generated: c.generated, unique: c.unique, hasDefault: c.hasDefault,
      ...(c.hasDefault ? { defaultValue: c.defaultValue! } : {}),
      ...(fk ? { foreignKey: { target: { table: fk.table.storage.table, column: fk.table.storage.columns[fk.column],
        ...(fk.table.storage.schema === undefined ? {} : { schema: fk.table.storage.schema }) }, onDelete: fk.onDelete } } : {}) };
  }) });
}
