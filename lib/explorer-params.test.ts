import { describe, it, expect } from "vitest";

import { loadExplorerParams } from "@/lib/explorer-params";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-limits";

describe("loadExplorerParams", () => {
  it("returns defaults for an empty query string", () => {
    expect(loadExplorerParams({})).toEqual({
      status: [],
      state: [],
      operator: [],
      facilityType: [],
      minMw: 0,
      q: "",
      sort: "capacity",
      dir: "desc",
      page: 1,
    });
  });

  it("parses existing share-link keys", () => {
    const p = loadExplorerParams({
      status: "operational,under_construction",
      state: "TX,OK",
      operator: "Acme",
      facilityType: "data_center",
      minMw: "100",
    });
    expect(p.status).toEqual(["operational", "under_construction"]);
    expect(p.state).toEqual(["TX", "OK"]);
    expect(p.operator).toEqual(["Acme"]);
    expect(p.facilityType).toEqual(["data_center"]);
    expect(p.minMw).toBe(100);
  });

  it("falls back to defaults on invalid values", () => {
    const p = loadExplorerParams({
      status: "bogus",
      facilityType: "nope",
      minMw: "abc",
      sort: "lat",
      dir: "sideways",
      page: "0",
    });
    expect(p.status).toEqual([]);
    expect(p.facilityType).toEqual([]);
    expect(p.minMw).toBe(0);
    expect(p.sort).toBe("capacity");
    expect(p.dir).toBe("desc");
    expect(p.page).toBe(1);
  });

  it("rejects negative and fractional pages", () => {
    expect(loadExplorerParams({ page: "-3" }).page).toBe(1);
    expect(loadExplorerParams({ page: "2.5" }).page).toBe(1);
    expect(loadExplorerParams({ page: "7" }).page).toBe(7);
  });

  it("trims q and caps it at MAX_SEARCH_QUERY_LEN", () => {
    expect(loadExplorerParams({ q: "  waco  " }).q).toBe("waco");
    const long = "a".repeat(MAX_SEARCH_QUERY_LEN + 50);
    expect(loadExplorerParams({ q: long }).q).toHaveLength(MAX_SEARCH_QUERY_LEN);
  });

  it("accepts every sortable column id and asc", () => {
    expect(loadExplorerParams({ sort: "name", dir: "asc" })).toMatchObject({
      sort: "name",
      dir: "asc",
    });
  });
});
