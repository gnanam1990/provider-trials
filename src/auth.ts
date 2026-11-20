import type { Ctx } from "./context.ts";
import type { Req } from "./lib/router.ts";
import { forbidden, unauthorized } from "./lib/errors.ts";
import { hmacSign } from "./lib/util.ts";

export type Role =
  | "procurement_lead"
  | "dataset_steward"
  | "provider_operator"
  | "runner"
  | "analyst";

export const ROLES: Role[] = [
  "procurement_lead",
  "dataset_steward",
  "provider_operator",
  "runner",
  "analyst",
];

export interface Actor {
  accountId: string;
  subject: string;
  role: Role;
}

/**
 * Identity comes from x-pt-account / x-pt-subject / x-pt-role headers, or from
 * the signed console session cookie. Membership is always verified against the
 * members table — role claims in headers alone are never trusted.
 */
export function resolveActor(ctx: Ctx, req: Req): Actor | null {
  let accountId = header(req, "x-pt-account");
  let subject = header(req, "x-pt-subject");
  let role = header(req, "x-pt-role");
  if (!accountId || !subject || !role) {
    const session = readSession(ctx, req);
    if (session) ({ accountId, subject, role } = session);
  }
  if (!accountId || !subject || !role) return null;
  if (!ROLES.includes(role as Role)) return null;
  const m = ctx.db.get(
    "SELECT 1 AS ok FROM members WHERE account_id=? AND subject=? AND role=?",
    accountId,
    subject,
    role,
  );
  if (!m) return null;
  return { accountId, subject, role: role as Role };
}

export function requireActor(ctx: Ctx, req: Req): Actor {
  const a = resolveActor(ctx, req);
  if (!a) throw unauthorized();
  return a;
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden("role_denied", `role ${actor.role} cannot perform this action`, {
      required: roles,
    });
  }
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const SESSION_COOKIE = "pt_session";

export function makeSessionCookie(ctx: Ctx, a: Actor): string {
  const payload = Buffer.from(
    JSON.stringify({ accountId: a.accountId, subject: a.subject, role: a.role }),
  ).toString("base64url");
  const sig = hmacSign(ctx.config.hmacSecret, payload);
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`;
}

function readSession(ctx: Ctx, req: Req): Actor | null {
  const cookie = header(req, "cookie") ?? "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig || hmacSign(ctx.config.hmacSecret, payload) !== sig) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return { accountId: v.accountId, subject: v.subject, role: v.role };
  } catch {
    return null;
  }
}
