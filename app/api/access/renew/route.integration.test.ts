// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";
import { generateToken } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, OPTIONS, POST } from "./route";

let tdb: TestDbHandle;
const IP = "203.0.113.50";

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
  vi.mocked(dbClient.getDb).mockClear();
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
});

function postReq(body: string, ip: string = IP): Request {
  return new Request("http://localhost/api/access/renew", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-real-ip": ip },
    body,
  });
}
const form = (token: string) => `token=${encodeURIComponent(token)}`;

async function seedLive(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const token = generateToken();
  await tdb.db.insert(datasetAccessGrantsTable).values({
    email: "reporter@example.com",
    name: "Pat",
    category: "journalist",
    intendedUse: "seed",
    attributionAckAt: new Date(),
    termsVersion: "seed-terms",
    status: "active",
    expiresAt: new Date(Date.now() + 10 * 86_400_000),
    renewTokenHash: hashToken(token),
    verifyTokenHash: hashToken(generateToken()),
    ...over,
  });
  return token;
}
const grantRows = () => tdb.db.select().from(datasetAccessGrantsTable);

function expectRedirect(res: Response, path: string) {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin).toBe("http://localhost");
  expect(location.pathname).toBe(path);
  expect(location.search).toBe("");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
}

describe("POST /api/access/renew", () => {
  it("403s no-store with no DB call when the flag is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const res = await POST(postReq(form(generateToken())));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing token", ""],
    ["a malformed token", "token=short"],
    ["an over-4-KiB body", `token=${"a".repeat(5000)}`],
  ])("redirects %s to /access/invalid without touching the DB", async (_name, body) => {
    expectRedirect(await POST(postReq(body)), "/access/invalid");
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });

  it("requests renewal for a live grant and is idempotent on repeat", async () => {
    const token = await seedLive();
    expectRedirect(await POST(postReq(form(token))), "/access/renewed");
    const first = (await grantRows())[0].renewalRequestedAt;
    expect(first).toBeInstanceOf(Date);

    expectRedirect(await POST(postReq(form(token))), "/access/renewed");
    expect((await grantRows())[0].renewalRequestedAt?.getTime()).toBe(first?.getTime());
  });

  it("redirects an unknown well-formed token to /access/invalid", async () => {
    expectRedirect(await POST(postReq(form(generateToken()))), "/access/invalid");
  });

  it("redirects a lapsed grant's token to /access/invalid and sets nothing", async () => {
    const token = await seedLive({ expiresAt: new Date(Date.now() - 86_400_000) });
    expectRedirect(await POST(postReq(form(token))), "/access/invalid");
    expect((await grantRows())[0].renewalRequestedAt).toBeNull();
  });

  it("405s a GET no-store and OPTIONS gives the preflight", () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(OPTIONS().status).toBeLessThan(300);
  });

  it(`429s no-store after ${API_RATE_LIMIT_MAX} POSTs from one IP`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) await POST(postReq("", "198.51.100.41"));
    const res = await POST(postReq("", "198.51.100.41"));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("503s no-store when the DB throws", async () => {
    const token = await seedLive();
    vi.spyOn(tdb.db, "update").mockImplementation(() => {
      throw new Error("down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(postReq(form(token)));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
