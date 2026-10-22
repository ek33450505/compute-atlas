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
import { emailSuppressionsTable, subscriptionsTable } from "@/lib/db/schema";
import { isSuppressed } from "@/lib/suppressions";
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

const ONE_CLICK = "List-Unsubscribe=One-Click";

function unsubReq(
  token: string,
  ip: string = IP,
  method: "GET" | "POST" = "GET",
  body?: string,
  extra = ""
): Request {
  return new Request(
    `http://localhost/api/subscribe/unsubscribe?token=${encodeURIComponent(token)}${extra}`,
    {
      method,
      headers: {
        "x-real-ip": ip,
        ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
    }
  );
}

async function rowStatus(): Promise<string> {
  const [row] = await tdb.db.select().from(subscriptionsTable);
  return row.status;
}

describe("GET /api/subscribe/unsubscribe", () => {
  it("never mutates: redirects to the interstitial (twice, prefetch-style) and leaves the row active", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await GET(unsubReq(TOKEN));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain(`/subscribe/unsubscribe?token=${TOKEN}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    }
    expect(await rowStatus()).toBe("confirmed");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(0);
  });

  it("redirects a missing token to /subscribe/invalid, still no-store", async () => {
    const res = await GET(unsubReq(""));

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

describe("POST /api/subscribe/unsubscribe (page form)", () => {
  it("unsubscribes the row, writes the suppression and answers 303 with no-store", async () => {
    const res = await POST(unsubReq(TOKEN, IP, "POST", ""));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/unsubscribed?token=");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await rowStatus()).toBe("unsubscribed");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(1);
  });

  it("a body-less POST is a form POST too (303), not a one-click", async () => {
    expect((await POST(unsubReq(TOKEN, IP, "POST"))).status).toBe(303);
  });

  it("an unknown token redirects to /subscribe/invalid", async () => {
    const res = await POST(unsubReq("not-a-real-token", IP, "POST", ""));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
  });

  it("a near-miss or oversized body is NOT treated as one-click", async () => {
    expect((await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK + "&x=1"))).status).toBe(303);
    expect((await POST(unsubReq(TOKEN, IP, "POST", "List-Unsubscribe=one-click"))).status).toBe(303);
    expect((await POST(unsubReq(TOKEN, IP, "POST", "x".repeat(100_000)))).status).toBe(303);
  });

  it("a stalled body is read for at most ~2s, then treated as a form POST (303), not hung", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stalled = new ReadableStream<Uint8Array>({ start() {} }); // never delivers, never closes
      const req = new Request(`http://localhost/api/subscribe/unsubscribe?token=${TOKEN}`, {
        method: "POST",
        headers: { "x-real-ip": IP, "content-type": "application/x-www-form-urlencoded" },
        body: stalled,
        duplex: "half",
      } as RequestInit);
      const pending = POST(req);
      await vi.advanceTimersByTimeAsync(2100);
      vi.useRealTimers();
      const res = await pending;
      expect(res.status).toBe(303);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a DB failure redirects to /subscribe/invalid and logs the SQLSTATE only", async () => {
    const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown };
    const original = db.select.bind(tdb.db);
    db.select = () => {
      throw Object.assign(new Error("boom for reader@example.com"), { code: "08006" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(unsubReq(TOKEN, IP, "POST", ""));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("sqlstate: 08006");
      expect(logged).not.toContain("reader@example.com");
    } finally {
      db.select = original;
      errSpy.mockRestore();
    }
  });
});

describe("POST /api/subscribe/unsubscribe (RFC 8058 one-click)", () => {
  it("unsubscribes the row and answers 200 with both no-store headers", async () => {
    const res = await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(await rowStatus()).toBe("unsubscribed");
  });

  it("scope=all one-click answers 200 and suppresses globally", async () => {
    const res = await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK, "&scope=all"));

    expect(res.status).toBe(200);
    expect(await rowStatus()).toBe("unsubscribed");
    expect(await isSuppressed(tdb.db, "reader@example.com", { kind: "global" })).toBe("suppressed");
  });

  it("answers 200 for an unknown token too (no oracle), still no-store", async () => {
    const res = await POST(unsubReq("not-a-real-token", IP, "POST", ONE_CLICK));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a DB failure answers 503 (so the client retries), no-store, and logs the SQLSTATE only", async () => {
    const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown };
    const original = db.select.bind(tdb.db);
    db.select = () => {
      throw Object.assign(new Error("boom for reader@example.com"), { code: "57P01" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("sqlstate: 57P01");
      expect(logged).not.toContain("reader@example.com");
    } finally {
      db.select = original;
      errSpy.mockRestore();
    }
  });

  it(`429s after ${API_RATE_LIMIT_MAX} requests from one IP`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK))).status).toBe(200);
    }

    const limited = await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK));
    expect(limited.status).toBe(429);
  });

  // One surface, one budget: GET and POST share the prefix on purpose, so an
  // attacker can't get 2x the work by alternating methods.
  it("shares its budget with the GET handler", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await GET(unsubReq(TOKEN))).status).toBe(307);
    }

    expect((await POST(unsubReq(TOKEN, IP, "POST", ONE_CLICK))).status).toBe(429);
  });
});
