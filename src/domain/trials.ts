import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor } from "../auth.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/util.ts";
import { HttpOcrAdapter } from "../adapters/ocr.ts";
import type { OcrAdapter } from "../adapters/ocr.ts";
import { activeBinding, getProvider, sweepExpiredBindings } from "./providers.ts";
import { getSample, getSuiteVersion, processorAllowed } from "./suites.ts";

export function getTrial(ctx: Ctx, id: string): any {
  const t = ctx.db.get<any>("SELECT * FROM trials WHERE id=?", id);
  if (!t) throw notFound("trial");
  return t;
}

export function createTrial(
  ctx: Ctx,
  actor: Actor,
  input: {
    suite_id: string;
    suite_version?: number;
    provider_ids: string[];
    budget_minor: number;
    per_provider_cap_minor: number;
    asset: string;
    ranking_min_observations?: number;
    small_sample_threshold?: number;
    dispatch_timeout_ms?: number;
    idempotency_key?: string;
    recurring?: unknown;
  },
): any {
  const version = input.suite_version ?? undefined;
  const suite = getSuiteVersion(
    ctx,
    input.suite_id,
    version ?? ctx.db.get<any>("SELECT MAX(version) v FROM suites WHERE id=?", input.suite_id).v,
  );
  if (suite.account_id !== actor.accountId) throw notFound("suite");
  if (suite.state !== "frozen") {
    throw conflict("suite_not_frozen", "trials require a frozen suite version");
  }
  if (!input.provider_ids?.length) throw badRequest("missing_fields", "provider_ids is required");
  if (!(input.budget_minor > 0) || !(input.per_provider_cap_minor > 0)) {
    throw badRequest("invalid_budget", "budget_minor and per_provider_cap_minor must be positive");
  }
  if (!input.asset) throw badRequest("missing_fields", "asset is required");
  for (const pid of input.provider_ids) {
    const p = getProvider(ctx, pid);
    if (p.account_id !== actor.accountId) throw notFound(`provider ${pid}`);
  }
  const id = newId("trial");
  ctx.db.run(
    `INSERT INTO trials(id,account_id,suite_id,suite_version,manifest_hash,budget_minor,per_provider_cap_minor,
       asset,state,providers_json,recurring_json,ranking_min_observations,small_sample_threshold,
       dispatch_timeout_ms,idempotency_key,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,'planned',?,?,?,?,?,?,?,?)`,
    id,
    actor.accountId,
    suite.id,
    suite.version,
    suite.manifest_hash,
    input.budget_minor,
    input.per_provider_cap_minor,
    input.asset,
    JSON.stringify(input.provider_ids),
    input.recurring ? JSON.stringify(input.recurring) : null,
    input.ranking_min_observations ?? 20,
    input.small_sample_threshold ?? 20,
    input.dispatch_timeout_ms ?? ctx.config.dispatchTimeoutMs,
    input.idempotency_key ?? null,
    actor.subject,
    iso(ctx),
  );
  audit(ctx, actor, "trial.create", "trial_created", "trial", id, {
    suite: `${suite.id}@${suite.version}`,
    providers: input.provider_ids,
    budget_minor: input.budget_minor,
    per_provider_cap_minor: input.per_provider_cap_minor,
    asset: input.asset,
  });
  return getTrial(ctx, id);
}

/**
 * Expand the provider-by-sample matrix, reserve budgeted spend and enqueue
 * dispatch work. Idempotent by trial state + idempotency key (FR-03/INV-03).
 */
