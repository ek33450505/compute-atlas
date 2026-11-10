import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, ne, not, notExists, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type Stripe from "stripe";

import { DATASET_TERMS_VERSION, liveGrant } from "@/lib/dataset-grants";
import { redactedErrorCode } from "@/lib/db-error";
import {
  DATASET_OPEN_GRANT_STATUSES,
  datasetAccessGrantsTable,
  stripeCheckoutDecisionsTable,
  stripeEventsTable,
  type DatasetAccessGrantRow,
} from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { normalizeEmail } from "@/lib/email-address";
import { hasUnstorableChars } from "@/lib/intake-fields";
import { allowedCommercialPriceIds, subscriptionPeriodEnd } from "@/lib/stripe";
import { hashToken } from "@/lib/token-hash";

/** Same cap the free request form puts on `organization` (lib/dataset-grants.ts). */
const ORGANIZATION_MAX_CODE_POINTS = 200;
const NAME_MAX_CODE_POINTS = 200;

const COMMERCIAL_PRODUCT = "compute_atlas_commercial_dataset";
const UNIQUE_VIOLATION = "23505";
const REVIEW_NOTE = "Self-serve commercial subscription";
const INTENDED_USE = "Commercial subscription (self-serve)";
/** A lost unique-index race re-reads and retries; two rounds cover two concurrent deliveries. */
const MAX_ACTIVATION_ATTEMPTS = 3;

/** Either the Neon HTTP client or PGlite in tests; the queries here use no transactions. */
export type CommercialDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface StripeEventDeps {
  db: CommercialDb;
  /** Only `subscriptions.retrieve` is used. Never a real client in tests. */
  stripe: Pick<Stripe, "subscriptions">;
  now?: Date;
  /** Runs once the outcome is known, before `processedAt` is set. Throw to leave the event unprocessed. */
  beforeComplete?: (outcome: Exclude<StripeEventOutcome, { kind: "duplicate" }>) => Promise<void>;
}

/** The mail the CALLER sends on first activation. Carries the raw access token: never log or store it. */
export interface SubscriptionActiveMailIntent {
  kind: "dataset_subscription_active";
  grantId: string;
  email: string;
  accessToken: string;
}

export type StripeEventOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "duplicate" }
  | { kind: "updated"; grantId: string }
  | { kind: "activated"; grantId: string; sessionId: string; mail: SubscriptionActiveMailIntent }
  /**
   * CONTRACT for the route (U5b). Auto cancel + refund happens ONLY for the two `checkout.session.completed`
   * conflicts below (`already_subscribed`, `revoked_buyer`), and the target is ALWAYS the signed session's
   * own subscription (`newSubscriptionId`) and its own first payment (`invoiceId`): cancel that subscription
   * and refund that invoice, using Stripe idempotency keys derived from `sessionId` (a redelivery after the
   * cancel returns the same conflict, so the refund is retried safely). NEVER act on `existingSubscriptionId`
   * or on the revoked grant's subscription from these outcomes. Always alert the maintainer.
   *
   * `amountTotal` (cents, 0 when Stripe sent none) is the session's total: when it is > 0 and the executor finds
   * no refundable payment for `invoiceId`, it must report "refund needed" to the maintainer instead of
   * treating the refund as done.
   *
   * `already_subscribed`: the buyer already holds a LIVE commercial subscription (a different one). Nothing
   * was changed and no token was minted. `grantId` and `existingSubscriptionId` are null once the named grant
   * was deleted (retention prune, >= 365 d); the executor only logs them.
   */
  | {
      kind: "conflict";
      reason: "already_subscribed";
      grantId: string | null;
      existingSubscriptionId: string | null;
      newSubscriptionId: string;
      sessionId: string;
      invoiceId: string | null;
      amountTotal: number;
    }
  /**
   * `revoked_buyer`: a checkout that would create a NEW subscription for a buyer whose commercial grant was
   * REVOKED (matched by email, Stripe customer id or card fingerprint). A revoke sticks on the paid tier:
   * nothing was created or changed and no token was minted. `grantId` is the revoked grant (null once pruned). Auto cancel +
   * refund of the new subscription, as above.
   */
  | {
      kind: "conflict";
      reason: "revoked_buyer";
      grantId: string | null;
      newSubscriptionId: string;
      sessionId: string;
      invoiceId: string | null;
      amountTotal: number;
    }
  /**
   * `superseded_session`: this checkout session's stored decision is 'activate' (or it is linked to a grant)
   * but it can no longer be activated: its grant was since moved to another session/subscription, or the
   * buyer was revoked. That payment was legitimate, so there is NO cancel and NO refund. Alert the
   * maintainer once; a person decides what to do with `sessionId` / `subscriptionId`. `grantId` is the grant
   * the decision is linked to, else the grant that blocked it; null when neither is known.
   */
  | { kind: "conflict"; reason: "superseded_session"; grantId: string | null; sessionId: string; subscriptionId: string }
  /**
   * `revoked_still_billing`: `invoice.paid` or `customer.subscription.updated` for a subscription LINKED to a
   * revoked grant that is still active at Stripe. The revoke action should have cancelled it. Nothing was
   * extended. U5b cancels THAT subscription (it belongs to the revoked grant itself), WITHOUT a refund, and
   * alerts the maintainer. Never a cancel + refund of anything else.
   */
  | { kind: "conflict"; reason: "revoked_still_billing"; grantId: string; subscriptionId: string }
  /**
   * `orphaned_subscription`: a paying, allowlisted subscription has a renewal invoice but no linked grant: a
   * customer is paying with no access. Alert the maintainer ONLY; nothing was written.
   */
  | { kind: "conflict"; reason: "orphaned_subscription"; subscriptionId: string };

