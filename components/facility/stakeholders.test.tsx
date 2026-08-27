import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { StakeholdersSection, hasStakeholders } from "./stakeholders";
import type { DataCenterFacility } from "@/lib/schema";

/** Minimal data-center Facility stub with required fields. */
function makeFacility(
  overrides: Partial<DataCenterFacility> = {}
): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: {
      lat: 40.0,
      lon: -90.0,
      city: "Springfield",
      state: "IL",
      precision: "exact",
    },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/founder-source",
        label: "Founder Filing",
        retrievedAt: "2024-01-01",
        kind: "filing",
      },
      {
        url: "https://example.com/official-source",
        label: "County Meeting Minutes",
        retrievedAt: "2024-02-01",
        kind: "other",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

describe("hasStakeholders", () => {
  it("returns false when the facility has no stakeholders", () => {
    expect(hasStakeholders(makeFacility())).toBe(false);
  });

  it("returns false when stakeholders is an empty array", () => {
    expect(hasStakeholders(makeFacility({ stakeholders: [] }))).toBe(false);
  });

  it("returns true when at least one stakeholder is present", () => {
    const facility = makeFacility({
      stakeholders: [
        { name: "Jane Doe", role: "founder", sourceIndex: 0, asOf: "2024-01-01" },
      ],
    });
    expect(hasStakeholders(facility)).toBe(true);
  });
});

describe("StakeholdersSection", () => {
  it("renders nothing when the facility has no stakeholders", () => {
    const { container } = render(
      <StakeholdersSection facility={makeFacility()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a financial-interest entry with its source link", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Jane Doe",
          role: "founder",
          via: "Acme Holdings",
          note: "Co-founded the parent company.",
          sourceIndex: 0,
          asOf: "2024-01-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    expect(
      screen.getByRole("heading", { name: "Notable stakeholders" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ownership and financial interest" })
    ).toBeInTheDocument();
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe via Acme Holdings")).toBeInTheDocument();
    expect(
      screen.getByText("Co-founded the parent company.")
    ).toBeInTheDocument();
    expect(screen.getByText(/As of 2024-01-01/)).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /Founder Filing \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/founder-source");
  });

  it("renders the public-official group with its caption", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Senator Smith",
          role: "public_official",
          note: "Voted to approve the rezoning.",
          sourceIndex: 1,
          asOf: "2024-02-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    expect(
      screen.getByRole("heading", { name: "Public officials" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Officials with a documented role in this site.s approval or funding\. Listing here does not imply a financial interest\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Public official")).toBeInTheDocument();
    expect(screen.getByText("Senator Smith")).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /County Meeting Minutes \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/official-source"
    );
  });

  it("does not render a public_official entry under the financial-interest heading", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Jane Doe",
          role: "founder",
          sourceIndex: 0,
          asOf: "2024-01-01",
        },
        {
          name: "Senator Smith",
          role: "public_official",
          sourceIndex: 1,
          asOf: "2024-02-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    const financialHeading = screen.getByRole("heading", {
      name: "Ownership and financial interest",
    });
    const financialGroup = financialHeading.closest("div") as HTMLElement;
    expect(financialGroup).not.toBeNull();
    expect(within(financialGroup).getByText("Jane Doe")).toBeInTheDocument();
    expect(
      within(financialGroup).queryByText("Senator Smith")
    ).not.toBeInTheDocument();

    const officialsHeading = screen.getByRole("heading", {
      name: "Public officials",
    });
    const officialsGroup = officialsHeading.closest("div") as HTMLElement;
    expect(
      within(officialsGroup).queryByText("Jane Doe")
    ).not.toBeInTheDocument();
  });
});
