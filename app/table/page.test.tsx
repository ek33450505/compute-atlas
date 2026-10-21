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

describe("/table page", () => {
  it("passes slim TableRow props, not full records, plus the snapshot key", async () => {
    mockGetAllFacilities.mockResolvedValue([FULL]);
    render(await TablePage());
    const props = explorerProps.current!;
    expect(props.mode).toBe("table");
    expect(props.snapshot).toEqual({ asOf: "2026-10-20T00:00:00.000Z" });
    const rows = props.facilities as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "acme-1", sourceCount: 2 });
    expect(rows[0].sources).toHaveLength(1);
    const json = JSON.stringify(rows);
    for (const k of ["statusHistory", "community", "notes", "secret prose", "example.com/b"]) {
      expect(json).not.toContain(k);
    }
  });
});
