import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { storableText } from "@/lib/intake-fields";
import { emailSuppressionsTable, subscriptionsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { generateToken } from "@/lib/email";
import { getFacilityById } from "@/lib/data";
import { stateNameFromCode } from "@/lib/us-states";
import { checkEmailSendCap, AUTO_CONFIRM_CAP_MAX, AUTO_CONFIRM_CAP_WINDOW_MS } from "@/lib/rate-limit";
import { verifyConsentCookie } from "@/lib/subscribe-consent";
import {
  inboxProofFromConsentCookie,
  inboxProofFromUnsubscribeToken,
  isSuppressed,
  lift,
  mayEmail,
  suppress,
} from "@/lib/suppressions";
import type { SuppressionScope, SuppressionSource } from "@/lib/suppressions";
import { hashToken, isHashedToken } from "@/lib/token-hash";

export const subscribeInputSchema = z
  .object({
    email: z.string().email().max(254),
    targetType: z.enum(["facility", "state"]),
    targetId: storableText(z.string().max(120)).optional(),
    website: z.string().optional(), // honeypot — real users never fill this
  })
  .refine((s) => Boolean(s.targetId), {
    message: "targetId is required",
    path: ["targetId"],
  });

export type SubscribeInput = z.infer<typeof subscribeInputSchema>;

export type SubscribeResult =
  | {
      ok: true;
      confirm?: { email: string; targetLabel: string; confirmToken: string };
      notice?: { email: string; targetLabel: string; unsubscribeToken: string };
    }
  | { ok: false; status: number; error: string; issues?: unknown };

function isHoneypotTripped(input: { website?: string }): boolean {
  return Boolean(input.website && input.website.trim());
}

const UNIQUE_VIOLATION_CODE = "23505";

/**
 * The neon-http and PGlite drivers both surface constraint violations with a
 * Postgres error `code`, but drizzle-orm wraps the driver error in a
 * `DrizzleQueryError` whose own `.message` is a generic "Failed query: ..."
 * string — the real `code`/message live one level down on `.cause`. Check
 * both layers, plus a message-regex fallback in case a driver loses `code`.
 */
function isUniqueViolation(err: unknown): boolean {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  return layers.some((layer) => {
    if (!layer) return false;
    if ((layer as { code?: unknown }).code === UNIQUE_VIOLATION_CODE) return true;
    const message = layer instanceof Error ? layer.message : String(layer);
    return /duplicate key|unique/i.test(message);
  });
}

/**
 * True iff this address's own SUBSCRIPTION HISTORY permits auto-confirming a
 * new subscription instead of sending it through the ordinary double-opt-in
 * flow. Three conditions, all from this email's rows:
 *
 *  1. `total > 0` — it already holds at least one confirmed subscription to
 *     some target, so our mail is deliverable there and wanted, instead of
 *     sending yet another confirm email it will likely never click (measured
 *     against prod Neon 2026-09-27: 9 of 14 pending rows belonged to
 *     addresses that already held a confirmed row elsewhere).
 *
 *     ⚠️ CORRECTED (security review 2026-09-27, the finding this signature
 *     change comes from): this condition was previously documented as
 *     "proven receipt", and the function's whole result was treated as
 *     licence to auto-confirm. It is NOT proof of receipt by the REQUESTER.
 *     It is a property of the ADDRESS, and every input to it is a property of
 *     the address — so on its own it let an anonymous `POST /api/subscribe`
 *     create a LIVE subscription for any address that had ever confirmed
 *     anything, and mail it, up to AUTO_CONFIRM_CAP_MAX times per window.
 *     Nothing here can prove the requester holds the address; that is the
 *     consent cookie's job (`lib/subscribe-consent.ts`), checked separately
 *     at the call site and ANDed with this result. Keep the two separate:
 *     this answers "is auto-confirming this address's history sane?", the
 *     cookie answers "is this the address's owner asking?".
 *  2. `recent < AUTO_CONFIRM_CAP_MAX` — it hasn't already had
 *     AUTO_CONFIRM_CAP_MAX+ confirmed rows CREATED in the trailing
 *     AUTO_CONFIRM_CAP_WINDOW_MS (H1, security review 2026-09-27; see that
 *     constant's doc comment in lib/rate-limit.ts for Ed's reasoning on the
 *     number). Filtered on `createdAt`, not `confirmedAt`: an auto-confirmed
 *     row sets both to the same instant, so for the auto-confirm path this
 *     counts new-confirmation velocity precisely. It's an approximation for
 *     the ordinary manual-click path: `createdAt` there is the ORIGINAL
 *     subscribe time, which can predate the actual confirm click by any
 *     amount, so a row created 8+ days ago and clicked-confirmed yesterday
 *     keeps its stale `createdAt` and is excluded from `recent` despite being
 *     a genuinely new confirmation. Not exploitable (confirming it requires
 *     real inbox access, which already defeats the point of auto-confirming
 *     anything), just a known imprecision on a path this cap doesn't
 *     primarily target. Deliberately NOT restricted to previously
 *     auto-confirmed rows: that would need a new column to mark them, and the
 *     property actually wanted is a bound on total new confirmations, not on
 *     this mechanism specifically.
 *  3. `unsubscribedHere === 0` — this address has never unsubscribed from
 *     THIS EXACT target (matched the way the partial unique index matches,
 *     `targetType` + `COALESCE(targetId,'')`, so the two agree on what "the
 *     same target" is). A prior unsubscribe is a standing instruction about
 *     one target, and `subscriptions_active_target_idx` excludes
 *     `unsubscribed` rows — so the moment someone unsubscribes, that triple
 *     becomes insertable again and the dedup path stops protecting them.
 *     Without this condition the auto-confirm branch would silently re-create
 *     the row as `confirmed` and mail them, i.e. the victim's only per-target
 *     remedy was undoable by whoever triggered it. Refusing only the SHORTCUT
 *     (not the subscription) is the right strength: a genuine returning
 *     subscriber can still re-subscribe, they just have to click a confirm
 *     link again, which is exactly the consent they withdrew.
 *
 * All three counts come from ONE query — three `count(*) FILTER (...)`
 * aggregates over this email's rows, so the `confirmed` scoping moved from
 * the WHERE clause into the filters — to keep this a single round trip; see
 * the timing-symmetry note below.
 *
 * NONE OF THE THREE REJECTS THE SUBSCRIPTION: a failing condition denies only
 * the auto-confirm shortcut. subscribeToTarget falls back to the ordinary
 * pending + confirm-email path exactly as if this address had never confirmed
 * anything, and the caller still gets the usual generic `{ok:true}` — never
 * an error, never a skipped row.
 *
 * Deliberately does NOT distinguish "no rows at all" from "rows exist but
 * none confirmed" (pending-only or unsubscribed-only) — both leave `total`
 * at 0 and return false, so a first-time subscriber and a fully-opted-out
 * one are both routed through the ordinary double-opt-in path below. An
 * unsubscribed-only address must NOT be auto-confirmed: it already told us
 * to stop, and silently reviving it would override that without consent.
 * Condition 3 covers the harder case the `total` count cannot see — an
 * address that still holds confirmed rows elsewhere but unsubscribed from
 * *this* target.
 *
 * Called unconditionally on every request that reaches this point in
 * subscribeToTarget — immediately after the checkEmailSendCap guard, before
 * the insert — including ones that will go on to hit the active-subscription
 * unique-violation path below. That keeps this check's latency identical
 * across every caller, so it introduces no new timing oracle (see
 * subscribeToTarget's doc comment on response-latency symmetry).
 *
 * NEVER THROWS (2026-09-27 security-review fix, H2): a lookup failure (e.g. a
 * transient Neon blip) is caught here, logged with ONLY a redacted SQLSTATE —
 * never the raw error or its message, since Drizzle embeds the bound email
 * in `.message` — and resolves to `false`. `subscribeToTarget` has no
 * try/catch around this call, and neither does its caller in
 * app/api/subscribe/route.ts, so an uncaught throw here would previously have
 * propagated straight into Vercel Runtime Logs carrying the subscriber's
 * plaintext email. Failing safe to `false` also means a lookup failure can
 * only ever under-trigger auto-confirm (falls through to the ordinary
 * double-opt-in path), never wrongly auto-confirm and never take down the
 * request.
 */
async function canAutoConfirm(
  email: string,
  targetType: string,
  targetId: string
): Promise<boolean> {
  try {
    const db = getDb();
    const windowStart = new Date(Date.now() - AUTO_CONFIRM_CAP_WINDOW_MS);
    const [row] = await db
      .select({
        recent: sql<number>`count(*) filter (
          where ${subscriptionsTable.status} = 'confirmed'
            and ${subscriptionsTable.createdAt} >= ${windowStart}
        )::int`,
        total: sql<number>`count(*) filter (where ${subscriptionsTable.status} = 'confirmed')::int`,
        unsubscribedHere: sql<number>`count(*) filter (
          where ${subscriptionsTable.status} = 'unsubscribed'
            and ${subscriptionsTable.targetType} = ${targetType}
            and coalesce(${subscriptionsTable.targetId}, '') = ${targetId}
        )::int`,
      })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.email, email));
    const recent = row?.recent ?? 0;
    const total = row?.total ?? 0;
    const unsubscribedHere = row?.unsubscribedHere ?? 0;
    return total > 0 && recent < AUTO_CONFIRM_CAP_MAX && unsubscribedHere === 0;
  } catch (err) {
    console.error(
      `canAutoConfirm lookup failed — falling through to pending (sqlstate: ${redactedErrorCode(err)})`
    );
    return false;
  }
}

