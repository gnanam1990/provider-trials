import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor } from "../auth.ts";
import { audit } from "../audit.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { canonicalJson, newId, sha256hex, verifyEd25519 } from "../lib/util.ts";
import { HttpTimeout } from "../lib/httpClient.ts";
import { HttpOcrAdapter } from "../adapters/ocr.ts";
import type { OcrAdapter, ReceiptPayload } from "../adapters/ocr.ts";
import { activeBinding, getProvider } from "./providers.ts";
import { getSample, getSuiteVersion, issueSampleUrl, processorAllowed } from "./suites.ts";
import { getTrial, maybeFinalizeTrial } from "./trials.ts";
import { scoreExtraction } from "./scoring.ts";

function blockCell(ctx: Ctx, actorScope: { accountId: string }, cellKey: any, reason: string): void {
  ctx.db.run(
    "UPDATE cells SET state='blocked', reason=?, updated_at=? WHERE trial_id=? AND provider_id=? AND sample_id=?",
    reason,
    iso(ctx),
    cellKey.trial_id,
    cellKey.provider_id,
    cellKey.sample_id,
  );
  audit(ctx, { accountId: actorScope.accountId, subject: "worker", role: "runner" },
    "cell.dispatch", `cell_blocked_${reason}`, "cell",
    `${cellKey.trial_id}/${cellKey.provider_id}/${cellKey.sample_id}`);
}

function setCell(ctx: Ctx, key: any, state: string, reason: string | null = null): void {
  ctx.db.run(
    "UPDATE cells SET state=?, reason=?, updated_at=? WHERE trial_id=? AND provider_id=? AND sample_id=?",
    state,
    reason,
    iso(ctx),
    key.trial_id,
    key.provider_id,
    key.sample_id,
  );
}

/** Verify a signed provider receipt against the enrolled key and this attempt. */
export function verifyReceipt(
  provider: any,
  attempt: any,
  receipt: ReceiptPayload,
): { ok: boolean; reason?: string } {
  const { digest, signature, ...unsigned } = receipt as any;
  if (receipt.invocation_ref !== attempt.invocation_ref) {
    return { ok: false, reason: "receipt_ref_mismatch" };
  }
  if (receipt.trial_id !== attempt.trial_id) {
    return { ok: false, reason: "receipt_trial_mismatch" };
  }
  const recomputed = sha256hex(canonicalJson(unsigned));
  if (recomputed !== digest) return { ok: false, reason: "receipt_digest_mismatch" };
  if (!verifyEd25519(digest, signature, provider.public_key_pem)) {
    return { ok: false, reason: "receipt_bad_signature" };
  }
  return { ok: true };
}

function storeReceipt(
  ctx: Ctx,
  attemptId: number,
  providerId: string,
  receipt: ReceiptPayload,
  verified: boolean,
): void {
  ctx.db.run(
    `INSERT OR REPLACE INTO receipts(id,attempt_id,provider_id,amount_minor,asset,digest,signature,verified,provenance_json,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    receipt.receipt_id,
    attemptId,
    providerId,
    receipt.amount_minor,
    receipt.asset,
    receipt.digest,
    receipt.signature,
    verified ? 1 : 0,
    canonicalJson({ environment: receipt.environment ?? "local", transport: "http-adapter" }),
    iso(ctx),
  );
}

/**
 * Apply a settled execution outcome to a durable attempt: verify the charge,
 * score the extraction against the frozen labels, close the logical cell.
 */
function applySettledOutcome(
  ctx: Ctx,
  trial: any,
  provider: any,
  attempt: any,
  fields: Record<string, string>,
  receipt: ReceiptPayload | undefined,
  durationMs: number | null,
): void {
  const sample = getSample(ctx, trial.suite_id, trial.suite_version, attempt.sample_id);
  const suite = getSuiteVersion(ctx, trial.suite_id, trial.suite_version);
  const normalizer = JSON.parse(suite.normalizer_config_json);
  const mandatory: string[] = JSON.parse(suite.mandatory_fields_json);
  const labels = JSON.parse(sample.label_json);
  const score = scoreExtraction(labels, fields ?? {}, normalizer, mandatory);

  let costState = "unpriced";
  let costMinor: number | null = null;
  let receiptId: string | null = null;
  let uncertainty: string | null = null;
  if (receipt) {
    const v = verifyReceipt(provider, attempt, receipt);
    storeReceipt(ctx, attempt.id, provider.id, receipt, v.ok);
    receiptId = receipt.receipt_id;
    if (v.ok) {
      costState = "verified";
      costMinor = receipt.amount_minor;
    } else {
      costState = "uncertain";
      uncertainty = v.reason ?? "receipt_unverified";
    }
  } else {
    costState = "uncertain";
    uncertainty = "receipt_missing";
  }
  const state = receipt && costState === "uncertain" ? "uncertain" : "succeeded";
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE attempts SET state=?, completed_at=?, duration_ms=?, cost_minor=?, cost_state=?,
         receipt_id=?, uncertainty_reason=? WHERE id=?`,
      state,
      iso(ctx),
      durationMs,
      costMinor,
      costState,
      receiptId,
      uncertainty,
      attempt.id,
    );
    ctx.db.run(
      `INSERT OR REPLACE INTO measurements(attempt_id,accepted,fields_correct,fields_total,field_results_json,response_ref)
       VALUES(?,?,?,?,?,?)`,
      attempt.id,
      score.accepted ? 1 : 0,
      score.fieldsCorrect,
      score.fieldsTotal,
      JSON.stringify(score.fieldResults),
      null,
    );
    setCell(ctx, attempt, state === "succeeded" ? "succeeded" : "uncertain",
      state === "succeeded" ? null : "pending_reconciliation");
  });
}

