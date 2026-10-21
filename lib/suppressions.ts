import { and, eq, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { redactedErrorCode } from "@/lib/db-error";
import { emailSuppressionsTable, subscriptionsTable } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { verifyConsentCookieIssuedAt } from "@/lib/subscribe-consent";
import { hashToken } from "@/lib/token-hash";

/**
 * Durable opt-out list (table `email_suppressions`; see its doc comment in
 * lib/db/schema.ts). Nothing here sends mail or touches `subscriptions` rows
 * except to resolve an unsubscribe token into an address.
 *
 * `db` is structural so the neon-http client and PGlite (tests) both fit.
 *
 * LOGGING: `suppress` and `lift` can throw a Drizzle error whose message
 * embeds bound parameters, including the address. Callers MUST log a caught
 * error only via `redactedErrorCode`, never the error object.
 */
export type SuppressionDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type SuppressionSource = "unsubscribe" | "unsubscribe_all" | "backfill" | "admin";

/** A global opt-out names no target; a target opt-out names exactly one. */
export type SuppressionScope =
  { kind: "global" } | { kind: "target"; targetType: string; targetId: string };

/** Same normalization as `subscribeToTarget` (lib/subscribe.ts): trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonical (targetType, targetId) key for a scope, normalized the way
 * `subscribeToTarget` stores them (state codes uppercase, ids trimmed) so a
 * caller cannot mismatch. Global is the empty pair.
 */
function scopeKey(scope: SuppressionScope): {
  targetType: string;
  targetId: string;
} {
  if (scope.kind === "global") {
    return { targetType: "", targetId: "" };
  }
  const targetType = scope.targetType.trim();
  let targetId = scope.targetId.trim();
  if (targetType === "state") {
    targetId = targetId.toUpperCase();
  }
  // An empty half would silently become (part of) the global key.
  if (!targetType || !targetId) {
    throw new Error("target suppression requires a non-empty targetType and targetId");
  }
  return { targetType, targetId };
}

/**
 * Margin for the global-lift ordering check. Row `created_at` and cookie
 * `issuedAt` are both stamped by the app clock (`suppress` sets `createdAt`
 * explicitly), but different serverless instances can still disagree by a
 * little. A cookie must postdate the global row by MORE than this to lift it,
 * so skew can only ever err toward refusing; a refused person just confirms
 * again. Distinct from the consent module's 5-minute future-dating tolerance,
 * which is far too wide for an ordering guard.
 */
export const CONSENT_LIFT_SKEW_MS = 5000;

export type SuppressionStatus = "suppressed" | "clear" | "unknown";

/**
 * The ONLY sanctioned way to turn a status into a send/no-send decision (or
 * use an exhaustive `switch` over all three values). Never write
 * `status !== "suppressed"` or test the status for truthiness: all three
 * values are truthy strings, and those forms fail OPEN on "unknown".
 */
export function mayEmail(status: SuppressionStatus): boolean {
  return status === "clear";
}

/**
 * Whether mail to this address for this scope is blocked: a GLOBAL row, or
 * (for a target scope) the exact target row. A `{kind:"global"}` scope asks
 * only about the global row.
 *
 * Three states, because a lookup failure must not look like either answer:
 *   - "suppressed": do not send.
 *   - "clear":      no opt-out on record.
 *   - "unknown":    the lookup errored. Callers MUST treat this as do-not-send
 *                   AND record it (the send log stores it as an outcome such
 *                   as `skipped_suppression_unknown`); never collapse it into
 *                   "clear", and never into a silent "suppressed".
 * Errors log the fixed prefix `isSuppressed lookup failed` plus the SQLSTATE.
 */
export async function isSuppressed(
  db: SuppressionDb,
  email: string,
  scope: SuppressionScope
): Promise<SuppressionStatus> {
  let key: { targetType: string; targetId: string };
  try {
    key = scopeKey(scope);
  } catch {
    // A caller bug, not an outage: still fail closed, but log it distinctly.
    console.error("isSuppressed invalid scope (caller bug)");
    return "unknown";
  }
  try {
    const globalRow = and(
      eq(emailSuppressionsTable.targetType, ""),
      eq(emailSuppressionsTable.targetId, "")
    );
    const rows = await db
      .select({ id: emailSuppressionsTable.id })
      .from(emailSuppressionsTable)
      .where(
        and(
          eq(emailSuppressionsTable.email, normalizeEmail(email)),
          scope.kind === "global"
            ? globalRow
            : or(
                globalRow,
                and(
                  eq(emailSuppressionsTable.targetType, key.targetType),
                  eq(emailSuppressionsTable.targetId, key.targetId)
                )
              )
        )
      )
      .limit(1);
    return rows.length > 0 ? "suppressed" : "clear";
  } catch (err) {
    console.error(`isSuppressed lookup failed (sqlstate: ${redactedErrorCode(err)})`);
    return "unknown";
  }
}

/**
 * Query-side twin of `isSuppressed` for the notify recipient queries: a
 * correlated boolean over a `subscriptions` row, true when a global row or
 * that row's exact target row exists. Select it as a column and drop the
 * rows where it is true. A lookup failure fails the WHOLE recipient query,
 * which the notify callers catch, so an error means nobody is mailed
 * (the SQL form of "unknown means do not send").
 */
export function subscriptionSuppressedSql() {
  // Table-qualified RAW identifiers on purpose: drizzle renders a column
  // interpolated into `sql` without its table prefix when the outer query has
  // one table, which would make every inner reference resolve to the
  // suppressions table and match every row. Pinned by the
  // `subscriptionSuppressedSql` tests in lib/suppressions.integration.test.ts.
  return sql<boolean>`exists (
    select 1 from "email_suppressions" "es"
    where "es"."email" = lower("subscriptions"."email")
      and (
        ("es"."target_type" = '' and "es"."target_id" = '')
        or (
          "es"."target_type" = "subscriptions"."target_type"
          and "es"."target_id" = coalesce("subscriptions"."target_id", '')
        )
      )
  )`;
}

/**
 * Idempotent: suppressing an already-suppressed (email, scope) is a no-op.
 *
 * `sourceTokenHash` (the hashToken() of the raw unsubscribe token, never the
 * raw token) is stored for the "Undo" action. Because a conflict does nothing,
 * a second stop-all with a DIFFERENT token keeps the FIRST token as the undo
 * key: the first stop-all wins.
 */
export async function suppress(
  db: SuppressionDb,
  email: string,
  scope: SuppressionScope,
  source: SuppressionSource,
  sourceTokenHash?: string
): Promise<void> {
  await db
    .insert(emailSuppressionsTable)
    // createdAt from the app clock (not the DB default) so it is comparable
    // with a cookie's app-stamped issuedAt in `lift`.
    .values({
      email: normalizeEmail(email),
      ...scopeKey(scope),
      source,
      sourceTokenHash: sourceTokenHash ?? null,
      createdAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        emailSuppressionsTable.email,
        emailSuppressionsTable.targetType,
        emailSuppressionsTable.targetId,
      ],
    });
}

