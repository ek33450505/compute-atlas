import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { findLiveCommercialGrant, type CommercialDb } from "@/lib/commercial-conflicts";
import { COMMERCIAL_PLANS } from "@/lib/commercial-plans";
import { DATASET_TERMS_VERSION, liveGrant } from "@/lib/dataset-grants";
import type { CommercialAlertAction, CommercialAlertReason } from "@/lib/dataset-email-templates";
import { redactedErrorCode } from "@/lib/db-error";
import {
  commercialCheckoutsTable,
  DATASET_OPEN_GRANT_STATUSES,
  datasetAccessGrantsTable,
  emailSendsTable,
  paypalWebhookEventsTable,
} from "@/lib/db/schema";
import { generateToken, sendDatasetCommercialAlertEmail, sendDatasetSubscriptionActiveEmail, type SendOutcome } from "@/lib/email";
import { sendDatasetCommercialAlertGated, sendGrantGated, type GateResult } from "@/lib/email-gate";
import { getDb } from "@/lib/db/client";
import {
  allowedCommercialPlanIds,
  getSubscription,
  planForPlanId,
  type CommercialPlan,
  type PayPalSubscription,
  type PayPalWebhookEvent,
} from "@/lib/paypal";
import { hashToken } from "@/lib/token-hash";

/**
 * Activation and event handling for PayPal commercial subscriptions. `activateFromPayPal` is the ONE
 * entry for both the buyer's return route and the webhook, and `processPaypalEvent` dispatches webhook events.
 * Nothing is ever read from an event body beyond ids: the subscription is always re-fetched from PayPal, and
 * only `status === "ACTIVE"` grants anything or extends anything.
 *
 * Ported from the earlier reviewed implementation (lib/commercial-grants.ts / commercial-actions.ts on
 * origin/feat/commercial-tier): the decision is made once and stored (here on the `commercial_checkouts` row,
 * where the earlier version had its own decisions table); NOTHING here moves money (Ed's decision: paying buyers are not
 * refused and nothing is cancelled or refunded automatically; the only conflict, a second subscription for an
 * address that already holds a live commercial grant, writes no grant and alerts the maintainer, who decides by
 * hand in PayPal); the grant is written by ONE statement that row-locks the
 * checkout, writes the grant and links the decision, so two concurrent activations can never both write; the
 * welcome mail is at-least-once (a send failure throws, the retry re-mints a token and mails again); alerts
 * to the maintainer are deduped by their gate and required (a missing one throws so PayPal redelivers).
 *
 * Never logs a token, an address or an id; only `redactedErrorCode`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";
const REVIEW_NOTE = "Self-serve commercial subscription";
const INTENDED_USE = "Commercial subscription (self-serve)";
/** A lost unique-index or claim race re-reads and decides again; three rounds cover two concurrent callers. */
const MAX_ACTIVATION_ATTEMPTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_ID_RE = /^I-[A-Z0-9]{6,32}$/;

export type ActivationOutcome =
  | { kind: "activated"; grantId: string }
  | { kind: "refused"; reason: "duplicate_subscription" }
  | { kind: "pending"; status: PayPalSubscription["status"] }
  | { kind: "ignored"; reason: string };

export type PaypalEventOutcome =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | { kind: "activation"; outcome: ActivationOutcome }
  | { kind: "renewal"; grantId: string; extended: boolean }
  | { kind: "no_change"; reason: string }
  | { kind: "alerted"; reason: CommercialAlertReason };

interface AlertMailInput {
  reason: CommercialAlertReason;
  action: CommercialAlertAction;
  subscriptionId: string | null;
  checkoutId: string | null;
  saleId: string | null;
  grantId?: string | null;
}

/** Test seam: the two real senders. Each is called only inside its gate's callback. */
export interface CommercialMailers {
  subscriptionActive: (input: { email: string; accessToken: string }) => Promise<SendOutcome>;
  alert: (input: AlertMailInput) => Promise<SendOutcome>;
}

export interface CommercialActivationDeps {
  db?: CommercialDb;
  now?: Date;
  sendMail?: CommercialMailers;
  /** The PayPal sale that triggered this call (a PAYMENT.SALE.COMPLETED event): the maintainer alerts it can cause dedupe per sale. */
  saleId?: string | null;
}

