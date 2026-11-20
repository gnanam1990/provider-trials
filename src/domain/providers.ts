import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor } from "../auth.ts";
import { audit } from "../audit.ts";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../lib/errors.ts";
import { fetchUrl, normalizeOrigin, originAllowed } from "../lib/httpClient.ts";
import { newId, secureCompare, sha256hex, verifyEd25519 } from "../lib/util.ts";

export const NONCE_PATH = "/.well-known/provider-trials/nonce";

export interface ProviderRow {
  id: string;
  account_id: string;
  owner_subject: string;
  name: string;
  endpoint_origin: string;
  key_id: string;
  public_key_pem: string;
  state: string;
  created_at: string;
}

export function getProvider(ctx: Ctx, id: string): ProviderRow {
  const p = ctx.db.get<ProviderRow>("SELECT * FROM providers WHERE id=?", id);
  if (!p) throw notFound("provider");
  return p;
}

export function listProviders(ctx: Ctx, accountId: string): ProviderRow[] {
  return ctx.db.all<ProviderRow>(
    "SELECT * FROM providers WHERE account_id=? ORDER BY created_at",
    accountId,
  );
}

export function registerProvider(
  ctx: Ctx,
  actor: Actor,
  input: { name: string; endpoint_origin: string; key_id: string; public_key_pem: string },
): ProviderRow {
  if (!input.name || !input.endpoint_origin || !input.key_id || !input.public_key_pem) {
    throw badRequest("missing_fields", "name, endpoint_origin, key_id and public_key_pem are required");
  }
  let origin: string;
  try {
    origin = normalizeOrigin(input.endpoint_origin);
  } catch {
    throw badRequest("invalid_origin", "endpoint_origin must be an http(s) origin");
  }
  if (!originAllowed(origin, ctx.config.allowedHosts)) {
    throw forbidden("origin_not_allowed", `origin ${origin} is outside the configured allowlist`);
  }
  const id = newId("prov");
  ctx.db.run(
    `INSERT INTO providers(id,account_id,owner_subject,name,endpoint_origin,key_id,public_key_pem,state,created_at)
     VALUES(?,?,?,?,?,?,?,'unverified',?)`,
    id,
    actor.accountId,
    actor.subject,
    input.name,
    origin,
    input.key_id,
    input.public_key_pem,
    iso(ctx),
  );
  audit(ctx, actor, "provider.register", "provider_registered", "provider", id, {
    origin,
    key_id: input.key_id,
  });
  return getProvider(ctx, id);
}

