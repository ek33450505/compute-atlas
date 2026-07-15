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
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable, submissionsTable } from "@/lib/db/schema";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/submissions.ts -> lib/db/client.ts) resolve against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body?: unknown): Request {
  return new Request("http://localhost/api/submissions/x/reject", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

async function insertPendingSubmission(): Promise<string> {
  const [row] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: "create",
      payload: seedDoc,
      provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
    })
    .returning({ id: submissionsTable.id });
  return row.id;
}

describe("POST /api/submissions/[id]/reject (authorized happy path)", () => {
  it("rejects a pending submission with a reason and writes no facility row", async () => {
    const id = await insertPendingSubmission();

    const res = await POST(req({ reason: "duplicate of an existing facility" }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("rejected");
    expect(submissionRows[0].reviewNote).toBe("duplicate of an existing facility");

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows).toHaveLength(0);
  });

  it("400s a reject with an empty reason", async () => {
    const id = await insertPendingSubmission();

    const res = await POST(req({ reason: "" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("pending");
  });

  it("400s a reject with a missing reason field", async () => {
    const id = await insertPendingSubmission();

    const res = await POST(req({}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });
});
