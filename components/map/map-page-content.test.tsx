import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MapPageContent, type MapPageContentProps } from "./map-page-content";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in
// jsdom. Spreads the rest of the props (notably `aria-label`) through, rather
// than naming each one, so an accessibility attribute added at the call site
// isn't silently dropped by the mock.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures — deliberately adversarial: distinct, non-round, non-coincident
// counts so a swapped label/count or a broken zero-filter changes the
// rendered text rather than passing by accident. `stateCodes` carries states
// AND DC AND a territory — the one combination that can distinguish
// `statesPhrase` from the naive "count + includesDc" arithmetic it replaced
// (a states-plus-DC-only fixture would pass against the reintroduced bug).
// ---------------------------------------------------------------------------

const PROPS: MapPageContentProps = {
  stats: { count: 1234, stateCodes: ["TX", "VA", "OH", "DC", "PR", "GU"] },
  topStates: [
    { state: "TX", count: 61 },
    { state: "VA", count: 44 },
  ],
  topOperators: [
    { operator: "Acme Compute", count: 19 },
    { operator: "Borealis Power", count: 8 },
  ],
  statusCounts: {
    operational: 12,
    under_construction: 5,
    permitted: 0,
    proposed: 3,
    cancelled: 0,
  },
  typeCounts: {
    data_center: 50,
    crypto_mining: 7,
    power_generation: 0,
  },
};

describe("MapPageContent", () => {
  it("renders the section heading", () => {
    render(<MapPageContent {...PROPS} />);
    expect(
      screen.getByRole("heading", { level: 2, name: /what the map shows/i })
    ).toBeInTheDocument();
  });

  it("states the live facility count and the states/DC/territories phrase in the intro", () => {
    render(<MapPageContent {...PROPS} />);
    expect(screen.getByText(/1,234/)).toBeInTheDocument();
    // 3 states (TX, VA, OH) + DC + 2 territories (PR, GU) -> statesPhrase's
    // full form. A naive `${stateCodes.length} states${hasDc ? " and DC" : ""}`
    // (the reintroduced bug this pins) would instead render "6 states and DC",
    // inventing 3 states and double-counting DC.
    expect(
      screen.getByText(/across 3 states, DC and 2 territories/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/6 states/)).not.toBeInTheDocument();
  });

  it("links top states with an accessible name that separates the label from the count", () => {
    render(<MapPageContent {...PROPS} />);
    // Exact-anchored name: a missing separator would render "Texas61 facilities"
    // (no space), which this regex does not match, while `toHaveTextContent`
    // would pass either way since it doesn't require the separator.
    const texas = screen.getByRole("link", { name: /^Texas, 61 facilities$/ });
    expect(texas).toHaveAttribute("href", "/states/texas");

    const virginia = screen.getByRole("link", {
      name: /^Virginia, 44 facilities$/,
    });
    expect(virginia).toHaveAttribute("href", "/states/virginia");
  });

  it("links top operators with an accessible name that separates the label from the count", () => {
    render(<MapPageContent {...PROPS} />);
    const acme = screen.getByRole("link", {
      name: /^Acme Compute, 19 facilities$/,
    });
    expect(acme).toHaveAttribute("href", "/operators/acme-compute");

    const borealis = screen.getByRole("link", {
      name: /^Borealis Power, 8 facilities$/,
    });
    expect(borealis).toHaveAttribute("href", "/operators/borealis-power");
  });

  it("links status breakdown rows with a separated accessible name and omits zero-count statuses", () => {
    render(<MapPageContent {...PROPS} />);
    const operational = screen.getByRole("link", {
      name: /^Operational, 12 facilities$/,
    });
    expect(operational).toHaveAttribute("href", "/status/operational");

    const underConstruction = screen.getByRole("link", {
      name: /^Under construction, 5 facilities$/,
    });
    expect(underConstruction).toHaveAttribute("href", "/status/under_construction");

    // "permitted" and "cancelled" are 0 in the fixture — must not render.
    expect(screen.queryByText("Permitted")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
  });

  it("links facility types that have a hub route, omits zero counts, and leaves data_center unlinked", () => {
    render(<MapPageContent {...PROPS} />);
    const crypto = screen.getByRole("link", {
      name: /^Crypto mining, 7 facilities$/,
    });
    expect(crypto).toHaveAttribute("href", "/crypto");

    // data_center has no dedicated hub route — rendered as plain text, not a link.
    expect(
      screen.queryByRole("link", { name: /Data center/ })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText(/50 facilities/)).toBeInTheDocument();

    // power_generation is 0 in the fixture — must not render.
    expect(screen.queryByText("Power generation")).not.toBeInTheDocument();
  });
});
