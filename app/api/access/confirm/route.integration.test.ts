// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// `after()` throws outside a Next.js request scope; run the task at once and keep its promise so tests can await the send.
let pendingAfter: Promise<unknown> | undefined;
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      pendingAfter = Promise.resolve().then(task);
    },
  };
});

// Wraps the real function so tests can count CALLS, not only sends: a call with no intent would throw inside
// its own try and be swallowed, leaving the Resend count unchanged.
vi.mock("@/lib/dataset-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataset-mail")>();
  return { ...actual, deliverDatasetAdminNotice: vi.fn(actual.deliverDatasetAdminNotice) };
});

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { deliverDatasetAdminNotice } from "@/lib/dataset-mail";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable, datasetAccessGrantsTable } from "@/lib/db/schema";
import { DATASET_VERIFY_TTL_MS } from "@/lib/dataset-grants";
import { generateToken } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, OPTIONS, POST } from "./route";

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
  pendingAfter = undefined;
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
  vi.mocked(dbClient.getDb).mockClear();
  vi.mocked(deliverDatasetAdminNotice).mockClear();
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("CONTACT_TO_EMAIL", "ed@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

function postReq(body: string, ip: string = IP): Request {
  return new Request("http://localhost/api/access/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-real-ip": ip },
    body,
  });
}
const form = (token: string) => `token=${encodeURIComponent(token)}`;

/** Seeds an unverified dataset grant and returns its raw verify token. */
async function seedUnverified(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const token = generateToken();
  await tdb.db.insert(datasetAccessGrantsTable).values({
    email: "reporter@example.com",
    name: "Pat Reporter",
    organization: "The Gazette",
    category: "journalist",
    intendedUse: "seed",
    attributionAckAt: new Date(),
    termsVersion: "seed-terms",
    verifyTokenHash: hashToken(token),
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

describe("POST /api/access/confirm", () => {
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
    ["a non-token body", "{\"token\":1}"],
    ["an over-4-KiB body", `token=${"a".repeat(5000)}`],
  ])("redirects %s to /access/invalid without touching the DB", async (_name, body) => {
    expectRedirect(await POST(postReq(body)), "/access/invalid");
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });

  it("confirms a valid token: pending_review, 303 to /access/confirmed, one admin mail with name and org", async () => {
    const token = await seedUnverified();
    const res = await POST(postReq(form(token)));
    await pendingAfter;

    expectRedirect(res, "/access/confirmed");
    expect((await grantRows())[0].status).toBe("pending_review");
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const payload = resendSendMock.mock.calls[0][0];
    expect(payload.to).toBe("ed@example.com");
    expect(payload.text).toContain("Pat Reporter");
    expect(payload.text).toContain("The Gazette");
    expect(payload.text).not.toContain("reporter@example.com");
  });

  it("the SAME token POSTed again still reads confirmed but sends no second admin mail", async () => {
    const token = await seedUnverified();
    await POST(postReq(form(token)));
    await pendingAfter;
    pendingAfter = undefined;

    expectRedirect(await POST(postReq(form(token))), "/access/confirmed");
    await pendingAfter;
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(deliverDatasetAdminNotice).toHaveBeenCalledTimes(1);
  });

  it("redirects an expired token (older than the verify TTL) to /access/invalid", async () => {
    const token = await seedUnverified({ createdAt: new Date(Date.now() - DATASET_VERIFY_TTL_MS - 60_000) });
    expectRedirect(await POST(postReq(form(token))), "/access/invalid");
    expect((await grantRows())[0].status).toBe("unverified");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("redirects an unknown well-formed token to /access/invalid", async () => {
    expectRedirect(await POST(postReq(form(generateToken()))), "/access/invalid");
  });

  it("a GET with a valid token does NOT confirm", async () => {
    const token = await seedUnverified();
    await GET(confirmReq(token));
    expect((await grantRows())[0].status).toBe("unverified");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it(`429s no-store after ${API_RATE_LIMIT_MAX} POSTs from one IP`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) await POST(postReq("", "198.51.100.40"));
    const res = await POST(postReq("", "198.51.100.40"));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("503s no-store when the DB throws", async () => {
    const token = await seedUnverified();
    vi.spyOn(tdb.db, "update").mockImplementation(() => {
      throw Object.assign(new Error("down"), { code: "57P01" });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(postReq(form(token)));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("OPTIONS gives the public-write preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
