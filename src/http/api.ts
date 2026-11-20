import type { Ctx } from "../context.ts";
import { Router } from "../lib/router.ts";
import type { Req } from "../lib/router.ts";
import { requireActor, requireRole } from "../auth.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import * as accounts from "../domain/accounts.ts";
import * as providers from "../domain/providers.ts";

export function buildApi(ctx: Ctx): Router {
  const r = new Router();

  r.get("/health", () => ({ json: { ok: true, service: "provider-trials" } }));

  r.post("/accounts", async (req) => {
    const out = accounts.createAccount(ctx, req.body ?? {});
    return { status: 201, json: out };
  });

  r.get("/accounts/{id}/members", (req) => {
    const a = requireActor(ctx, req);
    if (a.accountId !== req.params.id) throw notFound("account");
    return { json: { members: accounts.listMembers(ctx, a.accountId) } };
  });

  r.post("/accounts/{id}/members", (req) => {
    const a = requireActor(ctx, req);
    if (a.accountId !== req.params.id) throw notFound("account");
    requireRole(a, "procurement_lead");
    accounts.addMember(ctx, a, req.body ?? {});
    return { status: 201, json: { ok: true } };
  });

  r.post("/providers", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "provider_operator");
    const p = providers.registerProvider(ctx, a, req.body ?? {});
    return { status: 201, json: { provider: providers.publicProviderView(ctx, p) } };
  });

  r.get("/providers", (req) => {
    const a = requireActor(ctx, req);
    return {
      json: {
        providers: providers.listProviders(ctx, a.accountId).map((p) =>
          providers.publicProviderView(ctx, p),
        ),
      },
    };
  });

  r.get("/providers/{id}", (req) => {
    const a = requireActor(ctx, req);
    const p = providers.getProvider(ctx, req.params.id);
    if (p.account_id !== a.accountId) throw notFound("provider");
    return { json: { provider: providers.publicProviderView(ctx, p) } };
  });

  r.post("/providers/{id}/challenges", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "provider_operator");
    const p = providers.getProvider(ctx, req.params.id);
    if (p.account_id !== a.accountId) throw notFound("provider");
    requireOwner(p, a.subject);
    const ch = providers.createChallenge(ctx, a, p.id);
    return { status: 201, json: { challenge: ch } };
  });

  r.post("/providers/{id}/bindings", async (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "provider_operator");
    const p = providers.getProvider(ctx, req.params.id);
    if (p.account_id !== a.accountId) throw notFound("provider");
    requireOwner(p, a.subject);
    const out = await providers.submitBinding(ctx, a, p.id, req.body ?? {});
    return { status: 201, json: out };
  });

  return r;
}

/** The enrolled principal must be the acting subject for ownership proofs. */
function requireOwner(p: providers.ProviderRow, subject: string): void {
  if (p.owner_subject !== subject) {
    throw forbidden("not_enrolled_principal", "only the enrolled provider principal may prove ownership");
  }
}
