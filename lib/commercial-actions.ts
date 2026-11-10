import type Stripe from "stripe";

import type { StripeEventOutcome } from "@/lib/commercial-grants";
import type { CommercialAlertAction, CommercialAlertReason } from "@/lib/dataset-email-templates";
import { redactedErrorCode } from "@/lib/db-error";
import { sendDatasetCommercialAlertEmail, sendDatasetSubscriptionActiveEmail, type SendOutcome } from "@/lib/email";
import { sendDatasetCommercialAlertGated, sendGrantGated, type GateResult } from "@/lib/email-gate";
import type { EmailSendsDb } from "@/lib/email-sends";

/**
 * The `beforeComplete` executor for `processStripeEvent` (lib/commercial-grants.ts): the side effects of a
 * webhook outcome. It runs after the DB work and BEFORE the event is marked processed, so every failure that
 * must be retried THROWS (the route answers 500 and Stripe redelivers) and every step is safe to repeat.
 *
 * Retry safety: Stripe calls carry idempotency keys derived from the checkout session / subscription id; the
 * welcome mail is at-least-once because `email_sends` is only an accountability log (a `failed` or
 * `attempted` earlier row never blocks the next send; see `recordSendAttempt`), and the activation retry mints
 * a NEW token each time, so the retry's mail always carries a link that works; the maintainer alert is deduped by
 * its gate (one `sent` row per reason + Stripe id).
 *
 * Auto cancel/refund touches ONLY ids named by the outcome as belonging to the signed session
 * (`newSubscriptionId`, `invoiceId`) or to the revoked grant itself (`subscriptionId` of
 * `revoked_still_billing`). `existingSubscriptionId` is never passed to Stripe.
 *
 * Never logs a token, an address or an outcome object.
 */

export type CommercialStripe = Pick<Stripe, "subscriptions" | "refunds" | "invoicePayments">;

interface AlertMailInput {
  reason: CommercialAlertReason;
  action: CommercialAlertAction;
  subscriptionId: string | null;
  sessionId: string | null;
  invoiceId: string | null;
  grantId?: string | null;
}

/** Test seam: the two real senders. Each is called only inside its gate's callback. */
export interface CommercialMailers {
  subscriptionActive: (input: { email: string; accessToken: string }) => Promise<SendOutcome>;
  alert: (input: AlertMailInput) => Promise<SendOutcome>;
}

export interface CommercialSideEffectsDeps {
  db: EmailSendsDb;
  stripe: CommercialStripe;
  sendMail?: CommercialMailers;
}

type BeforeCompleteOutcome = Exclude<StripeEventOutcome, { kind: "duplicate" }>;
type Conflict = Extract<BeforeCompleteOutcome, { kind: "conflict" }>;

const stripeErrorCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;

/** Cancels at Stripe; an already-canceled subscription counts as done (checked by reading it back). */
async function cancelSubscription(stripe: CommercialStripe, id: string, idempotencyKey: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(id, {}, { idempotencyKey });
  } catch (err) {
    const current = await stripe.subscriptions.retrieve(id).catch(() => null);
    if (current?.status === "canceled") return;
    throw err;
  }
}

const idOf = (ref: string | { id: string } | null | undefined): string | null =>
  typeof ref === "string" ? ref : (ref?.id ?? null);