export async function runTrial(
  ctx: Ctx,
  actor: Actor,
  trialId: string,
  adapter: OcrAdapter = new HttpOcrAdapter(),
): Promise<{ trial_id: string; cells_created: number; reserved: number; blocked: number }> {
  const trial = getTrial(ctx, trialId);
  if (trial.account_id !== actor.accountId) throw notFound("trial");
  if (trial.state !== "planned") {
    if (trial.state === "running") return { trial_id: trialId, cells_created: 0, reserved: 0, blocked: 0 };
    throw conflict("trial_not_planned", `trial is ${trial.state}`);
  }
  const suite = getSuiteVersion(ctx, trial.suite_id, trial.suite_version);
  if (suite.manifest_hash !== trial.manifest_hash) {
    throw conflict("manifest_mismatch", "suite manifest changed since trial creation");
  }
  const samples = ctx.db.all<any>(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? ORDER BY sample_id",
    trial.suite_id,
    trial.suite_version,
  );
  const providerIds: string[] = JSON.parse(trial.providers_json);
  const exclusions: Array<{ provider_id: string; sample_id?: string; reason: string }> = [];

  // Collect eligibility + quotes outside the write transaction.
  const plans: Array<{
    provider: any;
    binding: any;
    quote: number | null;
    cells: Array<{ sample_id: string; reason: string | null }>;
  }> = [];
  for (const pid of providerIds) {
    const provider = getProvider(ctx, pid);
    const binding = activeBinding(ctx, pid);
    let quote: number | null = null;
    if (binding) {
      try {
        quote = (await adapter.quote(ctx, provider.endpoint_origin)).price_minor;
      } catch {
        quote = null;
      }
    }
    const cells: Array<{ sample_id: string; reason: string | null }> = [];
    let reservedSoFar = 0;
    for (const s of samples) {
      let reason: string | null = null;
      if (!binding) reason = "binding_expired";
      else if (!processorAllowed(s, pid)) reason = "consent_excluded";
      else if (quote === null) reason = "quote_unavailable";
      else {
        reservedSoFar += quote;
        if (reservedSoFar > trial.per_provider_cap_minor) {
          reason = "quota_exceeded";
          reservedSoFar -= quote;
        }
      }
      if (reason) exclusions.push({ provider_id: pid, sample_id: s.sample_id, reason });
      cells.push({ sample_id: s.sample_id, reason });
    }
    plans.push({ provider, binding, quote, cells });
  }

  const out = ctx.db.tx(() => {
    let created = 0;
    let reserved = 0;
    let blocked = 0;
    for (const plan of plans) {
      for (const c of plan.cells) {
        const state = c.reason ? "blocked" : "reserved";
        const r = ctx.db.run(
          `INSERT OR IGNORE INTO cells(trial_id,provider_id,binding_id,sample_id,state,reason,updated_at)
           VALUES(?,?,?,?,?,?,?)`,
          trialId,
          plan.provider.id,
          c.reason ? null : plan.binding.id,
          c.sample_id,
          state,
          c.reason,
          iso(ctx),
        );
        if (r.changes) created++;
        if (!c.reason) {
          reserved++;
          ctx.db.run(
            `INSERT INTO outbox(kind,payload_json,state,created_at)
             SELECT 'dispatch', ?, 'pending', ?
             WHERE NOT EXISTS (
               SELECT 1 FROM outbox WHERE kind='dispatch' AND json_extract(payload_json,'$.trial_id')=?
               AND json_extract(payload_json,'$.provider_id')=? AND json_extract(payload_json,'$.sample_id')=? AND state='pending')`,
            JSON.stringify({ trial_id: trialId, provider_id: plan.provider.id, sample_id: c.sample_id }),
            iso(ctx),
            trialId,
            plan.provider.id,
            c.sample_id,
          );
        } else {
          blocked++;
        }
      }
    }
    ctx.db.run(
      "UPDATE trials SET state='running', started_at=?, exclusions_json=? WHERE id=?",
      iso(ctx),
      JSON.stringify(exclusions),
      trialId,
    );
    return { created, reserved, blocked };
  });
  audit(ctx, actor, "trial.run", "trial_running", "trial", trialId, {
    cells_created: out.created,
    reserved: out.reserved,
    blocked: out.blocked,
    exclusions: exclusions.length,
  });
  return { trial_id: trialId, cells_created: out.created, reserved: out.reserved, blocked: out.blocked };
}

