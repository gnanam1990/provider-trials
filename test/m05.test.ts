import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256hex } from "../src/lib/util.ts";
import { scoreExtraction } from "../src/domain/scoring.ts";
import { startEnv, api, makeAccount, FakeProvider, bindProvider, makeFrozenSuite } from "./helpers.ts";

function sampleKey(content: string): string {
  return sha256hex(content).slice(0, 12);
}

test("T-009: 11 correct fields across four three-field invoices (3/3/3/2) yields 3 accepted", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const labels = { date: "2026-01-15", tax: "1.50", total: "11.50" };
    const contents = [1, 2, 3, 4].map((i) => `INVOICE ${i} body`);
    const s = await api(env.port, actors.steward, "POST", "/suites", { name: "scoring" });
    const suiteId = s.json.suite.id;
    for (let i = 0; i < 4; i++) {
      await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/samples`, {
        sample_id: `inv-${i + 1}`, content: contents[i], labels,
      });
    }
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/freeze`);

    // Provider answers 3/3/3/2: inv-4 gets 'total' wrong.
    const right = { ...labels };
    for (let i = 0; i < 4; i++) {
      fake.fieldPlan[sampleKey(contents[i])] =
        i < 3 ? right : { ...labels, total: "99.99" };
    }
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    await api(env.port, actors.runner, "POST", `/trials/${t.json.trial.id}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");

    const ms = env.db.all<any>(
      `SELECT m.*, a.sample_id FROM measurements m JOIN attempts a ON a.id=m.attempt_id
       WHERE a.trial_id=? ORDER BY a.sample_id`, t.json.trial.id);
    assert.equal(ms.length, 4);
    assert.deepEqual(ms.map((m) => m.fields_correct), [3, 3, 3, 2]);
    assert.deepEqual(ms.map((m) => m.accepted), [1, 1, 1, 0]);
    const accepted = ms.filter((m) => m.accepted === 1).length;
    assert.equal(accepted, 3);
    const totals = ms.reduce((a, m) => a + m.fields_correct, 0);
    assert.equal(totals, 11);
    const bad = JSON.parse(ms[3].field_results_json).find((f: any) => f.outcome !== "correct");
    assert.equal(bad.field, "total");
    assert.equal(bad.outcome, "amount_mismatch");
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("T-010: ambiguous day/month date without an allowed format is not silently correct", async () => {
  // Direct unit check of the manifest-pinned date rule.
  const dual = { unicode: "NFC", dateFormats: ["DD-MM-YYYY", "MM-DD-YYYY"], money: { decimalSeparator: "." } };
  const r = scoreExtraction(
    { date: "2026-03-04", tax: "1.00", total: "5.00" },
    { date: "04-03-2026", tax: "1.00", total: "5.00" },
    dual,
    ["date", "tax", "total"],
  );
  const dateOutcome = r.fieldResults.find((f) => f.field === "date")!;
  assert.equal(dateOutcome.outcome, "date_ambiguous");
  assert.equal(r.accepted, false);

  // And a value in a disallowed format is rejected, not guessed.
  const isoOnly = { unicode: "NFC", dateFormats: ["YYYY-MM-DD"], money: { decimalSeparator: "." } };
  const r2 = scoreExtraction(
    { date: "2026-03-04", tax: "1.00", total: "5.00" },
    { date: "04/03/2026", tax: "1.00", total: "5.00" },
    isoOnly,
    ["date", "tax", "total"],
  );
  assert.equal(r2.fieldResults.find((f) => f.field === "date")!.outcome, "date_format_not_allowed");
  assert.equal(r2.accepted, false);

  // End-to-end: ambiguous response under a dual-format manifest fails the field.
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    const suiteId = await makeFrozenSuite(env.port, actors, {
      n: 1,
      labels: { date: "2026-03-04", tax: "1.00", total: "5.00" },
      normalizer_config: { unicode: "NFC", dateFormats: ["DD-MM-YYYY", "MM-DD-YYYY"], money: { decimalSeparator: "." } },
    });
    const contentRef = env.db.get<any>("SELECT content_hash FROM samples WHERE suite_id=?", suiteId).content_hash;
    fake.fieldPlan[contentRef.slice(0, 12)] = { date: "04-03-2026", tax: "1.00", total: "5.00" };
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    await api(env.port, actors.runner, "POST", `/trials/${t.json.trial.id}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");
    const m = env.db.get<any>(
      `SELECT m.* FROM measurements m JOIN attempts a ON a.id=m.attempt_id WHERE a.trial_id=?`,
      t.json.trial.id);
    assert.equal(m.accepted, 0);
    const fr = JSON.parse(m.field_results_json).find((f: any) => f.field === "date");
    assert.equal(fr.outcome, "date_ambiguous");
  } finally {
    await fake.stop();
    await env.close();
  }
});
