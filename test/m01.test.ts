import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startEnv, api, makeAccount, FakeProvider } from "./helpers.ts";

function sign(payload: string, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64url");
}

test("T-001: provider signs challenge and serves nonce from declared origin -> binding valid", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const reg = await api(env.port, actors.operator, "POST", "/providers", {
      name: "OCR-A",
      endpoint_origin: fake.origin,
      key_id: fake.keyId,
      public_key_pem: fake.keys.publicKeyPem,
    });
    assert.equal(reg.status, 201);
    const providerId = reg.json.provider.id;
    assert.equal(reg.json.provider.state, "unverified");

    const ch = await api(env.port, actors.operator, "POST", `/providers/${providerId}/challenges`);
    assert.equal(ch.status, 201);
    const challenge = ch.json.challenge;
    assert.equal(challenge.serve_at, `${fake.origin}/.well-known/provider-trials/nonce`);

    // Provider publishes the nonce at its declared origin and signs the payload.
    fake.nonce = challenge.nonce;
    const signature = sign(challenge.signing_payload, fake.keys.privateKeyPem);

    const bind = await api(env.port, actors.operator, "POST", `/providers/${providerId}/bindings`, {
      challenge_id: challenge.challenge_id,
      signature,
    });
    assert.equal(bind.status, 201, JSON.stringify(bind.json));
    assert.equal(bind.json.binding.state, "valid");
    assert.equal(bind.json.binding.origin, fake.origin);
    assert.equal(bind.json.binding.key_id, fake.keyId);

    const after = await api(env.port, actors.operator, "GET", `/providers/${providerId}`);
    assert.equal(after.json.provider.state, "bound");
    const auditRows = env.db.all("SELECT decision_code FROM audit_log WHERE entity_id=?", providerId);
    assert.ok(auditRows.some((r: any) => r.decision_code === "binding_valid"));
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("T-002: valid signature with nonce hosted on another origin is rejected; nonce not replayable", async () => {
  const env = await startEnv();
  const fakeDeclared = await new FakeProvider().start();
  const fakeOther = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const reg = await api(env.port, actors.operator, "POST", "/providers", {
      name: "OCR-B",
      endpoint_origin: fakeDeclared.origin,
      key_id: fakeDeclared.keyId,
      public_key_pem: fakeDeclared.keys.publicKeyPem,
    });
    const providerId = reg.json.provider.id;

    const ch = await api(env.port, actors.operator, "POST", `/providers/${providerId}/challenges`);
    const challenge = ch.json.challenge;

    // The nonce is hosted on a *different* origin; the declared origin serves nothing.
    fakeOther.nonce = challenge.nonce;
    const signature = sign(challenge.signing_payload, fakeDeclared.keys.privateKeyPem);

    const bind = await api(env.port, actors.operator, "POST", `/providers/${providerId}/bindings`, {
      challenge_id: challenge.challenge_id,
      signature,
    });
    assert.equal(bind.status, 403);
    assert.equal(bind.json.error.code, "nonce_not_served");

    // Provider remains unverified and no binding was persisted.
    const p = await api(env.port, actors.operator, "GET", `/providers/${providerId}`);
    assert.equal(p.json.provider.state, "unverified");
    assert.equal(p.json.provider.bindings.length, 0);

    // The nonce/challenge cannot be replayed even with the valid signature.
    fakeDeclared.nonce = challenge.nonce;
    const replay = await api(env.port, actors.operator, "POST", `/providers/${providerId}/bindings`, {
      challenge_id: challenge.challenge_id,
      signature,
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error.code, "challenge_used");
  } finally {
    await fakeDeclared.stop();
    await fakeOther.stop();
    await env.close();
  }
});
