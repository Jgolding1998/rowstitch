# Rowstitch contributor instructions

- Build an independently implemented TypeScript ORM for supported Node 24 and 26 LTS releases. Keep the SQLite core free of runtime npm dependencies; PostgreSQL and PGlite use explicitly selected, exact optional peers. Use node:sqlite with foreign keys and defensive mode enabled and extensions disabled. Do not enable WAL automatically.
- Bind query values and validate and quote identifiers. PostgreSQL DDL defaults cannot use bind parameters: use only validated, escaped, typed literals there. Never accept arbitrary SQL through the inspector or from trace files.
- Require meaningful filters for writes. Guard affected-row counts and optimistic version checks atomically. Transactions and savepoints must recover after errors. The synchronous public API rejects asynchronous callbacks; the internal async session must await callbacks, isolate connection ownership and refuse unfinished work at settlement.
- Preserve integer precision, nullability and insert-versus-read type contracts. Include actual negative TypeScript checks, not only runtime assertions.
- The studio is a read-only local inspector and fictional demo. It must not expose an arbitrary database/file/SQL API. Trace imports stay in browser memory. Treat all imported strings as untrusted text.
- Use fictional examples only. Never commit databases, captures of private schemas, credentials, machine paths, profiles, node_modules, test logs or proof folders. Keep proof outside this repository.
- Run the documented tests and actual browser flows. Benchmark fixed datasets against named, pinned versions and report failures/limitations honestly.
- Claude Code leads UI/UX. Use installed design skills and Handy as visual inspiration; make original branding and assets. Do not copy Handy's name/logo or imply affiliation.
- Cite public research and licenses. Never claim parity across unsupported databases or universal security/performance superiority.
