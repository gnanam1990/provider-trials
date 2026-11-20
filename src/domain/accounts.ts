import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor, Role } from "../auth.ts";
import { ROLES } from "../auth.ts";
import { audit } from "../audit.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { newId } from "../lib/util.ts";

/**
 * Local bootstrap: creates an account and enrolls the bootstrap subject as its
 * procurement lead, who then enrolls the remaining roles. This endpoint is the
 * only unauthenticated write; it exists so a local deployment can be populated.
 */
export function createAccount(
  ctx: Ctx,
  input: { name: string; bootstrap_subject: string },
): { account_id: string } {
  if (!input.name || !input.bootstrap_subject) {
    throw badRequest("missing_fields", "name and bootstrap_subject are required");
  }
  const id = newId("acct");
  ctx.db.tx(() => {
    ctx.db.run("INSERT INTO accounts(id,name,created_at) VALUES(?,?,?)", id, input.name, iso(ctx));
    ctx.db.run(
      "INSERT INTO members(account_id,subject,role,created_at) VALUES(?,?,?,?)",
      id,
      input.bootstrap_subject,
      "procurement_lead",
      iso(ctx),
    );
  });
  audit(
    ctx,
    { accountId: id, subject: input.bootstrap_subject, role: "procurement_lead" },
    "account.create",
    "account_created",
    "account",
    id,
  );
  return { account_id: id };
}

export function addMember(
  ctx: Ctx,
  actor: Actor,
  input: { subject: string; role: Role },
): void {
  if (!input.subject || !ROLES.includes(input.role)) {
    throw badRequest("missing_fields", "subject and a valid role are required");
  }
  ctx.db.run(
    "INSERT OR IGNORE INTO members(account_id,subject,role,created_at) VALUES(?,?,?,?)",
    actor.accountId,
    input.subject,
    input.role,
    iso(ctx),
  );
  audit(ctx, actor, "account.add_member", "member_added", "account", actor.accountId, input);
}

export function listMembers(ctx: Ctx, accountId: string) {
  return ctx.db.all("SELECT subject, role FROM members WHERE account_id=? ORDER BY subject, role", accountId);
}

export function accountExists(ctx: Ctx, id: string): void {
  if (!ctx.db.get("SELECT 1 AS x FROM accounts WHERE id=?", id)) throw notFound("account");
}