/**
 * Validates and stages a double-opt-in subscription. Always returns a
 * generic `{ok:true}` for every "no new confirm email sent" path (honeypot,
 * already actively subscribed, over the per-email send cap) so the response
 * never leaks whether a given email/target combination already exists — only
 * genuine input-format or unknown-target errors return a non-generic result.
 * On a genuine new subscription, returns `{ok:true, confirm}` instead of
 * sending the email itself — the caller (the route) schedules the actual
 * send AFTER the response goes out, so response latency can't distinguish
 * the new-subscription path from the generic-success paths (a prior
 * security-review fix).
 *
 * `consentCookie` is the raw `sub_consent` cookie value from the request, or
 * undefined — the route reads it (`readConsentCookie`) and passes it in
 * rather than this module reaching for `next/headers`, so this stays a plain
 * function that a test can drive. It is REQUIRED for the auto-confirm
 * shortcut: the new row is created already-`confirmed` (returning
 * `{ok:true, notice}` — a "you're now watching X" email, not a confirm gate)
 * only when BOTH the cookie proves this requester recently completed a
 * confirm for THIS address AND canAutoConfirm's history conditions hold.
 * Anything short of both — no cookie, a cookie for another address, a forged
 * or expired one, no signing key configured — falls through to the ordinary
 * pending + confirm-email path, which is the same path as a first-time
 * subscriber and returns the same generic `{ok:true}`.
 *
 * Used to also take an `ipHash` param, written to `subscriptions.submitterIpHash`
 * for rate-limiting. That column was dropped 2026-09-13 as write-only PII —
 * rate limiting now counts `subscribe_attempts` rows instead (see
 * lib/rate-limit.ts) — so don't re-add an ipHash param here for that purpose.
 */