/** Per-provider coverage: scheduled vs attempted vs terminal, with reasons. */
export function trialCoverage(ctx: Ctx, trialId: string) {
  const trial = getTrial(ctx, trialId);
  const providerIds: string[] = JSON.parse(trial.providers_json);
  const providersOut = providerIds.map((pid) => {
    const cells = ctx.db.all<any>(
      "SELECT state, reason, COUNT(*) n FROM cells WHERE trial_id=? AND provider_id=? GROUP BY state, reason",
      trialId,
      pid,
    );
    const scheduled = cells.reduce((a: number, c: any) => a + c.n, 0);
    const attempted = ctx.db.get<any>(
      "SELECT COUNT(DISTINCT sample_id) n FROM attempts WHERE trial_id=? AND provider_id=?",
      trialId,
      pid,
    ).n;
    const accepted = ctx.db.get<any>(
      `SELECT COUNT(*) n FROM measurements m JOIN attempts a ON a.id=m.attempt_id
       WHERE a.trial_id=? AND a.provider_id=? AND m.accepted=1`,
      trialId,
      pid,
    ).n;
    const byState: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    for (const c of cells) {
      byState[c.state] = (byState[c.state] ?? 0) + c.n;
      if (c.reason) reasons[c.reason] = (reasons[c.reason] ?? 0) + c.n;
    }
    return {
      provider_id: pid,
      scheduled,
      attempted,
      accepted,
      coverage: `${attempted}/${scheduled}`,
      by_state: byState,
      blocked_reasons: reasons,
    };
  });
  return {
    trial_id: trialId,
    state: trial.state,
    suite: `${trial.suite_id}@${trial.suite_version}`,
    manifest_hash: trial.manifest_hash,
    exclusions: JSON.parse(trial.exclusions_json),
    providers: providersOut,
  };
}

/**
 * Opt-in recurring trial: creates a fresh planned trial on the latest frozen
 * suite version using the original provider set and budget. Requires the
 * source trial to carry recurring opt-in (FR-07).
 */
export function rerunTrial(ctx: Ctx, actor: Actor, trialId: string): any {
  const src = getTrial(ctx, trialId);
  if (src.account_id !== actor.accountId) throw notFound("trial");
  const recurring = src.recurring_json ? JSON.parse(src.recurring_json) : null;
  if (!recurring?.enabled) {
    throw conflict("recurring_not_enabled", "trial was not created with recurring opt-in");
  }
  const latest = ctx.db.get<any>(
    "SELECT MAX(version) v FROM suites WHERE id=? AND state='frozen'",
    src.suite_id,
  );
  if (!latest || latest.v === null) {
    throw conflict("no_frozen_version", "suite has no frozen version to rerun against");
  }
  return createTrial(ctx, actor, {
    suite_id: src.suite_id,
    suite_version: latest.v,
    provider_ids: JSON.parse(src.providers_json),
    budget_minor: src.budget_minor,
    per_provider_cap_minor: src.per_provider_cap_minor,
    asset: src.asset,
    ranking_min_observations: src.ranking_min_observations,
    small_sample_threshold: src.small_sample_threshold,
    dispatch_timeout_ms: src.dispatch_timeout_ms,
    recurring: recurring,
  });
}

/** Terminal-cell check after each drain; sets complete/partial. */
export function maybeFinalizeTrial(ctx: Ctx, trialId: string): void {
  const trial = ctx.db.get<any>("SELECT * FROM trials WHERE id=?", trialId);
  if (!trial || (trial.state !== "running" && trial.state !== "partial")) return;
  const open = ctx.db.get<any>(
    "SELECT COUNT(*) n FROM cells WHERE trial_id=? AND state IN ('planned','reserved','dispatched')",
    trialId,
  ).n;
  if (open > 0) return;
  const bad = ctx.db.get<any>(
    "SELECT COUNT(*) n FROM cells WHERE trial_id=? AND state!='succeeded'",
    trialId,
  ).n;
  ctx.db.run(
    "UPDATE trials SET state=?, finished_at=? WHERE id=?",
    bad === 0 ? "complete" : "partial",
    iso(ctx),
    trialId,
  );
}
