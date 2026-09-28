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

// Sharper here than on the sibling subscribe routes: the success redirect's
// `Location` carries the minted access token itself, and a Cloudflare cache rule
// makes every non-`/admin` GET cache-eligible — with no origin directive
// Cloudflare supplies `public, max-age=14400` (measured on the subscribe routes
// 2026-09-27), which would hand that token to the next caller of the same URL.
describe("GET /api/access/confirm — uncacheable", () => {
  it("sends both no-store headers on the success redirect", async () => {
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "reader@example.com",
      status: "pending",
      confirmToken: "nostore-token",
    });

    const res = await GET(confirmReq("nostore-token"));

    expect(res.headers.get("location")).toContain("#token=");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("sends both no-store headers on the invalid redirect", async () => {
    const res = await GET(confirmReq("nope-not-a-token"));

    expect(res.headers.get("location")).toContain("/access/invalid");
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
