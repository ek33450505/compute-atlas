import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import { ContestedStrip } from "./contested-strip";

// ---------------------------------------------------------------------------
// Fixtures
//
// No shared facility factory exists in the repo yet — each test file (e.g.
// related-facilities.test.tsx, format.test.ts) defines its own minimal
// makeFacility() helper. This one carries only the fields ContestedStrip
// actually reads (id, name, location, community); `as Facility` is a partial
// mock cast, acceptable for a presentational component test.
// ---------------------------------------------------------------------------

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-site",
    name: "Test Site",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

const CASES: Facility[] = [
  makeFacility({
    id: "site-one",
    name: "Site One",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    community: { status: "litigation", notes: "Residents filed suit over water use." },
  }),
  makeFacility({
    id: "site-two",
    name: "Site Two",
    location: { lat: 33, lon: -84, city: "Atlanta", state: "GA", precision: "exact" },
    community: { status: "opposed", notes: "County board rejected the rezoning request." },
  }),
  makeFacility({
    id: "site-three",
    name: "Site Three",
    location: { lat: 47, lon: -122, state: "WA", precision: "exact" },
    community: { status: "contested", notes: "Neighbors dispute the water-use permit." },
  }),
];

const BREAKDOWN = { litigation: 12, opposed: 34, contested: 56 };
const FRICTION_COUNT = BREAKDOWN.litigation + BREAKDOWN.opposed + BREAKDOWN.contested;

describe("ContestedStrip", () => {
  it("renders each case as a link to its facility page", () => {
    render(
      <ContestedStrip cases={CASES} frictionCount={FRICTION_COUNT} breakdown={BREAKDOWN} />
    );

    expect(screen.getByRole("link", { name: /Site One/ })).toHaveAttribute(
      "href",
      "/facilities/site-one"
    );
    expect(screen.getByRole("link", { name: /Site Two/ })).toHaveAttribute(
      "href",
      "/facilities/site-two"
    );
    expect(screen.getByRole("link", { name: /Site Three/ })).toHaveAttribute(
      "href",
      "/facilities/site-three"
    );
  });

  it("renders formatLocation output and community notes for each case", () => {
    render(
      <ContestedStrip cases={CASES} frictionCount={FRICTION_COUNT} breakdown={BREAKDOWN} />
    );

    expect(screen.getByText("Springfield, IL")).toBeInTheDocument();
    expect(screen.getByText("Atlanta, GA")).toBeInTheDocument();
    // Site Three has no city -> formatLocation falls back to bare state.
    expect(screen.getByText("WA")).toBeInTheDocument();

    expect(
      screen.getByText("Residents filed suit over water use.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("County board rejected the rezoning request.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Neighbors dispute the water-use permit.")
    ).toBeInTheDocument();
  });

  it("renders the friction headline with the interpolated counts", () => {
    render(
      <ContestedStrip cases={CASES} frictionCount={FRICTION_COUNT} breakdown={BREAKDOWN} />
    );

    expect(
      screen.getByText(
        `${FRICTION_COUNT} tracked sites carry a documented friction status — ${BREAKDOWN.litigation} in litigation, ${BREAKDOWN.opposed} opposed, ${BREAKDOWN.contested} contested — each with a public source.`
      )
    ).toBeInTheDocument();
  });

  it("renders the trailing link to /opposition", () => {
    render(
      <ContestedStrip cases={CASES} frictionCount={FRICTION_COUNT} breakdown={BREAKDOWN} />
    );

    const trailing = screen.getByRole("link", { name: /See all contested sites/ });
    expect(trailing).toHaveAttribute("href", "/opposition");
  });

  it("renders the header, lead, and trailing link with an empty cases list, without crashing", () => {
    render(<ContestedStrip cases={[]} frictionCount={0} breakdown={{ litigation: 0, opposed: 0, contested: 0 }} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Contested sites" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "0 tracked sites carry a documented friction status — 0 in litigation, 0 opposed, 0 contested — each with a public source."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See all contested sites/ })).toHaveAttribute(
      "href",
      "/opposition"
    );
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("passes className through to the section element", () => {
    const { container } = render(
      <ContestedStrip
        cases={CASES}
        frictionCount={FRICTION_COUNT}
        breakdown={BREAKDOWN}
        className="mt-12 border-t border-border pt-10"
      />
    );

    const section = container.querySelector("section");
    expect(section).toHaveClass("mt-12", "border-t", "border-border", "pt-10");
  });
});