type Resolution =
  | { kind: "ignored"; reason: string }
  | { kind: "updated"; grantId: string }
  | { kind: "activated"; grantId: string; sessionId: string; mail: SubscriptionActiveMailIntent }
  | Extract<StripeEventOutcome, { kind: "conflict" }>;

const grantIdOf = (resolution: Resolution): string | null => ("grantId" in resolution ? resolution.grantId : null);

const ignored = (reason: string): { kind: "ignored"; reason: string } => ({ kind: "ignored", reason });

// Control (Cc) and format (Cf) characters, plus line/paragraph separators. Cf covers the bidi
// embeddings/overrides/isolates (U+202A-202E, U+2066-2069), LRM/RLM (U+200E/F), ALM (U+061C), zero-width
// (U+200B-200D) and BOM (U+FEFF): all usable to spoof a name in the admin UI or a mail.
const SPOOFING_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Strips NUL, lone surrogates (Postgres rejects them) and spoofing characters, trims, caps at `max` code points. */
function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const cleaned = Array.from(value.replace(SPOOFING_CHARS, ""))
    .filter((codePoint) => !hasUnstorableChars(codePoint))
    .join("")
    .trim();
  return cleaned ? Array.from(cleaned).slice(0, max).join("") : null;
}

const isUniqueViolation = (err: unknown): boolean => redactedErrorCode(err) === UNIQUE_VIOLATION;

const PAYING_STATUSES: ReadonlySet<string> = new Set(["active"]);

/**
 * No trials are offered, so only `active` counts. The FRESHLY RETRIEVED subscription must be paying before anything is created, re-minted or extended.
 * Events arrive late and out of order (a `deleted` can precede the `checkout.session.completed` it
 * cancels, and a stale `invoice.paid` can follow a `deleted`), so an event is never trusted for status.
 */
const isPaying = (sub: Stripe.Subscription): boolean => PAYING_STATUSES.has(sub.status);

/** Every item's price must be one of the configured commercial prices. The allowlist, not the customer, is the authority. */
function hasOnlyAllowedPrices(sub: Stripe.Subscription): boolean {
  const items = sub.items?.data ?? [];
  if (items.length === 0) return false;
  const allowed = allowedCommercialPriceIds();
  return items.every((item) => typeof item.price?.id === "string" && allowed.has(item.price.id));
}

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

const timestamp = (value: Date) => sql`${value.toISOString()}::timestamptz`;

/**
 * Process one signed Stripe event. Idempotent via `stripe_events`: a delivery already marked processed
 * is `duplicate`; one recorded but never finished (an earlier attempt threw) runs again, and every write
 * below tolerates that. `processedAt` is set only after the work succeeded.
 *
 * Design invariant (see `liveGrant`): for tier 'commercial', `expiresAt` equals `paidThrough` on every
 * payment event, and `paidThrough` never moves backwards except on a subscription deletion. Free grants
 * are never touched by any branch. A revoked grant is never revived by any branch.
 *
 * The webhook endpoint must subscribe to: checkout.session.completed, checkout.session.async_payment_succeeded,
 * checkout.session.async_payment_failed, invoice.paid, customer.subscription.updated and
 * customer.subscription.deleted.
 *
 * CONTRACT FOR THE ROUTE (U5b): send the mail from `deps.beforeComplete`, which runs after the work and
 * BEFORE the event is marked processed. If it throws, the event stays unprocessed, the route returns
 * non-2xx and Stripe redelivers; the retry finds the session already activated by THIS unfinished event,
 * mints a fresh token (the earlier link was most likely never delivered) and returns `activated` again.
 * A completed event never mints again.
 */
export async function processStripeEvent(
  event: Stripe.Event,
  deps: StripeEventDeps
): Promise<StripeEventOutcome> {
  const { db } = deps;
  const now = deps.now ?? new Date();

  const [inserted] = await db
    .insert(stripeEventsTable)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeEventsTable.id });
  // `inserted` is empty when the row already exists: a retry of an unfinished attempt (or a duplicate).
  const isRetry = !inserted;
  if (!inserted) {
    const [existing] = await db
      .select({ processedAt: stripeEventsTable.processedAt })
      .from(stripeEventsTable)
      .where(eq(stripeEventsTable.id, event.id))
      .limit(1);
    if (existing?.processedAt) return { kind: "duplicate" };
  }

  const resolution = await resolveEvent(event, deps, now, isRetry);
  await deps.beforeComplete?.(resolution);

  await db
    .update(stripeEventsTable)
    .set({
      processedAt: now,
      ...(grantIdOf(resolution) ? { grantId: grantIdOf(resolution) } : {}),
    })
    .where(eq(stripeEventsTable.id, event.id));
  return resolution;
}

