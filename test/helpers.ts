import http from "node:http";
import crypto from "node:crypto";
import { Db } from "../src/db.ts";
import { defaultConfig, makeCtx } from "../src/context.ts";
import type { Ctx } from "../src/context.ts";
import { buildApi } from "../src/http/api.ts";
import { generateEd25519, hmacSign, sha256hex, canonicalJson } from "../src/lib/util.ts";
import type { Actor } from "../src/auth.ts";

export interface TestEnv {
  ctx: Ctx;
  db: Db;
  server: http.Server;
  port: number;
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

/** Boots a real HTTP server on an ephemeral port backed by in-memory sqlite. */
export async function startEnv(configOverrides: Partial<ReturnType<typeof defaultConfig>> = {}): Promise<TestEnv> {
  let now = Date.now();
  const db = Db.open(":memory:");
  const config = { ...defaultConfig(), ...configOverrides };
  const ctx = makeCtx(db, config, () => now);
  const api = buildApi(ctx);
  const server = http.createServer((req, res) => {
    api.dispatch(req, res).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  config.selfOrigin = `http://127.0.0.1:${port}`;
  return {
    ctx,
    db,
    server,
    port,
    setNow: (ms) => (now = ms),
    advance: (ms) => (now += ms),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface ApiResult {
  status: number;
  json: any;
  body: string;
}

export function hdr(a: Actor): Record<string, string> {
  return {
    "x-pt-account": a.accountId,
    "x-pt-subject": a.subject,
    "x-pt-role": a.role,
  };
}

export async function api(
  port: number,
  actor: Actor | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(actor ? hdr(actor) : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, body: text };
}

/** Creates an account + full set of role members for tests. */
export async function makeAccount(port: number, name = "buyer"): Promise<Record<string, Actor>> {
  const r = await api(port, null, "POST", "/accounts", { name, bootstrap_subject: "lead" });
  const accountId = r.json.account_id;
  const lead: Actor = { accountId, subject: "lead", role: "procurement_lead" };
  for (const [subject, role] of [
    ["steward", "dataset_steward"],
    ["operator", "provider_operator"],
    ["runner", "runner"],
    ["analyst", "analyst"],
  ] as const) {
    await api(port, lead, "POST", `/accounts/${accountId}/members`, { subject, role });
  }
  return {
    lead,
    steward: { accountId, subject: "steward", role: "dataset_steward" },
    operator: { accountId, subject: "operator", role: "provider_operator" },
    runner: { accountId, subject: "runner", role: "runner" },
    analyst: { accountId, subject: "analyst", role: "analyst" },
  };
}

export interface OcrInvocation {
  invocation_ref: string;
  sample_url?: string;
  trial_id?: string;
  state: "settled" | "unknown";
  result?: { fields: Record<string, string> };
  receipt?: any;
}

/**
 * Team-controlled, explicitly labeled provider emulator. Stands in for an OCR
 * merchant endpoint: serves binding nonces, quotes, OCR executions and status
 * lookups. All receipts it signs are local-environment artifacts.
 */
export class FakeProvider {
  keys = generateEd25519();
  keyId = "k1";
  nonce: string | null = null;
  priceMinor = 3;
  asset = "cent";
  mode: "ok" | "hang" | "error" | "bad_receipt" = "ok";
  /** sample content-hash suffix -> fields to return, or fallback */
  fieldPlan: Record<string, Record<string, string>> = {};
  defaultFields: Record<string, string> = { date: "2000-01-01", tax: "0.00", total: "0.00" };
  invocations = new Map<string, OcrInvocation>();
  latencyMs = 5;
  server!: http.Server;
  origin!: string;

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as any).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && u.pathname === "/.well-known/provider-trials/nonce") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nonce: this.nonce }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/quote") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ price_minor: this.priceMinor, asset: this.asset }));
      return;
    }
    if (req.method === "GET" && u.pathname === "/status") {
      const ref = u.searchParams.get("invocation_ref") ?? "";
      const inv = this.invocations.get(ref);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(inv ?? { state: "unknown" }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/ocr") {
      readJson(req).then((body) => this.handleOcr(body, res));
      return;
    }
    res.writeHead(404).end();
  }

  private handleOcr(body: any, res: http.ServerResponse): void {
    const ref = body.invocation_ref ?? "unknown";
    const record: OcrInvocation = { invocation_ref: ref, state: "unknown", ...body };
    this.invocations.set(ref, record);
    if (this.mode === "hang") return; // never answer -> client timeout
    if (this.mode === "error") {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "emulated provider fault" }));
      return;
    }
    const planKey = body.sample_key ?? "";
    const fields = this.fieldPlan[planKey] ?? this.defaultFields;
    const result = { fields };
    const receiptPayload = {
      receipt_id: `rcpt_${ref}`,
      invocation_ref: ref,
      trial_id: body.trial_id,
      amount_minor: this.priceMinor,
      asset: this.asset,
      environment: "local-emulator",
    };
    const digest = sha256hex(canonicalJson(receiptPayload));
    const signature = this.mode === "bad_receipt"
      ? hmacSign("wrong", digest)
      : signWith(this.keys.privateKeyPem, digest);
    const receipt = { ...receiptPayload, digest, signature };
    record.state = "settled";
    record.result = result;
    record.receipt = receipt;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result, receipt }));
    }, this.latencyMs);
  }
}

function signWith(privateKeyPem: string, data: string): string {
  return crypto.sign(null, Buffer.from(data, "utf8"), privateKeyPem).toString("base64url");
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });
}