type CheckoutRow = typeof commercialCheckoutsTable.$inferSelect;

const isUniqueViolation = (err: unknown): boolean => redactedErrorCode(err) === UNIQUE_VIOLATION;

const timestamp = (value: Date) => sql`${value.toISOString()}::timestamptz`;

/** PayPal amounts are decimal strings ("150.0" and "150.00" both occur): compare as cents, never as strings. */
function toCents(amount: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null;
  return Math.round(Number(amount) * 100);
}

/** One billing interval per plan, in days, rounded up (a month may have 31 days, a year 366). */
const PLAN_INTERVAL_DAYS = { monthly: 31, annual: 366 } as const;
/** Slack above one interval for a next-billing date PayPal moved a little (retries, weekend shifts). */
const PERIOD_CAP_SLACK_MS = 7 * DAY_MS;

/** The latest `paid_through` one payment can justify: now + one plan interval + 7 days. */
function periodCap(plan: CommercialPlan, now: Date): Date {
  return new Date(now.getTime() + PLAN_INTERVAL_DAYS[plan] * DAY_MS + PERIOD_CAP_SLACK_MS);
}

/**
 * What an EXISTING grant may take from this subscription, or null for no extension. PayPal keeps a
 * subscription ACTIVE through failed-payment retries and `next_billing_time` still moves, so status alone proves
 * nothing. An extension needs a NEW payment: `lastPayment.time` strictly newer than the grant's `last_payment_at`
 * (the payment that funded the current `paid_through`), so a replay or a stale event carrying an already-used
 * payment can never buy another period, however late it arrives. On top: ACTIVE, an allowlisted plan equal to
 * the grant's own, a USD payment of exactly the plan price, and the new date capped at `periodCap`. A commercial
 * grant with a null `last_payment_at` should never exist; it gets no extension and a logged code. The caller
 * applies the result with `extendPaidThrough` (compare-and-swap on `last_payment_at`, `greatest()` on the date).
 */
function verifiedExtension(
  sub: PayPalSubscription,
  plan: CommercialPlan,
  lastPaymentAt: Date | null,
  now: Date
): { paidThrough: Date; paymentAt: Date } | null {
  if (sub.status !== "ACTIVE") return null;
  if (!sub.planId || !allowedCommercialPlanIds().has(sub.planId) || planForPlanId(sub.planId) !== plan) return null;
  const next = nextBilling(sub);
  if (!next || !sub.lastPayment) return null;
  const cents = toCents(sub.lastPayment.amount);
  if (sub.lastPayment.currency !== "USD" || cents !== COMMERCIAL_PLANS[plan].priceUsd * 100) return null;
  const paymentAt = new Date(sub.lastPayment.time);
  if (Number.isNaN(paymentAt.getTime())) return null;
  if (!lastPaymentAt) {
    console.warn("commercial grant has no last_payment_at (code: missing_last_payment_at)");
    return null;
  }
  if (paymentAt.getTime() <= lastPaymentAt.getTime()) return null;
  const cap = periodCap(plan, now);
  return { paidThrough: next.getTime() > cap.getTime() ? cap : next, paymentAt };
}

