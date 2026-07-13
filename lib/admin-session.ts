import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cookie name for the admin UI session. Distinct from the `Authorization:
 * Bearer` header used by the JSON write API (`lib/api-auth.ts`) — same
 * secret (`API_ADMIN_TOKEN`), different transport.
 */
export const SESSION_COOKIE_NAME = "admin_session";

/**
 * Produces the cookie value to store at login time. Hashes the raw token
 * once with SHA-256; this hash IS the cookie value (never the raw token).
 *
 * Mirrors the hash step in `lib/api-auth.ts`'s `requireAdmin` — same
 * algorithm, same idiom — but only ever called with the already-verified
 * token (see `app/admin/login/actions.ts`), never with untrusted input.
 */
export function createSessionValue(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Validates a session cookie against the current `API_ADMIN_TOKEN`.
 *
 * Fails CLOSED: if `API_ADMIN_TOKEN` is unset/empty, or the cookie is
 * missing, every request is rejected — there is no "auth disabled" mode.
 *
 * Re-hashes `API_ADMIN_TOKEN` fresh per request (same SHA-256 step as
 * `createSessionValue`) and `timingSafeEqual`-compares the two digests —
 * hashing first avoids `timingSafeEqual` throwing on a length mismatch and
 * avoids leaking token length via a throw/no-throw side channel. This is a
 * single hash+compare, not a double-hash of the stored value.
 */
export function verifySessionCookie(cookieValue: string | undefined): boolean {
  const expected = process.env.API_ADMIN_TOKEN;
  if (!expected) {
    return false;
  }
  if (!cookieValue) {
    return false;
  }

  const expectedHash = createHash("sha256").update(expected).digest();

  let presentedHash: Buffer;
  try {
    presentedHash = Buffer.from(cookieValue, "hex");
  } catch {
    return false;
  }

  if (presentedHash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(presentedHash, expectedHash);
}
