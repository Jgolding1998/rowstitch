import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, ltColumns, eqColumns } from 'rowstitch';

const supplies = defineTable('supplies', {
  id: column.integer().primaryKey(),
  label: column.text(),
  available: column.integer(),
  needed: column.integer(),
  reorder: column.boolean().default(false),
});
const db = openDatabase(':memory:', { tables: [supplies] });
try {
  db.ensureSchema();
  const repository = db.table(supplies);
  repository.insertMany([
    { id: 1, label: 'Seed packets', available: 3, needed: 8 },
    { id: 2, label: 'Plant pots', available: 12, needed: 6 },
    { id: 3, label: 'Garden labels', available: 10, needed: 10 },
  ]);
  const shortage = ltColumns(supplies.col('available'), supplies.col('needed'));
  assert.deepEqual(repository.findMany({ where: shortage, select: ['label'] }), [{ label: 'Seed packets' }]);

  // The database compares its own columns; no row values need to be fetched first.
  const changed = repository.update({ reorder: true }, { where: shortage, maxRows: 1 });
  assert.deepEqual(changed.map(row => row.id), [1]);
  assert.equal(repository.count(eqColumns(supplies.col('available'), supplies.col('needed'))), 1);
  assert.deepEqual(repository.findMany({ select: ['reorder'] }).map(row => row.reorder), [true, false, false]);
  console.log('Column comparisons selected and updated only the supply shortage.');
} finally {
  db.close();
}
