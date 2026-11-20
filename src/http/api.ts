import type { Ctx } from "../context.ts";
import { Router } from "../lib/router.ts";
import { requireActor, requireRole } from "../auth.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import * as accounts from "../domain/accounts.ts";
import * as providers from "../domain/providers.ts";
import * as suites from "../domain/suites.ts";

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

  r.post("/suites", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward");
    const s = suites.createSuite(ctx, a, req.body ?? {});
    return { status: 201, json: { suite: suites.suitePublicView(ctx, s) } };
  });

  r.get("/suites", (req) => {
    const a = requireActor(ctx, req);
    return {
      json: {
        suites: suites
          .listSuites(ctx, a.accountId)
          .map((s) => suites.suitePublicView(ctx, s)),
      },
    };
  });

  r.get("/suites/{id}", (req) => {
    const a = requireActor(ctx, req);
    const v = req.query.get("version");
    const s = v
      ? suites.getSuiteVersion(ctx, req.params.id, Number(v))
      : suites.getSuiteVersion(ctx, req.params.id, suites.latestVersion(ctx, req.params.id));
    if (s.account_id !== a.accountId) throw notFound("suite");
    return { json: { suite: suites.suitePublicView(ctx, s) } };
  });

  r.post("/suites/{id}/versions", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward");
    const s = suites.getSuiteVersion(ctx, req.params.id, suites.latestVersion(ctx, req.params.id));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const nv = suites.createNextVersion(ctx, a, req.params.id);
    return { status: 201, json: { suite: suites.suitePublicView(ctx, nv) } };
  });

  r.post("/suites/{id}/versions/{v}/freeze", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward");
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const out = suites.freezeVersion(ctx, a, req.params.id, Number(req.params.v));
    return { json: { suite: suites.suitePublicView(ctx, out) } };
  });

  r.post("/suites/{id}/versions/{v}/samples", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward");
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const sample = suites.addSample(ctx, a, req.params.id, Number(req.params.v), req.body ?? {});
    return {
      status: 201,
      json: {
        sample: {
          sample_id: sample.sample_id,
          content_hash: sample.content_hash,
          label_hash: sample.label_hash,
          allowed_processors: JSON.parse(sample.allowed_processors_json),
        },
      },
    };
  });

  r.post("/suites/{id}/versions/{v}/samples/{sid}/correct", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward");
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const sample = suites.correctSample(ctx, a, req.params.id, Number(req.params.v), req.params.sid, req.body ?? {});
    return {
      json: {
        sample: {
          sample_id: sample.sample_id,
          label_hash: sample.label_hash,
          allowed_processors: JSON.parse(sample.allowed_processors_json),
        },
      },
    };
  });

  // Operator surface: prove whether a provider may transport a sample.
  r.post("/suites/{id}/versions/{v}/samples/{sid}/transport", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "dataset_steward", "runner", "procurement_lead");
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const sample = suites.getSample(ctx, req.params.id, Number(req.params.v), req.params.sid);
    const providerId = (req.body ?? {}).provider_id;
    const url = suites.issueSampleUrl(ctx, s, sample, providerId);
    return { json: { url, expires_ms: ctx.config.signedUrlTtlMs } };
  });

  // Signed transport endpoint used by providers at dispatch time.
  r.get("/samples/{ref}", (req) => {
    const p = req.query.get("p") ?? "";
    const exp = Number(req.query.get("exp") ?? "0");
    const sig = req.query.get("sig") ?? "";
    const blob = suites.serveSample(ctx, req.params.ref, p, exp, sig);
    return { text: blob.body, headers: { "content-type": blob.media_type } };
  });

  return r;
}

/** The enrolled principal must be the acting subject for ownership proofs. */
function requireOwner(p: providers.ProviderRow, subject: string): void {
  if (p.owner_subject !== subject) {
    throw forbidden("not_enrolled_principal", "only the enrolled provider principal may prove ownership");
  }
}