/**
 * Proof that the caller controls the inbox for one address: an opted-out
 * address can come back ONLY with proof of inbox, and a stranger never can.
 * Not constructible by hand: the only way to get one is a factory below, and
 * `lift` re-checks a private registry, so a cast or object literal is refused
 * at runtime too.
 *
 * Each proof is limited to what it demonstrably covers:
 *   - consent cookie: the address, any scope (target OR global); a row only
 *     if the cookie was issued more than CONSENT_LIFT_SKEW_MS after that row
 *     was created.
 *   - unsubscribe token: the address AND the issuing subscription row's exact
 *     target. It lifts the GLOBAL row only if the token's hash equals that
 *     row's `source_token_hash`, i.e. it is the very token that stopped all
 *     email. So an old per-target email, another token for the address, or a
 *     scanner prefetching a Resume link cannot undo a "stop all" it did not
 *     write; backfilled and admin rows (NULL hash) can't be lifted by a token.
 */
declare const inboxProofBrand: unique symbol;
export interface InboxProof {
  readonly [inboxProofBrand]: true;
  readonly email: string;
  readonly via: "consent_cookie" | "unsubscribe_token";
}

type ProofGrant = "any" | { targetType: string; targetId: string; tokenHash: string };

interface IssuedProof {
  email: string;
  grant: ProofGrant;
  /** Cookie proofs only: when the consent cookie was minted (ms). */
  issuedAtMs?: number;
}

const issuedProofs = new WeakMap<object, IssuedProof>();

