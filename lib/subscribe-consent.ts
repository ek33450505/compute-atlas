import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cookie name for the subscribe auto-confirm consent proof. Deliberately
 * unrelated to `admin_session` (`lib/admin-session.ts`): different audience,
 * different key, different lifetime, zero shared state — this cookie grants
 * NO privilege of any kind, it only proves which address this browser most
 * recently proved it can receive mail at.
 */
export const CONSENT_COOKIE_NAME = "sub_consent";

/**
 * Server-side lifetime. This is the value that actually expires the proof —
 * `verifyConsentCookie` checks the cookie's own signed `issuedAt` against it
 * on every request. The cookie's `maxAge` attribute (set by the confirm
 * route, which imports `CONSENT_MAX_AGE_SECONDS` below so the two can't
 * drift) is only a client-side hint a replaying attacker ignores.
 *
 * 30 minutes because of what the shortcut is FOR: a person who just clicked
 * a confirm link in their mail client and is adding a second watch in the
 * same sitting. Anything longer only widens the window in which a replayed
 * old confirm URL (see `"already"` in the confirm route) still yields a
 * usable proof, and buys no real user anything.
 */
const CONSENT_MAX_AGE_MS = 30 * 60 * 1000;
export const CONSENT_MAX_AGE_SECONDS = CONSENT_MAX_AGE_MS / 1000;

/**
 * Tolerance for clock skew between the instance that issued the cookie and
 * the one verifying it (e.g. across a rolling deploy) — not a grace window.
 * Same value and reasoning as `lib/admin-session.ts`.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const CONSENT_VERSION = "v1";
const NONCE_BYTES = 16;
const NONCE_HEX_PATTERN = /^[0-9a-f]{32}$/; // NONCE_BYTES * 2 hex chars
const TAG_HEX_PATTERN = /^[0-9a-f]{64}$/; // sha256 digest, hex-encoded
const HMAC_HEX_PATTERN = /^[0-9a-f]{64}$/; // sha256 digest, hex-encoded
const ISSUED_AT_PATTERN = /^\d+$/; // plain non-negative integer, no sign/decimal/exponent

/**
 * Domain-separation label. The signing key is NOT `CONTRIBUTE_IP_SALT`
 * itself but `HMAC(salt, label)`, so this cookie's key is cryptographically
 * independent of the salt's other use (the stored `submitter_ip_hash` /
 * notify-email digests in `lib/rate-limit.ts`). Consequence that matters: a
 * cookie an attacker collects reveals nothing usable against those stored
 * hashes, and nothing derived from those hashes can forge a cookie.
 *
 * Bump the label — never the salt — if this scheme ever needs invalidating;
 * `CONTRIBUTE_IP_SALT` must keep its exact value forever or every
 * already-stored `submitter_ip_hash` is orphaned (see that file's stability
 * note).
 */
const KEY_DOMAIN = "subscribe-consent-v1";

/**
 * Resolves the signing key, or `undefined` when no key is configured.
 *
 * WHY `CONTRIBUTE_IP_SALT` AND NOT A NEW VAR: a new Vercel env var is
 * invisible to already-built deployments — it reads `undefined` in the
 * running function until a redeploy — so a dedicated variable would ship
 * this feature silently fully-closed (every subscriber back to double
 * opt-in) until someone noticed and redeployed. `CONTRIBUTE_IP_SALT` is
 * already set in production, already treated as a secret, and already
 * signing-grade, so this works the moment it deploys. It is emphatically NOT
 * `API_ADMIN_TOKEN`: that token IS the admin credential, and keying anything
 * reachable from an unauthenticated public endpoint on it would widen that
 * credential's blast radius for no benefit.
 *
 * FAILS CLOSED, and deliberately does NOT reuse `resolveContributeSalt`'s
 * public fallback salt. That fallback exists so local dev and preview can
 * still *pseudonymize*; using it here would mean anyone reading this open
 * repo could forge a valid consent cookie against any preview deployment. No
 * env var ⇒ no key ⇒ no valid cookie ⇒ no auto-confirm ⇒ ordinary double
 * opt-in, which is the safe direction. Local dev and preview therefore never
 * auto-confirm unless the var is set there too.
 */
function resolveConsentKey(): string | undefined {
  const salt = process.env.CONTRIBUTE_IP_SALT;
  if (!salt) {
    return undefined;
  }
  return createHmac("sha256", salt).update(KEY_DOMAIN).digest("hex");
}

/**
 * Normalized exactly as `subscribeToTarget` normalizes the submitted address
 * (`trim().toLowerCase()`) and as `subscriptions.email` is stored, so the
 * issuing side (a DB row) and the verifying side (a request body) always
 * agree on the same input.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Keyed tag binding a cookie to ONE address. Keyed, not a bare sha256, for
 * one reason: a bare digest of an email address is trivially reversible by
 * dictionary, so a cookie captured from a browser would disclose whose it is.
 * Under the derived key it discloses nothing.
 *
 * It is not a secret and does not need to be — the outer HMAC covers it, so
 * it cannot be edited in place, and the requester already knows their own
 * address.
 */
