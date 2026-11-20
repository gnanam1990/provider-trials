import type { Ctx } from "../context.ts";
import { iso } from "../context.ts";
import type { Actor } from "../auth.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { canonicalJson, hmacSign, newId, secureCompare, sha256hex } from "../lib/util.ts";

export const ALL_BOUND = "ALL_BOUND";

export const DEFAULT_NORMALIZER = {
  unicode: "NFC",
  dateFormats: ["YYYY-MM-DD"],
  money: { decimalSeparator: ".", thousandsSeparator: ",", currency: "USD" },
};
export const DEFAULT_NORMALIZER_VERSION = "norm-1";
export const DEFAULT_MANDATORY_FIELDS = ["date", "tax", "total"];

export function getSuiteVersion(ctx: Ctx, id: string, version: number): any {
  const s = ctx.db.get(
    "SELECT * FROM suites WHERE id=? AND version=?",
    id,
    version,
  );
  if (!s) throw notFound("suite version");
  return s;
}

export function latestVersion(ctx: Ctx, id: string): number {
  const r = ctx.db.get<any>("SELECT MAX(version) AS v FROM suites WHERE id=?", id);
  if (!r || r.v === null) throw notFound("suite");
  return r.v;
}

export function listSuites(ctx: Ctx, accountId: string) {
  return ctx.db.all(
    "SELECT * FROM suites WHERE account_id=? ORDER BY id, version",
    accountId,
  );
}

export function createSuite(
  ctx: Ctx,
  actor: Actor,
  input: {
    name: string;
    task?: string;
    normalizer_config?: unknown;
    normalizer_version?: string;
    consent_policy?: unknown;
    mandatory_fields?: string[];
  },
): any {
  if (!input.name) throw badRequest("missing_fields", "name is required");
  const id = newId("suite");
  const normalizer = input.normalizer_config ?? DEFAULT_NORMALIZER;
  const consent = input.consent_policy ?? { classification: "redacted", processors: "per-sample" };
  const mandatory = input.mandatory_fields ?? DEFAULT_MANDATORY_FIELDS;
  ctx.db.run(
    `INSERT INTO suites(id,version,account_id,name,task,manifest_hash,normalizer_version,
       normalizer_config_json,consent_policy_json,mandatory_fields_json,state,created_at)
     VALUES(?,1,?,?,?,?,?,?,?,?,'draft',?)`,
    id,
    actor.accountId,
    input.name,
    input.task ?? "invoice-ocr",
    "",
    input.normalizer_version ?? DEFAULT_NORMALIZER_VERSION,
    canonicalJson(normalizer),
    canonicalJson(consent),
    canonicalJson(mandatory),
    iso(ctx),
  );
  audit(ctx, actor, "suite.create", "suite_draft_created", "suite", id, { version: 1 });
  return getSuiteVersion(ctx, id, 1);
}

function requireDraft(ctx: Ctx, id: string, version: number): any {
  const s = getSuiteVersion(ctx, id, version);
  if (s.state !== "draft") {
    throw conflict("suite_frozen", "suite version is frozen; create a new version to correct it");
  }
  return s;
}

