import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Facility, DataCenterFacility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest — mirrors the mocking
// pattern in lib/data.getRecentActivity.db.test.ts / lib/search-db.test.ts.
// getFacilitiesByMetro and loadFacilities are both defined in lib/data.ts and
// share module-internal bindings, so mocking "@/lib/data" itself (even with
// vi.importActual spreading the real exports) would NOT let a swapped-out
// loadFacilities be seen by getFacilitiesByMetro's own call to it — the
// spread copy is a distinct export binding, not the closure loadFacilities
// resolves internally. Instead this mocks the DB-client boundary
// loadFacilities reads through, the same as the established pattern, and
// forces the DB branch (hasDatabaseUrl()/readsUseDatabase() === true) so
// `mockDb` fixture rows are what loadFacilities ultimately returns.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  readsUseDatabase: () => true,
  getDb: () => mockDb,
}));

let fixtureFacilities: DataCenterFacility[] = [];

// Minimal drizzle-query-builder stand-in for the chain loadFacilitiesUncached
// uses: `.select().from(facilitiesTable)` resolves to DB rows, each mapped
// through `rowToFacility` (which just returns `row.doc` — see
// lib/db/serialize.ts) — so a fixture row only needs a `doc` of a full
// Facility.
function makeMockDb() {
  return {
    select: () => ({
      from: () => Promise.resolve(fixtureFacilities.map((doc) => ({ id: doc.id, doc }))),
    }),
  };
}

const mockDb = makeMockDb();

/** Mirrors the makeFacility fixture factory in lib/filters.test.ts, plus a county override. */
function makeFacility(
  overrides: Partial<DataCenterFacility> & {
    id: string;
    name: string;
    state: string;
    county?: string;
    capacityMw?: Facility["capacityMw"];
  }
): DataCenterFacility {
  const { state, county, capacityMw, ...rest } = overrides;
  return {
    facilityType: "data_center",
    operator: "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state, county, precision: "exact" },
    capacityMw,
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Source", retrievedAt: "2024-01-01", kind: "press" },
    ],
    lastUpdated: "2024-01-01",
    ...rest,
  };
}

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getFacilitiesByMetro } from "@/lib/data";

describe("getFacilitiesByMetro", () => {
  beforeEach(() => {
    fixtureFacilities = [];
  });

  it("returns [] for an unknown slug", async () => {
    fixtureFacilities = [makeFacility({ id: "a", name: "A", state: "VA", county: "Loudoun" })];
    expect(await getFacilitiesByMetro("not-a-real-metro")).toEqual([]);
  });

  it("matches counties regardless of a trailing ' County' suffix (normalization)", async () => {
    fixtureFacilities = [
      makeFacility({ id: "bare", name: "Bare Form", state: "VA", county: "Loudoun" }),
      makeFacility({ id: "suffixed", name: "Suffixed Form", state: "VA", county: "Loudoun County" }),
    ];
    const result = await getFacilitiesByMetro("northern-virginia");
    expect(result.map((f) => f.id).sort()).toEqual(["bare", "suffixed"]);
  });

  it("matches on (state, county) together — a same-named county in a non-member state does not match", async () => {
    fixtureFacilities = [
      makeFacility({ id: "or-washington", name: "OR Washington County DC", state: "OR", county: "Washington" }),
      makeFacility({ id: "tx-washington", name: "TX Washington County DC", state: "TX", county: "Washington" }),
    ];
    const result = await getFacilitiesByMetro("portland");
    expect(result.map((f) => f.id)).toEqual(["or-washington"]);
  });

  it("excludes facilities with no county on record", async () => {
    fixtureFacilities = [makeFacility({ id: "no-county", name: "No County", state: "VA" })];
    expect(await getFacilitiesByMetro("northern-virginia")).toEqual([]);
  });

  it("returns [] when the metro has no matching facilities", async () => {
    fixtureFacilities = [makeFacility({ id: "elsewhere", name: "Elsewhere", state: "TX", county: "Bexar" })];
    expect(await getFacilitiesByMetro("northern-virginia")).toEqual([]);
  });

  it("sorts by max MW (operational or planned) desc, then name A→Z on ties", async () => {
    fixtureFacilities = [
      makeFacility({ id: "small-zeta", name: "Zeta Site", state: "VA", county: "Fairfax", capacityMw: { operational: 50 } }),
      makeFacility({ id: "big", name: "Alpha Site", state: "VA", county: "Loudoun", capacityMw: { planned: 900 } }),
      makeFacility({ id: "small-bravo", name: "Bravo Site", state: "VA", county: "Fauquier", capacityMw: { operational: 50 } }),
    ];
    const result = await getFacilitiesByMetro("northern-virginia");
    expect(result.map((f) => f.id)).toEqual(["big", "small-bravo", "small-zeta"]);
  });
});
