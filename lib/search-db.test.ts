import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — mirrors the mocking
// pattern in lib/data.getRecentActivity.db.test.ts. `hasDatabaseUrl` is
// mutable per-test via `mockHasDatabaseUrl` so the "DB unset" short-circuit
// can be exercised without a second test file.
let mockHasDatabaseUrl = true;

vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: () => mockHasDatabaseUrl,
  getDb: () => mockDb,
}));

interface FixtureRow {
  id: string;
  doc: { id: string; name: string };
}

let fixtureRows: FixtureRow[] = [];

// Captures the raw SQL fragments passed to `.where()`/`.orderBy()` so tests
// can assert the query shape (plainto_tsquery usage, search_vector column,
// ts_rank ordering) without a live Postgres connection.
let capturedWhereSql: string | undefined;
let capturedOrderBySql: string | undefined;

/**
 * A drizzle-orm `sql` tagged-template value is a `SQL` object whose
 * `queryChunks` array interleaves three kinds of entries — none of which
 * render via plain `.toString()`/`toQuery()` outside a live dialect context:
 *   - raw SQL-fragment strings (e.g. `" @@ plainto_tsquery('english', "`)
 *   - `{ value: [...] }` bound-param chunks (the interpolated query text)
 *   - `Column`-like objects (e.g. `PgCustomColumn` for `${facilitiesTable
 *     .searchVector}`), which carry the real column name on `.name`
 * This flattens all three into one inspectable string so tests can assert on
 * SQL keyword/column presence without a live Postgres connection.
 */
function flattenSqlChunks(clause: unknown): string {
  const chunks = (clause as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const asColumn = chunk as { name?: unknown };
      if (typeof asColumn.name === "string") return asColumn.name;
      return JSON.stringify((chunk as { value?: unknown }).value);
    })
    .join(" ");
}

// A minimal drizzle-query-builder stand-in, same shape as the mock in
// lib/data.getRecentActivity.db.test.ts: `.select().from().where().orderBy()`
// resolves to the fixture rows.
function makeMockDb() {
  return {
    select: () => ({
      from: () => ({
        where: (whereClause: unknown) => {
          capturedWhereSql = flattenSqlChunks(whereClause);
          return {
            orderBy: (orderByClause: unknown) => {
              capturedOrderBySql = flattenSqlChunks(orderByClause);
              return Promise.resolve(fixtureRows);
            },
          };
        },
      }),
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { searchFacilitiesDb } from "@/lib/search-db";

describe("searchFacilitiesDb", () => {
  beforeEach(() => {
    mockHasDatabaseUrl = true;
    capturedWhereSql = undefined;
    capturedOrderBySql = undefined;
    fixtureRows = [
      { id: "facility-a", doc: { id: "facility-a", name: "Facility A" } },
      { id: "facility-b", doc: { id: "facility-b", name: "Facility B" } },
    ];
  });

  it("returns [] without querying when DATABASE_URL is unset", async () => {
    mockHasDatabaseUrl = false;
    const results = await searchFacilitiesDb("hyperscale");
    expect(results).toEqual([]);
    expect(capturedWhereSql).toBeUndefined();
  });

  it("returns [] without querying for an empty query string", async () => {
    const results = await searchFacilitiesDb("");
    expect(results).toEqual([]);
    expect(capturedWhereSql).toBeUndefined();
  });

  it("returns [] without querying for a whitespace-only query string", async () => {
    const results = await searchFacilitiesDb("   ");
    expect(results).toEqual([]);
    expect(capturedWhereSql).toBeUndefined();
  });

  it("parses each returned row's doc column back to a Facility via rowToFacility", async () => {
    const results = await searchFacilitiesDb("hyperscale campus");
    expect(results).toEqual([
      { id: "facility-a", name: "Facility A" },
      { id: "facility-b", name: "Facility B" },
    ]);
  });

  it("builds a WHERE clause referencing plainto_tsquery and search_vector", async () => {
    await searchFacilitiesDb("hyperscale");
    expect(capturedWhereSql).toContain("plainto_tsquery");
    expect(capturedWhereSql).toContain("search_vector");
  });

  it("builds an ORDER BY clause ranking via ts_rank", async () => {
    await searchFacilitiesDb("hyperscale");
    expect(capturedOrderBySql).toContain("ts_rank");
    expect(capturedOrderBySql).toContain("plainto_tsquery");
  });

  it("trims the query before use", async () => {
    await searchFacilitiesDb("  hyperscale  ");
    // The mock resolves regardless of trimming, but the short-circuit tests
    // above already prove whitespace-only trims to empty; this asserts a
    // padded-but-non-empty query still reaches the query builder.
    expect(capturedWhereSql).toContain("plainto_tsquery");
  });
});