export async function subscribeToTarget(
  rawInput: unknown,
  consentCookie?: string
): Promise<SubscribeResult> {
  const parsed = subscribeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid subscription", issues: parsed.error.issues };
  }
  const data = parsed.data;

  if (isHoneypotTripped(data)) {
    return { ok: true };
  }

  const email = data.email.trim().toLowerCase();

  // Resolves and validates the target by type: a facility subscription needs
  // a real facility id (checked against the DB); a state subscription needs
  // a real 2-letter state code (checked against the static US_STATE_NAMES
  // map in lib/us-states.ts — no DB round trip needed). Both branches 400 on
  // an unresolved target, with a distinct error string per branch ("Unknown
  // facility" / "Unknown state") — that distinction leaks nothing, since the
  // caller already supplied targetType and therefore already knows which
  // kind of target it asked about.
  let targetId: string;
  let targetLabel: string;
  if (data.targetType === "facility") {
    const facility = await getFacilityById(data.targetId!);
    if (!facility) {
      return { ok: false, status: 400, error: "Unknown facility" };
    }
    targetId = data.targetId!;
    targetLabel = facility.name;
  } else {
    // Normalized to uppercase before storing/comparing so "ca" and "CA" are
    // one target, not two — matches location.state's stored convention.
    const code = data.targetId!.toUpperCase();
    const stateName = stateNameFromCode(code);
    if (!stateName) {
      return { ok: false, status: 400, error: "Unknown state" };
    }
    targetId = code;
    targetLabel = stateName;
  }

  // Opt-out gate (A-3). An unsubscribed or "stop all" address, or one whose
  // lookup failed ("unknown"), gets NO row and NO mail, and the SAME generic
  // `{ok:true}` as every other no-send path, so it is not an oracle. Only
  // `mayEmail` decides: "unknown" is never read as "clear".
  //
  // D2: an opted-out address comes back only with proof of inbox. A valid
  // consent cookie for THIS address (an HMAC check, no I/O) lifts the target
  // suppression (and the global one, if the cookie postdates it) and the
  // request proceeds as a normal subscribe. Only a cookie holder pays the
  // extra queries, and that is a fact the requester already knows.
  const db = getDb();
  const scope: SuppressionScope = { kind: "target", targetType: data.targetType, targetId };
  let suppression = await isSuppressed(db, email, scope);
  if (!mayEmail(suppression)) {
    const proof = inboxProofFromConsentCookie(consentCookie, email);
    if (proof) {
      try {
        await lift(db, email, scope, proof);
        await lift(db, email, { kind: "global" }, proof);
      } catch (err) {
        console.error(`consent lift failed (sqlstate: ${redactedErrorCode(err)})`);
      }
      suppression = await isSuppressed(db, email, scope);
    }
  }
  const optedOut = !mayEmail(suppression);

  // Per-address send cap (a prior security-review fix): the IP rate limit
  // alone doesn't stop a distributed attacker from email-bombing one victim
  // by varying targetId/IP. This check runs on BOTH the eventual-new and
  // eventual-duplicate paths below (both reach this point before the
  // insert), so it stays timing-symmetric with the rest of the function.
  if (!(await checkEmailSendCap(email)).ok) {
    return { ok: true }; // over the per-address send cap — generic success, no row, no email
  }

  // Auto-confirm eligibility. Two independent halves, ANDed: does the
  // REQUESTER hold this address (the consent cookie), and does the ADDRESS's
  // own history permit the shortcut (canAutoConfirm). Neither alone is
  // sufficient — see canAutoConfirm's condition 1.
  //
  // LATENCY SYMMETRY (deliberate, and the reason this is written as two
  // unconditional statements ANDed rather than `hasConsent && await ...`):
  // canAutoConfirm still runs on EVERY request that reaches this point, in
  // the same position as before, exactly as its doc comment requires — so no
  // short-circuit makes one caller's round-trip count differ from another's.
  // verifyConsentCookie adds no I/O at all (pure HMAC over in-memory
  // strings), so it shifts every path by the same sub-microsecond constant.
  // It does return early when no cookie is present, which is a difference
  // between "sent a cookie" and "didn't" — not an oracle: it is a fact the
  // requester already knows about their own request, and it reveals nothing
  // about stored data, which is what the symmetry property protects.
  const hasConsent = verifyConsentCookie(consentCookie, email);
  const historyAllows = await canAutoConfirm(email, data.targetType, targetId);
  const autoConfirmEligible = hasConsent && historyAllows;

  if (optedOut) {
    // Query-count symmetry with the insert below: one read against the same
    // table, in the slot the INSERT occupies on the other paths. Its result
    // is unused and a failure is irrelevant (the answer is already decided).
    try {
      await db
        .select({ id: subscriptionsTable.id })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.email, email))
        .limit(1);
    } catch (err) {
      console.error(`opt-out probe failed (sqlstate: ${redactedErrorCode(err)})`);
    }
    return { ok: true };
  }

  const confirmToken = generateToken();
  const unsubscribeToken = generateToken();
  try {
    await db.insert(subscriptionsTable).values({
      email,
      targetType: data.targetType,
      targetId,
      status: autoConfirmEligible ? "confirmed" : "pending",
      // raw kept only in the local `confirmToken` var, for the email on the
      // pending branch below — unused on the auto-confirm branch, but still
      // generated and stored (hashed) either way: the column is NOT NULL and
      // uniquely indexed, so an auto-confirmed row needs its own distinct
      // value exactly like a pending one.
      confirmToken: hashToken(confirmToken),
      unsubscribeToken,
      ...(autoConfirmEligible ? { confirmedAt: new Date() } : {}),
    });

    if (autoConfirmEligible) {
      // Live immediately — no confirm email to click. The one-shot "you're
      // now watching X" notice below is purely informational: unlike the
      // KNOWN LIMITATION just below, a failed send here strands nothing,
      // since the row is already confirmed whether or not the notice
      // arrives.
      return { ok: true, notice: { email, targetLabel, unsubscribeToken } };
    }

    // The confirm email is NOT sent here. The route sends it AFTER this
    // function returns (via next/server's `after()`), so that response
    // latency is identical whether this is a new subscription or one of the
    // generic-success no-send paths above/below (a prior security-review
    // fix) — awaiting the send inline made the duplicate path (immediate
    // return) measurably faster than the new-subscription path (waits on
    // the network), leaking whether the (email,target) pair already existed.
    //
    // KNOWN LIMITATION (MVP, security-reviewed): the send result is still not
    // acted on by anything here. If this first confirm email fails (e.g.
    // Resend down), the pending row persists and a retry hits the
    // active-subscription unique index (23505) → generic success with no
    // resend, so that (email,target) can't be confirmed until the row
    // clears. Accepted for MVP (rare + bounded). Future fix: roll back the
    // row on a genuine send error (distinguishing it from the env-gated
    // no-key no-op), or expire stale pending rows + allow resend.
    return { ok: true, confirm: { email, targetLabel, confirmToken } };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      // A genuine DB failure (not the expected active-subscription dedup
      // below) must still surface as a failure — sanitized, not swallowed.
      // The raw `err` here is a DrizzleQueryError whose `.message` embeds its
      // bound params, i.e. this subscriber's plaintext email; re-throwing it
      // as-is would leak that into Vercel Runtime Logs via Next's own
      // uncaught-error handling (app/api/subscribe/route.ts has no try/catch
      // around this call, same H2 class as canAutoConfirm's fix above). Log
      // only a redacted SQLSTATE, then throw a NEW error carrying no bound
      // params and no address — the failure still propagates (this is never
      // converted into a generic success), just without the leak.
      console.error(`subscribeToTarget insert failed (sqlstate: ${redactedErrorCode(err)})`);
      throw new Error("subscribeToTarget: insert failed");
    }
    // subscriptions_active_target_idx (partial unique index, lib/db/schema.ts)
    // rejected the insert: an active (pending|confirmed) subscription already
    // exists for this email+target. No confirm signal — the route won't
    // schedule a send — so this returns the same generic success as every
    // other "no send" path.
    return { ok: true };
  }
}

