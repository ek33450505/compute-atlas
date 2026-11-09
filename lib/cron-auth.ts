import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron's convention: when `CRON_SECRET` is set, Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation.
 *
 * Both sides are SHA-256'd to a fixed 32-byte digest before `timingSafeEqual`, matching
 * `requireAdmin` in lib/api-auth.ts (read its doc comment): hashing first keeps the
 * comparison constant-time, avoids `timingSafeEqual` throwing on a length mismatch, and
 * avoids leaking the expected secret's length through a bare `a.length !== b.length` early
 * return. Never `===`.
 *
 * The presented bearer is trimmed but `CRON_SECRET` is compared exactly: set it in Vercel
 * without surrounding whitespace (a trailing newline there makes every cron run 401).
 *
 * Fails CLOSED: an unset/empty `CRON_SECRET` rejects every caller. There is no
 * "auth disabled" mode.
 */
export function hasValidCronSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim();
  if (!presented) return false;

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}
