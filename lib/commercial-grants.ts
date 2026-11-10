import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type Stripe from "stripe";

import { DATASET_TERMS_VERSION, liveGrant } from "@/lib/dataset-grants";
import { redactedErrorCode } from "@/lib/db-error";
import {
  DATASET_OPEN_GRANT_STATUSES,
  datasetAccessGrantsTable,
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
  | { kind: "activated"; grantId: string; mail: SubscriptionActiveMailIntent }
  /**
   * CONTRACT for the route (U5b). Auto cancel + refund happens ONLY for the two `checkout.session.completed`
   * conflicts below (`already_subscribed`, `revoked_buyer`), and the target is ALWAYS the signed session's
   * own subscription (`newSubscriptionId`) and its own first payment (`invoiceId`): cancel that subscription
   * and refund that invoice, using Stripe idempotency keys derived from `sessionId` (a redelivery after the
   * cancel returns the same conflict, so the refund is retried safely). NEVER act on `existingSubscriptionId`
   * or on the revoked grant's subscription from these outcomes. Always alert the maintainer.
   *
   * `already_subscribed`: the buyer already holds a LIVE commercial subscription (a different one). Nothing
   * was changed and no token was minted.
   */
  | {
      kind: "conflict";
      reason: "already_subscribed";
      grantId: string;
      existingSubscriptionId: string;
      newSubscriptionId: string;
      sessionId: string;
      invoiceId: string | null;
    }
  /**
   * `revoked_buyer`: a checkout that would create a NEW subscription for a buyer whose commercial grant was
   * REVOKED (matched by email, Stripe customer id or card fingerprint). A revoke sticks on the paid tier:
   * nothing was created or changed and no token was minted. `grantId` is the revoked grant. Auto cancel +
   * refund of the new subscription, as above.
   */
  | {
      kind: "conflict";
      reason: "revoked_buyer";
      grantId: string;
      newSubscriptionId: string;
      sessionId: string;
      invoiceId: string | null;
    }
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
  | { kind: "activated"; grantId: string; mail: SubscriptionActiveMailIntent }
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
      return handleCheckoutCompleted(event.data.object, deps, now, isRetry);
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
    .limit(1);
  return revoked;
}

/** sha256 of the default payment method's card fingerprint, or null when none is exposed. Never the raw value. */
function cardFingerprintHashOf(sub: Stripe.Subscription): string | null {
  const method = sub.default_payment_method;
  const fingerprint = method && typeof method === "object" ? method.card?.fingerprint : null;
  return fingerprint ? hashToken(fingerprint) : null;
}

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
        eq(datasetAccessGrantsTable.stripeCheckoutSessionId, session.id),
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.status, "revoked")
      )
    )
    .limit(1);
  if (ownRevoked) return ignored("grant revoked; billing is stopped by the revoke action");

  // Conflicts come BEFORE the amount and status checks: a redelivery after the route already cancelled the
  // new subscription must return the same conflict (so its refund is retried), never `ignored`.
  const customerId = idOf(session.customer);
  const fingerprintHash = cardFingerprintHashOf(sub);
  const conflictBase = { sessionId: session.id, newSubscriptionId: sub.id, invoiceId: idOf(session.invoice) };

  // A revoke sticks: nothing is created, resubscribed or re-minted for a revoked buyer.
  const revoked = await revokedBuyer(deps.db, { email, customerId, fingerprintHash });
  if (revoked) return { kind: "conflict", reason: "revoked_buyer", grantId: revoked.id, ...conflictBase };

  // Never overwrite a live subscription with a second one.
  const [existing] = await deps.db
    .select({ id: datasetAccessGrantsTable.id, stripeSubscriptionId: datasetAccessGrantsTable.stripeSubscriptionId })
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
  if (existing?.stripeSubscriptionId) {
    return {
      kind: "conflict",
      reason: "already_subscribed",
      grantId: existing.id,
      existingSubscriptionId: existing.stripeSubscriptionId,
      ...conflictBase,
    };
  }

  if (!(typeof session.amount_total === "number" && session.amount_total > 0)) return ignored("zero-amount checkout");
  if (!isPaying(sub)) return ignored("subscription not in a paying status");

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
      if (resolution) return resolution;
    } catch (err) {
      // A concurrent delivery won the open-email or session-id unique index: re-read and decide again.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("commercial grant activation kept losing a unique-index race");
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

/** One pass: already activated, upgrade an open grant, or insert. Null means a concurrent writer moved first; retry. */
async function activate(
  buyer: Buyer,
  db: CommercialDb,
  now: Date,
  isRetry: boolean
): Promise<Resolution | null> {
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
          mail: { kind: "dataset_subscription_active", grantId: done.id, email: buyer.email, accessToken: fresh },
        }
      : { kind: "updated", grantId: done.id };
  }

  const accessToken = generateToken();
  const commercialFields = {
    tier: "commercial" as const,
    status: "active" as const,
    category: "commercial" as const,
    paidThrough: buyer.paidThrough,
    expiresAt: buyer.paidThrough,
    stripeCustomerId: buyer.customerId,
    stripeSubscriptionId: buyer.subscriptionId,
    stripeCheckoutSessionId: buyer.sessionId,
    ...(buyer.fingerprintHash ? { cardFingerprintHash: buyer.fingerprintHash } : {}),
    accessTokenHash: hashToken(accessToken),
    approvedAt: now,
    reviewNote: REVIEW_NOTE,
    renewalRequestedAt: null,
  };
  const activated = (grantId: string): Resolution => ({
    kind: "activated",
    grantId,
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
    .limit(1);

  if (open) {
    const [upgraded] = await db
      .update(datasetAccessGrantsTable)
      .set({
        // A resubscribe keeps the row's name and organization: only the INSERT takes them from Checkout.
        ...commercialFields,
        verifiedAt: sql`coalesce(${datasetAccessGrantsTable.verifiedAt}, ${timestamp(now)})`,
        unsubscribeToken: sql`coalesce(${datasetAccessGrantsTable.unsubscribeToken}, ${generateToken()})`,
      })
      .where(
        and(
          eq(datasetAccessGrantsTable.id, open.id),
          eq(datasetAccessGrantsTable.tier, "commercial"),
          // Atomic claim: only one delivery mints the token for this session.
          or(
            isNull(datasetAccessGrantsTable.stripeCheckoutSessionId),
            ne(datasetAccessGrantsTable.stripeCheckoutSessionId, buyer.sessionId),
            isNull(datasetAccessGrantsTable.accessTokenHash)
          )
        )
      )
      .returning({ id: datasetAccessGrantsTable.id });
    return upgraded ? activated(upgraded.id) : null;
  }

  const [created] = await db
    .insert(datasetAccessGrantsTable)
    .values({
      ...commercialFields,
      email: buyer.email,
      name: buyer.name,
      organization: buyer.organization,
      intendedUse: INTENDED_USE,
      attributionAckAt: now,
      termsVersion: buyer.termsVersion,
      verifiedAt: now,
      verifyTokenHash: hashToken(generateToken()), // never sent: the buyer proved the address by paying through Stripe
      unsubscribeToken: generateToken(),
    })
    .returning({ id: datasetAccessGrantsTable.id });
  return activated(created.id);
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
