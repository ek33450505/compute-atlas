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
import { getRecentActivity } from "@/lib/data";

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

describe("getRecentActivity — attribution LEFT JOIN (PGlite)", () => {
  it("surfaces the attribution from the submission's provenance when the history row's source matches a submission id", async () => {
    const doc = makeDoc("attribution-join-facility");
    await seedFacility(tdb.db, doc);

    const [submission] = await tdb.db
      .insert(submissionsTable)
      .values({
        kind: "create",
        payload: {},
        status: "approved",
        provenance: {
          sources: ["https://ex/x"],
          discoveredBy: "public-contribution",
          attribution: "gridwatcher",
        },
      })
      .returning({ id: submissionsTable.id });

    await tdb.db.insert(facilityHistoryTable).values({
      facilityId: doc.id,
      changeType: "create",
      diff: [],
      source: submission.id,
    });

    const entries = await getRecentActivity(10);
    const entry = entries.find((e) => e.facilityId === doc.id);
    expect(entry).toBeDefined();
    expect(entry?.attribution).toBe("gridwatcher");
  });

  it("leaves attribution undefined for an admin-direct history row (no matching submission), without crashing", async () => {
    const doc = makeDoc("admin-direct-facility");
    await seedFacility(tdb.db, doc);

    await tdb.db.insert(facilityHistoryTable).values({
      facilityId: doc.id,
      changeType: "create",
      diff: [],
      source: "admin-direct",
    });

    const entries = await getRecentActivity(10);
    const entry = entries.find((e) => e.facilityId === doc.id);
    expect(entry).toBeDefined();
    expect(entry?.attribution).toBeUndefined();
  });
});