export function addSample(
  ctx: Ctx,
  actor: Actor,
  suiteId: string,
  version: number,
  input: {
    sample_id: string;
    content: string;
    media_type?: string;
    labels: Record<string, string>;
    allowed_processors?: string[];
    consent_note?: string;
  },
): any {
  const suite = requireDraft(ctx, suiteId, version);
  if (!input.sample_id || input.content === undefined || !input.labels) {
    throw badRequest("missing_fields", "sample_id, content and labels are required");
  }
  const mandatory: string[] = JSON.parse(suite.mandatory_fields_json);
  for (const f of mandatory) {
    if (!(f in input.labels)) {
      throw badRequest("label_missing_field", `labels must include mandatory field '${f}'`);
    }
  }
  const contentRef = `blob_${sha256hex(input.content).slice(0, 24)}`;
  const labelJson = canonicalJson(input.labels);
  const allowed = input.allowed_processors?.length ? input.allowed_processors : [ALL_BOUND];
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT OR IGNORE INTO blobs(ref,body,media_type,created_at) VALUES(?,?,?,?)",
      contentRef,
      input.content,
      input.media_type ?? "text/plain",
      iso(ctx),
    );
    ctx.db.run(
      `INSERT INTO samples(suite_id,suite_version,sample_id,content_ref,content_hash,label_json,label_hash,allowed_processors_json,consent_note,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      suiteId,
      version,
      input.sample_id,
      contentRef,
      sha256hex(input.content),
      labelJson,
      sha256hex(labelJson),
      canonicalJson(allowed),
      input.consent_note ?? null,
      iso(ctx),
    );
  });
  audit(ctx, actor, "suite.add_sample", "sample_added", "suite", suiteId, {
    version,
    sample_id: input.sample_id,
    allowed,
  });
  return ctx.db.get(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? AND sample_id=?",
    suiteId,
    version,
    input.sample_id,
  );
}

/** Steward correction on a draft version (labels and/or processor consent). */
export function correctSample(
  ctx: Ctx,
  actor: Actor,
  suiteId: string,
  version: number,
  sampleId: string,
  patch: { labels?: Record<string, string>; allowed_processors?: string[]; consent_note?: string },
): any {
  const suite = requireDraft(ctx, suiteId, version);
  const s = ctx.db.get<any>(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? AND sample_id=?",
    suiteId,
    version,
    sampleId,
  );
  if (!s) throw notFound("sample");
  const mandatory: string[] = JSON.parse(suite.mandatory_fields_json);
  let labelJson = s.label_json;
  let labelHash = s.label_hash;
  if (patch.labels) {
    for (const f of mandatory) {
      if (!(f in patch.labels)) {
        throw badRequest("label_missing_field", `labels must include mandatory field '${f}'`);
      }
    }
    labelJson = canonicalJson(patch.labels);
    labelHash = sha256hex(labelJson);
  }
  ctx.db.run(
    `UPDATE samples SET label_json=?, label_hash=?, allowed_processors_json=?, consent_note=?
     WHERE suite_id=? AND suite_version=? AND sample_id=?`,
    labelJson,
    labelHash,
    patch.allowed_processors ? canonicalJson(patch.allowed_processors) : s.allowed_processors_json,
    patch.consent_note !== undefined ? patch.consent_note : s.consent_note,
    suiteId,
    version,
    sampleId,
  );
  audit(ctx, actor, "suite.correct_sample", "sample_corrected", "suite", suiteId, {
    version,
    sample_id: sampleId,
    label_changed: patch.labels !== undefined,
  });
  return ctx.db.get(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? AND sample_id=?",
    suiteId,
    version,
    sampleId,
  );
}

/**
 * Freeze a draft: compute the manifest hash over samples, labels, normalization
 * configuration and consent policy. After this the version is immutable.
 */
export function freezeVersion(ctx: Ctx, actor: Actor, suiteId: string, version: number): any {
  const suite = requireDraft(ctx, suiteId, version);
  const samples = ctx.db.all<any>(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? ORDER BY sample_id",
    suiteId,
    version,
  );
  if (samples.length === 0) throw badRequest("suite_empty", "cannot freeze a suite with no samples");
  const manifest = {
    suite_id: suiteId,
    version,
    normalizer_version: suite.normalizer_version,
    normalizer_config: JSON.parse(suite.normalizer_config_json),
    consent_policy: JSON.parse(suite.consent_policy_json),
    mandatory_fields: JSON.parse(suite.mandatory_fields_json),
    samples: samples.map((s) => ({
      sample_id: s.sample_id,
      content_hash: s.content_hash,
      label_hash: s.label_hash,
      allowed_processors: JSON.parse(s.allowed_processors_json),
    })),
  };
  const manifestHash = sha256hex(canonicalJson(manifest));
  ctx.db.run(
    "UPDATE suites SET manifest_hash=?, state='frozen', frozen_at=? WHERE id=? AND version=?",
    manifestHash,
    iso(ctx),
    suiteId,
    version,
  );
  audit(ctx, actor, "suite.freeze", "suite_frozen", "suite", suiteId, {
    version,
    manifest_hash: manifestHash,
    sample_count: samples.length,
  });
  return getSuiteVersion(ctx, suiteId, version);
}

/** Create draft v+1 copying the latest version's samples (for corrections). */
export function createNextVersion(ctx: Ctx, actor: Actor, suiteId: string): any {
  const latest = getSuiteVersion(ctx, suiteId, latestVersion(ctx, suiteId));
  if (latest.state !== "frozen") {
    throw conflict("latest_not_frozen", "the latest suite version is still a draft");
  }
  const v = latest.version + 1;
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO suites(id,version,account_id,name,task,manifest_hash,normalizer_version,
         normalizer_config_json,consent_policy_json,mandatory_fields_json,state,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      suiteId,
      v,
      latest.account_id,
      latest.name,
      latest.task,
      "",
      latest.normalizer_version,
      latest.normalizer_config_json,
      latest.consent_policy_json,
      latest.mandatory_fields_json,
      iso(ctx),
    );
    ctx.db.run(
      `INSERT INTO samples(suite_id,suite_version,sample_id,content_ref,content_hash,label_json,label_hash,allowed_processors_json,consent_note,created_at)
       SELECT suite_id, ?, sample_id, content_ref, content_hash, label_json, label_hash, allowed_processors_json, consent_note, ?
       FROM samples WHERE suite_id=? AND suite_version=?`,
      v,
      iso(ctx),
      suiteId,
      latest.version,
    );
  });
  audit(ctx, actor, "suite.new_version", "suite_version_created", "suite", suiteId, {
    version: v,
    from: latest.version,
  });
  return getSuiteVersion(ctx, suiteId, v);
}

export function getSample(ctx: Ctx, suiteId: string, version: number, sampleId: string): any {
  const s = ctx.db.get<any>(
    "SELECT * FROM samples WHERE suite_id=? AND suite_version=? AND sample_id=?",
    suiteId,
    version,
    sampleId,
  );
  if (!s) throw notFound("sample");
  return s;
}

/** Consent gate: is this provider allowed to process the sample? */
export function processorAllowed(sample: any, providerId: string): boolean {
  const allowed: string[] = JSON.parse(sample.allowed_processors_json);
  return allowed.includes(ALL_BOUND) || allowed.includes(providerId);
}

/**
 * Issue a short-lived signed URL a provider may use to fetch sample content.
 * Consent is enforced at issuance AND at serve time.
 */
export function issueSampleUrl(ctx: Ctx, suiteVersion: any, sample: any, providerId: string): string {
  if (!processorAllowed(sample, providerId)) {
    throw forbidden("consent_excluded", `provider ${providerId} is not a consented processor for sample ${sample.sample_id}`);
  }
  const exp = ctx.now() + ctx.config.signedUrlTtlMs;
  const sig = hmacSign(ctx.config.hmacSecret, `${sample.content_ref}|${providerId}|${exp}`);
  return `${ctx.config.selfOrigin}/samples/${sample.content_ref}?p=${encodeURIComponent(providerId)}&exp=${exp}&sig=${sig}`;
}

/** Serve blob content behind a provider-bound, expiring signature + consent recheck. */
export function serveSample(
  ctx: Ctx,
  ref: string,
  providerId: string,
  exp: number,
  sig: string,
): { body: string; media_type: string } {
  const expected = hmacSign(ctx.config.hmacSecret, `${ref}|${providerId}|${exp}`);
  if (!secureCompare(expected, sig)) throw forbidden("bad_signature", "signed URL is invalid");
  if (exp <= ctx.now()) throw forbidden("url_expired", "signed URL has expired");
  // Any sample row sharing this content must consent to this provider.
  const rows = ctx.db.all<any>("SELECT allowed_processors_json FROM samples WHERE content_ref=?", ref);
  if (!rows.some((r) => {
    const a: string[] = JSON.parse(r.allowed_processors_json);
    return a.includes(ALL_BOUND) || a.includes(providerId);
  })) {
    throw forbidden("consent_excluded", "provider is not a consented processor for this content");
  }
  const blob = ctx.db.get<any>("SELECT * FROM blobs WHERE ref=?", ref);
  if (!blob) throw notFound("sample content");
  return { body: blob.body, media_type: blob.media_type };
}

export function suitePublicView(ctx: Ctx, suite: any) {
  const samples = ctx.db.all<any>(
    "SELECT sample_id, content_hash, label_hash, allowed_processors_json, consent_note FROM samples WHERE suite_id=? AND suite_version=? ORDER BY sample_id",
    suite.id,
    suite.version,
  );
  return {
    id: suite.id,
    version: suite.version,
    name: suite.name,
    task: suite.task,
    state: suite.state,
    manifest_hash: suite.manifest_hash || null,
    normalizer_version: suite.normalizer_version,
    normalizer_config: JSON.parse(suite.normalizer_config_json),
    consent_policy: JSON.parse(suite.consent_policy_json),
    mandatory_fields: JSON.parse(suite.mandatory_fields_json),
    samples: samples.map((s) => ({
      sample_id: s.sample_id,
      content_hash: s.content_hash,
      label_hash: s.label_hash,
      allowed_processors: JSON.parse(s.allowed_processors_json),
      consent_note: s.consent_note,
    })),
    frozen_at: suite.frozen_at,
  };
}
