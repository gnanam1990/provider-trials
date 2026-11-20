import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256hex } from "../src/lib/util.ts";
import { startEnv, api, makeAccount, FakeProvider, bindProvider } from "./helpers.ts";

const LABELS = { date: "2026-01-15", tax: "1.50", total: "11.50" };
const CONTENTS = [1, 2, 3, 4].map((i) => `INVOICE ${i} தமிழ்`);
const key = (i: number) => sha256hex(CONTENTS[i]).slice(0, 12);

async function consoleLogin(port: number, accountId: string, subject: string, role: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/console/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ account_id: accountId, subject, role }).toString(),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /pt_session=/);
  return cookie.split(";")[0];
}

async function getHtml(port: number, path: string, cookie?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, body: await res.text(), location: res.headers.get("location") };
}

/**
 * The reference acceptance scene: A accepts 3 invoices (11/12 fields, 12c),
 * B accepts 2 (9/12 fields, 10c) -> 4c vs 5c per accepted, coverage 4/4 each.
 */
test("T-015 + T-016: acceptance scene renders 4 vs 5 cents, 4/4 coverage, suppressed ranking", async () => {
  const env = await startEnv();
  const fakeA = await new FakeProvider().start();
  const fakeB = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    fakeA.priceMinor = 3;
    const pA = await bindProvider(env.port, actors.operator, fakeA, "provider-A");
    const pB = await bindProvider(env.port, actors.operator, fakeB, "provider-B");

    // Field plans: A 3/3/3/2, B 3/3/2/1 -> accepted 3 vs 2, fields 11 vs 9.
    fakeA.fieldPlan[key(0)] = { ...LABELS };
    fakeA.fieldPlan[key(1)] = { ...LABELS };
    fakeA.fieldPlan[key(2)] = { ...LABELS };
    fakeA.fieldPlan[key(3)] = { ...LABELS, total: "99.99" };
    fakeB.fieldPlan[key(0)] = { ...LABELS };
    fakeB.fieldPlan[key(1)] = { ...LABELS };
    fakeB.fieldPlan[key(2)] = { ...LABELS, total: "99.99" };
    fakeB.fieldPlan[key(3)] = { ...LABELS, tax: "9.99", total: "99.99" };
    // B's charges: 2+2+3+3 = 10c across its four attempts.
    fakeB.priceOverrides = { [key(0)]: 2, [key(1)]: 2, [key(2)]: 3, [key(3)]: 3 };

    const s = await api(env.port, actors.steward, "POST", "/suites", { name: "tamil-acceptance" });
    const suiteId = s.json.suite.id;
    for (let i = 0; i < 4; i++) {
      await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/samples`, {
        sample_id: `inv-${i + 1}`, content: CONTENTS[i], labels: LABELS,
      });
    }
    await api(env.port, actors.steward, "POST", `/suites/${suiteId}/versions/1/freeze`);

    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA, pB], budget_minor: 100,
      per_provider_cap_minor: 50, asset: "cent",
    });
    const trialId = t.json.trial.id;
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
    await api(env.port, actors.runner, "POST", "/internal/drain");

    const rep = await api(env.port, actors.analyst, "POST", `/trials/${trialId}/reports`);
    const body = rep.json.report.body;
    const rowA = body.providers.find((r: any) => r.provider_id === pA);
    const rowB = body.providers.find((r: any) => r.provider_id === pB);
    assert.equal(rowA.accepted, 3);
    assert.equal(rowA.fields_correct, 11);
    assert.equal(rowA.spend_minor, 12);
    assert.equal(rowA.cost_per_accepted_minor, 4);
    assert.equal(rowA.coverage, "4/4");
    assert.equal(rowB.accepted, 2);
    assert.equal(rowB.fields_correct, 9);
    assert.equal(rowB.spend_minor, 10);
    assert.equal(rowB.cost_per_accepted_minor, 5);
    assert.equal(rowB.coverage, "4/4");

    // T-016: four observed samples < 20 configured minimum -> no ordered ranking.
    assert.equal(body.comparison.ranked, null);
    assert.equal(body.comparison.suppressed.code, "min_observations");
    assert.equal(body.comparison.suppressed.observed, 4);

    // Browser surface: unauthenticated hits the login redirect.
    const anon = await getHtml(env.port, "/console");
    assert.equal(anon.status, 303);
    assert.equal(anon.location, "/console/login");

    // Analyst session renders the comparison rows with evidence qualifiers.
    const cookie = await consoleLogin(env.port, actors.analyst.accountId, "analyst", "analyst");
    const page = await getHtml(env.port, `/console/reports/${rep.json.report.id}`, cookie);
    assert.equal(page.status, 200);
    assert.match(page.body, /4¢/);
    assert.match(page.body, /5¢/);
    assert.equal((page.body.match(/4\/4/g) ?? []).length >= 2, true);
    assert.match(page.body, /small-sample warning/);
    assert.match(page.body, /suppressed: min_observations/);
    assert.match(page.body, /Accepted\/Attempted/);

    // Field drill-down is reachable and redacted.
    const fields = await getHtml(env.port,
      `/console/reports/${rep.json.report.id}/fields?provider_id=${pA}`, cookie);
    assert.equal(fields.status, 200);
    assert.match(fields.body, /amount_mismatch/);
    assert.match(fields.body, /Redacted field-level outcomes/);

    // A different tenant's analyst gets nothing.
    const other = await makeAccount(env.port, "other");
    const otherCookie = await consoleLogin(env.port, other.analyst.accountId, "analyst", "analyst");
    const denied = await getHtml(env.port, `/console/reports/${rep.json.report.id}`, otherCookie);
    assert.equal(denied.status, 404);
  } finally {
    await fakeA.stop();
    await fakeB.stop();
    await env.close();
  }
});
