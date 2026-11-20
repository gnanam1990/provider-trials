import crypto from "node:crypto";
import { Db } from "./db.ts";

export interface Config {
  /** Hostnames the outbound client may reach (nonce check + OCR adapter). */
  allowedHosts: string[];
  /** HMAC secret for signed sample-transport URLs and UI sessions. */
  hmacSecret: string;
  /** Public origin of this service, used to build signed sample URLs. */
  selfOrigin: string;
  /** Explicitly enabled local-demo shortcuts; never on by default. */
  demoMode: boolean;
  challengeTtlMs: number;
  bindingTtlMs: number;
  signedUrlTtlMs: number;
  dispatchTimeoutMs: number;
  dispatchConcurrency: number;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    allowedHosts: (env.PT_ALLOWED_HOSTS ?? "127.0.0.1,localhost,::1").split(",").map((s) => s.trim()),
    // No shared default: set PT_HMAC_SECRET for stable sessions across restarts,
    // otherwise a fresh per-boot secret invalidates sessions on restart.
    hmacSecret: env.PT_HMAC_SECRET ?? crypto.randomBytes(24).toString("base64url"),
    selfOrigin: env.PT_SELF_ORIGIN ?? "http://127.0.0.1:8787",
    demoMode: env.PT_DEMO === "1",
    challengeTtlMs: Number(env.PT_CHALLENGE_TTL_MS ?? 5 * 60_000),
    bindingTtlMs: Number(env.PT_BINDING_TTL_MS ?? 24 * 3600_000),
    signedUrlTtlMs: Number(env.PT_SIGNED_URL_TTL_MS ?? 10 * 60_000),
    dispatchTimeoutMs: Number(env.PT_DISPATCH_TIMEOUT_MS ?? 5000),
    dispatchConcurrency: Number(env.PT_DISPATCH_CONCURRENCY ?? 4),
  };
}

export interface Ctx {
  db: Db;
  config: Config;
  /** Injectable clock; returns milliseconds epoch. */
  now: () => number;
}

export function makeCtx(db: Db, config: Config, now: () => number = Date.now): Ctx {
  return { db, config, now };
}

export function iso(ctx: Ctx, ms?: number): string {
  return new Date(ms ?? ctx.now()).toISOString();
}
