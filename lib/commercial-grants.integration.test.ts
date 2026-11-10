// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { processStripeEvent, type CommercialDb } from "@/lib/commercial-grants";
import { liveGrant } from "@/lib/dataset-grants";
import { datasetAccessGrantsTable, stripeEventsTable } from "@/lib/db/schema";
import { hashToken } from "@/lib/token-hash";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

/** Stripe webhook processing against real Postgres (PGlite) and a canned Stripe client. */

let tdb: TestDbHandle;
const db = () => tdb.db as unknown as CommercialDb;

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

const MONTHLY = "price_monthly_test";
const ANNUAL = "price_annual_test";
const FOREIGN = "price_foreign_test";

beforeAll(async () => {
  tdb = await makeTestDb();
});
beforeEach(async () => {
  await tdb.reset();
  vi.stubEnv("STRIPE_PRICE_COMMERCIAL_MONTHLY", MONTHLY);
  vi.stubEnv("STRIPE_PRICE_COMMERCIAL_ANNUAL", ANNUAL);
  subs.clear();
  seq = 0;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await tdb.client.close();
});

let seq = 0;
const subs = new Map<string, Stripe.Subscription>();

function makeSub(
  id: string,
  opts: { price?: string; periodEnd?: Date; status?: string; endedAt?: Date | null; customer?: string; fingerprint?: string } = {}
): Stripe.Subscription {
  const sub = {
    id,
    customer: opts.customer ?? "cus_1",
    default_payment_method: opts.fingerprint ? { card: { fingerprint: opts.fingerprint } } : null,
    status: opts.status ?? "active",
    ended_at: opts.endedAt ? secs(opts.endedAt) : null,
    items: {
      data: [{ price: { id: opts.price ?? MONTHLY }, current_period_end: secs(opts.periodEnd ?? daysFromNow(30)) }],
    },
  } as unknown as Stripe.Subscription;
  subs.set(id, sub);
  return sub;
}

// Like Stripe: `default_payment_method` is only an id string unless the caller expands it.
const retrieve = vi.fn(async (id: string, params?: { expand?: string[] }) => {
  const sub = subs.get(id);
  if (!sub) throw new Error(`unknown subscription ${id}`);
  if (params?.expand?.includes("default_payment_method") || !sub.default_payment_method) return sub;
  return { ...sub, default_payment_method: "pm_unexpanded" } as unknown as Stripe.Subscription;
});
const stripe = { subscriptions: { retrieve } } as unknown as { subscriptions: Stripe["subscriptions"] };

function asEvent(type: string, object: unknown, id = `evt_${++seq}`): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

function checkoutEvent(
  over: Record<string, unknown> = {},
  opts: { id?: string; sessionId?: string; subId?: string } = {}
): Stripe.Event {
  return asEvent(
    "checkout.session.completed",
    {
      id: opts.sessionId ?? "cs_1",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 90000,
      invoice: "in_1",
      metadata: { product: "compute_atlas_commercial_dataset", termsVersion: "2026-11-09" },
      subscription: opts.subId ?? "sub_1",
      customer: "cus_1",
      customer_details: { email: "  Buyer@Example.com ", name: "Bea Buyer" },
      custom_fields: [{ key: "organization", text: { value: " Acme Corp " } }],
      ...over,
    },
    opts.id
  );
}

const invoicePaid = (subId: string | null, id?: string, amountPaid = 90000, billingReason = "subscription_create") =>
  asEvent(
    "invoice.paid",
    { amount_paid: amountPaid, billing_reason: billingReason, parent: subId ? { subscription_details: { subscription: subId } } : null },
    id
  );

const process = (event: Stripe.Event) => processStripeEvent(event, { db: db(), stripe, now: NOW });

const grants = () => tdb.db.select().from(datasetAccessGrantsTable);
async function isLive(id: string, at: Date = NOW): Promise<boolean> {
  const rows = await tdb.db.select({ id: datasetAccessGrantsTable.id }).from(datasetAccessGrantsTable).where(liveGrant(at));
  return rows.some((r) => r.id === id);
}

async function insertFree(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: "buyer@example.com",
      name: "Free Person",
      category: "journalist",
      intendedUse: "Reporting.",
      attributionAckAt: NOW,
      termsVersion: "2026-11-09",
      verifyTokenHash: "verify-free-1",
      status: "active",
      expiresAt: daysFromNow(100),
      accessTokenHash: "old-access-hash",
      unsubscribeToken: "old-unsub",
      ...over,
    })
    .returning();
  return row;
}

