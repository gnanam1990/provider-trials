import type { Ctx } from "./context.ts";
import { iso } from "./context.ts";
import type { Actor } from "./auth.ts";
import { conflict } from "./lib/errors.ts";
import { canonicalJson, sha256hex } from "./lib/util.ts";

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

/**
 * Durable idempotency for commands that trigger work or payment.
 * Same key + same payload  -> returns the stored operation reference.
 * Same key + different payload -> 409 idempotency_conflict.
 */
export function runIdempotent<T>(
  ctx: Ctx,
  actor: Actor,
  key: string | undefined,
  payload: unknown,
  fn: () => { ref: string; value: T },
): IdempotentResult<T> {
  if (!key) {
    return { value: fn().value, replayed: false };
  }
  const digest = sha256hex(canonicalJson(payload ?? null));
  const existing = ctx.db.get(
    "SELECT * FROM idempotency_keys WHERE key=? AND account_id=?",
    key,
    actor.accountId,
  );
  if (existing) {
    if (existing.actor !== actor.subject) {
      throw conflict("idempotency_conflict", "idempotency key was created by a different actor");
    }
    if (existing.payload_digest !== digest) {
      throw conflict("idempotency_conflict", "idempotency key replayed with a different payload", {
        operation_ref: existing.operation_ref,
      });
    }
    return { value: JSON.parse(existing.response_json) as T, replayed: true };
  }
  // Insert the key first so a concurrent retry sees the record.
  const out = fn();
  ctx.db.run(
    `INSERT INTO idempotency_keys(key,account_id,actor,payload_digest,operation_ref,status,response_json,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    key,
    actor.accountId,
    actor.subject,
    digest,
    out.ref,
    "completed",
    JSON.stringify(out.value),
    iso(ctx),
  );
  return { value: out.value, replayed: false };
}