/**
 * Consumes a confirm token.
 *
 * Returns the row's `email` alongside the status on both non-`invalid`
 * outcomes, for one caller and one purpose: the confirm route mints the
 * address-bound consent cookie from it (`lib/subscribe-consent.ts`). The
 * address is never put in the redirect URL, the response body, or a log — it
 * goes into an HMAC and nothing else. `invalid` carries no email, because
 * there is no row to name.
 */
export async function confirmSubscription(
  token: string
): Promise<{ status: "confirmed" | "already" | "invalid"; email?: string }> {
  if (!token) {
    return { status: "invalid" };
  }

  const db = getDb();
  const hashed = hashToken(token);
  let rows = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.confirmToken, hashed));
  let matchedValue: string = hashed;
  if (!rows[0] && !isHashedToken(token)) {
    // Legacy fallback: row predates hashing and still stores the raw confirm
    // token. A hit here is upgraded to its hash as part of the confirming
    // UPDATE below (see lib/token-hash.ts). Gated on `!isHashedToken(token)`
    // to close a stolen-stored-hash bypass: without this guard, presenting
    // the 64-hex hash itself (e.g. from a DB leak) would miss the hash-first
    // lookup (hash-of-hash) but then match THIS raw-equality fallback
    // directly against the stored value, authenticating with no raw token
    // ever having existed. A genuine raw token is always 43-char base64url
    // and can never be 64 lowercase hex, so no real caller is affected.
    rows = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.confirmToken, token));
    matchedValue = token;
  }
  const row = rows[0];
  if (!row) {
    return { status: "invalid" };
  }
  if (row.status === "confirmed") {
    return { status: "already", email: row.email };
  }
  if (row.status !== "pending") {
    // Stale confirm link for a since-unsubscribed row.
    return { status: "invalid" };
  }

  await db
    .update(subscriptionsTable)
    .set({ status: "confirmed", confirmedAt: new Date(), confirmToken: hashed })
    .where(eq(subscriptionsTable.confirmToken, matchedValue));

  return { status: "confirmed", email: row.email };
}

