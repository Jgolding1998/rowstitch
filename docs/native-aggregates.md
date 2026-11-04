# Summaries on PostgreSQL and PGlite

Native summaries are available from version 0.11.0.

The asynchronous PostgreSQL and in-memory PGlite APIs accept the same `agg`, `aggregate`, `groupBy` and per-row `aggregates` options as SQLite. Counts return numbers. Integer and bigint sums return exact bigints, including totals beyond the int64 range. Real sums and averages return approximate numbers. Empty counts are 0; other empty summaries are null.

For a runnable example, build the project, install the exact optional `@electric-sql/pglite@0.5.15` peer, then run:

```sh
node examples/native-aggregates.mjs
```

The example uses an in-memory database and fictional projects and tasks. Closing it discards the data. For a PostgreSQL server, use `openPostgresDatabase` with the same mapped tables and query options; see the [connection setup](async-drivers.md).

```js
const tasks = hasMany(taskTable, {
  localKey: projectTable.col('id'),
  foreignKey: taskTable.col('projectId'),
});

const totals = await db.table(projectTable).groupBy({
  by: ['team'],
  select: {
    projects: agg.count(),
    budget: agg.sum(projectTable.col('budget')),
    taskMinutes: agg.related(tasks, agg.sum(taskTable.col('minutes'))),
  },
});
```

Different related paths have independent domains. Multiple selectors on the same complete path and filters share one captured domain and its statistics. Selecting two different child collections does not multiply one collection's rows by the other. A trusted volatile view is therefore evaluated once for that shared domain, rather than separately for each alias. Nested selectors count matching path occurrences; a grouped average weights the matching leaf values, rather than averaging the separate parent averages. Related paths are bounded to four hops. This does not add eager loading of child objects, graph writes, HAVING, DISTINCT, windows or per-selector filters.

Group keys retain native text collation. Null keys correlate with null keys when attaching related group results. Ascending order puts null first; descending order puts null last. Integer sums are ordered before conversion to JavaScript, so adjacent large totals are not rounded into ties. A projected query applies its root page before collecting that page's related summaries.

## Invalid inputs and result limits

The generated query checks the physical type family, logical integer width, nullability and finite real values used by a summary. This includes `count(column)` and values that `min` would otherwise hide. A matching invalid path is refused as `DATA`. An unreferenced column is not asserted by `count(*)`.

Group input guards cover the filtered domain even when a damaged row belongs to a later group. A projected result checks its selected page and matching paths. An empty page has no guard row and makes no promise that hidden inputs were examined. Empty tables likewise do not establish that the mapped physical schema is correct. Use schema inspection and planning separately.

A child join key with the wrong physical type family is conservatively refused for a nonempty parent domain. Logical-width failures on an unrelated orphan do not make it a matching path. Database domains and custom types outside the closed supported families are not supported by these input guards.

Native summary results have a **16 MiB UTF-8 wire-text budget** across field names and non-null cells, including ordinary selected fields in a projected result. Exceeding it raises `RESULT_LIMIT`. Narrow the selected columns or request a smaller page. This budget is separate from the row, field, cell and existing group limits. It cannot prevent a driver from allocating its response first. Ordinary native reads currently do not have this aggregate-specific byte budget.

## Floating-point behavior and errors

Real sums use native float8 arithmetic. They are approximate, order-sensitive and uncompensated. Their signed-zero behavior can differ from SQLite. Reordering large cancelling values can change a result or cause overflow; Rowstitch does not promise exact decimal or compensated real arithmetic.

Real averages use that sum and the non-null count. This avoids the native AVG variance state's overflow on inputs such as `1e154` and `-1e154`, and handles means that round into subnormal values or signed zero. It still cannot average a sequence whose native sum overflows. The bounded native oracle corpus found results within one representable float step of the exact quotient of the computed sum and count. Double rounding near normal values and counts above 2^53 can produce that one-step difference. This is evidence for the tested helper and a documented approximation, not a proof of a correctly rounded mean of arbitrary inputs. Bigint averages require the existing explicit approximate option.

`AGGREGATE_RANGE` categorizes a confirmed numeric range error while running a generated real sum or average. It can originate in another trusted database expression in the same statement, such as a view or RLS function; the category does not identify the precise expression. Raw driver messages and SQLSTATE are not exposed. Unknown transport or commit outcomes retain their separate session behavior and are never reclassified as a known arithmetic failure.

A native arithmetic error inside a transaction leaves PostgreSQL's transaction aborted. Catching it does not heal the transaction: later SQL fails, and a commit cannot report success. Let it roll back, or use an explicit nested transaction/savepoint boundary where recovery is required. A `DATA` refusal after a successfully completed guarded SELECT does not abort the engine transaction. Neither path automatically retries an operation.

Native PostgreSQL and PGlite compute all group statistics before returning a page. An overflowing group outside that page can therefore fail the whole statement. SQLite can return the safe page because its non-finite aggregate result is refused only when decoded. A zero-length result page is not a general way to suppress native aggregation errors. Filter the input domain explicitly when excluding a group is intended.

## Reproducing the checks

The [public aggregate corpus](../tests/integration/public-aggregates.mjs) uses the actual public factories. Separate native [malformed-storage tests](../tests/integration/aggregate-guards.mjs) and [operator tests](../tests/integration/aggregate-operators.mjs) exercise generated input guards and explicitly hostile operator lookup. PGlite malformed-storage controls use a labelled inline fixture; they do not stand in for the worker factory tests.

The [pinned comparison](../tests/integration/public-aggregate-compare.mjs) runs Orange ORM 5.5.1, Kysely 0.29.8 and Rowstitch on the same disposable PostgreSQL engine. It reports representations, empty-value contracts, joined versus independent domains, null ordering and explicit application recipes separately. The fixtures do not measure speed, production reliability, concurrent snapshot equivalence or universal superiority. See the [full coverage matrix](compatibility.md) for remaining work.
