import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256hex } from "../src/lib/util.ts";
import { startEnv, api, makeAccount, FakeProvider, bindProvider } from "./helpers.ts";

const LABELS = { date: "2026-01-15", tax: "1.50", total: "11.50" };

/** Four samples where the provider gets fields right per a 3/3/3/2-style plan. */
async function suiteWithPlan(env: any, actors: any, fake: FakeProvider, plan: string[]) {
  const s = await api(env.port, actors.steward, "POST", "/suites", { name: "reports" });
  const suiteId = s.json.suite.id;
  for (let i = 0; i < 4; i++) {
    const content = `INVOICE ${i + 1} content`;
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/samples`, {
      sample_id: `inv-${i + 1}`, content, labels: LABELS,
    });
    const misses = (plan[i] ?? "").split(",").filter(Boolean);
    fake.fieldPlan[sha256hex(content).slice(0, 12)] = {
      date: misses.includes("date") ? "2020-02-02" : LABELS.date,
      tax: misses.includes("tax") ? "9.99" : LABELS.tax,
      total: misses.includes("total") ? "9.99" : LABELS.total,
    };
  }
  await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/freeze`);
  return suiteId;
}

test("T-011: twelve cents across three accepted outputs displays exactly four cents each", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    fake.priceMinor = 3;
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    // A: 3 accepted of 4 (inv-4 misses 'total'), 11/12 fields, 4x3=12c spend.
    const suiteId = await suiteWithPlan(env, actors, fake, ["", "", "", "total"]);
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    const trialId = t.json.trial.id;
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");

    const rep = await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);
    assert.equal(rep.status, 201);
    const body = rep.json.report.body;
    const row = body.providers.find((r: any) => r.provider_id === pA);
    assert.equal(row.accepted, 3);
    assert.equal(row.fields_correct, 11);
    assert.equal(row.fields_total, 12);
    assert.equal(row.spend_minor, 12);
    assert.equal(row.cost_per_accepted_minor, 4);
    assert.equal(row.coverage, "4/4");
    assert.equal(row.coverage_complete, true);
    assert.equal(row.small_sample_warning, true); // 4 < default threshold 20
    assert.equal(row.latency.n, 4);
    assert.ok(body.manifest_hash);
    assert.equal(body.comparison.suppressed.code, "min_observations");
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("T-012: one outstanding unpriced attempt makes aggregate cost efficiency unknown", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    fake.priceMinor = 3;
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const suiteId = await suiteWithPlan(env, actors, fake, ["", "", "", ""]);
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    const trialId = t.json.trial.id;
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);

    // inv-4 executes but returns an unverifiable receipt: output exists, charge unknown.
    fake.mode = "ok";
    const origHandle = (fake as any).handleOcr.bind(fake);
    (fake as any).handleOcr = (body: any, res: any) => {
      const ref = body.sample_key;
      const key4 = sha256hex("INVOICE 4 content").slice(0, 12);
      if (ref === key4) fake.mode = "bad_receipt"; else fake.mode = "ok";
      origHandle(body, res);
      fake.mode = "ok";
    };
    await api(env.port, actors.runner, "POST", "/internal/drain");

    const rep = await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);
    const row = rep.json.report.body.providers[0];
    assert.equal(row.attempted, 4);
    assert.equal(row.accepted, 3); // uncertain attempt does not count
    assert.equal(row.spend_minor, 9); // three verified charges only
    assert.equal(row.cost_state, "unknown");
    assert.equal(row.cost_per_accepted_minor, null);
    assert.equal(row.cost_unknown_reason, "unpriced_or_unverified_attempts");
  } finally {
    await fake.stop();
    await env.close();
  }
});
