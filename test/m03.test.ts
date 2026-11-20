import { test } from "node:test";
import assert from "node:assert/strict";
import { startEnv, api, makeAccount, FakeProvider, bindProvider, rebindProvider, makeFrozenSuite } from "./helpers.ts";

test("T-005: two eligible providers x four frozen samples -> eight distinct cells after replay", async () => {
  const env = await startEnv();
  const fakeA = await new FakeProvider().start();
  const fakeB = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fakeA, "A");
    const pB = await bindProvider(env.port, actors.operator, fakeB, "B");
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 4 });

    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId,
      provider_ids: [pA, pB],
      budget_minor: 100,
      per_provider_cap_minor: 50,
      asset: "cent",
    });
    assert.equal(t.status, 201);
    const trialId = t.json.trial.id;

    const run = await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`, {}, {
      "idempotency-key": "run-1",
    });
    assert.equal(run.status, 200);
    assert.equal(run.json.cells_created, 8);
    assert.equal(run.json.reserved, 8);

    // Command replay under the same key returns the stored operation; no new cells.
    const replay = await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`, {}, {
      "idempotency-key": "run-1",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    const cellCount = env.db.get<any>("SELECT COUNT(*) n FROM cells WHERE trial_id=?", trialId).n;
    assert.equal(cellCount, 8);
    const distinct = env.db.get<any>(
      "SELECT COUNT(DISTINCT provider_id || '|' || sample_id) n FROM cells WHERE trial_id=?", trialId).n;
    assert.equal(distinct, 8);

    // Same command under a different key also cannot duplicate the matrix.
    const again = await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
    assert.equal(again.status, 200);
    assert.equal(env.db.get<any>("SELECT COUNT(*) n FROM cells WHERE trial_id=?", trialId).n, 8);

    // Conflicting payload under the original key is a conflict.
    const conflict = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA], budget_minor: 5, per_provider_cap_minor: 5, asset: "cent",
    }, { "idempotency-key": "create-1" });
    assert.equal(conflict.status, 201);
    const conflictReplay = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId, provider_ids: [pA, pB], budget_minor: 9, per_provider_cap_minor: 9, asset: "cent",
    }, { "idempotency-key": "create-1" });
    assert.equal(conflictReplay.status, 409);
    assert.equal(conflictReplay.json.error.code, "idempotency_conflict");
  } finally {
    await fakeA.stop();
    await fakeB.stop();
    await env.close();
  }
});

test("T-006: binding expiring before dispatch blocks cells and reduces coverage", async () => {
  // Attestation lifetime of 1s: valid at expansion, dead at dispatch.
  const env = await startEnv({ bindingTtlMs: 1000 });
  const fakeA = await new FakeProvider().start();
  const fakeB = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const pA = await bindProvider(env.port, actors.operator, fakeA, "A");
    const pB = await bindProvider(env.port, actors.operator, fakeB, "B");
    const suiteId = await makeFrozenSuite(env.port, actors, { n: 4 });
    const t = await api(env.port, actors.lead, "POST", "/trials", {
      suite_id: suiteId,
      provider_ids: [pA, pB],
      budget_minor: 100,
      per_provider_cap_minor: 50,
      asset: "cent",
    });
    const trialId = t.json.trial.id;
    await api(env.port, actors.runner, "POST", `/trials/${trialId}/run`);
    assert.equal(
      env.db.get<any>("SELECT COUNT(*) n FROM cells WHERE trial_id=? AND state='reserved'", trialId).n,
      8,
    );

    // Both attestations lapse; B re-enrols with a fresh proof before dispatch,
    // A does not. A's reserved cells must block at dispatch time.
    env.advance(2000);
    await rebindProvider(env.port, actors.operator, fakeB, pB);
    const drain = await api(env.port, actors.runner, "POST", "/internal/drain");
    assert.equal(drain.status, 200);

    const cov = await api(env.port, actors.analyst, "GET", `/trials/${trialId}/coverage`);
    const rowA = cov.json.coverage.providers.find((p: any) => p.provider_id === pA);
    const rowB = cov.json.coverage.providers.find((p: any) => p.provider_id === pB);
    assert.equal(rowA.coverage, "0/4");
    assert.equal(rowA.blocked_reasons.binding_expired, 4);
    assert.equal(rowB.coverage, "4/4");
    assert.equal(rowB.blocked_reasons.binding_expired ?? 0, 0);

    // B's provider shows expired attestation; historical binding stays on record.
    const pAview = await api(env.port, actors.operator, "GET", `/providers/${pA}`);
    assert.equal(pAview.json.provider.state, "expired");
    assert.equal(pAview.json.provider.bindings[0].state, "expired");
  } finally {
    await fakeA.stop();
    await fakeB.stop();
    await env.close();
  }
});