/**
 * Suppression scope an unsubscribe token's row maps to. The retired `all`
 * target (and any row without a target id) means "everything", so it maps to
 * global: erring toward more suppression, never less.
 */
function scopeForRow(row: { targetType: string; targetId: string | null }): SuppressionScope {
  if (row.targetType === "all" || !row.targetId) {
    return { kind: "global" };
  }
  return { kind: "target", targetType: row.targetType, targetId: row.targetId };
}

/**
 * Runs a suppression write, logging a failure as SQLSTATE only and rethrowing
 * a NEW error: Drizzle's own message embeds the bound address.
 */
async function suppressOrThrow(
  email: string,
  scope: SuppressionScope,
  source: SuppressionSource,
  sourceTokenHash?: string
): Promise<void> {
  try {
    await suppress(getDb(), email, scope, source, sourceTokenHash);
  } catch (err) {
    console.error(`suppress failed (sqlstate: ${redactedErrorCode(err)})`);
    throw new Error("suppress failed");
  }
}

/**
 * Per-target unsubscribe. WRITES THE SUPPRESSION FIRST, then flips the row:
 * neon-http has no interactive transactions, so a failure between the two
 * statements must leave the person opted out (safe) rather than still live.
 */
export async function unsubscribeByToken(
  token: string
): Promise<{ status: "unsubscribed" | "invalid" }> {
  if (!token) {
    return { status: "invalid" };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.unsubscribeToken, token));
  if (!rows[0]) {
    return { status: "invalid" };
  }

  await suppressOrThrow(rows[0].email, scopeForRow(rows[0]), "unsubscribe");

  // Idempotent: re-applying to an already-unsubscribed row is a harmless no-op.
  await db
    .update(subscriptionsTable)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(eq(subscriptionsTable.unsubscribeToken, token));

  return { status: "unsubscribed" };
}

