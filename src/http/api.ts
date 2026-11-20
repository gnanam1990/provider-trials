import type { Ctx } from "../context.ts";
import { Router } from "../lib/router.ts";
import { requireActor, requireRole } from "../auth.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import * as accounts from "../domain/accounts.ts";
import * as providers from "../domain/providers.ts";
import * as suites from "../domain/suites.ts";
import * as trials from "../domain/trials.ts";
import * as execution from "../domain/execution.ts";
import * as reports from "../domain/reports.ts";
import { runIdempotent } from "../idempotency.ts";

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

  r.post("/trials", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "procurement_lead");
    const key = headerOf(req, "idempotency-key");
    const body = { ...(req.body ?? {}), idempotency_key: key };
    const { value, replayed } = runIdempotent(ctx, a, key, body, () => {
      const t = trials.createTrial(ctx, a, body);
      return { ref: t.id, value: { trial: publicTrial(t) } };
    });
    return { status: replayed ? 200 : 201, json: value };
  });

  r.get("/trials", (req) => {
    const a = requireActor(ctx, req);
    const rows = ctx.db.all("SELECT * FROM trials WHERE account_id=? ORDER BY created_at", a.accountId);
    return { json: { trials: rows.map(publicTrial) } };
  });

  r.get("/trials/{id}", (req) => {
    const a = requireActor(ctx, req);
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    return { json: { trial: publicTrial(t) } };
  });

  r.post("/trials/{id}/run", async (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "runner");
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    const key = headerOf(req, "idempotency-key");
    const { value, replayed } = runIdempotent(ctx, a, key, { trial_id: t.id }, () => ({
      ref: t.id,
      value: { pending: true },
    }));
    if (replayed) return { json: { ...trialRunState(ctx, t.id), replayed: true } };
    const out = await trials.runTrial(ctx, a, t.id);
    // Store the real result under the idempotency key so replays match.
    if (key) {
      ctx.db.run("UPDATE idempotency_keys SET response_json=? WHERE key=? AND account_id=?",
        JSON.stringify(trialRunState(ctx, t.id)), key, a.accountId);
    }
    return { json: { ...out, ...trialRunState(ctx, t.id) } };
  });

  r.get("/trials/{id}/coverage", (req) => {
    const a = requireActor(ctx, req);
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    return { json: { coverage: trials.trialCoverage(ctx, t.id) } };
  });

  r.post("/trials/{id}/reconcile", async (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "runner");
    const out = await execution.reconcileTrial(ctx, a, req.params.id);
    return { json: out };
  });

  r.post("/trials/{id}/cells/{provider}/{sample}/retry", async (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "runner");
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    const outcome = await execution.retryCell(ctx, a, t.id, req.params.provider, req.params.sample);
    return { json: { outcome } };
  });

  // Worker surface: drain the durable dispatch queue (bounded concurrency).
  r.post("/internal/drain", async (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "runner");
    const out = await execution.drainOutbox(ctx);
    return { json: out };
  });

  r.post("/trials/{id}/reports", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "analyst", "procurement_lead");
    const rep = reports.issueReport(ctx, a, req.params.id);
    return { status: 201, json: { report: rep } };
  });

  r.get("/trials/{id}/reports", (req) => {
    const a = requireActor(ctx, req);
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    return { json: { reports: reports.listReports(ctx, t.id) } };
  });

  r.get("/reports/{id}", (req) => {
    const a = requireActor(ctx, req);
    const rep = reports.getReport(ctx, req.params.id);
    const t = trials.getTrial(ctx, rep.trial_id);
    if (t.account_id !== a.accountId) throw notFound("report");
    return { json: { report: rep } };
  });

  r.get("/reports/{id}/fields", (req) => {
    const a = requireActor(ctx, req);
    const rep = reports.getReport(ctx, req.params.id);
    const t = trials.getTrial(ctx, rep.trial_id);
    if (t.account_id !== a.accountId) throw notFound("report");
    const providerId = req.query.get("provider_id") ?? "";
    return { json: reports.reportFieldEvidence(ctx, rep, providerId) };
  });

  r.post("/reports/{id}/rebuild", (req) => {
    const a = requireActor(ctx, req);
    requireRole(a, "analyst", "procurement_lead");
    const rep = reports.getReport(ctx, req.params.id);
    const t = trials.getTrial(ctx, rep.trial_id);
    if (t.account_id !== a.accountId) throw notFound("report");
    return { json: reports.rebuildReport(ctx, rep.id) };
  });

  return r;
}

function headerOf(req: import("../lib/router.ts").Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function publicTrial(t: any) {
  return {
    id: t.id,
    suite_id: t.suite_id,
    suite_version: t.suite_version,
    manifest_hash: t.manifest_hash,
    state: t.state,
    budget_minor: t.budget_minor,
    per_provider_cap_minor: t.per_provider_cap_minor,
    asset: t.asset,
    providers: JSON.parse(t.providers_json),
    exclusions: JSON.parse(t.exclusions_json),
    ranking_min_observations: t.ranking_min_observations,
    small_sample_threshold: t.small_sample_threshold,
    created_by: t.created_by,
    created_at: t.created_at,
    started_at: t.started_at,
    finished_at: t.finished_at,
  };
}

function trialRunState(ctx: Ctx, trialId: string) {
  const cov = trials.trialCoverage(ctx, trialId);
  return { state: cov.state, providers: cov.providers };
}

/** The enrolled principal must be the acting subject for ownership proofs. */
function requireOwner(p: providers.ProviderRow, subject: string): void {
  if (p.owner_subject !== subject) {
    throw forbidden("not_enrolled_principal", "only the enrolled provider principal may prove ownership");
  }
}
