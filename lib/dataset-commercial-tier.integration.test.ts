// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

import { liveGrant } from "@/lib/dataset-grants";
import { commercialCheckoutsTable, DATASET_TIERS, datasetAccessGrantsTable, paypalWebhookEventsTable } from "@/lib/db/schema";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

/**
 * Commercial tier (drizzle/0021_commercial_tier.sql): the payment gate inside `liveGrant`, and the
 * unique indexes the PayPal webhook relies on, plus the commercial_checkouts constraints.
 */

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);

let seq = 0;

function grantValues(
  overrides: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}
): typeof datasetAccessGrantsTable.$inferInsert {
  seq++;
  return {
    email: `buyer-${seq}@example.com`,
    name: "Test Buyer",
    category: "commercial",
    intendedUse: "Market research.",
    attributionAckAt: NOW,
    termsVersion: "2026-11-09",
    verifyTokenHash: `verify-hash-${seq}`,
    status: "active",
    expiresAt: daysFromNow(30),
    ...overrides,
  };
}

/** Whether `liveGrant(NOW)` selects the grant, evaluated by Postgres as the real queries do. */
async function isLive(overrides: Partial<typeof datasetAccessGrantsTable.$inferInsert>): Promise<boolean> {
  const [row] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues(overrides)).returning();
  const rows = await tdb.db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(liveGrant(NOW));
  return rows.some((r) => r.id === row.id);
}

/** The Postgres SQLSTATE a failed insert raised, or undefined if it succeeded. */
async function sqlState(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe("liveGrant: payment gate", () => {
  it("exports the tier vocabulary", () => {
    expect(DATASET_TIERS).toEqual(["free", "commercial"]);
  });

  it("a free grant with no paid_through stays live (default tier backfills to free)", async () => {
    const [row] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    expect(row.tier).toBe("free");
    expect(row.paidThrough).toBeNull();
    expect(await isLive({ tier: "free" })).toBe(true);
  });

  it("a commercial active grant with paid_through NULL is not live", async () => {
    expect(await isLive({ tier: "commercial", paidThrough: null })).toBe(false);
  });

  it("a commercial grant with paid_through in the future is live", async () => {
    expect(await isLive({ tier: "commercial", paidThrough: daysFromNow(10) })).toBe(true);
  });

  it("a commercial grant with paid_through in the past is not live", async () => {
    expect(await isLive({ tier: "commercial", paidThrough: daysFromNow(-1) })).toBe(false);
  });

  it("a commercial grant past expires_at is not live even if paid", async () => {
    expect(await isLive({ tier: "commercial", paidThrough: daysFromNow(10), expiresAt: daysFromNow(-1) })).toBe(false);
  });

  it("a paid commercial grant that is not active is not live", async () => {
    expect(await isLive({ tier: "commercial", paidThrough: daysFromNow(10), status: "revoked" })).toBe(false);
  });
});

describe("commercial tier: unique indexes", () => {
  it("rejects a duplicate paypal_subscription_id", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ paypalSubscriptionId: "I-SUB1" }));
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ paypalSubscriptionId: "I-SUB1" }))
    );
    expect(code).toBe("23505");
  });

  it("allows many grants with NULL paypal_subscription_id", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues());
    expect(await sqlState(tdb.db.insert(datasetAccessGrantsTable).values(grantValues()))).toBeUndefined();
  });

  it("allows one free and one commercial open grant per email, never two of one tier", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ email: "same@example.com", tier: "free" }));
    expect(
      await sqlState(tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ email: "same@example.com", tier: "commercial" })))
    ).toBeUndefined();
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ email: "same@example.com", tier: "commercial" }))
    );
    expect(code).toBe("23505");
  });
});

describe("paypal_webhook_events", () => {
  it("rejects a duplicate event id", async () => {
    await tdb.db.insert(paypalWebhookEventsTable).values({ id: "WH-1", eventType: "BILLING.SUBSCRIPTION.ACTIVATED" });
    const code = await sqlState(tdb.db.insert(paypalWebhookEventsTable).values({ id: "WH-1", eventType: "BILLING.SUBSCRIPTION.ACTIVATED" }));
    expect(code).toBe("23505");
  });

  it("nulls grant_id when the grant is deleted", async () => {
    const [grant] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    await tdb.db.insert(paypalWebhookEventsTable).values({ id: "WH-2", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", grantId: grant.id });
    await tdb.client.query(`DELETE FROM "dataset_access_grants" WHERE id = $1`, [grant.id]);
    const [event] = await tdb.db.select().from(paypalWebhookEventsTable);
    expect(event.grantId).toBeNull();
  });
});

describe("commercial_checkouts", () => {
  const base = { plan: "monthly" as const, termsVersion: "2026-11-09" };

  it("accepts a pending attempt with no decision and no reason", async () => {
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values(base))).toBeUndefined();
  });

  it("rejects an unknown plan", async () => {
    const code = await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, plan: "weekly" as "monthly" }));
    expect(code).toBe("23514");
  });

  it("requires a reason exactly when the decision is refuse", async () => {
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, decision: "refuse" }))).toBe("23514");
    expect(
      await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, decision: "activate", reason: "revoked_buyer" }))
    ).toBe("23514");
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, reason: "revoked_buyer" }))).toBe("23514");
    expect(
      await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, decision: "refuse", reason: "revoked_buyer" }))
    ).toBeUndefined();
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, decision: "activate" }))).toBeUndefined();
  });

  it("rejects a duplicate paypal_subscription_id but allows many nulls", async () => {
    await tdb.db.insert(commercialCheckoutsTable).values({ ...base, paypalSubscriptionId: "I-A" });
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values({ ...base, paypalSubscriptionId: "I-A" }))).toBe("23505");
    await tdb.db.insert(commercialCheckoutsTable).values(base);
    expect(await sqlState(tdb.db.insert(commercialCheckoutsTable).values(base))).toBeUndefined();
  });

  it("nulls grant_id and conflict_grant_id when the grant is deleted", async () => {
    const [grant] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    await tdb.db
      .insert(commercialCheckoutsTable)
      .values({ ...base, decision: "refuse", reason: "already_subscribed", grantId: grant.id, conflictGrantId: grant.id });
    await tdb.client.query(`DELETE FROM "dataset_access_grants" WHERE id = $1`, [grant.id]);
    const [row] = await tdb.db.select().from(commercialCheckoutsTable);
    expect(row.grantId).toBeNull();
    expect(row.conflictGrantId).toBeNull();
  });
});