/**
 * Where an address stands on "stop all email", seen from one unsubscribe token.
 * A pure READ (safe on a GET):
 *   - `not_stopped`:      no global row, OR the token is unknown (so a GET
 *                         reveals nothing about token validity).
 *   - `stopped_by_this`:  a global row exists and THIS token wrote it, so
 *                         this token can Undo it.
 *   - `stopped_by_other`: a global row exists from another token (first stop-all
 *                         wins) or has no token (backfill/admin): no Undo here.
 *   - `error`:            the lookup failed; callers must not promise Undo.
 */
export type StopAllState = "not_stopped" | "stopped_by_this" | "stopped_by_other" | "error";

export async function stopAllStateByToken(token: string): Promise<StopAllState> {
  if (!token) {
    return "not_stopped";
  }
  try {
    const db = getDb();
    const [row] = await db
      .select({ email: subscriptionsTable.email })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.unsubscribeToken, token));
    // The second query ALWAYS runs (against a fixed dummy address when the
    // token is unknown), so an unknown token and a known-but-not-stopped one
    // cost the same two queries and timing separates neither.
    const [global] = await db
      .select({ hash: emailSuppressionsTable.sourceTokenHash })
      .from(emailSuppressionsTable)
      .where(
        and(
          eq(emailSuppressionsTable.email, row ? row.email.trim().toLowerCase() : "no-such-token@invalid"),
          eq(emailSuppressionsTable.targetType, ""),
          eq(emailSuppressionsTable.targetId, "")
        )
      );
    if (!row) {
      return "not_stopped";
    }
    if (!global) {
      return "not_stopped";
    }
    return global.hash !== null && global.hash === hashToken(token)
      ? "stopped_by_this"
      : "stopped_by_other";
  } catch (err) {
    console.error(`stopAllStateByToken failed (sqlstate: ${redactedErrorCode(err)})`);
    return "error";
  }
}