function markAttemptUncertain(ctx: Ctx, attempt: any, reason: string): void {
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE attempts SET state='uncertain', cost_state='uncertain', uncertainty_reason=?, completed_at=? WHERE id=?",
      reason,
      iso(ctx),
      attempt.id,
    );
    setCell(ctx, attempt, "uncertain", "pending_reconciliation");
  });
}

function markAttemptFailed(ctx: Ctx, attempt: any, reason: string): void {
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE attempts SET state='failed', completed_at=?, uncertainty_reason=? WHERE id=?",
      iso(ctx),
      reason,
      attempt.id,
    );
    setCell(ctx, attempt, "failed", reason);
  });
}

/**
 * Dispatch one reserved cell. Gates (binding, consent, quota) are re-evaluated
 * at dispatch time so a binding that expired after scheduling blocks the cell.
 * The durable attempt is persisted BEFORE the external call.
 */
export async function dispatchCell(
  ctx: Ctx,
  payload: { trial_id: string; provider_id: string; sample_id: string },
  adapter: OcrAdapter = new HttpOcrAdapter(),
): Promise<string> {
  const { trial_id, provider_id, sample_id } = payload;
  const cell = ctx.db.get<any>(
    "SELECT * FROM cells WHERE trial_id=? AND provider_id=? AND sample_id=?",
    trial_id,
    provider_id,
    sample_id,
  );
  if (!cell || cell.state !== "reserved") return "skipped";
  const trial = getTrial(ctx, trial_id);
  const provider = getProvider(ctx, provider_id);
  const scope = { accountId: trial.account_id };

  const binding = activeBinding(ctx, provider_id);
  if (!binding) {
    blockCell(ctx, scope, payload, "binding_expired");
    return "blocked";
  }
  const sample = getSample(ctx, trial.suite_id, trial.suite_version, sample_id);
  if (!processorAllowed(sample, provider_id)) {
    blockCell(ctx, scope, payload, "consent_excluded");
    return "blocked";
  }
  const spent = ctx.db.get<any>(
    `SELECT COALESCE(SUM(cost_minor),0) s FROM attempts
     WHERE trial_id=? AND provider_id=? AND cost_state IN ('verified','uncertain')`,
    trial_id,
    provider_id,
  ).s as number;
  let quoteMinor: number;
  try {
    quoteMinor = (await adapter.quote(ctx, provider.endpoint_origin)).price_minor;
  } catch {
    // Quote unavailable at dispatch: leave the cell reserved for a later drain.
    return "deferred";
  }
  if (spent + quoteMinor > trial.per_provider_cap_minor) {
    blockCell(ctx, scope, payload, "quota_exceeded");
    return "blocked";
  }

  const seq =
    (ctx.db.get<any>(
      "SELECT MAX(seq) m FROM attempts WHERE trial_id=? AND provider_id=? AND sample_id=?",
      trial_id,
      provider_id,
      sample_id,
    ).m ?? 0) + 1;
  const attempt = ctx.db.tx(() => {
    const publicId = newId("att");
    const invRef = newId("inv");
    ctx.db.run(
      `INSERT INTO attempts(public_id,trial_id,provider_id,binding_id,sample_id,seq,state,invocation_ref,dispatched_at)
       VALUES(?,?,?,?,?,?, 'dispatched', ?, ?)`,
      publicId,
      trial_id,
      provider_id,
      binding.id,
      sample_id,
      seq,
      invRef,
      iso(ctx),
    );
    setCell(ctx, payload, "dispatched");
    return ctx.db.get<any>(
      "SELECT * FROM attempts WHERE trial_id=? AND provider_id=? AND sample_id=? AND seq=?",
      trial_id,
      provider_id,
      sample_id,
      seq,
    );
  });

  const suite = getSuiteVersion(ctx, trial.suite_id, trial.suite_version);
  const url = issueSampleUrl(ctx, suite, sample, provider_id);
  const started = ctx.now();
  try {
    const res = await adapter.execute(
      ctx,
      provider.endpoint_origin,
      {
        invocation_ref: attempt.invocation_ref,
        trial_id,
        sample_url: url,
        sample_key: sample.content_hash.slice(0, 12),
      },
      trial.dispatch_timeout_ms,
    );
    const duration = Math.max(0, ctx.now() - started);
    const fresh = ctx.db.get<any>("SELECT * FROM attempts WHERE id=?", attempt.id);
    applySettledOutcome(ctx, trial, provider, fresh, res.fields, res.receipt, duration);
    return "settled";
  } catch (e) {
    const fresh = ctx.db.get<any>("SELECT * FROM attempts WHERE id=?", attempt.id);
    if (e instanceof HttpTimeout) {
      // Uncertain charge: no auto-retry, no zero-cost assertion (T-008).
      markAttemptUncertain(ctx, fresh, "timeout");
      return "uncertain";
    }
    markAttemptFailed(ctx, fresh, "provider_error");
    return "failed";
  }
}

