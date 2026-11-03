# Reproduce the SQLite comparison

This compares correctness and SELECT counts on the same fictional fixture: 40 authors with three posts each, plus one author with no posts. It checks bound input, batched relations, a limit per parent, real rollback, stale writes and a real JSON update. It does not rank speed or claim feature parity with Orange or Kysely.

The [recorded results](results.json) pass all 31 exercised cases. Rowstitch and Orange both use two SELECTs to load the 41-parent/120-child graph; limiting each parent's children to two returns 80 children in two SELECTs. The explicit Kysely and raw-SQL recipes also use two SELECTs. Query counts on this fixture demonstrate batching parity, not a speed advantage.

The shared to-one case includes an author for each of 120 posts. Rowstitch currently uses two SELECTs; Orange and the explicit Kysely/raw LEFT JOIN recipes use one. This is a current query-count tradeoff to improve, not a result to hide. Selected-name reads also document a contract difference: Rowstitch returns only `name`, while Orange retains `id` for Active Record identity. Both exclude unrelated application fields; Orange's retained key is not treated as a defect.

Build Rowstitch with the supported Node version, then run its zero-dependency comparison:

```sh
npm ci
npm run build
node benchmarks/compare.mjs
```

To compare released tools, create a separate directory **outside this repository** and install these exact versions there:

```sh
npm init -y
npm install --save-exact orange-orm@5.5.1 kysely@0.29.8 better-sqlite3@12.6.2
```

The native driver has an installation script that downloads or builds its SQLite binding. Review that dependency and run it only in a directory you trust. These reference packages are not Rowstitch dependencies and are not needed by the library or studio. Do not place their node_modules, databases or logs in a contribution.

From the Rowstitch checkout:

```sh
node benchmarks/compare.mjs --reference-dir /path/to/reference-directory --output /path/to/results.json
```

On Windows, use the corresponding quoted Windows paths. The runner checks each reference package's version and records Node, platform and both SQLite versions. It creates synthetic databases in its own temporary directory and removes that directory after closing the databases. The report contains no machine paths or real records.

Orange already batches these relations and supports optimistic concurrency. Kysely is a query builder; its comparison uses an explicit two-query grouping/window recipe and explicit version predicates. Raw SQLite also uses application-written SQL. These are valid working alternatives, not deliberately slow N+1 baselines.

Each tool gets a separate database with the same schema, rows, DELETE journal mode and FULL synchronous setting. The fixture schema is created by Rowstitch, then populated with bound raw inserts. In the recorded Windows run, Rowstitch and Orange use Node's SQLite 3.53.4; Kysely uses better-sqlite3's SQLite 3.51.2. The runner queries Orange's actual engine instead of inferring it from installed dependencies. Orange's published CommonJS source export is resolved explicitly; its SQLite backend depends on the runtime. A cross-engine timing claim would be misleading, and no timings are collected.

