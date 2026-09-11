import { vi, describe, it, expect } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — define fixtures inline
// inside the factory bodies. Isolates the DB-backed branch of
// getContributorCredits from the rest of lib/data.test.ts, which relies on
// the real (unmocked) @/lib/db/client and the no-DATABASE_URL degrade path.
// Mirrors data.getRecentActivity.db.test.ts's mock shape.
vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => true,
  getDb: () => mockDb,
}));

// The production query is a single facility_history JOIN facilities JOIN
// submissions query, filtered (status = 'approved', attribution IS NOT
// NULL), deduped case-insensitively (GROUP BY lower(trim(attribution)),
// with min(attribution) picked as the displayed representative), and
// counted/sorted entirely in SQL — this drizzle mock can't exercise any of
// that predicate/grouping (a PGlite/real-DB test would be needed, out of
// scope here, same limitation the sibling getRecentActivity mock notes; the
// dedupe was instead verified with a one-off read-only query against live
// prod, see the C2 handoff notes). Instead the mock resolves directly to
// fixture rows shaped like the query's post-`groupBy` projection, already
// deduped and sorted the way the real query would leave them — this test
// suite is asserting the JS-side row mapping (count coercion, pass-through),
// not the SQL predicate/grouping itself.
const groupedRows = [
  { attribution: "alice", count: 3 },
  { attribution: "bob", count: 1 },
  { attribution: "zed", count: 1 },
];

// Flipped by the query-failure test below to make the mocked `.orderBy()`
// reject, exercising getContributorCredits's try/catch degrade path. Reset
// in a `finally` so a failure never leaks into the other tests in this file
// (Vitest runs a single file's tests sequentially by default).
let shouldFail = false;

// Minimal drizzle-query-builder stand-in for the chain:
// `.select({...}).from(...).innerJoin(...).innerJoin(...).where(...).groupBy(...).orderBy(...)`.
function makeMockDb() {
  const chain = {
    innerJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () =>
      shouldFail
        ? Promise.reject(new Error("mock query failure"))
        : Promise.resolve(groupedRows),
  };
  return {
    select: () => ({
      from: () => chain,
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { getContributorCredits } from "@/lib/data";

describe("getContributorCredits (DB path)", () => {
  it("returns one entry per attribution handle with its count", async () => {
    const credits = await getContributorCredits();
    expect(credits).toEqual([
      { attribution: "alice", count: 3 },
      { attribution: "bob", count: 1 },
      { attribution: "zed", count: 1 },
    ]);
  });

  it("coerces the SQL count into a real number, not a string", async () => {
    const credits = await getContributorCredits();
    const alice = credits.find((c) => c.attribution === "alice");
    expect(alice?.count).toBe(3);
    expect(typeof alice?.count).toBe("number");
  });
});

describe("getContributorCredits (DB path) — query failure", () => {
  // hasDatabaseUrl() is mocked true above, so this reaches the query (not
  // the early-return degrade path already covered in lib/data.test.ts).
  it("resolves to [] when the live query rejects, rather than throwing", async () => {
    shouldFail = true;
    try {
      await expect(getContributorCredits()).resolves.toEqual([]);
    } finally {
      shouldFail = false;
    }
  });
});
