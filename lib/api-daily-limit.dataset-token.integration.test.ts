// @vitest-environment node
// Design 9 regression: a dataset-sharing access token is NOT an API bearer. The daily gate's
// bearer branch queries ONLY api_access_grants; a dataset token presented there must be treated
// as anonymous (IP-day counter incremented, no ceiling raise).
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable, apiDailyUsageTable, datasetAccessGrantsTable } from "@/lib/db/schema";
import { hashIp } from "@/lib/rate-limit";
import { hashToken } from "@/lib/token-hash";

import { checkDailyApiGate, API_DAILY_LIMIT_MAX } from "@/lib/api-daily-limit";

const IP = "203.0.113.7";
const RAW_TOKEN = "D".repeat(43); // shaped like a real raw access token (43 base64url chars)
const DAY_MS = 24 * 60 * 60 * 1000;

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

function bearerRequest(token: string): Request {
  return new Request("https://compute-atlas.com/api/facilities", {
    headers: { "x-real-ip": IP, authorization: `Bearer ${token}` },
  });
}

const today = () => new Date().toISOString().slice(0, 10);

async function usageCount(): Promise<number | undefined> {
  const [row] = await tdb.db
    .select({ count: apiDailyUsageTable.count })
    .from(apiDailyUsageTable)
    .where(and(eq(apiDailyUsageTable.ipHash, hashIp(IP)), eq(apiDailyUsageTable.day, today())));
  return row?.count;
}

async function seedActiveDatasetGrant(): Promise<void> {
  await tdb.db.insert(datasetAccessGrantsTable).values({
    email: "reporter@example.com",
    name: "Seed",
    category: "journalist",
    intendedUse: "seed",
    attributionAckAt: new Date(),
    termsVersion: "seed-terms",
    verifyTokenHash: hashToken("dataset-verify-seed"),
    status: "active",
    accessTokenHash: hashToken(RAW_TOKEN),
    approvedAt: new Date(),
    reviewedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
  });
}

describe("checkDailyApiGate with a dataset access token as the bearer", () => {
  it("counts the request against the IP-day bucket (anonymous treatment)", async () => {
    await seedActiveDatasetGrant();

    const result = await checkDailyApiGate(bearerRequest(RAW_TOKEN));

    expect(result.ok).toBe(true);
    expect(await usageCount()).toBe(1);
  });

  it("gives no ceiling raise: an IP at the daily cap is still refused", async () => {
    await seedActiveDatasetGrant();
    await tdb.db
      .insert(apiDailyUsageTable)
      .values({ ipHash: hashIp(IP), day: today(), count: API_DAILY_LIMIT_MAX });

    const result = await checkDailyApiGate(bearerRequest(RAW_TOKEN));

    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(await usageCount()).toBe(API_DAILY_LIMIT_MAX + 1);
  });

  it("does not touch the dataset grant (no usage bump on that table)", async () => {
    await seedActiveDatasetGrant();

    await checkDailyApiGate(bearerRequest(RAW_TOKEN));

    const [grant] = await tdb.db
      .select({ downloadCount: datasetAccessGrantsTable.downloadCount, lastDownloadAt: datasetAccessGrantsTable.lastDownloadAt })
      .from(datasetAccessGrantsTable);
    expect(grant.downloadCount).toBe(0);
    expect(grant.lastDownloadAt).toBeNull();
  });

  // Control: proves the two tests above can tell the branches apart. The SAME raw token stored as
  // a genuine API grant bypasses the ceiling and leaves the IP-day counter alone. If the bearer
  // lookup were pointed at dataset_access_grants instead, the dataset-token tests above would
  // flip (counter not incremented, capped IP allowed) and go RED.
  it("control: the same token as a real API grant bypasses the cap without a counter bump", async () => {
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "api@example.com",
      status: "active",
      confirmToken: hashToken("api-confirm-seed"),
      accessToken: hashToken(RAW_TOKEN),
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    await tdb.db
      .insert(apiDailyUsageTable)
      .values({ ipHash: hashIp(IP), day: today(), count: API_DAILY_LIMIT_MAX });

    const result = await checkDailyApiGate(bearerRequest(RAW_TOKEN));

    expect(result.ok).toBe(true);
    expect(await usageCount()).toBe(API_DAILY_LIMIT_MAX);
  });
});