function nextBilling(sub: PayPalSubscription): Date | null {
  if (!sub.nextBillingTime) return null;
  const date = new Date(sub.nextBillingTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Required: returns once the alert is out (or was out before); throws otherwise so PayPal redelivers until the
 * maintainer has been told. A missing CONTACT_TO_EMAIL is a `gate_error`, so it throws too.
 */
async function sendAlert(
  deps: Required<Pick<CommercialActivationDeps, "db">> & CommercialActivationDeps,
  args: AlertMailInput,
  targetId: string
): Promise<void> {
  let result: GateResult;
  try {
    result = await sendDatasetCommercialAlertGated(
      deps.db,
      { recipient: (process.env.CONTACT_TO_EMAIL ?? "").trim(), reason: args.reason, targetId },
      () => (deps.sendMail ? deps.sendMail.alert(args) : sendDatasetCommercialAlertEmail(args))
    );
  } catch (err) {
    result = { sent: false, disposition: "gate_error" };
    console.warn(`commercial alert failed (${redactedErrorCode(err)})`);
  }
  if (result.sent || result.disposition === "skipped_duplicate") return;
  throw new Error(`commercial alert not sent (${result.disposition})`);
}

type ResolvedDeps = Required<Pick<CommercialActivationDeps, "db" | "now">> & CommercialActivationDeps;

const resolveDeps = (deps: CommercialActivationDeps): ResolvedDeps => ({
  ...deps,
  db: deps.db ?? getDb(),
  now: deps.now ?? new Date(),
});

async function checkoutById(db: CommercialDb, id: string): Promise<CheckoutRow | undefined> {
  const [row] = await db.select().from(commercialCheckoutsTable).where(eq(commercialCheckoutsTable.id, id)).limit(1);
  return row;
}

/**
 * paidThrough = expiresAt = max(current, next) and last_payment_at = the funding payment, in ONE statement, only
 * while `last_payment_at` is older than this payment (compare-and-swap: two concurrent deliveries of the same
 * payment extend once, the other writes nothing), and only while the grant is BOUND to `subscriptionId`, the
 * subscription whose payment is credited: a grant upgraded in place by a newer subscription is never extended
 * by an older one that still bills. Returns whether this call extended. Never shortens.
 */
async function extendPaidThrough(
  db: CommercialDb,
  grantId: string,
  subscriptionId: string,
  ext: { paidThrough: Date; paymentAt: Date }
): Promise<boolean> {
  const greatest = sql`greatest(${datasetAccessGrantsTable.paidThrough}, ${timestamp(ext.paidThrough)})`;
  const rows = await db
    .update(datasetAccessGrantsTable)
    .set({
      paidThrough: greatest,
      expiresAt: greatest,
      lastPaymentAt: ext.paymentAt,
      // A sweep may have marked a lapsed grant expired; a payment that arrives afterwards revives it.
      status: sql`case when ${datasetAccessGrantsTable.status} = 'expired' then 'active' else ${datasetAccessGrantsTable.status} end`,
    })
    .where(
      and(
        eq(datasetAccessGrantsTable.id, grantId),
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.paypalSubscriptionId, subscriptionId),
        sql`${datasetAccessGrantsTable.status} <> 'revoked'`,
        sql`${datasetAccessGrantsTable.lastPaymentAt} < ${timestamp(ext.paymentAt)}`
      )
    )
    .returning({ id: datasetAccessGrantsTable.id });
  return rows.length > 0;
}

export async function activateFromPayPal(
  subscriptionId: string,
  rawDeps: CommercialActivationDeps = {}
): Promise<ActivationOutcome> {
  const deps = resolveDeps(rawDeps);
  const { db } = deps;
  const sub = await getSubscription(subscriptionId);
  const active = sub.status === "ACTIVE";

  const unmatched = async (reason: string, checkoutId: string | null = null): Promise<ActivationOutcome> => {
    // A paid-but-unmatched subscription is the only case worth telling the maintainer about.
    if (active) {
      await sendAlert(
        deps,
        { reason: "unmatched_subscription", action: "none", subscriptionId: sub.id, checkoutId, saleId: null },
        sub.id
      );
    }
    return { kind: "ignored", reason };
  };

  const checkout = sub.customId && UUID_RE.test(sub.customId) ? await checkoutById(db, sub.customId) : undefined;
  if (!checkout) return active ? unmatched("no checkout for subscription") : { kind: "pending", status: sub.status };
  if (checkout.paypalSubscriptionId && checkout.paypalSubscriptionId !== sub.id) {
    return unmatched("checkout belongs to another subscription", checkout.id);
  }

  // A stored decision is replayed whatever the subscription's status is now.
  if (checkout.decision === "refuse") return replayDuplicate(deps, checkout, sub);
  if (checkout.decision === "activate") return replayActivation(deps, checkout, sub);
  if (!active) return { kind: "pending", status: sub.status };

  const plan = sub.planId && allowedCommercialPlanIds().has(sub.planId) ? planForPlanId(sub.planId) : null;
  if (!plan) return unmatched("plan not allowed", checkout.id);
  if (plan !== checkout.plan) return unmatched("plan differs from checkout", checkout.id);
  // ACTIVE but no payment recorded yet: PAYMENT.SALE.COMPLETED activates it when the money lands.
  if (!sub.lastPayment) return { kind: "pending", status: sub.status };
  const paymentAt = new Date(sub.lastPayment.time);
  if (Number.isNaN(paymentAt.getTime())) return unmatched("payment time is invalid", checkout.id);
  const paidCents = toCents(sub.lastPayment.amount);
  if (paidCents === null || paidCents <= 0) return unmatched("payment amount is not positive", checkout.id);
  if (sub.lastPayment.currency !== "USD" || paidCents !== COMMERCIAL_PLANS[plan].priceUsd * 100) {
    return unmatched("payment does not match the plan price", checkout.id);
  }
  const nextPeriodEnd = nextBilling(sub);
  if (!nextPeriodEnd) return unmatched("no next billing time", checkout.id);
  const cap = periodCap(plan, deps.now);
  const paidThrough = nextPeriodEnd.getTime() > cap.getTime() ? cap : nextPeriodEnd;
  if (!checkout.email) return unmatched("checkout has no email", checkout.id);

  const email = checkout.email;

  for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt++) {
    const current = attempt === 0 ? checkout : await checkoutById(db, checkout.id);
    if (!current) return { kind: "ignored", reason: "checkout no longer exists" };
    if (current.decision) return activateFromPayPal(subscriptionId, rawDeps);

    try {
      const conflict = await findLiveCommercialGrant(db, { email, excludeSubscriptionId: sub.id, now: deps.now });
      if (conflict) {
        await db
          .update(commercialCheckoutsTable)
          .set({
            decision: "refuse",
            reason: "duplicate_subscription",
            conflictGrantId: conflict.grantId,
            paypalSubscriptionId: sub.id,
            decidedAt: deps.now,
          })
          .where(and(eq(commercialCheckoutsTable.id, checkout.id), sql`${commercialCheckoutsTable.decision} is null`));
        // Whoever claimed, the outcome is what the stored row says.
        return activateFromPayPal(subscriptionId, rawDeps);
      }

      const written = await writeGrant(db, {
        checkoutId: checkout.id,
        subscriptionId: sub.id,
        email,
        name: checkout.name ?? email,
        organization: checkout.organization,
        termsVersion: checkout.termsVersion || DATASET_TERMS_VERSION,
        paidThrough,
        paymentAt,
        now: deps.now,
      });
      if (!written) continue; // lost the claim or a guard moved: re-read and decide again
      return await deliverWelcome(deps, { id: written.grantId, email }, written.accessToken, checkout.id);
    } catch (err) {
      // A concurrent caller won the open-email or subscription-id unique index: re-read and decide again.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("commercial grant activation kept losing a race");
}

interface GrantWrite {
  checkoutId: string;
  subscriptionId: string;
  email: string;
  name: string;
  organization: string | null;
  termsVersion: string;
  paidThrough: Date;
  /** `lastPayment.time` of the payment that funds `paidThrough`. */
  paymentAt: Date;
  now: Date;
}

/**
 * The ONE statement that makes the 'activate' decision AND writes the grant. `lock_co` row-locks the checkout
 * while it is still undecided (`FOR UPDATE`; Postgres re-checks the predicate after waiting out a concurrent
 * decision, so the loser locks nothing); the grant write requires that lock, and the decision is claimed only
 * if the write returned a row (a data-modifying CTE runs whether or not it is read, so the claim must depend
 * on the write, never the reverse). A refused write therefore leaves the checkout undecided. Whichever caller
 * takes the lock first wins; the other writes nothing and the caller re-reads. Parameters are bound.
 *
 * SECURITY: only tier 'commercial' rows are read or written. The checkout email is typed by the buyer and
 * nobody verified it, so a purchase must never touch somebody's free grant; the (email, tier) open index lets
 * the commercial row sit beside it. A LAPSED open commercial row for the address (not yet swept to 'expired')
 * is upgraded in place instead of inserting a second open row, never while it is live under another
 * subscription and never if revoked.
 */
async function writeGrant(
  db: CommercialDb,
  w: GrantWrite
): Promise<{ grantId: string; accessToken: string } | undefined> {
  const accessToken = generateToken();
  const common: Array<[string, SQL]> = [
    ["tier", sql`'commercial'`],
    ["status", sql`'active'`],
    ["category", sql`'commercial'`],
    ["paid_through", timestamp(w.paidThrough)],
    ["expires_at", timestamp(w.paidThrough)],
    ["last_payment_at", timestamp(w.paymentAt)],
    ["paypal_subscription_id", sql`${w.subscriptionId}::text`],
    ["access_token_hash", sql`${hashToken(accessToken)}::text`],
    ["approved_at", timestamp(w.now)],
    ["review_note", sql`${REVIEW_NOTE}::text`],
    ["renewal_requested_at", sql`null::timestamptz`],
  ];

  const [open] = await db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.email, w.email),
        inArray(datasetAccessGrantsTable.status, [...DATASET_OPEN_GRANT_STATUSES])
      )
    )
    .orderBy(datasetAccessGrantsTable.id)
    .limit(1);

  const grantId = open?.id ?? randomUUID();
  const lockCheckout = sql`lock_co as (
    select 1 from commercial_checkouts
    where id = ${w.checkoutId}::uuid and decision is null
      and (paypal_subscription_id is null or paypal_subscription_id = ${w.subscriptionId}::text)
    for update
  )`;
  const claim = (writeCte: "up" | "ins") => sql`claim as (
    update commercial_checkouts
    set decision = 'activate', decided_at = ${timestamp(w.now)}, grant_id = ${grantId}::uuid,
        paypal_subscription_id = ${w.subscriptionId}::text
    where id = ${w.checkoutId}::uuid and decision is null and exists (select 1 from ${sql.raw(writeCte)})
    returning 1
  )`;

  let statement: SQL;
  if (open) {
    statement = sql`
      with ${lockCheckout},
      up as (
        update dataset_access_grants set ${sql.join(
          [
            ...common.map(([column, value]) => sql`${sql.raw(column)} = ${value}`),
            // A resubscribe keeps the row's name and organization: only the INSERT takes them from the checkout.
            sql`verified_at = coalesce(verified_at, ${timestamp(w.now)})`,
            sql`unsubscribe_token = coalesce(unsubscribe_token, ${generateToken()}::text)`,
          ],
          sql`, `
        )}
        where ${and(
          eq(datasetAccessGrantsTable.id, open.id),
          eq(datasetAccessGrantsTable.tier, "commercial"),
          sql`${datasetAccessGrantsTable.status} <> 'revoked'`,
          // Never take over a grant that is live with a DIFFERENT subscription (the same-email race).
          sql`not (${datasetAccessGrantsTable.paypalSubscriptionId} is not null and ${datasetAccessGrantsTable.paypalSubscriptionId} <> ${w.subscriptionId}::text and ${liveGrant(w.now)})`
        )}
        and exists (select 1 from lock_co)
        returning id
      ),
      ${claim("up")}
      select id from up`;
  } else {
    const columns: Array<[string, SQL]> = [
      ["id", sql`${grantId}::uuid`],
      ...common,
      ["email", sql`${w.email}::text`],
      ["name", sql`${w.name}::text`],
      ["organization", sql`${w.organization}::text`],
      ["intended_use", sql`${INTENDED_USE}::text`],
      ["attribution_ack_at", timestamp(w.now)],
      ["terms_version", sql`${w.termsVersion}::text`],
      ["verified_at", timestamp(w.now)],
      ["verify_token_hash", sql`${hashToken(generateToken())}::text`], // never sent: the buyer proved the address by paying
      ["unsubscribe_token", sql`${generateToken()}::text`],
    ];
    statement = sql`
      with ${lockCheckout},
      ins as (
        insert into dataset_access_grants (${sql.raw(columns.map(([column]) => column).join(", "))})
        select ${sql.join(
          columns.map(([, value]) => value),
          sql`, `
        )}
        where exists (select 1 from lock_co)
        returning id
      ),
      ${claim("ins")}
      select id from ins`;
  }

  const result = await db.execute(statement);
  // PgDatabase leaves the driver's result type open; both neon-http and PGlite return `{ rows }`.
  const row = (result as unknown as { rows: Array<{ id: string }> }).rows[0];
  return row ? { grantId: row.id, accessToken } : undefined;
}

