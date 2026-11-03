# Research and design credits

Rowstitch is independently implemented MIT-licensed source. No Orange, Handy, Prisma, Drizzle or Kysely implementation, logo or product asset is included.

- [Orange ORM](https://github.com/alfateam/orange-orm), ISC: reference for typed relational mapping and the reviewed discussions linked in the research notes.
- [Kysely](https://github.com/kysely-org/kysely), MIT; [Drizzle](https://github.com/drizzle-team/drizzle-orm) and [Prisma/ORM](https://github.com/prisma/orm), Apache-2.0: research and optional comparison references. Installing comparison tools does not make them Rowstitch runtime dependencies.
- [Handy](https://github.com/cjpais/Handy): visual inspiration for quiet navigation and an approachable local tool. Handy's name, logo and brand assets are not reused, and no affiliation is implied.
- [Unslop](https://github.com/heydamir/unslop), by Damir Sokolovsky, CC BY 4.0: installed design guidance used by Claude Code. This is attribution for the design workflow, not a claim that its skill files are shipped here.
- [node-postgres](https://github.com/brianc/node-postgres), MIT, and [PGlite](https://github.com/electric-sql/pglite), Apache-2.0: separately pinned optional test clients for the internal PostgreSQL transaction boundary. Their implementations are not bundled in Rowstitch or added to its runtime dependencies.

Node's built-in SQLite module carries Node and SQLite's own licensing and maintenance responsibilities. Development dependencies retain their respective licenses.
