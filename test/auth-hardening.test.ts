import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { defaultConfig } from "../src/context.ts";
import { signingPayload } from "../src/domain/providers.ts";
import { generateEd25519 } from "../src/lib/util.ts";
import { startEnv, api, makeAccount, FakeProvider } from "./helpers.ts";

const postForm = async (port: number, path: string, fields: Record<string, string>, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") ?? "", location: res.headers.get("location") };
};

const getHtml = async (port: number, path: string, cookie?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: cookie ? { cookie } : {}, redirect: "manual",
  });
  return { status: res.status, body: await res.text(), location: res.headers.get("location") };
};

test("H-01: API identity requires a verified member credential; role headers are ignored", async () => {
  const env = await startEnv();
  try {
    const actors = await makeAccount(env.port);
    // Valid credential authenticates with the enrolled role.
    const ok = await api(env.port, actors.steward, "GET", "/providers");
    assert.equal(ok.status, 200);
    // Missing credential -> 401, even with the old claim headers present.
    const noCred = await api(env.port, null, "GET", "/providers", undefined, {
      "x-pt-account": actors.steward.accountId,
      "x-pt-subject": "steward",
      "x-pt-role": "dataset_steward",
    });
    assert.equal(noCred.status, 401);
    // Wrong credential -> 401.
    const badCred = await api(env.port, { ...actors.steward, credential: "cred_wrong" }, "GET", "/providers");
    assert.equal(badCred.status, 401);
    // Spoofed role header cannot escalate: analyst credential + steward claim.
    const spoof = await api(env.port, actors.analyst, "POST", "/suites", { name: "x" }, {
      "x-pt-role": "dataset_steward",
    });
    assert.equal(spoof.status, 403);
    // A role claim without credential is not a session either.
    const claimed = await api(env.port, { accountId: actors.lead.accountId, subject: "lead", role: "procurement_lead", credential: "" } as any,
      "GET", "/providers");
    assert.equal(claimed.status, 401);
  } finally {
    await env.close();
  }
});

test("H-02: console login requires the member credential; demo shortcut is gated by PT_DEMO", async () => {
  const env = await startEnv();
  try {
    const actors = await makeAccount(env.port);
    // Normal mode: no demo section on the login page.
    const login = await getHtml(env.port, "/console/login");
    assert.equal(login.status, 200);
    assert.equal(login.body.includes("demo_member"), false);
    // Missing and wrong credentials are rejected.
    const missing = await postForm(env.port, "/console/login", {
      account_id: actors.analyst.accountId, subject: "analyst",
    });
    assert.equal(missing.status, 403);
    const wrong = await postForm(env.port, "/console/login", {
      account_id: actors.analyst.accountId, subject: "analyst", credential: "cred_nope",
    });
    assert.equal(wrong.status, 403);
    // Correct credential -> session for the enrolled role.
    const good = await postForm(env.port, "/console/login", {
      account_id: actors.analyst.accountId, subject: "analyst", credential: actors.analyst.credential,
    });
    assert.equal(good.status, 303);
    assert.match(good.cookie, /pt_session=/);
    const queue = await getHtml(env.port, "/console", good.cookie.split(";")[0]);
    assert.equal(queue.status, 200);
    // Demo shortcut refused while PT_DEMO is unset.
    const demo = await postForm(env.port, "/console/login", {
      demo_member: `${actors.analyst.accountId}|analyst|analyst`,
    });
    assert.equal(demo.status, 403);
  } finally {
    await env.close();
  }

  const demoEnv = await startEnv({ demoMode: true } as any);
  try {
    const actors = await makeAccount(demoEnv.port);
    const login = await getHtml(demoEnv.port, "/console/login");
    assert.match(login.body, /demo_member/);
    const demo = await postForm(demoEnv.port, "/console/login", {
      demo_member: `${actors.analyst.accountId}|analyst|analyst`,
    });
    assert.equal(demo.status, 303);
    assert.match(demo.cookie, /pt_session=/);
  } finally {
    await demoEnv.close();
  }
});

test("H-03: console bind accepts only challenge + signature, never a private key", async () => {
  const env = await startEnv();
  const fake = await new FakeProvider().start();
  try {
    const actors = await makeAccount(env.port);
    const reg = await api(env.port, actors.operator, "POST", "/providers", {
      name: "provider-console",
      endpoint_origin: fake.origin,
      key_id: fake.keyId,
      public_key_pem: fake.keys.publicKeyPem,
    });
    const providerId = reg.json.provider.id;
    const login = await postForm(env.port, "/console/login", {
      account_id: actors.operator.accountId, subject: "operator", credential: actors.operator.credential,
    });
    const cookie = login.cookie.split(";")[0];

    // Issue the challenge through the console; the page shows what to sign.
    const issued = await postForm(env.port, `/console/providers/${providerId}/challenge`, {}, cookie);
    assert.equal(issued.status, 303);
    assert.match(issued.location ?? "", /challenge=chal_/);
    const page = await getHtml(env.port, issued.location!, cookie);
    assert.match(page.body, /PT-BINDING-v1/);
    assert.match(page.body, /Submit signature/);
    assert.equal(page.body.includes("private_key"), false);
    assert.equal(page.body.includes("Private key (PEM)"), false);

    // The operator signs locally (throwaway fixture key); the console takes
    // only challenge_id + signature — the same semantics as the API binding.
    const chRow = env.db.get<any>("SELECT * FROM challenges WHERE provider_id=? ORDER BY rowid DESC", providerId);
    fake.nonce = chRow.nonce;
    const payload = signingPayload(chRow.nonce, chRow.origin, fake.keyId, chRow.expires_at);
    const signature = crypto.sign(null, Buffer.from(payload, "utf8"), fake.keys.privateKeyPem).toString("base64url");
    const bound = await postForm(env.port, `/console/providers/${providerId}/bind`, {
      challenge_id: chRow.id, signature,
    }, cookie);
    assert.equal(bound.status, 303);
    const after = await api(env.port, actors.operator, "GET", `/providers/${providerId}`);
    assert.equal(after.json.provider.state, "bound");

    // A private key is refused outright.
    const keys = generateEd25519();
    const refused = await postForm(env.port, `/console/providers/${providerId}/bind`, {
      private_key_pem: keys.privateKeyPem,
    }, cookie);
    assert.equal(refused.status, 400);
    assert.match(refused.body, /private_key_not_accepted|Private keys are never accepted/);
  } finally {
    await fake.stop();
    await env.close();
  }
});

test("H-04: session signing key is never a shared compile-time default", () => {
  const a = defaultConfig({});
  const b = defaultConfig({});
  assert.notEqual(a.hmacSecret, "dev-only-hmac-secret");
  assert.notEqual(a.hmacSecret, b.hmacSecret);
  const pinned = defaultConfig({ PT_HMAC_SECRET: "explicit-secret" });
  assert.equal(pinned.hmacSecret, "explicit-secret");
});
