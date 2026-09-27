import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { getFacilityById } from "@/lib/data";
import { stateNameFromCode } from "@/lib/us-states";
import { checkEmailSendCap, AUTO_CONFIRM_CAP_MAX, AUTO_CONFIRM_CAP_WINDOW_MS } from "@/lib/rate-limit";
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
 * Extracts a Postgres SQLSTATE (or "unknown") from a caught error for
 * logging, walking the same `err`/`err.cause` layers as isUniqueViolation
 * above — mirrors redactedFailureCode in app/api/subscribe/route.ts (kept as
 * a separate local copy rather than imported: route.ts imports FROM this
 * file, not the other way around). Deliberately never returns the error's
 * message or the error itself: drizzle-orm's DrizzleQueryError embeds its
 * bound params — here, the subscriber's email — in its own `.message`, so
 * logging `err` or `err.message` would leak it into server logs.
 */
function redactedErrorCode(err: unknown): string {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  for (const layer of layers) {
    const code = (layer as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

/**
 * True iff `email` should have a NEW subscription auto-confirmed instead of
 * going through the ordinary double-opt-in flow. Two conditions, both against
 * this email's CONFIRMED rows (to any target):
 *
 *  1. `total > 0` — it already holds at least one confirmed subscription,
 *     proving it receives our mail, instead of sending yet another confirm
 *     email it will likely never click (measured against prod Neon
 *     2026-09-27: 9 of 14 pending rows belonged to addresses that already
 *     held a confirmed row elsewhere).
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
 *
 * Both counts come from ONE query (a single `count(*) FILTER (...)` alongside
 * a plain `count(*)`, both scoped to this email's `confirmed` rows) to keep
 * this a single round trip — see the timing-symmetry note below.
 *
 * OVER THE CAP DOES NOT REJECT THE SUBSCRIPTION: condition 2 failing just
 * denies the auto-confirm shortcut. subscribeToTarget falls back to the
 * ordinary pending + confirm-email path exactly as if this address had never
 * confirmed anything, and the caller still gets the usual generic
 * `{ok:true}` — never an error, never a skipped row.
 *
 * Deliberately does NOT distinguish "no rows at all" from "rows exist but
 * none confirmed" (pending-only or unsubscribed-only) — both leave `total`
 * at 0 and return false, so a first-time subscriber and a fully-opted-out
 * one are both routed through the ordinary double-opt-in path below. An
 * unsubscribed-only address must NOT be auto-confirmed: it already told us
 * to stop, and silently reviving it would override that without consent.
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
async function canAutoConfirm(email: string): Promise<boolean> {
  try {
    const db = getDb();
    const windowStart = new Date(Date.now() - AUTO_CONFIRM_CAP_WINDOW_MS);
    const [row] = await db
      .select({
        recent: sql<number>`count(*) filter (where ${subscriptionsTable.createdAt} >= ${windowStart})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.email, email), eq(subscriptionsTable.status, "confirmed")));
    const recent = row?.recent ?? 0;
    const total = row?.total ?? 0;
    return total > 0 && recent < AUTO_CONFIRM_CAP_MAX;
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
 * security-review fix). If the address is eligible for auto-confirm (see
 * canAutoConfirm above — proven receipt via an existing confirmed row, and
 * under the weekly cumulative cap), the new row is created already-
 * `confirmed` instead and this returns `{ok:true, notice}` — a "you're now
 * watching X" email, not a confirm gate — so a subscriber who has already
 * proven they receive our mail is never asked to prove it again for every
 * new target.
 *
 * Used to also take an `ipHash` param, written to `subscriptions.submitterIpHash`
 * for rate-limiting. That column was dropped 2026-09-13 as write-only PII —
 * rate limiting now counts `subscribe_attempts` rows instead (see
 * lib/rate-limit.ts) — so don't re-add an ipHash param here for that purpose.
 */
export async function subscribeToTarget(rawInput: unknown): Promise<SubscribeResult> {
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

  // Auto-confirm eligibility (proven receipt + under the weekly cumulative
  // cap) — see canAutoConfirm's doc comment for why this must run
  // unconditionally, right here, on every request that reaches this point.
  const autoConfirmEligible = await canAutoConfirm(email);

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

export async function confirmSubscription(
  token: string
): Promise<{ status: "confirmed" | "already" | "invalid" }> {
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
    return { status: "already" };
  }
  if (row.status !== "pending") {
    // Stale confirm link for a since-unsubscribed row.
    return { status: "invalid" };
  }

  await db
    .update(subscriptionsTable)
    .set({ status: "confirmed", confirmedAt: new Date(), confirmToken: hashed })
    .where(eq(subscriptionsTable.confirmToken, matchedValue));

  return { status: "confirmed" };
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
