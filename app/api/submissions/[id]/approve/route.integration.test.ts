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
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/submissions.ts -> lib/facility-write.ts -> lib/db/client.ts) resolve
// against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn, status: operational

function req(): Request {
  return new Request("http://localhost/api/submissions/x/approve", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

let tdb: TestDbHandle;

beforeAll(async () => {
  process.env.API_ADMIN_TOKEN = "test-token";
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
  kind: "create" | "update";
  targetFacilityId?: string;
  payload: Record<string, unknown>;
  status?: string;
}): Promise<string> {
  const [row] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: values.kind,
      targetFacilityId: values.targetFacilityId,
      payload: values.payload,
      provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
      status: values.status ?? "pending",
    })
    .returning({ id: submissionsTable.id });
  return row.id;
}

describe("POST /api/submissions/[id]/approve (authorized happy path)", () => {
  it("promotes a create submission to a live facility and records facility_history", async () => {
    const id = await insertSubmission({ kind: "create", payload: seedDoc });

    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows).toHaveLength(1);

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("create");
    expect(historyRows[0].source).toBe(id);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("approved");
  });

  it("promotes an update submission's patch onto an existing facility and records the update in facility_history", async () => {
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
    });

    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.status).toBe("under_construction");

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
    expect(historyRows[0].source).toBe(id);
  });

  it("404s approving a non-existent submission id", async () => {
    const res = await POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("409s approving an already-approved submission", async () => {
    const id = await insertSubmission({ kind: "create", payload: seedDoc, status: "approved" });
    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
  });
});
