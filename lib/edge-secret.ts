import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Request header a Cloudflare Transform Rule injects on every request that
 * traverses the edge. Its value is compared against `EDGE_SHARED_SECRET`.
 *
 * Deliberately not prefixed `cf-`/`x-cf-`: Cloudflare reserves those names
 * and a Transform Rule cannot set them.
 */
export const EDGE_SECRET_HEADER = "x-edge-shared-secret";

/**
 * True when `headers` carries the edge shared secret and it matches
 * `EDGE_SHARED_SECRET`. False when the secret is unset or empty (nothing can
 * be proven), or the header is missing or wrong. Does NOT look at
 * `VERCEL_ENV`: callers decide what "not production" means for them.
 *
 * Compares by SHA-256 hashing both sides to a fixed 32-byte digest, then
 * `timingSafeEqual`: it throws on a length mismatch, and the throw/no-throw
 * branch would leak the expected secret's length. Shared by `proxy.ts` and
 * `lib/rate-limit.ts` so the two never fork.
 */
export function hasValidEdgeSecret(headers: Headers): boolean {
  const expected = process.env.EDGE_SHARED_SECRET;
  if (!expected) {
    return false;
  }

  const presented = headers.get(EDGE_SECRET_HEADER);
  if (!presented) {
    return false;
  }

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}
