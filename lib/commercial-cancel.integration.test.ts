// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const paypal = vi.hoisted(() => ({ cancelSubscription: vi.fn() }));
vi.mock("@/lib/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal")>()),
  ...paypal,
}));

import { cancelOwnSubscription, SUBSCRIBER_CANCEL_REASON } from "@/lib/commercial-cancel";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { PayPalApiError } from "@/lib/paypal";
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
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS);
const TOKEN = "Zk3_-" + "A".repeat(38);
const SUB = "I-ABC123456";

let seq = 0;
async function makeGrant(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  seq++;
  await tdb.db.insert(datasetAccessGrantsTable).values({
    email: `buyer-${seq}@example.com`,
    name: "Buyer",
    category: "commercial",
    intendedUse: "Research.",
    attributionAckAt: NOW,
    termsVersion: "2026-11-09",
    verifyTokenHash: `verify-${seq}`,
    status: "active",
    expiresAt: inDays(60),
    tier: "commercial",
    paidThrough: inDays(20),
    paypalSubscriptionId: SUB,
    accessTokenHash: hashToken(TOKEN),
    ...over,
  });
}

const run = (token = TOKEN) => cancelOwnSubscription(token, { db: tdb.db, now: NOW });

beforeEach(async () => {
  await tdb.reset();
  paypal.cancelSubscription.mockReset();
  paypal.cancelSubscription.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cancelOwnSubscription", () => {
  it("cancels a live commercial grant's subscription with the reason and returns paid_through", async () => {
    await makeGrant();
    const res = await run();
    expect(res).toEqual({ ok: true, paidThrough: inDays(20) });
    expect(paypal.cancelSubscription).toHaveBeenCalledExactlyOnceWith(SUB, SUBSCRIBER_CANCEL_REASON);
    expect(SUBSCRIBER_CANCEL_REASON).toBe("Cancelled by subscriber");
  });

  it("does not cut access: the grant row is unchanged", async () => {
    await makeGrant();
    await run();
    const [row] = await tdb.db.select().from(datasetAccessGrantsTable);
    expect(row.status).toBe("active");
    expect(row.paidThrough).toEqual(inDays(20));
  });

  it("treats PayPal's already-inactive answer as success", async () => {
    await makeGrant();
    paypal.cancelSubscription.mockResolvedValue({ ok: true, alreadyInactive: true });
    expect((await run()).ok).toBe(true);
  });

  it.each([
    ["a free grant", { tier: "free" as const }],
    ["a grant with no subscription id", { paypalSubscriptionId: null }],
    ["a revoked grant", { status: "revoked" as const }],
    ["a lapsed grant (paid_through past)", { paidThrough: inDays(-1) }],
    ["a never-paid grant (paid_through null)", { paidThrough: null }],
    ["an expired grant", { expiresAt: inDays(-1) }],
  ])("is { ok: false } and never calls PayPal for %s", async (_n, over) => {
    await makeGrant(over);
    expect(await run()).toEqual({ ok: false });
    expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  });

  it("is { ok: false } for an unknown token and a malformed one", async () => {
    await makeGrant();
    expect(await run("B".repeat(43))).toEqual({ ok: false });
    expect(await run("short")).toEqual({ ok: false });
    expect(paypal.cancelSubscription).not.toHaveBeenCalled();
  });

  it("is { ok: false } when PayPal errors, logging a code and never the id or token", async () => {
    await makeGrant();
    paypal.cancelSubscription.mockRejectedValue(new PayPalApiError(500, "X", "dbg-1"));
    expect(await run()).toEqual({ ok: false });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("paypal");
    expect(logged).not.toContain(SUB);
    expect(logged).not.toContain(TOKEN);
  });
});
