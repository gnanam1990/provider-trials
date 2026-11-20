import http from "node:http";
import https from "node:https";

export class HttpTimeout extends Error {
  url: string;
  constructor(url: string) {
    super(`request to ${url} timed out`);
    this.name = "HttpTimeout";
    this.url = url;
  }
}

export class HttpCallError extends Error {
  url: string;
  constructor(url: string, message: string) {
    super(message);
    this.name = "HttpCallError";
    this.url = url;
  }
}

export interface FetchResult {
  status: number;
  body: string;
  json: any;
}

const MAX_RESP = 1024 * 1024;

/**
 * Restricted outbound client: only http/https, only origins whose host is in
 * the configured allowlist. No redirect following (origin must be exact).
 */
export function originAllowed(origin: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return allowedHosts.includes(u.hostname);
}

export function normalizeOrigin(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.host}`;
}

export async function fetchUrl(
  url: string,
  opts: { method?: string; json?: unknown; timeoutMs?: number; allowedHosts: string[] },
): Promise<FetchResult> {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.host}`;
  if (!originAllowed(origin, opts.allowedHosts)) {
    throw new HttpCallError(url, `origin ${origin} is not in the configured allowlist`);
  }
  const mod = u.protocol === "https:" ? https : http;
  const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: opts.method ?? "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          accept: "application/json, text/plain",
        },
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESP) {
            req.destroy(new HttpCallError(url, "response exceeds 1MiB cap"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: any = undefined;
          try {
            json = JSON.parse(body);
          } catch {
            /* non-JSON body is fine */
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new HttpTimeout(url)));
    req.on("error", (e) => {
      if (e instanceof HttpTimeout) reject(e);
      else reject(new HttpCallError(url, (e as Error).message));
    });
    if (payload) req.write(payload);
    req.end();
  });
}
