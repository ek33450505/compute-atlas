// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findLiveCommercialGrant } from "@/lib/commercial-conflicts";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

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
const inDays = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);

let seq = 0;
async function insertGrant(overrides: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}): Promise<string> {
  seq++;
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `buyer-${seq}@example.com`,
      name: "Buyer",
      category: "commercial",
      intendedUse: "Research.",
      attributionAckAt: NOW,
      termsVersion: "2026-11-10",
      verifyTokenHash: `verify-${seq}`,
      tier: "commercial",
      status: "active",
      expiresAt: inDays(30),
      paidThrough: inDays(30),
      paypalSubscriptionId: `I-SUB${seq}`,
      ...overrides,
    })
    .returning({ id: datasetAccessGrantsTable.id });
  return row.id;
}

describe("findLiveCommercialGrant", () => {
  it("returns null when nothing matches", async () => {
    await insertGrant({ email: "other@example.com" });
    expect(await findLiveCommercialGrant(tdb.db, { email: "a@example.com", now: NOW })).toBeNull();
  });

  it("finds a live commercial grant of another subscription", async () => {
    const id = await insertGrant({ email: "a@example.com", paypalSubscriptionId: "I-LIVE1" });
    expect(await findLiveCommercialGrant(tdb.db, { email: "a@example.com", excludeSubscriptionId: "I-NEW1", now: NOW })).toEqual({ grantId: id });
    expect(await findLiveCommercialGrant(tdb.db, { email: "a@example.com", now: NOW })).toEqual({ grantId: id });
  });

  it("does not conflict with the subscription's own grant", async () => {
    await insertGrant({ email: "a@example.com", paypalSubscriptionId: "I-SAME1" });
    expect(await findLiveCommercialGrant(tdb.db, { email: "a@example.com", excludeSubscriptionId: "I-SAME1", now: NOW })).toBeNull();
  });

  it("ignores lapsed, unpaid, revoked, free-tier and other-address grants", async () => {
    await insertGrant({ email: "a@example.com", paidThrough: inDays(-1), expiresAt: inDays(-1) });
    await insertGrant({ email: "a@example.com", paidThrough: null, status: "expired" });
    await insertGrant({ email: "a@example.com", status: "revoked", revokedAt: NOW });
    await insertGrant({ email: "a@example.com", tier: "free", paypalSubscriptionId: null, paidThrough: null });
    await insertGrant({ email: "b@example.com" });
    expect(await findLiveCommercialGrant(tdb.db, { email: "a@example.com", now: NOW })).toBeNull();
  });
});
