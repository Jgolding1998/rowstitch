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