/**
 * Welcome mail, at-least-once: a failed send THROWS so the caller answers 500 and PayPal redelivers. A terminal
 * skip (the address opted out, or the grant is not live) alerts the maintainer instead, because a retry would
 * skip the same way.
 */
async function deliverWelcome(
  deps: ResolvedDeps,
  grant: { id: string; email: string },
  accessToken: string,
  checkoutId: string
): Promise<ActivationOutcome> {
  const result = await sendGrantGated(
    deps.db,
    { kind: "dataset_subscription_active", grantId: grant.id, email: grant.email },
    () =>
      deps.sendMail
        ? deps.sendMail.subscriptionActive({ email: grant.email, accessToken })
        : sendDatasetSubscriptionActiveEmail({ email: grant.email, accessToken })
  );
  if (result.sent) return { kind: "activated", grantId: grant.id };
  if (result.disposition === "skipped_suppressed" || result.disposition === "skipped_unconfirmed") {
    await sendAlert(
      deps,
      {
        reason: "welcome_mail_undeliverable",
        action: result.disposition === "skipped_suppressed" ? "link_not_mailed_suppressed" : "link_not_mailed_unconfirmed",
        subscriptionId: null,
        checkoutId,
        saleId: null,
        grantId: grant.id,
      },
      `${grant.id}:${checkoutId}`
    );
    return { kind: "activated", grantId: grant.id };
  }
  throw new Error(`subscription active mail not sent (${result.disposition})`);
}

