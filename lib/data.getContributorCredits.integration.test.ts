// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { submissionsTable, facilityHistoryTable } from "@/lib/db/schema";
import type { DataCenterFacility, Source } from "@/lib/schema";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getContributorCredits } from "@/lib/data";

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeDoc(id: string): DataCenterFacility {
  return {
    id,
    name: `Facility ${id}`,
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2025-06-01",
  };
}

/** Inserts one approved submission with the given attribution and its matching facility_history row, against a freshly-seeded facility. */
async function seedApprovedCredit(
  tdb: TestDbHandle,
  facilityId: string,
  attribution: string
): Promise<void> {
  await seedFacility(tdb.db, makeDoc(facilityId));

  const [submission] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: "create",
      payload: {},
      status: "approved",
      provenance: {
        sources: ["https://ex/x"],
        discoveredBy: "public-contribution",
        attribution,
      },
    })
    .returning({ id: submissionsTable.id });

  await tdb.db.insert(facilityHistoryTable).values({
    facilityId,
    changeType: "create",
    diff: [],
    source: submission.id,
  });
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("getContributorCredits — case-insensitive dedupe (PGlite, real SQL)", () => {
  // THE PIN: two approved submissions whose attribution differs only in
  // case must collapse into ONE credit row with count 2 — never two rows
  // with count 1 each. This is the exact defect the raw (non-normalized)
  // `groupBy` produced: Postgres GROUP BY is case-sensitive, so "Jane Doe"
  // and "jane doe" are distinct groups unless the grouping key is itself
  // normalized. Mutation-tested: reverting getContributorCredits's
  // `.groupBy(normalizedAttribution)` back to `.groupBy(attribution)` makes
  // this test fail (observed 2 rows, count 1 each) before being restored —
  // see the C2 handoff notes for the before/after transcript.
  it("collapses two submissions attributed with different casing into one credit row with count 2", async () => {
    await seedApprovedCredit(tdb, "case-a", "Jane Doe");
    await seedApprovedCredit(tdb, "case-b", "jane doe");

    const credits = await getContributorCredits();

    expect(credits).toHaveLength(1);
    expect(credits[0].count).toBe(2);
    // Collation of the winning representative isn't pinned (PGlite's default
    // collation could sort either casing first) — what's pinned is that it's
    // ONE of the two real variants, not a third value, and that lowercasing
    // it recovers the shared identity both submissions attributed to.
    expect(["Jane Doe", "jane doe"]).toContain(credits[0].attribution);
    expect(credits[0].attribution.toLowerCase()).toBe("jane doe");
  });

  it("keeps two genuinely different handles as two separate credit rows", async () => {
    await seedApprovedCredit(tdb, "distinct-a", "Jane Doe");
    await seedApprovedCredit(tdb, "distinct-b", "John Smith");

    const credits = await getContributorCredits();

    expect(credits).toHaveLength(2);
    expect(credits.map((c) => c.count)).toEqual([1, 1]);
  });

  it("absorbs stray leading/trailing whitespace into the same credit as the untrimmed handle", async () => {
    await seedApprovedCredit(tdb, "whitespace-a", "Jane Doe");
    await seedApprovedCredit(tdb, "whitespace-b", "  Jane Doe  ");

    const credits = await getContributorCredits();

    expect(credits).toHaveLength(1);
    expect(credits[0].count).toBe(2);
  });
});
