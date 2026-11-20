import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor } from "../auth.ts";
import { audit } from "../audit.ts";
import { notFound } from "../lib/errors.ts";
import { canonicalJson, newId, percentile } from "../lib/util.ts";
import { getTrial } from "./trials.ts";

/**
 * Immutable comparison snapshot at an evidence cursor (attempt rowid max).
 * The body is fully deterministic given (trial, cursor): no wall-clock fields,
 * so rebuilding from the same append-only records is byte-identical (NFR-01).
 */
export function buildReportBody(ctx: Ctx, trialId: string, asof: number): any {
  const trial = getTrial(ctx, trialId);
  const providerIds: string[] = JSON.parse(trial.providers_json);
  const providerRows: any[] = [];
  let anyIncomplete = false;
  let anyUnknownCost = false;
  for (const pid of providerIds) {
    const p = ctx.db.get<any>("SELECT * FROM providers WHERE id=?", pid);
    const scheduled = ctx.db.get<any>(
      "SELECT COUNT(*) n FROM cells WHERE trial_id=? AND provider_id=?",
      trialId, pid,
    ).n;
    const attempts = ctx.db.all<any>(
      "SELECT * FROM attempts WHERE trial_id=? AND provider_id=? AND id<=? ORDER BY id",
      trialId, pid, asof,
    );
    const attempted = new Set(attempts.map((a) => a.sample_id)).size;
    // Latest attempt per logical cell within the cursor window.
    const latestByCell = new Map<string, any>();
    for (const a of attempts) {
      const prev = latestByCell.get(a.sample_id);
      if (!prev || a.seq > prev.seq) latestByCell.set(a.sample_id, a);
    }
    let accepted = 0;
    let fieldsCorrect = 0;
    let fieldsTotal = 0;
    const errorHist: Record<string, number> = {};
    for (const a of latestByCell.values()) {
      const m = ctx.db.get<any>("SELECT * FROM measurements WHERE attempt_id=?", a.id);
      if (m) {
        fieldsCorrect += m.fields_correct;
        fieldsTotal += m.fields_total;
        if (a.state === "succeeded" && m.accepted === 1) accepted++;
        for (const fr of JSON.parse(m.field_results_json)) {
          if (fr.outcome !== "correct") errorHist[fr.outcome] = (errorHist[fr.outcome] ?? 0) + 1;
        }
      }
      if (a.state === "failed") errorHist[a.uncertainty_reason ?? "failed"] = (errorHist[a.uncertainty_reason ?? "failed"] ?? 0) + 1;
      if (a.state === "uncertain") errorHist[a.uncertainty_reason ?? "uncertain"] = (errorHist[a.uncertainty_reason ?? "uncertain"] ?? 0) + 1;
    }
    const spend = ctx.db.get<any>(
      `SELECT COALESCE(SUM(cost_minor),0) s FROM attempts
       WHERE trial_id=? AND provider_id=? AND id<=? AND cost_state='verified'`,
      trialId, pid, asof,
    ).s as number;
    const unpriced = ctx.db.get<any>(
      `SELECT COUNT(*) n FROM attempts
       WHERE trial_id=? AND provider_id=? AND id<=? AND cost_state IN ('uncertain','unpriced')`,
      trialId, pid, asof,
    ).n as number;
    const durations = attempts
      .map((a) => a.duration_ms)
      .filter((d): d is number => d !== null)
      .sort((x, y) => x - y);
    const bindings = ctx.db.all<any>(
      `SELECT DISTINCT b.id, b.origin, b.key_id, b.expires_at FROM attempts a
       JOIN bindings b ON b.id=a.binding_id
       WHERE a.trial_id=? AND a.provider_id=? AND a.id<=?`,
      trialId, pid, asof,
    );
    const coverageComplete = attempted === scheduled;
    const costKnown = unpriced === 0;
    if (!coverageComplete) anyIncomplete = true;
    if (!costKnown) anyUnknownCost = true;
    providerRows.push({
      provider_id: pid,
      name: p?.name,
      scheduled,
      attempted,
      accepted,
      fields_correct: fieldsCorrect,
      fields_total: fieldsTotal,
      spend_minor: spend,
      cost_state: costKnown ? "verified" : "unknown",
      cost_per_accepted_minor:
        costKnown && accepted > 0
          ? spend % accepted === 0
            ? spend / accepted
            : Math.round((spend / accepted) * 100) / 100
          : null,
      cost_unknown_reason: !costKnown
        ? "unpriced_or_unverified_attempts"
        : accepted === 0
          ? "zero_accepted"
          : null,
      latency: {
        n: durations.length,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      errors: errorHist,
      coverage: `${attempted}/${scheduled}`,
      coverage_complete: coverageComplete,
      small_sample_warning: attempted < trial.small_sample_threshold,
      bindings: bindings.map((b) => ({ id: b.id, origin: b.origin, key_id: b.key_id, expires_at: b.expires_at })),
    });
  }
  const maxAttempted = Math.max(0, ...providerRows.map((r) => r.attempted));
  const windowRows = ctx.db.get<any>(
    "SELECT MIN(dispatched_at) first, MAX(COALESCE(completed_at,dispatched_at)) last FROM attempts WHERE trial_id=? AND id<=?",
    trialId, asof,
  );
  let suppressed: any = null;
  if (maxAttempted < trial.ranking_min_observations) {
    suppressed = {
      code: "min_observations",
      required: trial.ranking_min_observations,
      observed: maxAttempted,
    };
  } else if (anyIncomplete) {
    suppressed = { code: "incomplete_coverage" };
  } else if (anyUnknownCost) {
    suppressed = { code: "unknown_cost" };
  }
  const ranked = suppressed
    ? null
    : providerRows
        .filter((r) => r.cost_per_accepted_minor !== null)
        .sort((a, b) => a.cost_per_accepted_minor - b.cost_per_accepted_minor || b.accepted - a.accepted)
        .map((r) => ({ provider_id: r.provider_id, cost_per_accepted_minor: r.cost_per_accepted_minor }));
  return {
    trial_id: trialId,
    account_id: trial.account_id,
    suite_id: trial.suite_id,
    suite_version: trial.suite_version,
    manifest_hash: trial.manifest_hash,
    asof_cursor: asof,
    environment: "local",
    run_window: { first_dispatch: windowRows.first ?? null, last_completion: windowRows.last ?? null },
    ranking_min_observations: trial.ranking_min_observations,
    small_sample_threshold: trial.small_sample_threshold,
    providers: providerRows,
    comparison: { ranked, suppressed },
  };
}

export function latestCursor(ctx: Ctx, trialId: string): number {
  return (
    ctx.db.get<any>("SELECT COALESCE(MAX(id),0) c FROM attempts WHERE trial_id=?", trialId).c ?? 0
  );
}

/** Issue an immutable report snapshot for the trial's current evidence. */
export function issueReport(ctx: Ctx, actor: Actor, trialId: string): any {
  const trial = getTrial(ctx, trialId);
  if (trial.account_id !== actor.accountId) throw notFound("trial");
  const asof = latestCursor(ctx, trialId);
  const body = buildReportBody(ctx, trialId, asof);
  const id = newId("rep");
  ctx.db.run(
    "INSERT INTO reports(id,trial_id,asof_cursor,body_json,created_by,created_at) VALUES(?,?,?,?,?,?)",
    id,
    trialId,
    asof,
    JSON.stringify(body),
    actor.subject,
    iso(ctx),
  );
  audit(ctx, actor, "report.issue", "report_issued", "report", id, {
    trial_id: trialId,
    asof_cursor: asof,
  });
  return getReport(ctx, id);
}

export function getReport(ctx: Ctx, id: string): any {
  const r = ctx.db.get<any>("SELECT * FROM reports WHERE id=?", id);
  if (!r) throw notFound("report");
  return { id: r.id, trial_id: r.trial_id, asof_cursor: r.asof_cursor, body: JSON.parse(r.body_json), created_by: r.created_by, created_at: r.created_at };
}

export function listReports(ctx: Ctx, trialId: string) {
  return ctx.db
    .all<any>("SELECT * FROM reports WHERE trial_id=? ORDER BY created_at", trialId)
    .map((r) => ({ id: r.id, trial_id: r.trial_id, asof_cursor: r.asof_cursor, created_by: r.created_by, created_at: r.created_at }));
}

/** Redacted per-sample field evidence for one provider within a report. */
export function reportFieldEvidence(ctx: Ctx, report: any, providerId: string) {
  const trial = getTrial(ctx, report.trial_id);
  const attempts = ctx.db.all<any>(
    `SELECT * FROM attempts WHERE trial_id=? AND provider_id=? AND id<=? ORDER BY sample_id, seq`,
    report.trial_id,
    providerId,
    report.asof_cursor,
  );
  const byCell = new Map<string, any>();
  for (const a of attempts) {
    const prev = byCell.get(a.sample_id);
    if (!prev || a.seq > prev.seq) byCell.set(a.sample_id, a);
  }
  const samples = [...byCell.values()].map((a) => {
    const m = ctx.db.get<any>("SELECT * FROM measurements WHERE attempt_id=?", a.id);
    return {
      sample_id: a.sample_id,
      attempt_state: a.state,
      cost_state: a.cost_state,
      accepted: m?.accepted === 1 && a.state === "succeeded",
      fields: m ? JSON.parse(m.field_results_json) : null,
    };
  });
  // Cells never attempted stay visible with no evidence.
  const attempted = new Set(samples.map((s) => s.sample_id));
  const cells = ctx.db.all<any>(
    "SELECT sample_id, state, reason FROM cells WHERE trial_id=? AND provider_id=?",
    report.trial_id,
    providerId,
  );
  for (const c of cells) {
    if (!attempted.has(c.sample_id)) {
      samples.push({ sample_id: c.sample_id, attempt_state: c.state, cost_state: null, accepted: false, fields: null });
    }
  }
  samples.sort((a, b) => a.sample_id.localeCompare(b.sample_id));
  return { report_id: report.id, provider_id: providerId, samples };
}

/** Rebuild a report body from its frozen cursor and compare byte-for-byte. */
export function rebuildReport(ctx: Ctx, reportId: string): { identical: boolean; diffs?: any } {
  const r = ctx.db.get<any>("SELECT * FROM reports WHERE id=?", reportId);
  if (!r) throw notFound("report");
  const rebuilt = canonicalJson(buildReportBody(ctx, r.trial_id, r.asof_cursor));
  const original = canonicalJson(JSON.parse(r.body_json));
  return { identical: rebuilt === original };
}