/**
 * A stored 'activate' decision seen again (return route and webhook both arrive, or PayPal redelivers). Never a
 * second grant. The paid-through date is extended only by a verified NEWER payment (`verifiedExtension`; never
 * shortened). If NO welcome send reached a terminal state for the grant (a `sent` row, or a terminal skip such
 * as an opted-out address; only a failed or absent send is retried), the token is replaced (compare-and-swap on
 * the hash just read) and mailed again. A terminal skip re-runs only its (deduped) maintainer alert, so a
 * failed alert is not lost. Two callers racing here can each swap once, and the token that works is the last one
 * SWAPPED, not necessarily the last one mailed: a slower send can deliver a dead link. The only recourse is the maintainer's
 * reissue from /admin/access (`reissueDatasetLink`; there is no buyer-facing reissue), which a buyer who
 * reports a dead link needs.
 */
async function replayActivation(deps: ResolvedDeps, checkout: CheckoutRow, sub: PayPalSubscription): Promise<ActivationOutcome> {
  const { db } = deps;
  if (!checkout.grantId) return { kind: "ignored", reason: "grant no longer exists" };
  const [grant] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      email: datasetAccessGrantsTable.email,
      status: datasetAccessGrantsTable.status,
      accessTokenHash: datasetAccessGrantsTable.accessTokenHash,
      lastPaymentAt: datasetAccessGrantsTable.lastPaymentAt,
    })
    .from(datasetAccessGrantsTable)
    .where(and(eq(datasetAccessGrantsTable.id, checkout.grantId), eq(datasetAccessGrantsTable.tier, "commercial")))
    .limit(1);
  if (!grant) return { kind: "ignored", reason: "grant no longer exists" };
  if (grant.status === "revoked") return { kind: "ignored", reason: "grant revoked" };

  const extension = verifiedExtension(sub, checkout.plan, grant.lastPaymentAt, deps.now);
  if (extension) await extendPaidThrough(db, grant.id, sub.id, extension);

  // Any terminal welcome row ends the mail: a failed or absent send alone may re-mint.
  const prior = await db
    .select({ outcome: emailSendsTable.outcome })
    .from(emailSendsTable)
    .where(
      and(
        eq(emailSendsTable.kind, "dataset_subscription_active"),
        eq(emailSendsTable.targetType, "dataset"),
        eq(emailSendsTable.targetId, grant.id),
        inArray(emailSendsTable.outcome, ["sent", "skipped_suppressed", "skipped_unconfirmed"])
      )
    );
  if (prior.some((row) => row.outcome === "sent") || !grant.accessTokenHash) return { kind: "activated", grantId: grant.id };
  const skipped = prior[0];
  if (skipped) {
    await sendAlert(
      deps,
      {
        reason: "welcome_mail_undeliverable",
        action: skipped.outcome === "skipped_suppressed" ? "link_not_mailed_suppressed" : "link_not_mailed_unconfirmed",
        subscriptionId: null,
        checkoutId: checkout.id,
        saleId: null,
        grantId: grant.id,
      },
      `${grant.id}:${checkout.id}`
    );
    return { kind: "activated", grantId: grant.id };
  }

  const fresh = generateToken();
  const [swapped] = await db
    .update(datasetAccessGrantsTable)
    .set({ accessTokenHash: hashToken(fresh) })
    .where(
      and(
        eq(datasetAccessGrantsTable.id, grant.id),
        eq(datasetAccessGrantsTable.accessTokenHash, grant.accessTokenHash),
        sql`${datasetAccessGrantsTable.status} <> 'revoked'`
      )
    )
    .returning({ id: datasetAccessGrantsTable.id });
  // Lost the swap: another caller owns the mail.
  if (!swapped) return { kind: "activated", grantId: grant.id };
  return deliverWelcome(deps, { id: grant.id, email: grant.email }, fresh, checkout.id);
}

