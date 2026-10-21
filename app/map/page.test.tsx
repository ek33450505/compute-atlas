import { vi, describe, it, expect } from "vitest";
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

const { explorerSpy } = vi.hoisted(() => ({ explorerSpy: vi.fn() }));

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

import MapPage from "./page";

describe("MapPage", () => {
  it("hands Explorer the slim projection, not the full records", async () => {
    render(await MapPage());
    const props = explorerSpy.mock.calls[0][0] as { mode: string; facilities: unknown[] };
    expect(props.mode).toBe("map");
    const json = JSON.stringify(props.facilities);
    expect(json).not.toContain("heavy prose");
    expect(json).not.toContain("statusHistory");
    expect(json).not.toContain("example.com/second");
    expect(props.facilities).toHaveLength(1);
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
});
