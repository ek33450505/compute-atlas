import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SitingContextSection, hasSitingContext } from "./siting-context";
import sitingContextRaw from "@/data/siting-context.json";
import type { SitingContext } from "@/lib/siting-context";
import type { DataCenterFacility } from "@/lib/schema";

// Two synthetic ids let us exercise field-presence combinations that don't
// occur in the real data/siting-context.json (every facility with
// nearestWater in the current dataset also has waterStress). All other ids
// look up the bundled snapshot, which holds the same rows as the Neon table.
function sitingFor(id: string): SitingContext | undefined {
  if (id === "only-nearest-water-test") {
    return { nearestWater: { name: "Test River", kind: "river", distanceMi: 1.2 } };
  }
  if (id === "only-water-stress-test") {
    return { waterStress: { cat: 4, label: "Extremely High (>80%)" } };
  }
  return (sitingContextRaw as Record<string, SitingContext>)[id];
}

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
    expect(hasSitingContext(sitingFor(facility.id))).toBe(true);
  });

  it("returns false for a facility id with no siting-context entry", () => {
    const facility = makeFacility({ id: "not-a-real-facility-id-xyz" });
    expect(hasSitingContext(sitingFor(facility.id))).toBe(false);
  });

  it("returns true for a context with only waterStress", () => {
    const facility = makeFacility({ id: "only-water-stress-test" });
    expect(hasSitingContext(sitingFor(facility.id))).toBe(true);
  });
});

describe("SitingContextSection", () => {
  it("renders nearest water and transmission data with the source citation", () => {
    const facility = makeFacility({ id: "xai-colossus-memphis-tn" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByRole("heading", { name: "Siting context" })).toBeInTheDocument();
    expect(screen.getByText(/Nonconnah Creek/)).toBeInTheDocument();
    expect(screen.getByText(/0\.7 mi/)).toBeInTheDocument();
    expect(screen.getByText(/500 kV line/)).toBeInTheDocument();
    expect(
      screen.getByText(/USGS National Hydrography Dataset/)
    ).toBeInTheDocument();
    expect(screen.getByText(/HIFLD/)).toBeInTheDocument();
  });

  it("renders a SectionGapPrompt tip trigger when the facility has no siting-context entry", () => {
    const facility = makeFacility({ id: "not-a-real-facility-id-xyz" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent(/the siting context/i);
    expect(trigger).toHaveTextContent(/test datacenter/i);
    expect(screen.queryByRole("heading", { name: "Siting context" })).not.toBeInTheDocument();
  });

  it("renders the no-data state from the prop alone, even for an id the bundled snapshot holds", () => {
    const id = "xai-colossus-memphis-tn";
    expect((sitingContextRaw as Record<string, SitingContext>)[id]?.nearestWater).toBeDefined();
    render(<SitingContextSection facility={makeFacility({ id })} siting={undefined} />);

    expect(screen.getByRole("button")).toHaveTextContent(/the siting context/i);
    expect(screen.queryByRole("heading", { name: "Siting context" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nonconnah Creek/)).not.toBeInTheDocument();
  });

  it("phrases a zero-distance waterway as 'On <name>'", () => {
    const facility = makeFacility({ id: "beale-project-mustang-claremore-ok" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByText(/^On Cat Creek$/)).toBeInTheDocument();
  });

  it("phrases a zero-distance transmission line as 'On a <voltage> kV transmission line'", () => {
    const facility = makeFacility({ id: "32-avenue-of-the-americas-ny" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByText(/^On a 345 kV transmission line$/)).toBeInTheDocument();
  });

  it("renders water stress, groundwater decline, and aquifer when present", () => {
    const facility = makeFacility({ id: "xai-colossus-memphis-tn" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByText("Baseline water stress")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("Groundwater decline")).toBeInTheDocument();
    expect(screen.getByText("Low - Medium")).toBeInTheDocument();
    expect(screen.getByText("Principal aquifer")).toBeInTheDocument();
    expect(
      screen.getByText("Mississippi Embayment Aquifer System"),
    ).toBeInTheDocument();
    expect(screen.getByText(/WRI Aqueduct 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/1:2,500,000/)).toBeInTheDocument();
  });

  it("omits water stress, groundwater decline, and aquifer datums when absent", () => {
    const facility = makeFacility({ id: "only-nearest-water-test" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByText(/Test River/)).toBeInTheDocument();
    expect(screen.queryByText("Baseline water stress")).not.toBeInTheDocument();
    expect(screen.queryByText("Groundwater decline")).not.toBeInTheDocument();
    expect(screen.queryByText("Principal aquifer")).not.toBeInTheDocument();
  });

  it("renders a facility with only waterStress (no nearestWater/nearestTransmission)", () => {
    const facility = makeFacility({ id: "only-water-stress-test" });
    render(<SitingContextSection facility={facility} siting={sitingFor(facility.id)} />);

    expect(screen.getByText("Baseline water stress")).toBeInTheDocument();
    expect(screen.getByText("Extremely High")).toBeInTheDocument();
    expect(screen.getByText("(>80%)")).toBeInTheDocument();
    expect(screen.queryByText("Nearest named waterway")).not.toBeInTheDocument();
  });
});
