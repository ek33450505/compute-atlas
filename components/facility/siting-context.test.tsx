import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SitingContextSection, hasSitingContext } from "./siting-context";
import type { DataCenterFacility } from "@/lib/schema";

/** Minimal data-center Facility stub with required fields. */
function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 40.0, lon: -90.0, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/source",
        label: "Source",
        retrievedAt: "2024-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

describe("hasSitingContext", () => {
  it("returns true for a facility id present in the siting-context artifact", () => {
    const facility = makeFacility({ id: "xai-colossus-memphis-tn" });
    expect(hasSitingContext(facility)).toBe(true);
  });

  it("returns false for a facility id with no siting-context entry", () => {
    const facility = makeFacility({ id: "not-a-real-facility-id-xyz" });
    expect(hasSitingContext(facility)).toBe(false);
  });
});

describe("SitingContextSection", () => {
  it("renders nearest water and transmission data with the source citation", () => {
    const facility = makeFacility({ id: "xai-colossus-memphis-tn" });
    render(<SitingContextSection facility={facility} />);

    expect(screen.getByRole("heading", { name: "Siting context" })).toBeInTheDocument();
    expect(screen.getByText(/Nonconnah Creek/)).toBeInTheDocument();
    expect(screen.getByText(/0\.7 mi/)).toBeInTheDocument();
    expect(screen.getByText(/500 kV line/)).toBeInTheDocument();
    expect(
      screen.getByText(/USGS National Hydrography Dataset/)
    ).toBeInTheDocument();
    expect(screen.getByText(/HIFLD/)).toBeInTheDocument();
  });

  it("returns null when the facility has no siting-context entry", () => {
    const facility = makeFacility({ id: "not-a-real-facility-id-xyz" });
    const { container } = render(<SitingContextSection facility={facility} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("phrases a zero-distance waterway as 'On <name>'", () => {
    const facility = makeFacility({ id: "beale-project-mustang-claremore-ok" });
    render(<SitingContextSection facility={facility} />);

    expect(screen.getByText(/^On Cat Creek$/)).toBeInTheDocument();
  });

  it("phrases a zero-distance transmission line as 'On a <voltage> kV transmission line'", () => {
    const facility = makeFacility({ id: "32-avenue-of-the-americas-ny" });
    render(<SitingContextSection facility={facility} />);

    expect(screen.getByText(/^On a 345 kV transmission line$/)).toBeInTheDocument();
  });
});