/** Reads every page of the invoice's paid payments (a page is at most 10 by default). */
async function listPaidPayments(stripe: CommercialStripe, invoiceId: string) {
  const all: Stripe.InvoicePayment[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoicePayments.list({
      invoice: invoiceId,
      status: "paid",
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    all.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (!page.has_more || !last) return all;
    startingAfter = last.id;
  }
}

/**
 * Refunds every distinct payment intent (else charge) behind the session's invoice, once each, however many
 * paid payments point at it. `refunded`: all done (an "already refunded" error counts); `none`: nothing
 * refundable was found AND nothing was due (`amountTotal` is 0); `unidentified`: money was paid (or is due per
 * `amountTotal`) but at least one payment had no payment intent / charge, or no payment could be found at all,
 * which the maintainer must see. The other payments are still refunded.
 */
async function refundInvoice(
  stripe: CommercialStripe,
  invoiceId: string | null,
  sessionId: string,
  amountTotal: number
): Promise<"refunded" | "none" | "unidentified"> {
  const payments = invoiceId ? await listPaidPayments(stripe, invoiceId) : [];
  const paid = payments.filter((p) => idOf(p.invoice) === invoiceId && (p.amount_paid ?? 0) > 0);
  if (paid.length === 0) return amountTotal > 0 ? "unidentified" : "none";

  let unidentified = false;
  const targets = new Map<string, { payment_intent: string } | { charge: string }>();
  for (const p of paid) {
    const paymentIntent = idOf(p.payment.payment_intent);
    const charge = idOf(p.payment.charge);
    if (paymentIntent) targets.set(paymentIntent, { payment_intent: paymentIntent });
    else if (charge) targets.set(charge, { charge });
    else unidentified = true;
  }
  for (const [id, target] of targets) {
    try {
      await stripe.refunds.create(target, { idempotencyKey: `ca-refund-${sessionId}-${id}` });
    } catch (err) {
      if (stripeErrorCode(err) !== "charge_already_refunded") throw err;
    }
  }
  return unidentified ? "unidentified" : "refunded";
}

export function makeCommercialSideEffects(
  deps: CommercialSideEffectsDeps
): (outcome: BeforeCompleteOutcome) => Promise<void> {
  const { db, stripe, sendMail } = deps;

  /**
   * Returns once the alert is out (or was out before); throws otherwise so Stripe redelivers until the
   * maintainer has been told. A missing CONTACT_TO_EMAIL is a `gate_error`, so it throws too.
   */
  async function alert(
    reason: CommercialAlertReason,
    action: CommercialAlertAction,
    ids: { subscriptionId: string | null; sessionId: string | null; invoiceId: string | null; grantId?: string | null },
    targetId: string
  ): Promise<void> {
    const args: AlertMailInput = { reason, action, ...ids };
    let result: GateResult;
    try {
      result = await sendDatasetCommercialAlertGated(
        db,
        { recipient: (process.env.CONTACT_TO_EMAIL ?? "").trim(), reason, targetId },
        () => (sendMail ? sendMail.alert(args) : sendDatasetCommercialAlertEmail(args))
      );
    } catch (err) {
      result = { sent: false, disposition: "gate_error" };
      console.warn(`commercial alert failed (${redactedErrorCode(err)})`);
    }
    if (result.sent || result.disposition === "skipped_duplicate") return;
    throw new Error(`commercial alert not sent (${result.disposition})`);
  }

  // Every alert is REQUIRED: cancel and refund are idempotent, so a throw lets Stripe redeliver
  // until the maintainer has actually been told.
  async function handleConflict(outcome: Conflict): Promise<void> {
    switch (outcome.reason) {
      case "already_subscribed":
      case "revoked_buyer": {
        await cancelSubscription(stripe, outcome.newSubscriptionId, `ca-cancel-${outcome.sessionId}`);
        const refund = await refundInvoice(stripe, outcome.invoiceId, outcome.sessionId, outcome.amountTotal);
        const action: CommercialAlertAction =
          refund === "refunded" ? "cancelled_and_refunded" : refund === "unidentified" ? "cancelled_refund_needed" : "cancelled";
        await alert(
          outcome.reason,
          action,
          {
            subscriptionId: outcome.newSubscriptionId,
            sessionId: outcome.sessionId,
            invoiceId: outcome.invoiceId,
            grantId: outcome.grantId,
          },
          outcome.sessionId
        );
        return;
      }
      case "revoked_still_billing":
        await cancelSubscription(stripe, outcome.subscriptionId, `ca-cancel-revoked-${outcome.subscriptionId}`);
        await alert(
          outcome.reason,
          "cancelled",
          { subscriptionId: outcome.subscriptionId, sessionId: null, invoiceId: null },
          outcome.subscriptionId
        );
        return;
      case "orphaned_subscription":
        await alert(
          outcome.reason,
          "none",
          { subscriptionId: outcome.subscriptionId, sessionId: null, invoiceId: null },
          outcome.subscriptionId
        );
        return;
      case "superseded_session":
        // No cancel, no refund: the session was already approved for activation, so a person decides.
        await alert(
          outcome.reason,
          "no_action_person_decides",
          { subscriptionId: outcome.subscriptionId, sessionId: outcome.sessionId, invoiceId: null, grantId: outcome.grantId },
          outcome.sessionId
        );
        return;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  return async (outcome) => {
    switch (outcome.kind) {
      case "activated": {
        const { mail } = outcome;
        const result = await sendGrantGated(
          db,
          { kind: "dataset_subscription_active", grantId: mail.grantId, email: mail.email },
          () =>
            sendMail
              ? sendMail.subscriptionActive({ email: mail.email, accessToken: mail.accessToken })
              : sendDatasetSubscriptionActiveEmail({ email: mail.email, accessToken: mail.accessToken })
        );
        if (result.sent) return;
        // Terminal: a retry would skip the same way, so tell the maintainer and let Stripe stop redelivering.
        if (result.disposition === "skipped_suppressed" || result.disposition === "skipped_unconfirmed") {
          await alert(
            "welcome_mail_undeliverable",
            result.disposition === "skipped_suppressed" ? "link_not_mailed_suppressed" : "link_not_mailed_unconfirmed",
            { subscriptionId: null, sessionId: outcome.sessionId, invoiceId: null, grantId: mail.grantId },
            `${mail.grantId}:${outcome.sessionId}`
          );
          return;
        }
        throw new Error(`subscription active mail not sent (${result.disposition})`);
      }
      case "conflict":
        await handleConflict(outcome);
        return;
      case "updated":
      case "ignored":
        return;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  };
}
