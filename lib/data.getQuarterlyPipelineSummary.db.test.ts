import { vi, describe, it, expect } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — define fixtures inline
// inside the factory bodies. This isolates the DB-backed branch of
// getQuarterlyPipelineSummary from the rest of lib/data.test.ts, which relies
// on the real (unmocked) @/lib/db/client and the no-DATABASE_URL degrade path.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  getDb: () => mockDb,
}));

// The production query filters to the current quarter and to
// create/update rows entirely in SQL (`where(and(inArray(...), gte(...),
// lt(...)))`) — this mock query-builder stand-in can't exercise that (a
// PGlite/real-DB test would be needed for the boundary math; see
// data.getQuarterlyPipelineSummary.integration.test.ts). So every fixture row
// here is already "as if" the SQL filter had run: all rows are create/update
// rows already inside the quarter. This file instead exercises the
// diff-inspection/aggregation logic that runs in JS AFTER the query resolves.
const historyRows = [
  // A create — counts toward newThisQuarter.
  {
    facilityId: "facility-new",
    changeType: "create",
    diff: [],
  },
  // An update whose diff includes a status-key entry — counts toward
  // statusChangesThisQuarter, but doesn't transition to "cancelled".
  {
    facilityId: "facility-status-change",
    changeType: "update",
    diff: [{ key: "status", before: "proposed", after: "permitted" }],
  },
  // An update whose diff has NO status-key entry (a capacity edit) — must
  // not count toward statusChangesThisQuarter at all.
  {
    facilityId: "facility-non-status-update",
    changeType: "update",
    diff: [{ key: "capacityPlannedMw", before: 100, after: 200 }],
  },
  // Two update rows for the SAME facility, both transitioning to "cancelled"
  // — cancelledThisQuarter must dedupe to 1 facility, while
  // statusChangesThisQuarter counts both rows (2 real status-change events).
  {
    facilityId: "facility-cancelled",
    changeType: "update",
    diff: [{ key: "status", before: "permitted", after: "cancelled" }],
  },
  {
    facilityId: "facility-cancelled",
    changeType: "update",
    diff: [{ key: "status", before: "cancelled", after: "cancelled" }],
  },
];

// Flipped by the query-failure test below to make the mocked `.where()`
// reject, exercising the try/catch degrade path. Reset in a `finally` so a
// failure never leaks into the other tests in this file.
let shouldFail = false;

// Minimal drizzle-query-builder stand-in for the chain used by
// getQuarterlyPipelineSummary: `.select({...}).from(...).where(...)`. Unlike
// getRecentActivity's chain, there's no join/orderBy/limit — `.where()` is
// itself the terminal, awaitable call, so it resolves/rejects directly.
function makeMockDb() {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          shouldFail
            ? Promise.reject(new Error("mock query failure"))
            : Promise.resolve(historyRows),
      }),
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getQuarterlyPipelineSummary } from "@/lib/data";

describe("getQuarterlyPipelineSummary (DB path)", () => {
  it("counts create rows toward newThisQuarter", async () => {
    const summary = await getQuarterlyPipelineSummary();
    expect(summary.newThisQuarter).toBe(1);
  });

  it("counts only update rows whose diff has a status-key entry toward statusChangesThisQuarter", async () => {
    const summary = await getQuarterlyPipelineSummary();
    // facility-status-change (1) + facility-cancelled x2 (2) = 3. The
    // non-status update is excluded.
    expect(summary.statusChangesThisQuarter).toBe(3);
  });

  it("dedupes cancelledThisQuarter to distinct facilities transitioning to 'cancelled'", async () => {
    const summary = await getQuarterlyPipelineSummary();
    expect(summary.cancelledThisQuarter).toBe(1);
  });
});

describe("getQuarterlyPipelineSummary (DB path) — query failure", () => {
  // hasDatabaseUrl() is mocked true above, so this reaches the query (not
  // the early-return degrade path already covered in lib/data.test.ts).
  it("resolves to the all-zero summary when the live query rejects, rather than throwing", async () => {
    shouldFail = true;
    try {
      await expect(getQuarterlyPipelineSummary()).resolves.toEqual({
        newThisQuarter: 0,
        cancelledThisQuarter: 0,
        statusChangesThisQuarter: 0,
      });
    } finally {
      shouldFail = false;
    }
  });
});