/**
 * A stored 'refuse' decision (the address already holds a live commercial grant from another subscription): no
 * grant, and NO money movement. The maintainer is alerted (deduped by the gate: once per checkout, however
 * many retries) with the new subscription, the existing grant and what to do by hand. A failed alert throws,
 * so a redelivery tells them eventually.
 */
async function replayDuplicate(deps: ResolvedDeps, checkout: CheckoutRow, sub: PayPalSubscription): Promise<ActivationOutcome> {
  await sendAlert(
    deps,
    {
      reason: "duplicate_subscription",
      action: "no_grant_created",
      subscriptionId: sub.id,
      checkoutId: checkout.id,
      saleId: deps.saleId ?? null,
      grantId: checkout.conflictGrantId,
    },
    // Per SALE when a payment triggered this (each charge on a duplicate subscription is a fresh alert); else per checkout.
    deps.saleId ?? checkout.id
  );
  return { kind: "refused", reason: "duplicate_subscription" };
}

const stringField = (resource: Record<string, unknown> | undefined, key: string): string | null => {
  const value = resource?.[key];
  return typeof value === "string" && value ? value : null;
};

async function commercialGrantBySubscription(db: CommercialDb, subscriptionId: string) {
  const [grant] = await db
    .select({ id: datasetAccessGrantsTable.id, status: datasetAccessGrantsTable.status, lastPaymentAt: datasetAccessGrantsTable.lastPaymentAt })
    .from(datasetAccessGrantsTable)
    .where(and(eq(datasetAccessGrantsTable.paypalSubscriptionId, subscriptionId), eq(datasetAccessGrantsTable.tier, "commercial")))
    .limit(1);
  return grant;
}