describe("checkout.session.completed", () => {
  it("creates a live commercial grant and returns a token whose hash is stored", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    const out = await process(checkoutEvent());
    expect(out.kind).toBe("activated");
    if (out.kind !== "activated") return;

    const rows = await grants();
    expect(rows).toHaveLength(1);
    const g = rows[0];
    expect(g).toMatchObject({
      email: "buyer@example.com",
      name: "Bea Buyer",
      organization: "Acme Corp",
      tier: "commercial",
      status: "active",
      category: "commercial",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeCheckoutSessionId: "cs_1",
    });
    expect(g.paidThrough).toEqual(daysFromNow(30));
    expect(g.expiresAt).toEqual(g.paidThrough);
    expect(await isLive(g.id)).toBe(true);
    expect(out.mail).toMatchObject({ kind: "dataset_subscription_active", grantId: g.id, email: "buyer@example.com" });
    expect(g.accessTokenHash).toBe(hashToken(out.mail.accessToken));
    expect(g.unsubscribeToken).toBeTruthy();

    const [ev] = await tdb.db.select().from(stripeEventsTable);
    expect(ev.processedAt).not.toBeNull();
    expect(ev.grantId).toBe(g.id);
  });

  it("a duplicate delivery is `duplicate`: one row, no second token", async () => {
    makeSub("sub_1");
    const event = checkoutEvent();
    const first = await process(event);
    const hash = (await grants())[0].accessTokenHash;
    expect(await process(event)).toEqual({ kind: "duplicate" });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(hash);
    expect(first.kind).toBe("activated");
  });

  it("a retry of an unfinished event mints a FRESH token and returns `activated` (lost-mail recovery)", async () => {
    makeSub("sub_1");
    const event = checkoutEvent();
    const first = await process(event);
    if (first.kind !== "activated") throw new Error("expected activation");
    await tdb.db.update(stripeEventsTable).set({ processedAt: null }).where(eq(stripeEventsTable.id, event.id));

    const retry = await process(event);
    expect(retry.kind).toBe("activated");
    if (retry.kind !== "activated") return;
    expect(retry.grantId).toBe(first.grantId);
    expect(retry.mail.accessToken).not.toBe(first.mail.accessToken);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(hashToken(retry.mail.accessToken));
    expect(rows[0].accessTokenHash).not.toBe(hashToken(first.mail.accessToken));
    expect((await tdb.db.select().from(stripeEventsTable))[0].processedAt).not.toBeNull();
  });

  it("a failing beforeComplete leaves the event unprocessed; the redelivery re-mints and completes", async () => {
    makeSub("sub_1");
    const event = checkoutEvent();
    await expect(
      processStripeEvent(event, {
        db: db(),
        stripe,
        now: NOW,
        beforeComplete: async () => {
          throw new Error("send failed");
        },
      })
    ).rejects.toThrow("send failed");
    expect((await tdb.db.select().from(stripeEventsTable))[0].processedAt).toBeNull();
    const [afterFailure] = await grants();

    const sent: string[] = [];
    const out = await processStripeEvent(event, {
      db: db(),
      stripe,
      now: NOW,
      beforeComplete: async (o) => {
        if (o.kind === "activated") sent.push(o.mail.accessToken);
      },
    });
    expect(out.kind).toBe("activated");
    expect(sent).toHaveLength(1);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(hashToken(sent[0]));
    expect(rows[0].accessTokenHash).not.toBe(afterFailure.accessTokenHash);
    expect(await process(event)).toEqual({ kind: "duplicate" });
  });

  it("a session already activated by a DIFFERENT completed event gets no new token", async () => {
    makeSub("sub_1");
    const first = await process(checkoutEvent({}, { id: "evt_a" }));
    if (first.kind !== "activated") throw new Error("expected activation");
    // A second, distinct event for the same session (no stripe_events row yet): `updated`, no mail.
    const second = await process(checkoutEvent({}, { id: "evt_b" }));
    expect(second).toEqual({ kind: "updated", grantId: first.grantId });
    expect((await grants())[0].accessTokenHash).toBe(hashToken(first.mail.accessToken));
  });

  it("a checkout retry never revives a revoked grant", async () => {
    makeSub("sub_1");
    const event = checkoutEvent();
    const first = await process(event);
    if (first.kind !== "activated") throw new Error("expected activation");
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    await tdb.db.update(stripeEventsTable).set({ processedAt: null });
    const retry = await process(event);
    expect(retry).toEqual({ kind: "ignored", reason: "grant revoked; billing is stopped by the revoke action" });
    const [g] = await grants();
    expect(g.status).toBe("revoked");
    expect(g.accessTokenHash).toBe(hashToken(first.mail.accessToken));
    expect(await isLive(g.id)).toBe(false);
  });

  it("conflict: a LIVE commercial grant with another subscription is not overwritten", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    const first = await process(checkoutEvent());
    if (first.kind !== "activated") throw new Error("expected activation");
    const before = (await grants())[0];

    makeSub("sub_2", { periodEnd: daysFromNow(60) });
    const out = await process(checkoutEvent({}, { sessionId: "cs_2", subId: "sub_2" }));
    expect(out).toEqual({
      kind: "conflict",
      grantId: first.grantId,
      reason: "already_subscribed",
      existingSubscriptionId: "sub_1",
      newSubscriptionId: "sub_2",
      sessionId: "cs_2",
      invoiceId: "in_1",
    });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before);
    const events = await tdb.db.select().from(stripeEventsTable);
    expect(events.every((e) => e.processedAt !== null)).toBe(true);
  });

  it("resubscribe keeps the existing name and organization (only an INSERT takes them from Checkout)", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    await tdb.db.update(datasetAccessGrantsTable).set({ paidThrough: daysFromNow(-1), expiresAt: daysFromNow(-1) });
    makeSub("sub_2", { periodEnd: daysFromNow(60) });
    await process(
      checkoutEvent(
        {
          customer_details: { email: "buyer@example.com", name: "Someone Else" },
          custom_fields: [{ key: "organization", text: { value: "Other Org" } }],
        },
        { sessionId: "cs_2", subId: "sub_2" }
      )
    );
    const [g] = await grants();
    expect(g).toMatchObject({ name: "Bea Buyer", organization: "Acme Corp", stripeSubscriptionId: "sub_2" });
  });

  it("resubscribe: a LAPSED commercial grant is overwritten with the new subscription", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    const first = await process(checkoutEvent());
    if (first.kind !== "activated") throw new Error("expected activation");
    await tdb.db.update(datasetAccessGrantsTable).set({ paidThrough: daysFromNow(-1), expiresAt: daysFromNow(-1) });

    makeSub("sub_2", { periodEnd: daysFromNow(60) });
    const out = await process(checkoutEvent({}, { sessionId: "cs_2", subId: "sub_2" }));
    expect(out.kind).toBe("activated");
    if (out.kind !== "activated") return;
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripeSubscriptionId: "sub_2", stripeCheckoutSessionId: "cs_2" });
    expect(rows[0].accessTokenHash).toBe(hashToken(out.mail.accessToken));
    expect(await isLive(rows[0].id)).toBe(true);
  });

  describe("free rows are never read or written (the Checkout email is unverified)", () => {
    const snapshot = async (id: string) => {
      const [row] = await tdb.db.select().from(datasetAccessGrantsTable).where(eq(datasetAccessGrantsTable.id, id));
      return row;
    };

    it("an active free grant + a purchase with the same email: NEW commercial row, free row byte-identical", async () => {
      const free = await insertFree({ organization: "Free Org" });
      makeSub("sub_1");
      const out = await process(checkoutEvent());
      expect(out.kind).toBe("activated");
      if (out.kind !== "activated") return;
      expect(out.grantId).not.toBe(free.id);
      expect(await snapshot(free.id)).toEqual(free);
      const rows = await grants();
      expect(rows).toHaveLength(2);
      const paid = rows.find((r) => r.id === out.grantId);
      expect(paid).toMatchObject({ tier: "commercial", status: "active", organization: "Acme Corp" });
      expect(paid?.accessTokenHash).toBe(hashToken(out.mail.accessToken));
      expect(paid?.accessTokenHash).not.toBe("old-access-hash");
      expect(await isLive(out.grantId)).toBe(true);
    });

    it.each(["unverified", "pending_review"] as const)(
      "a %s free request + a purchase: untouched, new commercial row active",
      async (status) => {
        const free = await insertFree({ status, accessTokenHash: null, unsubscribeToken: null, expiresAt: null, organization: "Victim Org" });
        makeSub("sub_1");
        const out = await process(checkoutEvent());
        expect(out.kind).toBe("activated");
        if (out.kind !== "activated") return;
        expect(await snapshot(free.id)).toEqual(free);
        const paid = (await grants()).find((r) => r.id === out.grantId);
        expect(paid).toMatchObject({ tier: "commercial", status: "active" });
        expect(await isLive(free.id)).toBe(false);
      }
    );

    it("a later invoice event never touches the free row", async () => {
      const free = await insertFree();
      makeSub("sub_1", { periodEnd: daysFromNow(30) });
      await process(checkoutEvent());
      makeSub("sub_1", { periodEnd: daysFromNow(60) });
      await process(invoicePaid("sub_1"));
      expect(await snapshot(free.id)).toEqual(free);
    });
  });

  it("ignores a zero-amount checkout (100% coupon or free trial) and writes nothing", async () => {
    makeSub("sub_1");
    expect((await process(checkoutEvent({ amount_total: 0 }))).kind).toBe("ignored");
    expect((await process(checkoutEvent({ amount_total: null }, { id: "evt_x" }))).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
  });

  it("strips bidi, zero-width, control and format characters from name and organization", async () => {
    makeSub("sub_1");
    const out = await process(
      checkoutEvent({
        customer_details: { email: "buyer@example.com", name: "\u202EAlice\u200B \u2066Smith\u2069\uFEFF\u061C\u200E\n" },
        custom_fields: [{ key: "organization", text: { value: "\u202ECorp\u200D\u0007 Inc\u2028" } }],
      })
    );
    expect(out.kind).toBe("activated");
    const [g] = await grants();
    expect(g.name).toBe("Alice Smith");
    expect(g.organization).toBe("Corp Inc");
  });

  it("ignores a foreign price id and writes no grant", async () => {
    makeSub("sub_1", { price: FOREIGN });
    const out = await process(checkoutEvent());
    expect(out).toMatchObject({ kind: "ignored" });
    expect(await grants()).toHaveLength(0);
  });

  it("ignores a subscription with one foreign item among allowed ones", async () => {
    const sub = makeSub("sub_1");
    (sub.items.data as unknown[]).push({ price: { id: FOREIGN }, current_period_end: secs(daysFromNow(30)) });
    expect((await process(checkoutEvent())).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
  });

  it("ignores the wrong metadata.product", async () => {
    makeSub("sub_1");
    const out = await process(checkoutEvent({ metadata: { product: "something_else" } }));
    expect(out.kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
  });

  it("ignores an unpaid session and a missing email", async () => {
    makeSub("sub_1");
    expect((await process(checkoutEvent({ payment_status: "unpaid" }))).kind).toBe("ignored");
    expect((await process(checkoutEvent({ payment_status: "no_payment_required" }))).kind).toBe("ignored");
    expect((await process(checkoutEvent({ customer_details: { email: null } }))).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);
  });

  it("an ignored event is recorded as processed, so redelivery is a duplicate", async () => {
    makeSub("sub_1", { price: FOREIGN });
    const event = checkoutEvent();
    await process(event);
    expect(await process(event)).toEqual({ kind: "duplicate" });
  });
});

describe("invoice.paid", () => {
  it("extends paidThrough and expiresAt, and never shortens them", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());

    makeSub("sub_1", { periodEnd: daysFromNow(60) });
    expect((await process(invoicePaid("sub_1"))).kind).toBe("updated");
    let [g] = await grants();
    expect(g.paidThrough).toEqual(daysFromNow(60));
    expect(g.expiresAt).toEqual(daysFromNow(60));

    makeSub("sub_1", { periodEnd: daysFromNow(40) }); // an older, out-of-order invoice
    expect((await process(invoicePaid("sub_1"))).kind).toBe("updated");
    [g] = await grants();
    expect(g.paidThrough).toEqual(daysFromNow(60));
    expect(g.expiresAt).toEqual(daysFromNow(60));
  });

  it("before the checkout event is ignored", async () => {
    makeSub("sub_1");
    expect(await process(invoicePaid("sub_1"))).toEqual({ kind: "ignored", reason: "no grant yet" });
    expect(await grants()).toHaveLength(0);
  });

  it("ignores a zero-amount invoice and does not extend", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    makeSub("sub_1", { periodEnd: daysFromNow(60) });
    expect((await process(invoicePaid("sub_1", undefined, 0))).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(30));
  });

  it("a renewal invoice for a paying allowlisted subscription with no grant is an orphaned_subscription conflict", async () => {
    makeSub("sub_9", { periodEnd: daysFromNow(30) });
    const out = await process(invoicePaid("sub_9", undefined, 90000, "subscription_cycle"));
    expect(out).toEqual({ kind: "conflict", reason: "orphaned_subscription", subscriptionId: "sub_9" });
    expect(await grants()).toHaveLength(0);
    expect((await tdb.db.select().from(stripeEventsTable))[0].processedAt).not.toBeNull();
  });

  it("an orphan with a canceled subscription or a foreign price is ignored, not a conflict", async () => {
    makeSub("sub_9", { status: "canceled" });
    expect((await process(invoicePaid("sub_9", undefined, 90000, "subscription_cycle"))).kind).toBe("ignored");
    makeSub("sub_8", { price: FOREIGN });
    expect((await process(invoicePaid("sub_8", undefined, 90000, "subscription_cycle"))).kind).toBe("ignored");
  });

  it("without a subscription is ignored", async () => {
    expect((await process(invoicePaid(null))).kind).toBe("ignored");
  });

  it("never touches a free grant", async () => {
    const free = await insertFree({ stripeSubscriptionId: "sub_1" });
    makeSub("sub_1", { periodEnd: daysFromNow(400) });
    expect((await process(invoicePaid("sub_1"))).kind).toBe("ignored");
    const [g] = await grants();
    expect(g.expiresAt).toEqual(free.expiresAt);
    expect(g.paidThrough).toBeNull();
  });

  it("revives a grant the sweep marked expired", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "expired" });
    makeSub("sub_1", { periodEnd: daysFromNow(60) });
    await process(invoicePaid("sub_1"));
    const [g] = await grants();
    expect(g.status).toBe("active");
    expect(await isLive(g.id)).toBe(true);
  });

  it("does not revive a revoked grant", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    makeSub("sub_1", { periodEnd: daysFromNow(60) });
    expect((await process(invoicePaid("sub_1"))).kind).toBe("conflict");
    expect((await grants())[0].status).toBe("revoked");
  });
});

