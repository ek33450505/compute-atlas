// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable, facilityHistoryTable, submissionsTable } from "@/lib/db/schema";
import type { DataCenterFacility, Source } from "@/lib/schema";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { approveSubmission } from "@/lib/submissions";

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
    id: "submissions-status-update-test-facility",
    name: "Submissions Status Update Test Facility",
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

async function insertSubmission(values: {
  kind: "create" | "update" | "status_update";
  targetFacilityId?: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const [row] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: values.kind,
      targetFacilityId: values.targetFacilityId,
      payload: values.payload,
      provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
      status: "pending",
    })
    .returning({ id: submissionsTable.id });
  return row.id;
}

describe("approveSubmission (kind: status_update)", () => {
  it("promotes a pending status_update submission: applies the intent and marks the submission approved", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "status_update",
      targetFacilityId: seedDoc.id,
      payload: {
        status: "operational",
        date: "2026-07-16",
        sources: [makeSource("corroboration")],
      },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facility.status).toBe("operational");
    expect(result.facility.sources).toHaveLength(2);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.status).toBe("operational");

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("approved");

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
    expect(historyRows[0].source).toBe(id);
  });

  it("leaves the submission pending when the status_update payload is invalid", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "status_update",
      targetFacilityId: seedDoc.id,
      payload: { status: "operational", date: "2026-07-16", sources: [] },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(false);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("pending");
  });
});
