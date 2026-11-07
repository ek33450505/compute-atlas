import { describe, it, expect } from "vitest";

import { compareRows, SORT_COLUMNS } from "@/lib/table-sort";
import type { TableRow } from "@/lib/facility-slim";

function row(over: Partial<TableRow> & { id: string; name: string }): TableRow {
  return {
    operator: "Op",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { state: "TX" },
    lastUpdated: "2026-01-01",
    ...over,
  } as TableRow;
}

const sorted = (rows: TableRow[], col: Parameters<typeof compareRows>[0], dir: "asc" | "desc") =>
  [...rows].sort((a, b) => compareRows(col, dir)(a, b)).map((r) => r.id);

describe("compareRows", () => {
  it("lists the sortable column ids", () => {
    expect(SORT_COLUMNS).toContain("capacity");
    expect(SORT_COLUMNS).toContain("status");
    expect(SORT_COLUMNS).not.toContain("lat");
  });

  it("sorts status by STATUS_ORDER, not alphabetically", () => {
    const rows = [
      row({ id: "c", name: "C", status: "cancelled" }),
      row({ id: "o", name: "O", status: "operational" }),
    ];
    expect(sorted(rows, "status", "asc")).toEqual(["o", "c"]);
    expect(sorted(rows, "status", "desc")).toEqual(["c", "o"]);
  });

  it("keeps no-capacity rows last in both directions", () => {
    const rows = [
      row({ id: "none", name: "A" }),
      row({ id: "big", name: "B", capacityMw: { operational: 500 } }),
      row({ id: "small", name: "C", capacityMw: { operational: 5 } }),
    ];
    expect(sorted(rows, "capacity", "desc")).toEqual(["big", "small", "none"]);
    expect(sorted(rows, "capacity", "asc")).toEqual(["small", "big", "none"]);
  });

  it("breaks ties by name then id, independent of direction", () => {
    const rows = [
      row({ id: "2", name: "Same" }),
      row({ id: "1", name: "Same" }),
      row({ id: "3", name: "Alpha" }),
    ];
    expect(sorted(rows, "operator", "asc")).toEqual(["3", "1", "2"]);
    expect(sorted(rows, "operator", "desc")).toEqual(["3", "1", "2"]);
  });

  it("sorts undefined AI class last", () => {
    const rows = [
      row({ id: "u", name: "A" }),
      row({ id: "c", name: "B", aiClassification: "confirmed" } as Partial<TableRow> & { id: string; name: string }),
    ];
    expect(sorted(rows, "aiClassification", "asc")).toEqual(["c", "u"]);
    expect(sorted(rows, "aiClassification", "desc")).toEqual(["c", "u"]);
  });
});