function issueProof(
  email: string,
  via: InboxProof["via"],
  grant: ProofGrant,
  issuedAtMs?: number
): InboxProof {
  const proof = Object.freeze({ email, via }) as unknown as InboxProof;
  issuedProofs.set(proof, { email, grant, issuedAtMs });
  return proof;
}

/** Valid, unexpired consent cookie bound to this address (fails closed without a key). */
export function inboxProofFromConsentCookie(
  cookieValue: string | undefined,
  email: string
): InboxProof | null {
  const normalized = normalizeEmail(email);
  const issuedAtMs = verifyConsentCookieIssuedAt(cookieValue, normalized);
  return issuedAtMs === null ? null : issueProof(normalized, "consent_cookie", "any", issuedAtMs);
}

/**
 * An unsubscribe token (raw, from a mail we sent) proves its row's address,
 * scoped to that row's target. The row's status is deliberately ignored: the
 * Resume case is a token for an already-`unsubscribed` row.
 *
 * Returns null (no proof) for an unknown token, the retired `all` target,
 * AND on a DB error (logged as SQLSTATE only), so a route can treat both as "not proven". The calling route
 * MUST apply the existing unsubscribe rate limiter BEFORE calling this, and
 * any route that goes on to `lift` must be POST-only (mail scanners prefetch
 * GET links).
 */
export async function inboxProofFromUnsubscribeToken(
  db: SuppressionDb,
  token: string
): Promise<InboxProof | null> {
  if (!token) {
    return null;
  }
  try {
    const [row] = await db
      .select({
        email: subscriptionsTable.email,
        targetType: subscriptionsTable.targetType,
        targetId: subscriptionsTable.targetId,
      })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.unsubscribeToken, token));
    if (!row) {
      return null;
    }
    // Retired target: no proof, and not an error worth logging.
    if (row.targetType === "all") {
      return null;
    }
    const grant = {
      ...scopeKey({ kind: "target", targetType: row.targetType, targetId: row.targetId ?? "" }),
      tokenHash: hashToken(token),
    };
    return issueProof(normalizeEmail(row.email), "unsubscribe_token", grant);
  } catch (err) {
    console.error(`inboxProofFromUnsubscribeToken failed (sqlstate: ${redactedErrorCode(err)})`);
    return null;
  }
}

/**
 * Removes the one suppression row named by `scope`. Returns false, deleting
 * nothing, in two indistinguishable cases: `proof` is forged / for another
 * address / does not cover this scope, or no matching row exists. Lifting a
 * target row does not lift a global one. A route calling this must be
 * POST-only (see `inboxProofFromUnsubscribeToken`).
 */
export async function lift(
  db: SuppressionDb,
  email: string,
  scope: SuppressionScope,
  proof: InboxProof
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const issued = issuedProofs.get(proof);
  if (!issued || issued.email !== normalized) {
    return false;
  }
  const key = scopeKey(scope);
  if (
    issued.grant !== "any" &&
    scope.kind !== "global" &&
    (issued.grant.targetType !== key.targetType || issued.grant.targetId !== key.targetId)
  ) {
    return false;
  }
  const removed = await db
    .delete(emailSuppressionsTable)
    .where(
      and(
        eq(emailSuppressionsTable.email, normalized),
        eq(emailSuppressionsTable.targetType, key.targetType),
        eq(emailSuppressionsTable.targetId, key.targetId),
        // A cookie minted before an explicit opt-out must not undo it, at
        // ANY scope: a suppression row only lifts for a cookie issued more
        // than CONSENT_LIFT_SKEW_MS after it. Token grants carry no
        // issuedAtMs and stay unrestricted (that is the Resume path). The
        // check lives in the DELETE itself so it cannot race a re-created row.
        issued.issuedAtMs !== undefined
          ? lt(emailSuppressionsTable.createdAt, new Date(issued.issuedAtMs - CONSENT_LIFT_SKEW_MS))
          : undefined,
        // A token grant lifts the global row only if it is the very token that
        // wrote it (a NULL hash never matches). In the DELETE for the same
        // no-race reason.
        scope.kind === "global" && issued.grant !== "any"
          ? eq(emailSuppressionsTable.sourceTokenHash, issued.grant.tokenHash)
          : undefined
      )
    )
    .returning({ id: emailSuppressionsTable.id });
  return removed.length > 0;
}
