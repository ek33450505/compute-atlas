import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cookie name for the admin UI session. Distinct from the `Authorization:
 * Bearer` header used by the JSON write API (`lib/api-auth.ts`) — same
 * secret (`API_ADMIN_TOKEN`), different transport.
 */
export const SESSION_COOKIE_NAME = "admin_session";

/**
 * Server-side session lifetime. This is the value that actually expires a
 * session — `verifySessionCookie` checks a v2 cookie's own embedded
 * `issuedAt` against it on every request. The cookie's `maxAge` attribute
 * (set in `app/admin/login/actions.ts`, which imports this constant so the
 * two can't drift) is only ever a client-side hint the browser uses to stop
 * *sending* an old cookie; an attacker replaying a stolen value ignores it
 * entirely, so it is not a security control on its own (see #237).
 */
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000; // 7 days
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;

/**
 * How far into the future an `issuedAt` may sit before it's rejected as
 * forged/malformed rather than merely a bit ahead due to clock skew between
 * the server that issued the cookie and the one verifying it (e.g. across a
 * rolling deploy). Small on purpose — this is tolerance, not a grace window.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

const SESSION_VERSION = "v2";
const NONCE_BYTES = 16;
const NONCE_HEX_PATTERN = /^[0-9a-f]{32}$/; // NONCE_BYTES * 2 hex chars
const HMAC_HEX_PATTERN = /^[0-9a-f]{64}$/; // sha256 digest, hex-encoded
const ISSUED_AT_PATTERN = /^\d+$/; // plain non-negative integer, no sign/decimal/exponent

/**
 * Computes the HMAC covering a v2 cookie's version, issuedAt, and nonce,
 * keyed by the raw `API_ADMIN_TOKEN`. Only something holding the token can
 * produce a value that verifies — this is what makes the cookie
 * server-verifiable rather than just a client-trusted blob, and covering
 * `issuedAt`/`nonce` in the signed input (not appending them unsigned after
 * the fact) is what stops either field from being edited in place.
 */
function signV2Parts(issuedAtMs: number, nonce: string, token: string): string {
  return createHmac("sha256", token)
    .update(`${SESSION_VERSION}.${issuedAtMs}.${nonce}`)
    .digest("hex");
}

/**
 * Produces the cookie value to store at login time.
 *
 * Format: `v2.<issuedAtMs>.<nonceHex>.<hmacHex>` — an explicit version
 * prefix (so verification can dispatch on it), a millisecond issued-at
 * timestamp (so a leaked cookie ages out on its own — see
 * `SESSION_MAX_AGE_MS`), per-session randomness (so two logins never
 * produce the same value, unlike the old bare-hash-of-the-token scheme),
 * and an HMAC over the other three parts.
 *
 * Every field is drawn from a fixed, delimiter-free charset (digits for
 * `issuedAtMs`, lowercase hex for the nonce and HMAC) and `verifySessionCookie`
 * re-validates that charset after splitting — so even though `.` is also a
 * valid separator *within* a field's own alphabet in principle, no field's
 * content can smuggle an extra `.` and shift what the parser reads as the
 * next field, because a value containing one would fail its own format
 * check and be rejected outright.
 */
export function createSessionValue(token: string): string {
  const issuedAtMs = Date.now();
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const hmac = signV2Parts(issuedAtMs, nonce, token);
  return `${SESSION_VERSION}.${issuedAtMs}.${nonce}.${hmac}`;
}

/**
 * Verifies a v2 (`v2.<issuedAtMs>.<nonceHex>.<hmacHex>`) cookie value.
 *
 * Order matters: format/charset checks first (cheap, and they reject
 * garbage before it ever reaches crypto calls that expect well-formed
 * input), then the HMAC — which authenticates `issuedAtMs` and `nonce`
 * together, so a tampered timestamp or nonce fails here even before the
 * expiry check runs — and only once the value is proven untampered do we
 * trust `issuedAtMs` enough to make an expiry/future-dating decision from it.
 */
function verifyV2SessionCookie(cookieValue: string, token: string): boolean {
  const parts = cookieValue.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [version, issuedAtRaw, nonce, presentedHmacHex] = parts;
  if (version !== SESSION_VERSION) {
    return false;
  }
  if (!ISSUED_AT_PATTERN.test(issuedAtRaw)) {
    return false;
  }
  if (!NONCE_HEX_PATTERN.test(nonce)) {
    return false;
  }
  if (!HMAC_HEX_PATTERN.test(presentedHmacHex)) {
    return false;
  }

  // Number()/parseInt on an over-long digit string can overflow past
  // Number.MAX_SAFE_INTEGER (or, for a truly enormous string, to Infinity);
  // isSafeInteger rejects both rather than silently truncating precision.
  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAtMs)) {
    return false;
  }

  const expectedHmacHex = signV2Parts(issuedAtMs, nonce, token);
  const expectedHmac = Buffer.from(expectedHmacHex, "hex");
  const presentedHmac = Buffer.from(presentedHmacHex, "hex");
  if (presentedHmac.length !== expectedHmac.length) {
    return false;
  }
  if (!timingSafeEqual(presentedHmac, expectedHmac)) {
    return false;
  }

  const now = Date.now();
  if (issuedAtMs > now + CLOCK_SKEW_TOLERANCE_MS) {
    return false; // future-dated beyond tolerance — not a value we issued
  }
  if (now - issuedAtMs > SESSION_MAX_AGE_MS) {
    return false; // server-side expiry — the whole point of #237
  }

  return true;
}

/**
 * Validates a session cookie against the current `API_ADMIN_TOKEN`.
 *
 * Fails CLOSED: if `API_ADMIN_TOKEN` is unset/empty, or the cookie is
 * missing/empty, every request is rejected — there is no "auth disabled"
 * mode. Only the current `v2.` scheme is accepted; anything else (including
 * the retired bare-hash v1 format — see #237) is rejected outright.
 */
export function verifySessionCookie(cookieValue: string | undefined): boolean {
  const expected = process.env.API_ADMIN_TOKEN;
  if (!expected) {
    return false;
  }
  if (!cookieValue) {
    return false;
  }

  if (!cookieValue.startsWith(`${SESSION_VERSION}.`)) {
    return false;
  }

  return verifyV2SessionCookie(cookieValue, expected);
}
