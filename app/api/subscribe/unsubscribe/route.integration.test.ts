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
import { subscriptionsTable } from "@/lib/db/schema";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, POST } from "./route";

let tdb: TestDbHandle;

const TOKEN = "unsub-token-abc";
const IP = "203.0.113.20";

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
  await tdb.db.insert(subscriptionsTable).values({
    email: "reader@example.com",
    targetType: "state",
    targetId: "TN",
    status: "confirmed",
    confirmedAt: new Date(),
    confirmToken: "unsub-route-confirm-tok",
    unsubscribeToken: TOKEN,
  });
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
});

function unsubReq(token: string, ip: string = IP, method: "GET" | "POST" = "GET"): Request {
  return new Request(
    `http://localhost/api/subscribe/unsubscribe?token=${encodeURIComponent(token)}`,
    { method, headers: { "x-real-ip": ip } }
  );
}

describe("GET /api/subscribe/unsubscribe", () => {
  it("unsubscribes the row and redirects, with both no-store headers", async () => {
    const res = await GET(unsubReq(TOKEN));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/subscribe/unsubscribed");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");

    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("unsubscribed");
  });

  it("sends both no-store headers on the invalid-token redirect too", async () => {
    const res = await GET(unsubReq("not-a-real-token"));

    expect(res.headers.get("location")).toContain("/subscribe/invalid");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it(`429s after ${API_RATE_LIMIT_MAX} requests from one IP, with both no-store headers`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await GET(unsubReq(TOKEN))).status).toBe(307);
    }

    const limited = await GET(unsubReq(TOKEN));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("counts per IP — a different IP is unaffected by another's burst", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      await GET(unsubReq(TOKEN, "198.51.100.11"));
    }

    expect((await GET(unsubReq(TOKEN, "198.51.100.12"))).status).toBe(307);
  });

  // Namespaced buckets: ordinary page browsing (read API, keyed on the bare IP)
  // must not spend a subscriber's one unsubscribe click.
  it("does not share a bucket with the bare-IP key used by the read API", async () => {
    const { checkApiRateLimit } = await import("@/lib/api-rate-limit");
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      checkApiRateLimit(IP);
    }

    expect((await GET(unsubReq(TOKEN))).status).toBe(307);
  });
});

describe("POST /api/subscribe/unsubscribe (RFC 8058 one-click)", () => {
  it("unsubscribes the row and answers 200 with both no-store headers", async () => {
    const res = await POST(unsubReq(TOKEN, IP, "POST"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");

    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("unsubscribed");
  });

  it("answers 200 for an unknown token too (no oracle), still no-store", async () => {
    const res = await POST(unsubReq("not-a-real-token", IP, "POST"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it(`429s after ${API_RATE_LIMIT_MAX} requests from one IP`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await POST(unsubReq(TOKEN, IP, "POST"))).status).toBe(200);
    }

    const limited = await POST(unsubReq(TOKEN, IP, "POST"));
    expect(limited.status).toBe(429);
  });

  // One surface, one budget: GET and POST share the prefix on purpose, so an
  // attacker can't get 2x the work by alternating methods.
  it("shares its budget with the GET handler", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await GET(unsubReq(TOKEN))).status).toBe(307);
    }

    expect((await POST(unsubReq(TOKEN, IP, "POST"))).status).toBe(429);
  });
});
