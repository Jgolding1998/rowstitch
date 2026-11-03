# Research behind Rowstitch

Reviewed 2026-11-02. The implementation is original. Research covered source, issue conversations and PR reviews, not just project descriptions. These discussions informed regression fixtures; historical reports are not presented as unfixed flaws in current releases.

## Orange ORM

Reference: [alfateam/orange-orm](https://github.com/alfateam/orange-orm/tree/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1), ISC, package 5.5.1.

Orange already provides multi-database mapping, typed relationships, batched graph reads, per-parent pagination, optimistic concurrency and graph changes. Those are established strengths. Rowstitch's first release supports a much narrower SQLite API.

- [Issue 94](https://github.com/alfateam/orange-orm/issues/94) asks about reverse-engineering a database mapping. Its discussion helped motivate a useful read-only schema report. Rowstitch's report is not a full TypeScript model generator.
- [PR 191](https://github.com/alfateam/orange-orm/pull/191) discusses JSON key ordering and change detection. The comparison must force a real persisted update and inspect affected rows, rather than merely exercise an equality shortcut.
- [Issue 104](https://github.com/alfateam/orange-orm/issues/104) discusses nullability and type behavior. Rowstitch checks required/default/generated/nullable insert types separately from returned-row types.
- [Issue 190](https://github.com/alfateam/orange-orm/issues/190) concerns unintended published demo content. Rowstitch uses an npm file allowlist and verifies the actual packed tarball, including compiled files and notices.
- [Issue 150](https://github.com/alfateam/orange-orm/issues/150) is closed; Orange's released column-to-column filters already cover same-table and relationship operands. Rowstitch's first six column helpers cover distinct columns on one mapped table. Relationship operands remain a compatibility gap.

Orange's query events already expose emitted SQL. Rowstitch's distinction is a bounded trace with bound values redacted by default and an included local visual inspector, not an invention of query logging. The inspected Orange README explicitly excludes migrations; Rowstitch only offers conservative creation planning, not a migration-history runner.

## Other libraries

- [Drizzle issue 5782](https://github.com/drizzle-team/drizzle-orm/issues/5782) and [PR 5784](https://github.com/drizzle-team/drizzle-orm/pull/5784) discuss SQLite table rebuilds, foreign keys and accidental cascades. Review comments also caught a regression fixture that did not reach the intended migrator. Rowstitch avoids automatic rebuilds and tests that refused drift preserves actual child records.
- [Prisma issue 29933](https://github.com/prisma/orm/issues/29933) and [PR 29955](https://github.com/prisma/orm/pull/29955) informed tests for failed BEGIN/COMMIT, cleanup and subsequent independently verified persistence. Released adapter versions and a developing new architecture must not be conflated.
- [Kysely issue 729](https://github.com/kysely-org/kysely/issues/729) discusses migration locking. Rowstitch does not claim a concurrent migration runner. Kysely is also a useful SQL/query-count reference, with an explicit batched relation recipe in the comparison.
- [Drizzle's eslint plugin](https://orm.drizzle.team/docs/eslint-plugin) already offers rules requiring WHERE clauses. Rowstitch adds runtime defaults in its own API; guarded mutation is not a new technique.
- [Prisma's transaction documentation](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) already teaches optimistic concurrency. Rowstitch's version method is a small built-in API for that established approach.

The portable [comparison](../benchmarks/README.md) uses released Orange 5.5.1 and Kysely 0.29.8, with actual row checks and SELECT counts. SQLite driver versions differ, so it does not publish a universal speed ranking. Orange and Rowstitch both achieve two SELECTs on the shared 41-parent fixture.

The [expression comparison](../benchmarks/expressions-results.json) separately checks literal text searches and ranges against independent expected rows, raw SQLite and Orange's SQLite helpers. It exercises actual UTF-8 and UTF-16 databases. Literal searches intentionally differ from LIKE patterns; those differences are recorded rather than described as Orange defects. SQLite's [function contracts](https://www.sqlite.org/lang_corefunc.html) and [expression rules](https://www.sqlite.org/lang_expr.html) informed the NULL, case, encoding and embedded-NUL probes. The implementation does not change the connection's LIKE settings or claim locale-aware Unicode matching.

The [column comparison](../benchmarks/columns-results.json) exercises native numeric comparisons without converting bigint to Number, SQL NULL under NOT, boolean equality, and declared text collations in three database encodings. [SQLite's collation rules](https://www.sqlite.org/datatype3.html#collating_sequences) explain why reversing two text operands can change a result. Rowstitch preserves that behavior; its current schema report does not identify or compare declared collations. Orange's released column operands and [Kysely's whereRef](https://kysely-org.github.io/kysely-apidoc/interfaces/SelectQueryBuilder.html#whereRef) are working reference implementations, not features Rowstitch originated.

The shared singular-relation read still costs Rowstitch two SELECTs versus one for Orange and the explicit Kysely/raw-SQL joins. Orange's closed [issue 177](https://github.com/alfateam/orange-orm/issues/177) and [issue 206](https://github.com/alfateam/orange-orm/issues/206) inform future tests for missing related rows and per-parent pagination. The pinned release passes the exercised cases; these reports are not presented as current upstream failures.

A later review found a Rowstitch-specific relationship bug: SQLite could match a text key under `NOCASE` or `RTRIM`, while JavaScript grouping discarded the result because the original strings differed. Text relationships now carry SQL-generated parent ordinals through decoding. Regression tests compare native SQL results across all three database encodings, including equivalent parent keys, batched pagination and row limits. This fix preserves SQLite's comparison contract; it does not add schema-collation introspection.

The [relation comparison](../benchmarks/relations-results.json) checks `some`, `none` and `every` against independent expectations, raw SQLite and equivalent Orange predicates. It records the native Orange `all` contract separately: [its pinned implementation](https://github.com/alfateam/orange-orm/blob/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1/src/table/relatedTable/all.js) excludes empty sets and permits a matching row alongside a NULL result. Rowstitch's vacuous `every` requires every considered row to evaluate to true. Two differing-collation fixtures expose another deliberate difference: Rowstitch uses foreign-column collation consistently with its eager loader, while Orange's filter uses the parent column. These are explicit contracts, not a ranking of correctness.

Orange's closed [issue 76](https://github.com/alfateam/orange-orm/issues/76) informed repeated-table alias and same-child correlation tests. Its merged [PR 107](https://github.com/alfateam/orange-orm/pull/107) demonstrates why composite joins need all key components; Rowstitch's new filters still support single-column keys only. Its closed [issue 151](https://github.com/alfateam/orange-orm/issues/151) identifies filtered relation counts as a separate useful capability still to implement here. These historical reports are not current Orange defects. The comparison also exercises 5,000 parents and 20,000 children: both tools use one SELECT and indexed child lookups on that fixed dataset, without a timing or general performance claim.

## Runtime and design

[SQLite's change history](https://www.sqlite.org/changes.html) and [CVE notes](https://www.sqlite.org/cves.html) informed the maintained Node baseline, explicit defensive mode and the decision not to enable WAL automatically. A clean npm audit is not an audit of the embedded native engine.

The [Node 26.13.0 LTS release](https://nodejs.org/en/blog/release/v26.13.0) adds a second supported runtime line alongside Node 24.22.2. The tested Windows binaries report SQLite 3.54.0 and 3.53.4 respectively. CI exercises both Node lines on Linux, Windows and macOS, with browser checks for both. Supporting a new major requires actual behavior tests; a permissive version check alone is insufficient.

[Handy](https://github.com/cjpais/Handy) inspired an approachable local tool with quiet navigation. Claude Code uses the installed Unslop design guidance. Rowstitch has its own mark, layout and product language; Handy's restricted branding is not copied. See [credits](../THIRD_PARTY_NOTICES.md).
