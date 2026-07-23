// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import { revalidateTag } from "next/cache";
import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable, facilityHistoryTable } from "@/lib/db/schema";
import type { DataCenterFacility, PowerGenerationFacility, Source } from "@/lib/schema";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { createFacility, deleteFacility, updateFacility, writeStatusUpdate } from "@/lib/facility-write";

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeSeedDoc(): DataCenterFacility {
  return {
    id: "status-update-test-facility",
    name: "Status Update Test Facility",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [{ status: "permitted", date: "2025-06-01", sourceIndex: 0 }],
    sources: [makeSource("s0"), makeSource("s1"), makeSource("s2"), makeSource("s3")],
    community: { status: "supported", sourceIndex: 3 },
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

describe("writeStatusUpdate", () => {
  it("applies a status_update intent, appends the source, and preserves an existing sourceIndex reference (community)", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);

    const result = await writeStatusUpdate(seedDoc.id, {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("new-corroborating-source")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.facility.status).toBe("operational");
    expect(result.facility.sources).toHaveLength(5);
    expect(result.facility.community?.sourceIndex).toBe(3);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.status).toBe("operational");
    expect(facilityRows[0].doc.sources).toHaveLength(5);

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
  });

  it("404s when the facility id does not exist", async () => {
    const result = await writeStatusUpdate("does-not-exist", {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("s0")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("400s on a malformed intent (empty sources array)", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);

    const result = await writeStatusUpdate(seedDoc.id, {
      status: "operational",
      date: "2026-07-16",
      sources: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("regression: existing sourceIndex-bearing fields (statusHistory, community) survive a status_update untouched", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);

    const result = await writeStatusUpdate(seedDoc.id, {
      status: "operational",
      date: "2026-07-16",
      sources: [makeSource("new-corroborating-source")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Original statusHistory entry (index 0, sourceIndex 0) is untouched.
    expect(result.facility.statusHistory[0]).toEqual({
      status: "permitted",
      date: "2025-06-01",
      sourceIndex: 0,
    });
    // The newly appended entry points at the first appended source (index 4).
    const appended = result.facility.statusHistory[result.facility.statusHistory.length - 1];
    expect(appended.sourceIndex).toBe(4);
    // community.sourceIndex still resolves within the (now-grown) sources array.
    expect(result.facility.community?.sourceIndex).toBe(3);
    expect(result.facility.sources[3]).toEqual(seedDoc.sources[3]);
  });
});

describe("revalidateForFacility (scoped tag invalidation, not the old global nuke)", () => {
  it("createFacility busts facility:<id> and state:<STATE>, never the old global 'facilities' tag", async () => {
    const doc = makeSeedDoc();
    const result = await createFacility(doc);
    expect(result.ok).toBe(true);

    const calledTags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(calledTags).toContain(`facility:${doc.id}`);
    expect(calledTags).toContain(`state:${doc.location.state}`);
    expect(calledTags).not.toContain("facilities");
  });

  it("updateFacility busts the state tag for both old and new state when the state changes", async () => {
    const seedDoc = makeSeedDoc(); // location.state: "GA"
    await seedFacility(tdb.db, seedDoc);

    const result = await updateFacility(seedDoc.id, {
      location: { ...seedDoc.location, state: "SC" },
    });
    expect(result.ok).toBe(true);

    const calledTags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(calledTags).toContain(`facility:${seedDoc.id}`);
    expect(calledTags).toContain("state:SC");
    expect(calledTags).toContain("state:GA");
    expect(calledTags).not.toContain("facilities");
  });

  it("deleteFacility busts facility:<id> and state:<STATE> using the deleted doc", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);

    const result = await deleteFacility(seedDoc.id);
    expect(result.ok).toBe(true);

    const calledTags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(calledTags).toContain(`facility:${seedDoc.id}`);
    expect(calledTags).toContain(`state:${seedDoc.location.state}`);
    expect(calledTags).not.toContain("facilities");
  });

  it("createFacility busts the power-generation tag when the new doc is a power_generation facility", async () => {
    const doc: PowerGenerationFacility = {
      id: "power-gen-tag-test-plant",
      name: "Tag Test Plant",
      operator: "Test Utility",
      facilityType: "power_generation",
      status: "operational",
      confidence: "confirmed",
      location: { lat: 34.0, lon: -83.0, state: "GA", precision: "exact" },
      statusHistory: [],
      sources: [makeSource("s0")],
      lastUpdated: "2026-01-01",
    };

    const result = await createFacility(doc);
    expect(result.ok).toBe(true);

    const calledTags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(calledTags).toContain("power-generation");
    expect(calledTags).not.toContain("facilities");
  });
});
