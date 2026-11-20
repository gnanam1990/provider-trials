import crypto from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

export function sha256hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sortValue(v: any): any {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) o[k] = sortValue(v[k]);
    return o;
  }
  return v;
}

/** Deterministic JSON for hashing: object keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

export function generateEd25519(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signEd25519(data: string, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(data, "utf8"), privateKeyPem).toString("base64url");
}

export function verifyEd25519(data: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(data, "utf8"),
      publicKeyPem,
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    return false;
  }
}

export function hmacSign(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function secureCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Nearest-rank percentile over an ascending-sorted array; null when empty. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

export function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
