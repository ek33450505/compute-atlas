// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const paypal = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  listSubscriptionTransactions: vi.fn(),
  refundSale: vi.fn(),
}));
vi.mock("@/lib/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal")>()),
  ...paypal,
  allowedCommercialPlanIds: () => new Set(["P-MONTH", "P-YEAR"]),
  planForPlanId: (id: string) => (id === "P-MONTH" ? "monthly" : id === "P-YEAR" ? "annual" : null),
}));

import { activateFromPayPal, processPaypalEvent, type CommercialMailers } from "@/lib/commercial-activation";
import {
  commercialCheckoutsTable,
  datasetAccessGrantsTable,
  emailSendsTable,
  paypalWebhookEventsTable,
} from "@/lib/db/schema";
import type { PayPalSubscription, PayPalWebhookEvent } from "@/lib/paypal";
import { hashToken } from "@/lib/token-hash";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
});
afterAll(async () => {
  await tdb.client.close();
});

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);
const SUB = "I-ABC123456";

let mails: Array<{ email: string; accessToken: string }>;
let alerts: Array<{ reason: string; action: string; saleId: string | null }>;
let mailFails: boolean;
let sendMail: CommercialMailers;

afterEach(() => {
  // Activation never moves money, whatever the test did.
  expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  expect(paypal.refundSale).not.toHaveBeenCalled();
  expect(paypal.listSubscriptionTransactions).not.toHaveBeenCalled();
});

beforeEach(async () => {
  await tdb.reset();
  process.env.CONTACT_TO_EMAIL = "ed@example.com";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(paypal)) fn.mockReset();
  mails = [];
  alerts = [];
  mailFails = false;
  sendMail = {
    subscriptionActive: async (input) => {
      if (mailFails) return { sent: false, errorCode: "boom" };
      mails.push(input);
      return { sent: true, resendId: "r" };
    },
    alert: async (input) => {
      alerts.push({ reason: input.reason, action: input.action, saleId: input.saleId });
      return { sent: true, resendId: "r" };
    },
  };
});

const deps = () => ({ db: tdb.db, now: NOW, sendMail });

function paypalSub(overrides: Partial<PayPalSubscription> = {}): PayPalSubscription {
  return {
    id: SUB,
    status: "ACTIVE",
    planId: "P-MONTH",
    customId: null,
    payerId: "PAYER1",
    payerEmail: "payer@example.com",
    startTime: NOW.toISOString(),
    nextBillingTime: inDays(30).toISOString(),
    lastPayment: { amount: "150.0", currency: "USD", time: NOW.toISOString() },
    ...overrides,
  };
}

async function makeCheckout(overrides: Partial<typeof commercialCheckoutsTable.$inferInsert> = {}) {
  const [row] = await tdb.db
    .insert(commercialCheckoutsTable)
    .values({ plan: "monthly", email: "buyer@example.com", name: "Buyer", organization: "Acme", termsVersion: "2026-11-10", ...overrides })
    .returning();
  return row;
}

/** Makes PayPal report the given subscription (default: ACTIVE, linked to the checkout). */
function pay(checkoutId: string, overrides: Partial<PayPalSubscription> = {}) {
  const sub = paypalSub({ customId: checkoutId, ...overrides });
  paypal.getSubscription.mockResolvedValue(sub);
  return sub;
}

const grants = () => tdb.db.select().from(datasetAccessGrantsTable);
const checkoutOf = async (id: string) =>
  (await tdb.db.select().from(commercialCheckoutsTable).where(eq(commercialCheckoutsTable.id, id)))[0];

let seq = 0;
async function insertGrant(overrides: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  seq++;
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `other-${seq}@example.com`,
      name: "Other",
      category: "commercial",
      intendedUse: "x",
      attributionAckAt: NOW,
      termsVersion: "2026-11-10",
      verifyTokenHash: `verify-${seq}`,
      tier: "commercial",
      status: "active",
      expiresAt: inDays(30),
      paidThrough: inDays(30),
      paypalSubscriptionId: `I-OTHER${seq}00`,
      ...overrides,
    })
    .returning();
  return row;
}

