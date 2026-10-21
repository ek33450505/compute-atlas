import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { facilitiesSchema } from "@/lib/schema";
import { toMapFacility } from "@/lib/facility-slim";
import { FacilityPopup } from "./facility-popup";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Records go through the real projector, so a field the popup reads but the
// projection dropped shows up here as missing text.
const SOURCES = [
  { url: "https://example.com/first", label: "First Source", retrievedAt: "2026-01-01", kind: "press" },
  { url: "https://example.com/second", label: "Second Source", retrievedAt: "2026-01-01", kind: "press" },
];

const BASE = {
  id: "acme-1",
  name: "Acme One",
  operator: "Acme",
  status: "operational",
  confidence: "reported",
  statusHistory: [],
  sources: SOURCES,
  lastUpdated: "2026-01-01",
  notes: "long prose",
};

const [dataCenter, multiSite, mining] = facilitiesSchema.parse([
  {
    ...BASE,
    facilityType: "data_center",
    aiClassification: "mixed_use",
    location: { lat: 31.5, lon: -97.5, city: "Waco", state: "TX" },
    capacityMw: { operational: 100, planned: 250 },
  },
  {
    ...BASE,
    id: "acme-2",
    name: "Acme Fleet",
    facilityType: "crypto_mining",
    location: {
      lat: 35,
      lon: -100,
      state: "TX",
      precision: "representative_multi_site",
      multiSite: { states: ["TX", "OK"], siteCountNote: "12 sites" },
    },
  },
  {
    ...BASE,
    id: "acme-3",
    name: "Acme Miner",
    facilityType: "crypto_mining",
    location: { lat: 40, lon: -90, city: "Joliet", state: "IL" },
    mining: { hashRateThPerS: 500, powerArrangement: "stranded_gas" },
    environmental: { carbonIntensityProxy: 42 },
  },
]);

describe("FacilityPopup with a projected record", () => {
  it("shows the first source link and capacity for a data center", () => {
    render(<FacilityPopup facility={toMapFacility(dataCenter)} onClose={() => {}} />);
    const link = screen.getByRole("link", { name: "First Source (opens in new tab)" });
    expect(link).toHaveAttribute("href", "https://example.com/first");
    // Popup contract: only the first source is linked. The projection-side
    // guard (second source never reaches the client) is in lib/facility-slim.test.ts.
    expect(screen.queryByText(/Second Source/)).not.toBeInTheDocument();
    expect(screen.getByText("100 MW operational")).toBeInTheDocument();
    expect(screen.getByText("250 MW planned")).toBeInTheDocument();
    expect(screen.getByText("Waco, TX")).toBeInTheDocument();
    expect(screen.getByText("mixed use · reported")).toBeInTheDocument();
  });

  it("shows the multi-site line with its states", () => {
    render(<FacilityPopup facility={toMapFacility(multiSite)} onClose={() => {}} />);
    expect(
      screen.getByText(/Distributed operation — pin is illustrative \(TX, OK\)/)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /First Source/ })).toBeInTheDocument();
  });

  it("shows mining and environmental details for a crypto-mining site", () => {
    render(<FacilityPopup facility={toMapFacility(mining)} onClose={() => {}} />);
    expect(screen.getByText("500 TH/s")).toBeInTheDocument();
    expect(screen.getByText("stranded gas")).toBeInTheDocument();
    expect(screen.getByText("Carbon proxy: 42")).toBeInTheDocument();
  });

  it("renders without a Source link when the record has no sources", () => {
    const noSources = toMapFacility({ ...dataCenter, sources: [] });
    render(<FacilityPopup facility={noSources} onClose={() => {}} />);
    expect(screen.queryByRole("link", { name: /opens in new tab/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View details/ })).toHaveAttribute(
      "href",
      "/facilities/acme-1"
    );
  });
});
