import { test } from "node:test";
import assert from "node:assert/strict";
import { startEnv, api, makeAccount, FakeProvider, bindProvider, makeFrozenSuite } from "./helpers.ts";

async function oneCellTrial(env: any, actors: any, providerId: string, suiteId: string) {
  const t = await api(env.port, actors.lead, "POST", "/trials", {
    suite_id: suiteId,
    provider_ids: [providerId],
    budget_minor: 100,
    per_provider_cap_minor: 50,
    asset: "cent",
    dispatch_timeout_ms: 200,
  });
  return t.json.trial.id;
}

test("T-007: a settled retry adds its expense without increasing the logical sample count", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 1 });
    const trialId = await oneCellTrial(env, actors, pA, suiteId);
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);

    // First attempt faults at the provider: cell fails, no charge asserted.
    fake.mode = "error";
    await api(env.port, actors.runner, "POST", "/internal/drain");
    let cell = env.db.get<any>("SELECT * FROM cells WHERE trial_id=?", trialId);
    assert.equal(cell.state, "failed");
    assert.equal(cell.reason, "provider_error");

    // Manual retry: second attempt on the SAME logical cell settles + charges.
    fake.mode = "ok";
    fake.defaultFields = { date: "2026-01-15", tax: "1.50", total: "11.50" };
    const retry = await api(env.port, actors.runner, "POST",
      `/trials/${trialId}/cells/${pA}/inv-1/retry`);
    assert.equal(retry.json.outcome, "settled");

    cell = env.db.get<any>("SELECT * FROM cells WHERE trial_id=?", trialId);
    assert.equal(cell.state, "succeeded");
    const attempts = env.db.all<any>("SELECT * FROM attempts WHERE trial_id=? ORDER BY seq", trialId);
    assert.equal(attempts.length, 2); // retry recorded, logical cell still one
    const spend = env.db.get<any>(
      "SELECT COALESCE(SUM(cost_minor),0) s FROM attempts WHERE trial_id=? AND cost_state='verified'",
      trialId).s;
    assert.equal(spend, 3); // only the settled retry charged
    assert.equal(env.db.get<any>("SELECT COUNT(*) n FROM cells WHERE trial_id=?", trialId).n, 1);
    const t = await api(env.port, actors.lead, "GET", `/trials/${trialId}`);
    assert.equal(t.json.trial.state, "complete");
    const receipt = env.db.get<any>("SELECT * FROM receipts WHERE attempt_id=?", attempts[1].id);
    assert.equal(receipt.verified, 1);
    assert.equal(receipt.amount_minor, 3);
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("T-008: a timeout without provider lookup does not auto-retry or assert zero cost", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 1 });
    const trialId = await oneCellTrial(env, actors, pA, suiteId);
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);

    fake.mode = "hang";
    await api(env.port, actors.runner, "POST", "/internal/drain");

    const attempts = env.db.all<any>("SELECT * FROM attempts WHERE trial_id=?", trialId);
    assert.equal(attempts.length, 1); // no automatic redispatch
    const a = attempts[0];
    assert.equal(a.state, "uncertain");
    assert.equal(a.uncertainty_reason, "timeout");
    assert.equal(a.cost_minor, null); // charge is unknown, never asserted as 0
    assert.equal(a.cost_state, "uncertain");

    const cell = env.db.get<any>("SELECT * FROM cells WHERE trial_id=?", trialId);
    assert.equal(cell.state, "uncertain");
    assert.equal(cell.reason, "pending_reconciliation");

    // Provider cannot say what happened -> stays uncertain, still no retry.
    const rec = await api(env.port, actors.runner, "POST", `/trials/${trialId}/reconcile`);
    assert.equal(rec.json.reconciled, 0);
    assert.equal(rec.json.still_uncertain, 1);
    assert.equal(env.db.get<any>("SELECT COUNT(*) n FROM attempts WHERE trial_id=?", trialId).n, 1);
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("M04-extra: timeout followed by a settled provider lookup reconciles the same invocation", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 1 });
    const trialId = await oneCellTrial(env, actors, pA, suiteId);
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);

    // Provider is slower than the 200ms dispatch timeout but does settle.
    fake.mode = "ok";
    fake.latencyMs = 500;
    fake.defaultFields = { date: "2026-01-15", tax: "1.50", total: "11.50" };
    await api(env.port, actors.runner, "POST", "/internal/drain");
    assert.equal(env.db.get<any>("SELECT state FROM attempts WHERE trial_id=?", trialId).state, "uncertain");

    await new Promise((r) => setTimeout(r, 600)); // provider finishes in the background
    const rec = await api(env.port, actors.runner, "POST", `/trials/${trialId}/reconcile`);
    assert.equal(rec.json.reconciled, 1);
    const a = env.db.get<any>("SELECT * FROM attempts WHERE trial_id=?", trialId);
    assert.equal(a.state, "succeeded");
    assert.equal(a.cost_minor, 3);
    assert.equal(a.cost_state, "verified");
    assert.equal(env.db.get<any>("SELECT COUNT(*) n FROM attempts WHERE trial_id=?", trialId).n, 1);
  } finally {
    await fake.stop();
    await env.close();
  }
});
