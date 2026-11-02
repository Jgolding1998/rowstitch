# Research behind Rowstitch

Reviewed 2026-11-02. The implementation is original. Research covered source, issue conversations and PR reviews, not just project descriptions. These discussions informed regression fixtures; historical reports are not presented as unfixed flaws in current releases.

## Orange ORM

Reference: [alfateam/orange-orm](https://github.com/alfateam/orange-orm/tree/52fdb48880dee4d6bfaf3dd59e5b5150c76bcca1), ISC, package 5.5.1.

Orange already provides multi-database mapping, typed relationships, batched graph reads, per-parent pagination, optimistic concurrency and graph changes. Those are established strengths. Rowstitch's first release supports a much narrower SQLite API.

- [Issue 94](https://github.com/alfateam/orange-orm/issues/94) asks about reverse-engineering a database mapping. Its discussion helped motivate a useful read-only schema report. Rowstitch's report is not a full TypeScript model generator.
- [PR 191](https://github.com/alfateam/orange-orm/pull/191) discusses JSON key ordering and change detection. The comparison must force a real persisted update and inspect affected rows, rather than merely exercise an equality shortcut.
- [Issue 104](https://github.com/alfateam/orange-orm/issues/104) discusses nullability and type behavior. Rowstitch checks required/default/generated/nullable insert types separately from returned-row types.
- [Issue 190](https://github.com/alfateam/orange-orm/issues/190) concerns unintended published demo content. Rowstitch uses an npm file allowlist and verifies the actual packed tarball, including compiled files and notices.

Orange's query events already expose emitted SQL. Rowstitch's distinction is a bounded trace with bound values redacted by default and an included local visual inspector, not an invention of query logging. The inspected Orange README explicitly excludes migrations; Rowstitch only offers conservative creation planning, not a migration-history runner.

## Other libraries

- [Drizzle issue 5782](https://github.com/drizzle-team/drizzle-orm/issues/5782) and [PR 5784](https://github.com/drizzle-team/drizzle-orm/pull/5784) discuss SQLite table rebuilds, foreign keys and accidental cascades. Review comments also caught a regression fixture that did not reach the intended migrator. Rowstitch avoids automatic rebuilds and tests that refused drift preserves actual child records.
- [Prisma issue 29933](https://github.com/prisma/orm/issues/29933) and [PR 29955](https://github.com/prisma/orm/pull/29955) informed tests for failed BEGIN/COMMIT, cleanup and subsequent independently verified persistence. Released adapter versions and a developing new architecture must not be conflated.
- [Kysely issue 729](https://github.com/kysely-org/kysely/issues/729) discusses migration locking. Rowstitch does not claim a concurrent migration runner. Kysely is also a useful SQL/query-count reference, with an explicit batched relation recipe in the comparison.
- [Drizzle's eslint plugin](https://orm.drizzle.team/docs/eslint-plugin) already offers rules requiring WHERE clauses. Rowstitch adds runtime defaults in its own API; guarded mutation is not a new technique.
- [Prisma's transaction documentation](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) already teaches optimistic concurrency. Rowstitch's version method is a small built-in API for that established approach.

The portable [comparison](../benchmarks/README.md) uses released Orange 5.5.1 and Kysely 0.29.8, with actual row checks and SELECT counts. SQLite driver versions differ, so it does not publish a universal speed ranking. Orange and Rowstitch both achieve two SELECTs on the shared 41-parent fixture.

## Runtime and design

[SQLite's change history](https://www.sqlite.org/changes.html) and [CVE notes](https://www.sqlite.org/cves.html) informed the maintained Node baseline, explicit defensive mode and the decision not to enable WAL automatically. A clean npm audit is not an audit of the embedded native engine.

[Handy](https://github.com/cjpais/Handy) inspired an approachable local tool with quiet navigation. Claude Code uses the installed Unslop design guidance. Rowstitch has its own mark, layout and product language; Handy's restricted branding is not copied. See [credits](../THIRD_PARTY_NOTICES.md).
