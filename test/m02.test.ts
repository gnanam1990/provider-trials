import { test } from "node:test";
import assert from "node:assert/strict";
import { startEnv, api, makeAccount } from "./helpers.ts";
import { hmacSign } from "../src/lib/util.ts";

const LABELS = { date: "2026-01-15", tax: "1.50", total: "11.50" };

async function makeFrozenSuite(port: number, actors: any, samples = 4) {
  const s = await api(port, actors.steward, "POST", "/suites", { name: "tamil-invoices" });
  const suiteId = s.json.suite.id;
  for (let i = 1; i <= samples; i++) {
    const r = await api(port, actors.steward, "POST", `/suites/${suiteId}/versions/1/samples`, {
      sample_id: `inv-${i}`,
      content: `INVOICE ${i} தமிழ் நிறுவனம் total=11.50`,
      labels: { ...LABELS },
    });
    assert.equal(r.status, 201);
  }
  const f = await api(port, actors.steward, "POST", `/suites/${suiteId}/versions/1/freeze`);
  assert.equal(f.status, 200);
  return { suiteId, frozen: f.json.suite };
}

test("T-003: correcting one total creates a new suite version with a different manifest hash", async () => {
  const env = await startEnv();
  try {
    const actors = await makeAccount(env.port);
    const { suiteId, frozen } = await makeFrozenSuite(env.port, actors);
    const manifest1 = frozen.manifest_hash;
    assert.ok(manifest1 && manifest1.length === 64);

    // Silent edit on the frozen version is rejected (INV-02).
    const edit = await api(env.port, actors.steward, "POST",
      `/suites/${suiteId}/versions/1/samples/inv-1/correct`,
      { labels: { ...LABELS, total: "12.00" } });
    assert.equal(edit.status, 409);
    assert.equal(edit.error?.code ?? edit.json.error.code, "suite_frozen");

    // Correction path: new draft version, fix one label, refreeze.
    const v2 = await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions`);
    assert.equal(v2.status, 201);
    assert.equal(v2.json.suite.version, 2);

    const fix = await api(env.port, actors.steward, "POST",
      `/suites/${suiteId}/versions/2/samples/inv-1/correct`,
      { labels: { ...LABELS, total: "12.00" } });
    assert.equal(fix.status, 200);
    assert.notEqual(fix.json.sample.label_hash, undefined);

    const f2 = await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/2/freeze`);
    const manifest2 = f2.json.suite.manifest_hash;
    assert.ok(manifest2 && manifest2 !== manifest1);

    // Version 1 manifest is untouched.
    const v1 = await api(env.port, actors.steward, "GET", `/suites/${suiteId}?version=1`);
    assert.equal(v1.json.suite.manifest_hash, manifest1);
  } finally {
    await env.close();
  }
});

test("T-004: provider excluded by processor consent cannot receive the invoice or a signed URL", async () => {
  const env = await startEnv();
  try {
    const actors = await makeAccount(env.port);
    const s = await api(env.port, actors.steward, "POST", "/suites", { name: "restricted" });
    const suiteId = s.json.suite.id;
    const add = await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/samples`, {
      sample_id: "inv-x",
      content: "CONFIDENTIAL INVOICE",
      labels: LABELS,
      allowed_processors: ["prov_allowed_only"],
    });
    assert.equal(add.status, 201);
    const contentRef = env.db.get<any>(
      "SELECT content_ref FROM samples WHERE suite_id=? AND sample_id='inv-x'", suiteId).content_ref;

    // An excluded provider is denied a transport URL at issuance.
    const denied = await api(env.port, actors.runner, "POST",
      `/suites/${suiteId}/versions/1/samples/inv-x/transport`,
      { provider_id: "prov_evil" });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, "consent_excluded");

    // A consented provider gets a URL and can fetch the content.
    const ok = await api(env.port, actors.runner, "POST",
      `/suites/${suiteId}/versions/1/samples/inv-x/transport`,
      { provider_id: "prov_allowed_only" });
    assert.equal(ok.status, 200);
    const got = await fetch(ok.json.url);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "CONFIDENTIAL INVOICE");

    // The URL is provider-bound: swapping the provider id breaks the signature.
    const u = new URL(ok.json.url);
    u.searchParams.set("p", "prov_evil");
    const swapped = await fetch(u.toString());
    assert.equal(swapped.status, 403);

    // And a forged signature for the excluded provider is also refused: even a
    // correctly computed HMAC cannot pass the serve-time consent recheck.
    const exp = Date.now() + 60000;
    const forged = hmacSign(env.ctx.config.hmacSecret, `${contentRef}|prov_evil|${exp}`);
    const forgedRes = await fetch(
      `http://127.0.0.1:${env.port}/samples/${contentRef}?p=prov_evil&exp=${exp}&sig=${forged}`);
    assert.equal(forgedRes.status, 403);
    const j = await forgedRes.json();
    assert.equal(j.error.code, "consent_excluded");

    // Unsigned access is refused entirely.
    const bare = await fetch(`http://127.0.0.1:${env.port}/samples/${contentRef}`);
    assert.equal(bare.status, 403);
  } finally {
    await env.close();
  }
});
