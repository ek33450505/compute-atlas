import { vi, describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { facilitiesSchema } from "@/lib/schema";

const { mockGetAllFacilities, explorerProps } = vi.hoisted(() => ({
  mockGetAllFacilities: vi.fn(),
  explorerProps: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("@/lib/data", () => ({ getAllFacilities: mockGetAllFacilities }));
vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: () => ({
    version: "1.31.0",
    asOf: "2026-10-20T00:00:00.000Z",
    recordCount: 1,
    schemaVersion: 1,
  }),
}));
vi.mock("@/components/explorer/explorer", () => ({
  Explorer: (props: Record<string, unknown>) => {
    explorerProps.current = props;
    return null;
  },
}));
vi.mock("@/components/home/graticule-survey", () => ({ GraticuleSurvey: () => null }));

import TablePage from "./page";

const [FULL] = facilitiesSchema.parse([
  {
    id: "acme-1",
    name: "Acme One",
    operator: "Acme",
    status: "operational",
    facilityType: "data_center",
    confidence: "confirmed",
    location: { lat: 31.123456789, lon: -97.987654321, state: "TX" },
    capacityMw: { operational: 10 },
    statusHistory: [{ date: "2025-01-01", status: "proposed" }],
    sources: [
      { url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01", kind: "other" },
      { url: "https://example.com/b", label: "B", retrievedAt: "2026-01-02", kind: "other" },
    ],
    notes: "secret prose",
    lastUpdated: "2026-01-01",
  },
]);

const MANY = Array.from({ length: 120 }, (_, i) => ({
  ...FULL,
  id: `acme-${i}`,
  name: `Acme ${String(i).padStart(3, "0")}`,
}));

const render_ = async (sp: Record<string, string | string[] | undefined> = {}) => {
  render(await TablePage({ searchParams: Promise.resolve(sp) }));
  return explorerProps.current!;
};

describe("/table page", () => {
  it("passes slim TableRow props, not full records", async () => {
    mockGetAllFacilities.mockResolvedValue([FULL]);
    const props = await render_();
    expect(props.mode).toBe("table");
    expect(props).not.toHaveProperty("snapshot");
    const rows = props.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "acme-1", sourceCount: 2 });
    expect(rows[0].sources).toHaveLength(1);
    const json = JSON.stringify(rows);
    for (const k of ["statusHistory", "community", "notes", "secret prose", "example.com/b"]) {
      expect(json).not.toContain(k);
    }
  });

  it("slices to 50 rows and passes the counts", async () => {
    mockGetAllFacilities.mockResolvedValue(MANY);
    const props = await render_();
    expect(props.rows).toHaveLength(50);
    expect(props).toMatchObject({ filteredCount: 120, totalCount: 120, page: 1, pageCount: 3 });
  });

  it("serves the requested page", async () => {
    mockGetAllFacilities.mockResolvedValue(MANY);
    const props = await render_({ page: "3", sort: "name", dir: "asc" });
    expect(props.rows).toHaveLength(20);
    expect((props.rows as Array<{ name: string }>)[0].name).toBe("Acme 100");
    expect(props).toMatchObject({ page: 3, sort: "name", dir: "asc" });
  });

  it("clamps an out-of-range page and ignores a junk one", async () => {
    mockGetAllFacilities.mockResolvedValue(MANY);
    expect((await render_({ page: "99" })).page).toBe(3);
    expect((await render_({ page: "abc" })).page).toBe(1);
  });

  it("filters by q on the server", async () => {
    mockGetAllFacilities.mockResolvedValue(MANY);
    const props = await render_({ q: "Acme 007" });
    expect(props).toMatchObject({ filteredCount: 1, totalCount: 120, q: "Acme 007" });
  });
});