async function resolveEvent(
  event: Stripe.Event,
  deps: StripeEventDeps,
  now: Date,
  isRetry: boolean
): Promise<Resolution> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutCompleted(event.data.object, deps, now, isRetry);
    case "checkout.session.async_payment_failed":
      return ignored("async payment failed");
    case "invoice.paid":
      return handleInvoicePaid(event.data.object, deps);
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(event.data.object, deps);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object, deps, now);
    default:
      return ignored("unhandled event type");
  }
}

/**
 * A revoked COMMERCIAL grant matching this email, this Stripe customer id, or this card fingerprint hash.
 * Free-tier revokes do not count (the maintainer reviews those on the free side). Any one key is enough. The
 * fingerprint key is a partial close of the inherent "new email + new customer" bypass: it is skipped when
 * Stripe exposes no fingerprint on the subscription's default payment method.
 */
async function revokedBuyer(
  db: CommercialDb,
  keys: { email: string; customerId: string | null; fingerprintHash: string | null }
): Promise<{ id: string } | undefined> {
  const matches = [
    eq(datasetAccessGrantsTable.email, keys.email),
    keys.customerId ? eq(datasetAccessGrantsTable.stripeCustomerId, keys.customerId) : undefined,
    keys.fingerprintHash ? eq(datasetAccessGrantsTable.cardFingerprintHash, keys.fingerprintHash) : undefined,
  ].filter((m) => m !== undefined);
  const [revoked] = await db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.status, "revoked"),
        or(...matches)
      )
    )
    // Deterministic: this id feeds the durable conflict_grant_id. Most recently revoked first.
    .orderBy(sql`${datasetAccessGrantsTable.revokedAt} desc nulls last`, datasetAccessGrantsTable.id)
    .limit(1);
  return revoked;
}

/** sha256 of the default payment method's card fingerprint, or null when none is exposed. Never the raw value. */
function cardFingerprintHashOf(sub: Stripe.Subscription): string | null {
  const method = sub.default_payment_method;
  const fingerprint = method && typeof method === "object" ? method.card?.fingerprint : null;
  return fingerprint ? hashToken(fingerprint) : null;
}

type DecisionRow = typeof stripeCheckoutDecisionsTable.$inferSelect;

async function decisionOf(db: CommercialDb, sessionId: string): Promise<DecisionRow | undefined> {
  const [row] = await db
    .select()
    .from(stripeCheckoutDecisionsTable)
    .where(eq(stripeCheckoutDecisionsTable.sessionId, sessionId))
    .limit(1);
  return row;
}

/** The refund conflict a stored 'refuse' decision stands for. Built from the row alone, never from current state. */
async function refundConflictOf(
  db: CommercialDb,
  row: DecisionRow
): Promise<Extract<Resolution, { kind: "conflict"; reason: "already_subscribed" | "revoked_buyer" }>> {
  // `grantId` is null only after the named grant was deleted (retention prune, >= 365 d); the executor only logs it.
  const base = {
    grantId: row.conflictGrantId,
    newSubscriptionId: row.subscriptionId,
    sessionId: row.sessionId,
    invoiceId: row.invoiceId,
    amountTotal: row.amountTotal,
  };
  if (row.reason === "revoked_buyer") return { kind: "conflict", reason: "revoked_buyer", ...base };
  const [existing] = row.conflictGrantId
    ? await db
        .select({ stripeSubscriptionId: datasetAccessGrantsTable.stripeSubscriptionId })
        .from(datasetAccessGrantsTable)
        .where(eq(datasetAccessGrantsTable.id, row.conflictGrantId))
        .limit(1)
    : [];
  // Informational only (never passed to Stripe): the winner's subscription as the grant reads now.
  return { kind: "conflict", reason: "already_subscribed", existingSubscriptionId: existing?.stripeSubscriptionId ?? null, ...base };
}

