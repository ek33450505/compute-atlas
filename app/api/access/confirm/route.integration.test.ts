// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable } from "@/lib/db/schema";

// Imported after the mocks above so the mocked modules are in effect.
import { GET } from "./route";

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

function confirmReq(token: string): Request {
  return new Request(`http://localhost/api/access/confirm?token=${encodeURIComponent(token)}`);
}

describe("GET /api/access/confirm", () => {
  it("redirects to /access/confirmed#token=... and activates the grant on a valid token", async () => {
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "reader@example.com",
      status: "pending",
      confirmToken: "good-token",
    });

    const res = await GET(confirmReq("good-token"));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/access/confirmed#token=");
    expect(location).not.toContain("?token="); // never a query param

    const [row] = await tdb.db.select().from(apiAccessGrantsTable);
    expect(row.status).toBe("active");
    expect(row.accessToken).not.toBeNull();
  });

  it("redirects to /access/invalid for an unknown token", async () => {
    const res = await GET(confirmReq("bogus-token"));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/access/invalid");
  });

  it("redirects to /access/invalid on a second confirm of the same token (single-use)", async () => {
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "reader@example.com",
      status: "pending",
      confirmToken: "one-time-token",
    });

    const first = await GET(confirmReq("one-time-token"));
    expect(first.headers.get("location") ?? "").toContain("/access/confirmed#token=");

    const second = await GET(confirmReq("one-time-token"));
    expect(second.headers.get("location") ?? "").toContain("/access/invalid");
  });
});
