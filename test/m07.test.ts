import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateEd25519 } from "../src/lib/util.ts";
import { startEnv, api, makeAccount, FakeProvider, bindProvider, rebindProvider, makeFrozenSuite } from "./helpers.ts";

const LABELS = { date: "2026-01-15", tax: "1.50", total: "11.50" };

async function runCompleteTrial(env: any, actors: any, providerId: string, suiteId: string, extra: any = {}) {
  const t = await api(env.port, actors.lead, "POST", "/trials", {
    suite_id: suiteId, provider_ids: [providerId], budget_minor: 100,
    per_provider_cap_minor: 50, asset: "cent", ...extra,
  });
  const trialId = t.json.trial.id;
  await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
  await api(env.port, actors.runner, "POST", "/internal/drain");
  return trialId;
}

test("T-013: rebuilding an issued report from its cursor is identical, even after restart", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-test-"));
  const dbPath = join(dir, "pt.db");
  const fake = await new FakeProvider().start();
  let env = await startEnv({}, dbPath);
  let reportId: string;
  let actors: any;
  try {
    actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    fake.defaultFields = { ...LABELS };
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 4, labels: LABELS });
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    const trialId = t.json.trial.id;
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");
    const rep = await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);
    reportId = rep.json.report.id;
    const rb = await api(env.port, actors.analyst, "POST", `/reports/${reportId}/rebuild`);
    assert.equal(rb.json.identical, true);
  } finally {
    await env.close();
  }
  // Process restart: fresh server over the same database file. The enrolled
  // member credential still authenticates — it survives in the file database.
  const env2 = await startEnv({}, dbPath);
  try {
    const r2 = await api(env2.port, actors.lead, "GET", `/reports/${reportId}`);
    assert.equal(r2.status, 200);
    const rb2 = await api(env2.port, actors.lead, "POST", `/reports/${reportId}/rebuild`);
    assert.equal(rb2.json.identical, true);
    assert.equal(r2.json.report.body.manifest_hash.length, 64);
  } finally {
    await fake.stop();
    await env2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-014: label correction or key rotation cannot rewrite a report or transfer its score", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    fake.defaultFields = { ...LABELS };
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 4, labels: LABELS });
    const trialId = await runCompleteTrial(env, actors, pA, suiteId);
    const rep = await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);
    const reportId = rep.json.report.id;
    const originalRow = rep.json.report.body.providers[0];
    const oldBindingId = originalRow.bindings[0].id;
    const oldKeyId = originalRow.bindings[0].key_id;
    const manifest1 = rep.json.report.body.manifest_hash;

    // 1) Label correction lands in a NEW suite version; report untouched.
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions`);
    const fix = await api(env.port, actors.steward, "POST",
      `/suites/${suiteId}/versions/2/samples/inv-1/correct`,
      { labels: { ...LABELS, total: "99.00" } });
    assert.equal(fix.status, 200);
    const f2 = await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/2/freeze`);
    assert.notEqual(f2.json.suite.manifest_hash, manifest1);
    let rb = await api(env.port, actors.analyst, "POST", `/reports/${reportId}/rebuild`);
    assert.equal(rb.json.identical, true);

    // 2) Key rotation revokes the binding; report still credits the old binding.
    const newKeys = generateEd25519();
    const rot = await api(env.port, actors.operator, "POST", `/providers/${pA}/rotate`, {
      key_id: "k2", public_key_pem: newKeys.publicKeyPem,
    });
    assert.equal(rot.status, 200);
    assert.equal(rot.json.provider.state, "unverified");
    const rb2 = await api(env.port, actors.analyst, "POST", `/reports/${reportId}/rebuild`);
    assert.equal(rb2.json.identical, true);
    const rep2 = await api(env.port, actors.analyst, "GET", `/reports/${reportId}`);
    assert.equal(rep2.json.report.body.providers[0].bindings[0].id, oldBindingId);
    assert.equal(rep2.json.report.body.providers[0].bindings[0].key_id, oldKeyId);

    // 3) Fresh enrollment under the new key creates new evidence identity only.
    fake.keys = newKeys;
    fake.keyId = "k2";
    await rebindProvider(env.port, actors.operator, fake, pA);
    const t2 = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    await api(env.port, actors.runner, "POST", `/trials/${t2.json.trial.id}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");
    const newBinding = env.db.get<any>(
      "SELECT binding_id FROM attempts WHERE trial_id=? LIMIT 1", t2.json.trial.id).binding_id;
    assert.notEqual(newBinding, oldBindingId);
    const rep3 = await api(env.port, actors.analyst, "GET", `/reports/${reportId}`);
    assert.equal(rep3.json.report.body.providers[0].bindings.length, 1);
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("M07-extra: recurring rerun, quality curve, export and tenant isolation", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fake, "A");
    fake.defaultFields = { ...LABELS };
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 2, labels: LABELS });
    const trialId = await runCompleteTrial(env, actors, pA, suiteId, { recurring: { enabled: true } });
    await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);

    // Non-opted-in trials refuse rerun; opted-in gets the latest frozen version.
    const tPlain = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 10,
      per_provider_cap_minor: 10, asset: "cent",
    });
    const deny = await api(env.port, actors.runner, "POST", `/trials/${tPlain.json.trial.id}/rerun`);
    assert.equal(deny.status, 409);
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions`);
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/2/samples/inv-1/correct`,
      { labels: { ...LABELS, total: "12.50" } });
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/2/freeze`);
    const rerun = await api(env.port, actors.runner, "POST", `/trials/${trialId}/rerun`);
    assert.equal(rerun.status, 201);
    assert.equal(rerun.json.trial.suite_version, 2);

    // Run the rerun and issue a second report -> two curve points, one series.
    await api(env.port, actors.runner, "POST", `/trials/${rerun.json.trial.id}/run`);
    fake.defaultFields = { ...LABELS, total: "12.50" };
    await api(env.port, actors.runner, "POST", "/internal/drain");
    await api(env.port, actors.analyst, "POST", `/trials/${rerun.json.trial.id}/reports`);
    const curve = await api(env.port, actors.analyst,
      "GET", `/providers/${pA}/quality-curve?suite_id=${suiteId}`);
    assert.equal(curve.json.series.length, 1);
    assert.equal(curve.json.series[0].points.length, 2);
    assert.equal(curve.json.series[0].points[0].suite_version, 1);
    assert.equal(curve.json.series[0].points[1].suite_version, 2);

    // Export both formats; a different tenant cannot read the report.
    const list = await api(env.port, actors.analyst, "GET", `/trials/${trialId}/reports`);
    const repId = list.json.reports[0].id;
    const j = await api(env.port, actors.analyst, "GET", `/reports/${repId}/export?format=json`);
    assert.equal(j.status, 200);
    const c = await api(env.port, actors.analyst, "GET", `/reports/${repId}/export?format=csv`);
    assert.match(c.body, /cost_per_accepted_minor/);

    const other = await makeAccount(env.port, "other-buyer");
    const denied = await api(env.port, other.analyst, "GET", `/reports/${repId}`);
    assert.equal(denied.status, 404);
    const deniedFields = await api(env.port, other.analyst, "GET", `/reports/${repId}/fields?provider_id=${pA}`);
    assert.equal(deniedFields.status, 404);
  } finally {
    await fake.stop();
    await env.close();
  }
});