const supersededSession = (
  row: Pick<DecisionRow, "sessionId" | "subscriptionId" | "grantId">,
  fallbackGrantId: string | null
): Resolution => ({
  kind: "conflict",
  reason: "superseded_session",
  grantId: row.grantId ?? fallbackGrantId,
  sessionId: row.sessionId,
  subscriptionId: row.subscriptionId,
});

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  deps: StripeEventDeps,
  now: Date,
  isRetry: boolean
): Promise<Resolution> {
  if (session.mode !== "subscription") return ignored("not a subscription checkout");
  if (session.metadata?.product !== COMMERCIAL_PRODUCT) return ignored("not the commercial product");
  if (session.payment_status !== "paid") return ignored("checkout not paid");

  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return ignored("no subscription on session");
  const email = session.customer_details?.email ? normalizeEmail(session.customer_details.email) : "";
  if (!email) return ignored("no customer email");

  const sub = await deps.stripe.subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] });
  if (!hasOnlyAllowedPrices(sub)) return ignored("subscription price not allowed");

  // A redelivery for a session whose OWN grant was revoked: ignore. That payment was legitimate and billing
  // is stopped by the revoke action, so it must never read as a conflict (which triggers an auto refund).
  const [ownRevoked] = await deps.db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        or(
          eq(datasetAccessGrantsTable.stripeCheckoutSessionId, session.id),
          eq(datasetAccessGrantsTable.stripeSubscriptionId, sub.id)
        ),
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.status, "revoked")
      )
    )
    .limit(1);
  if (ownRevoked) return ignored("grant revoked; billing is stopped by the revoke action");

  const customerId = idOf(session.customer);
  const fingerprintHash = cardFingerprintHashOf(sub);
  const invoiceId = idOf(session.invoice);
  const amountTotal = typeof session.amount_total === "number" ? session.amount_total : 0;

  // The DECISION for a session is made once and stored; every delivery of the session (completed, async
  // payment succeeded, any retry) acts on the stored row, never on state read later. Refusals come BEFORE the
  // amount and status checks so a conflict whose new subscription was already cancelled still refunds.
  let decision = await decisionOf(deps.db, session.id);
  let replayed = decision !== undefined;
  if (!decision) {
    const decide = async (): Promise<Pick<DecisionRow, "decision" | "reason" | "conflictGrantId"> | null> => {
      // A revoke sticks: nothing is created, resubscribed or re-minted for a revoked buyer.
      const revoked = await revokedBuyer(deps.db, { email, customerId, fingerprintHash });
      if (revoked) return { decision: "refuse", reason: "revoked_buyer", conflictGrantId: revoked.id };
      // Never overwrite a live subscription with a second one.
      const [existing] = await deps.db
        .select({ id: datasetAccessGrantsTable.id })
        .from(datasetAccessGrantsTable)
        .where(
          and(
            eq(datasetAccessGrantsTable.tier, "commercial"),
            eq(datasetAccessGrantsTable.email, email),
            inArray(datasetAccessGrantsTable.status, [...DATASET_OPEN_GRANT_STATUSES]),
            isNotNull(datasetAccessGrantsTable.stripeSubscriptionId),
            ne(datasetAccessGrantsTable.stripeSubscriptionId, sub.id),
            liveGrant(now)
          )
        )
        .limit(1);
      if (existing) return { decision: "refuse", reason: "already_subscribed", conflictGrantId: existing.id };
      if (!(amountTotal > 0)) return null;
      if (!isPaying(sub)) return null;
      return { decision: "activate", reason: null, conflictGrantId: null };
    };
    const computed = await decide();
    if (!computed) return ignored(amountTotal > 0 ? "subscription not in a paying status" : "zero-amount checkout");
    // First writer wins: a concurrent delivery of this session inserted first and its row is what we act on,
    // so when our insert wrote nothing this IS a replay and gets the replay checks below.
    const [wrote] = await deps.db
      .insert(stripeCheckoutDecisionsTable)
      .values({ sessionId: session.id, subscriptionId: sub.id, invoiceId, amountTotal, ...computed })
      .onConflictDoNothing()
      .returning({ sessionId: stripeCheckoutDecisionsTable.sessionId });
    replayed = !wrote;
    decision = await decisionOf(deps.db, session.id);
    if (!decision) throw new Error("checkout decision row missing after insert");
  }

  if (decision.decision === "refuse") return refundConflictOf(deps.db, decision);

  // Activation. A replay of a stored 'activate' never refunds; it either proceeds or reads as superseded.
  if (replayed) {
    // A subscription cancelled since mints and extends nothing (the decision stays; no refund either way).
    if (!isPaying(sub)) return ignored("subscription not in a paying status");
    if (decision.grantId) {
      // Linked to a grant that no longer carries this session: it moved on (or was re-pointed). Never re-activate.
      const [own] = await deps.db
        .select({ id: datasetAccessGrantsTable.id })
        .from(datasetAccessGrantsTable)
        .where(and(eq(datasetAccessGrantsTable.stripeCheckoutSessionId, session.id), eq(datasetAccessGrantsTable.tier, "commercial")))
        .limit(1);
      if (!own) return supersededSession(decision, null);
    } else {
      // Nothing written yet (a crash before the grant write): a revoke since the decision must still stick.
      const revoked = await revokedBuyer(deps.db, { email, customerId, fingerprintHash });
      if (revoked) return supersededSession(decision, revoked.id);
    }
  }

  const organization = cleanText(
    session.custom_fields?.find((field) => field.key === "organization")?.text?.value,
    ORGANIZATION_MAX_CODE_POINTS
  );
  const buyer = {
    email,
    name: cleanText(session.customer_details?.name, NAME_MAX_CODE_POINTS) ?? email,
    organization,
    termsVersion: cleanText(session.metadata?.termsVersion, 40) ?? DATASET_TERMS_VERSION,
    paidThrough: subscriptionPeriodEnd(sub),
    customerId,
    fingerprintHash,
    subscriptionId: sub.id,
    sessionId: session.id,
  };

  for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt++) {
    try {
      const resolution = await activate(buyer, deps.db, now, isRetry);
      if (!resolution) continue;
      if (resolution.kind === "blocked") return await refuseAfterLostWrite(deps.db, decision, resolution.grantId);
      if (resolution.kind === "claim_lost") return await storedOutcome(deps.db, decision, null);
      return resolution;
    } catch (err) {
      // A concurrent delivery won the open-email or session-id unique index: re-read and decide again.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("commercial grant activation kept losing a unique-index race");
}

/**
 * The grant write lost because ANOTHER session holds a live grant for this email (the same-email race: both
 * first-time checkouts passed the `already_subscribed` precheck before either grant existed). Flip this
 * session's decision to a refusal in ONE conditional statement, only while it is still 'activate' and not
 * linked to a grant (belt and braces: and no grant carries its session or subscription). Whatever that
 * statement did, the outcome is read back from the stored row: a concurrent delivery may have flipped it first.
 *
 * Exported for the integration test only (the conditional flip is otherwise reached only by a race).
 *
 * SERIALIZATION: the decision row is the one lock both sides take. Every grant write for a session
 * (`writeGrant`) is a single statement that row-locks the decision (`FOR UPDATE`, re-checked after any wait),
 * writes the grant and links `grant_id` in that same statement; this flip is conditioned on `grant_id IS NULL`
 * on the same row. Whichever takes the row lock first wins, and the other's recheck (EvalPlanQual) sees the
 * committed result and writes nothing. Remaining limits (see docs/maintainers.md): a revoke landing in the
 * milliseconds between the decision and the grant write, and a lapsed-grant takeover (alert-only on replay).
 */
export async function refuseAfterLostWrite(
  db: CommercialDb,
  decision: DecisionRow,
  winnerGrantId: string
): Promise<Resolution> {
  await db
    .update(stripeCheckoutDecisionsTable)
    .set({ decision: "refuse", reason: "already_subscribed", conflictGrantId: winnerGrantId })
    .where(
      and(
        eq(stripeCheckoutDecisionsTable.sessionId, decision.sessionId),
        eq(stripeCheckoutDecisionsTable.decision, "activate"),
        isNull(stripeCheckoutDecisionsTable.grantId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(datasetAccessGrantsTable)
            .where(
              or(
                eq(datasetAccessGrantsTable.stripeCheckoutSessionId, decision.sessionId),
                eq(datasetAccessGrantsTable.stripeSubscriptionId, decision.subscriptionId)
              )
            )
        )
      )
    );
  return storedOutcome(db, decision, winnerGrantId);
}

/** What the STORED decision says now: the refund conflict for a refusal, else the alert-only superseded session. */
async function storedOutcome(db: CommercialDb, decision: DecisionRow, fallbackGrantId: string | null): Promise<Resolution> {
  const current = await decisionOf(db, decision.sessionId);
  if (current?.decision === "refuse") return refundConflictOf(db, current);
  return supersededSession(current ?? decision, fallbackGrantId);
}

interface Buyer {
  email: string;
  name: string;
  organization: string | null;
  termsVersion: string;
  paidThrough: Date;
  customerId: string | null;
  fingerprintHash: string | null;
  subscriptionId: string;
  sessionId: string;
}

/**
 * One pass: already activated, upgrade an open grant, or insert. Null means a concurrent writer moved first;
 * retry. `claim_lost` means the session's decision row no longer permits a write (it was flipped to 'refuse', or
 * linked to a different grant): nothing was written, and the caller reports the stored decision. `blocked` means another session's subscription holds a LIVE grant for this email, which is never
 * overwritten: that condition is part of the upgrade's own WHERE (and the insert hits the (email, tier) open
 * unique index), so it holds however the race interleaves.
 */
async function activate(
  buyer: Buyer,
  db: CommercialDb,
  now: Date,
  isRetry: boolean
): Promise<Resolution | { kind: "blocked"; grantId: string } | { kind: "claim_lost" } | null> {
  const [done] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      status: datasetAccessGrantsTable.status,
      accessTokenHash: datasetAccessGrantsTable.accessTokenHash,
    })
    .from(datasetAccessGrantsTable)
    .where(
      and(eq(datasetAccessGrantsTable.stripeCheckoutSessionId, buyer.sessionId), eq(datasetAccessGrantsTable.tier, "commercial"))
    )
    .limit(1);
  if (done?.accessTokenHash) {
    await extendPaidThrough(db, eq(datasetAccessGrantsTable.id, done.id), buyer.paidThrough);
    if (!isRetry || done.status === "revoked") return { kind: "updated", grantId: done.id };
    // This event was seen before and never completed, so its welcome mail most likely never went out:
    // replace the token and hand the new one back. The swap is compare-and-swap on the hash just read, so
    // a delivery that lost the race to another one mints nothing (that winner owns the mail). It cannot
    // tell an in-flight concurrent delivery from a failed one, so two deliveries that read at different
    // times can still each swap once; the last token mailed is the one that works.
    const fresh = generateToken();
    const [swapped] = await db
      .update(datasetAccessGrantsTable)
      .set({ accessTokenHash: hashToken(fresh) })
      .where(
        and(
          eq(datasetAccessGrantsTable.id, done.id),
          eq(datasetAccessGrantsTable.accessTokenHash, done.accessTokenHash),
          ne(datasetAccessGrantsTable.status, "revoked")
        )
      )
      .returning({ id: datasetAccessGrantsTable.id });
    return swapped
      ? {
          kind: "activated",
          grantId: done.id,
          sessionId: buyer.sessionId,
          mail: { kind: "dataset_subscription_active", grantId: done.id, email: buyer.email, accessToken: fresh },
        }
      : { kind: "updated", grantId: done.id };
  }

  const accessToken = generateToken();
  // Columns the INSERT and the upgrade both set (`writeGrant` builds the statement from these).
  const commonColumns: Array<[string, SQL]> = [
    ["tier", sql`'commercial'`],
    ["status", sql`'active'`],
    ["category", sql`'commercial'`],
    ["paid_through", timestamp(buyer.paidThrough)],
    ["expires_at", timestamp(buyer.paidThrough)],
    ["stripe_customer_id", sql`${buyer.customerId}::text`],
    ["stripe_subscription_id", sql`${buyer.subscriptionId}::text`],
    ["stripe_checkout_session_id", sql`${buyer.sessionId}::text`],
    ["access_token_hash", sql`${hashToken(accessToken)}::text`],
    ["approved_at", timestamp(now)],
    ["review_note", sql`${REVIEW_NOTE}::text`],
    ["renewal_requested_at", sql`null::timestamptz`],
  ];
  const activated = (grantId: string): Resolution => ({
    kind: "activated",
    grantId,
    sessionId: buyer.sessionId,
    mail: { kind: "dataset_subscription_active", grantId, email: buyer.email, accessToken },
  });

  // SECURITY: only tier 'commercial' rows are ever read or written here. The Checkout email is typed by the
  // buyer and Stripe does not verify it, so touching the free row for that address would let anyone rotate a
  // stranger's free token or push their unverified/pending request past email verification and review. The
  // (email, tier) open index lets the new commercial row sit beside the free one. A commercial row that
  // already carries this session id is found here too (the token-bearing case returned above).
  //
  // Expired commercial rows are not "open", so a new purchase by that address INSERTS a new row; checkout
  // never revives an expired one. (`invoice.paid` / `subscription.updated` on the SAME subscription may
  // still revive its own expired row: see `extendPaidThrough`.)
  // At most one open row per (email, tier) and one row per session id, so up to two rows can match: the
  // session's own (lapsed) row wins, then the lowest id, so the choice never depends on plan order.
  const [open] = await db
    .select({
      id: datasetAccessGrantsTable.id,
    })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        eq(datasetAccessGrantsTable.tier, "commercial"),
        or(
          and(
            eq(datasetAccessGrantsTable.stripeCheckoutSessionId, buyer.sessionId),
            ne(datasetAccessGrantsTable.status, "revoked")
          ),
          and(
            eq(datasetAccessGrantsTable.email, buyer.email),
            inArray(datasetAccessGrantsTable.status, [...DATASET_OPEN_GRANT_STATUSES])
          )
        )
      )
    )
    .orderBy(
      sql`case when ${datasetAccessGrantsTable.stripeCheckoutSessionId} = ${buyer.sessionId} then 0 else 1 end`,
      datasetAccessGrantsTable.id
    )
    .limit(1);

  if (open) {
    const upgraded = await writeGrant(db, buyer.sessionId, open.id, (lockDecision, linkDecision) => sql`
      with ${lockDecision},
      up as (
        update dataset_access_grants set ${sql.join(
          [
            ...commonColumns.map(([column, value]) => sql`${sql.raw(column)} = ${value}`),
            // A resubscribe keeps the row's name and organization: only the INSERT takes them from Checkout.
            sql`card_fingerprint_hash = coalesce(${buyer.fingerprintHash}::text, card_fingerprint_hash)`,
            sql`verified_at = coalesce(verified_at, ${timestamp(now)})`,
            sql`unsubscribe_token = coalesce(unsubscribe_token, ${generateToken()}::text)`,
          ],
          sql`, `
        )}
        where ${and(
          eq(datasetAccessGrantsTable.id, open.id),
          eq(datasetAccessGrantsTable.tier, "commercial"),
          // A revoke that landed after the open read must not be overwritten back to active.
          ne(datasetAccessGrantsTable.status, "revoked"),
          // Never take over a grant that is live with a DIFFERENT subscription (the same-email race).
          not(
            and(
              isNotNull(datasetAccessGrantsTable.stripeSubscriptionId),
              ne(datasetAccessGrantsTable.stripeSubscriptionId, buyer.subscriptionId),
              liveGrant(now)
            )!
          ),
          // Atomic claim: only one delivery mints the token for this session.
          or(
            isNull(datasetAccessGrantsTable.stripeCheckoutSessionId),
            ne(datasetAccessGrantsTable.stripeCheckoutSessionId, buyer.sessionId),
            isNull(datasetAccessGrantsTable.accessTokenHash)
          )
        )}
        and exists (select 1 from lock_decision)
        returning id
      ),
      ${linkDecision("up")}
      select id from up`);
    if (upgraded) return activated(upgraded);
    const lost = await lostClaim(db, buyer.sessionId, open.id);
    if (lost) return { kind: "claim_lost" };
    // Revoked after the open read: no grant, and the retry loop must not insert a fresh row either.
    const [nowRevoked] = await db
      .select({ id: datasetAccessGrantsTable.id })
      .from(datasetAccessGrantsTable)
      .where(and(eq(datasetAccessGrantsTable.id, open.id), eq(datasetAccessGrantsTable.status, "revoked")))
      .limit(1);
    if (nowRevoked) return { kind: "claim_lost" };
    const [blocker] = await db
      .select({ id: datasetAccessGrantsTable.id })
      .from(datasetAccessGrantsTable)
      .where(
        and(
          eq(datasetAccessGrantsTable.id, open.id),
          isNotNull(datasetAccessGrantsTable.stripeSubscriptionId),
          ne(datasetAccessGrantsTable.stripeSubscriptionId, buyer.subscriptionId),
          liveGrant(now)
        )
      )
      .limit(1);
    return blocker ? { kind: "blocked", grantId: blocker.id } : null;
  }

  const newId = randomUUID();
  const insertColumns: Array<[string, SQL]> = [
    ["id", sql`${newId}::uuid`],
    ...commonColumns,
    ["card_fingerprint_hash", sql`${buyer.fingerprintHash}::text`],
    ["email", sql`${buyer.email}::text`],
    ["name", sql`${buyer.name}::text`],
    ["organization", sql`${buyer.organization}::text`],
    ["intended_use", sql`${INTENDED_USE}::text`],
    ["attribution_ack_at", timestamp(now)],
    ["terms_version", sql`${buyer.termsVersion}::text`],
    ["verified_at", timestamp(now)],
    ["verify_token_hash", sql`${hashToken(generateToken())}::text`], // never sent: the buyer proved the address by paying through Stripe
    ["unsubscribe_token", sql`${generateToken()}::text`],
  ];
  const created = await writeGrant(db, buyer.sessionId, newId, (lockDecision, linkDecision) => sql`
    with ${lockDecision},
    ins as (
      insert into dataset_access_grants (${sql.raw(insertColumns.map(([column]) => column).join(", "))})
      select ${sql.join(
        insertColumns.map(([, value]) => value),
        sql`, `
      )}
      where exists (select 1 from lock_decision)
      returning id
    ),
    ${linkDecision("ins")}
    select id from ins`);
  if (created) return activated(created);
  // Nothing written: the lock found no 'activate' decision this write may claim.
  return (await lostClaim(db, buyer.sessionId, newId)) ? { kind: "claim_lost" } : null;
}