describe("customer.subscription.updated", () => {
  it("extends on an active subscription and leaves a canceled one alone", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());

    const renewed = makeSub("sub_1", { periodEnd: daysFromNow(60) });
    expect((await process(asEvent("customer.subscription.updated", renewed))).kind).toBe("updated");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(60));

    const pastDue = makeSub("sub_1", { periodEnd: daysFromNow(75), status: "past_due" });
    expect((await process(asEvent("customer.subscription.updated", pastDue))).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(60));

    const trialing = makeSub("sub_1", { periodEnd: daysFromNow(65), status: "trialing" });
    expect((await process(asEvent("customer.subscription.updated", trialing))).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(60));

    const canceled = makeSub("sub_1", { periodEnd: daysFromNow(90), status: "canceled" });
    expect((await process(asEvent("customer.subscription.updated", canceled))).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(60));
  });
});

describe("revoked grants", () => {
  it("are never revived by subscription.updated", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    const renewed = makeSub("sub_1", { periodEnd: daysFromNow(60) });
    expect((await process(asEvent("customer.subscription.updated", renewed))).kind).toBe("conflict");
    const [g] = await grants();
    expect(g.status).toBe("revoked");
    expect(await isLive(g.id)).toBe(false);
  });
});

describe("out-of-order events: a canceled subscription never gains access", () => {
  it("deleted, then a delayed checkout: no grant, no token", async () => {
    const ended = makeSub("sub_1", { status: "canceled", endedAt: NOW });
    expect((await process(asEvent("customer.subscription.deleted", ended))).kind).toBe("ignored");
    const out = await process(checkoutEvent());
    expect(out).toEqual({ kind: "ignored", reason: "subscription not in a paying status" });
    expect(await grants()).toHaveLength(0);
  });

  it("a retry of a checkout after an immediate cancel mints no token", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    const event = checkoutEvent();
    const first = await process(event);
    if (first.kind !== "activated") throw new Error("expected activation");
    await tdb.db.update(stripeEventsTable).set({ processedAt: null }).where(eq(stripeEventsTable.id, event.id));
    makeSub("sub_1", { status: "canceled", endedAt: NOW });
    const retry = await process(event);
    expect(retry.kind).toBe("ignored");
    expect((await grants())[0].accessTokenHash).toBe(hashToken(first.mail.accessToken));
  });

  it("deleted, then a stale subscription.updated and a stale invoice.paid: paidThrough stays cut", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    const ended = makeSub("sub_1", { periodEnd: daysFromNow(30), status: "canceled", endedAt: NOW });
    await process(asEvent("customer.subscription.deleted", ended));
    expect((await grants())[0].paidThrough).toEqual(NOW);

    // The event bodies still claim "active"; only the retrieved subscription tells the truth.
    const staleBody = makeSub("sub_stale", { periodEnd: daysFromNow(60) });
    expect((await process(asEvent("customer.subscription.updated", { ...staleBody, id: "sub_1" }))).kind).toBe("ignored");
    expect((await process(invoicePaid("sub_1"))).kind).toBe("ignored");
    const [g] = await grants();
    expect(g.paidThrough).toEqual(NOW);
    expect(g.expiresAt).toEqual(NOW);
  });
});

