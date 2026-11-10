// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeCommercialSideEffects, type CommercialStripe } from "@/lib/commercial-actions";
import type { StripeEventOutcome as AnyOutcome } from "@/lib/commercial-grants";
import { datasetAccessGrantsTable, emailSendsTable, emailSuppressionsTable } from "@/lib/db/schema";
import type { SendOutcome } from "@/lib/email";
import { sendGrantGated } from "@/lib/email-gate";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

/** Webhook side effects against real Postgres (PGlite) and a fake Stripe that records every call. */

let tdb: TestDbHandle;
type StripeEventOutcome = Exclude<AnyOutcome, { kind: "duplicate" }>;
const OK: SendOutcome = { sent: true, resendId: "r-1" };
const DAY = 24 * 60 * 60 * 1000;
const EXISTING = "sub_existing_DO_NOT_TOUCH";

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "commercial-actions-test-salt";
  tdb = await makeTestDb();
});
beforeEach(async () => {
  await tdb.reset();
  vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.test");
  calls.length = 0;
  invoicePayments = [];
  cancelError = null;
  refundError = null;
  subStatus = "active";
  pageSize = 100;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await tdb.client.close();
});

const calls: Array<{ method: string; args: unknown[] }> = [];
let invoicePayments: Array<Record<string, unknown>> = [];
let cancelError: Error | null = null;
let refundError: (Error & { code?: string }) | null = null;
let subStatus = "active";
let pageSize = 100;

const rec =
  (method: string, impl: (...a: unknown[]) => unknown = () => ({})) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
    return impl(...args);
  };

const stripe = {
  subscriptions: {
    cancel: rec("cancel", () => {
      if (cancelError) throw cancelError;
      return {};
    }),
    retrieve: rec("retrieve", () => ({ status: subStatus })),
  },
  refunds: {
    create: rec("refund", () => {
      if (refundError) throw refundError;
      return {};
    }),
  },
  invoicePayments: {
    // Honest pagination: `pageSize` items per page, `starting_after` honoured, `has_more` set.
    list: rec("listPayments", (params) => {
      const { starting_after } = params as { starting_after?: string };
      const from = starting_after ? invoicePayments.findIndex((p) => p.id === starting_after) + 1 : 0;
      const data = invoicePayments.slice(from, from + pageSize);
      return { data, has_more: from + pageSize < invoicePayments.length };
    }),
  },
} as unknown as CommercialStripe;

const mailers = () => ({
  subscriptionActive: vi.fn<(i: { email: string; accessToken: string }) => Promise<SendOutcome>>(async () => OK),
  alert: vi.fn<(i: unknown) => Promise<SendOutcome>>(async () => OK),
});

const db = () => tdb.db;
const make = (m = mailers()) => ({
  m,
  run: makeCommercialSideEffects({ db: db(), stripe, sendMail: m as never }),
});
const emailRows = () => tdb.db.select().from(emailSendsTable);

async function seedCommercialGrant(email = "buyer@example.com") {
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email,
      name: "Buyer",
      category: "commercial",
      intendedUse: "x",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status: "active",
      tier: "commercial",
      verifyTokenHash: "v".padEnd(64, "0"),
      expiresAt: new Date(Date.now() + 5 * DAY),
      paidThrough: new Date(Date.now() + 5 * DAY),
    })
    .returning();
  return row;
}

const activated = (grantId: string, accessToken = "tok-1"): StripeEventOutcome => ({
  kind: "activated",
  grantId,
  sessionId: "cs_1",
  mail: { kind: "dataset_subscription_active", grantId, email: "buyer@example.com", accessToken },
});

const alreadySub = (over: Partial<{ invoiceId: string | null; amountTotal: number }> = {}): StripeEventOutcome => ({
  kind: "conflict",
  reason: "already_subscribed",
  grantId: "g1",
  existingSubscriptionId: EXISTING,
  newSubscriptionId: "sub_new",
  sessionId: "cs_1",
  invoiceId: "in_1",
  amountTotal: 15000,
  ...over,
});
const revokedBuyer = (): StripeEventOutcome => ({
  kind: "conflict",
  reason: "revoked_buyer",
  grantId: "g1",
  newSubscriptionId: "sub_new",
  sessionId: "cs_2",
  invoiceId: "in_2",
  amountTotal: 15000,
});

