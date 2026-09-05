import { createHash } from "node:crypto";

/**
 * Raw tokens (`generateToken()`, lib/email.ts) are 43-char base64url strings
 * — the form shown to a token's owner exactly once, embedded in a confirm or
 * bulk-access email. The stored form is this file's sha256 hex digest (64
 * lowercase hex chars), so a DB leak yields no usable credential.
 *
 * Every lookup call site (lib/subscribe.ts, lib/access-grants.ts,
 * lib/api-daily-limit.ts) compares `hashToken(presented) === stored`, never a
 * raw-value equality. Rows written before this hardening still hold the raw
 * value; each call site also carries a legacy raw-equality fallback that
 * upgrades a matched row to its hash as part of the same request, and
 * `scripts/hash-tokens-backfill.ts` sweeps any rows that never get another
 * lookup. `subscriptions.unsubscribe_token` is the one deliberate exception —
 * it is never hashed (see its column comment in lib/db/schema.ts).
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const HASHED_TOKEN_RE = /^[0-9a-f]{64}$/;

/** True when `value` is already a sha256 hex digest (64 lowercase hex chars) — i.e. already hashed, not a raw legacy token. */
export function isHashedToken(value: string): boolean {
  return HASHED_TOKEN_RE.test(value);
}