/**
 * Processes one VERIFIED PayPal webhook event (the route verifies the signature first). Idempotent via
 * `paypal_webhook_events`: a delivery already processed is `duplicate`; one recorded but never finished (an
 * earlier attempt threw) runs again, and every write below tolerates that. `processedAt` is set only after the
 * work succeeded, so a throw makes PayPal redeliver.
 *
 * Subscribed events: BILLING.SUBSCRIPTION.ACTIVATED, PAYMENT.SALE.COMPLETED, BILLING.SUBSCRIPTION.CANCELLED /
 * EXPIRED / SUSPENDED, PAYMENT.SALE.REFUNDED / REVERSED, BILLING.SUBSCRIPTION.PAYMENT.FAILED. A cancel, expiry
 * or suspension writes nothing: access simply runs to `paid_through`.
 */
export async function processPaypalEvent(
  event: PayPalWebhookEvent,
  rawDeps: CommercialActivationDeps = {}
): Promise<PaypalEventOutcome> {
  const deps = resolveDeps(rawDeps);
  const { db } = deps;

  const [inserted] = await db
    .insert(paypalWebhookEventsTable)
    .values({ id: event.id, eventType: event.event_type })
    .onConflictDoNothing()
    .returning({ id: paypalWebhookEventsTable.id });
  if (!inserted) {
    const [existing] = await db
      .select({ processedAt: paypalWebhookEventsTable.processedAt })
      .from(paypalWebhookEventsTable)
      .where(eq(paypalWebhookEventsTable.id, event.id))
      .limit(1);
    if (existing?.processedAt) return { kind: "duplicate" };
  }

  const { outcome, grantId } = await resolveEvent(event, deps);
  await db
    .update(paypalWebhookEventsTable)
    .set({ processedAt: deps.now, ...(grantId ? { grantId } : {}) })
    .where(eq(paypalWebhookEventsTable.id, event.id));
  return outcome;
}

