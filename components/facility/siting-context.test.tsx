import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SitingContextSection, hasSitingContext } from "./siting-context";
import type { DataCenterFacility } from "@/lib/schema";

// Two synthetic ids let us exercise field-presence combinations that don't
// occur in the real data/siting-context.json (every facility with
// nearestWater in the current dataset also has waterStress). All other ids
// fall through to the real getSitingContext lookup.
vi.mock("@/lib/siting-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/siting-context")>();
  return {
    ...actual,
    getSitingContext: (id: string) => {
      if (id === "only-nearest-water-test") {
        return {
          nearestWater: { name: "Test River", kind: "river", distanceMi: 1.2 },
        };
      }
      if (id === "only-water-stress-test") {
        return {
          waterStress: { cat: 4, label: "Extremely High (>80%)" },
        };
      }
      return actual.getSitingContext(id);
    },
  };
});

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

  it("returns true for a context with only waterStress", () => {
    const facility = makeFacility({ id: "only-water-stress-test" });
    expect(hasSitingContext(facility)).toBe(true);
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

  it("renders water stress, groundwater decline, and aquifer when present", () => {
    const facility = makeFacility({ id: "xai-colossus-memphis-tn" });
    render(<SitingContextSection facility={facility} />);

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
    render(<SitingContextSection facility={facility} />);

    expect(screen.getByText(/Test River/)).toBeInTheDocument();
    expect(screen.queryByText("Baseline water stress")).not.toBeInTheDocument();
    expect(screen.queryByText("Groundwater decline")).not.toBeInTheDocument();
    expect(screen.queryByText("Principal aquifer")).not.toBeInTheDocument();
  });

  it("renders a facility with only waterStress (no nearestWater/nearestTransmission)", () => {
    const facility = makeFacility({ id: "only-water-stress-test" });
    render(<SitingContextSection facility={facility} />);

    expect(screen.getByText("Baseline water stress")).toBeInTheDocument();
    expect(screen.getByText("Extremely High")).toBeInTheDocument();
    expect(screen.getByText("(>80%)")).toBeInTheDocument();
    expect(screen.queryByText("Nearest named waterway")).not.toBeInTheDocument();
  });
});
