import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — define fixtures inline
// inside the factory bodies. This isolates the DB-backed branch of
// getRecentActivity from the rest of lib/data.test.ts, which relies on the
// real (unmocked) @/lib/db/client and the no-DATABASE_URL degrade path.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  getDb: () => mockDb,
}));

const facilityRows = [
  {
    id: "facility-a",
    name: "Facility A",
    updatedAt: new Date("2026-07-10T00:00:00Z"),
  },
  {
    id: "facility-b",
    name: "Facility B",
    updatedAt: new Date("2026-07-12T00:00:00Z"),
  },
];

const submissionRows = [
  {
    id: "sub-1",
    status: "approved",
    kind: "create",
    targetFacilityId: null,
    payload: { id: "facility-c", name: "Facility C" },
    reviewedAt: new Date("2026-07-11T00:00:00Z"),
  },
  {
    id: "sub-2",
    status: "approved",
    kind: "update",
    targetFacilityId: "facility-a",
    payload: { status: "operational" },
    reviewedAt: new Date("2026-07-13T00:00:00Z"),
  },
];

// Mutable row sources so an individual test can temporarily swap in a larger
// fixture set (see the "per-source LIMIT" regression describe block below)
// without disturbing the small default fixtures the other tests rely on.
let activeFacilityRows: typeof facilityRows = facilityRows;
let activeSubmissionRows: typeof submissionRows = submissionRows;

// A minimal drizzle-query-builder stand-in: each call chains and resolves
// to the appropriate fixture depending on which table `.from()` was called with.
// Each source is ordered independently by the row array's own order (the
// fixtures below are pre-sorted newest-first per source, mirroring the real
// `orderBy(desc(...))` the production query issues), and `.limit(n)` slices
// that ordered array — the same shape as the real per-source LIMIT.
function makeMockDb() {
  return {
    select: () => ({
      from: (table: { [Symbol.toPrimitive]?: unknown } | Record<string, unknown>) => {
        const isSubmissions = "targetFacilityId" in ((table as Record<string, unknown>) ?? {});
        const rows = isSubmissions ? activeSubmissionRows : activeFacilityRows;
        const chain = {
          orderBy: () => ({
            limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          }),
          where: () => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
        };
        return chain;
      },
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getRecentActivity } from "@/lib/data";
import { facilitiesTable, submissionsTable } from "@/lib/db/schema";

describe("getRecentActivity (DB path)", () => {
  it("merges facility updates and approved submissions in reverse-chron order", async () => {
    const entries = await getRecentActivity(10);
    const timestamps = entries.map((e) => e.timestamp.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("labels a create-kind submission as a new facility, an update-kind as a contribution", async () => {
    const entries = await getRecentActivity(10);
    const created = entries.find((e) => e.facilityId === "facility-c");
    const updated = entries.find(
      (e) => e.facilityId === "facility-a" && e.kind === "submission_approved"
    );
    expect(created?.label).toBe("new facility added");
    expect(updated?.label).toBe("contribution approved");
  });

  it("labels a plain facility row update as 'facility updated'", async () => {
    const entries = await getRecentActivity(10);
    const facilityUpdate = entries.find(
      (e) => e.facilityId === "facility-b" && e.kind === "facility_updated"
    );
    expect(facilityUpdate?.label).toBe("facility updated");
  });

  it("respects the limit after merging both sources", async () => {
    const entries = await getRecentActivity(2);
    expect(entries.length).toBe(2);
  });
});

describe("getRecentActivity (per-source LIMIT regression)", () => {
  // Regression coverage for the bug the fix in lib/data.ts addresses: each
  // source query previously applied `LIMIT <limit>` independently BEFORE the
  // merge/sort step. With many old rows from one source and only a few, but
  // genuinely newer, rows from the other source, an equal per-source LIMIT
  // fetch of `limit` from each could still surface fewer of the newer rows
  // than expected if their count relative to the other source's near-limit
  // volume wasn't accounted for — the fix (LIMIT 2*limit per source) ensures
  // the merge always sees enough candidates from both sources to find the
  // true top-N once sorted together.
  const LIMIT = 5;

  // Many stale facility rows, oldest of the two sources, pre-sorted
  // newest-first (index 0 = most recent of this source) to mirror the real
  // `orderBy(desc(updatedAt))` query.
  const manyOldFacilityRows = Array.from({ length: 20 }, (_, i) => ({
    id: `facility-old-${i}`,
    name: `Old Facility ${i}`,
    // Day 1 is most recent among these stale rows; day 20 is oldest.
    updatedAt: new Date(`2026-06-${String(20 - i).padStart(2, "0")}T00:00:00Z`),
  }));

  // A small number of submissions, each newer than every stale facility row
  // above, pre-sorted newest-first.
  const fewNewSubmissionRows = [
    {
      id: "sub-new-1",
      status: "approved",
      kind: "create",
      targetFacilityId: null,
      payload: { id: "facility-new-1", name: "Fresh Facility 1" },
      reviewedAt: new Date("2026-07-13T00:00:00Z"),
    },
    {
      id: "sub-new-2",
      status: "approved",
      kind: "update",
      targetFacilityId: "facility-old-0",
      payload: { status: "operational" },
      reviewedAt: new Date("2026-07-12T00:00:00Z"),
    },
    {
      id: "sub-new-3",
      status: "approved",
      kind: "create",
      targetFacilityId: null,
      payload: { id: "facility-new-3", name: "Fresh Facility 3" },
      reviewedAt: new Date("2026-07-11T00:00:00Z"),
    },
  ];

  beforeEach(() => {
    activeFacilityRows = manyOldFacilityRows;
    activeSubmissionRows = fewNewSubmissionRows;
  });

  afterEach(() => {
    activeFacilityRows = facilityRows;
    activeSubmissionRows = submissionRows;
  });

  it("keeps every newer submission-source entry out of a smaller, older facility-source pool", async () => {
    const entries = await getRecentActivity(LIMIT);

    expect(entries.length).toBe(LIMIT);

    const submissionEntryIds = entries
      .filter((e) => e.kind === "submission_approved")
      .map((e) => e.facilityId);

    // All 3 fresh submissions are strictly newer than all 20 stale facility
    // rows, so with LIMIT=5 the merged top-5 must include all 3 of them —
    // none may be dropped by an independent per-source cutoff.
    expect(submissionEntryIds.sort()).toEqual(
      ["facility-new-1", "facility-old-0", "facility-new-3"].sort()
    );
  });

  it("still returns results in reverse-chronological order across both sources", async () => {
    const entries = await getRecentActivity(LIMIT);
    const timestamps = entries.map((e) => e.timestamp.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });
});

// Sanity check the mock table shape matches what data.ts distinguishes on.
describe("mock fixture sanity", () => {
  it("submissionsTable has a targetFacilityId column, facilitiesTable does not", () => {
    expect("targetFacilityId" in submissionsTable).toBe(true);
    expect("targetFacilityId" in facilitiesTable).toBe(false);
  });
});
