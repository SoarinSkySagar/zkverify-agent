import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

/** HMAC-SHA256 over the exact bytes, hex-encoded (/guide: `x-agent-games-signature: <hmac-sha256-hex>`). */
export function sign(body: Buffer | string, key: Buffer): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

/**
 * Constant-time check of the signature header against the RAW request body.
 * Accepts an optional "sha256=" prefix; anything that isn't 64 hex chars is rejected.
 */
export function verify(rawBody: Buffer, header: string | string[] | undefined, key: Buffer): boolean {
  if (typeof header !== "string") return false;
  const provided = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = Buffer.from(sign(rawBody, key), "hex");
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

/** Returns the first key the signature verifies under, or undefined. */
export function verifyAny(rawBody: Buffer, header: string | string[] | undefined, keys: readonly Buffer[]): Buffer | undefined {
  return keys.find((k) => verify(rawBody, header, k));
}