/** Issue a single-use challenge binding the nonce to the declared origin. */
export function createChallenge(ctx: Ctx, actor: Actor, providerId: string) {
  const p = getProvider(ctx, providerId);
  if (p.account_id !== actor.accountId) throw notFound("provider");
  const id = newId("chal");
  const nonce = newId("nonce");
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO challenges(id,provider_id,nonce,origin,issued_at,expires_at)
     VALUES(?,?,?,?,?,?)`,
    id,
    p.id,
    nonce,
    p.endpoint_origin,
    iso(ctx, now),
    iso(ctx, now + ctx.config.challengeTtlMs),
  );
  audit(ctx, actor, "provider.challenge", "challenge_issued", "provider", p.id, {
    challenge_id: id,
  });
  return {
    challenge_id: id,
    nonce,
    origin: p.endpoint_origin,
    expires_at: iso(ctx, now + ctx.config.challengeTtlMs),
    serve_at: `${p.endpoint_origin}${NONCE_PATH}`,
    signing_payload: signingPayload(nonce, p.endpoint_origin, p.key_id, iso(ctx, now + ctx.config.challengeTtlMs)),
  };
}

export function signingPayload(nonce: string, origin: string, keyId: string, expiry: string): string {
  return ["PT-BINDING-v1", nonce, origin, keyId, expiry].join("\n");
}

/**
 * Dual proof: (1) enrolled key signed the challenge payload; (2) the declared
 * origin serves the same nonce. Both must match — INV-01. The challenge is
 * single-use: any submission consumes it so a nonce cannot be replayed.
 */
export async function submitBinding(
  ctx: Ctx,
  actor: Actor,
  providerId: string,
  input: { challenge_id: string; signature: string },
): Promise<{ binding: any; decision: string }> {
  const p = getProvider(ctx, providerId);
  if (p.account_id !== actor.accountId) throw notFound("provider");
  const ch = ctx.db.get<any>(
    "SELECT * FROM challenges WHERE id=? AND provider_id=?",
    input.challenge_id,
    p.id,
  );
  if (!ch) throw notFound("challenge");
  if (ch.used_at) throw conflict("challenge_used", "challenge was already consumed");
  const now = ctx.now();
  if (Date.parse(ch.expires_at) <= now) {
    throw unprocessable("challenge_expired", "challenge expired before proof submission");
  }

  const payload = signingPayload(ch.nonce, ch.origin, p.key_id, ch.expires_at);
  const proofDigest = sha256hex(`${payload}\n${input.signature}`);

  // Consume the challenge first: it is single-use whether proof passes or not.
  ctx.db.run("UPDATE challenges SET used_at=? WHERE id=? AND used_at IS NULL", iso(ctx), ch.id);

  const sigOk = verifyEd25519(payload, input.signature, p.public_key_pem);
  if (!sigOk) {
    audit(ctx, actor, "provider.bind", "binding_rejected_bad_signature", "provider", p.id, {
      challenge_id: ch.id,
    });
    throw forbidden("bad_signature", "challenge signature does not verify against the enrolled key");
  }

  // Endpoint control: the declared origin itself must serve the nonce.
  let served: string | null = null;
  try {
    const r = await fetchUrl(`${ch.origin}${NONCE_PATH}`, {
      timeoutMs: ctx.config.dispatchTimeoutMs,
      allowedHosts: ctx.config.allowedHosts,
    });
    if (r.status === 200) served = (r.json?.nonce ?? r.body ?? "").toString().trim();
  } catch {
    served = null;
  }
  if (served === null || !secureCompare(served, ch.nonce)) {
    audit(ctx, actor, "provider.bind", "binding_rejected_nonce_mismatch", "provider", p.id, {
      challenge_id: ch.id,
      origin: ch.origin,
    });
    throw forbidden(
      "nonce_not_served",
      "declared origin did not serve the challenge nonce; origin control not proven",
    );
  }

  const binding = ctx.db.tx(() => {
    const id = newId("bind");
    const prev = ctx.db.get<any>(
      "SELECT id FROM bindings WHERE provider_id=? AND state='valid'",
      p.id,
    );
    if (prev) {
      ctx.db.run(
        "UPDATE bindings SET state='superseded', superseded_by=? WHERE id=?",
        id,
        prev.id,
      );
    }
    const validUntil = Math.min(
      now + ctx.config.bindingTtlMs,
      Date.parse(ch.expires_at) + ctx.config.bindingTtlMs,
    );
    ctx.db.run(
      `INSERT INTO bindings(id,provider_id,origin,nonce,challenge_id,proof_digest,key_id,valid_from,expires_at,state,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,'valid',?)`,
      id,
      p.id,
      ch.origin,
      ch.nonce,
      ch.id,
      proofDigest,
      p.key_id,
      iso(ctx, now),
      iso(ctx, validUntil),
      iso(ctx),
    );
    ctx.db.run("UPDATE providers SET state='bound' WHERE id=?", p.id);
    return ctx.db.get("SELECT * FROM bindings WHERE id=?", id);
  });
  audit(ctx, actor, "provider.bind", "binding_valid", "provider", p.id, {
    binding_id: binding.id,
    superseded: ctx.db.get("SELECT id FROM bindings WHERE provider_id=? AND state='superseded'", p.id)?.id,
  });
  return { binding, decision: "binding_valid" };
}

/** Expire bindings whose attestation window has closed. */
export function sweepExpiredBindings(ctx: Ctx): number {
  const rows = ctx.db.all<any>(
    "SELECT id, provider_id FROM bindings WHERE state='valid' AND expires_at<=?",
    iso(ctx),
  );
  for (const r of rows) {
    ctx.db.run("UPDATE bindings SET state='expired' WHERE id=?", r.id);
    const stillValid = ctx.db.get(
      "SELECT 1 AS x FROM bindings WHERE provider_id=? AND state='valid'",
      r.provider_id,
    );
    if (!stillValid) ctx.db.run("UPDATE providers SET state='expired' WHERE id=?", r.provider_id);
  }
  return rows.length;
}

/** The binding eligible for new dispatch right now, if any. */
export function activeBinding(ctx: Ctx, providerId: string): any | null {
  sweepExpiredBindings(ctx);
  return (
    ctx.db.get(
      "SELECT * FROM bindings WHERE provider_id=? AND state='valid' AND expires_at>?",
      providerId,
      iso(ctx),
    ) ?? null
  );
}

/**
 * Key or origin rotation invalidates the current binding (SECURITY.md):
 * existing attestation is revoked and fresh enrollment is required before
 * any new dispatch. Prior evidence stays pinned to the revoked binding.
 */
export function rotateProvider(
  ctx: Ctx,
  actor: Actor,
  providerId: string,
  input: { endpoint_origin?: string; key_id?: string; public_key_pem?: string },
): ProviderRow {
  const p = getProvider(ctx, providerId);
  if (p.account_id !== actor.accountId) throw notFound("provider");
  if (!input.endpoint_origin && !input.key_id && !input.public_key_pem) {
    throw badRequest("missing_fields", "endpoint_origin, key_id or public_key_pem is required");
  }
  let origin = p.endpoint_origin;
  if (input.endpoint_origin) {
    try {
      origin = normalizeOrigin(input.endpoint_origin);
    } catch {
      throw badRequest("invalid_origin", "endpoint_origin must be an http(s) origin");
    }
    if (!originAllowed(origin, ctx.config.allowedHosts)) {
      throw forbidden("origin_not_allowed", `origin ${origin} is outside the configured allowlist`);
    }
  }
  ctx.db.tx(() => {
    const valid = ctx.db.get<any>(
      "SELECT id FROM bindings WHERE provider_id=? AND state='valid'", p.id);
    if (valid) {
      ctx.db.run("UPDATE bindings SET state='revoked' WHERE id=?", valid.id);
    }
    ctx.db.run(
      "UPDATE providers SET endpoint_origin=?, key_id=?, public_key_pem=?, state='unverified' WHERE id=?",
      origin,
      input.key_id ?? p.key_id,
      input.public_key_pem ?? p.public_key_pem,
      p.id,
    );
  });
  audit(ctx, actor, "provider.rotate", "binding_revoked_rotation", "provider", p.id, {
    origin_changed: input.endpoint_origin !== undefined,
    key_changed: input.key_id !== undefined || input.public_key_pem !== undefined,
  });
  return getProvider(ctx, providerId);
}

export function publicProviderView(ctx: Ctx, p: ProviderRow) {
  const bindings = ctx.db.all(
    "SELECT id,origin,key_id,state,valid_from,expires_at,superseded_by FROM bindings WHERE provider_id=? ORDER BY created_at",
    p.id,
  );
  return {
    id: p.id,
    name: p.name,
    state: p.state,
    endpoint_origin: p.endpoint_origin,
    key_id: p.key_id,
    owner_subject: p.owner_subject,
    bindings,
  };
}