describe("activateFromPayPal", () => {
  it("activates: one grant, decision stored, welcome mail carries a working token", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const out = await activateFromPayPal(SUB, deps());
    const [grant] = await grants();
    expect(out).toEqual({ kind: "activated", grantId: grant.id });
    expect(grant).toMatchObject({
      tier: "commercial",
      status: "active",
      email: "buyer@example.com",
      name: "Buyer",
      organization: "Acme",
      paypalSubscriptionId: SUB,
    });
    expect(grant.paidThrough?.toISOString()).toBe(inDays(30).toISOString());
    expect(grant.expiresAt?.toISOString()).toBe(inDays(30).toISOString());
    const stored = await checkoutOf(co.id);
    expect(stored).toMatchObject({ decision: "activate", grantId: grant.id, paypalSubscriptionId: SUB });
    expect(mails).toHaveLength(1);
    expect(grant.accessTokenHash).toBe(hashToken(mails[0].accessToken));
  });

  it("replays an activation (return route and webhook both arrive): still one grant, one mail", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const first = await activateFromPayPal(SUB, deps());
    const second = await activateFromPayPal(SUB, deps());
    expect(second).toEqual(first);
    expect(await grants()).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect((await grants())[0].accessTokenHash).toBe(hashToken(mails[0].accessToken));
  });

  it("two parallel activations write exactly one grant and one decision", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const results = await Promise.all([activateFromPayPal(SUB, deps()), activateFromPayPal(SUB, deps())]);
    expect(results.every((r) => r.kind === "activated")).toBe(true);
    expect(await grants()).toHaveLength(1);
    const stored = await checkoutOf(co.id);
    expect(stored.decision).toBe("activate");
    expect(stored.grantId).toBe((await grants())[0].id);
    // The loser may find the winner's mail not yet recorded and swap the token once more, so one or two mails
    // go out; what must hold is that EXACTLY ONE mailed token is the live one (a working link reached the buyer).
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails.length).toBeLessThanOrEqual(2);
    const live = (await grants())[0].accessTokenHash;
    expect(mails.filter((m) => hashToken(m.accessToken) === live)).toHaveLength(1);
  });

  it("a mail failure throws, and the retry mints a fresh token and mails again", async () => {
    const co = await makeCheckout();
    pay(co.id);
    mailFails = true;
    await expect(activateFromPayPal(SUB, deps())).rejects.toThrow(/mail not sent/);
    expect(await grants()).toHaveLength(1);
    mailFails = false;
    const out = await activateFromPayPal(SUB, deps());
    expect(out.kind).toBe("activated");
    expect(await grants()).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect((await grants())[0].accessTokenHash).toBe(hashToken(mails[0].accessToken));
  });

  it("reports pending and writes nothing when the subscription is not ACTIVE", async () => {
    const co = await makeCheckout();
    pay(co.id, { status: "APPROVED" });
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "pending", status: "APPROVED" });
    expect(await grants()).toHaveLength(0);
    expect((await checkoutOf(co.id)).decision).toBeNull();
    expect((await checkoutOf(co.id)).paypalSubscriptionId).toBeNull();
  });

  it("reports pending when ACTIVE but no payment is recorded yet", async () => {
    const co = await makeCheckout();
    pay(co.id, { lastPayment: null });
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "pending", status: "ACTIVE" });
    expect((await checkoutOf(co.id)).decision).toBeNull();
  });

  it("ignores and alerts (once) for a plan outside the allowlist", async () => {
    const co = await makeCheckout();
    pay(co.id, { planId: "P-OTHER" });
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "ignored", reason: "plan not allowed" });
    await activateFromPayPal(SUB, deps());
    expect(await grants()).toHaveLength(0);
    expect(alerts).toEqual([{ reason: "unmatched_subscription", action: "none", saleId: null }]);
  });

  it.each([
    ["no custom id", null],
    ["a non-uuid custom id", "not-a-uuid"],
    ["an unknown checkout", "11111111-1111-4111-8111-111111111111"],
  ])("ignores and alerts for %s", async (_name, customId) => {
    paypal.getSubscription.mockResolvedValue(paypalSub({ customId }));
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("ignored");
    expect(alerts).toHaveLength(1);
    expect(await grants()).toHaveLength(0);
  });

  it("ignores a subscription bound to a different checkout", async () => {
    const co = await makeCheckout({ paypalSubscriptionId: "I-DIFFERENT1" });
    pay(co.id);
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
  });

  it.each([
    ["a wrong amount", { lastPayment: { amount: "1.00", currency: "USD", time: NOW.toISOString() } }],
    ["a zero amount", { lastPayment: { amount: "0.00", currency: "USD", time: NOW.toISOString() } }],
    ["a wrong currency", { lastPayment: { amount: "150.00", currency: "EUR", time: NOW.toISOString() } }],
    ["a plan that differs from the checkout", { planId: "P-YEAR" }],
  ])("ignores %s", async (_name, overrides) => {
    const co = await makeCheckout();
    pay(co.id, overrides);
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
    expect((await checkoutOf(co.id)).decision).toBeNull();
  });

  it("accepts the amount as either decimal spelling", async () => {
    const co = await makeCheckout();
    pay(co.id, { lastPayment: { amount: "150.00", currency: "USD", time: NOW.toISOString() } });
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("activated");
  });

  it("upgrades a lapsed open commercial row instead of inserting a second one", async () => {
    const lapsed = await insertGrant({ email: "buyer@example.com", paidThrough: inDays(-5), expiresAt: inDays(-5) });
    const co = await makeCheckout();
    pay(co.id);
    const out = await activateFromPayPal(SUB, deps());
    expect(out).toEqual({ kind: "activated", grantId: lapsed.id });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paypalSubscriptionId: SUB, status: "active" });
  });

  it("never touches a free grant for the same address", async () => {
    const free = await insertGrant({ email: "buyer@example.com", tier: "free", paypalSubscriptionId: null, paidThrough: null, status: "pending_review" });
    const co = await makeCheckout();
    pay(co.id);
    await activateFromPayPal(SUB, deps());
    const rows = await grants();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === free.id)).toMatchObject({ status: "pending_review", tier: "free", accessTokenHash: null });
  });
});

