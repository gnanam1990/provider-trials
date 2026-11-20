// Local demo: boots the app + two provider emulators, seeds the reference
// acceptance scene, and prints the console URL + analyst login. Ctrl-C to stop.
import { startEnv, api, makeAccount, FakeProvider, bindProvider } from "../test/helpers.ts";
import { sha256hex } from "../src/lib/util.ts";

const LABELS = { date: "2026-01-15", tax: "1.50", total: "11.50" };
const CONTENTS = [1, 2, 3, 4].map((i) => `INVOICE ${i} தமிழ்`);
const key = (i) => sha256hex(CONTENTS[i]).slice(0, 12);

const env = await startEnv();
const fakeA = await new FakeProvider().start();
const fakeB = await new FakeProvider().start();
const actors = await makeAccount(env.port);

fakeA.priceMinor = 3;
const pA = await bindProvider(env.port, actors.operator, fakeA, "provider-A");
const pB = await bindProvider(env.port, actors.operator, fakeB, "provider-B");

fakeA.fieldPlan[key(0)] = { ...LABELS };
fakeA.fieldPlan[key(1)] = { ...LABELS };
fakeA.fieldPlan[key(2)] = { ...LABELS };
fakeA.fieldPlan[key(3)] = { ...LABELS, total: "99.99" };
fakeB.fieldPlan[key(0)] = { ...LABELS };
fakeB.fieldPlan[key(1)] = { ...LABELS };
fakeB.fieldPlan[key(2)] = { ...LABELS, total: "99.99" };
fakeB.fieldPlan[key(3)] = { ...LABELS, tax: "9.99", total: "99.99" };
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

console.log(`console:  http://127.0.0.1:${env.port}/console`);
console.log(`report:   http://127.0.0.1:${env.port}/console/reports/${rep.json.report.id}`);
console.log(`trial:    ${trialId}`);
console.log(`login:    account_id=${actors.analyst.accountId} subject=analyst role=analyst`);
console.log("(waiting — Ctrl-C to stop)");
process.on("SIGINT", async () => { await fakeA.stop(); await fakeB.stop(); await env.close(); process.exit(0); });
setInterval(() => {}, 60_000);