/**
 * The ONE statement that writes a grant for a checkout session, so the decision row is the serialization
 * point against `refuseAfterLostWrite`. `build` receives two CTEs: `lock_decision` row-locks this session's
 * decision (`FOR UPDATE`) while it is still 'activate' and unlinked (or already linked to `grantId`); Postgres
 * re-checks that predicate after waiting out a concurrent flip, so a refused session locks nothing and
 * `exists (select 1 from lock_decision)` keeps the grant write from happening. `linkDecision(cte)` sets
 * `grant_id` in the same statement, only if the named write CTE returned a row (a data-modifying CTE runs
 * whether or not it is read, so the link must depend on the write, never the reverse). Parameters are bound.
 * Returns the written grant id, or undefined when nothing was written.
 */
async function writeGrant(
  db: CommercialDb,
  sessionId: string,
  grantId: string,
  build: (lockDecision: SQL, linkDecision: (writeCte: "up" | "ins") => SQL) => SQL
): Promise<string | undefined> {
  const lockDecision = sql`lock_decision as (
    select 1 from stripe_checkout_decisions
    where session_id = ${sessionId} and decision = 'activate' and (grant_id is null or grant_id = ${grantId}::uuid)
    for update
  )`;
  const linkDecision = (writeCte: "up" | "ins") => sql`link as (
    update stripe_checkout_decisions set grant_id = ${grantId}::uuid
    where session_id = ${sessionId} and decision = 'activate' and exists (select 1 from ${sql.raw(writeCte)})
    returning 1
  )`;
  const result = await db.execute(build(lockDecision, linkDecision));
  // PgDatabase leaves the driver's result type open; both neon-http and PGlite return `{ rows }`.
  return (result as unknown as { rows: Array<{ id: string }> }).rows[0]?.id;
}