describe("duplicate subscription", () => {
  it("writes no grant, claims a 'refuse' decision, alerts once across retries, and never moves money", async () => {
    const existing = await insertGrant({ email: "buyer@example.com" });
    const co = await makeCheckout();
    pay(co.id);
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "refused", reason: "duplicate_subscription" });
    expect(await grants()).toHaveLength(1);
    expect(mails).toHaveLength(0);
    expect(await checkoutOf(co.id)).toMatchObject({
      decision: "refuse",
      reason: "duplicate_subscription",
      conflictGrantId: existing.id,
      paypalSubscriptionId: SUB,
    });
    // Retries (webhook after the return route), whatever PayPal reports now.
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "refused", reason: "duplicate_subscription" });
    pay(co.id, { status: "CANCELLED" });
    expect(await activateFromPayPal(SUB, deps())).toEqual({ kind: "refused", reason: "duplicate_subscription" });
    expect(alerts).toEqual([{ reason: "duplicate_subscription", action: "no_grant_created", saleId: null }]);
  });

  it("throws (so PayPal redelivers) when the maintainer alert cannot be sent, and alerts on the retry", async () => {
    await insertGrant({ email: "buyer@example.com" });
    const co = await makeCheckout();
    pay(co.id);
    const working = sendMail.alert;
    sendMail.alert = async () => ({ sent: false, errorCode: "boom" });
    await expect(activateFromPayPal(SUB, deps())).rejects.toThrow(/alert not sent/);
    sendMail.alert = working;
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("refused");
    expect(alerts).toHaveLength(1);
  });

  it("a revoked commercial grant does not block a new purchase", async () => {
    await insertGrant({ email: "buyer@example.com", status: "revoked", revokedAt: NOW });
    const co = await makeCheckout();
    pay(co.id);
    expect((await activateFromPayPal(SUB, deps())).kind).toBe("activated");
    expect(await grants()).toHaveLength(2);
  });

  it("two parallel first-time checkouts for one address: one activates, the other is a duplicate", async () => {
    const a = await makeCheckout();
    const b = await makeCheckout();
    paypal.getSubscription.mockImplementation(async (id: string) =>
      id === SUB ? paypalSub({ customId: a.id }) : paypalSub({ id, customId: b.id, payerId: "PAYER2" })
    );
    const results = await Promise.all([activateFromPayPal(SUB, deps()), activateFromPayPal("I-SECOND123", deps())]);
    expect(results.map((r) => r.kind).sort()).toEqual(["activated", "refused"]);
    expect(await grants()).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });
});

