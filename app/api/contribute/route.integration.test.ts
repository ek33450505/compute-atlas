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
import { submissionsTable } from "@/lib/db/schema";
import { hashIp } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/contribute.ts, lib/rate-limit.ts, lib/data.ts -> lib/db/client.ts)
// resolve against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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

const validCreateBody = {
  kind: "create" as const,
  name: "New Facility",
  operator: "Acme Compute",
  state: "TX",
  lat: 30.5,
  lon: -97.5,
  sourceUrl: "https://example.com/article",
};

describe("POST /api/contribute (public, unauthenticated happy path)", () => {
  it("stages a pending create submission with public-contribution provenance", async () => {
    const res = await POST(req(validCreateBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("create");
    expect(
      (rows[0].provenance as { discoveredBy?: string }).discoveredBy
    ).toBe("public-contribution");
  });

  it("honeypot: returns 201 ok but inserts zero submission rows", async () => {
    const res = await POST(req({ ...validCreateBody, website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(0);
  });

  it("rate-limits a 6th submission from the same ip within the window", async () => {
    const ip = "203.0.113.7";
    const ipHash = hashIp(ip);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(submissionsTable).values({
        kind: "create",
        payload: seedDoc,
        provenance: { sources: ["https://example.com/x"], discoveredBy: "test", submitterIpHash: ipHash },
      });
    }

    const res = await POST(req(validCreateBody, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(5); // the 6th attempt must not have landed
  });

  it("correction: stages a pending update submission targeting an existing facility", async () => {
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(
      req({
        kind: "correction",
        targetFacilityId: seedDoc.id,
        field: "operator",
        value: "New Op",
        sourceUrl: "https://example.com/correction",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("update");
    expect(rows[0].targetFacilityId).toBe(seedDoc.id);
    expect((rows[0].payload as { operator?: string }).operator).toBe("New Op");

    const submissionsAfter = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.targetFacilityId, seedDoc.id));
    expect(submissionsAfter).toHaveLength(1);
  });
});
