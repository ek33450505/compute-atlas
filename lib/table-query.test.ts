import { describe, it, expect } from "vitest";

import { facilitiesSchema, type Facility } from "@/lib/schema";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-limits";
import { PAGE_SIZE, queryTable, type TableQueryParams } from "@/lib/table-query";

function make(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `f-${String(i).padStart(3, "0")}`,
    name: `Site ${String(i).padStart(3, "0")}`,
    operator: i % 2 ? "Odd Co" : "Even Co",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 30, lon: -97, state: i % 3 ? "TX" : "OK" },
    capacityMw: { operational: 10 },
    statusHistory: [],
    sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01", kind: "other" }],
    lastUpdated: "2026-01-01",
    ...over,
  };
}

const ALL: Facility[] = facilitiesSchema.parse(
  // Input order deliberately disagrees with name/id order (37 is coprime with 120), all capacities tied.
  Array.from({ length: 120 }, (_, k) => make((k * 37) % 120))
);

const P: TableQueryParams = {
  status: [],
  state: [],
  operator: [],
  facilityType: [],
  minMw: 0,
  q: "",
  sort: "capacity",
  dir: "desc",
  page: 1,
};

describe("queryTable", () => {
  it("paginates at PAGE_SIZE and reports counts", () => {
    expect(PAGE_SIZE).toBe(50);
    const r = queryTable(ALL, P);
    expect(r.rows).toHaveLength(50);
    expect(r.totalCount).toBe(120);
    expect(r.filteredCount).toBe(120);
    expect(r.pageCount).toBe(3);
    expect(queryTable(ALL, { ...P, page: 3 }).rows).toHaveLength(20);
  });

  it("clamps out-of-range pages", () => {
    expect(queryTable(ALL, { ...P, page: 99 }).page).toBe(3);
    expect(queryTable(ALL, { ...P, page: 0 }).page).toBe(1);
  });

  it("returns pageCount 1 for an empty result", () => {
    const r = queryTable(ALL, { ...P, q: "zzzz-nothing", page: 5 });
    expect(r.rows).toEqual([]);
    expect(r.filteredCount).toBe(0);
    expect(r.pageCount).toBe(1);
    expect(r.page).toBe(1);
  });

  it("is stable across pages with all-tied sort keys (no dupes, no gaps)", () => {
    const ids = [1, 2, 3].flatMap((page) => queryTable(ALL, { ...P, page }).rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(120);
    expect(ids).toEqual([...ids].sort());
  });

  it("filters by q, state and minMw", () => {
    expect(queryTable(ALL, { ...P, q: "site 007" }).filteredCount).toBe(1);
    const ok = queryTable(ALL, { ...P, state: ["OK"] });
    expect(ok.filteredCount).toBe(40);
    expect(queryTable(ALL, { ...P, minMw: 11 }).filteredCount).toBe(0);
  });

  it("caps q at MAX_SEARCH_QUERY_LEN", () => {
    const long = `site 007${" ".repeat(MAX_SEARCH_QUERY_LEN)}zzz`;
    // The tail beyond the cap is ignored, so the query reduces to "site 007".
    expect(queryTable(ALL, { ...P, q: long }).filteredCount).toBe(1);
  });

  it("derives options from the FULL set, not the filtered one", () => {
    const r = queryTable(ALL, { ...P, state: ["OK"] });
    expect(r.options.states).toEqual(["OK", "TX"]);
    expect(r.options.operators).toEqual(["Even Co", "Odd Co"]);
  });

  it("projects rows without lat/lon", () => {
    expect(JSON.stringify(queryTable(ALL, P).rows)).not.toMatch(/"lat"|"lon"/);
  });
});