function event(type: string, resource: Record<string, unknown>, id = `WH-${type}-${Math.random()}`): PayPalWebhookEvent {
  return { id, event_type: type, resource };
}

describe("processPaypalEvent", () => {
  async function activated() {
    const co = await makeCheckout();
    pay(co.id);
    await activateFromPayPal(SUB, deps());
    return { co, grant: (await grants())[0] };
  }

  it("ACTIVATED activates and marks the event processed", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const ev = event("BILLING.SUBSCRIPTION.ACTIVATED", { id: SUB }, "WH-1");
    const out = await processPaypalEvent(ev, deps());
    expect(out).toMatchObject({ kind: "activation", outcome: { kind: "activated" } });
    const [row] = await tdb.db.select().from(paypalWebhookEventsTable).where(eq(paypalWebhookEventsTable.id, "WH-1"));
    expect(row.processedAt).not.toBeNull();
    expect(row.grantId).toBe((await grants())[0].id);
  });

  it("a duplicate event id is a no-op", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const ev = event("BILLING.SUBSCRIPTION.ACTIVATED", { id: SUB }, "WH-2");
    await processPaypalEvent(ev, deps());
    paypal.getSubscription.mockClear();
    expect(await processPaypalEvent(ev, deps())).toEqual({ kind: "duplicate" });
    expect(paypal.getSubscription).not.toHaveBeenCalled();
  });

  it("an event whose handling threw stays unprocessed and is reprocessed on redelivery", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const ev = event("BILLING.SUBSCRIPTION.ACTIVATED", { id: SUB }, "WH-3");
    mailFails = true;
    await expect(processPaypalEvent(ev, deps())).rejects.toThrow();
    const [row] = await tdb.db.select().from(paypalWebhookEventsTable).where(eq(paypalWebhookEventsTable.id, "WH-3"));
    expect(row.processedAt).toBeNull();
    mailFails = false;
    expect((await processPaypalEvent(ev, deps())).kind).toBe("activation");
    expect(mails).toHaveLength(1);
    expect(await grants()).toHaveLength(1);
  });

  const atDay = (days: number) => ({ ...deps(), now: inDays(days) });
  const payment = (days: number, amount = "150.00", currency = "USD") => ({
    amount,
    currency,
    time: inDays(days).toISOString(),
  });
  const saleEvent = (id: string) => event("PAYMENT.SALE.COMPLETED", { id, billing_agreement_id: SUB });

  it("a verified renewal sale extends paid_through, and a stale one never shortens it", async () => {
    const { co, grant } = await activated();
    const renewed = inDays(60);
    pay(co.id, { nextBillingTime: renewed.toISOString(), lastPayment: payment(30) });
    expect(await processPaypalEvent(saleEvent("SALE2"), atDay(30))).toEqual({ kind: "renewal", grantId: grant.id, extended: true });
    let [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(renewed.toISOString());
    expect(g.expiresAt?.toISOString()).toBe(renewed.toISOString());

    pay(co.id, { nextBillingTime: inDays(30).toISOString(), lastPayment: payment(30) }); // out-of-order: an older period end
    await processPaypalEvent(saleEvent("SALE3"), atDay(30));
    [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(renewed.toISOString());
    expect(g.expiresAt?.toISOString()).toBe(renewed.toISOString());
  });

  it.each([
    ["no payment recorded", { lastPayment: null }],
    ["a stale payment (before the previous period)", { lastPayment: payment(-10) }],
    ["a wrong amount", { lastPayment: payment(30, "1.00") }],
    ["a wrong currency", { lastPayment: payment(30, "150.00", "EUR") }],
    ["a plan that is not the grant's", { planId: "P-YEAR", lastPayment: payment(30) }],
    ["a plan outside the allowlist", { planId: "P-OTHER", lastPayment: payment(30) }],
  ] as Array<[string, Partial<PayPalSubscription>]>)("an ACTIVE subscription with %s does not extend", async (_name, overrides) => {
    const { co, grant } = await activated();
    pay(co.id, { nextBillingTime: inDays(60).toISOString(), ...overrides });
    expect(await processPaypalEvent(saleEvent("SALE9"), atDay(30))).toEqual({ kind: "renewal", grantId: grant.id, extended: false });
    // The return-route replay path obeys the same rule.
    await activateFromPayPal(SUB, atDay(30));
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(30).toISOString());
  });

  it("timeline: a day-31 replay of the day-0 payment does not extend; the genuine day-30 payment does, once", async () => {
    const { co } = await activated();
    expect((await grants())[0].lastPaymentAt?.toISOString()).toBe(NOW.toISOString());

    // Day 31: the renewal failed, PayPal still reports ACTIVE with a moved next_billing_time and the day-0 payment.
    pay(co.id, { nextBillingTime: inDays(61).toISOString(), lastPayment: payment(0) });
    expect(await processPaypalEvent(saleEvent("SALE-R1"), atDay(31))).toMatchObject({ kind: "renewal", extended: false });
    await activateFromPayPal(SUB, atDay(31));
    let [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(inDays(30).toISOString());
    expect(g.lastPaymentAt?.toISOString()).toBe(NOW.toISOString());

    // A genuine payment (made on day 30) arrives.
    pay(co.id, { nextBillingTime: inDays(60).toISOString(), lastPayment: payment(30) });
    expect(await processPaypalEvent(saleEvent("SALE-R2"), atDay(31))).toMatchObject({ kind: "renewal", extended: true });
    [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(inDays(60).toISOString());
    expect(g.lastPaymentAt?.toISOString()).toBe(inDays(30).toISOString());

    // Redelivery and the return-route replay of that same payment extend nothing more.
    pay(co.id, { nextBillingTime: inDays(90).toISOString(), lastPayment: payment(30) });
    expect(await processPaypalEvent(saleEvent("SALE-R3"), atDay(32))).toMatchObject({ extended: false });
    await activateFromPayPal(SUB, atDay(32));
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(60).toISOString());
  });

  it("the same payment delivered twice concurrently extends exactly once", async () => {
    const { co } = await activated();
    pay(co.id, { nextBillingTime: inDays(60).toISOString(), lastPayment: payment(30) });
    const outcomes = await Promise.all([
      processPaypalEvent(saleEvent("SALE-C1"), atDay(31)),
      processPaypalEvent(saleEvent("SALE-C2"), atDay(31)),
    ]);
    expect(outcomes.filter((o) => o.kind === "renewal" && o.extended)).toHaveLength(1);
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(60).toISOString());
  });

  it("a payment of an older subscription never extends a grant since bound to a newer one", async () => {
    const SUB_B = "I-BBB123456";
    const { co: coA, grant } = await activated(); // subscription A; paid through day 30
    const coB = await makeCheckout();
    const subA = (days: number, next: number) =>
      paypalSub({ customId: coA.id, nextBillingTime: inDays(next).toISOString(), lastPayment: payment(days) });
    const subB = (days: number, next: number) =>
      paypalSub({ id: SUB_B, customId: coB.id, nextBillingTime: inDays(next).toISOString(), lastPayment: payment(days) });
    let days = 40;
    paypal.getSubscription.mockImplementation(async (id: string) =>
      id === SUB_B ? subB(days, days + 30) : subA(days, days + 30)
    );

    // Day 40: the grant has lapsed; the new subscription B upgrades it in place.
    expect(await activateFromPayPal(SUB_B, atDay(40))).toEqual({ kind: "activated", grantId: grant.id });
    let [g] = await grants();
    expect(g).toMatchObject({ paypalSubscriptionId: SUB_B });
    expect(g.paidThrough?.toISOString()).toBe(inDays(70).toISOString());
    expect(g.lastPaymentAt?.toISOString()).toBe(inDays(40).toISOString());

    // Day 41: old subscription A still bills and reports a NEWER payment: it credits nothing.
    days = 41;
    // No grant is bound to A any more, so the sale replays A's activation: nothing is credited.
    expect(await processPaypalEvent(saleEvent("SALE-A1"), atDay(41))).toMatchObject({ kind: "activation" });
    await activateFromPayPal(SUB, atDay(41));
    [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(inDays(70).toISOString());
    expect(g.lastPaymentAt?.toISOString()).toBe(inDays(40).toISOString());

    // B's own newer payment still extends.
    days = 42;
    const saleB: PayPalWebhookEvent = {
      id: "WH-B1",
      event_type: "PAYMENT.SALE.COMPLETED",
      resource: { id: "SALE-B1", billing_agreement_id: SUB_B },
    };
    expect(await processPaypalEvent(saleB, atDay(42))).toMatchObject({ kind: "renewal", extended: true });
    [g] = await grants();
    expect(g.paidThrough?.toISOString()).toBe(inDays(72).toISOString());
    expect(g.lastPaymentAt?.toISOString()).toBe(inDays(42).toISOString());
  });

  it("a grant with no last_payment_at is never extended", async () => {
    const { co, grant } = await activated();
    await tdb.db.update(datasetAccessGrantsTable).set({ lastPaymentAt: null }).where(eq(datasetAccessGrantsTable.id, grant.id));
    pay(co.id, { nextBillingTime: inDays(60).toISOString(), lastPayment: payment(30) });
    expect(await processPaypalEvent(saleEvent("SALE-N1"), atDay(31))).toMatchObject({ extended: false });
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(30).toISOString());
  });

  it("caps paid_through at now + one plan interval + 7 days", async () => {
    const { co } = await activated();
    pay(co.id, { nextBillingTime: inDays(500).toISOString(), lastPayment: payment(30) });
    await processPaypalEvent(saleEvent("SALE10"), atDay(30));
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(30 + 31 + 7).toISOString());
  });

  it("caps the first activation too", async () => {
    const co = await makeCheckout();
    pay(co.id, { nextBillingTime: inDays(500).toISOString() });
    await activateFromPayPal(SUB, deps());
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(31 + 7).toISOString());
  });

  it.each(["CANCELLED", "SUSPENDED", "EXPIRED"] as const)("a sale for a %s subscription does not extend", async (status) => {
    const { co, grant } = await activated();
    pay(co.id, { status, nextBillingTime: inDays(90).toISOString() });
    const out = await processPaypalEvent(event("PAYMENT.SALE.COMPLETED", { id: "SALE4", billing_agreement_id: SUB }), deps());
    expect(out).toEqual({ kind: "renewal", grantId: grant.id, extended: false });
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(30).toISOString());
  });

  it.each(["BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.SUSPENDED"])(
    "%s writes nothing to the grant",
    async (type) => {
      const { grant } = await activated();
      const before = JSON.stringify((await grants())[0]);
      const out = await processPaypalEvent(event(type, { id: SUB }), deps());
      expect(out.kind).toBe("no_change");
      expect(JSON.stringify((await grants())[0])).toBe(before);
      expect(grant.id).toBeTruthy();
    }
  );

  it("a first-payment sale with no grant yet activates through the same path", async () => {
    const co = await makeCheckout();
    pay(co.id);
    const out = await processPaypalEvent(event("PAYMENT.SALE.COMPLETED", { id: "SALE5", billing_agreement_id: SUB }), deps());
    expect(out).toMatchObject({ kind: "activation", outcome: { kind: "activated" } });
  });

  it("a sale for a revoked grant is never extended and alerts", async () => {
    const { co, grant } = await activated();
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked", revokedAt: NOW }).where(eq(datasetAccessGrantsTable.id, grant.id));
    pay(co.id, { nextBillingTime: inDays(90).toISOString() });
    const out = await processPaypalEvent(event("PAYMENT.SALE.COMPLETED", { id: "SALE6", billing_agreement_id: SUB }), deps());
    expect(out).toEqual({ kind: "alerted", reason: "revoked_still_billing" });
    expect((await grants())[0].paidThrough?.toISOString()).toBe(inDays(30).toISOString());
  });

  it("REFUNDED / REVERSED alert the maintainer", async () => {
    expect(await processPaypalEvent(event("PAYMENT.SALE.REVERSED", { id: "SALE7" }), deps())).toEqual({ kind: "alerted", reason: "payment_reversed" });
    expect(alerts).toEqual([{ reason: "payment_reversed", action: "no_action_person_decides", saleId: "SALE7" }]);
    expect(await processPaypalEvent(event("PAYMENT.SALE.REFUNDED", { id: "REF1", sale_id: "SALE8" }), deps())).toEqual({ kind: "alerted", reason: "payment_reversed" });
    expect(alerts).toHaveLength(2);
  });

  it("payment failed and unknown events change nothing", async () => {
    expect((await processPaypalEvent(event("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: SUB }), deps())).kind).toBe("no_change");
    expect(await processPaypalEvent(event("SOMETHING.ELSE", {}), deps())).toEqual({ kind: "ignored", reason: "unhandled event type" });
    expect(paypal.getSubscription).not.toHaveBeenCalled();
  });

  it("ignores a malformed subscription id without calling PayPal", async () => {
    const out = await processPaypalEvent(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: "../x" }), deps());
    expect(out.kind).toBe("ignored");
    expect(paypal.getSubscription).not.toHaveBeenCalled();
  });
});