describe("no trials: only an active subscription grants access", () => {
  it("a trialing subscription is ignored on checkout and invoice.paid", async () => {
    makeSub("sub_1", { status: "trialing" });
    expect((await process(checkoutEvent())).kind).toBe("ignored");
    expect(await grants()).toHaveLength(0);

    makeSub("sub_2", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent({}, { sessionId: "cs_2", subId: "sub_2" }));
    makeSub("sub_2", { status: "trialing", periodEnd: daysFromNow(90) });
    expect((await process(invoicePaid("sub_2"))).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(30));
  });
});

describe("a revoke sticks on the paid tier", () => {
  const revokedCommercial = (over: Partial<typeof datasetAccessGrantsTable.$inferInsert>) =>
    insertFree({
      tier: "commercial",
      category: "commercial",
      status: "revoked",
      accessTokenHash: "revoked-access",
      unsubscribeToken: null,
      expiresAt: daysFromNow(10),
      paidThrough: daysFromNow(10),
      ...over,
    });

  it("revoked by email: conflict, nothing created", async () => {
    const revoked = await revokedCommercial({ stripeCustomerId: "cus_old", stripeSubscriptionId: "sub_old" });
    makeSub("sub_1");
    const out = await process(checkoutEvent());
    expect(out).toEqual({
      kind: "conflict",
      reason: "revoked_buyer",
      grantId: revoked.id,
      newSubscriptionId: "sub_1",
      sessionId: "cs_1",
      invoiceId: "in_1",
    });
    expect(await grants()).toEqual([revoked]);
    expect((await tdb.db.select().from(stripeEventsTable))[0].processedAt).not.toBeNull();
  });

  it("revoked by Stripe customer id with a DIFFERENT email: conflict", async () => {
    const revoked = await revokedCommercial({ email: "old-address@example.com", stripeCustomerId: "cus_1", verifyTokenHash: "v-old" });
    makeSub("sub_1");
    const out = await process(checkoutEvent());
    expect(out).toMatchObject({ kind: "conflict", reason: "revoked_buyer", grantId: revoked.id });
    expect(await grants()).toHaveLength(1);
  });

  it("a revoked FREE grant for the same email does not block a purchase", async () => {
    await insertFree({ status: "revoked" });
    makeSub("sub_1");
    expect((await process(checkoutEvent())).kind).toBe("activated");
    expect(await grants()).toHaveLength(2);
  });

  it("revoked by CARD FINGERPRINT with a new email and a new customer: conflict; only the hash is stored", async () => {
    const fp = "fp_raw_visa_4242";
    makeSub("sub_a", { fingerprint: fp, customer: "cus_a" });
    await process(checkoutEvent({ customer: "cus_a" }, { sessionId: "cs_a", subId: "sub_a" }));
    const [orig] = await grants();
    expect(retrieve).toHaveBeenCalledWith("sub_a", { expand: ["default_payment_method"] });
    expect(orig.cardFingerprintHash).toBe(hashToken(fp));
    expect(JSON.stringify(orig)).not.toContain(fp);
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });

    makeSub("sub_b", { fingerprint: fp, customer: "cus_b" });
    const out = await process(
      checkoutEvent(
        { customer: "cus_b", customer_details: { email: "new-person@example.com", name: "New" } },
        { sessionId: "cs_b", subId: "sub_b" }
      )
    );
    expect(out).toMatchObject({ kind: "conflict", reason: "revoked_buyer", grantId: orig.id, newSubscriptionId: "sub_b" });
    expect(await grants()).toHaveLength(1);
  });

  it("an unpaid session from a revoked buyer is ignored, never a conflict (no refund of a payment never made)", async () => {
    await revokedCommercial({ stripeCustomerId: "cus_old", stripeSubscriptionId: "sub_old" });
    makeSub("sub_1");
    const out = await process(checkoutEvent({ payment_status: "unpaid" }));
    expect(out).toEqual({ kind: "ignored", reason: "checkout not paid" });
    expect(await grants()).toHaveLength(1);
  });

  it("a different card does not match", async () => {
    makeSub("sub_a", { fingerprint: "fp_one", customer: "cus_a" });
    await process(checkoutEvent({ customer: "cus_a" }, { sessionId: "cs_a", subId: "sub_a" }));
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    makeSub("sub_b", { fingerprint: "fp_two", customer: "cus_b" });
    const out = await process(
      checkoutEvent(
        { customer: "cus_b", customer_details: { email: "new-person@example.com", name: "New" } },
        { sessionId: "cs_b", subId: "sub_b" }
      )
    );
    expect(out.kind).toBe("activated");
  });

  it("the conflict is returned again on redelivery after the new subscription was cancelled (never ignored)", async () => {
    const revoked = await revokedCommercial({ stripeCustomerId: "cus_old", stripeSubscriptionId: "sub_old" });
    makeSub("sub_1");
    const event = checkoutEvent();
    const first = await process(event);
    expect(first).toMatchObject({ kind: "conflict", reason: "revoked_buyer" });
    await tdb.db.update(stripeEventsTable).set({ processedAt: null });
    makeSub("sub_1", { status: "canceled", endedAt: NOW }); // the route cancelled it
    expect(await process(event)).toMatchObject({
      kind: "conflict",
      reason: "revoked_buyer",
      grantId: revoked.id,
      sessionId: "cs_1",
      invoiceId: "in_1",
    });
  });

  it("the already_subscribed conflict also survives a cancelled new subscription", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    makeSub("sub_2", { periodEnd: daysFromNow(60) });
    const event = checkoutEvent({}, { sessionId: "cs_2", subId: "sub_2" });
    expect((await process(event)).kind).toBe("conflict");
    await tdb.db.update(stripeEventsTable).set({ processedAt: null }).where(eq(stripeEventsTable.id, event.id));
    makeSub("sub_2", { status: "canceled", endedAt: NOW });
    expect(await process(event)).toMatchObject({ kind: "conflict", reason: "already_subscribed", newSubscriptionId: "sub_2" });
  });

  it("another revoked grant on the same customer does NOT affect a live linked grant (extends normally)", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30), customer: "cus_live" });
    await process(checkoutEvent({ customer: "cus_live" }));
    await revokedCommercial({ email: "gone@example.com", stripeCustomerId: "cus_live", verifyTokenHash: "v-gone" });
    makeSub("sub_1", { periodEnd: daysFromNow(60), customer: "cus_live" });
    expect((await process(invoicePaid("sub_1"))).kind).toBe("updated");
    expect((await process(asEvent("customer.subscription.updated", { id: "sub_1" }))).kind).toBe("updated");
    expect((await grants()).find((g) => g.stripeSubscriptionId === "sub_1")?.paidThrough).toEqual(daysFromNow(60));
  });

  it("invoice.paid / subscription.updated for a LINKED revoked grant whose subscription is still active: revoked_still_billing, no extension", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    const before = (await grants())[0];
    makeSub("sub_1", { periodEnd: daysFromNow(60) });

    expect(await process(invoicePaid("sub_1"))).toEqual({
      kind: "conflict",
      reason: "revoked_still_billing",
      grantId: before.id,
      subscriptionId: "sub_1",
    });
    expect(await process(asEvent("customer.subscription.updated", { id: "sub_1" }))).toMatchObject({
      kind: "conflict",
      reason: "revoked_still_billing",
      grantId: before.id,
    });
    expect(await grants()).toEqual([before]);
  });

  it("an UNLINKED paying subscription stays orphaned_subscription even if its customer has a revoked grant", async () => {
    await revokedCommercial({ email: "gone@example.com", stripeCustomerId: "cus_1", verifyTokenHash: "v-gone" });
    makeSub("sub_new", { customer: "cus_1" });
    expect(await process(invoicePaid("sub_new", undefined, 90000, "subscription_cycle"))).toEqual({
      kind: "conflict",
      reason: "orphaned_subscription",
      subscriptionId: "sub_new",
    });
  });
});

