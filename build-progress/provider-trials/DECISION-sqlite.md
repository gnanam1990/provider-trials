# Decision record

- Date: 2026-11-20
- Owner: implementation agent (SWE-2 High)
- Module: foundation / all persistence
- Decision: use embedded SQLite via `node:sqlite` (Node >=22.18) instead of the
  PostgreSQL baseline proposed in TDD.md.
- Context: greenfield target repo; no PostgreSQL server is running on this
  machine (`pg_isready` -> no response). The build must run entirely local with
  no external services.
- Alternatives: (a) install/start local Postgres — heavier, still only a local
  stand-in; (b) pure JSON files — loses transactions, unique constraints, row
  locks. Chosen: SQLite gives real transactions, unique constraints, FK
  enforcement and a single durable file; the schema stays portable SQL.
- Compatibility: `Db.open(path)` with `:memory:` for tests; `data/provider-trials.db`
  for the running service. WAL mode + busy_timeout for writer concurrency.
- Dependency proof: `node --test test/*.test.ts` exercises real SQL.
- Conditions to reopen: production deployment or concurrent multi-process
  writers -> migrate to Postgres; schema uses no SQLite-specific syntax beyond
  INTEGER PRIMARY KEY rowid semantics (used as the report evidence cursor).
