import { vi, describe, it, expect } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — define fixtures inline
// inside the factory bodies. This isolates the DB-backed branch of
// getRecentActivity from the rest of lib/data.test.ts, which relies on the
// real (unmocked) @/lib/db/client and the no-DATABASE_URL degrade path.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  getDb: () => mockDb,
}));

// The production query is a single `facility_history` INNER JOIN
// `facilities` query. The join, and the `where` filtering to
// create/update, both happen in SQL — this drizzle mock can't exercise
// that (a PGlite/real-DB test would be needed, out of scope here). Instead
// the mock resolves directly to PRE-JOINED fixture rows shaped like the
// query's `.select({...})` projection, pre-sorted newest-first (mirroring
// `orderBy(desc(changedAt))`), and `.limit(n)` slices that array.
const historyRows = [
  {
    facilityId: "facility-b",
    facilityName: "Facility B",
    changeType: "update",
    changedAt: new Date("2026-07-13T00:00:00Z"),
  },
  {
    facilityId: "facility-c",
    facilityName: "Facility C",
    changeType: "create",
    changedAt: new Date("2026-07-12T00:00:00Z"),
  },
  {
    facilityId: "facility-a",
    facilityName: "Facility A",
    changeType: "create",
    changedAt: new Date("2026-07-11T00:00:00Z"),
  },
];

// Minimal drizzle-query-builder stand-in for the chain:
// `.select({...}).from(...).innerJoin(...).where(...).orderBy(...).limit(n)`.
function makeMockDb() {
  const chain = {
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => Promise.resolve(historyRows.slice(0, n)),
  };
  return {
    select: () => ({
      from: () => chain,
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getRecentActivity } from "@/lib/data";

describe("getRecentActivity (DB path)", () => {
  it("returns entries in reverse-chronological order", async () => {
    const entries = await getRecentActivity(10);
    const timestamps = entries.map((e) => e.timestamp.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("labels a create-changeType row as 'new facility added'", async () => {
    const entries = await getRecentActivity(10);
    const created = entries.find((e) => e.facilityId === "facility-c");
    expect(created?.kind).toBe("create");
    expect(created?.label).toBe("new facility added");
  });

  it("labels an update-changeType row as 'facility updated'", async () => {
    const entries = await getRecentActivity(10);
    const updated = entries.find((e) => e.facilityId === "facility-b");
    expect(updated?.kind).toBe("update");
    expect(updated?.label).toBe("facility updated");
  });

  it("respects the limit", async () => {
    const entries = await getRecentActivity(2);
    expect(entries.length).toBe(2);
  });

  // THE REGRESSION for the double-entry bug: a facility's create used to be
  // captured by BOTH `facilitiesTable` (mislabeled "facility updated", since
  // `updatedAt` is set on insert too) AND `submissionsTable` (correctly
  // labeled "new facility added"), producing two feed entries for one event.
  // Driving the feed off `facility_history` means each event writes exactly
  // one row, so a single create yields exactly one entry.
  it("yields exactly one entry for a facility with a single create history row — no duplicate 'facility updated' entry", async () => {
    const entries = await getRecentActivity(10);
    const entriesForFacilityA = entries.filter((e) => e.facilityId === "facility-a");

    expect(entriesForFacilityA).toHaveLength(1);
    expect(entriesForFacilityA[0].kind).toBe("create");
    expect(entriesForFacilityA[0].label).toBe("new facility added");
    expect(
      entriesForFacilityA.some((e) => e.label === "facility updated")
    ).toBe(false);
  });
});
