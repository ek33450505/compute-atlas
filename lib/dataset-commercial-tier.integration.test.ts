// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

import { liveGrant } from "@/lib/dataset-grants";
import { DATASET_TIERS, datasetAccessGrantsTable, stripeEventsTable } from "@/lib/db/schema";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

/**
 * Commercial tier (drizzle/0021_commercial_tier.sql): the payment gate inside `liveGrant`, and the
 * unique indexes the Stripe webhook relies on.
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
  it("rejects a duplicate stripe_subscription_id", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ stripeSubscriptionId: "sub_1" }));
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ stripeSubscriptionId: "sub_1" }))
    );
    expect(code).toBe("23505");
  });

  it("rejects a duplicate stripe_checkout_session_id", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ stripeCheckoutSessionId: "cs_1" }));
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ stripeCheckoutSessionId: "cs_1" }))
    );
    expect(code).toBe("23505");
  });

  it("allows many grants with NULL stripe_subscription_id and stripe_checkout_session_id", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues());
    expect(await sqlState(tdb.db.insert(datasetAccessGrantsTable).values(grantValues()))).toBeUndefined();
  });
});

describe("stripe_events", () => {
  it("rejects a duplicate event id", async () => {
    await tdb.db.insert(stripeEventsTable).values({ id: "evt_1", type: "invoice.paid" });
    const code = await sqlState(tdb.db.insert(stripeEventsTable).values({ id: "evt_1", type: "invoice.paid" }));
    expect(code).toBe("23505");
  });

  it("nulls grant_id when the grant is deleted", async () => {
    const [grant] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    await tdb.db.insert(stripeEventsTable).values({ id: "evt_2", type: "invoice.paid", grantId: grant.id });
    await tdb.client.query(`DELETE FROM "dataset_access_grants" WHERE id = $1`, [grant.id]);
    const [event] = await tdb.db.select().from(stripeEventsTable);
    expect(event.grantId).toBeNull();
  });
});
