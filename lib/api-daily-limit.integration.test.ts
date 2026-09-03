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
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable, apiDailyUsageTable } from "@/lib/db/schema";
import { hashIp } from "@/lib/rate-limit";

import { checkDailyApiGate, API_DAILY_LIMIT_MAX } from "@/lib/api-daily-limit";

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

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://compute-atlas.com/api/facilities", { headers });
}

describe("checkDailyApiGate", () => {
  it("allows a fresh anonymous IP under the limit", async () => {
    const result = await checkDailyApiGate(makeRequest({ "x-real-ip": "1.2.3.4" }));
    expect(result.ok).toBe(true);
  });

  it("blocks an IP already at the daily cap, with a positive retryAfter", async () => {
    const ip = "5.6.7.8";
    const ipHash = hashIp(ip);
    const today = new Date().toISOString().slice(0, 10);
    await tdb.db.insert(apiDailyUsageTable).values({ ipHash, day: today, count: API_DAILY_LIMIT_MAX });

    const result = await checkDailyApiGate(makeRequest({ "x-real-ip": ip }));
    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("tracks two different IPs independently — one at the cap doesn't affect the other", async () => {
    const cappedIp = "9.9.9.9";
    const freshIp = "10.10.10.10";
    const today = new Date().toISOString().slice(0, 10);
    await tdb.db
      .insert(apiDailyUsageTable)
      .values({ ipHash: hashIp(cappedIp), day: today, count: API_DAILY_LIMIT_MAX });

    const cappedResult = await checkDailyApiGate(makeRequest({ "x-real-ip": cappedIp }));
    expect(cappedResult.ok).toBe(false);

    const freshResult = await checkDailyApiGate(makeRequest({ "x-real-ip": freshIp }));
    expect(freshResult.ok).toBe(true);
  });

  it("isolates days — a cap seeded for a different day does not block today's request", async () => {
    const ip = "11.11.11.11";
    const ipHash = hashIp(ip);
    await tdb.db.insert(apiDailyUsageTable).values({ ipHash, day: "2020-01-01", count: API_DAILY_LIMIT_MAX });

    const result = await checkDailyApiGate(makeRequest({ "x-real-ip": ip }));
    expect(result.ok).toBe(true);
  });

  it("a valid active access-grant token bypasses the cap even when the IP is already capped", async () => {
    const ip = "12.12.12.12";
    const ipHash = hashIp(ip);
    const today = new Date().toISOString().slice(0, 10);
    await tdb.db.insert(apiDailyUsageTable).values({ ipHash, day: today, count: API_DAILY_LIMIT_MAX });

    const token = "valid-token-123";
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "reader@example.com",
      status: "active",
      confirmToken: "confirm-abc",
      accessToken: token,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const result = await checkDailyApiGate(
      makeRequest({ "x-real-ip": ip, authorization: `Bearer ${token}` })
    );
    expect(result.ok).toBe(true);
  });

  it("an expired token does not bypass — falls through to the IP-day check", async () => {
    const ip = "13.13.13.13";
    const token = "expired-token";
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "expired@example.com",
      status: "active",
      confirmToken: "confirm-def",
      accessToken: token,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await checkDailyApiGate(
      makeRequest({ "x-real-ip": ip, authorization: `Bearer ${token}` })
    );
    // Under the anonymous cap, so it still succeeds — but via the IP-day path.
    expect(result.ok).toBe(true);
    const rows = await tdb.db
      .select()
      .from(apiDailyUsageTable)
      .where(eq(apiDailyUsageTable.ipHash, hashIp(ip)));
    expect(rows).toHaveLength(1); // proves the IP-day counter path ran, not the token bypass
  });

  it("a revoked/nonexistent token does not bypass — falls through to the IP-day check", async () => {
    const ip = "14.14.14.14";
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "revoked@example.com",
      status: "revoked",
      confirmToken: "confirm-ghi",
      accessToken: "revoked-token",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const revokedResult = await checkDailyApiGate(
      makeRequest({ "x-real-ip": ip, authorization: "Bearer revoked-token" })
    );
    expect(revokedResult.ok).toBe(true);

    const unknownResult = await checkDailyApiGate(
      makeRequest({ "x-real-ip": "15.15.15.15", authorization: "Bearer no-such-token" })
    );
    expect(unknownResult.ok).toBe(true);

    const rows = await tdb.db
      .select()
      .from(apiDailyUsageTable)
      .where(eq(apiDailyUsageTable.ipHash, hashIp(ip)));
    expect(rows).toHaveLength(1); // the revoked-token call ran through the IP-day path
  });

  it("bumps requestCount and sets lastUsedAt on the grant row when the token bypasses", async () => {
    const token = "usage-token";
    const [inserted] = await tdb.db
      .insert(apiAccessGrantsTable)
      .values({
        email: "usage@example.com",
        status: "active",
        confirmToken: "confirm-jkl",
        accessToken: token,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        requestCount: 0,
      })
      .returning({ id: apiAccessGrantsTable.id });

    await checkDailyApiGate(makeRequest({ "x-real-ip": "16.16.16.16", authorization: `Bearer ${token}` }));

    const [updated] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, inserted.id));
    expect(updated.requestCount).toBe(1);
    expect(updated.lastUsedAt).not.toBeNull();
  });
});