async function resolveEvent(
  event: PayPalWebhookEvent,
  deps: ResolvedDeps
): Promise<{ outcome: Exclude<PaypalEventOutcome, { kind: "duplicate" }>; grantId?: string | null }> {
  const { db } = deps;
  const resource = event.resource;
  const validSubscriptionId = (id: string | null): id is string => id !== null && SUBSCRIPTION_ID_RE.test(id);

  switch (event.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": {
      const id = stringField(resource, "id");
      if (!validSubscriptionId(id)) return { outcome: { kind: "ignored", reason: "no subscription id" } };
      const outcome = await activateFromPayPal(id, deps);
      return { outcome: { kind: "activation", outcome }, grantId: outcome.kind === "activated" ? outcome.grantId : null };
    }
    case "PAYMENT.SALE.COMPLETED": {
      const id = stringField(resource, "billing_agreement_id");
      if (!validSubscriptionId(id)) return { outcome: { kind: "ignored", reason: "sale has no subscription" } };
      const saleId = stringField(resource, "id");
      const grant = await commercialGrantBySubscription(db, id);
      if (!grant) {
        const outcome = await activateFromPayPal(id, { ...deps, saleId });
        return { outcome: { kind: "activation", outcome }, grantId: outcome.kind === "activated" ? outcome.grantId : null };
      }
      const sub = await getSubscription(id);
      if (grant.status === "revoked") {
        // The revoke action should have cancelled billing; never extend, tell the maintainer (once per sale).
        await sendAlert(
          deps,
          { reason: "revoked_still_billing", action: "none", subscriptionId: id, checkoutId: null, saleId, grantId: grant.id },
          saleId ?? id
        );
        return { outcome: { kind: "alerted", reason: "revoked_still_billing" }, grantId: grant.id };
      }
      // Status, plan and payment come from the re-fetched subscription, never the (possibly stale) event body.
      const [checkout] = await db
        .select({ plan: commercialCheckoutsTable.plan })
        .from(commercialCheckoutsTable)
        .where(eq(commercialCheckoutsTable.paypalSubscriptionId, id))
        .limit(1);
      const extension = checkout ? verifiedExtension(sub, checkout.plan, grant.lastPaymentAt, deps.now) : null;
      const extended = extension ? await extendPaidThrough(db, grant.id, id, extension) : false;
      return { outcome: { kind: "renewal", grantId: grant.id, extended }, grantId: grant.id };
    }
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
      return { outcome: { kind: "no_change", reason: "access runs to paid_through" } };
    case "PAYMENT.SALE.REFUNDED":
    case "PAYMENT.SALE.REVERSED": {
      const saleId = event.event_type === "PAYMENT.SALE.REVERSED" ? stringField(resource, "id") : (stringField(resource, "sale_id") ?? stringField(resource, "id"));
      // Nothing here refunds, so every refund or reversal is the maintainer's to weigh (access runs to paid_through).
      const subscriptionId = stringField(resource, "billing_agreement_id");
      await sendAlert(
        deps,
        { reason: "payment_reversed", action: "no_action_person_decides", subscriptionId, checkoutId: null, saleId },
        event.id
      );
      return { outcome: { kind: "alerted", reason: "payment_reversed" } };
    }
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      console.warn("commercial subscription payment failed event received");
      return { outcome: { kind: "no_change", reason: "payment failed; access runs to paid_through" } };
    default:
      return { outcome: { kind: "ignored", reason: "unhandled event type" } };
  }
}