describe("alerts per sale", () => {
  const saleEvent = (id: string, eventId: string): PayPalWebhookEvent => ({
    id: eventId,
    event_type: "PAYMENT.SALE.COMPLETED",
    resource: { id, billing_agreement_id: SUB },
  });

  it("a duplicate subscription alerts once per sale: two sales, two alerts; the same sale redelivered, one", async () => {
    await insertGrant({ email: "buyer@example.com" });
    const co = await makeCheckout();
    pay(co.id);
    await processPaypalEvent(saleEvent("SALEA", "WH-A"), deps());
    await processPaypalEvent(saleEvent("SALEB", "WH-B"), deps());
    expect(alerts.map((a) => a.saleId)).toEqual(["SALEA", "SALEB"]);
    await processPaypalEvent(saleEvent("SALEA", "WH-A-again"), deps()); // new event id, same sale
    expect(alerts).toHaveLength(2);
  });

  it("revoked_still_billing alerts once per sale", async () => {
    const co = await makeCheckout();
    pay(co.id);
    await activateFromPayPal(SUB, deps());
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked", revokedAt: NOW });
    await processPaypalEvent(saleEvent("SALEA", "WH-A"), deps());
    await processPaypalEvent(saleEvent("SALEB", "WH-B"), deps());
    await processPaypalEvent(saleEvent("SALEA", "WH-A-again"), deps());
    expect(alerts.map((a) => `${a.reason}:${a.saleId}`)).toEqual(["revoked_still_billing:SALEA", "revoked_still_billing:SALEB"]);
  });
});

