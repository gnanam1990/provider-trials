import { Db } from "./db.ts";
import { defaultConfig, makeCtx } from "./context.ts";
import { drainOutbox } from "./domain/execution.ts";

// Supervised background worker: drains durable dispatch outbox rows.
// Deployed with separate credentials from the web process (TDD).
const db = Db.open(process.env.PT_DB ?? "data/provider-trials.db");
const ctx = makeCtx(db, defaultConfig());
const intervalMs = Number(process.env.PT_WORKER_INTERVAL_MS ?? 500);

const timer = setInterval(async () => {
  try {
    await drainOutbox(ctx);
  } catch (e) {
    console.error("worker drain error", e);
  }
}, intervalMs);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
console.log(`provider-trials worker draining every ${intervalMs}ms`);