function emailTag(email: string, key: string): string {
  return createHmac("sha256", key).update(`email:${normalizeEmail(email)}`).digest("hex");
}

/**
 * HMAC covering version, issuedAt and nonce AND the email tag — all four in
 * the signed input, not appended after the fact, so none of them can be
 * swapped (most importantly: the tag can't be re-pointed at another address).
 */
function signParts(issuedAtMs: number, nonce: string, tag: string, key: string): string {
  return createHmac("sha256", key)
    .update(`${CONSENT_VERSION}.${issuedAtMs}.${nonce}.${tag}`)
    .digest("hex");
}

/**
 * Produces the cookie value to set when a browser completes a confirm for
 * `email`. Returns `undefined` when no key is configured — the caller then
 * simply sets no cookie (see `resolveConsentKey`).
 *
 * Format: `v1.<issuedAtMs>.<nonceHex>.<emailTagHex>.<hmacHex>` — a version
 * prefix (so verification can dispatch on it), a millisecond issued-at (so a
 * captured cookie ages out server-side), per-issue randomness (so two
 * confirms never produce the same value), the address binding, and an HMAC
 * over the other four parts.
 *
 * Every field is drawn from a fixed, delimiter-free charset (digits for
 * `issuedAtMs`, lowercase hex for nonce/tag/HMAC) and `verifyConsentCookie`
 * re-validates that charset after splitting, so no field's content can
 * smuggle an extra `.` and shift what the parser reads as the next field.
 */
export function createConsentValue(email: string): string | undefined {
  const key = resolveConsentKey();
  if (!key) {
    return undefined;
  }
  const issuedAtMs = Date.now();
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const tag = emailTag(email, key);
  const hmac = signParts(issuedAtMs, nonce, tag, key);
  return `${CONSENT_VERSION}.${issuedAtMs}.${nonce}.${tag}.${hmac}`;
}

/**
 * True iff `cookieValue` is a cookie WE issued, still inside its server-side
 * lifetime, and bound to `email`.
 *
 * Order matters: format/charset first (cheap, and it keeps malformed input
 * out of crypto calls that expect well-formed hex), then the HMAC — which
 * authenticates `issuedAtMs`, `nonce` and the tag together — and only once
 * the value is proven untampered do we trust `issuedAtMs` enough to decide
 * expiry, or the tag enough to compare it against this request's address.
 *
 * NEVER THROWS and never touches I/O: pure crypto over in-memory strings.
 * That is load-bearing for `subscribeToTarget`'s latency symmetry — see the
 * note at its call site.
 */
export function verifyConsentCookie(cookieValue: string | undefined, email: string): boolean {
  const key = resolveConsentKey();
  if (!key) {
    return false; // fail closed — no key, no auto-confirm
  }
  if (!cookieValue) {
    return false;
  }
  if (!cookieValue.startsWith(`${CONSENT_VERSION}.`)) {
    return false;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 5) {
    return false;
  }
  const [version, issuedAtRaw, nonce, presentedTag, presentedHmacHex] = parts;
  if (version !== CONSENT_VERSION) {
    return false;
  }
  if (!ISSUED_AT_PATTERN.test(issuedAtRaw)) {
    return false;
  }
  if (!NONCE_HEX_PATTERN.test(nonce)) {
    return false;
  }
  if (!TAG_HEX_PATTERN.test(presentedTag)) {
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

  const expectedHmac = Buffer.from(signParts(issuedAtMs, nonce, presentedTag, key), "hex");
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
  if (now - issuedAtMs > CONSENT_MAX_AGE_MS) {
    return false; // server-side expiry
  }

  // Address binding, checked LAST because it is only meaningful once the tag
  // is known to be one we signed. Without it the cookie would prove only
  // "this browser confirmed SOME address", which an attacker obtains for
  // free by confirming a throwaway address of their own — and could then
  // spend on any victim address that has ever confirmed. That is the exact
  // hole this module exists to close, so the binding is the point, not a
  // refinement.
  const expectedTag = Buffer.from(emailTag(email, key), "hex");
  const tag = Buffer.from(presentedTag, "hex");
  return tag.length === expectedTag.length && timingSafeEqual(tag, expectedTag);
}

/**
 * Pulls the consent cookie out of a raw `Cookie` header.
 *
 * Hand-parsed (rather than via `NextRequest.cookies`) so the route handlers
 * keep their plain-`Request` signatures and this stays unit-testable with a
 * bare `Headers`. Safe to do here because the value's charset is a strict
 * subset of the cookie-value grammar — `[0-9a-f.]` only — so there is
 * nothing to percent-decode and any encoded variant simply fails
 * verification. First occurrence wins, matching `NextResponse.cookies.get`.
 */
export function readConsentCookie(headers: Headers): string | undefined {
  const raw = headers.get("cookie");
  if (!raw) {
    return undefined;
  }
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() !== CONSENT_COOKIE_NAME) {
      continue;
    }
    const value = pair.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}