const paid = (invoice: string, over: Record<string, unknown> = {}) => ({
  id: "ip_1",
  invoice,
  amount_paid: 15000,
  status: "paid",
  payment: { type: "payment_intent", payment_intent: "pi_1" },
  ...over,
});

/** No Stripe call may name the existing subscription, however deep the argument. */
const expectNoExisting = () => expect(JSON.stringify(calls)).not.toContain(EXISTING);

describe("activated", () => {
  it("sends the welcome mail once with the raw token, and records a sent row", async () => {
    const g = await seedCommercialGrant();
    const { m, run } = make();
    await run(activated(g.id, "tok-abc"));
    expect(m.subscriptionActive).toHaveBeenCalledTimes(1);
    expect(m.subscriptionActive).toHaveBeenCalledWith({ email: "buyer@example.com", accessToken: "tok-abc" });
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "dataset_subscription_active", outcome: "sent", targetId: g.id });
  });

  it("throws when the send fails, and a retry with a NEW token sends again (the failed claim does not block it)", async () => {
    const g = await seedCommercialGrant();
    const failing = mailers();
    failing.subscriptionActive.mockResolvedValue({ sent: false, errorCode: "validation_error" });
    await expect(make(failing).run(activated(g.id, "tok-1"))).rejects.toThrow(/not sent/);

    const retry = mailers();
    await make(retry).run(activated(g.id, "tok-2"));
    expect(retry.subscriptionActive).toHaveBeenCalledWith({ email: "buyer@example.com", accessToken: "tok-2" });
    expect((await emailRows()).map((r) => r.outcome).sort()).toEqual(["error", "sent"]);
  });

  it("a non-terminal skip (no API key) still throws", async () => {
    const g = await seedCommercialGrant();
    const m = mailers();
    m.subscriptionActive.mockResolvedValue({ sent: false, errorCode: "no_key", skipped: "no_key" });
    await expect(make(m).run(activated(g.id))).rejects.toThrow(/not sent/);
    expect(m.alert).not.toHaveBeenCalled();
  });

  it("terminal skip (grant unconfirmed): alerts the maintainer and does not throw", async () => {
    const g = await seedCommercialGrant();
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    const { m, run } = make();
    await expect(run(activated(g.id))).resolves.toBeUndefined();
    expect(m.subscriptionActive).not.toHaveBeenCalled();
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(m.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "welcome_mail_undeliverable", action: "link_not_mailed_unconfirmed", grantId: g.id, sessionId: "cs_1" })
    );
    expect((await emailRows()).map((r) => r.targetId)).toContain(`welcome_mail_undeliverable:${g.id}:cs_1`);
  });

  it("terminal skip (address suppressed): alerts the maintainer and does not throw", async () => {
    const g = await seedCommercialGrant();
    await tdb.db
      .insert(emailSuppressionsTable)
      .values({ email: "buyer@example.com", targetType: "", targetId: "", source: "test" });
    const { m, run } = make();
    await expect(run(activated(g.id))).resolves.toBeUndefined();
    expect(m.subscriptionActive).not.toHaveBeenCalled();
    expect(m.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "welcome_mail_undeliverable", action: "link_not_mailed_suppressed" })
    );
  });

  it("the welcome alert is keyed per (grant, session): two sessions on one grant alert twice, a redelivery once", async () => {
    const g = await seedCommercialGrant();
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    const m = mailers();
    const other = { ...activated(g.id), sessionId: "cs_2" } as StripeEventOutcome;
    await make(m).run(activated(g.id));
    await make(m).run(activated(g.id));
    await make(m).run(other);
    expect(m.alert).toHaveBeenCalledTimes(2);
  });

  it("terminal skip whose alert fails: throws so Stripe redelivers", async () => {
    const g = await seedCommercialGrant();
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    const m = mailers();
    m.alert.mockResolvedValue({ sent: false, errorCode: "x" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(make(m).run(activated(g.id))).rejects.toThrow(/alert not sent/);
  });

  it("the gate requires an active commercial grant", async () => {
    const g = await seedCommercialGrant();
    const send = vi.fn(async () => OK);
    const ask = () =>
      sendGrantGated(tdb.db, { kind: "dataset_subscription_active", grantId: g.id, email: "buyer@example.com" }, send);
    expect((await ask()).disposition).toBe("sent");
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "revoked" });
    expect((await ask()).disposition).toBe("skipped_unconfirmed");
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "active", tier: "free" });
    expect((await ask()).disposition).toBe("skipped_unconfirmed");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["already_subscribed", () => alreadySub(), "cs_1", "in_1"],
  ["revoked_buyer", () => revokedBuyer(), "cs_2", "in_2"],
] as const)("%s", (reason, outcome, sessionId, invoiceId) => {
  it("cancels ONLY the new subscription, refunds only that invoice's payment intent, alerts", async () => {
    invoicePayments = [paid(invoiceId), paid("in_OTHER", { payment: { type: "payment_intent", payment_intent: "pi_OTHER" } })];
    const { m, run } = make();
    await run(outcome());

    expect(calls.filter((c) => c.method === "cancel")).toEqual([
      { method: "cancel", args: ["sub_new", {}, { idempotencyKey: `ca-cancel-${sessionId}` }] },
    ]);
    expect(calls.find((c) => c.method === "listPayments")?.args[0]).toMatchObject({ invoice: invoiceId });
    expect(calls.filter((c) => c.method === "refund")).toEqual([
      { method: "refund", args: [{ payment_intent: "pi_1" }, { idempotencyKey: `ca-refund-${sessionId}-pi_1` }] },
    ]);
    expectNoExisting();
    expect(m.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason, action: "cancelled_and_refunded", subscriptionId: "sub_new", sessionId, invoiceId, grantId: "g1" })
    );
  });

  it("passes a null conflict grant through to the alert as null", async () => {
    const { m, run } = make();
    await run({ ...outcome(), grantId: null } as unknown as StripeEventOutcome);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ reason, grantId: null }));
    expect((await emailRows()).map((r) => r.targetId)).toEqual([`${reason}:${sessionId}`]);
  });

  it("no invoice or zero amount: cancels, no refund, no throw", async () => {
    const noInvoice = make();
    await noInvoice.run(
      reason === "revoked_buyer"
        ? ({ ...revokedBuyer(), invoiceId: null, amountTotal: 0 } as StripeEventOutcome)
        : alreadySub({ invoiceId: null, amountTotal: 0 })
    );
    expect(calls.some((c) => c.method === "refund" || c.method === "listPayments")).toBe(false);
    expect(calls.some((c) => c.method === "cancel")).toBe(true);
    expect(noInvoice.m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled" }));

    calls.length = 0;
    invoicePayments = [paid(invoiceId, { amount_paid: 0 })];
    await make().run({ ...outcome(), amountTotal: 0 } as StripeEventOutcome);
    expect(calls.some((c) => c.method === "refund")).toBe(false);
  });

  it("amountTotal > 0 with no payments found: cancelled, refund needed", async () => {
    invoicePayments = [];
    const { m, run } = make();
    await run(outcome());
    expect(calls.some((c) => c.method === "refund")).toBe(false);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_refund_needed" }));
  });

  it("amountTotal > 0 with no invoice: cancelled, refund needed", async () => {
    const { m, run } = make();
    await run({ ...outcome(), invoiceId: null } as StripeEventOutcome);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_refund_needed" }));
  });

  it("refunds every paid payment with its own idempotency key", async () => {
    invoicePayments = [
      paid(invoiceId, { id: "ip_a", payment: { type: "payment_intent", payment_intent: "pi_a" } }),
      paid(invoiceId, { id: "ip_b", payment: { type: "charge", charge: "ch_b" } }),
    ];
    const { m, run } = make();
    await run(outcome());
    expect(calls.filter((c) => c.method === "refund").map((c) => c.args)).toEqual([
      [{ payment_intent: "pi_a" }, { idempotencyKey: `ca-refund-${sessionId}-pi_a` }],
      [{ charge: "ch_b" }, { idempotencyKey: `ca-refund-${sessionId}-ch_b` }],
    ]);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_and_refunded" }));
  });

  it("reads every page of invoice payments", async () => {
    pageSize = 1;
    invoicePayments = [
      paid(invoiceId, { id: "ip_a", payment: { type: "payment_intent", payment_intent: "pi_a" } }),
      paid(invoiceId, { id: "ip_b", payment: { type: "payment_intent", payment_intent: "pi_b" } }),
      paid(invoiceId, { id: "ip_c", payment: { type: "charge", charge: "ch_c" } }),
    ];
    await make().run(outcome());
    expect(calls.filter((c) => c.method === "listPayments")).toHaveLength(3);
    expect(calls.filter((c) => c.method === "refund").map((c) => c.args[0])).toEqual([
      { payment_intent: "pi_a" },
      { payment_intent: "pi_b" },
      { charge: "ch_c" },
    ]);
  });

  it("two payments sharing one payment intent refund it exactly once", async () => {
    invoicePayments = [paid(invoiceId, { id: "ip_a" }), paid(invoiceId, { id: "ip_b" })];
    const { m, run } = make();
    await run(outcome());
    expect(calls.filter((c) => c.method === "refund")).toEqual([
      { method: "refund", args: [{ payment_intent: "pi_1" }, { idempotencyKey: `ca-refund-${sessionId}-pi_1` }] },
    ]);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_and_refunded" }));
  });

  it("one unidentified payment among two: the other is still refunded, refund needed", async () => {
    invoicePayments = [
      paid(invoiceId, { id: "ip_a", payment: { type: "payment_record" } }),
      paid(invoiceId, { id: "ip_b", payment: { type: "payment_intent", payment_intent: "pi_b" } }),
    ];
    const { m, run } = make();
    await run(outcome());
    expect(calls.filter((c) => c.method === "refund")).toHaveLength(1);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_refund_needed" }));
  });

  it("treats an already-canceled subscription and an already-refunded charge as success", async () => {
    invoicePayments = [paid(invoiceId)];
    cancelError = new Error("canceled subscription can only update metadata");
    subStatus = "canceled";
    refundError = Object.assign(new Error("already refunded"), { code: "charge_already_refunded" });
    await expect(make().run(outcome())).resolves.toBeUndefined();
  });

  it("throws on a Stripe cancel failure (subscription still live) and on a refund failure", async () => {
    cancelError = new Error("api down");
    await expect(make().run(outcome())).rejects.toThrow("api down");

    cancelError = null;
    invoicePayments = [paid(invoiceId)];
    refundError = Object.assign(new Error("boom"), { code: "api_error" });
    await expect(make().run(outcome())).rejects.toThrow("boom");
  });

  it("a paid invoice with no payment intent or charge is reported for a manual refund", async () => {
    invoicePayments = [paid(invoiceId, { payment: { type: "payment_record" } })];
    const { m, run } = make();
    await run(outcome());
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled_refund_needed" }));
  });

  it("a failing alert throws AFTER cancel and refund ran; the retry repeats them with the same keys, then alerts", async () => {
    invoicePayments = [paid(invoiceId)];
    const m = mailers();
    m.alert.mockResolvedValueOnce({ sent: false, errorCode: "x" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(make(m).run(outcome())).rejects.toThrow(/alert not sent/);
    const first = calls.filter((c) => c.method === "cancel" || c.method === "refund");
    expect(first).toHaveLength(2);
    calls.length = 0;
    await make(m).run(outcome());
    expect(calls.filter((c) => c.method === "cancel" || c.method === "refund")).toEqual(first);
    expect(m.alert).toHaveBeenCalledTimes(2);
  });

  it("without CONTACT_TO_EMAIL it throws after cancel and refund ran", async () => {
    invoicePayments = [paid(invoiceId)];
    vi.stubEnv("CONTACT_TO_EMAIL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(make().run(outcome())).rejects.toThrow(/gate_error/);
    expect(calls.some((c) => c.method === "cancel")).toBe(true);
    expect(calls.some((c) => c.method === "refund")).toBe(true);
  });

  it("a whitespace-padded CONTACT_TO_EMAIL is trimmed; all-whitespace behaves like unset", async () => {
    invoicePayments = [paid(invoiceId)];
    vi.stubEnv("CONTACT_TO_EMAIL", "  maintainer@example.test \n");
    await make().run(outcome());
    expect((await emailRows())[0]?.outcome).toBe("sent");
    vi.stubEnv("CONTACT_TO_EMAIL", "   ");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(make().run(alreadySub())).rejects.toThrow(/gate_error/);
  });

  it("alerts once across a redelivery", async () => {
    invoicePayments = [paid(invoiceId)];
    const m = mailers();
    await make(m).run(outcome());
    await make(m).run(outcome());
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect((await emailRows()).filter((r) => r.outcome === "skipped_duplicate")).toHaveLength(1);
  });
});

describe("superseded_session", () => {
  const superseded: StripeEventOutcome = {
    kind: "conflict",
    reason: "superseded_session",
    grantId: "g9",
    sessionId: "cs_9",
    subscriptionId: "sub_9",
  };

  it("alerts only: no cancel, no refund; required", async () => {
    const { m, run } = make();
    await run(superseded);
    expect(calls).toEqual([]);
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(m.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "superseded_session", action: "no_action_person_decides", sessionId: "cs_9", grantId: "g9" })
    );
    expect((await emailRows()).map((r) => r.targetId)).toEqual(["superseded_session:cs_9"]);
  });

  it("throws when the alert cannot be sent", async () => {
    const m = mailers();
    m.alert.mockResolvedValue({ sent: false, errorCode: "x" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(make(m).run(superseded)).rejects.toThrow(/alert not sent/);
    expect(calls).toEqual([]);
  });
});

describe("revoked_still_billing", () => {
  it("cancels that subscription with no refund and alerts", async () => {
    const { m, run } = make();
    await run({ kind: "conflict", reason: "revoked_still_billing", grantId: "g1", subscriptionId: "sub_rev" });
    expect(calls).toEqual([{ method: "cancel", args: ["sub_rev", {}, { idempotencyKey: "ca-cancel-revoked-sub_rev" }] }]);
    expect(m.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "revoked_still_billing", action: "cancelled" }));
  });
});

