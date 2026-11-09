// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";
import { getGrantByAccessToken } from "@/lib/dataset-grants";
import { datasetAccessGrantsTable, emailSuppressionsTable, type DatasetGrantStatus } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, OPTIONS, POST } from "./route";

let tdb: TestDbHandle;

const IP = "203.0.113.40";
const ONE_CLICK = "List-Unsubscribe=One-Click";
const DAY = 24 * 60 * 60 * 1000;

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
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
});

let seq = 0;
async function seedGrant(status: DatasetGrantStatus = "active") {
  seq++;
  const accessToken = generateToken();
  const unsubscribeToken = generateToken();
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `reader${seq}@example.com`,
      name: "Reader",
      category: "journalist",
      intendedUse: "testing",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status,
      verifyTokenHash: `v${seq}`.padEnd(64, "0"),
      accessTokenHash: hashToken(accessToken),
      unsubscribeToken,
      expiresAt: status === "active" ? new Date(Date.now() + 30 * DAY) : null,
    })
    .returning();
  return { row, accessToken, unsubscribeToken };
}

function req(token: string, method: "GET" | "POST", body?: string, ip: string = IP): Request {
  return new Request(`http://localhost/api/dataset/unsubscribe?token=${encodeURIComponent(token)}`, {
    method,
    headers: {
      "x-real-ip": ip,
      ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
}

const suppressionRows = () => tdb.db.select().from(emailSuppressionsTable);
const expectNoStore = (res: Response) => expect(res.headers.get("cache-control")).toContain("no-store");

describe("GET /api/dataset/unsubscribe", () => {
  it("303s to the interstitial, makes no DB call and no mutation, and is no-store", async () => {
    const { unsubscribeToken } = await seedGrant();
    vi.mocked(dbClient.getDb).mockClear();

    const res = await GET(req(unsubscribeToken, "GET"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://localhost/access/unsubscribe?token=${unsubscribeToken}`);
    expectNoStore(res);
    expect(dbClient.getDb).not.toHaveBeenCalled();
    expect(await suppressionRows()).toHaveLength(0); // a mail scanner's prefetch changes nothing
  });

  it("sends a malformed or missing token to the token-less interstitial, never echoing it", async () => {
    for (const token of ["", "abc", "<script>".padEnd(43, "x")]) {
      const res = await GET(req(token, "GET"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("http://localhost/access/unsubscribe");
      expectNoStore(res);
    }
  });

  it("still sends the link to the interstitial when the kill switch is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const { unsubscribeToken } = await seedGrant();
    const res = await GET(req(unsubscribeToken, "GET"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://localhost/access/unsubscribe?token=${unsubscribeToken}`);
    expectNoStore(res);
    expect(await suppressionRows()).toHaveLength(0);
  });
});

describe("POST /api/dataset/unsubscribe (RFC 8058 one-click)", () => {
  it("suppresses dataset_edition/weekly and answers 200 with no body, no-store", async () => {
    const { row, unsubscribeToken } = await seedGrant();
    const res = await POST(req(unsubscribeToken, "POST", ONE_CLICK));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expectNoStore(res);
    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: row.email,
      targetType: "dataset_edition",
      targetId: "weekly",
      source: "unsubscribe",
      sourceTokenHash: hashToken(unsubscribeToken),
    });
  });

  it("is idempotent", async () => {
    const { unsubscribeToken } = await seedGrant();
    expect((await POST(req(unsubscribeToken, "POST", ONE_CLICK))).status).toBe(200);
    expect((await POST(req(unsubscribeToken, "POST", ONE_CLICK))).status).toBe(200);
    expect(await suppressionRows()).toHaveLength(1);
  });

  it("answers an unknown or malformed token exactly like success and writes nothing", async () => {
    await seedGrant();
    for (const token of [generateToken(), "abc", ""]) {
      const res = await POST(req(token, "POST", ONE_CLICK));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expectNoStore(res);
    }
    expect(await suppressionRows()).toHaveLength(0);
  });

  it("a revoked grant's token still unsubscribes", async () => {
    const { unsubscribeToken } = await seedGrant("revoked");
    expect((await POST(req(unsubscribeToken, "POST", ONE_CLICK))).status).toBe(200);
    expect(await suppressionRows()).toHaveLength(1);
  });

  it("does not change the grant: the personal link keeps working", async () => {
    const { row, accessToken, unsubscribeToken } = await seedGrant();
    await POST(req(unsubscribeToken, "POST", ONE_CLICK));

    const [after] = await tdb.db.select().from(datasetAccessGrantsTable);
    expect(after).toEqual(row);
    expect((await getGrantByAccessToken(accessToken)).state).toBe("active");
  });
});

describe("POST /api/dataset/unsubscribe (interstitial form)", () => {
  it("a body-less form POST suppresses and 303s to /access/unsubscribed, no-store", async () => {
    const { unsubscribeToken } = await seedGrant();
    const res = await POST(req(unsubscribeToken, "POST"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/access/unsubscribed");
    expectNoStore(res);
    expect(await suppressionRows()).toHaveLength(1);
  });

  it("a near-miss body is a form POST, not a one-click", async () => {
    const { unsubscribeToken } = await seedGrant();
    expect((await POST(req(unsubscribeToken, "POST", "List-Unsubscribe=one-click"))).status).toBe(303);
    expect((await POST(req(unsubscribeToken, "POST", `${ONE_CLICK}&x=1`))).status).toBe(303);
  });

  it("an oversized body is a form POST (303), not a one-click", async () => {
    const { unsubscribeToken } = await seedGrant();
    expect((await POST(req(unsubscribeToken, "POST", "x".repeat(100_000)))).status).toBe(303);
  });

  it("a stalled body is read for at most ~2s, then treated as a form POST (303), not hung", async () => {
    const { unsubscribeToken } = await seedGrant();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stalled = new ReadableStream<Uint8Array>({ start() {} }); // never delivers, never closes
      const stalledReq = new Request(`http://localhost/api/dataset/unsubscribe?token=${unsubscribeToken}`, {
        method: "POST",
        headers: { "x-real-ip": IP, "content-type": "application/x-www-form-urlencoded" },
        body: stalled,
        duplex: "half",
      } as RequestInit);
      const pending = POST(stalledReq);
      await vi.advanceTimersByTimeAsync(2100);
      vi.useRealTimers();
      const res = await pending;
      expect(res.status).toBe(303);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an unknown or malformed token with the SAME 303, and writes nothing", async () => {
    await seedGrant();
    for (const token of [generateToken(), "abc", ""]) {
      const res = await POST(req(token, "POST"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("http://localhost/access/unsubscribed");
      expectNoStore(res);
    }
    expect(await suppressionRows()).toHaveLength(0);
  });
});

describe("POST /api/dataset/unsubscribe (guards)", () => {
  it("ignores the kill switch: one-click still suppresses when DATASET_SHARING_ENABLED is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const { unsubscribeToken } = await seedGrant();
    const res = await POST(req(unsubscribeToken, "POST", ONE_CLICK));
    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(await suppressionRows()).toHaveLength(1);
  });

  it("ignores the kill switch: the form POST still suppresses and 303s to /access/unsubscribed", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const { unsubscribeToken } = await seedGrant();
    const res = await POST(req(unsubscribeToken, "POST"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/access/unsubscribed");
    expect(await suppressionRows()).toHaveLength(1);
  });

  it("429s with Retry-After and no-store past the burst limit, before any DB call", async () => {
    const { unsubscribeToken } = await seedGrant();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await POST(req(unsubscribeToken, "POST"))).status).toBe(303);
    }
    vi.mocked(dbClient.getDb).mockClear();
    const res = await POST(req(unsubscribeToken, "POST"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expectNoStore(res);
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });

  it("another address has its own bucket", async () => {
    const { unsubscribeToken } = await seedGrant();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) await POST(req(unsubscribeToken, "POST"));
    expect((await POST(req(unsubscribeToken, "POST", undefined, "203.0.113.41"))).status).toBe(303);
  });

  it("a DB failure is a 503 (one-click and form), logs the SQLSTATE only, never the token or email", async () => {
    const { row, unsubscribeToken } = await seedGrant();
    const err = Object.assign(new Error(`Failed query: params: ${row.email}, ${unsubscribeToken}`), { code: "57P01" });
    vi.mocked(dbClient.getDb).mockImplementation(() => {
      throw err;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const body of [ONE_CLICK, undefined]) {
      const res = await POST(req(unsubscribeToken, "POST", body));
      expect(res.status).toBe(503);
      expectNoStore(res);
    }
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain("57P01");
    expect(output).not.toContain(unsubscribeToken);
    expect(output).not.toContain(row.email);
  });

  it("OPTIONS is the public-write preflight and advertises no Authorization", () => {
    const res = OPTIONS();
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).not.toContain("Authorization");
  });
});
