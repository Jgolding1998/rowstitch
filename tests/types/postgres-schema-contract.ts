import { inspectPostgresSchemaWork, inspectPostgresSchemaDetailsWork, type PostgresSchemaDetails } from '../../src/core/postgres-schema.js';
import type { Rows, SchemaTable, Work } from '../../src/core/repository-core.js';

const work: Work<SchemaTable[]> = inspectPostgresSchemaWork('sample');
const privateWork: Work<PostgresSchemaDetails> = inspectPostgresSchemaDetailsWork('sample');
void privateWork;
const first = work.next();
if (!first.done) {
  const input: unknown = {};
  const rows: Rows | undefined = first.value.decode?.(input);
  void rows;
}

// @ts-expect-error A namespace is a validated string, not an arbitrary object or numeric id.
inspectPostgresSchemaWork(1);
// @ts-expect-error No raw SQL or user decoder option is accepted.
inspectPostgresSchemaWork('sample', {sql: 'SELECT * FROM hidden'});
// @ts-expect-error Inspection describes work; an owning database must drive it before tables are available.
const tables: SchemaTable[] = inspectPostgresSchemaWork();
// @ts-expect-error The work generator is not a Promise that silently owns an external connection.
inspectPostgresSchemaWork().then(() => {});
declare const table: SchemaTable;
// @ts-expect-error Primary-key order is an ordinal number, not text from an unparsed driver.
const order: string = table.columns[0]!.primaryKeyOrder;
// @ts-expect-error A default may be absent; it is not an always-present SQL string.
const expression: string = table.columns[0]!.default;
declare const details: PostgresSchemaDetails;
// @ts-expect-error Private details preserve a typed native identity policy, not a guessed boolean.
const identity: boolean = details.tables[0]!.columns[0]!.identity;
// @ts-expect-error Fact arrays are immutable snapshots, not caller-editable planner input.
details.tables.push(details.tables[0]!);
// @ts-expect-error Composite foreign-key grouping is an immutable fact, not a mutable planner hint.
details.tables[0]!.foreignKeys[0]!.columns.push('changed');
// @ts-expect-error Index activity is an immutable native fact, not a caller-set validation flag.
details.tables[0]!.indexes[0]!.valid = true;
void [tables, order, expression, identity];
