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

// When set, the mock query rejects instead of resolving — stands in for a live
// Neon failure (unreachable / over quota) so the degrade path can be exercised.
let queryError: Error | null = null;

// Captures the raw SQL fragments passed to `.where()`/`.orderBy()` so tests
// can assert the query shape (to_tsquery usage, the bound tsquery expression,
// search_vector column, ts_rank ordering) without a live Postgres connection.
let capturedWhereSql: string | undefined;
let capturedOrderBySql: string | undefined;

/**
 * A drizzle-orm `sql` tagged-template value is a `SQL` object whose
 * `queryChunks` array interleaves three kinds of entries — none of which
 * render via plain `.toString()`/`toQuery()` outside a live dialect context:
 *   - raw SQL-fragment strings (e.g. `" @@ to_tsquery('english', "`)
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
              return queryError ? Promise.reject(queryError) : Promise.resolve(fixtureRows);
            },
          };
        },
      }),
    }),
  };
}

const mockDb = makeMockDb();

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { buildTsQuery, searchFacilitiesDb } from "@/lib/search-db";

describe("buildTsQuery", () => {
  it("returns null for an empty or whitespace-only query", () => {
    expect(buildTsQuery("")).toBeNull();
    expect(buildTsQuery("   ")).toBeNull();
  });

  it("returns null for a punctuation-only query (to_tsquery would throw)", () => {
    expect(buildTsQuery("!!!")).toBeNull();
    expect(buildTsQuery("&|():*")).toBeNull();
  });

  it("marks a single token as a prefix", () => {
    expect(buildTsQuery("goo")).toBe("goo:*");
  });

  it("ANDs complete words and prefixes only the last token", () => {
    expect(buildTsQuery("google council")).toBe("google & council:*");
    expect(buildTsQuery("a b c")).toBe("a & b & c:*");
  });

  it("strips tsquery operator characters from the tokens it emits", () => {
    expect(buildTsQuery("goo:*!bar")).toBe("goo & bar:*");
  });

  it("keeps digits and splits on punctuation and underscores", () => {
    expect(buildTsQuery("site-42_north")).toBe("site & 42 & north:*");
  });

  // Stop words, digits and non-Latin tokens all survive tokenization here —
  // `buildTsQuery` does no dictionary work, it only bounds the string. What
  // Postgres then does with that string was MEASURED against the live Neon
  // database on 2026-08-17 (observed, not assumed):
  //
  //   'google:*'         -> 'googl':*   75 matches
  //   'goo:*'            -> 'goo':*     85 matches   (0 under plainto_tsquery)
  //   'the:*'            -> ''           0 matches, NO ERROR
  //   'google & the:*'   -> 'googl'     74 matches, NO ERROR (stop word dropped)
  //   'of & and & the:*' -> ''           0 matches, NO ERROR
  //   '123:*'            -> '123':*      4 matches
  //   '中文:*'            -> '中文':*     0 matches
  //
  // i.e. the english dictionary drops stop words from the parsed tsquery and
  // an all-stop-word query yields an EMPTY tsquery that matches nothing —
  // `to_tsquery` does not raise a syntax error on any of them. Only a truly
  // empty string does, which is why `buildTsQuery` returns null there instead.
  // These unit tests assert the BOUND STRING this function emits; they do not
  // and cannot assert Postgres's response — that half is the measurement above.
  describe("stop words, digits and non-Latin tokens", () => {
    it("emits a lone stop word as an ordinary prefix token", () => {
      expect(buildTsQuery("the")).toBe("the:*");
    });

    it("keeps a trailing stop word rather than dropping it client-side", () => {
      expect(buildTsQuery("google the")).toBe("google & the:*");
    });

    it("emits an all-stop-word query unchanged (Postgres reduces it to empty)", () => {
      expect(buildTsQuery("of and the")).toBe("of & and & the:*");
    });

    it("emits a digit-only token as a prefix", () => {
      expect(buildTsQuery("123")).toBe("123:*");
    });

    it("keeps non-Latin tokens — \\p{L} is Unicode-aware, not ASCII-only", () => {
      expect(buildTsQuery("中文")).toBe("中文:*");
      expect(buildTsQuery("münchen rechenzentrum")).toBe("münchen & rechenzentrum:*");
    });
  });

  it("caps the number of tokens at 10", () => {
    const query = Array.from({ length: 25 }, (_, i) => `t${i}`).join(" ");
    const built = buildTsQuery(query);
    expect(built?.split(" & ")).toHaveLength(10);
    expect(built).toBe(
      "t0 & t1 & t2 & t3 & t4 & t5 & t6 & t7 & t8 & t9:*"
    );
  });
});

describe("searchFacilitiesDb", () => {
  beforeEach(() => {
    mockHasDatabaseUrl = true;
    capturedWhereSql = undefined;
    capturedOrderBySql = undefined;
    queryError = null;
    fixtureRows = [
      { id: "facility-a", doc: { id: "facility-a", name: "Facility A" } },
      { id: "facility-b", doc: { id: "facility-b", name: "Facility B" } },
    ];
  });

  it("returns [] without querying when DATABASE_URL is unset", async () => {
    mockHasDatabaseUrl = false;
    const result = await searchFacilitiesDb("hyperscale");
    expect(result).toEqual({ facilities: [], degraded: false });
    expect(capturedWhereSql).toBeUndefined();
  });

  it("returns [] without querying for an empty query string", async () => {
    const result = await searchFacilitiesDb("");
    expect(result).toEqual({ facilities: [], degraded: false });
    expect(capturedWhereSql).toBeUndefined();
  });

  it("returns [] without querying for a whitespace-only query string", async () => {
    const result = await searchFacilitiesDb("   ");
    expect(result).toEqual({ facilities: [], degraded: false });
    expect(capturedWhereSql).toBeUndefined();
  });

  it("returns [] without querying for a punctuation-only query", async () => {
    // `to_tsquery('english', '')` is a syntax error in Postgres, so a query
    // that tokenizes to nothing must never reach the DB. This guard now sits
    // ABOVE the cache in `searchFacilitiesDb`, with the original one kept in
    // `searchFacilitiesDbUncached` as defence in depth. Honest note: the hoist
    // itself is not independently observable from here — under `VITEST` the
    // `unstable_cache` wrapper is bypassed entirely, so this asserts the
    // behavioural contract (empty result, no query issued), not which of the
    // two guards produced it.
    const result = await searchFacilitiesDb("!!!");
    expect(result).toEqual({ facilities: [], degraded: false });
    expect(capturedWhereSql).toBeUndefined();
  });

  it("degrades to [] and warns when the DB query fails", async () => {
    // A live Neon failure must not surface on the public, unauthenticated
    // /api/search as a 500 — every other public read path here degrades to
    // empty (`getRecentActivity` in lib/data.ts).
    queryError = new Error("connection terminated unexpectedly");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await searchFacilitiesDb("hyperscale");

    expect(result.facilities).toEqual([]);
    // The distinguishing bit: a blip's `[]` must not look like a genuine
    // "no matches" `[]` to the caller, which decides whether to let the CDN
    // cache the body for the next 600s (app/api/search/route.ts).
    expect(result.degraded).toBe(true);
    // Silent data loss is not the goal — the failure stays visible to an
    // operator, with the underlying error attached.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("searchFacilitiesDb"),
      queryError
    );
    warn.mockRestore();
  });

  it("still returns rows normally after a failed query (no latched state)", async () => {
    queryError = new Error("transient");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await searchFacilitiesDb("hyperscale");
    warn.mockRestore();

    queryError = null;
    const result = await searchFacilitiesDb("hyperscale");
    expect(result.degraded).toBe(false);
    expect(result.facilities).toEqual([
      { id: "facility-a", name: "Facility A" },
      { id: "facility-b", name: "Facility B" },
    ]);
  });

  it("parses each returned row's doc column back to a Facility via rowToFacility", async () => {
    const result = await searchFacilitiesDb("hyperscale campus");
    expect(result.degraded).toBe(false);
    expect(result.facilities).toEqual([
      { id: "facility-a", name: "Facility A" },
      { id: "facility-b", name: "Facility B" },
    ]);
  });

  it("builds a WHERE clause referencing to_tsquery and search_vector", async () => {
    await searchFacilitiesDb("hyperscale");
    expect(capturedWhereSql).toContain("to_tsquery");
    // `plainto_tsquery` matches whole stemmed words only, which breaks
    // as-you-type prefix search — assert it is gone, not merely that
    // "to_tsquery" appears (it is a substring of "plainto_tsquery").
    expect(capturedWhereSql).not.toContain("plainto_tsquery");
    expect(capturedWhereSql).toContain("search_vector");
  });

  it("binds a prefix-marked tsquery expression as a parameter", async () => {
    await searchFacilitiesDb("hyper campus");
    expect(capturedWhereSql).toContain("hyper & campus:*");
  });

  it("builds an ORDER BY clause ranking via ts_rank over the same tsquery", async () => {
    await searchFacilitiesDb("hyper campus");
    expect(capturedOrderBySql).toContain("ts_rank");
    expect(capturedOrderBySql).not.toContain("plainto_tsquery");
    expect(capturedOrderBySql).toContain("hyper & campus:*");
  });

  it("trims the query before use", async () => {
    await searchFacilitiesDb("  hyperscale  ");
    // The mock resolves regardless of trimming, but the short-circuit tests
    // above already prove whitespace-only trims to empty; this asserts a
    // padded-but-non-empty query still reaches the query builder, with no
    // stray whitespace token in the bound expression.
    expect(capturedWhereSql).toContain("hyperscale:*");
  });
});
