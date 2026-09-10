/**
 * Webhook signature verification (spec 04 §2.4): `Webhook-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.
 * Web Crypto only, so it runs in Node 18+, Deno, Bun and Workers.
 */
const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VerifyOptions {
  /** Maximum age of the timestamp in seconds (default 300). */
  toleranceSeconds?: number;
  /** Unix seconds "now"; tests pass a fixed clock. */
  now?: number;
}

/**
 * Returns true when the header matches the raw body. Pass the body exactly as received (not
 * re-serialised JSON): the signature covers the bytes on the wire.
 */
export async function verifyWebhookSignature(
  secret: string,
  signatureHeader: string | null | undefined,
  rawBody: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const parts = new Map(signatureHeader.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.get('t'));
  const v1 = (parts.get('v1') ?? '').toLowerCase();
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

/** Parses a verified event body. Throws when the signature does not match. */
export async function parseWebhookEvent<T = { id: string; type: string; created_at: string; workspace_id: string | null; data: unknown }>(
  secret: string,
  signatureHeader: string | null | undefined,
  rawBody: string,
  options: VerifyOptions = {},
): Promise<T> {
  if (!(await verifyWebhookSignature(secret, signatureHeader, rawBody, options)))
    throw new Error('invalid webhook signature');
  return JSON.parse(rawBody) as T;
}
