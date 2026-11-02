# Security and trust boundary

Rowstitch is new software. Report a reproducible issue with the affected version and a fictional fixture. Do not post private databases, credentials or customer traces in a public issue.

## Library

SQL values are bound parameters. Model identifiers are validated and quoted; arbitrary raw SQL is not part of the public API. Missing or provably unrestricted write predicates are rejected. Affected-row checks and version checks run within the mutation transaction. Row limits refer to directly matched rows, not every change a trusted database trigger or foreign-key cascade can perform.

Foreign keys and SQLite defensive mode are enabled; extension loading is disabled. WAL is not enabled automatically. Keep the supported Node runtime updated: npm audits do not assess every vulnerability in its embedded SQLite engine. Release checks record the Node and SQLite versions separately.

Model definitions, application code, the chosen database path and existing schema are trusted inputs. This library is not a sandbox for hostile JavaScript, a substitute for application authorization or a promise that every existing database file is safe. A read-only schema report can still reveal names, constraints and default values.

Transaction callbacks must be synchronous. Nested transactions use savepoints. Failed work is rolled back, callbacks are not automatically replayed, and an unrecoverable connection must not accept more writes. A successful database commit does not guarantee an HTTP client received its response; application code still needs a retry/idempotency policy.

Schema creation does not authorize a destructive migration. Unsupported schema changes are refused. Existing triggers, cascades, collations and application invariants need independent review before adopting a model. The schema report is not a complete recreation script.

## Inspector

The studio binds only to `127.0.0.1`, serves a fixed asset allowlist and a fictional demo, and has no SQL, database-path, upload or mutation endpoint. It checks Host/Origin and request framing, applies response policies and bounds connections, headers and output. Do not expose it with a public tunnel or reverse proxy.

Trace imports are parsed and displayed in browser memory. Imported SQL is never executed. No browser storage, remote scripts, external fonts, analytics or AI provider is used. Initial installation still downloads development packages; a hosted static copy can have hosting access logs.

Traces are bounded and hide bound values by default. They do not retain result rows or raw database errors. SQL text, identifiers and literal defaults may still contain sensitive information. Explicit exports preserve the trace you loaded; review them before sharing. Clear removes the current view and file reference, not operating-system or browser memory caches.

These protections address tested cases. They are not a universal security certification or a guarantee of forensic erasure.