describe("price allowlist on later events", () => {
  it.each([
    ["invoice.paid", () => invoicePaid("sub_1")],
    ["customer.subscription.updated", () => asEvent("customer.subscription.updated", { id: "sub_1" })],
  ])("%s with a foreign price is ignored and does not extend", async (_name, build) => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    makeSub("sub_1", { price: FOREIGN, periodEnd: daysFromNow(90) });
    expect((await process(build())).kind).toBe("ignored");
    expect((await grants())[0].paidThrough).toEqual(daysFromNow(30));
  });
});

describe("unique-index race", () => {
  it("a competing insert between lookup and insert (23505) is re-read, not duplicated and not a crash", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    let raced = false;
    const competitor = () =>
      tdb.db.insert(datasetAccessGrantsTable).values({
        email: "buyer@example.com",
        name: "Racer",
        category: "commercial",
        tier: "commercial",
        status: "active",
        intendedUse: "x",
        attributionAckAt: NOW,
        termsVersion: "2026-11-09",
        verifyTokenHash: "racer-verify",
        expiresAt: daysFromNow(-1),
        paidThrough: daysFromNow(-1),
      });
    // Delays the FIRST grant insert until a competitor has taken the (email, tier) open slot.
    const racing = new Proxy(db(), {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "insert") return typeof value === "function" ? value.bind(target) : value;
        return (table: unknown) => {
          const builder = target.insert(table as never);
          if (table !== datasetAccessGrantsTable || raced) return builder;
          raced = true;
          return {
            values: (v: never) => {
              const q = builder.values(v);
              return {
                returning: (...args: never[]) => {
                  const real = (q.returning as (...a: unknown[]) => PromiseLike<unknown>)(...args);
                  return { then: (ok: never, bad: never) => competitor().then(() => real).then(ok, bad) };
                },
              };
            },
          };
        };
      },
    }) as CommercialDb;

    const out = await processStripeEvent(checkoutEvent(), { db: racing, stripe, now: NOW });
    expect(raced).toBe(true);
    expect(out.kind).toBe("activated");
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripeSubscriptionId: "sub_1", status: "active" });
    if (out.kind === "activated") expect(rows[0].accessTokenHash).toBe(hashToken(out.mail.accessToken));
    expect(await isLive(rows[0].id)).toBe(true);
  });
});

