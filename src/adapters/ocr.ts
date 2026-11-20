import type { Ctx } from "../context.ts";
import { fetchUrl } from "../lib/httpClient.ts";

/**
 * Seller adapter contract (KITE-AND-PROVIDERS): quote, execute, inspect status.
 * Refund/cancel are not supported by the emulator and are never invented.
 * Transport and credentials bind to the provider's declared endpoint origin.
 */

export interface QuoteResult {
  price_minor: number;
  asset: string;
}

export interface ReceiptPayload {
  receipt_id: string;
  invocation_ref: string;
  trial_id: string;
  amount_minor: number;
  asset: string;
  environment?: string;
  digest: string;
  signature: string;
}

export interface ExecuteInput {
  invocation_ref: string;
  trial_id: string;
  sample_url: string;
  sample_key: string;
}

export interface ExecuteResult {
  fields: Record<string, string>;
  receipt: ReceiptPayload;
}

export interface StatusResult {
  state: "settled" | "unknown";
  result?: { fields: Record<string, string> };
  receipt?: ReceiptPayload;
}

export interface OcrAdapter {
  quote(ctx: Ctx, origin: string): Promise<QuoteResult>;
  execute(ctx: Ctx, origin: string, input: ExecuteInput, timeoutMs: number): Promise<ExecuteResult>;
  status(ctx: Ctx, origin: string, invocationRef: string): Promise<StatusResult>;
}

/** Speaks the documented local OCR adapter endpoints on the declared origin. */
export class HttpOcrAdapter implements OcrAdapter {
  async quote(ctx: Ctx, origin: string): Promise<QuoteResult> {
    const r = await fetchUrl(`${origin}/quote`, {
      method: "POST",
      timeoutMs: ctx.config.dispatchTimeoutMs,
      allowedHosts: ctx.config.allowedHosts,
    });
    if (r.status !== 200 || typeof r.json?.price_minor !== "number") {
      throw new Error(`quote failed: status ${r.status}`);
    }
    return { price_minor: r.json.price_minor, asset: r.json.asset ?? "cent" };
  }

  async execute(
    ctx: Ctx,
    origin: string,
    input: ExecuteInput,
    timeoutMs: number,
  ): Promise<ExecuteResult> {
    const r = await fetchUrl(`${origin}/ocr`, {
      method: "POST",
      json: input,
      timeoutMs,
      allowedHosts: ctx.config.allowedHosts,
    });
    if (r.status !== 200) {
      throw new Error(`ocr execute failed: status ${r.status}`);
    }
    const j = r.json;
    if (!j?.receipt) throw new Error("ocr response missing receipt");
    return { fields: j.result?.fields ?? {}, receipt: j.receipt };
  }

  async status(ctx: Ctx, origin: string, invocationRef: string): Promise<StatusResult> {
    const r = await fetchUrl(
      `${origin}/status?invocation_ref=${encodeURIComponent(invocationRef)}`,
      { timeoutMs: ctx.config.dispatchTimeoutMs, allowedHosts: ctx.config.allowedHosts },
    );
    if (r.status !== 200 || !r.json) return { state: "unknown" };
    return r.json as StatusResult;
  }
}