References: [Orange ORM](https://github.com/alfateam/orange-orm), [Kysely](https://github.com/kysely-org/kysely), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

## Literal text and ranges

The [expression comparison](expressions-results.json) uses 14 fictional rows in UTF-8, UTF-16LE and UTF-16BE SQLite databases. An independent JavaScript oracle checks literal punctuation, quotes, embedded NUL, Unicode, ASCII case handling, NULL under NOT, inclusive/reversed ranges and int64 precision.

```sh
node benchmarks/expressions.mjs --reference-dir /path/to/reference-directory --output /path/to/expressions-results.json
```

Use the same reference directory described above, containing `orange-orm@5.5.1`. Without `--reference-dir`, the Rowstitch and raw-SQL checks still run. `--entry /path/to/installed/rowstitch/dist/index.js` can select a built installed package.

The recorded comparison passes 132 cases and identifies nine LIKE/literal contract differences. Orange's SQLite helpers use LIKE patterns; percent signs, underscores, case handling and NUL behavior differ from literal matching. These are different contracts, not upstream defects. The report records generated SQL, binding order and actual SELECT counts; it makes no latency or full-parity claim. The upstream [string predicate](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/column/string/containsCore.js) and [range implementation](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/column/newColumn.js) define the pinned reference behavior. No Orange implementation is embedded in the runner.

## Column comparisons

The [column comparison](columns-results.json) checks all nine integer/bigint/real type pairs, text with declared collations, boolean equality and SQL NULL behavior. It passes 432 checks across Rowstitch, raw SQLite, Orange 5.5.1 and Kysely 0.29.8, using three database encodings. Numeric operators rotate across the nine type pairs; the text fixtures exercise all six operators and reversed operands. Numeric expectations use exact rational arithmetic for the stored binary64 and integer values, without rounding bigint to a JavaScript number.

```sh
node benchmarks/columns.mjs --reference-dir /path/to/reference-directory --output /path/to/columns-results.json
```

Without references, 216 Rowstitch/raw-SQL checks run. Native NOCASE, BINARY and RTRIM behavior remains observable, including the effect of reversing operands. Schema inspection currently does not report or certify these collations. Orange and Kysely already support column operands with broader SQL and relationship contracts; Rowstitch's narrower helpers are not evidence of a defect in either tool.

To check all eight local fixture sets without installing reference libraries:

```sh
node benchmarks/check.mjs
```

This command fails if any exercised case fails. CI runs it alongside the runtime and type tests on Linux, Windows and macOS. These are correctness checks, not a representative performance or production workload benchmark.

## Relation predicates

The [relation comparison](relations-results.json) checks `some`, `none` and `every` with empty relations, nullable values, nested child scopes, a filtered relation domain and bound text containing SQL punctuation. It runs 42 checks against Rowstitch and raw SQLite without reference packages, or 64 checks with Orange 5.5.1. The JavaScript expectations are calculated independently of the ORM queries.

```sh
node benchmarks/relations.mjs
node benchmarks/relations.mjs --reference-dir /path/to/reference-directory --output /path/to/relations-results.json
```

The optional `--entry /path/to/installed/rowstitch/dist/index.js` flag selects a built installed package. The local relation checks are also included in `node benchmarks/check.mjs`; a failed assertion makes the command fail. No reference package becomes a Rowstitch dependency.

The larger fixture has 5,000 parents and 20,000 children, with an index on `(parent_id, score)`. For the three tested predicates, Rowstitch and Orange each use one SELECT and an indexed child lookup. The reports include actual SQL and query plans. This demonstrates correct indexed queries on this fixture, without making a latency or general performance claim.

Measured contract differences remain explicit:

- Rowstitch `every` includes empty relations and treats a NULL predicate result as a failure. Orange's native `all` requires at least one matching child, and its negated test does not treat NULL as a failing child. For example, `[1, NULL]` passes Orange `all(score = 1)` and fails Rowstitch `every(score = 1)`. The shared comparison expresses strict `every` in Orange using `none(score != 1 OR score IS NULL)`, then checks native `all` separately.
- With a NOCASE parent key and BINARY foreign key, Orange's relation filter uses the parent collation and Rowstitch uses the foreign collation. Reversing those declared collations reverses the result. Both directions are measured. Rowstitch's eager loader and new relation filters agree on the foreign-column rule.

These differences are documented behavior, not upstream defects. This runner also includes an Orange count reference case; the dedicated count comparison below checks both tools. The pinned sources for these contracts are Orange's [all predicate](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/relatedTable/all.js), [relation count](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/relatedTable/count.js) and [correlation equality](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/query/singleQuery/joinSql/newShallowJoinSqlCore.js).

## Filtered relation counts

The [count comparison](counts-results.json) checks all six `countRelated` comparison operators, thresholds from zero through `Number.MAX_SAFE_INTEGER`, NULL fields, empty relations, repeated values, orphan keys, filtered domains, nested counts, self-relations and bound text. It runs 140 checks with Rowstitch and raw SQLite, or 208 checks with Orange 5.5.1. Every exercised count query uses one SELECT. Expected rows are calculated from independent JavaScript fixture data and also checked with raw SQL.

```sh
node benchmarks/counts.mjs
node benchmarks/counts.mjs --reference-dir /path/to/reference-directory --output /path/to/counts-results.json
```

Use `--entry /path/to/installed/rowstitch/dist/index.js` to check a built installed package. The local count cases also run through `node benchmarks/check.mjs`, and failures produce a nonzero exit status.

Counts use `COUNT(*)`: a related row with a NULL score still contributes to an unfiltered count. A filtered count includes only rows whose predicate is true. Empty relations count as zero, and equal values in distinct rows are counted separately. Two matching grandchildren do not double-count their parent when used inside a nested predicate. Rowstitch's singular descriptors count matching rows without asserting cardinality; that behavior is tested against raw SQL separately from Orange's typed many-relation count API.

On the 5,000-parent/20,000-child fixture, both tools use the `(parent_id, score)` covering index for the tested count queries. A count may visit the entire matching range, while `EXISTS` can stop at its first match. This benchmark records correctness and plans, not a claim that count is faster. The two text-collation comparisons retain the documented foreign-column-left versus parent-column-left difference.

This comparison covers count predicates in read filters. It does not cover count projections, distinct counts, grouping or Orange's full numeric expression API. The root aggregate comparison below covers grouped summaries separately. Sources: [Orange's pinned count API](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/relatedTable/count.js), its [implemented feature request](https://github.com/alfateam/orange-orm/issues/151), and [SQLite's aggregate contracts](https://www.sqlite.org/lang_aggfunc.html).

## Root aggregates and grouping

The [recorded aggregate comparison](aggregates-results.json) checks root COUNT, SUM, AVG, MIN and MAX; grouped results; NULL keys; global filters; related-count filters; sorting and pagination; source-column aliases; and declared text collation. It passes 59 local checks, or 81 with Orange, and records four contract differences separately. Expected numeric results are computed independently in JavaScript. Each case records the actual generated statements and requires one executed SELECT, including cases whose expected outcome is a documented error. This is a correctness fixture, not a latency comparison.

```sh
node benchmarks/aggregates.mjs --reference-dir /path/to/reference-directory --output /path/to/aggregates-results.json
```

Use the existing reference directory with `orange-orm@5.5.1`; no new package is required. Without `--reference-dir`, Rowstitch and raw SQLite checks still run. `--entry /path/to/installed/rowstitch/dist/index.js` selects another built package. The runner uses temporary fictional data, restores its native statement instrumentation, reports failures in `summary.failed`, and exits nonzero if an assertion fails. The local comparison gate includes this runner.

The shared fixtures compare working root and grouped queries in both tools. Safe numeric return representations are normalized for these comparisons, with native results preserved in the report. The separate observations are deliberately narrow:

- Empty or all-NULL SUM/AVG returns `null` in Rowstitch and raw SQLite; Orange 5.5.1 uses COALESCE and returns `0`. This is an intentional contract difference.
- On the tested Orange 5.5.1 node:sqlite aggregate path, empty numeric MIN/MAX and text MIN/MAX return `NaN`. The report records this pinned behavior without generalizing to all drivers or text APIs.
- A large bigint minimum produces `ERR_OUT_OF_RANGE` on that Orange aggregate path. The same fixture verifies that an ordinary Orange bigint read succeeds, and that AVG of the same large input succeeds approximately. This is not a claim that Orange cannot read large integers or perform bigint aggregates generally.

The pinned [aggregate SQL construction](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/column/columnAggregate.js) and [aggregate result decoding](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/groupBy.js) explain those observations. No Orange implementation is embedded in this runner.

Exact integer totals beyond int64, intermediate cancellation, and grouped sum ordering are checked against a BigInt oracle **and a working raw SQLite split-SUM recipe**. Native integer SUM raises the same engine overflow in raw SQLite and Orange on these fixtures. It is an [SQLite arithmetic limit](https://www.sqlite.org/lang_aggfunc.html), not an Orange-specific defect. Rowstitch's split partials still retain SQLite limits. For a mapped real column containing safe INTEGER values, the raw comparison also uses an explicit REAL cast, matching the approximate contract. Both tools remain subject to floating-point rounding; Rowstitch rejects a nonfinite aggregate result.

Additional Rowstitch cases check storage guards outside a requested group page and filtering invalid data out of the domain. An empty page has no guard-bearing row and makes no data-validity assertion. Related aggregate projections, HAVING, DISTINCT, per-selector filters and other database engines are outside this root-aggregate slice. None of these checks establishes overall superiority or complete Orange parity.

## Per-row related summaries

The [projected aggregate runner](projected.mjs) uses two deterministic fictional datasets, 32 parents in total and 18 query scenarios. It checks child counts, non-NULL counts, integer sums, averages, extrema, nested paths and two independent child collections. Expected results come from separately computed JavaScript arrays. Every operation must use one SELECT in each tool; query counts do not establish a speed ranking.

```sh
node benchmarks/projected.mjs
node benchmarks/projected.mjs --reference-dir /path/to/reference-directory --output /path/to/projected-results.json
```

The [recorded run](projected-results.json) has 288 Rowstitch result checks and 230 Orange comparisons with the documented return-type and empty-value normalization. Those numbers count individual parent results, not hundreds of distinct use cases. Another 58 empty-value outcomes are classified separately: the tested Orange 5.5.1 path returns NaN for missing counts or extrema and zero for empty sums/averages, whereas Rowstitch returns zero for counts and NULL for the other aggregates. The two-collection scenario explicitly normalizes NULL and zero before comparing totals. Neither tool multiplies the independent collection totals on these per-row fixtures.

Shared fixture integers stay within JavaScript's safe range. Exact large totals, malformed storage, text collation, domain filtering, shared query limits and transaction lifetimes are covered separately by Rowstitch's runtime tests. The comparison covers per-row SQLite queries only. It does not test related aggregates inside root/group summaries, other databases, timing or full Orange compatibility. Orange observations are tied to the pinned release and recorded engine versions, not every driver or release.

## Related summaries across roots and groups

The [grouped related runner](grouped-related.mjs) checks 30 query scenarios across two fictional datasets. Its independent JavaScript oracle covers root and grouped counts, totals, averages and extrema, two independent child collections alongside a root count, empty/NULL values, orphan children, and a root filter combined with a related domain. Each Rowstitch query must use one statement.

```sh
node benchmarks/grouped-related.mjs
node benchmarks/grouped-related.mjs --reference-dir /path/to/reference-directory --output /path/to/grouped-related-results.json
```

The [recorded run](grouped-related-results.json) separates these counts:

- 109 complete Rowstitch result rows match the independent oracle.
- 76 Orange result rows match the same values, after representing safe integer totals consistently.
- 10 Orange result rows need the documented NULL/zero/NaN normalization for empty numeric aggregates.
- 12 rows from the two-collection expression show joined multiplicity. On these fixtures, Orange 5.5.1 joins both collections before aggregating; its result matches a separately calculated LEFT JOIN cross-product. Rowstitch calculates each path independently. This observation describes the tested expression and fixtures, not every Orange query or driver.

These are result-row counts, not hundreds of independent use cases. `summary.passed` counts only the 109 Rowstitch oracle rows; reference matches, normalized results and observations remain separate. Unexpected values or extra statements fail the run without producing a success report. Related domain filters use the Rowstitch oracle only, since they do not reproduce the Orange API. Shared numeric inputs stay in the safe integer range; separate runtime tests cover large exact totals, text collations and malformed storage. No timing or universal superiority claim is made.
