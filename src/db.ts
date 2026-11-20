import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";

/** Thin wrapper over node:sqlite with versioned migrations and tx helper. */
export class Db {
  readonly inner: DatabaseSync;
  constructor(inner: DatabaseSync) {
    this.inner = inner;
  }

  static open(path: string): Db {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const inner = new DatabaseSync(path);
    inner.exec("PRAGMA journal_mode=WAL");
    inner.exec("PRAGMA foreign_keys=ON");
    inner.exec("PRAGMA busy_timeout=5000");
    migrate(inner);
    return new Db(inner);
  }

  tx<T>(fn: () => T): T {
    this.inner.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.inner.exec("COMMIT");
      return v;
    } catch (e) {
      this.inner.exec("ROLLBACK");
      throw e;
    }
  }

  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.inner.prepare(sql).get(...params) as T | undefined;
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.inner.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.inner.prepare(sql).run(...params);
  }
}

function migrate(inner: DatabaseSync): void {
  inner.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (inner.prepare("SELECT version FROM schema_migrations").all() as any[]).map(
      (r) => r.version,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    inner.exec("BEGIN");
    try {
      inner.exec(m.sql);
      inner
        .prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
        .run(m.version, m.name, new Date().toISOString());
      inner.exec("COMMIT");
    } catch (e) {
      inner.exec("ROLLBACK");
      throw e;
    }
  }
}
