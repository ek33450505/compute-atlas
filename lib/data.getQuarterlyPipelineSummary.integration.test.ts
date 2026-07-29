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
import { facilityHistoryTable } from "@/lib/db/schema";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getQuarterlyPipelineSummary } from "@/lib/data";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  // Pins "now" to 2026-08-15T12:00:00Z, which falls in Q3 2026:
  // [2026-07-01T00:00:00Z, 2026-10-01T00:00:00Z). This exercises the REAL
  // SQL gte/lt quarter-boundary filter — the mocked-db unit test
  // (data.getQuarterlyPipelineSummary.db.test.ts) can't, since it stubs
  // `.where()` to resolve fixtures unconditionally.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await tdb.client.close();
});

const QUARTER_START = new Date("2026-07-01T00:00:00.000Z");
const QUARTER_END = new Date("2026-10-01T00:00:00.000Z");

describe("getQuarterlyPipelineSummary — quarter-boundary scoping (PGlite)", () => {
  it("includes a create exactly at the quarter start and excludes one 1ms before it", async () => {
    await tdb.db.insert(facilityHistoryTable).values([
      {
        facilityId: "in-quarter-facility",
        changeType: "create",
        diff: [],
        source: "admin-direct",
        changedAt: QUARTER_START,
      },
      {
        facilityId: "prev-quarter-facility",
        changeType: "create",
        diff: [],
        source: "admin-direct",
        changedAt: new Date(QUARTER_START.getTime() - 1),
      },
    ]);

    const summary = await getQuarterlyPipelineSummary();
    expect(summary.newThisQuarter).toBe(1);
  });

  it("excludes a create exactly at the (exclusive) quarter end", async () => {
    await tdb.db.insert(facilityHistoryTable).values({
      facilityId: "next-quarter-facility",
      changeType: "create",
      diff: [],
      source: "admin-direct",
      changedAt: QUARTER_END,
    });

    const summary = await getQuarterlyPipelineSummary();
    expect(summary.newThisQuarter).toBe(0);
  });

  it("counts a real status-change update and a cancellation transition within the quarter", async () => {
    await tdb.db.insert(facilityHistoryTable).values([
      {
        facilityId: "status-change-facility",
        changeType: "update",
        diff: [{ key: "status", before: "proposed", after: "under_construction" }],
        source: "admin-direct",
        changedAt: new Date(QUARTER_START.getTime() + 1000),
      },
      {
        facilityId: "cancelled-facility",
        changeType: "update",
        diff: [{ key: "status", before: "under_construction", after: "cancelled" }],
        source: "admin-direct",
        changedAt: new Date(QUARTER_START.getTime() + 2000),
      },
    ]);

    const summary = await getQuarterlyPipelineSummary();
    expect(summary.statusChangesThisQuarter).toBe(2);
    expect(summary.cancelledThisQuarter).toBe(1);
  });

  it("excludes delete rows and rows outside the quarter, even when they touch 'status'", async () => {
    await tdb.db.insert(facilityHistoryTable).values([
      {
        facilityId: "deleted-facility",
        changeType: "delete",
        diff: [{ key: "status", before: "cancelled", after: null }],
        source: "admin-direct",
        changedAt: new Date(QUARTER_START.getTime() + 500),
      },
      {
        facilityId: "prior-quarter-cancellation",
        changeType: "update",
        diff: [{ key: "status", before: "permitted", after: "cancelled" }],
        source: "admin-direct",
        changedAt: new Date(QUARTER_START.getTime() - 1),
      },
    ]);

    const summary = await getQuarterlyPipelineSummary();
    expect(summary).toEqual({
      newThisQuarter: 0,
      cancelledThisQuarter: 0,
      statusChangesThisQuarter: 0,
    });
  });
});
