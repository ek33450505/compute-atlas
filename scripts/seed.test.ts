// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// vi.mock is hoisted above imports by Vitest — this swaps out the real Neon
// client for the one seed.ts's getDb() call resolves to, so seedFacilities()
// (which calls getDb() internally, matching lib/facility-write.ts's pattern)
// runs against the PGlite instance set up below.
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable } from "../lib/db/schema";
import type { DataCenterFacility, Source } from "../lib/schema";

// Imported after the mock above so the mocked ../lib/db/client is in effect.
import { seedFacilities } from "./seed";

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

describe("seedFacilities", () => {
  it("default (no force): inserts a new id and leaves a pre-existing row untouched even when the JSON differs", async () => {
    const originalDoc = makeDoc({
      id: "existing-facility",
      name: "Original Name",
      status: "under_construction",
    });
    await seedFacility(tdb.db, originalDoc);

    const differingJsonDoc = makeDoc({
      id: "existing-facility",
      name: "Changed In JSON",
      status: "operational",
    });
    const newDoc = makeDoc({ id: "brand-new-facility", name: "New Facility" });

    const result = await seedFacilities([differingJsonDoc, newDoc], { force: false });

    expect(result.insertedCount).toBe(1);
    expect(result.skippedExistingCount).toBe(1);
    expect(result.forcedOverwriteCount).toBe(0);
    expect(result.forced).toBe(false);

    const existingRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "existing-facility"));
    expect(existingRows).toHaveLength(1);
    expect(existingRows[0].name).toBe("Original Name");
    expect(existingRows[0].status).toBe("under_construction");

    const newRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "brand-new-facility"));
    expect(newRows).toHaveLength(1);
    expect(newRows[0].name).toBe("New Facility");
  });

  it("--force: overwrites the pre-existing row from JSON", async () => {
    const originalDoc = makeDoc({
      id: "existing-facility",
      name: "Original Name",
      status: "under_construction",
    });
    await seedFacility(tdb.db, originalDoc);

    const differingJsonDoc = makeDoc({
      id: "existing-facility",
      name: "Changed In JSON",
      status: "operational",
    });
    const newDoc = makeDoc({ id: "brand-new-facility", name: "New Facility" });

    const result = await seedFacilities([differingJsonDoc, newDoc], { force: true });

    expect(result.insertedCount).toBe(1);
    expect(result.forcedOverwriteCount).toBe(1);
    expect(result.skippedExistingCount).toBe(0);
    expect(result.forced).toBe(true);

    const existingRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "existing-facility"));
    expect(existingRows).toHaveLength(1);
    expect(existingRows[0].name).toBe("Changed In JSON");
    expect(existingRows[0].status).toBe("operational");
  });

  it("reports neonOnlyCount for DB rows absent from the JSON, without modifying them", async () => {
    const dbOnlyDoc = makeDoc({ id: "db-only-facility", name: "DB Only" });
    await seedFacility(tdb.db, dbOnlyDoc);

    const newDoc = makeDoc({ id: "brand-new-facility", name: "New Facility" });

    const result = await seedFacilities([newDoc], { force: false });

    expect(result.neonOnlyCount).toBe(1);
    expect(result.insertedCount).toBe(1);

    const dbOnlyRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "db-only-facility"));
    expect(dbOnlyRows).toHaveLength(1);
    expect(dbOnlyRows[0].name).toBe("DB Only");
  });
});
