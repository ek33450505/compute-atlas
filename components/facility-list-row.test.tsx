import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import { FacilityListRow } from "./facility-list-row";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "site-one",
    name: "Site One",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    capacityMw: { operational: 150 },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FacilityListRow", () => {
  it("links to the facility page and renders name, secondary content, status, and capacity", () => {
    render(
      <FacilityListRow
        facility={makeFacility()}
        secondary={<>Acme Corp &middot; Springfield, IL</>}
      />
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/facilities/site-one");
    expect(link).toHaveTextContent("Site One");
    expect(link).toHaveTextContent("Acme Corp");
    expect(link).toHaveTextContent("Springfield, IL");
    expect(link).toHaveTextContent("150 MW");
    expect(link).toHaveTextContent("Operational");
  });

  it("accepts a plain string secondary (location-only caller shape)", () => {
    render(
      <FacilityListRow facility={makeFacility()} secondary="Springfield, IL" />
    );
    expect(screen.getByRole("link")).toHaveTextContent("Springfield, IL");
  });

  it("renders 'planned' capacity and a different status when the facility has no operational capacity", () => {
    render(
      <FacilityListRow
        facility={makeFacility({
          id: "site-two",
          name: "Site Two",
          status: "proposed",
          capacityMw: { planned: 400 },
        })}
        secondary="Peoria, IL"
      />
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/facilities/site-two");
    expect(link).toHaveTextContent("400 MW planned");
    expect(link).toHaveTextContent("Proposed");
  });

  it("renders an em dash for capacity when the facility discloses no capacity figure", () => {
    render(
      <FacilityListRow
        facility={makeFacility({ capacityMw: undefined })}
        secondary="Peoria, IL"
      />
    );
    expect(screen.getByRole("link")).toHaveTextContent("—");
  });
});