/** Drain pending dispatch work in bounded batches until the queue is empty. */
export async function drainOutbox(
  ctx: Ctx,
  adapter: OcrAdapter = new HttpOcrAdapter(),
  batchSize = ctx.config.dispatchConcurrency,
): Promise<{ processed: number; outcomes: Record<string, number> }> {
  const outcomes: Record<string, number> = {};
  let processed = 0;
  const touchedTrials = new Set<string>();
  for (;;) {
    const rows = ctx.db.all<any>(
      "SELECT * FROM outbox WHERE state='pending' AND kind='dispatch' ORDER BY id LIMIT ?",
      Math.max(1, batchSize),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const claimed = ctx.db.run(
        "UPDATE outbox SET state='done', processed_at=? WHERE id=? AND state='pending'",
        iso(ctx),
        row.id,
      );
      if (!claimed.changes) continue;
      processed++;
      const payload = JSON.parse(row.payload_json);
      const outcome = await dispatchCell(ctx, payload, adapter);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome === "deferred") {
        const tries = (payload.tries ?? 0) + 1;
        if (tries < 3) {
          ctx.db.run("INSERT INTO outbox(kind,payload_json,state,created_at) VALUES('dispatch',?,'pending',?)",
            JSON.stringify({ ...payload, tries }), iso(ctx));
        } else {
          blockCell(ctx, { accountId: getTrial(ctx, payload.trial_id).account_id }, payload, "quote_unavailable");
        }
      }
      touchedTrials.add(payload.trial_id);
    }
  }
  for (const t of touchedTrials) maybeFinalizeTrial(ctx, t);
  return { processed, outcomes };
}

/** Manual retry of a failed/uncertain cell: new attempt seq, same logical cell. */
export async function retryCell(
  ctx: Ctx,
  actor: Actor,
  trialId: string,
  providerId: string,
  sampleId: string,
  adapter: OcrAdapter = new HttpOcrAdapter(),
): Promise<string> {
  const cell = ctx.db.get<any>(
    "SELECT * FROM cells WHERE trial_id=? AND provider_id=? AND sample_id=?",
    trialId,
    providerId,
    sampleId,
  );
  if (!cell) throw notFound("cell");
  if (cell.state !== "failed" && cell.state !== "uncertain") {
    throw conflict("cell_not_retryable", `cell is ${cell.state}; only failed/uncertain cells may be retried`);
  }
  setCell(ctx, { trial_id: trialId, provider_id: providerId, sample_id: sampleId }, "reserved");
  ctx.db.run("UPDATE trials SET state='running', finished_at=NULL WHERE id=? AND state IN ('partial','complete')", trialId);
  audit(ctx, actor, "cell.retry", "cell_reserved_for_retry", "cell",
    `${trialId}/${providerId}/${sampleId}`);
  const outcome = await dispatchCell(
    ctx,
    { trial_id: trialId, provider_id: providerId, sample_id: sampleId },
    adapter,
  );
  maybeFinalizeTrial(ctx, trialId);
  return outcome;
}

/**
 * Reconcile uncertain attempts against the provider's own status lookup using
 * the original invocation reference. Unknown stays uncertain — never assumed.
 */
export async function reconcileTrial(
  ctx: Ctx,
  actor: Actor,
  trialId: string,
  adapter: OcrAdapter = new HttpOcrAdapter(),
): Promise<{ reconciled: number; still_uncertain: number }> {
  const trial = getTrial(ctx, trialId);
  if (trial.account_id !== actor.accountId) throw notFound("trial");
  const rows = ctx.db.all<any>(
    "SELECT * FROM attempts WHERE trial_id=? AND state='uncertain'",
    trialId,
  );
  let reconciled = 0;
  let still = 0;
  for (const attempt of rows) {
    const provider = getProvider(ctx, attempt.provider_id);
    const st = await adapter.status(ctx, provider.endpoint_origin, attempt.invocation_ref);
    if (st.state === "settled" && st.result) {
      applySettledOutcome(ctx, trial, provider, attempt, st.result.fields, st.receipt, null);
      reconciled++;
      audit(ctx, actor, "trial.reconcile", "attempt_reconciled", "attempt", attempt.public_id, {
        invocation_ref: attempt.invocation_ref,
      });
    } else {
      still++;
    }
  }
  maybeFinalizeTrial(ctx, trialId);
  return { reconciled, still_uncertain: still };
}
