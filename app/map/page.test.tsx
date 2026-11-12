import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { facilitySchema, type Facility } from "@/lib/schema";

const FULL: Facility = facilitySchema.parse({
  id: "acme-1",
  name: "Acme One",
  operator: "Acme",
  status: "operational",
  confidence: "confirmed",
  facilityType: "data_center",
  location: { lat: 31.123456, lon: -97.654321, city: "Waco", state: "TX", precision: "exact" },
  statusHistory: [{ status: "proposed", date: "2024-01-01" }],
  sources: [
    { url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01", kind: "other" },
    { url: "https://example.com/second", label: "B", retrievedAt: "2026-01-01", kind: "other" },
  ],
  lastUpdated: "2026-01-01",
  notes: "heavy prose that must not reach the client",
});

const { explorerSpy, mockLoadOfferCounts } = vi.hoisted(() => ({
  explorerSpy: vi.fn(),
  mockLoadOfferCounts: vi.fn(),
}));

vi.mock("@/lib/dataset-offer", () => ({ loadOfferCounts: mockLoadOfferCounts }));

vi.mock("@/lib/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data")>()),
  getAllFacilities: async () => [FULL],
  getStats: async () => ({ count: 1, stateCodes: ["TX"] }),
  getTopStates: async () => [{ state: "TX", count: 1 }],
  getTopOperators: async () => [{ operator: "Acme", count: 1 }],
  getStatusCounts: async () => ({
    operational: 1,
    under_construction: 0,
    permitted: 0,
    proposed: 0,
    cancelled: 0,
  }),
  getFacilityTypeCounts: async () => ({ data_center: 1, crypto_mining: 0, power_generation: 0 }),
}));

vi.mock("@/components/explorer/explorer", () => ({
  Explorer: (props: unknown) => {
    explorerSpy(props);
    return null;
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import MapPage, { generateMetadata } from "./page";

describe("MapPage", () => {
  beforeEach(() => {
    mockLoadOfferCounts.mockReset().mockResolvedValue({
      facilities: 1,
      stateCodes: ["TX"],
      asOf: "2026-11-12T08:00:00.000Z",
    });
  });

  it("hands Explorer only MapPoints: no name, operator, capacity, sources or city", async () => {
    render(await MapPage());
    const props = explorerSpy.mock.calls[0][0] as {
      mode: string;
      points: Record<string, unknown>[];
      facilities?: unknown;
    };
    expect(props.mode).toBe("map");
    expect(props.facilities).toBeUndefined();
    expect(props.points).toHaveLength(1);

    const point = props.points[0];
    expect(Object.keys(point).sort()).toEqual(["facilityType", "id", "location", "status"]);
    expect(Object.keys(point.location as object).sort()).toEqual(["lat", "lon", "state"]);

    const json = JSON.stringify(props.points);
    for (const leaked of ["Acme One", "Acme", "Waco", "capacityMw", "sources", "heavy prose", "statusHistory", "31.123456"]) {
      expect(json).not.toContain(leaked);
    }
    expect(point.location).toMatchObject({ lat: 31.12, lon: -97.65 });
  });

  it("passes precomputed filter options (operator names only, no records)", async () => {
    render(await MapPage());
    const props = explorerSpy.mock.calls[0][0] as { options: { operators: string[]; states: string[] } };
    expect(props.options.operators).toEqual(["Acme"]);
    expect(props.options.states).toEqual(["TX"]);
  });

  it("still server-renders the indexable heading and summary text", async () => {
    render(await MapPage());
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Map of US data centers, crypto-mining sites, and power generation",
      })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Acme/).length).toBeGreaterThan(0);
  });

  it("dates the total in the body and the description when the offer read counted the same number", async () => {
    render(await MapPage());
    expect(
      screen.getByText(/all 1 tracked sites, counted on 12 November 2026, across/)
    ).toBeInTheDocument();
    const meta = await generateMetadata();
    expect(meta.description).toContain("1 US data centers");
    expect(meta.description).toContain("counted on 12 November 2026");
  });

  it("shows getStats' number with no date when the offer read counted a different total", async () => {
    mockLoadOfferCounts.mockResolvedValue({
      facilities: 3174,
      stateCodes: ["TX"],
      asOf: "2026-11-12T08:00:00.000Z",
    });
    render(await MapPage());
    expect(screen.getByText(/all 1 tracked sites across/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("counted on");
    const meta = await generateMetadata();
    expect(meta.description).toContain("1 US data centers");
    expect(meta.description).not.toContain("counted on");
  });

  it("shows no date when the offer read fails", async () => {
    mockLoadOfferCounts.mockResolvedValue(null);
    render(await MapPage());
    expect(document.body.textContent).not.toContain("counted on");
    expect((await generateMetadata()).description).not.toContain("counted on");
  });
});