describe("customer.subscription.deleted", () => {
  it("an immediate cancel cuts access now", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    const ended = makeSub("sub_1", { periodEnd: daysFromNow(30), status: "canceled", endedAt: NOW });
    expect((await process(asEvent("customer.subscription.deleted", ended))).kind).toBe("updated");
    const [g] = await grants();
    expect(g.paidThrough).toEqual(NOW);
    expect(g.expiresAt).toEqual(NOW);
    expect(await isLive(g.id, new Date(NOW.getTime() + 1000))).toBe(false);
  });

  it("a period-end cancel keeps access until the period ends", async () => {
    makeSub("sub_1", { periodEnd: daysFromNow(30) });
    await process(checkoutEvent());
    const ended = makeSub("sub_1", { status: "canceled", endedAt: daysFromNow(30) });
    await process(asEvent("customer.subscription.deleted", ended));
    const [g] = await grants();
    expect(g.paidThrough).toEqual(daysFromNow(30));
    expect(await isLive(g.id)).toBe(true);
    expect(await isLive(g.id, daysFromNow(31))).toBe(false);
  });

  it("an unknown subscription is ignored", async () => {
    const ended = makeSub("sub_nope", { endedAt: NOW });
    expect((await process(asEvent("customer.subscription.deleted", ended))).kind).toBe("ignored");
  });
});

describe("other events", () => {
  it("an unknown event type is ignored", async () => {
    expect(await process(asEvent("charge.refunded", {}))).toEqual({ kind: "ignored", reason: "unhandled event type" });
  });
});