/**
 * True when the session's decision row definitely no longer permits a write: flipped to 'refuse', or linked to
 * a grant other than `candidateGrantId`. False means the lock was fine and the grant write failed on its own
 * conditions (a live grant with another subscription, a lost token claim) or the row is still claimable.
 */
async function lostClaim(db: CommercialDb, sessionId: string, candidateGrantId: string): Promise<boolean> {
  const current = await decisionOf(db, sessionId);
  if (!current) return false;
  return current.decision === "refuse" || (current.grantId !== null && current.grantId !== candidateGrantId);
}

/** paidThrough = expiresAt = max(current, next), in one statement so both columns see the same old value. */
async function extendPaidThrough(db: CommercialDb, where: ReturnType<typeof eq>, next: Date) {
  const greatest = sql`greatest(${datasetAccessGrantsTable.paidThrough}, ${timestamp(next)})`;
  return db
    .update(datasetAccessGrantsTable)
    .set({
      paidThrough: greatest,
      expiresAt: greatest,
      // A sweep may have marked a lapsed grant expired; a payment that arrives afterwards revives it.
      status: sql`case when ${datasetAccessGrantsTable.status} = 'expired' then 'active' else ${datasetAccessGrantsTable.status} end`,
    })
    .where(and(where, eq(datasetAccessGrantsTable.tier, "commercial")))
    .returning({ id: datasetAccessGrantsTable.id });
}

