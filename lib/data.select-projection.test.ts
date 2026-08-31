import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DataCenterFacility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest — mirrors the mocking
// pattern in lib/data.getFacilitiesByMetro.test.ts / lib/data.rankings.test.ts.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  readsUseDatabase: () => true,
  getDb: () => mockDb,
}));

interface FixtureRow {
  id: string;
  doc: DataCenterFacility;
}

let fixtureRows: FixtureRow[] = [];

/** Every argument a read path under test passed to `.select(...)`, in call order. */
const capturedSelectArgs: unknown[] = [];

/**
 * A drizzle-query-builder stand-in wide enough to serve both call shapes this
 * file exercises: `selectAllFacilitiesResilient` awaits `.select().from()`
 * directly (no `.where()`), while `fetchFacilityByIdUncached` /
 * `fetchFacilitiesByOperatorUncached` chain a `.where()` off `.from()`. Real
 * drizzle query objects are both thenable AND chainable for exactly this
 * reason, so `.from()` here returns a Promise with a `.where` method
 * attached, rather than picking one shape and breaking the other caller.
 */
function makeMockDb() {
  return {
    select: (arg?: unknown) => {
      capturedSelectArgs.push(arg);
      return {
        from: () => {
          const promise = Promise.resolve(fixtureRows) as Promise<FixtureRow[]> & {
            where: (clause: unknown) => Promise<FixtureRow[]>;
          };
          promise.where = () => Promise.resolve(fixtureRows);
          return promise;
        },
      };
    },
  };
}

const mockDb = makeMockDb();

/** Mirrors the makeFacility fixture factory in lib/data.rankings.test.ts. */
function makeFacility(overrides: { id: string; name: string }): DataCenterFacility {
  return {
    facilityType: "data_center",
    operator: "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Source", retrievedAt: "2024-01-01", kind: "press" },
    ],
    lastUpdated: "2024-01-01",
    ...overrides,
  };
}

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getAllFacilities, getFacilityByIdCached, getFacilitiesByOperator } from "@/lib/data";

/**
 * Asserts a captured `.select(...)` argument is a doc-only projection —
 * `{ doc: facilitiesTable.doc }` — never a bare `.select()` (which drizzle
 * expands to `SELECT *`). This is the one guard in the suite that inspects
 * the actual argument passed to `.select()`; every other test here would
 * keep passing even if a read path regressed back to a full-row select,
 * because the mock's fixture rows already carry only `doc`.
 */
function assertDocOnlyProjection(arg: unknown) {
  expect(arg).toBeTypeOf("object");
  expect(arg).not.toBeUndefined();
  const projection = arg as Record<string, { name?: unknown }>;
  expect(Object.keys(projection)).toEqual(["doc"]);
  expect(projection.doc?.name).toBe("doc");
}

describe("lib/data.ts DB reads select only the doc column (never SELECT *)", () => {
  beforeEach(() => {
    capturedSelectArgs.length = 0;
    fixtureRows = [{ id: "a", doc: makeFacility({ id: "a", name: "Alpha" }) }];
  });

  it("getAllFacilities (selectAllFacilitiesResilient) projects { doc }", async () => {
    await getAllFacilities();
    expect(capturedSelectArgs).toHaveLength(1);
    assertDocOnlyProjection(capturedSelectArgs[0]);
  });

  it("getFacilityByIdCached (fetchFacilityByIdUncached) projects { doc }", async () => {
    await getFacilityByIdCached("a");
    expect(capturedSelectArgs).toHaveLength(1);
    assertDocOnlyProjection(capturedSelectArgs[0]);
  });

  it("getFacilitiesByOperator (fetchFacilitiesByOperatorUncached) projects { doc }", async () => {
    await getFacilitiesByOperator("Test Operator");
    expect(capturedSelectArgs).toHaveLength(1);
    assertDocOnlyProjection(capturedSelectArgs[0]);
  });
});