/**
 * Whether the row behind a per-target unsubscribe token is already
 * unsubscribed. A pure READ for the interstitial (so it can offer Resume
 * instead of Unsubscribe); an unknown token and a lookup error read as
 * `active`, which shows the ordinary Unsubscribe page and reveals nothing.
 */
export async function isTokenRowUnsubscribed(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  try {
    const [row] = await getDb()
      .select({ status: subscriptionsTable.status })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.unsubscribeToken, token));
    return row?.status === "unsubscribed";
  } catch (err) {
    console.error(`isTokenRowUnsubscribed failed (sqlstate: ${redactedErrorCode(err)})`);
    return false;
  }
}

/**
 * "Stop all email": a global suppression authorised by any of the address's
 * unsubscribe tokens, written first, then every still-active row for that
 * address is flipped to `unsubscribed`. Callers must be POST-only.
 *
 * `undoable` says whether THIS token is the one that can undo it. The first
 * stop-all wins (see `suppress`), so a second token gets `undoable: false`
 * and the caller must not show it an Undo button that cannot work. Last-wins
 * is deliberately not used: a forwarded email could steal the undo key.
 */
export async function unsubscribeAllByToken(
  token: string
): Promise<{ status: "unsubscribed" | "invalid"; undoable: boolean }> {
  if (!token) {
    return { status: "invalid", undoable: false };
  }

  const db = getDb();
  const [row] = await db
    .select({ email: subscriptionsTable.email })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.unsubscribeToken, token));
  if (!row) {
    return { status: "invalid", undoable: false };
  }

  // The token's HASH is stored as the key for "Undo". A second stop-all with a
  // different token leaves the first token as the undo key (first one wins).
  await suppressOrThrow(row.email, { kind: "global" }, "unsubscribe_all", hashToken(token));

  await db
    .update(subscriptionsTable)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(
      and(eq(subscriptionsTable.email, row.email), ne(subscriptionsTable.status, "unsubscribed"))
    );

  // On a failed post-write lookup (`error`) assume undoable: the person who
  // just stopped everything is better sent to the Undo page, whose POST
  // re-validates anyway, than told that only another link can undo it.
  const state = await stopAllStateByToken(token);
  return { status: "unsubscribed", undoable: state === "stopped_by_this" || state === "error" };
}

/**
 * Undo "stop all email": lifts the GLOBAL suppression, and only for the token
 * that wrote it (`lift` checks the stored hash inside the DELETE). It does NOT
 * re-confirm the subscriptions the stop-all flipped to `unsubscribed`: those
 * flips were not recorded, so restoring them would guess; the person resumes
 * each from its own email or subscribes again. Forged, different, or
 * NULL-hash cases and DB errors are all `invalid`. POST-only, rate limited.
 */
