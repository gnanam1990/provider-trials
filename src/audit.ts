import type { Ctx } from "./context.ts";
import { iso } from "./context.ts";
import type { Actor } from "./auth.ts";
import { canonicalJson } from "./lib/util.ts";

/** Append-only audit record: actor, role, decision code, entity and detail. */
export function audit(
  ctx: Ctx,
  actor: Pick<Actor, "accountId" | "subject" | "role">,
  action: string,
  decisionCode: string,
  entity?: string,
  entityId?: string,
  detail?: unknown,
): void {
  ctx.db.run(
    `INSERT INTO audit_log(account_id,actor,role,action,decision_code,entity,entity_id,detail_json,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    actor.accountId,
    actor.subject,
    actor.role,
    action,
    decisionCode,
    entity ?? null,
    entityId ?? null,
    detail === undefined ? null : canonicalJson(detail),
    iso(ctx),
  );
}