describe("orphaned_subscription", () => {
  const orphan: StripeEventOutcome = { kind: "conflict", reason: "orphaned_subscription", subscriptionId: "sub_orph" };

  it("alerts once per subscription, touching nothing at Stripe", async () => {
    const m = mailers();
    await make(m).run(orphan);
    await make(m).run(orphan);
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    await make(m).run({ ...orphan, subscriptionId: "sub_orph2" } as StripeEventOutcome);
    expect(m.alert).toHaveBeenCalledTimes(2);
  });

  it("throws when the alert cannot be sent, then alerts on the retry", async () => {
    const m = mailers();
    m.alert.mockResolvedValueOnce({ sent: false, errorCode: "x" });
    await expect(make(m).run(orphan)).rejects.toThrow(/alert not sent/);
    await make(m).run(orphan);
    expect(m.alert).toHaveBeenCalledTimes(2);
  });

  it("throws without CONTACT_TO_EMAIL (nothing to alert)", async () => {
    vi.stubEnv("CONTACT_TO_EMAIL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(make().run(orphan)).rejects.toThrow(/gate_error/);
  });
});

describe("updated / ignored", () => {
  it("do nothing", async () => {
    const { m, run } = make();
    await run({ kind: "updated", grantId: "g" });
    await run({ kind: "ignored", reason: "x" });
    expect(calls).toEqual([]);
    expect(m.alert).not.toHaveBeenCalled();
    expect(m.subscriptionActive).not.toHaveBeenCalled();
  });
});