export async function undoStopAllByToken(token: string): Promise<{ status: "undone" | "invalid" }> {
  if (!token) {
    return { status: "invalid" };
  }
  try {
    const db = getDb();
    const proof = await inboxProofFromUnsubscribeToken(db, token);
    if (!proof) {
      return { status: "invalid" };
    }
    const [row] = await db
      .select({ email: subscriptionsTable.email })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.unsubscribeToken, token));
    if (!row) {
      return { status: "invalid" };
    }
    const lifted = await lift(db, row.email, { kind: "global" }, proof);
    return { status: lifted ? "undone" : "invalid" };
  } catch (err) {
    console.error(`undoStopAllByToken failed (sqlstate: ${redactedErrorCode(err)})`);
    return { status: "invalid" };
  }
}

export type ResumeStatus =
  | "resumed"
  | "already_active"
  | "still_stopped"
  | "lift_failed"
  | "invalid";

/**
 * "Resume": the unsubscribe token proves inbox control for ITS row's target
 * only. Order matters (no transactions on neon-http): the row is restored
 * FIRST, then the target suppression is lifted, so a failure in between
 * leaves the person still opted out (suppressed rows are never mailed), and a
 * retry finishes the job.
 *
 * Statuses:
 *   - `resumed`:       row active again and nothing blocks mail to it.
 *   - `already_active`: an active row for this target already existed.
 *   - `still_stopped`: the row is active but a suppression remains (a GLOBAL
 *                      "stop all", which a per-target token cannot lift, or a
 *                      lookup failure), so no alert will actually be sent.
 *   - `lift_failed`:   the row WAS restored but lifting the suppression threw
 *                      (SQLSTATE logged), so alerts stay blocked; pressing
 *                      Resume again finishes it (every step is idempotent).
 *   - `invalid`:       forged/unknown token, the retired `all` row, or ANY DB
 *                      error (logged as SQLSTATE only), identical to the
 *                      unsubscribe path's invalid outcome.
 * Callers must be POST-only and rate limited.
 */
export async function resumeByToken(token: string): Promise<{ status: ResumeStatus }> {
  if (!token) {
    return { status: "invalid" };
  }

  try {
    const db = getDb();
    const proof = await inboxProofFromUnsubscribeToken(db, token);
    if (!proof) {
      return { status: "invalid" };
    }
    const [row] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.unsubscribeToken, token));
    if (!row || !row.targetId) {
      return { status: "invalid" };
    }
    // A `pending` row has never been confirmed, and its unsubscribe token is
    // only ever emailed AFTER confirmation (confirm mail carries the confirm
    // token; change/notice/digest mail carry the unsubscribe token), so this is
    // unreachable from a real link. Refuse it rather than call it active.
    if (row.status === "pending") {
      return { status: "invalid" };
    }

    let alreadyActive = false;
    try {
      const restored = await db
        .update(subscriptionsTable)
        .set({ status: "confirmed", unsubscribedAt: null })
        .where(
          and(
            eq(subscriptionsTable.unsubscribeToken, token),
            eq(subscriptionsTable.status, "unsubscribed")
          )
        )
        .returning({ id: subscriptionsTable.id });
      alreadyActive = restored.length === 0;
    } catch (err) {
      // 23505: another active row for this target exists, so nothing to restore.
      if (!isUniqueViolation(err)) {
        throw err;
      }
      alreadyActive = true;
    }

    const scope = scopeForRow(row);
    try {
      await lift(db, row.email, scope, proof);
    } catch (err) {
      console.error(`resume lift failed (sqlstate: ${redactedErrorCode(err)})`);
      return { status: "lift_failed" };
    }

    if (!mayEmail(await isSuppressed(db, row.email, scope))) {
      return { status: "still_stopped" };
    }
    return { status: alreadyActive ? "already_active" : "resumed" };
  } catch (err) {
    console.error(`resumeByToken failed (sqlstate: ${redactedErrorCode(err)})`);
    return { status: "invalid" };
  }
}
