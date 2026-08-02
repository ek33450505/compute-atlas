// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// vi.mock is hoisted above imports by Vitest — this swaps out the real Neon
// client for the one backfill-facility-history.ts's getDb() call resolves
// to, so backfillFacilityHistory() (which calls getDb() internally,
// matching scripts/seed.ts's pattern) runs against the PGlite instance set
// up below.
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable, facilityHistoryTable } from "../lib/db/schema";
import type { DataCenterFacility, Source } from "../lib/schema";

// Imported after the mock above so the mocked ../lib/db/client is in effect.
import { backfillFacilityHistory } from "./backfill-facility-history";

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeDoc(overrides: Partial<DataCenterFacility> & { id: string }): DataCenterFacility {
  return {
    name: "Test Facility",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2025-06-01",
    ...overrides,
  };
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("backfillFacilityHistory", () => {
  it("backfills a 'create' row for a history-less facility, with changedAt set to the facility's updatedAt", async () => {
    const doc = makeDoc({ id: "seed-only-facility" });
    await seedFacility(tdb.db, doc);

    const [facilityRow] = await tdb.db
      .select({ updatedAt: facilitiesTable.updatedAt })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "seed-only-facility"));

    const result = await backfillFacilityHistory({ dryRun: false });

    expect(result.backfilledCount).toBe(1);
    expect(result.alreadyHadHistoryCount).toBe(0);

    const history = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, "seed-only-facility"));
    expect(history).toHaveLength(1);
    expect(history[0].changeType).toBe("create");
    expect(history[0].source).toBe("db-seed-backfill");
    expect(history[0].changedAt.getTime()).toBe(facilityRow.updatedAt.getTime());
  });

  it("is idempotent: a second run backfills nothing further and leaves exactly one history row", async () => {
    const doc = makeDoc({ id: "seed-only-facility" });
    await seedFacility(tdb.db, doc);

    const firstResult = await backfillFacilityHistory({ dryRun: false });
    expect(firstResult.backfilledCount).toBe(1);

    const secondResult = await backfillFacilityHistory({ dryRun: false });
    expect(secondResult.backfilledCount).toBe(0);
    expect(secondResult.alreadyHadHistoryCount).toBe(1);

    const history = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, "seed-only-facility"));
    expect(history).toHaveLength(1);
  });

  it("--dry-run computes a count but writes nothing", async () => {
    const doc = makeDoc({ id: "seed-only-facility" });
    await seedFacility(tdb.db, doc);

    const result = await backfillFacilityHistory({ dryRun: true });

    expect(result.backfilledCount).toBe(0);
    expect(result.alreadyHadHistoryCount).toBe(0);

    const history = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, "seed-only-facility"));
    expect(history).toHaveLength(0);
  });
});