describe("welcome mail on replay", () => {
  async function failedActivation() {
    const co = await makeCheckout();
    pay(co.id);
    mailFails = true;
    await expect(activateFromPayPal(SUB, deps())).rejects.toThrow(/mail not sent/);
    mailFails = false;
    const [grant] = await grants();
    return { co, grant };
  }

  it("a FAILED send is re-minted and mailed again", async () => {
    const { grant } = await failedActivation();
    await activateFromPayPal(SUB, deps());
    expect(mails).toHaveLength(1);
    expect((await grants())[0].accessTokenHash).not.toBe(grant.accessTokenHash);
    expect((await grants())[0].accessTokenHash).toBe(hashToken(mails[0].accessToken));
  });

  it("a terminal skip (opted-out address) is not re-minted; only its alert is re-run, once", async () => {
    const { grant } = await failedActivation();
    await tdb.db.update(emailSendsTable).set({ outcome: "skipped_suppressed" }).where(eq(emailSendsTable.targetId, grant.id));
    await activateFromPayPal(SUB, deps());
    await activateFromPayPal(SUB, deps());
    expect(mails).toHaveLength(0);
    expect((await grants())[0].accessTokenHash).toBe(grant.accessTokenHash);
    expect(alerts).toEqual([{ reason: "welcome_mail_undeliverable", action: "link_not_mailed_suppressed", saleId: null }]);
  });
});
