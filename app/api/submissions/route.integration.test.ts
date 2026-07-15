// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import { eq } from "drizzle-orm";

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { submissionsTable } from "@/lib/db/schema";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/submissions.ts -> lib/db/client.ts) resolve against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body: unknown): Request {
  return new Request("http://localhost/api/submissions", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

describe("POST /api/submissions (authorized happy path)", () => {
  it("stages a pending create submission and persists it in the DB", async () => {
    const res = await POST(
      req({
        kind: "create",
        payload: seedDoc,
        provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();

    const rows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("create");
  });
});
