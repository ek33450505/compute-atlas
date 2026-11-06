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
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";

// Imported after the mocks above so the mocked modules are in effect.
import { GET } from "./route";

let tdb: TestDbHandle;

const IP = "203.0.113.30";

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
});

function confirmReq(token: string, ip: string = IP): Request {
  return new Request(`http://localhost/api/access/confirm?token=${encodeURIComponent(token)}`, {
    headers: { "x-real-ip": ip },
  });
}

describe("GET /api/access/confirm", () => {
  it("redirects to /contact and activates nothing, even for a valid pending token", async () => {
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "reader@example.com",
      status: "pending",
      confirmToken: "good-token",
    });

    const res = await GET(confirmReq("good-token"));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).pathname).toBe("/contact");
    expect(location).not.toContain("token");

    const [row] = await tdb.db.select().from(apiAccessGrantsTable);
    expect(row.status).toBe("pending");
    expect(row.accessToken).toBeNull();
  });

  it("redirects an unknown token to /contact too", async () => {
    const res = await GET(confirmReq("bogus-token"));
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/contact");
  });

  it("sends both no-store headers on the redirect", async () => {
    const res = await GET(confirmReq("nostore-token"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });
});

describe("GET /api/access/confirm — rate limit", () => {
  it(`429s after ${API_RATE_LIMIT_MAX} requests from one IP, with both no-store headers`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await GET(confirmReq("burst-token"))).status).toBe(307);
    }

    const limited = await GET(confirmReq("burst-token"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("counts per IP — a different IP is unaffected by another's burst", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      await GET(confirmReq("burst-token", "198.51.100.21"));
    }

    expect((await GET(confirmReq("burst-token", "198.51.100.22"))).status).toBe(307);
  });

  // Namespaced buckets: ordinary page browsing (read API, keyed on the bare IP)
  // must not spend an API reader's one confirm click.
  it("does not share a bucket with the bare-IP key used by the read API", async () => {
    const { checkApiRateLimit } = await import("@/lib/api-rate-limit");
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      checkApiRateLimit(IP);
    }

    expect((await GET(confirmReq("post-readapi-token"))).status).toBe(307);
  });
});
