# Rowstitch contributor instructions

- Build a small, honest SQLite ORM for current Node 24 LTS, with no runtime npm dependencies. Use node:sqlite with foreign keys and defensive mode enabled and extensions disabled. Do not enable WAL automatically.
- Keep all SQL values bound and identifiers validated and quoted. Never accept arbitrary SQL through the inspector or from trace files.
- Require meaningful filters for writes. Guard affected-row counts and optimistic version checks atomically. Transactions and savepoints must recover after errors; reject asynchronous transaction callbacks.
- Preserve integer precision, nullability and insert-versus-read type contracts. Include actual negative TypeScript checks, not only runtime assertions.
- The studio is a read-only local inspector and fictional demo. It must not expose an arbitrary database/file/SQL API. Trace imports stay in browser memory. Treat all imported strings as untrusted text.
- Use fictional examples only. Never commit databases, captures of private schemas, credentials, machine paths, profiles, node_modules, test logs or proof folders. Keep proof outside this repository.
- Run the documented tests and actual browser flows. Benchmark fixed datasets against named, pinned versions and report failures/limitations honestly.
- Claude Code leads UI/UX. Use installed design skills and Handy as visual inspiration; make original branding and assets. Do not copy Handy's name/logo or imply affiliation.
- Cite public research and licenses. Never claim parity across unsupported databases or universal security/performance superiority.
