# Live engine checks

These tests exercise the internal transaction driver against PostgreSQL 18.6 and PGlite 0.5.15. They cover the driver boundary under development; Rowstitch's public SDK still supports SQLite.

Use supported Node 24 or 26 and a running local Docker daemon:

```sh
npm ci --ignore-scripts
npm run build
npm --prefix tests/integration ci --ignore-scripts
npm --prefix tests/integration test
```

The optional test package pins its clients separately from the SQLite core, which keeps zero runtime npm dependencies. The check pulls one official image by its immutable digest, starts a new labelled server on a loopback-only random port, and uses fictional data with a password generated for that run. It refuses remote Docker endpoints and checks ownership before removing its container and network. It does not connect to an existing application database.

The result is printed with the location of a report under the OS temporary directory. Set `ROWSTITCH_TEST_OUTPUT_DIR` to choose a parent directory outside the checkout. Successful runs remove their PGlite fixture; failed runs keep it and the report for inspection. Reports record both source hashes and the compiled JavaScript hashes that ran. Run `npm run build` first.

The runner prints its unique resource label before creation. Normal failures clean up resources found by that label, including a container whose start failed. An interrupted process, unavailable Docker daemon or daemon operation that finishes after a CLI timeout can prevent complete cleanup; use the printed label to find its container and network in Docker. Remove only resources bearing that exact label. No cleanup after abrupt termination is guaranteed.

The suite checks malformed protocol responses with synthetic messages and a scripted server using the real `pg` client, then runs these separate groups on the actual engines:

- 14 PostgreSQL and 12 PGlite transaction cases: binding, int64, rollback/savepoints, failed COMMIT/RELEASE, read-only roots, serialization and terminated backends.
- 5 positional-result cases per engine: native type OIDs, duplicate field names, exact affected-row counts and transaction handles.
- 3 error-recovery cases per engine: errors after partial rows or statement completion, and implicit-commit uncertainty. The resource-error case deliberately raises a SQLSTATE; it does not simulate a real disk failure.
- 8 mapped-root cases per engine: compiled insert/key/count, independent native SQL, input capture, rollback on decoder errors and expanded JSONB, duplicate declared keys, savepoint recovery, read-only execution and an applied COMMIT with its acknowledgment deliberately hidden.

CI runs the same checks on both supported Node versions. These groups are scenarios on fixed fictional datasets, not a count of apps or users. High-bit OIDs, counts beyond Number's safe range and malformed/stale messages are scripted evidence, not observations from a real server.

Deliberately hiding a COMMIT acknowledgment tests an uncertain result; it does not reproduce TCP loss during COMMIT. PGlite does not establish network, pool or role behaviour. Its synchronous WASM execution can block the event loop, so a timer on that thread cannot enforce a wall-clock deadline. A worker boundary remains necessary before making that promise. These checks do not certify security or establish full PostgreSQL ORM support.
