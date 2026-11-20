import crypto from "node:crypto";
import type { Ctx } from "../context.ts";
import { Router } from "../lib/router.ts";
import type { Req, Resp } from "../lib/router.ts";
import { makeSessionCookie, requireActor } from "../auth.ts";
import type { Actor } from "../auth.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import * as providers from "../domain/providers.ts";
import * as suites from "../domain/suites.ts";
import * as trials from "../domain/trials.ts";
import * as reports from "../domain/reports.ts";
import * as execution from "../domain/execution.ts";
import { verifyEd25519 } from "../lib/util.ts";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:64rem;margin:0 auto;padding:1rem;line-height:1.45}
nav{display:flex;gap:1rem;flex-wrap:wrap;border-bottom:1px solid #8885;padding-bottom:.5rem;margin-bottom:1rem}
nav a{color:#4f6ef7;text-decoration:none}
table{border-collapse:collapse;width:100%;margin:.75rem 0}
th,td{border:1px solid #8885;padding:.35rem .6rem;text-align:left;font-size:.9rem}
th{background:#8882}
.badge{display:inline-block;padding:.1rem .45rem;border-radius:.6rem;font-size:.75rem;border:1px solid #8886}
.warn{background:#7c2d12;color:#fde8d8;padding:.6rem .8rem;border-radius:.4rem;margin:.5rem 0}
.ok{background:#14532d;color:#d9f7e4;padding:.6rem .8rem;border-radius:.4rem;margin:.5rem 0}
.muted{color:#888}
form.inline{display:inline}
fieldset{border:1px solid #8885;border-radius:.4rem;margin:.6rem 0}
label{display:block;margin:.3rem 0;font-size:.85rem}
input,select,textarea{font:inherit;max-width:100%}
button{font:inherit;cursor:pointer}
:focus-visible{outline:2px solid #4f6ef7;outline-offset:2px}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.4rem}
small{display:block}
`;

function page(title: string, actor: Actor | null, inner: string): string {
  const nav = actor
    ? `<nav aria-label="main">
       <a href="/console">Work queue</a><a href="/console/providers">Providers</a>
       <a href="/console/suites">Suites</a><a href="/console/trials">Trials</a>
       <a href="/console/reports">Reports</a>
       <span class="muted">${esc(actor.subject)} · ${esc(actor.role)} · ${esc(actor.accountId)}</span>
       <a href="/console/logout">Sign out</a></nav>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Provider Trials</title><style>${CSS}</style></head>
<body>${nav}<main><h1>${esc(title)}</h1>${inner}</main></body></html>`;
}

/** Console actor: redirects to login on unauthenticated GETs. */
function actor(ctx: Ctx, req: Req, res: Resp | null = null): Actor {
  try {
    return requireActor(ctx, req);
  } catch {
    throw { redirect: "/console/login" };
  }
}

function th(...cells: string[]): string {
  return `<tr>${cells.map((c) => `<th scope="col">${c}</th>`).join("")}</tr>`;
}
function td(...cells: unknown[]): string {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}
const fmtCost = (v: number | null, reason: string | null): string =>
  v === null ? `<span class="muted">unknown${reason ? ` — ${esc(reason)}` : ""}</span>` : `${v}¢`;
const badge = (s: string): string => `<span class="badge">${esc(s)}</span>`;

export function mountConsole(ctx: Ctx, r: Router): void {
  const go = (loc: string): Resp => ({ status: 303, headers: { location: loc }, text: "" });

  r.get("/", () => go("/console"));

  r.get("/console/login", () => ({
    html: page("Sign in", null, `
      <p class="muted">Local development console: select an enrolled member identity.</p>
      <form method="post" action="/console/login">
        <label>Account <input name="account_id" required></label>
        <label>Subject <input name="subject" required></label>
        <label>Role
          <select name="role">
            <option>procurement_lead</option><option>dataset_steward</option>
            <option>provider_operator</option><option>runner</option><option>analyst</option>
          </select></label>
        <button type="submit">Sign in</button>
      </form>`),
  }));

  r.post("/console/login", (req) => {
    const { account_id, subject, role } = req.body ?? {};
    const m = ctx.db.get(
      "SELECT 1 x FROM members WHERE account_id=? AND subject=? AND role=?",
      account_id, subject, role,
    );
    if (!m) {
      return { status: 403, html: page("Sign in", null, `<p class="warn">No such member/role in that account.</p><p><a href="/console/login">Back</a></p>`) };
    }
    return {
      status: 303,
      headers: {
        location: "/console",
        "set-cookie": makeSessionCookie(ctx, { accountId: account_id, subject, role }),
      },
      text: "",
    };
  });

  r.get("/console/logout", () => ({
    status: 303,
    headers: { location: "/console/login", "set-cookie": "pt_session=; Path=/; Max-Age=0" },
    text: "",
  }));

  // ---- Work queue: role-aware landing ------------------------------------
  r.get("/console", (req) => {
    const a = actor(ctx, req);
    let items = "";
    if (a.role === "provider_operator") {
      const mine = providers.listProviders(ctx, a.accountId).filter((p) => p.owner_subject === a.subject);
      items = `<h2>Your providers</h2><ul>${mine.map((p) =>
        `<li><a href="/console/providers/${p.id}">${esc(p.name)}</a> ${badge(p.state)}</li>`).join("") || "<li class='muted'>none</li>"}</ul>`;
    } else if (a.role === "dataset_steward") {
      const drafts = suites.listSuites(ctx, a.accountId).filter((s) => s.state === "draft");
      items = `<h2>Suites needing attention</h2><ul>${drafts.map((s) =>
        `<li><a href="/console/suites/${s.id}">${esc(s.name)} v${s.version}</a> ${badge("draft")}</li>`).join("") || "<li class='muted'>none</li>"}</ul>`;
    } else if (a.role === "procurement_lead") {
      const planned = ctx.db.all("SELECT * FROM trials WHERE account_id=? AND state='planned'", a.accountId);
      items = `<h2>Trials awaiting run</h2><ul>${planned.map((t: any) =>
        `<li><a href="/console/trials/${t.id}">${t.id}</a> ${badge(t.state)}</li>`).join("") || "<li class='muted'>none</li>"}</ul>`;
    } else if (a.role === "runner") {
      const running = ctx.db.all("SELECT * FROM trials WHERE account_id=? AND state='running'", a.accountId);
      const pending = ctx.db.get("SELECT COUNT(*) n FROM outbox WHERE state='pending'").n;
      const uncertain = ctx.db.all("SELECT DISTINCT trial_id FROM cells WHERE state='uncertain'");
      items = `<h2>Dispatch work</h2><p>${pending} queued dispatch items.</p>
        <ul>${running.map((t: any) => `<li><a href="/console/trials/${t.id}">${t.id}</a> ${badge("running")}</li>`).join("")}</ul>
        ${uncertain.length ? `<p class="warn">${uncertain.length} trial(s) with uncertain attempts need reconciliation.</p>` : ""}`;
    } else {
      const reps = ctx.db.all("SELECT r.*, t.account_id FROM reports r JOIN trials t ON t.id=r.trial_id WHERE t.account_id=? ORDER BY r.created_at DESC LIMIT 10", a.accountId);
      items = `<h2>Latest reports</h2><ul>${reps.map((x: any) =>
        `<li><a href="/console/reports/${x.id}">${x.id}</a> <span class="muted">trial ${x.trial_id}</span></li>`).join("") || "<li class='muted'>none</li>"}</ul>`;
    }
    return { html: page("Work queue", a, items) };
  });

  // ---- Providers ----------------------------------------------------------
  r.get("/console/providers", (req) => {
    const a = actor(ctx, req);
    const rows = providers.listProviders(ctx, a.accountId).map((p) =>
      td(`<a href="/console/providers/${p.id}">${esc(p.name)}</a>`, badge(p.state), esc(p.endpoint_origin), esc(p.key_id)));
    const form = a.role === "provider_operator" ? `
      <h2>Register provider</h2>
      <form method="post" action="/console/providers">
        <label>Name <input name="name" required></label>
        <label>Endpoint origin <input name="endpoint_origin" required placeholder="http://127.0.0.1:9000"></label>
        <label>Key ID <input name="key_id" required></label>
        <label>Public key (PEM) <textarea name="public_key_pem" rows="4" required></textarea></label>
        <button type="submit">Register</button>
      </form>` : "";
    return { html: page("Providers", a, `<table>${th("Name", "State", "Origin", "Key")}${rows.join("")}</table>${form}`) };
  });

  r.post("/console/providers", (req) => {
    const a = actor(ctx, req);
    const b = req.body ?? {};
    providers.registerProvider(ctx, a, {
      name: b.name, endpoint_origin: b.endpoint_origin,
      key_id: b.key_id, public_key_pem: b.public_key_pem,
    });
    return go("/console/providers");
  });

  r.get("/console/providers/{id}", (req) => {
    const a = actor(ctx, req);
    const p = providers.getProvider(ctx, req.params.id);
    if (p.account_id !== a.accountId) throw notFound("provider");
    const binds = ctx.db.all<any>("SELECT * FROM bindings WHERE provider_id=? ORDER BY created_at", p.id);
    const bindRows = binds.map((b) =>
      td(esc(b.id), badge(b.state), esc(b.origin), esc(b.key_id), esc(b.expires_at)));
    const actions = a.role === "provider_operator" && p.owner_subject === a.subject ? `
      <h2>Enroll / rebind (dev-assisted signing)</h2>
      <p class="muted">The console issues a challenge, signs it with the pasted private key and submits the binding — the same dual proof as the API. In production the provider signs and hosts the nonce itself.</p>
      <form method="post" action="/console/providers/${p.id}/bind">
        <label>Private key (PEM) <textarea name="private_key_pem" rows="4" required></textarea></label>
        <button type="submit">Prove ownership &amp; bind</button>
      </form>
      <h2>Rotate key/origin</h2>
      <form method="post" action="/console/providers/${p.id}/rotate">
        <label>New origin (optional) <input name="endpoint_origin"></label>
        <label>New key ID (optional) <input name="key_id"></label>
        <label>New public key PEM (optional) <textarea name="public_key_pem" rows="3"></textarea></label>
        <button type="submit">Rotate (revokes binding)</button>
      </form>` : "";
    return { html: page(`Provider ${esc(p.name)}`, a,
      `<p>${badge(p.state)} · owner ${esc(p.owner_subject)} · origin ${esc(p.endpoint_origin)} · key ${esc(p.key_id)}</p>
       <h2>Bindings</h2><table>${th("ID", "State", "Origin", "Key", "Expires")}${bindRows.join("")}</table>${actions}`) };
  });

  r.post("/console/providers/{id}/bind", async (req) => {
    const a = actor(ctx, req);
    const p = providers.getProvider(ctx, req.params.id);
    if (p.account_id !== a.accountId) throw notFound("provider");
    const pem = req.body?.private_key_pem;
    if (!pem) throw badRequest("missing_fields", "private_key_pem required");
    const ch = providers.createChallenge(ctx, a, p.id);
    // Dev-assisted signing: verifies the pasted key matches the enrolled key.
    const probe = verifyEd25519(ch.signing_payload, signNow(ch.signing_payload, pem), p.public_key_pem);
    if (!probe) {
      return { status: 422, html: page(`Provider ${esc(p.name)}`, a, `<p class="warn">Pasted private key does not match the enrolled public key.</p>`) };
    }
    await providers.submitBinding(ctx, a, p.id, {
      challenge_id: ch.challenge_id,
      signature: signNow(ch.signing_payload, pem),
    });
    return go(`/console/providers/${p.id}`);
  });

  r.post("/console/providers/{id}/rotate", (req) => {
    const a = actor(ctx, req);
    const b = req.body ?? {};
    providers.rotateProvider(ctx, a, req.params.id, {
      endpoint_origin: b.endpoint_origin || undefined,
      key_id: b.key_id || undefined,
      public_key_pem: b.public_key_pem || undefined,
    });
    return go(`/console/providers/${req.params.id}`);
  });

  // ---- Suites --------------------------------------------------------------
  r.get("/console/suites", (req) => {
    const a = actor(ctx, req);
    const rows = suites.listSuites(ctx, a.accountId).map((s) =>
      td(`<a href="/console/suites/${s.id}?version=${s.version}">${esc(s.name)}</a>`, `v${s.version}`, badge(s.state),
        `<code>${esc((s.manifest_hash || "").slice(0, 12) || "—")}</code>`));
    const form = a.role === "dataset_steward" ? `
      <h2>New suite</h2>
      <form method="post" action="/console/suites">
        <label>Name <input name="name" required></label>
        <button type="submit">Create draft</button>
      </form>` : "";
    return { html: page("Suites", a, `<table>${th("Name", "Version", "State", "Manifest")}${rows.join("")}</table>${form}`) };
  });

  r.post("/console/suites", (req) => {
    const a = actor(ctx, req);
    const s = suites.createSuite(ctx, a, { name: req.body?.name });
    return go(`/console/suites/${s.id}`);
  });

  r.get("/console/suites/{id}", (req) => {
    const a = actor(ctx, req);
    const v = req.query.get("version");
    const s = v
      ? suites.getSuiteVersion(ctx, req.params.id, Number(v))
      : suites.getSuiteVersion(ctx, req.params.id, suites.latestVersion(ctx, req.params.id));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const view = suites.suitePublicView(ctx, s);
    const sampleRows = view.samples.map((sm) =>
      td(esc(sm.sample_id), `<code>${esc(sm.content_hash.slice(0, 10))}</code>`,
        `<code>${esc(sm.label_hash.slice(0, 10))}</code>`, esc(sm.allowed_processors.join(", ")), esc(sm.consent_note ?? "")));
    const actions = a.role === "dataset_steward" && s.state === "draft" ? `
      <h2>Add sample</h2>
      <form method="post" action="/console/suites/${s.id}/versions/${s.version}/samples">
        <label>Sample ID <input name="sample_id" required></label>
        <label>Content <textarea name="content" rows="3" required></textarea></label>
        <fieldset><legend>Labels (mandatory fields)</legend>
          ${view.mandatory_fields.map((f: string) => `<label>${esc(f)} <input name="label_${esc(f)}" required></label>`).join("")}
        </fieldset>
        <label>Allowed processors (comma-separated provider IDs, blank = all bound) <input name="allowed_processors"></label>
        <label>Consent note <input name="consent_note"></label>
        <button type="submit">Add sample</button>
      </form>
      <form method="post" action="/console/suites/${s.id}/versions/${s.version}/freeze">
        <button type="submit">Freeze version ${s.version}</button>
      </form>` : "";
    const newVersion = a.role === "dataset_steward" && s.state === "frozen" ? `
      <form method="post" action="/console/suites/${s.id}/versions">
        <button type="submit">Create correction version (v${s.version + 1})</button>
      </form>` : "";
    const correct = a.role === "dataset_steward" && s.state === "draft" ? `
      <h2>Correct a sample</h2>
      <form method="post" action="/console/suites/${s.id}/versions/${s.version}/correct">
        <label>Sample ID <input name="sample_id" required></label>
        ${view.mandatory_fields.map((f: string) => `<label>${esc(f)} <input name="label_${esc(f)}"></label>`).join("")}
        <label>Allowed processors <input name="allowed_processors"></label>
        <button type="submit">Apply correction</button>
      </form>` : "";
    return { html: page(`Suite ${esc(s.name)} v${s.version}`, a,
      `<p>${badge(s.state)} · manifest <code>${esc(s.manifest_hash || "unfrozen")}</code> · normalizer ${esc(s.normalizer_version)}</p>
       <h2>Samples (${view.samples.length})</h2>
       <table>${th("Sample", "Content", "Label", "Processors", "Consent")}${sampleRows.join("")}</table>
       ${actions}${correct}${newVersion}`) };
  });

  r.post("/console/suites/{id}/versions/{v}/samples", (req) => {
    const a = actor(ctx, req);
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const mandatory: string[] = JSON.parse(s.mandatory_fields_json);
    const labels: Record<string, string> = {};
    for (const f of mandatory) labels[f] = req.body?.[`label_${f}`] ?? "";
    const allowed = (req.body?.allowed_processors ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
    suites.addSample(ctx, a, req.params.id, Number(req.params.v), {
      sample_id: req.body?.sample_id,
      content: req.body?.content,
      labels,
      allowed_processors: allowed.length ? allowed : undefined,
      consent_note: req.body?.consent_note || undefined,
    });
    return go(`/console/suites/${req.params.id}?version=${req.params.v}`);
  });

  r.post("/console/suites/{id}/versions/{v}/correct", (req) => {
    const a = actor(ctx, req);
    const s = suites.getSuiteVersion(ctx, req.params.id, Number(req.params.v));
    if (s.account_id !== a.accountId) throw notFound("suite");
    const mandatory: string[] = JSON.parse(s.mandatory_fields_json);
    const labels: Record<string, string> = {};
    for (const f of mandatory) labels[f] = req.body?.[`label_${f}`] ?? "";
    const allowed = (req.body?.allowed_processors ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
    suites.correctSample(ctx, a, req.params.id, Number(req.params.v), req.body?.sample_id, {
      labels,
      allowed_processors: allowed.length ? allowed : undefined,
    });
    return go(`/console/suites/${req.params.id}?version=${req.params.v}`);
  });

  r.post("/console/suites/{id}/versions/{v}/freeze", (req) => {
    const a = actor(ctx, req);
    suites.freezeVersion(ctx, a, req.params.id, Number(req.params.v));
    return go(`/console/suites/${req.params.id}?version=${req.params.v}`);
  });

  r.post("/console/suites/{id}/versions", (req) => {
    const a = actor(ctx, req);
    const s = suites.createNextVersion(ctx, a, req.params.id);
    return go(`/console/suites/${s.id}?version=${s.version}`);
  });

  // ---- Trials ---------------------------------------------------------------
  r.get("/console/trials", (req) => {
    const a = actor(ctx, req);
    const rows = ctx.db.all("SELECT * FROM trials WHERE account_id=? ORDER BY created_at DESC", a.accountId)
      .map((t: any) => td(`<a href="/console/trials/${t.id}">${esc(t.id)}</a>`,
        `${esc(t.suite_id)} v${t.suite_version}`, badge(t.state), `${t.budget_minor} / ${t.per_provider_cap_minor} ${esc(t.asset)}`));
    let form = "";
    if (a.role === "procurement_lead") {
      const frozen = suites.listSuites(ctx, a.accountId).filter((s) => s.state === "frozen");
      const bound = providers.listProviders(ctx, a.accountId).filter((p) => p.state === "bound");
      form = `
      <h2>New trial (consent &amp; cap review)</h2>
      <form method="post" action="/console/trials">
        <label>Suite version <select name="suite">${frozen.map((s) =>
          `<option value="${esc(s.id)}|${s.version}">${esc(s.name)} v${s.version}</option>`).join("")}</select></label>
        <fieldset><legend>Providers (must be bound &amp; consented)</legend>
          ${bound.map((p) => `<label><input type="checkbox" name="p_${esc(p.id)}" value="1"> ${esc(p.name)} <span class="muted">${esc(p.endpoint_origin)}</span></label>`).join("") || "<p class='muted'>no bound providers</p>"}
        </fieldset>
        <label>Budget (minor units) <input name="budget_minor" type="number" min="1" required></label>
        <label>Per-provider cap <input name="per_provider_cap_minor" type="number" min="1" required></label>
        <label>Asset <input name="asset" value="cent" required></label>
        <label>Min observations for ranking <input name="ranking_min_observations" type="number" value="20"></label>
        <label>Small-sample threshold <input name="small_sample_threshold" type="number" value="20"></label>
        <label><input type="checkbox" name="recurring" value="1"> Opt into recurring reruns</label>
        <button type="submit">Create trial</button>
      </form>`;
    }
    return { html: page("Trials", a, `<table>${th("ID", "Suite", "State", "Budget/Cap")}${rows.join("")}</table>${form}`) };
  });

  r.post("/console/trials", (req) => {
    const a = actor(ctx, req);
    const [suiteId, version] = String(req.body?.suite ?? "|").split("|");
    const providerIds = Object.keys(req.body ?? {})
      .filter((k) => k.startsWith("p_") && req.body[k] === "1")
      .map((k) => k.slice(2));
    const t = trials.createTrial(ctx, a, {
      suite_id: suiteId,
      suite_version: Number(version),
      provider_ids: providerIds,
      budget_minor: Number(req.body?.budget_minor),
      per_provider_cap_minor: Number(req.body?.per_provider_cap_minor),
      asset: req.body?.asset,
      ranking_min_observations: Number(req.body?.ranking_min_observations ?? 20),
      small_sample_threshold: Number(req.body?.small_sample_threshold ?? 20),
      recurring: req.body?.recurring ? { enabled: true } : undefined,
    });
    return go(`/console/trials/${t.id}`);
  });

  r.get("/console/trials/{id}", (req) => {
    const a = actor(ctx, req);
    const t = trials.getTrial(ctx, req.params.id);
    if (t.account_id !== a.accountId) throw notFound("trial");
    const cov = trials.trialCoverage(ctx, t.id);
    const rows = cov.providers.map((p: any) =>
      td(esc(p.provider_id), esc(p.coverage), String(p.accepted),
        Object.entries(p.blocked_reasons).map(([k, v]) => `${k}:${v}`).join(", ") || "—"));
    const acts: string[] = [];
    if (a.role === "runner" && t.state === "planned")
      acts.push(`<form class="inline" method="post" action="/console/trials/${t.id}/run"><button>Run trial</button></form>`);
    if (a.role === "runner")
      acts.push(`<form class="inline" method="post" action="/console/drain"><button>Drain dispatch queue</button></form>`);
    if (a.role === "runner")
      acts.push(`<form class="inline" method="post" action="/console/trials/${t.id}/reconcile"><button>Reconcile uncertain</button></form>`);
    if ((a.role === "analyst" || a.role === "procurement_lead"))
      acts.push(`<form class="inline" method="post" action="/console/trials/${t.id}/reports"><button>Issue report</button></form>`);
    const reps = ctx.db.all("SELECT id FROM reports WHERE trial_id=? ORDER BY created_at", t.id);
    return { html: page(`Trial ${esc(t.id)}`, a, `
      <p>${badge(t.state)} · suite ${esc(t.suite_id)} v${t.suite_version} · manifest <code>${esc(t.manifest_hash.slice(0, 16))}</code> · budget ${t.budget_minor} ${esc(t.asset)} · cap ${t.per_provider_cap_minor}</p>
      ${cov.exclusions.length ? `<p class="warn">Exclusions: ${cov.exclusions.map((e: any) => `${e.provider_id}/${e.sample_id ?? "*"} ${e.reason}`).join("; ")}</p>` : ""}
      <h2>Coverage</h2>
      <table>${th("Provider", "Attempted/Scheduled", "Accepted", "Blocked reasons")}${rows.join("")}</table>
      <p>${acts.join(" ")}</p>
      ${reps.length ? `<h2>Reports</h2><ul>${reps.map((x: any) => `<li><a href="/console/reports/${x.id}">${x.id}</a></li>`).join("")}</ul>` : ""}`) };
  });

  r.post("/console/trials/{id}/run", async (req) => {
    const a = actor(ctx, req);
    await trials.runTrial(ctx, a, req.params.id);
    return go(`/console/trials/${req.params.id}`);
  });

  r.post("/console/drain", async (req) => {
    actor(ctx, req);
    await execution.drainOutbox(ctx);
    return go(req.headers.referer ?? "/console/trials");
  });

  r.post("/console/trials/{id}/reconcile", async (req) => {
    const a = actor(ctx, req);
    await execution.reconcileTrial(ctx, a, req.params.id);
    return go(`/console/trials/${req.params.id}`);
  });

  r.post("/console/trials/{id}/reports", (req) => {
    const a = actor(ctx, req);
    const rep = reports.issueReport(ctx, a, req.params.id);
    return go(`/console/reports/${rep.id}`);
  });

  // ---- Reports ----------------------------------------------------------------
  r.get("/console/reports", (req) => {
    const a = actor(ctx, req);
    const rows = ctx.db.all(
      "SELECT r.*, t.account_id FROM reports r JOIN trials t ON t.id=r.trial_id WHERE t.account_id=? ORDER BY r.created_at DESC",
      a.accountId,
    ).map((x: any) => td(`<a href="/console/reports/${x.id}">${x.id}</a>`, esc(x.trial_id), esc(x.created_at)));
    return { html: page("Reports", a, `<table>${th("Report", "Trial", "Issued")}${rows.join("")}</table>`) };
  });

  r.get("/console/reports/{id}", (req) => {
    const a = actor(ctx, req);
    const rep = reports.getReport(ctx, req.params.id);
    const t = trials.getTrial(ctx, rep.trial_id);
    if (t.account_id !== a.accountId) throw notFound("report");
    const b = rep.body;
    const rows = b.providers.map((p: any) => td(
      esc(p.name ?? p.provider_id),
      `${p.accepted} / ${p.attempted}`,
      `${p.fields_correct}/${p.fields_total}`,
      esc(p.coverage),
      `${p.spend_minor}¢`,
      fmtCost(p.cost_per_accepted_minor, p.cost_unknown_reason),
      `n=${p.latency.n} p50=${p.latency.p50 ?? "—"}ms p95=${p.latency.p95 ?? "—"}ms`,
      Object.entries(p.errors).map(([k, v]) => `${esc(k)}:${v}`).join(", ") || "—",
      p.bindings.map((x: any) => `${esc(x.key_id)} exp ${esc(x.expires_at)}`).join("<br>") || "—",
      `<a href="/console/reports/${rep.id}/fields?provider_id=${encodeURIComponent(p.provider_id)}">fields</a>`,
    ));
    const warns: string[] = [];
    for (const p of b.providers) {
      if (p.small_sample_warning)
        warns.push(`${p.name ?? p.provider_id}: results on ${p.attempted} sample(s) — small-sample warning (threshold ${b.small_sample_threshold}).`);
      if (p.cost_state === "unknown")
        warns.push(`${p.name ?? p.provider_id}: cost efficiency unknown until reconciliation (${p.cost_unknown_reason}).`);
      if (!p.coverage_complete)
        warns.push(`${p.name ?? p.provider_id}: incomplete coverage ${p.coverage}.`);
    }
    const comparison = b.comparison.ranked
      ? `<h2>Ranking</h2><ol>${b.comparison.ranked.map((x: any) => `<li>${esc(x.provider_id)} — ${x.cost_per_accepted_minor}¢/accepted</li>`).join("")}</ol>`
      : `<p class="warn">Ordered comparison suppressed: ${esc(b.comparison.suppressed?.code ?? "n/a")}${
          b.comparison.suppressed?.code === "min_observations"
            ? ` (requires ${b.comparison.suppressed.required}, observed ${b.comparison.suppressed.observed})`
            : ""}.</p>`;
    return { html: page(`Report ${esc(rep.id)}`, a, `
      <p class="muted">trial ${esc(rep.trial_id)} · suite v${b.suite_version} · manifest <code>${esc(b.manifest_hash.slice(0, 16))}</code> ·
      evidence cursor ${b.asof_cursor} · window ${esc(b.run_window.first_dispatch ?? "—")} → ${esc(b.run_window.last_completion ?? "—")} · environment ${esc(b.environment)}</p>
      ${warns.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      <table>${th("Provider", "Accepted/Attempted", "Fields", "Coverage", "Spend", "Cost/accepted", "Latency", "Errors", "Binding", "Detail")}${rows.join("")}</table>
      ${comparison}
      <p><a href="/reports/${rep.id}/export?format=json">Export JSON</a> · <a href="/reports/${rep.id}/export?format=csv">Export CSV</a></p>`) };
  });

  r.get("/console/reports/{id}/fields", (req) => {
    const a = actor(ctx, req);
    const rep = reports.getReport(ctx, req.params.id);
    const t = trials.getTrial(ctx, rep.trial_id);
    if (t.account_id !== a.accountId) throw notFound("report");
    const providerId = req.query.get("provider_id") ?? "";
    const ev = reports.reportFieldEvidence(ctx, rep, providerId);
    const rows = ev.samples.map((s: any) =>
      td(esc(s.sample_id), badge(s.attempt_state), s.accepted ? "yes" : "no",
        s.fields ? s.fields.map((f: any) => `${esc(f.field)}: ${esc(f.outcome)}`).join("<br>") : `<span class="muted">${esc(s.attempt_state)}</span>`));
    return { html: page(`Field evidence · ${esc(providerId)}`, a,
      `<p class="muted">Redacted field-level outcomes for report ${esc(rep.id)}. Label values stay buyer-side.</p>
       <table>${th("Sample", "Attempt", "Accepted", "Field outcomes")}${rows.join("")}</table>`) };
  });
}

// Sign a payload with a pasted PEM (console dev-assist only).
function signNow(payload: string, pem: string): string {
  return crypto.sign(null, Buffer.from(payload, "utf8"), pem).toString("base64url");
}
