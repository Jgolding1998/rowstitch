# Live engine checks

Rowstitch 0.10 supports SQLite and optional PostgreSQL/PGlite entry points. The native public APIs cover mapped scalar CRUD, filters, relation predicates, transactions/savepoints, inspection and creation of missing mapped tables/indexes. See [native driver support and limits](../../docs/async-drivers.md). These checks exercise that subset, the lower-level transaction boundary and pinned reference tools; they do not establish full Orange ORM compatibility.

Use supported Node 24 or 26, a running **local** Docker daemon and OpenSSL on PATH. From the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm --prefix tests/integration ci --ignore-scripts
npm --prefix tests/comparison ci --ignore-scripts
node --test tests/integration/protocol.test.mjs
node tests/integration/check.mjs local
node tests/integration/public-driver.mjs local --require-native --compare
```

The internal runner downloads the official PostgreSQL 18.6 image by immutable digest. The public runner uses that same already downloaded image. Both accept only local Docker Unix sockets or Windows named pipes; TCP/SSH/remote contexts are refused before creating Docker resources. Once validated, every daemon call, including cleanup, is pinned to that endpoint with ambient host/context/TLS overrides removed. Docker command failures use constant messages rather than exposing daemon stderr.

On Windows, Git for Windows usually supplies OpenSSL in its `mingw64\bin` directory. Add that directory to the current session's PATH if `openssl version` is unavailable. A typical PowerShell setup is:

```powershell
$gitRoot = Split-Path (Split-Path (Get-Command git).Source)
$env:PATH = (Join-Path $gitRoot 'mingw64\bin') + [IO.Path]::PathSeparator + $env:PATH
openssl version
```

The comparison dependencies live in [tests/comparison](../comparison/package.json), separately from the [engine clients](package.json): Orange's optional PGlite peer differs from the version tested here. Both are private test packages with exact versions and lockfiles. Neither adds runtime dependencies to the SQLite SDK; native drivers remain optional peers. Use ordinary `npm ci --ignore-scripts`, without forced peer overrides.

## Choosing a run

- `node --test tests/integration/protocol.test.mjs` checks synthetic protocol faults without Docker.
- `node tests/integration/check.mjs local` runs the internal positional/session, mapped-root, numeric and conservative schema-policy scenarios against native PostgreSQL and embedded PGlite. Some strict-policy faults are deliberately injected into fictional fixture catalogs; these are separate from the public API's trusted-native-schema policy.
- `node tests/integration/public-driver.mjs local --require-native` runs actual public factories, scalar/filter/relation/schema/transaction cases, scripted wire controls, cancellation, and verified/mutual TLS. OpenSSL and Docker are required: skipped required checks fail the run.
- Add `--compare` to run [the public behavior comparison](public-compare.mjs) against Orange ORM 5.5.1 and Kysely 0.29.8 on the same owned PostgreSQL server. Install `tests/comparison` first. The comparison verifies installed versions and that Orange uses the supplied comparison copy of pg 8.23.1. This flag requires native PostgreSQL, fails on skipped checks and cannot be combined with `--no-docker`.
- `node tests/integration/public-driver.mjs local --no-docker` runs the available embedded/scripted checks and reports native groups as skipped. This is a local development aid, not the complete CI gate. Omitting strict flags also permits unavailable native/TLS groups to be reported as skips.

The label is optional and accepts lowercase letters, digits and hyphens. Unknown, repeated or conflicting flags are refused.

## What is observed

The public runner loads the SDK and actual optional factories from the same fresh consumer copy of the compiled build, with ordinary copies of the pinned peers. It checks call-time input capture, read-only schema planning and parent-first/idempotent creation, six scalar codecs/defaults, guarded and versioned writes, FK effects, rollback/savepoint recovery, and redacted traces. Handwritten expected IDs cover literal text matching, inclusive ranges, nullable/empty IN lists and relation `some`/`none`/`every`/`countRelated`, including vacuous `every` and NULL counterexamples.

Native PostgreSQL cases add independently observed trigger rewrite/suppression, routed partition rows, and RLS through an actual separately connected non-superuser/non-bypass LOGIN. PGlite's public factory opens fresh private memory, so those externally prepared native fixtures are PostgreSQL-only. Public ORM CRUD here uses local plaintext connections; positive verified and mutual TLS cases exercise the adapter/executor boundary. The internal catalog fixtures use dedicated superuser connections and do not replace the restricted-role public cases.

The comparison uses separate fictional schemas, equivalent native constraints and explicit UTF8/float settings. It records known differences rather than ranking tools: Orange's default `contains` exposes LIKE wildcards; Kysely needs an application recipe for an empty IN list; Rowstitch's native aggregate method is explicitly unsupported. Guard/version recipes are identified as built-in or application-authored. Reference int8 strings and Rowstitch bigints are normalized losslessly, while raw representations and signed-zero observations remain visible. No timing, AI-usage, concurrency, universal superiority or full feature-parity claim follows from this sample.

## Reports and owned resources

Reports go under the OS temporary directory. Set `ROWSTITCH_TEST_OUTPUT_DIR` to choose a parent outside the checkout, including linked paths. Run `npm run build` first: source and executed compiled hashes are recorded separately and checked for changes during the run. The public report also records public/comparison case descriptions, known differences, limits and cleanup. Generated passwords are not saved in reports; Docker can hold the temporary server password in container metadata until cleanup.

Each runner starts only newly labelled fictional fixtures on loopback-only random ports, with bounded native resources. The public server's data uses tmpfs and refuses anonymous volumes. Cleanup checks the exact ownership label before removal, then verifies no matching containers remain; comparison connections close and their random schemas drop before container cleanup. It never connects to an existing application database. Local recursive deletion is limited to the resolved ordinary directories belonging to that run, without deleting shared dependency junctions.

Normal failures retain reports. Abrupt process termination or an unavailable daemon can prevent cleanup. Each runner prints its unique resource label before Docker creation; use that label to identify an interrupted run and remove only resources bearing that exact ownership value. Cleanup after abrupt termination is not guaranteed.

Fixed scenarios are not user/app sample sizes. Scripted oversized tags and malformed messages are synthetic evidence. Hiding a COMMIT acknowledgment is deliberate fault injection, not a reproduced network failure. These suites do not verify pools, replicas, managed services, general migrations, arbitrary native schemas or every nested relation case, and do not certify security.