async function grantBySubscription(
  db: CommercialDb,
  subscriptionId: string
): Promise<Pick<DatasetAccessGrantRow, "id" | "tier" | "status"> | undefined> {
  const [grant] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      tier: datasetAccessGrantsTable.tier,
      status: datasetAccessGrantsTable.status,
    })
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return grant?.tier === "commercial" ? grant : undefined;
}

async function handleInvoicePaid(invoice: Stripe.Invoice, deps: StripeEventDeps): Promise<Resolution> {
  if (!(typeof invoice.amount_paid === "number" && invoice.amount_paid > 0)) return ignored("zero-amount invoice");
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return ignored("invoice has no subscription");
  const grant = await grantBySubscription(deps.db, subscriptionId);
  // The first invoice of a subscription races its checkout event, which provisions the grant.
  if (!grant && invoice.billing_reason === "subscription_create") return ignored("no grant yet");

  const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
  if (!isPaying(sub)) return ignored("subscription not in a paying status");
  if (!hasOnlyAllowedPrices(sub)) return ignored("subscription price not allowed");
  // Any later invoice with no linked grant means someone is paying and cannot get in: alert only.
  if (!grant) return { kind: "conflict", reason: "orphaned_subscription", subscriptionId };
  // A revoked grant is never extended; its subscription still billing means the revoke did not cancel it.
  if (grant.status === "revoked") {
    return { kind: "conflict", reason: "revoked_still_billing", grantId: grant.id, subscriptionId };
  }
  await extendPaidThrough(deps.db, eq(datasetAccessGrantsTable.id, grant.id), subscriptionPeriodEnd(sub));
  return { kind: "updated", grantId: grant.id };
}

