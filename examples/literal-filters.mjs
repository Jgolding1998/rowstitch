import assert from 'node:assert/strict';
import { column, defineTable, openDatabase, contains, startsWith, endsWith, between, isNull, or } from 'rowstitch';

const notes = defineTable('notes', {
  id: column.integer().primaryKey(),
  title: column.text().nullable(),
  priority: column.integer(),
});

const db = openDatabase(':memory:', { tables: [notes] });
try {
  db.ensureSchema();
  const repository = db.table(notes);
  repository.insertMany([
    { id: 1, title: '100% local notes', priority: 1 },
    { id: 2, title: 'draft: garden plan', priority: 2 },
    { id: 3, title: 'Archived note', priority: 4 },
    { id: 4, title: null, priority: 9 },
  ]);
  const ids = where => repository.findMany({ where, select: ['id'] }).map(row => row.id);

  // Search characters are literal, including percent signs and underscores.
  assert.deepEqual(ids(contains(notes.col('title'), '%')), [1]);
  assert.deepEqual(ids(startsWith(notes.col('title'), 'DRAFT:', { case: 'ascii-insensitive' })), [2]);
  assert.deepEqual(ids(endsWith(notes.col('title'), 'note')), [3]);
  assert.deepEqual(ids(between(notes.col('priority'), 2, 4)), [2, 3]);

  // NULL requires an explicit condition; it is not an empty string.
  assert.deepEqual(ids(or(isNull(notes.col('title')), contains(notes.col('title'), 'note'))), [1, 3, 4]);
  console.log('Literal text searches, inclusive ranges and explicit NULL handling passed.');
} finally {
  db.close();
}
