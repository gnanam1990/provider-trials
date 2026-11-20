import http from "node:http";
import { ApiError } from "./errors.ts";

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: any;
  raw: http.IncomingMessage;
  res: http.ServerResponse;
}

export interface Resp {
  status?: number;
  json?: unknown;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export type Handler = (r: Req) => Promise<Resp | void> | Resp | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const MAX_BODY = 2 * 1024 * 1024;

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
  }
  get(p: string, h: Handler): void { this.add("GET", p, h); }
  post(p: string, h: Handler): void { this.add("POST", p, h); }

  async dispatch(raw: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(raw.url ?? "/", "http://localhost");
    const path = url.pathname;
    const segs = path.split("/").filter(Boolean);
    let bodyRaw = Buffer.alloc(0);
    if (raw.method === "POST" || raw.method === "PUT" || raw.method === "PATCH") {
      bodyRaw = await readBody(raw);
      if (bodyRaw.length > MAX_BODY) {
        return send(res, { status: 413, json: { error: { code: "payload_too_large", message: "body exceeds 2MiB" } } });
      }
    }
    let body: any = undefined;
    if (bodyRaw.length > 0) {
      const ctype = String(raw.headers["content-type"] ?? "");
      if (ctype.includes("application/json")) {
        try {
          body = JSON.parse(bodyRaw.toString("utf8"));
        } catch {
          return send(res, { status: 400, json: { error: { code: "invalid_json", message: "request body is not valid JSON" } } });
        }
      } else if (ctype.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(bodyRaw.toString("utf8")));
      } else {
        body = bodyRaw.toString("utf8");
      }
    }
    for (const route of this.routes) {
      if (route.method !== raw.method) continue;
      const params = matchSegments(route.segments, segs);
      if (!params) continue;
      const req: Req = {
        method: raw.method ?? "GET",
        path,
        params,
        query: url.searchParams,
        headers: raw.headers,
        body,
        raw,
        res,
      };
      try {
        const out = await route.handler(req);
        if (!res.writableEnded) send(res, out ?? { status: 200, json: { ok: true } });
      } catch (e) {
        if (!res.writableEnded) {
          if (e && typeof e === "object" && "redirect" in (e as any)) {
            send(res, { status: 303, headers: { location: (e as any).redirect }, text: "" });
          } else {
            sendError(res, e, path.startsWith("/console"));
          }
        }
      }
      return;
    }
    sendError(res, new ApiError(404, "not_found", `${raw.method} ${path}`), path.startsWith("/console"));
  }
}

function matchSegments(pattern: string[], segs: string[]): Record<string, string> | null {
  if (pattern.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith("{") && p.endsWith("}")) params[p.slice(1, -1)] = decodeURIComponent(segs[i]);
    else if (p !== segs[i]) return null;
  }
  return params;
}

function readBody(raw: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    raw.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY + 1) {
        reject(new Error("too large"));
        raw.destroy();
        return;
      }
      chunks.push(c);
    });
    raw.on("end", () => resolve(Buffer.concat(chunks)));
    raw.on("error", reject);
  });
}

export function send(res: http.ServerResponse, r: Resp): void {
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  let payload: string | Buffer = "";
  if (r.json !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(r.json);
  } else if (r.html !== undefined) {
    headers["content-type"] = "text/html; charset=utf-8";
    payload = r.html;
  } else if (r.text !== undefined) {
    headers["content-type"] ??= "text/plain; charset=utf-8";
    payload = r.text;
  }
  res.writeHead(r.status ?? 200, headers);
  res.end(payload);
}

function sendError(res: http.ServerResponse, e: unknown, consolePage = false): void {
  if (!(e instanceof ApiError)) {
    console.error("unhandled route error:", e);
    e = new ApiError(500, "internal", "internal error");
  }
  const err = e as ApiError;
  if (consolePage) {
    const h = (s: string) => s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    send(res, {
      status: err.status,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Error ${err.status}</title>
<style>body{font-family:"DM Sans",ui-sans-serif,system-ui,sans-serif;background:#FEF8F0;color:#1F1A14;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
h1{font-family:"Crimson Text",Georgia,serif;font-weight:600}
.error{background:#FBE7DE;color:#A23A1A;border:1px solid #E7B7A3;padding:.6rem .8rem;border-radius:.45rem}
a{color:#485C11;text-underline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#211B14;color:#F2ECDF}
.error{background:#4A2013;color:#F0A98C;border-color:#7A4430}a{color:#7C9A3D}}</style></head>
<body><main><h1>${err.status} ${h(err.code)}</h1><p class="error" role="alert">${h(err.message)}</p>
<p><a href="/console">Back to the console</a></p></main></body></html>`,
    });
    return;
  }
  send(res, { status: err.status, json: { error: { code: err.code, message: err.message, details: err.details } } });
}