async function handleSubscriptionUpdated(
  eventSub: Stripe.Subscription,
  deps: StripeEventDeps
): Promise<Resolution> {
  const grant = await grantBySubscription(deps.db, eventSub.id);
  if (!grant) return ignored("no grant for subscription");
  // Status, prices and period come from the retrieved subscription, never the (possibly stale) event body.
  const sub = await deps.stripe.subscriptions.retrieve(eventSub.id);
  if (!isPaying(sub)) return ignored("subscription not in a paying status");
  if (!hasOnlyAllowedPrices(sub)) return ignored("subscription price not allowed");
  if (grant.status === "revoked") {
    return { kind: "conflict", reason: "revoked_still_billing", grantId: grant.id, subscriptionId: sub.id };
  }
  await extendPaidThrough(deps.db, eq(datasetAccessGrantsTable.id, grant.id), subscriptionPeriodEnd(sub));
  return { kind: "updated", grantId: grant.id };
}

async function handleSubscriptionDeleted(
  sub: Stripe.Subscription,
  deps: StripeEventDeps,
  now: Date
): Promise<Resolution> {
  const grant = await grantBySubscription(deps.db, sub.id);
  if (!grant) return ignored("no grant for subscription");

  // An immediate cancel (refund) ends now; a period-end cancel ends at or after paidThrough, which then wins.
  const endedAt = typeof sub.ended_at === "number" ? new Date(sub.ended_at * 1000) : now;
  const least = sql`least(${datasetAccessGrantsTable.paidThrough}, ${timestamp(endedAt)})`;
  await deps.db
    .update(datasetAccessGrantsTable)
    .set({ paidThrough: least, expiresAt: least })
    .where(and(eq(datasetAccessGrantsTable.id, grant.id), eq(datasetAccessGrantsTable.tier, "commercial")));
  return { kind: "updated", grantId: grant.id };
}
