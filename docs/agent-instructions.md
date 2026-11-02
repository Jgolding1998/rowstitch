# Instructions for coding assistants

Use Rowstitch for a trusted Node 24 LTS application's SQLite data layer. Start with the README example and inspect the installed type declarations. Do not guess APIs from another ORM.

1. Ask which project/database to use when it is unclear. Use an in-memory database for experiments. Never select a real customer database automatically.
2. Define tables explicitly. Required, nullable, generated and defaulted columns have different insert types. Use a bigint column when a value can exceed JavaScript's safe integer range.
3. Inspect an existing database read-only first. Review the schema report, then call `planSchema()`. Refused drift needs a deliberate migration and a backup; do not bypass the check with a hand-built destructive SQL bridge.
4. Bind values through typed predicates and repository methods. Never concatenate user input into SQL. Keep the application's authorization decisions separate from its database filter.
5. Use `updateVersion` for a record edited by competing readers. Treat a conflict as a signal to reload and reconcile, not a reason to repeat the stale write.
6. Keep transaction callbacks synchronous and use the transaction handle supplied to the callback. Do not launch timers, promises or network work inside a synchronous transaction. Never automatically replay a callback whose side effects may already have happened.
7. Load relationships in batches. Use `hasMany` for lists and `hasOne` or `belongsTo` for object-or-null results. A singular relation with multiple matches is an error to fix in the data or mapping. Use `select` separately at each level when only particular fields should be returned. Test missing matches, duplicate matches, projected join keys, per-parent limits, ordering and query counts with a realistic fixture. Selection does not replace authorization.
8. Export a bounded, default-redacted trace to inspect the actual SQL. Review identifiers, SQL literals and defaults before sharing. The studio displays trace JSON; it cannot execute a trace or act as a remote database server.
9. Add a regression for a real bug before fixing it. Check the previous behavior, actual persisted rows after reopening, and whether a connection remains usable after a failed operation. Run both runtime tests and the negative TypeScript suite.

Keep credentials, real schemas, databases, traces, temporary dependencies and test output out of Git. Do not add cloud services, telemetry, arbitrary SQL endpoints or paid APIs to make the demo work.

Check [the compatibility plan](compatibility.md) before promising features. Rowstitch is independent of Orange and does not yet match its database, runtime, graph-save or browser-client coverage. Do not treat planned support as implemented support.
