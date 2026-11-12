import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import type { DataCenterFacility } from "@/lib/schema";
import { PrintGapSummary } from "./print-gap-summary";
import { CivicImpactSection } from "./civic-impact";

// Print must not change when the on-screen gap prompts were replaced by one
// card: the brief's consolidated nil line and its per-field "Not recorded"
// markers are pinned here on a sparse record. The expected text and counts are
// what the page printed with the old prompts in place.

function makeSparse(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [{ url: "https://example.com/s", label: "Source", retrievedAt: "2024-01-01", kind: "press" }],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

describe("print brief is unchanged on a sparse record", () => {
  it("keeps the consolidated nil line naming every empty section", async () => {
    const { container } = render(await PrintGapSummary({ facility: makeSparse(), siting: undefined }));

    expect(container.querySelector("[data-print-gap-summary]")).toHaveTextContent(
      "Not recorded: siting context, power supply, economic impact, energy and water, air permit, public subsidies, stakeholders."
    );
  });

  it("keeps one hidden nil marker per empty field row in civic impact, and none for empty groups", () => {
    // energy only: on-site generation + water use are empty field rows (2);
    // economics/air permit/subsidies are whole-group gaps, named by the summary instead.
    const { container } = render(<CivicImpactSection facility={makeSparse({ energy: { source: "grid" } })} />);

    const nils = container.querySelectorAll("[data-print-nil]");
    expect(nils).toHaveLength(2);
    for (const nil of nils) {
      expect(nil).toHaveClass("hidden");
      expect(nil).toHaveTextContent("Not recorded");
    }
  });

  it("keeps a nil per empty economics row when one economics field is recorded", () => {
    const { container } = render(
      <CivicImpactSection facility={makeSparse({ investmentUsd: 1_000_000 })} />
    );

    // land + jobs; energy & water is a whole-group gap here, so it adds none.
    expect(container.querySelectorAll("[data-print-nil]")).toHaveLength(2);
  });
});
