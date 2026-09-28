import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { redactedErrorCode } from "@/lib/db-error";
import { generateToken } from "@/lib/email";
import { getFacilityById } from "@/lib/data";
import { stateNameFromCode } from "@/lib/us-states";
import { checkEmailSendCap, AUTO_CONFIRM_CAP_MAX, AUTO_CONFIRM_CAP_WINDOW_MS } from "@/lib/rate-limit";
import { verifyConsentCookie } from "@/lib/subscribe-consent";
import { hashToken, isHashedToken } from "@/lib/token-hash";

export const subscribeInputSchema = z
  .object({
    email: z.string().email().max(254),
    targetType: z.enum(["facility", "state"]),
    targetId: z.string().max(120).optional(),
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

  const db = getDb();
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

  // Idempotent: re-applying to an already-unsubscribed row is a harmless no-op.
  await db
    .update(subscriptionsTable)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(eq(subscriptionsTable.unsubscribeToken, token));

  return { status: "unsubscribed" };
}
